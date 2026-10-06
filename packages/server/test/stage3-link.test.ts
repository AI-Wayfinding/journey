import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { PrivateVault, newLinkSecret, linkLookupHash, sealLinkIdentity, newId, signPrivateRecord, privateHash, importSigningKey, type PrivateRecord, type PrivatePayload, type VaultCacheRecord } from '@ai-wayfinding/core';
import { PAGE_LIMIT } from '../src/agentLink.js';
import type { Env } from '../src/index.js';
import { fixture, addAgent, as, request, createProject, project, send, artifact, body, payload, controller, vaultShape, change, snapshot, wire, binary, encodeVaultPatch, vault, headerEntries, type Journey } from './stage3-fixtures.js';

async function linked() {
  const f = await fixture(), agent = await addAgent(f.j, f.owner, 'read', true), secret = newLinkSecret();
  expect((await request(`/v1/journeys/${f.j.id}/agent-links`, 'POST', { sessionId: agent.id, hash: await linkLookupHash(secret), blob: await sealLinkIdentity(secret, agent.age.identity, f.j.id, agent.principal) }, as(f.owner))).status).toBe(201);
  return { ...f, agent, secret };
}
async function response(path: string, auth: Record<string, string> = {}) {
  const r = await request(path, 'GET', undefined, auth);
  return { status: r.status, headers: headerEntries(r.headers), text: await r.text() };
}
async function pages(secret: string, selector: string) {
  let path = `/a/${secret}?project=${selector}`;
  const rows: Awaited<ReturnType<typeof response>>[] = [], visited = new Set<string>();
  for (;;) {
    expect(visited.has(path)).toBe(false); visited.add(path);
    const r = await response(path); expect(r.status).toBe(200); rows.push(r);
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(12000);
    expect(r.headers).toContainEqual(['cache-control', 'no-store, no-transform']);
    const page = JSON.parse(r.text) as { selection: string; page: { next: string | null } };
    expect(page.selection).toBe(selector);
    if (!page.page.next) break;
    const next = new URL(page.page.next); expect(next.searchParams.get('project')).toBe(selector); path = next.pathname + next.search;
  }
  return rows;
}
async function shared(j: Journey, auth: Record<string, string>) {
  return Promise.all(['/log', '/records', '/wraps/me', '/export'].map(suffix => response(`/v1/journeys/${j.id}${suffix}`, auth)));
}

