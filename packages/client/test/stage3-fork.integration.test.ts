import { describe, expect, it } from 'vitest';
import { readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { privateHash, importSigningKey, signPrivateHeader } from '@ai-wayfinding/core';
import { localServer } from './local-server.js';
import { agentState, cacheBytes, cli, command, denyTool, execute, privateFixture, privateMcp, privateProxy, retained, tool } from './stage3-fixtures.js';
import { forkCache, forkFile, forkRecord } from './stage3-forks.js';

localServer();
describe('real CLI/MCP signed forks', () => {
  it.each(['CLI', 'MCP'] as const)('%s retains ties, chooses higher artifact versions and preserves tombstones under higher signed heads', async surface => {
    for (const scenario of ['tie', 'higher', 'deleted'] as const) {
      const f = await privateFixture(), proxy = await privateProxy(), state = await agentState(f.agentSession, proxy.origin);
      const m = surface === 'MCP' ? await privateMcp(state, f.cache, true) : undefined;
      try {
        if (m) await tool(m.sdk, 'private_init'); else await command(state, f.cache, 'private', 'init');
        const base = await retained(f.cache, f.vaultId, f.agentSession.identity), bundle = structuredClone(f.bundle);
        await forkRecord(f, bundle, 'FORK CANARY', scenario === 'deleted' ? 'private.delete' : 'private.version');
        if (scenario === 'higher') await forkRecord(f, bundle, 'HIGHER CANARY');
        // Left branch has the same artifact-version count as the tied right branch.
        if (scenario === 'tie') {
          if (m) { const shown = await tool(m.sdk, 'private_show', { id: f.copy }); await tool(m.sdk, 'private_edit', { id: f.copy, predecessor: shown.copy.head, type: 'document', title: 'LEFT CANARY' }); await m.advance(300_000); }
          else {
            const shown = await command(state, f.cache, 'private', 'show', f.copy);
            await command(state, f.cache, 'private', 'edit', f.copy, '--predecessor', shown.copy.head, '--type', 'document', '--title', 'LEFT CANARY');
            const writer = await privateMcp(state, f.cache, true); try { await tool(writer.sdk, 'private_init'); await writer.advance(300_000); } finally { await writer.close(); }
          }
        }
        const current = await retained(f.cache, f.vaultId, f.agentSession.identity);
        const path = await forkFile(await forkCache(f, { ...base, checkpoint: current.checkpoint, frame: current.frame }, bundle));
        const before = proxy.trace.filter(t => t.path.includes('/private-vault')).length;
        const result = m ? await tool(m.sdk, 'private_merge', { path }) : await command(state, f.cache, 'private', 'merge', path);
        if (m) { expect(result.status).toBe('staged'); expect(proxy.trace.filter(t => t.path.includes('/private-vault'))).toHaveLength(before); await m.advance(scenario === 'tie' ? 600_000 : 300_000); }
        const branches = m ? await tool(m.sdk, 'private_branches') : await command(state, f.cache, 'private', 'branches');
        if (scenario === 'tie') expect(branches.map((b: any[]) => b[0].content.title).sort()).toEqual(['FORK CANARY', 'LEFT CANARY']);
        else if (scenario === 'higher') expect(branches.map((b: any[]) => b[0].content.title)).toEqual(['HIGHER CANARY']);
        else expect(branches).toEqual([[]]);
        const merged = await retained(f.cache, f.vaultId, f.agentSession.identity);
        expect(merged.checkpoint.version).toBeGreaterThan(current.checkpoint.version);
        expect(merged.checkpoint.head).not.toBe(current.checkpoint.head);
        expect(JSON.stringify(proxy.trace)).not.toContain('CANARY');
      } finally { await m?.close(); await proxy.close(); }
    }
  }, 240_000);

  it('CLI resumes a multi-branch signed merge across repeated process exits without the fork file', async () => {
    const f = await privateFixture(), proxy = await privateProxy(), state = await agentState(f.agentSession, proxy.origin);
    try {
      await command(state, f.cache, 'private', 'init');
      const bundle = structuredClone(f.bundle);
      // Large earlier signed versions make *both* tied branches span several slots.
      for (let i = 0; i < 5; i++) await forkRecord(f, bundle, 'LARGE RESTART CANARY ' + String(i) + 'x'.repeat(240_000));
      // Extend the left branch to an equal artifact version with independent signatures.
      const left = structuredClone(f.bundle);
      for (let i = 0; i < 5; i++) await forkRecord(f, left, 'LEFT RESTART CANARY ' + String(i) + 'y'.repeat(240_000));
      const { sealIdentity, canonical } = await import('@ai-wayfinding/core');
      const transfer = await forkFile(null);
      await (await import('node:fs/promises')).writeFile(transfer, await sealIdentity(canonical(bundle), [f.agentSession.recipient]));
      await command(state, f.cache, 'private', 'import', transfer);
      const writer = await privateMcp(state, f.cache, true);
      try { await tool(writer.sdk, 'private_init'); await writer.advance(300_000); await writer.advance(600_000); } finally { await writer.close(); }
      const base = await retained(f.cache, f.vaultId, f.agentSession.identity);
      const leftPath = await forkFile(await forkCache(f, base, left));
      // Seed an independently verified left cache without changing the live server.
      const { NodePrivateStore } = await import('../src/private-store.js');
      const { openPrivateFrame, privateAgentSession, verifyPrivateContext, privateHash, importSigningKey } = await import('@ai-wayfinding/core');
      const context = await verifyPrivateContext({ journey: f.trip.id, creator: f.trip.entries[0]!.proof.body.creator as import('@ai-wayfinding/core').Member, controls: f.trip.entries }, { now: Date.now(), currentHead: await privateHash(f.trip.entries.at(-1)!.proof) });
      const actor = { kind: 'agent' as const, signingKey: f.agentSession.signingKey, recipient: f.agentSession.recipient };
      const signingKey = await importSigningKey(f.agentSession.signingPrivateKey);
      const session = await privateAgentSession(context, actor, signingKey, f.agentSession.identity, 'authenticated');
      const leftCache = JSON.parse(await readFile(leftPath, 'utf8'));
      const { contentIdentity } = await openPrivateFrame(base.frame, f.owner.age.identity, f.bundle.author.recipient) as { contentIdentity: string };
      const path = await forkFile(base);
      // A same-version independent fork cannot advance a retained cache: start a separate device cache.
      const mergeCache = join(f.cache, 'merge-device');
      const seeded = new NodePrivateStore(mergeCache, f.vaultId, { contentIdentity, trust: { vault: f.vaultId, author: f.bundle.author }, actor, identity: f.agentSession.identity, signingKey, contexts: [context], sessions: [session], transport: { read: async () => { throw Error('unused'); }, commit: async () => { throw Error('unused'); } } });
      await seeded.commit(null, leftCache);
      // An accepted ordinary proposal may still have its encrypted pending file
      // after a crash; replace that revision with the merge plan, never unlink it.
      const { NodePrivatePending } = await import('../src/private-store.js');
      const queued = new NodePrivatePending(mergeCache, f.vaultId, f.agentSession.identity, f.agentSession.recipient);
      await queued.write(null, left);
      const credentials = await readFile(state), start = proxy.trace.length;
      expect((await command(state, mergeCache, 'private', 'merge', path)).status).toBe('staged');
      await rm(path); await rm(leftPath);
      const pending = join(mergeCache, f.vaultId, 'pending.age');
      const encrypted = await readFile(pending, 'utf8');
      expect(encrypted).not.toContain('RESTART CANARY');
      const { openIdentity } = await import('@ai-wayfinding/core');
      const hostile = JSON.parse(await openIdentity(encrypted, [f.agentSession.identity]));
      hostile.left.slots[0].ciphertext = Buffer.alloc(1_048_576).toString('base64');
      await (await import('node:fs/promises')).writeFile(pending, await sealIdentity(canonical(hostile), [f.agentSession.recipient]));
      const retainedBefore = await cacheBytes(mergeCache, f.vaultId), writesBefore = proxy.trace.filter(t => t.method === 'PUT').length;
      await expect(command(state, mergeCache, 'private', 'init')).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('digest mismatch') });
      expect(await cacheBytes(mergeCache, f.vaultId)).toEqual(retainedBefore);
      expect(proxy.trace.filter(t => t.method === 'PUT')).toHaveLength(writesBefore);
      await (await import('node:fs/promises')).writeFile(pending, encrypted);
      // Every init is a fresh shipped CLI process and one normal open sync.
      expect((await command(state, mergeCache, 'private', 'init')).status).toBe('staged');
      expect((await command(state, mergeCache, 'private', 'init')).status).toBe('committed');
      await expect(access(pending)).rejects.toMatchObject({ code: 'ENOENT' });
      const branches = JSON.parse((await execute(process.execPath, [cli, 'private', 'branches', '--state', state, '--private-cache', mergeCache], { timeout: 90_000, maxBuffer: 12_000_000 })).stdout);
      expect(branches).toHaveLength(2);
      expect(branches.map((b: any[]) => b[0].copy.records.length)).toEqual([6, 6]);
      expect(branches.map((b: any[]) => b[0].content.title.replace(/[xy]+$/, '')).sort()).toEqual(['LARGE RESTART CANARY 4', 'LEFT RESTART CANARY 4']);
      const patches = proxy.trace.slice(start).filter(t => t.path.endsWith('/private-vault') && t.method === 'PUT');
      expect(patches.slice(0, 3).flatMap(t => t.slots)).toHaveLength(6);
      expect(new Set(patches.slice(0, 3).flatMap(t => t.slots)).size).toBe(6);
      expect((await retained(mergeCache, f.vaultId, f.agentSession.identity)).checkpoint.version).toBeGreaterThan(base.checkpoint.version);
      expect(await readFile(state)).toEqual(credentials);
      expect(JSON.stringify(proxy.trace)).not.toContain('RESTART CANARY');
    } finally { await proxy.close(); }
  }, 240_000);

  it.each(['CLI', 'MCP'] as const)('%s rejects unsigned, corrupt, stale, bad-signature/digest/predecessor forks without local/server mutation', async surface => {
    const f = await privateFixture(), proxy = await privateProxy(), state = await agentState(f.agentSession, proxy.origin);
    const m = surface === 'MCP' ? await privateMcp(state, f.cache, true) : undefined;
    try {
      if (m) await tool(m.sdk, 'private_init'); else await command(state, f.cache, 'private', 'init');
      const base = await retained(f.cache, f.vaultId, f.agentSession.identity), bundle = structuredClone(f.bundle);
      await forkRecord(f, bundle, 'INVALID FORK CANARY');
      const good = await forkCache(f, base, bundle), malformed = structuredClone(bundle);
      malformed.records.at(-1)!.prev = await privateHash('unrelated predecessor');
      const { sig: _sig, ...unsigned } = malformed.records.at(-1)!;
      malformed.records[malformed.records.length - 1] = await (await import('@ai-wayfinding/core')).signPrivateRecord(unsigned, await importSigningKey(f.owner.signing.privateKey));
      const wrongSignature = structuredClone(bundle); wrongSignature.records.at(-1)!.sig = Buffer.alloc(64).toString('base64');
      const wrongPayload = structuredClone(bundle); wrongPayload.payloads.at(-1)!.payload.body.title = 'TAMPERED PAYLOAD CANARY';
      const cases = [
        { name: 'unsigned', value: await forkCache(f, base, bundle, async raw => { raw.header.sig = ''; }) },
        { name: 'signature', value: await forkCache(f, base, bundle, async raw => { raw.header.sig = Buffer.alloc(64).toString('base64'); }) },
        { name: 'digest', value: { ...good, slots: good.slots.map((s, i) => i === 63 ? Buffer.alloc(1_048_576).toString('base64') : s) } },
        { name: 'complete-digest', value: await forkCache(f, base, bundle, async raw => { const { sig, ...h } = raw.header; raw.header = await signPrivateHeader({ ...h, contentsHash: await privateHash('wrong digest') }, await importSigningKey(f.owner.signing.privateKey)); }) },
        { name: 'predecessor', value: await forkCache(f, base, malformed) },
        { name: 'record-signature', value: await forkCache(f, base, wrongSignature) },
        { name: 'payload-digest', value: await forkCache(f, base, wrongPayload) },
        { name: 'header-predecessor', value: await forkCache(f, base, bundle, async raw => { const { sig, ...h } = raw.header; raw.header = await signPrivateHeader({ ...h, prev: null }, await importSigningKey(f.owner.signing.privateKey)); }) },
        { name: 'stale', value: await forkCache(f, base, bundle, async raw => { const { sig, ...h } = raw.header; raw.header = await signPrivateHeader({ ...h, version: h.version - 1 }, await importSigningKey(f.owner.signing.privateKey)); }) },
        { name: 'unknown-version', value: await forkCache(f, base, bundle, async raw => { (raw.header as any).v = 2; }) },
        { name: 'extra-field', value: { ...good, plaintext: 'INVALID FORK CANARY' } },
      ];
      const before = await cacheBytes(f.cache, f.vaultId), credentials = await (await import('node:fs/promises')).readFile(state), writes = proxy.trace.filter(t => t.method === 'PUT').length;
      for (const c of cases) {
        const path = await forkFile(c.value);
        if (m) { const denied = await m.sdk.callTool({ name: 'private_merge', arguments: { path } }); expect(denied.isError, c.name).toBe(true); expect(JSON.stringify(denied.content)).not.toContain('CANARY'); }
        else await expect(execute(process.execPath, [cli, 'private', 'merge', path, '--state', state, '--private-cache', f.cache], { timeout: 90_000 })).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.not.stringContaining('CANARY') });
        expect(await cacheBytes(f.cache, f.vaultId), c.name).toEqual(before);
        expect(proxy.trace.filter(t => t.method === 'PUT'), c.name).toHaveLength(writes);
        expect(await (await import('node:fs/promises')).readFile(state)).toEqual(credentials);
      }
    } finally { await m?.close(); await proxy.close(); }
  }, 240_000);
});
