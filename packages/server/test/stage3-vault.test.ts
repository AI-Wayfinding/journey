import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { PRIVATE_SLOT_BYTES, PRIVATE_HEADER_BYTES, decodeVaultWire, encodeVaultPatch, privateRandomBytes, privateEncode, importSigningKey, newId, sealIdentity, createAgeIdentity } from '@ai-wayfinding/core';
import type { VaultPatch } from '@ai-wayfinding/core';
import worker, { type Env, PrivateVaultObject } from '../src/index.js';
import { fixture, as, addPerson, addAgent, agentHeaders, change, snapshot, request as jsonRequest } from './stage0-fixtures.js';
import { base64url } from '../src/crypto.js';
const vault = (id: string, principal: string) => (env as unknown as Env).PRIVATE_VAULTS.get((env as unknown as Env).PRIVATE_VAULTS.idFromName(JSON.stringify([id, principal])));
const headers = { 'X-Client-Version': '0.1.7', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Project-Format': 'project-v1', 'X-Private-Format': 'private-v1' };
const request = (path: string, auth: Record<string, string>, body?: Uint8Array) => worker.fetch(new Request('https://app.wayfinding.support' + path, { method: body ? 'PUT' : 'GET', headers: { ...headers, ...auth, Origin: 'https://app.wayfinding.support', 'X-Wayfinding': '1', 'Content-Type': 'application/octet-stream' }, ...(body ? { body: Uint8Array.from(body) } : {}) }), { ...env, RP_ID: 'app.wayfinding.support', ORIGIN: 'https://app.wayfinding.support', EMAIL_HASH_KEY: 'test-key' } as Env);

describe('dedicated fixed ciphertext member vault in workerd SQLite', () => {
  it('stores only encrypted same-person agent wraps and deletes on removal and expiry', async () => {
    const { owner, j } = await fixture(), own = await addAgent(j, owner, 'readwrite'), guest = await addPerson(j, owner), foreign = await addAgent(j, guest, 'readwrite'), link = await addAgent(j, owner, 'read', true);
    const path = (id: string) => `/v1/journeys/${j.id}/private-agent-wrap/${id}`;
    const secret = (await createAgeIdentity()).identity, ciphertext = await sealIdentity(secret, [own.age.recipient]);
    const wire = decodeVaultWire(new Uint8Array(await (await request(`/v1/journeys/${j.id}/private-vault?slots=00,01`, as(owner))).arrayBuffer()), [0, 1]);
    expect((await jsonRequest(path(own.principal), 'PUT', { ciphertext }, as(owner))).status).toBe(409);
    expect((await request(`/v1/journeys/${j.id}/private-vault`, as(owner), encodeVaultPatch({ token: wire.token, frame: privateEncode(privateRandomBytes(PRIVATE_HEADER_BYTES)), slots: wire.slots }))).status).toBe(200);
    expect((await jsonRequest(path(own.principal), 'PUT', { ciphertext, identity: secret }, as(owner))).status).toBe(400);
    expect((await jsonRequest(path(own.principal), 'PUT', { ciphertext: secret }, as(owner))).status).toBe(400);
    expect((await jsonRequest(path(own.principal), 'PUT', { ciphertext }, as(guest))).status).toBe(403);
    expect((await jsonRequest(path(foreign.principal), 'PUT', { ciphertext }, as(owner))).status).toBe(403);
    expect((await jsonRequest(path(link.principal), 'PUT', { ciphertext }, as(owner))).status).toBe(403);
    expect((await jsonRequest(path(own.principal), 'PUT', { ciphertext }, as(owner))).status).toBe(200);
    expect((await request(path(own.principal), as(owner))).status).toBe(200);
    expect((await request(path(own.principal), as(guest))).status).toBe(403);
    expect((await request(path(own.principal), await agentHeaders(foreign, 'GET', path(own.principal)))).status).toBe(403);
    expect((await request(path(own.principal), await agentHeaders(link, 'GET', path(own.principal)))).status).toBe(403);
    const fetched = await request(path(own.principal), await agentHeaders(own, 'GET', path(own.principal)));
    expect(fetched.status).toBe(200); expect(fetched.headers.get('Cache-Control')).toBe('no-store'); expect(await fetched.json()).toEqual({ ciphertext });
    const rows = await runInDurableObject(vault(j.id, owner.principal), (_o, state) => state.storage.sql.exec('SELECT * FROM agent_wraps').toArray());
    expect(rows).toEqual([{ agent: own.principal, ciphertext, expires: own.expiresAt }]); expect(JSON.stringify(rows)).not.toContain(secret); expect(await snapshot(j)).not.toContain(ciphertext);
    expect((await change(j, owner, 'member.remove', { member: own.principal })).status).toBe(201);
    expect((await request(path(own.principal), await agentHeaders(own, 'GET', path(own.principal)))).status).toBe(403);
    expect((await jsonRequest(path(own.principal), 'PUT', { ciphertext }, as(owner))).status).toBe(403);
    await runInDurableObject(vault(j.id, owner.principal), async (_o, state) => {
      expect(state.storage.sql.exec('SELECT * FROM agent_wraps').toArray()).toEqual([]);
      state.storage.sql.exec('INSERT INTO agent_wraps VALUES(?,?,?)', 'expired', ciphertext, Date.now() - 1);
      await new PrivateVaultObject(state).alarm();
      expect(state.storage.sql.exec('SELECT * FROM agent_wraps').toArray()).toEqual([]);
    });
  }, 60000);
  it('fills every slot independently, rolls back incomplete allocation and preserves bytes on retries', async () => {
    const first = vault('allocation-test', 'first');
    const inspect = (state: DurableObjectState) => ({
      head: state.storage.sql.exec('SELECT token FROM head').toArray(),
      rows: state.storage.sql.exec('SELECT id,length(ciphertext) AS bytes FROM slots ORDER BY id').toArray(),
      // Both ends of every getRandomValues-sized chunk catch zero-fill, reused
      // slots and incomplete fills without copying 64 MiB to the test.
      fingerprints: state.storage.sql.exec<{ fingerprint: string }>(`WITH RECURSIVE chunks(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM chunks WHERE n<15)
        SELECT hex(substr(ciphertext,n*65536+1,16)) || hex(substr(ciphertext,(n+1)*65536-15,16)) AS fingerprint FROM slots,chunks ORDER BY id,n`).toArray().map(row => row.fingerprint),
    });
    await runInDurableObject(first, async (_o, state) => {
      state.storage.sql.exec("CREATE TRIGGER fail_allocation BEFORE INSERT ON slots WHEN NEW.id=17 BEGIN SELECT RAISE(ABORT,'allocation interrupted'); END");
      await expect(new PrivateVaultObject(state).allocate()).rejects.toThrow('allocation interrupted');
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM slots').one()).toEqual({ n: 0 });
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM head').one()).toEqual({ n: 0 });
      state.storage.sql.exec('DROP TRIGGER fail_allocation');
    });
    const original = await runInDurableObject(first, async (_o, state) => {
      await Promise.all([new PrivateVaultObject(state).allocate(), new PrivateVaultObject(state).allocate()]);
      return inspect(state);
    });
    expect(original.head).toHaveLength(1);
    expect(original.rows).toEqual(Array.from({ length: 64 }, (_, id) => ({ id, bytes: PRIVATE_SLOT_BYTES })));
    expect(original.fingerprints).toHaveLength(1024);
    expect(new Set(original.fingerprints).size).toBe(1024);
    expect(original.fingerprints.every(value => value !== '0'.repeat(64))).toBe(true);
    const retry = await runInDurableObject(first, async (_o, state) => { await new PrivateVaultObject(state).allocate(); return inspect(state); });
    expect(retry).toEqual(original);
    const second = await runInDurableObject(vault('allocation-test', 'second'), async (_o, state) => { await new PrivateVaultObject(state).allocate(); return inspect(state); });
    expect(new Set([...original.fingerprints, ...second.fingerprints]).size).toBe(2048);
    expect(second.head).not.toEqual(original.head);
  });
  it('allocates all 64 MiB at every person admission, isolates authenticated members and never enters shared tables/R2', async () => {
    const { owner, j } = await fixture(), guest = await addPerson(j, owner), agent = await addAgent(j, owner, 'readwrite');
    for (const p of [owner, guest]) {
      const rows = await runInDurableObject(vault(j.id, p.principal), (_o, s) => s.storage.sql.exec<{ n: number; min: number; max: number }>('SELECT COUNT(*) AS n,MIN(length(ciphertext)) AS min,MAX(length(ciphertext)) AS max FROM slots').one());
      expect(rows).toEqual({ n: 64, min: PRIVATE_SLOT_BYTES, max: PRIVATE_SLOT_BYTES });
    }
    const path = `/v1/journeys/${j.id}/private-vault?slots=00,01`, before = await snapshot(j);
    const response = await request(path, as(owner)); expect(response.status).toBe(200);
    const raw = new Uint8Array(await response.arrayBuffer()), wire = decodeVaultWire(raw, [0, 1]); expect(raw.length).toBe(65 + PRIVATE_HEADER_BYTES + 2 * (1 + PRIVATE_SLOT_BYTES)); expect(wire.frame).toBeNull();
    const patch: VaultPatch = { token: wire.token, frame: privateEncode(privateRandomBytes(PRIVATE_HEADER_BYTES)), slots: wire.slots.map(s => ({ index: s.index, ciphertext: privateEncode(privateRandomBytes(PRIVATE_SLOT_BYTES)) })) };
    expect((await request(`/v1/journeys/${j.id}/private-vault`, as(owner), encodeVaultPatch(patch))).status).toBe(200);
    const own = decodeVaultWire(new Uint8Array(await (await request(path, as(owner))).arrayBuffer()), [0, 1]); expect(own.slots).toEqual(patch.slots);
    const other = decodeVaultWire(new Uint8Array(await (await request(path, as(guest))).arrayBuffer()), [0, 1]); expect(other.slots).not.toEqual(patch.slots); expect(other.frame).toBeNull();
    expect((await request(path, { Cookie: guest.cookie, 'X-Principal': owner.principal })).status).toBe(403);
    expect((await request(path + '&vault=' + owner.principal, as(owner))).status).toBe(400);
    expect((await request(path, {})).status).toBe(401);
    const signed = await agentHeaders(agent, 'GET', path); expect((await request(path, signed)).status).toBe(200);
    const link = await addAgent(j, owner, 'read', true), linkSigned = await agentHeaders(link, 'GET', path); expect((await request(path, linkSigned)).status).toBe(403);
    const current = await snapshot(j); expect(current).not.toContain(patch.frame); expect(current).not.toContain(patch.slots[0]!.ciphertext); expect((await (env as unknown as Env).ARTIFACT_BLOBS.list()).objects).toHaveLength(0);
    expect(before).not.toContain('private-v1');
    expect((await change(j, owner, 'member.remove', { member: guest.principal })).status).toBe(201); expect((await request(path, as(guest))).status).toBe(403);
  }, 60000);
  it('admits authenticated and link agents without allocating any vault storage', async () => {
    const { owner, j } = await fixture();
    const before = await runInDurableObject(vault(j.id, owner.principal), (_o, s) => s.storage.sql.exec('SELECT id,hex(substr(ciphertext,1,32)) AS fingerprint FROM slots ORDER BY id').toArray());
    for (const link of [false, true]) {
      const agent = await addAgent(j, owner, link ? 'read' : 'readwrite', link);
      await runInDurableObject(vault(j.id, agent.principal), (_o, s) => {
        expect(s.storage.sql.exec('SELECT COUNT(*) AS n FROM slots').one()).toEqual({ n: 0 });
        expect(s.storage.sql.exec('SELECT COUNT(*) AS n FROM head').one()).toEqual({ n: 0 });
      });
    }
    expect(await runInDurableObject(vault(j.id, owner.principal), (_o, s) => s.storage.sql.exec('SELECT id,hex(substr(ciphertext,1,32)) AS fingerprint FROM slots ORDER BY id').toArray())).toEqual(before);
  });
  it('routes every same-person agent commit to the person vault and denies live read-only, removed, foreign and link agents', async () => {
    const { owner, j } = await fixture(), agent = await addAgent(j, owner, 'readwrite');
    expect((await change(j, owner, 'client.minVersion', { version: '0.1.7' })).status).toBe(201);
    const path = `/v1/journeys/${j.id}/private-vault?slots=00,01`, putPath = `/v1/journeys/${j.id}/private-vault`;
    const read = async (auth: Record<string, string>) => {
      const response = await request(path, auth); expect(response.status).toBe(200);
      return decodeVaultWire(new Uint8Array(await response.arrayBuffer()), [0, 1]);
    };
    const own = await read(as(owner)), delegated = await read(await agentHeaders(agent, 'GET', path));
    expect(delegated).toEqual(own);
    expect(own.frame).toBeNull();
    const patch = { token: own.token, frame: privateEncode(privateRandomBytes(PRIVATE_HEADER_BYTES)), slots: own.slots.map(s => ({ index: s.index, ciphertext: privateEncode(privateRandomBytes(PRIVATE_SLOT_BYTES)) })) };
    const write = async (actor: typeof agent, token: string) => {
      const bytes = encodeVaultPatch({ ...patch, token }), timestamp = String(Date.now()), nonce = newId();
      const hash = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)));
      const signature = base64url(new Uint8Array(await crypto.subtle.sign('Ed25519', await importSigningKey(actor.signing.privateKey), new TextEncoder().encode(['PUT', putPath, hash, timestamp, nonce].join('\n')))));
      return request(putPath, { 'X-Agent-Session': actor.id, 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': signature }, bytes);
    };
    expect((await write(agent, own.token)).status).toBe(200);
    const first = await read(as(owner));
    expect(first.frame).toBe(patch.frame);
    expect(first.token).not.toBe(own.token);
    expect((await request(putPath, as(owner), encodeVaultPatch({ ...patch, token: first.token }))).status).toBe(200);
    const initial = await read(as(owner));
    expect((await write(agent, initial.token)).status).toBe(200);
    let committed = await read(as(owner)); expect(committed.frame).toBe(patch.frame); expect(committed.slots).toEqual(patch.slots); expect(committed.token).not.toBe(initial.token);
    const readonly = await addAgent(j, owner, 'read');
    expect((await write(readonly, committed.token)).status).toBe(200);
    const siblingCommit = await read(as(owner));
    expect(siblingCommit.token).not.toBe(committed.token);
    expect(siblingCommit.frame).toBe(patch.frame);
    committed = siblingCommit;
    expect((await change(j, owner, 'member.role', { member: owner.principal, role: 'read-only' })).status).toBe(201);
    for (const actor of [agent, readonly]) expect((await write(actor, committed.token)).status).toBe(403);
    expect((await request(putPath, as(owner), encodeVaultPatch({ ...patch, token: committed.token }))).status).toBe(403);
    expect(await read(as(owner))).toEqual(committed);
    expect((await change(j, owner, 'member.role', { member: owner.principal, role: 'read-write' })).status).toBe(201);
    expect(await read(await agentHeaders(agent, 'GET', path))).toEqual(committed);
    const foreign = await fixture(), foreignAgent = await addAgent(foreign.j, foreign.owner, 'readwrite');
    expect((await request(path, await agentHeaders(foreignAgent, 'GET', path))).status).toBe(403);
    const guest = await addPerson(j, owner), guestAgent = await addAgent(j, guest, 'readwrite');
    const guestWire = await read(await agentHeaders(guestAgent, 'GET', path)); expect(guestWire.frame).toBeNull(); expect(guestWire.token).not.toBe(committed.token);
    const forged = path + '&vault=' + owner.principal;
    expect((await request(forged, await agentHeaders(guestAgent, 'GET', forged))).status).toBe(400);
    const link = await addAgent(j, owner, 'read', true);
    expect((await request(path, await agentHeaders(link, 'GET', path))).status).toBe(403);
    expect(await read(as(owner))).toEqual(committed);
    expect((await write(guestAgent, committed.token)).status).toBe(409); // CAS belongs to guest vault, never owner's
    expect((await write(foreignAgent, committed.token)).status).toBe(403);
    expect((await write(link, committed.token)).status).toBe(403);
    expect((await change(j, owner, 'member.remove', { member: agent.principal })).status).toBe(201);
    expect((await write(agent, committed.token)).status).toBe(403);
    expect(await read(as(owner))).toEqual(committed);
  });
  it('CAS replaces only two slots plus header; stale, truncated, oversized and repeated-slot commits cannot partially mutate', async () => {
    const { owner, j } = await fixture(), stub = vault(j.id, owner.principal);
    const wire = decodeVaultWire(new Uint8Array(await (await request(`/v1/journeys/${j.id}/private-vault?slots=00,01`, as(owner))).arrayBuffer()), [0, 1]);
    const untouched = await runInDurableObject(stub, (_o, s) => Array.from(new Uint8Array(s.storage.sql.exec<{ ciphertext: ArrayBuffer }>('SELECT ciphertext FROM slots WHERE id=2').one().ciphertext)).slice(0, 64));
    const patch = { token: wire.token, frame: privateEncode(privateRandomBytes(PRIVATE_HEADER_BYTES)), slots: wire.slots }, bytes = encodeVaultPatch(patch);
    const responses = await Promise.all([stub.fetch('https://internal/', { method: 'PUT', body: Uint8Array.from(bytes) }), stub.fetch('https://internal/', { method: 'PUT', body: Uint8Array.from(bytes) })]); expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const after = await stub.fetch('https://internal/?slots=00,01'); const content = new Uint8Array(await after.arrayBuffer());
    for (const bad of [bytes.slice(1), new Uint8Array(bytes.length + 1), (() => { const b = bytes.slice(); b[64 + PRIVATE_HEADER_BYTES + 1 + PRIVATE_SLOT_BYTES] = 0; return b; })()]) expect((await stub.fetch('https://internal/', { method: 'PUT', body: bad })).status).toBe(400);
    expect(new Uint8Array(await (await stub.fetch('https://internal/?slots=00,01')).arrayBuffer())).toEqual(content);
    expect(await runInDurableObject(stub, (_o, s) => Array.from(new Uint8Array(s.storage.sql.exec<{ ciphertext: ArrayBuffer }>('SELECT ciphertext FROM slots WHERE id=2').one().ciphertext)).slice(0, 64))).toEqual(untouched);
    const replay = await runInDurableObject(stub, (_o, s) => new PrivateVaultObject(s).fetch(new Request('https://internal/?slots=00,01'))); expect(new Uint8Array(await replay.arrayBuffer())).toEqual(content);
  }, 60000);
});