describe('Stage 3 private-free links and operator observations', () => {
  it('keeps empty-shared links byte-identical after real private saves, with fixed join/open/5-minute traffic, retries and no logs/R2/archive egress', async () => {
    expect(PAGE_LIMIT).toBe(12000);
    const empty = await linked(), populated = await linked();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const log = vi.spyOn(console, 'log'), error = vi.spyOn(console, 'error'), warn = vi.spyOn(console, 'warn');
    let a: Awaited<ReturnType<typeof controller>> | undefined, b: Awaited<ReturnType<typeof controller>> | undefined;
    try {
      a = await controller(empty.j, empty.owner); b = await controller(populated.j, populated.owner);
      const before = await pages(populated.secret, 'all'), publicBefore = await shared(populated.j, as(populated.owner)), dbBefore = await snapshot(populated.j);
      expect(JSON.parse(before[0]!.text).items).toEqual([]);
      for (const f of [empty, populated]) expect(await vaultShape(f.j, f.owner.principal)).toEqual({ slots: Array.from({ length: 64 }, (_, id) => ({ id, bytes: 1048576 })), head: [{ token: 64, frame: null }] });
      await a.vault.open(); await b.vault.open();
      const previousTrace = b.trace.slice(); b.time(1000); await b.vault.stage(b.bundle); expect(b.trace).toEqual(previousTrace);
      expect(await b.vault.tick()).toBe(false);
      for (const c of [a, b]) { c.time(300000); expect(await c.vault.tick()).toBe(true); }
      expect(a.vault.branches).toEqual([]); expect(b.vault.branches[0]!.bundle.records).toHaveLength(1);
      expect(b.trace).toEqual(a.trace);
      expect(b.trace.map(t => [t.at, t.method, t.requestBytes, t.responseBytes])).toEqual([[0, 'GET', 0, 67141761], [0, 'GET', 0, 2129987], [0, 'PUT', 2129986, 76], [300000, 'GET', 0, 2129987], [300000, 'PUT', 2129986, 76]]);
      // Invalid/truncated and stale CAS requests have matched, content-free errors.
      const errors: Awaited<ReturnType<typeof response>>[] = [];
      for (const f of [empty, populated]) {
        const saved = await wire(f.j, as(f.owner)), bytes = encodeVaultPatch({ token: saved.token, frame: saved.frame!, slots: saved.slots });
        const committed = await binary(`/v1/journeys/${f.j.id}/private-vault`, as(f.owner), bytes); expect(committed.status).toBe(200);
        for (const bad of [bytes, bytes.slice(0, -1)]) { const r = await binary(`/v1/journeys/${f.j.id}/private-vault`, as(f.owner), bad); errors.push({ status: r.status, headers: headerEntries(r.headers), text: await r.text() }); }
        expect(await vaultShape(f.j, f.owner.principal)).toEqual({ slots: Array.from({ length: 64 }, (_, id) => ({ id, bytes: 1048576 })), head: [{ token: 64, frame: 32768 }] });
      }
      expect(errors.slice(0, 2)).toEqual(errors.slice(2)); expect(errors.map(e => e.status)).toEqual([409, 400, 409, 400]);
      for (const c of [a, b]) { c.time(600000); expect(await c.vault.tick()).toBe(true); }
      expect(b.trace).toEqual(a.trace);
      expect(await pages(populated.secret, 'all')).toEqual(before); expect(await shared(populated.j, as(populated.owner))).toEqual(publicBefore); expect(await snapshot(populated.j)).toBe(dbBefore);
      expect((await (env as unknown as Env).ARTIFACT_BLOBS.list()).objects).toEqual([]);
      const markers = ['PRIVATE TITLE CANARY', 'PRIVATE TAG CANARY', 'PRIVATE BODY CANARY', String(b.bundle.records[0]!.body.artifact), b.bundle.records[0]!.id];
      const leaks = await runInDurableObject(vault(populated.j, populated.owner.principal), (_o, s) => markers.map(marker => ({
        slots: s.storage.sql.exec('SELECT COUNT(*) AS n FROM slots WHERE instr(ciphertext, CAST(? AS BLOB))>0', marker).one().n,
        head: s.storage.sql.exec('SELECT COUNT(*) AS n FROM head WHERE instr(frame, CAST(? AS BLOB))>0', marker).one().n,
        wraps: s.storage.sql.exec('SELECT COUNT(*) AS n FROM agent_wraps WHERE instr(ciphertext, ?)>0', marker).one().n,
      })));
      expect(leaks).toEqual(markers.map(() => ({ slots: 0, head: 0, wraps: 0 })));
      expect(log.mock.calls).toEqual([]); expect(error.mock.calls).toEqual([]); expect(warn.mock.calls).toEqual([]);
    } finally { a?.vault.close(); b?.vault.close(); clock.mockRestore(); log.mockRestore(); error.mockRestore(); warn.mockRestore(); }
  }, 120000);

  it('preserves main/project/all Unicode pages, headers, counts, next URLs and errors with populated vaults, without activating public journeys', async () => {
    const f = await linked(), { j, owner, secret } = f, p = await createProject(j, owner, ('🧭共同\n'.repeat(900)).trim());
    const placed = await body(owner), main = await body(owner);
    expect((await send(j, owner, await project(j, owner, 'project.join', { project: p.id, member: owner.principal, predecessor: null }))).status).toBe(201);
    expect((await request(`/v1/journeys/${j.id}/log`, 'POST', { control: await artifact(j, owner, 'artifact.create', main, { ...payload(), title: 'SHARED MAIN', content: { kind: 'document', markdown: '💬🧭\n'.repeat(1800) } }) }, as(owner))).status).toBe(201);
    // Keep the fixture chain in sync after signed writes.
    const mainRead = await (await request(`/v1/journeys/${j.id}/log`, 'GET', undefined, as(owner))).json() as { log: Journey['controls'] };
    j.controls.splice(0, j.controls.length, ...mainRead.log.map(r => ({ proof: r.proof, envelope: r.envelope })));
    const placedControl = await artifact(j, owner, 'artifact.create', placed, { ...payload(), title: 'SHARED PROJECT', content: { kind: 'document', markdown: '🌱共同作業\n'.repeat(1000) } });
    expect((await request(`/v1/journeys/${j.id}/log`, 'POST', { control: placedControl }, as(owner))).status).toBe(201); j.controls.push(placedControl);
    expect((await send(j, owner, await project(j, owner, 'artifact.project', { artifact: placed.artifact, author: owner.principal, actor: owner.principal, project: p.id, predecessor: null }))).status).toBe(201);
    const c = await controller(j, owner), clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const selectors = ['main', p.id, 'all'], before = await Promise.all(selectors.map(s => pages(secret, s))), exportBefore = await shared(j, as(owner));
      for (const rows of before) { expect(rows.length).toBeGreaterThan(1); expect(rows.map(r => r.text).join('')).not.toContain('\uFFFD'); }
      const errorPaths = [`/a/${secret}?project=bogus`, `/a/${secret}?project=${newId()}`, `/a/${secret}?project=all&page=999999`, `/a/${secret}/private-vault`, `/a/${secret}/private-agent-wrap/${f.agent.principal}`];
      const failures = await Promise.all(errorPaths.map(path => response(path)));
      await c.vault.open(); await c.vault.stage(c.bundle); c.time(300000); await c.vault.tick();
      expect(await Promise.all(selectors.map(s => pages(secret, s)))).toEqual(before); expect(await shared(j, as(owner))).toEqual(exportBefore);
      expect(await Promise.all(errorPaths.map(path => response(path)))).toEqual(failures);
      const frozen = clock.getMockImplementation()!(); clock.mockReturnValue(f.agent.expiresAt + 1);
      const expired = await response(`/a/${secret}?project=all`); expect(expired.status).toBe(410); expect(expired.text).not.toContain('PRIVATE');
      clock.mockReturnValue(frozen);
      expect((await change(j, owner, 'journey.settings', { name: 'Public', description: '', defaultRole: 'read-write', visibility: 'public', joiningPolicy: 'immediate' })).status).toBe(403);
      expect((await change(j, owner, 'client.minVersion', { version: '0.1.8' }, { 'X-Client-Version': '0.1.8' })).status).toBe(201);
      const unsupported = await response(`/a/${secret}?project=all`); expect(unsupported.status).toBe(502); expect(unsupported.text).toContain('Update the server'); expect(unsupported.text).not.toContain('PRIVATE'); expect(unsupported.text).not.toContain('SHARED MAIN');
    } finally { c.vault.close(); clock.mockRestore(); }
  }, 120000);

  it('refuses a verified over-capacity history without traffic or server/cache mutation', async () => {
    const { owner, j } = await fixture(), c = await controller(j, owner);
    try {
      await c.vault.open();
      const checkpoint = c.vault.retainedCheckpoint!, server = await wire(j, as(owner)), trace = c.trace.slice();
      const records: PrivateRecord[] = [], payloads: PrivatePayload[] = [], first = c.bundle.records[0]!, key = await importSigningKey(owner.signing.privateKey);
      for (let i = 0; i < 85; i++) {
        const content = { type: 'artifact.content', typeVersion: 1, body: { title: 'PRIVATE CAPACITY CANARY', tags: [], content: { kind: 'document', markdown: 'x'.repeat(800000) }, attachments: [] } };
        const record = await signPrivateRecord({ format: first.format, v: first.v, vault: first.vault, copy: first.copy, at: first.at, actor: first.actor, authority: first.authority, id: newId(), seq: i, prev: i ? await privateHash(records.at(-1)!) : null, type: i ? 'private.version' : 'private.create', body: { ...first.body, version: newId(), predecessor: i ? records.at(-1)!.body.version : null }, payloadHash: await privateHash(content) }, key);
        records.push(record); payloads.push({ record: record.id, payload: content });
      }
      await expect(c.vault.stage({ ...c.bundle, records, payloads })).rejects.toThrow('Private vault is full; nothing was saved');
      expect(c.trace).toEqual(trace); expect(c.vault.retainedCheckpoint).toEqual(checkpoint); expect(await wire(j, as(owner))).toEqual(server); expect(c.vault.branches).toEqual([]);
      expect(await vaultShape(j, owner.principal)).toEqual({ slots: Array.from({ length: 64 }, (_, id) => ({ id, bytes: 1048576 })), head: [{ token: 64, frame: 32768 }] });
    } finally { c.vault.close(); }
  }, 120000);

  it('verifies divergent signed histories from two devices before a higher signed merge on real workerd storage', async () => {
    const { owner, j } = await fixture(), c = await controller(j, owner), stub = vault(j, owner.principal), key = await importSigningKey(owner.signing.privateKey);
    let right: PrivateVault | undefined;
    try {
      await c.vault.open(); await c.vault.stage(c.bundle); c.time(300000); await c.vault.tick();
      const base = (await c.options.cache!.read())!;
      await runInDurableObject(stub, (_o, s) => { s.storage.sql.exec('CREATE TABLE base_slots AS SELECT * FROM slots'); s.storage.sql.exec('CREATE TABLE base_head AS SELECT * FROM head'); });
      const first = c.bundle.records[0]!;
      const edit = async (text: string) => {
        const content = { type: 'artifact.content', typeVersion: 1, body: { title: 'PRIVATE FORK CANARY', tags: [], content: { kind: 'document', markdown: text }, attachments: [] } };
        const record = await signPrivateRecord({ format: first.format, v: first.v, vault: first.vault, copy: first.copy, at: first.at, actor: first.actor, authority: first.authority, id: newId(), seq: 1, prev: await privateHash(first), type: 'private.version', body: { ...first.body, version: newId(), predecessor: first.body.version }, payloadHash: await privateHash(content) }, key);
        return { ...c.bundle, records: [first, record], payloads: [...c.bundle.payloads, { record: record.id, payload: content }] };
      };
      await c.vault.stage(await edit('left branch')); c.time(600000); await c.vault.tick(); c.time(900000); await c.vault.tick();
      const left = c.vault.retainedCheckpoint!;
      await runInDurableObject(stub, (_o, s) => { s.storage.transactionSync(() => { s.storage.sql.exec('DELETE FROM slots'); s.storage.sql.exec('INSERT INTO slots SELECT * FROM base_slots'); s.storage.sql.exec('DELETE FROM head'); s.storage.sql.exec('INSERT INTO head SELECT * FROM base_head'); }); });
      let rightCache: VaultCacheRecord = base;
      right = new PrivateVault({ ...c.options, cache: { read: async () => rightCache, commit: async (_expected, value) => { rightCache = value; } } });
      await right.open(); await right.stage(await edit('right branch')); c.time(1200000); await right.tick();
      expect(right.retainedCheckpoint!.version).toBe(left.version);
      expect(right.retainedCheckpoint!.head).not.toBe(left.head);
      expect((await c.vault.merge(rightCache))[0]!.branches).toHaveLength(2);
      c.time(1500000); await c.vault.tick(); expect(c.vault.retainedCheckpoint!.version).toBe(left.version + 1); expect(c.vault.branches).toHaveLength(2);
      const fresh = new PrivateVault({ ...c.options, cache: undefined });
      await fresh.open(); expect(fresh.branches).toHaveLength(2); fresh.close();
    } finally { right?.close(); c.vault.close(); }
  }, 120000);

  it('retains signed rollback protection and unpaired/paired freshness against a replayed real server head', async () => {
    const { owner, j } = await fixture(), c = await controller(j, owner);
    try {
      await c.vault.open(); expect(c.vault.freshness).toBe('unverified'); await runInDurableObject(vault(j, owner.principal), (_o, s) => { s.storage.sql.exec('CREATE TABLE rollback_slots AS SELECT * FROM slots'); s.storage.sql.exec('CREATE TABLE rollback_head AS SELECT * FROM head'); });
      await c.vault.stage(c.bundle); c.time(300000); await c.vault.tick();
      const checkpoint = c.vault.retainedCheckpoint!;
      await runInDurableObject(vault(j, owner.principal), (_o, s) => { s.storage.transactionSync(() => { s.storage.sql.exec('DELETE FROM slots'); s.storage.sql.exec('INSERT INTO slots SELECT * FROM rollback_slots'); s.storage.sql.exec('DELETE FROM head'); s.storage.sql.exec('INSERT INTO head SELECT * FROM rollback_head'); }); });
      c.time(600000); await expect(c.vault.tick()).rejects.toThrow('rollback'); expect(c.vault.retainedCheckpoint).toEqual(checkpoint);
      const paired = new PrivateVault({ ...c.options, cache: undefined, paired: { ...checkpoint, freshness: 'paired' } });
      await expect(paired.open()).rejects.toThrow('rollback'); paired.close();
      const fresh = new PrivateVault({ ...c.options, cache: undefined });
      await fresh.open(); expect(fresh.freshness).toBe('unverified'); expect(fresh.branches).toEqual([]); fresh.close();
    } finally { c.vault.close(); }
  }, 120000);
});
