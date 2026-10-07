import { describe, expect, it, vi } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { createAgeIdentity, sealIdentity, seal, newId } from '@ai-wayfinding/core';
import { fixture, change, proof, request, as, patch, wire, binary, encodeVaultPatch, addAgent, agentHeaders, addPerson, registryStub, enclaveStub, signedBinary, snapshot, staged, upload, artifact, body, payload } from './stage3-fixtures.js';

describe('Stage 3 private authority transport', () => {
  it('requires the resulting minimum and every capability before shared or dedicated content, retaining content-free negotiation', async () => {
    const { owner, j } = await fixture(), own = await addAgent(j, owner, 'read');
    const path = `/v1/journeys/${j.id}`, current = await patch(j, as(owner)), bytes = encodeVaultPatch(current), blob = await staged(j, owner);
    const wrap = await sealIdentity((await createAgeIdentity()).identity, [own.age.recipient]);
    const checks: Record<string, string>[] = [{ 'X-Client-Version': '0.1.6' }, { 'X-Client-Version': 'broken' }, ...['X-Control-Format', 'X-Artifact-Format', 'X-Project-Format', 'X-Private-Format'].map(key => ({ [key]: '' }))];
    const before = await snapshot(j), prior = await wire(j, as(owner));
    for (const missing of checks) {
      for (const suffix of ['/log', '/records', '/wraps/me', '/export', '/private-agents']) expect((await request(path + suffix, 'GET', undefined, { ...as(owner), ...missing })).status).toBe(426);
      expect((await request('/v1/journeys', 'GET', undefined, { Cookie: owner.cookie, ...missing })).status).toBe(426);
      expect((await request(path + '/seq', 'POST', {}, { ...as(owner), ...missing })).status).toBe(426);
      expect((await request(path + '/blobs', 'POST', { size: 0 }, { ...as(owner), ...missing })).status).toBe(426);
      expect((await upload(j, owner, blob, blob.ciphertext, missing)).status).toBe(426);
      expect((await request(path + '/blobs/' + blob.descriptor.id, 'GET', undefined, { ...as(owner), ...missing })).status).toBe(426);
      expect((await binary(path + '/private-vault?slots=00,01', as(owner), undefined, missing)).status).toBe(426);
      expect((await binary(path + '/private-vault', as(owner), bytes, missing)).status).toBe(426);
      expect((await request(path + '/private-agent-wrap/' + own.principal, 'PUT', { ciphertext: wrap }, { ...as(owner), ...missing })).status).toBe(426);
      const protocol = await request(path + '/protocol', 'GET', undefined, { ...as(owner), ...missing });
      expect(protocol.status).toBe(200); expect(await protocol.json()).toEqual({ minClientVersion: '0.1.7', controlFormat: 'control-proof-v1', artifactFormat: 'artifact-v1', projectFormat: 'project-v1', privateFormat: 'private-v1' });
    }
    expect(await snapshot(j)).toBe(before); expect(await wire(j, as(owner))).toEqual(prior);
    const old = await fixture();
    const next = await proof(old.j, old.owner, 'client.minVersion', { version: '0.1.8' });
    expect((await request(`/v1/journeys/${old.j.id}/log`, 'POST', { control: next }, { ...as(old.owner), 'X-Client-Version': '0.1.8', 'X-Private-Format': '' })).status).toBe(426);
    expect((await request(`/v1/journeys/${old.j.id}/protocol`, 'GET', undefined, as(old.owner))).status).toBe(200);
  }, 60000);

  it('shares person vault and sibling wraps regardless of legacy scope, denying foreign and unknown credentials', async () => {
    const { owner, j } = await fixture(), readonly = await addAgent(j, owner, 'read'), write = await addAgent(j, owner, 'readwrite'), guest = await addPerson(j, owner), foreign = await addAgent(j, guest, 'readwrite');
    const put = `/v1/journeys/${j.id}/private-vault`, get = put + '?slots=00,01', wrapPath = `/v1/journeys/${j.id}/private-agent-wrap/${readonly.principal}`;
    expect((await binary(put, as(owner), encodeVaultPatch(await patch(j, as(owner))))).status).toBe(200);
    const ciphertext = await sealIdentity((await createAgeIdentity()).identity, [readonly.age.recipient]);
    expect((await request(wrapPath, 'PUT', { ciphertext }, as(owner))).status).toBe(200);
    let before = await wire(j, as(owner));
    expect(await wire(j, await agentHeaders(readonly, 'GET', get))).toEqual(before);
    const received = await request(wrapPath, 'GET', undefined, await agentHeaders(readonly, 'GET', wrapPath));
    expect(received.status).toBe(200); expect(await received.json()).toEqual({ ciphertext });
    const bytes = encodeVaultPatch({ ...await patch(j, as(owner)), token: before.token });
    expect((await binary(put, await signedBinary(readonly, put, bytes), bytes)).status).toBe(200);
    before = await wire(j, as(owner));
    expect(before.token).not.toBe(new TextDecoder().decode(bytes.subarray(0, 64)));
    expect((await request(wrapPath, 'PUT', { ciphertext }, await agentHeaders(readonly, 'PUT', wrapPath, { ciphertext }))).status).toBe(200);
    expect((await request(wrapPath, 'GET', undefined, await agentHeaders(write, 'GET', wrapPath))).status).toBe(200);
    expect((await request(wrapPath, 'PUT', { ciphertext }, as(guest))).status).toBe(403);
    expect((await request(wrapPath, 'GET', undefined, await agentHeaders(foreign, 'GET', wrapPath))).status).toBe(403);
    for (const value of ['', 'unknown']) {
      await runInDurableObject(registryStub(), (_o, s) => { s.storage.sql.exec('UPDATE agent_sessions SET keyStorage=? WHERE id=?', value, write.id); });
      expect((await binary(get, await agentHeaders(write, 'GET', get))).status).toBe(403);
      expect((await binary(put, await signedBinary(write, put, bytes), bytes)).status).toBe(403);
      expect((await request(`/v1/journeys/${j.id}/private-agents`, 'GET', undefined, as(owner))).status).toBe(200);
      const candidates = await (await request(`/v1/journeys/${j.id}/private-agents`, 'GET', undefined, as(owner))).json() as { agents: { principal: string }[] };
      expect(candidates.agents).toEqual([{ principal: readonly.principal }]);
    }
    expect(await wire(j, as(owner))).toEqual(before);
    expect((await change(j, owner, 'member.role', { member: owner.principal, role: 'read-only' })).status).toBe(201);
    expect(await wire(j, await agentHeaders(readonly, 'GET', get))).toEqual(before);
    expect((await binary(put, await signedBinary(readonly, put, bytes), bytes)).status).toBe(403);
  }, 60000);

  it('denies removed/expired agents at the serialized storage boundary and binds credentials to their registered journey', async () => {
    const { owner, j } = await fixture(), agent = await addAgent(j, owner, 'readwrite');
    const put = `/v1/journeys/${j.id}/private-vault`, get = put + '?slots=00,01';
    expect((await binary(put, as(owner), encodeVaultPatch(await patch(j, as(owner))))).status).toBe(200);
    const before = await wire(j, as(owner)), bytes = encodeVaultPatch(await patch(j, as(owner)));
    const signed = await signedBinary(agent, put, bytes);
    // Actual public authentication binds a session to its registered journey,
    // even if a careless registry row reuses an admitted principal/key elsewhere.
    await runInDurableObject(registryStub(), (_o, s) => { s.storage.sql.exec('UPDATE agent_sessions SET journeyId=? WHERE id=?', newId(), agent.id); });
    expect((await binary(get, await agentHeaders(agent, 'GET', get))).status).toBe(403);
    expect((await binary(put, signed, bytes)).status).toBe(403);
    await runInDurableObject(registryStub(), (_o, s) => { s.storage.sql.exec('UPDATE agent_sessions SET journeyId=? WHERE id=?', j.id, agent.id); });
    // The storage route itself rechecks live authority, not a prior preflight.
    const queued = await runInDurableObject(enclaveStub(j.id), async (object, state) => {
      const accountHash = String(state.storage.sql.exec('SELECT accountHash FROM principals WHERE id=?', owner.principal).one().accountHash);
      const subject = { principal: owner.principal, accountHash, clientVersion: '0.1.7', controlFormat: 'control-proof-v1', artifactFormat: 'artifact-v1', projectFormat: 'project-v1', privateFormat: 'private-v1' };
      const remove = await proof(j, owner, 'member.remove', { member: agent.principal });
      const removal = await object.fetch!(new Request('https://internal/', { method: 'POST', body: JSON.stringify({ op: 'controlWrite', journeyId: j.id, subject, control: remove }) }));
      expect(removal.status).toBe(201); j.controls.push(remove);
      return object.fetch!(new Request('https://internal/private-vault', { method: 'PUT', headers: { 'X-Private-Message': JSON.stringify({ op: 'privateAccess', journeyId: j.id, write: true, subject: { ...subject, principal: agent.principal, accountHash: undefined, agent: true, agentJourney: j.id, privateCredential: 'authenticated' } }) }, body: Uint8Array.from(bytes) }));
    });
    expect(queued.status).toBe(403);
    expect((await binary(get, await agentHeaders(agent, 'GET', get))).status).toBe(403);
    expect(await wire(j, as(owner))).toEqual(before);
    const live = await fixture(), timed = await addAgent(live.j, live.owner, 'readwrite'), read = `/v1/journeys/${live.j.id}/private-vault?slots=00,01`;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(timed.expiresAt + 1);
    try { expect((await binary(read, await agentHeaders(timed, 'GET', read))).status).toBe(401); } finally { clock.mockRestore(); }
  }, 60000);

  it('refuses private actions, wrap/archive fields and descriptors at every shared sink without storage or export leakage', async () => {
    const { owner, j } = await fixture(), prefix = `/v1/journeys/${j.id}`, canary = 'PRIVATE-CANARY-DO-NOT-SHARE';
    const reserved = await (await request(prefix + '/seq', 'POST', {}, as(owner))).json() as { seq: number; epoch: number };
    const envelope = await seal({ type: 'item', typeVersion: 1, body: { title: 'ordinary ciphertext' } }, { id: newId(), journey: j.id, seq: reserved.seq, epoch: reserved.epoch, createdAt: new Date().toISOString() }, j.key);
    const control = await proof(j, owner, 'member.profile', { id: owner.principal, name: 'Allowed profile' });
    const sharedArtifact = await artifact(j, owner, 'artifact.create', await body(owner), payload());
    const before = await snapshot(j);
    for (const field of ['private', 'privateWraps', 'privateArchive', 'vault', 'origin', 'recipients']) {
      expect((await request(prefix + '/log', 'POST', { control, [field]: canary }, as(owner))).status).toBe(400);
      expect((await request(prefix + '/log', 'POST', { control: sharedArtifact, [field]: canary }, as(owner))).status).toBe(400);
      expect((await request(prefix + '/records', 'POST', { envelope, [field]: canary }, as(owner))).status).toBe(400);
      expect((await request(prefix + '/records', 'POST', { envelope: { ...envelope, [field]: canary } }, as(owner))).status).toBe(400);
      expect((await request(prefix + '/blobs', 'POST', { size: 0, [field]: canary }, as(owner))).status).toBe(400);
    }
    for (const type of ['private.create', 'private.copy', 'private.delete', 'private.project']) expect((await request(prefix + '/log', 'POST', { control: { ...control, proof: { ...control.proof, type } } }, as(owner))).status).toBe(400);
    expect((await request(prefix + '/log', 'POST', { control, wraps: [{ principal: owner.principal, epoch: 1, wrap: canary, private: true }] }, as(owner))).status).toBe(400);
    expect((await request(prefix + '/export', 'POST', { format: 'private-v1', vault: canary }, as(owner))).status).toBe(404);
    expect(await snapshot(j)).toBe(before);
    const exported = await request(prefix + '/export', 'GET', undefined, as(owner));
    expect(exported.status).toBe(200); const archive = await exported.json() as Record<string, unknown>;
    expect(Object.keys(archive).sort()).toEqual(['blobs', 'controls', 'creator', 'envelopes', 'format', 'journey', 'unavailableDeletedBlobs', 'version', 'wraps']);
    expect(JSON.stringify(archive)).not.toContain(canary);
    expect(await runInDurableObject(enclaveStub(j.id), (_o, s) => s.storage.sql.exec('SELECT * FROM blobs').toArray())).toEqual([]);
  }, 60000);
});
