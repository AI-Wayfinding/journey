import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { generateJourneyKey, recipientsHash, newId, newLinkSecret, linkLookupHash, sealLinkIdentity, seal } from '@ai-wayfinding/core';
import { fixture, as, request, addPerson, addAgent, change, proof, submit, state, wraps, snapshot, enclaveStub, agentHeaders } from './stage0-fixtures.js';

describe('immediate removal and resumable rotation', () => {
  it('cascades person removal to their agents and links; blocks every content write until exact next-epoch delivery', async () => {
    const { owner, j } = await fixture();
    const survivor = await addPerson(j, owner, { grants: ['members.manage'] });
    const guest = await addPerson(j, owner);
    const a = await addAgent(j, guest, 'readwrite');
    const link = await addAgent(j, guest, 'read', true);
    const secret = newLinkSecret();
    expect((await request(`/v1/journeys/${j.id}/agent-links`, 'POST', { sessionId: link.id, hash: await linkLookupHash(secret), blob: await sealLinkIdentity(secret, link.age.identity, j.id, link.principal) }, as(guest))).status).toBe(201);
    const { seq } = await (await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(owner))).json() as { seq: number };
    expect((await change(j, owner, 'member.remove', { member: guest.principal })).status).toBe(201);
    expect((await request('/a/' + secret)).status).toBe(404);
    for (const suffix of ['records','log','wraps/me','export','seq']) {
      const path = `/v1/journeys/${j.id}/${suffix}`, method = suffix === 'seq' ? 'POST' : 'GET', body = suffix === 'seq' ? {} : undefined;
      expect((await request(path, method, body, as(guest))).status).toBe(403);
      expect((await request(path, method, body, await agentHeaders(a, method, path, body))).status).toBe(403);
    }
    expect((await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(owner))).status).toBe(409);
    for (const type of ['item','comment','delete']) {
      const envelope = await seal({ type, typeVersion: 1, body: { target: newId() } }, { id: newId(), journey: j.id, seq, epoch: 1, createdAt: new Date().toISOString() }, j.key);
      expect((await request(`/v1/journeys/${j.id}/records`, 'POST', { envelope }, as(owner))).status).toBe(409);
    }
    // Controls still work while rotation is pending; a read-only guide can finish it.
    expect((await change(j, owner, 'member.role', { member: survivor.principal, role: 'read-only' })).status).toBe(201);
    expect((await change(j, survivor, 'member.profile', { id: survivor.principal, name: 'Still authorized' })).status).toBe(201);
    const remainingMembers = (await state(j)).members;
    const remaining = Object.values(remainingMembers).map(m => ({ id: m.member.id, recipient: m.member.recipient }));
    const key = generateJourneyKey(2);
    const rotation = await proof(j, survivor, 'key.rotate', { epoch: 2, recipientsHash: await recipientsHash(remainingMembers) }, key);
    const delivery = await wraps(j, remaining, key);
    const before = await snapshot(j);
    const invalid = [delivery.slice(1), [...delivery, { principal: guest.principal, epoch: 2, wrap: 'YWJjZA==' }], delivery.map(w => ({ ...w, epoch: 3 })), [delivery[0]!, delivery[0]!]];
    for (const supplied of invalid) {
      expect((await submit(j, survivor, rotation, { wraps: supplied })).status).toBe(400);
      expect(await snapshot(j)).toBe(before);
    }
    const wrongKey = generateJourneyKey(3);
    expect((await submit(j, survivor, await proof(j, survivor, 'key.rotate', { epoch: 3, recipientsHash: await recipientsHash(remainingMembers) }, wrongKey), { wraps: await wraps(j, remaining, wrongKey) })).status).toBe(400);
    expect((await submit(j, survivor, await proof(j, survivor, 'key.rotate', { epoch: 2, recipientsHash: 'AAAA' }, key), { wraps: delivery })).status).toBe(400);
    expect(await snapshot(j)).toBe(before);
    expect((await submit(j, survivor, rotation, { wraps: delivery })).status).toBe(201);
    expect(await runInDurableObject(enclaveStub(j.id), (_o, s) => s.storage.sql.exec('SELECT principal FROM wraps WHERE epoch=2').toArray().map(r => r.principal).sort())).toEqual(remaining.map(m => m.id).sort());
    j.key = key;
    const allocated = await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(owner));
    expect(allocated.status).toBe(200);
    const fresh = await allocated.json() as { seq: number; epoch: number };
    expect(fresh.epoch).toBe(2);
    const stale = await seal({ type: 'item', typeVersion: 1, body: {} }, { id: newId(), journey: j.id, seq: fresh.seq, epoch: 1, createdAt: new Date().toISOString() }, { ...key, epoch: 1 });
    expect((await request(`/v1/journeys/${j.id}/records`, 'POST', { envelope: stale }, as(owner))).status).toBe(409);
    const envelope = await seal({ type: 'item', typeVersion: 1, body: {} }, { id: newId(), journey: j.id, seq: fresh.seq, epoch: 2, createdAt: new Date().toISOString() }, key);
    expect((await request(`/v1/journeys/${j.id}/records`, 'POST', { envelope }, as(owner))).status).toBe(201);
    expect((await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(survivor))).status).toBe(403);
  });

  it('protects the last person guide and immediately revokes own-agent removal and self-leave', async () => {
    const { owner, j } = await fixture();
    const before = await snapshot(j);
    for (const [type, body] of [['member.remove', { member: owner.principal }], ['grant.remove', { member: owner.principal, grant: 'members.manage' }]] as const) {
      expect((await change(j, owner, type, body)).status).toBe(403);
      expect(await snapshot(j)).toBe(before);
    }
    const successor = await addPerson(j, owner, { grants: ['members.manage'] });
    const a = await addAgent(j, owner);
    expect((await change(j, owner, 'member.remove', { member: a.principal })).status).toBe(201);
    expect((await change(j, owner, 'member.remove', { member: owner.principal })).status).toBe(201);
    expect((await state(j)).pendingRotation).toBe(true);
    expect((await request(`/v1/journeys/${j.id}/export`, 'GET', undefined, as(owner))).status).toBe(403);
    expect((await request(`/v1/journeys/${j.id}/export`, 'GET', undefined, as(successor))).status).toBe(200);
  });
});
