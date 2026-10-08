import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { decodeVaultWire, openPrivateFrame, open as openEnvelope, unwrapJourneyKey, createAgeIdentity, createSigningIdentity, newLinkSecret, linkLookupHash, sealLinkIdentity } from '@ai-wayfinding/core';
import { as, approve, localServer, localWorkerLog, request, scratch } from './local-server.js';
import { agentState, cacheBytes, command, privateFixture, privateMcp, privateProxy, retained, tool, fileDigest } from './stage3-fixtures.js';

localServer();
describe('real scheduled chunk and fault boundaries', () => {
  it('CLI queues a three-slot attachment, MCP uploads dirty chunks across two ticks, exposing only a complete signed history', async () => {
    const f = await privateFixture(), proxy = await privateProxy(), state = await agentState(f.agentSession, proxy.origin);
    const file = join(scratch, 'multi-tick-input'); await writeFile(file, Buffer.alloc(1_600_000, 61));
    const created = await command(state, f.cache, 'private', 'create', '--type', 'document', '--title', 'MULTI TICK CANARY', '--file', file);
    expect(created.status).toBe('staged');
    const m = await privateMcp(state, f.cache, true);
    const raw = async () => {
      const response = await request(`/v1/journeys/${f.trip.id}/private-vault?slots=00,01`, 'GET', undefined, as(f.owner));
      const wire = decodeVaultWire(new Uint8Array(await response.arrayBuffer()), [0, 1]);
      return await openPrivateFrame(wire.frame!, f.owner.age.identity, f.bundle.author.recipient) as { directory: { branches: number[][] } };
    };
    try {
      await tool(m.sdk, 'private_init'); const original = (await raw()).directory.branches;
      const before = proxy.trace.length; await m.advance(300_000);
      expect((await raw()).directory.branches).toEqual(original);
      expect((await tool(m.sdk, 'private_init')).status).toBe('staged');
      await m.advance(600_000);
      expect((await tool(m.sdk, 'private_init')).status).toBe('committed');
      const slots = (await raw()).directory.branches[0]!; expect(slots).toHaveLength(3);
      const reads = proxy.trace.slice(before).filter(t => t.path.includes('/private-vault?')).map(t => t.path.split('=')[1]!.split(',').map(Number));
      expect(reads).toHaveLength(2); expect(reads[0]).toEqual(slots.slice(0, 2)); expect(reads[1]![0]).toBe(slots[2]);
      expect((await tool(m.sdk, 'private_show', { id: created.id })).content.title).toBe('MULTI TICK CANARY');
      const down = join(scratch, 'multi-tick-output');
      const show = await tool(m.sdk, 'private_show', { id: created.id });
      await tool(m.sdk, 'private_download', { id: created.id, blob: show.content.attachments[0].blob.id, path: down });
      expect(await readFile(down)).toEqual(Buffer.alloc(1_600_000, 61));
      expect(JSON.stringify(proxy.trace)).not.toContain('MULTI TICK CANARY'); expect(localWorkerLog()).not.toContain('MULTI TICK CANARY');
    } finally { await m.close(); await proxy.close(); }
  }, 120_000);

  it('capacity refusal through CLI/MCP preserves retained bytes and creates no pending proposal', async () => {
    const f = await privateFixture(); await command(f.state, f.cache, 'private', 'init');
    const m = await privateMcp(f.state, f.cache, true);
    const files = [0, 1, 2].map(i => join(scratch, 'capacity-' + i));
    for (const file of files) await writeFile(file, Buffer.alloc(20_000_000, 43));
    try {
      await tool(m.sdk, 'private_init');
      const before = await cacheBytes(f.cache, f.vaultId), credentials = await readFile(f.state);
      const denied = await m.sdk.callTool({ name: 'private_create', arguments: { type: 'document', title: 'CAPACITY CANARY', files: files.map(path => ({ path })) } });
      expect(denied.isError).toBe(true); expect(JSON.stringify(denied.content)).toContain('Private vault is full; nothing was saved');
      expect(await cacheBytes(f.cache, f.vaultId)).toEqual(before); expect(await readFile(f.state)).toEqual(credentials);
      const { execute, cli } = await import('./stage3-fixtures.js');
      await m.close();
      for (const file of files.slice(0, 2)) expect((await command(f.state, f.cache, 'private', 'create', '--type', 'document', '--title', 'QUEUED CAPACITY', '--file', file)).status).toBe('staged');
      const queued = await fileDigest(join(f.cache, f.vaultId, 'pending.age'));
      await expect(execute(process.execPath, [cli, 'private', 'create', '--type', 'document', '--title', 'CAPACITY CANARY', '--file', files[2]!, '--state', f.state, '--private-cache', f.cache], { timeout: 120_000 })).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('Private vault is full; nothing was saved') });
      expect(await fileDigest(join(f.cache, f.vaultId, 'pending.age'))).toBe(queued);
    } finally { await m.close(); }
  }, 180_000);

  it('shared archive, list, credentials and operator log exclude private content, IDs, keys and encrypted wraps', async () => {
    const f = await privateFixture(); await command(f.state, f.cache, 'private', 'init');
    const m = await privateMcp(f.state, f.cache, true);
    try {
      const shown = await tool(m.sdk, 'private_show', { id: f.copy });
      const response = await request(`/v1/journeys/${f.trip.id}/export`, 'GET', undefined, as(f.owner)); expect(response.status).toBe(200);
      const archive = await response.json() as any;
      const delivered = await request(`/v1/journeys/${f.trip.id}/private-agent-wrap/${f.agentSession.principal}`, 'GET', undefined, as(f.owner));
      expect(delivered.status).toBe(200);
      const wrap = await delivered.json() as { ciphertext: string };
      const linkIdentity = await createAgeIdentity(), linkSigning = await createSigningIdentity();
      const admission = await request('/v1/agent-sessions', 'POST', { journeyId: f.trip.id, agentPublicKey: { recipient: linkIdentity.recipient, signingKey: linkSigning.publicKey }, remembered: true, keyStorage: 'link', requestedScope: 'read' });
      expect(admission.status).toBe(201);
      const session = await admission.json() as { id: string; code: string; approvalUrl: string };
      await approve(f.owner, f.trip, session.approvalUrl, session.code, 'read');
      const admitted = await (await request('/v1/agent-sessions/' + session.id)).json() as { principal: string; expiresAt: number };
      const secret = newLinkSecret();
      const createdLink = await request(`/v1/journeys/${f.trip.id}/agent-links`, 'POST', { sessionId: session.id, hash: await linkLookupHash(secret), blob: await sealLinkIdentity(secret, linkIdentity.identity, f.trip.id, admitted.principal) }, as(f.owner));
      expect(createdLink.status).toBe(201);
      const linkRead = await request('/a/' + secret); expect(linkRead.status).toBe(200);
      const linkBody = await linkRead.json();
      const keys = await Promise.all(archive.wraps.map((wrap: any) => unwrapJourneyKey(wrap, f.owner.age.identity)));
      const plaintext = await Promise.all([...archive.controls.map((c: any) => c.envelope), ...archive.envelopes].map((e: any) => openEnvelope(e, keys.find((k: any) => k.epoch === e.outside.epoch)!)));
      const publicOutput = JSON.stringify({ archive, plaintext, linkBody, list: await command(f.state, f.cache, 'list'), state: await readFile(f.state, 'utf8'), logs: localWorkerLog() });
      for (const hidden of ['PERSON PRIVATE CANARY', 'PERSON PRIVATE BODY', f.copy, shown.copy.artifact, f.vaultId, f.bundle.copyKeys[0]!.key, wrap.ciphertext]) expect(publicOutput).not.toContain(hidden);
      expect(archive.blobs).toEqual([]); expect(archive.envelopes).toEqual([]);
    } finally { await m.close(); }
  }, 120_000);

  it('stdio writer uses distinct dirty slots before the supplied random fallback order', async () => {
    const f = await privateFixture(), proxy = await privateProxy(), state = await agentState(f.agentSession, proxy.origin);
    const m = await privateMcp(state, f.cache, true, undefined, Array.from({ length: 64 }, (_, i) => 63 - i));
    try {
      await tool(m.sdk, 'private_init');
      expect(proxy.trace.filter(t => t.method === 'PUT' && t.path.endsWith('/private-vault')).at(-1)!.slots).toEqual([63, 62]);
      await tool(m.sdk, 'private_create', { type: 'document', title: 'DIRTY FIRST CANARY' });
      await m.advance(300_000);
      const response = await request(`/v1/journeys/${f.trip.id}/private-vault?slots=00,01`, 'GET', undefined, as(f.owner));
      const wire = decodeVaultWire(new Uint8Array(await response.arrayBuffer()), [0, 1]);
      const frame = await openPrivateFrame(wire.frame!, f.owner.age.identity, f.bundle.author.recipient) as { directory: { branches: number[][] } };
      const dirty = frame.directory.branches[0]![0]!;
      expect(proxy.trace.filter(t => t.method === 'PUT' && t.path.endsWith('/private-vault')).at(-1)!.slots).toEqual([dirty, dirty === 63 ? 62 : 63]);
      await m.advance(600_000);
      expect(proxy.trace.filter(t => t.method === 'PUT' && t.path.endsWith('/private-vault')).at(-1)!.slots).toEqual([63, 62]);
      const next = await command(f.state, join(scratch, 'random-observer'), 'private', 'list', '--project', 'all');
      expect(next).toHaveLength(2);
    } finally { await m.close(); await proxy.close(); }
  }, 120_000);

  it('two real stdio devices preserve signed server history and pending proposals on concurrent staging', async () => {
    const f = await privateFixture(), proxy = await privateProxy(), state = await agentState(f.agentSession, proxy.origin);
    const cacheB = join(scratch, 'second-device');
    const a = await privateMcp(state, f.cache, true), b = await privateMcp(state, cacheB, true);
    try {
      await tool(a.sdk, 'private_init'); await tool(b.sdk, 'private_init');
      // Hydrate the older device using its normal schedule before both save.
      await a.advance(300_000);
      const left = await tool(a.sdk, 'private_create', { type: 'document', title: 'DEVICE A CANARY' });
      const right = await tool(b.sdk, 'private_create', { type: 'document', title: 'DEVICE B CANARY' });
      const pendingA = await readFile(join(f.cache, f.vaultId, 'pending.age')), pendingB = await readFile(join(cacheB, f.vaultId, 'pending.age'));
      await a.advance(600_000);
      await expect(b.advance(300_000)).rejects.toThrow('Private vault concurrent staging conflict; reload before saving');
      expect(await readFile(join(f.cache, f.vaultId, 'pending.age'))).toEqual(pendingA);
      expect(await readFile(join(cacheB, f.vaultId, 'pending.age'))).toEqual(pendingB);
      const fresh = await privateMcp(state, join(scratch, 'third-device'), true);
      try {
        const copies = await tool(fresh.sdk, 'private_list', { project: 'all' });
        expect(copies.map((c: any) => c.copy)).toContain(left.id); expect(copies.map((c: any) => c.copy)).not.toContain(right.id);
        expect((await tool(fresh.sdk, 'private_show', { id: left.id })).content.title).toBe('DEVICE A CANARY');
      } finally { await fresh.close(); }
      expect(JSON.stringify(proxy.trace)).not.toContain('DEVICE');
    } finally { await a.close(); await b.close(); await proxy.close(); }
  }, 120_000);

  it('simultaneous stdio writers race the same server CAS token without losing either encrypted proposal', async () => {
    const f = await privateFixture(); let waiting = 0, armed = false, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const proxy = await privateProxy(async (path, method, bytes, status) => {
      if (armed && method === 'GET' && path.includes('/private-vault?')) { if (++waiting === 2) release(); await barrier; }
      return { bytes, status };
    });
    const state = await agentState(f.agentSession, proxy.origin), cacheB = join(scratch, 'racing-device');
    const a = await privateMcp(state, f.cache, true), b = await privateMcp(state, cacheB, true);
    try {
      await tool(a.sdk, 'private_init'); await tool(b.sdk, 'private_init'); await a.advance(300_000);
      await tool(a.sdk, 'private_create', { type: 'document', title: 'RACE A CANARY' });
      await tool(b.sdk, 'private_create', { type: 'document', title: 'RACE B CANARY' });
      const version = (await retained(f.cache, f.vaultId, f.agentSession.identity)).checkpoint.version;
      const pendingA = await fileDigest(join(f.cache, f.vaultId, 'pending.age')), pendingB = await fileDigest(join(cacheB, f.vaultId, 'pending.age'));
      const before = proxy.trace.length; armed = true;
      const results = await Promise.allSettled([a.advance(600_000), b.advance(300_000)]); armed = false;
      expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(proxy.trace.slice(before).filter(t => t.path.endsWith('/private-vault') && t.method === 'PUT').map(t => t.status).sort()).toEqual([200, 409]);
      expect(await fileDigest(join(f.cache, f.vaultId, 'pending.age'))).toBe(pendingA);
      expect(await fileDigest(join(cacheB, f.vaultId, 'pending.age'))).toBe(pendingB);
      const read = await command(f.state, join(scratch, 'race-observer'), 'private', 'list', '--project', 'all');
      const shown: any[] = [];
      for (const copy of read) shown.push(await command(f.state, join(scratch, 'race-reader-' + copy.copy), 'private', 'show', copy.copy));
      // The stale device may win with its content-independent dummy patch.
      const expectedTitles = results[0]!.status === 'fulfilled' ? ['PERSON PRIVATE CANARY', 'RACE A CANARY'] : ['PERSON PRIVATE CANARY'];
      expect(shown.map(c => c.content.title).sort()).toEqual(expectedTitles);
      expect(read.map((c: any) => c.copy)).toContain(f.copy);
      const server = await request(`/v1/journeys/${f.trip.id}/private-vault?slots=00,01`, 'GET', undefined, as(f.owner));
      const wire = decodeVaultWire(new Uint8Array(await server.arrayBuffer()), [0, 1]);
      const frame = await openPrivateFrame(wire.frame!, f.owner.age.identity, f.bundle.author.recipient) as { header: { version: number } };
      // The observer above performs its own mandatory open dummy commit.
      expect(frame.header.version).toBe(version + 2 + shown.length);
    } finally { release(); await a.close(); await b.close(); await proxy.close(); }
  }, 120_000);

  it('a server commit followed by interrupted cache publication retains the checkpoint and recovers only through scheduled hydration', async () => {
    const f = await privateFixture(), m = await privateMcp(f.state, f.cache, true), lock = join(f.cache, f.vaultId, '.lock');
    try {
      await tool(m.sdk, 'private_init');
      const before = await readFile(join(f.cache, f.vaultId, 'checkpoint.age'));
      const checkpoint = (await retained(f.cache, f.vaultId, f.agentSession.identity)).checkpoint;
      const saved = await tool(m.sdk, 'private_create', { type: 'document', title: 'CACHE CRASH CANARY' });
      await mkdir(lock);
      await expect(m.advance(300_000)).rejects.toThrow('Private cache concurrent commit');
      expect(await readFile(join(f.cache, f.vaultId, 'checkpoint.age'))).toEqual(before);
      const server = await request(`/v1/journeys/${f.trip.id}/private-vault?slots=00,01`, 'GET', undefined, as(f.owner));
      expect(server.status).toBe(200);
      const wire = decodeVaultWire(new Uint8Array(await server.arrayBuffer()), [0, 1]);
      const committed = await openPrivateFrame(wire.frame!, f.owner.age.identity, f.bundle.author.recipient) as { header: { version: number } };
      expect(committed.header.version).toBe(checkpoint.version + 1);
      await m.close(); await rm(lock, { recursive: true });
      const next = await privateMcp(f.state, f.cache, true);
      try {
        // Init may wait until the normal tick fetches the COW chunk, never all slots.
        const pending = tool(next.sdk, 'private_show', { id: saved.id });
        void pending.catch(() => {});
        await next.advance(300_000);
        await next.advance(600_000);
        expect((await pending).content.title).toBe('CACHE CRASH CANARY');
        expect(await readFile(join(f.cache, f.vaultId, 'checkpoint.age'))).not.toEqual(before);
      } finally { await next.close(); }
    } finally { await rm(lock, { recursive: true, force: true }); await m.close(); }
  }, 180_000);

  it.each([false, true])('empty/populated writer retries only next tick after an interrupted response, without content-shaped errors or logs (%s)', async populated => {
    const f = await privateFixture(populated); let fail = false;
    const proxy = await privateProxy((path, method, bytes, status) => {
      if (fail && path.endsWith('/private-vault') && method === 'PUT') { fail = false; return { bytes: Buffer.from('{"error":{"code":"test-interrupted"}}'), status: 503 }; }
      return { bytes, status };
    });
    const state = await agentState(f.agentSession, proxy.origin), m = await privateMcp(state, f.cache, true);
    try {
      await tool(m.sdk, 'private_init'); const before = await retained(f.cache, f.vaultId, f.agentSession.identity);
      fail = true; proxy.time(300_000);
      await expect(m.advance(300_000)).rejects.toThrow('Journey request failed (test-interrupted).');
      const failed = proxy.trace.filter(t => t.path.includes('/private-vault')).slice(-2);
      expect(failed.map(t => [t.method, t.request, t.response, t.status])).toEqual([['GET', 0, 2_129_987, 200], ['PUT', 2_129_986, 37, 503]]);
      const count = proxy.trace.length; await m.advance(300_001); await m.advance(599_999); expect(proxy.trace).toHaveLength(count);
      proxy.time(600_000); await m.advance(600_000);
      const after = await retained(f.cache, f.vaultId, f.agentSession.identity); expect(after.checkpoint.version).toBe(before.checkpoint.version + 2);
      expect(m.errors()).not.toContain('PERSON PRIVATE'); expect(localWorkerLog()).not.toContain('PERSON PRIVATE');
      const headers = proxy.trace.filter(t => t.path.includes('/private-vault')).map(t => t.headers);
      for (const h of headers) {
        expect(h['x-client-version']).toBe('0.1.7'); expect(h['x-private-format']).toBe('private-v1');
        expect(String(h['x-agent-signature'])).toHaveLength(86); expect(String(h['x-agent-nonce'])).toHaveLength(36);
        expect(String(h['x-agent-timestamp'])).toMatch(/^\d{13}$/);
        expect(h['authorization']).toBeUndefined();
        expect(h['cookie']).toBeUndefined();
        expect(h['x-principal']).toBeUndefined();
        expect(h['x-artifact-format']).toBe('artifact-v1');
        expect(h['x-control-format']).toBe('control-proof-v1');
        expect(h['x-project-format']).toBe('project-v1');
      }
      expect(new Set(headers.map(h => h['x-agent-nonce'])).size).toBe(headers.length);
      expect(JSON.stringify(proxy.trace)).not.toContain('PERSON PRIVATE');
    } finally { await m.close(); await proxy.close(); }
  }, 120_000);
});
