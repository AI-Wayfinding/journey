import { describe, expect, it, vi } from 'vitest';
import { newId, newLinkSecret, linkLookupHash, sealLinkIdentity } from '@ai-wayfinding/core';
import { fixture, as, request, addPerson, addAgent, change, settings, agentHeaders, agentRequest, snapshot, proof } from './stage0-fixtures.js';

describe('personal controls remain separate from content and guide authority', () => {
  it('lets a read-only non-guide manage their profile and own agents, but not anyone else', async () => {
    const { owner, j } = await fixture();
    await settings(j, owner, 'read-only');
    const guest = await addPerson(j, owner);
    const other = await addAgent(j, owner, 'read', true);
    const own = await addAgent(j, guest, 'read', true);
    expect((await change(j, guest, 'member.profile', { id: guest.principal, name: 'Private name', email: guest.email })).status).toBe(201);
    expect((await change(j, guest, 'member.rename', { id: own.principal, name: 'My bot' })).status).toBe(201);
    const secret = newLinkSecret();
    const link = { sessionId: own.id, hash: await linkLookupHash(secret), blob: await sealLinkIdentity(secret, own.age.identity, j.id, own.principal) };
    expect((await request(`/v1/journeys/${j.id}/agent-links`, 'POST', link, as(owner))).status).toBe(403);
    expect((await request(`/v1/journeys/${j.id}/agent-links`, 'POST', link, as(guest))).status).toBe(201);
    const expiresAt = own.expiresAt + 86_400_000;
    const renewal = await proof(j, guest, 'member.renew', { id: own.principal, expiresAt: new Date(expiresAt).toISOString() });
    const path = `/v1/journeys/${j.id}/agent-links/${own.principal}/renew`;
    expect((await request(path, 'POST', { expiresAt, control: renewal }, as(owner))).status).toBe(403);
    expect((await request(path, 'POST', { expiresAt, control: renewal }, as(guest))).status).toBe(200);
    j.controls.push(renewal);
    expect((await (await request('/v1/agent-sessions/' + own.id)).json() as { expiresAt: number }).expiresAt).toBe(expiresAt);
    const live = await request('/a/' + secret);
    expect(live.status).toBe(200);
    expect((await live.json() as { access: { expiresAt: string } }).access.expiresAt).toBe(new Date(expiresAt).toISOString());
    const before = await snapshot(j);
    for (const [type, body] of [
      ['member.profile', { id: owner.principal, name: 'Forged' }],
      ['member.rename', { id: other.principal, name: 'Not mine' }],
      ['member.renew', { id: other.principal, expiresAt: new Date(expiresAt).toISOString() }],
      ['member.role', { member: guest.principal, role: 'read-write' }],
      ['grant.add', { member: guest.principal, grant: 'members.manage' }],
      ['member.remove', { member: other.principal }],
      ['journey.settings', { name: 'No', description: '', defaultRole: 'read-write', visibility: 'private', joiningPolicy: 'invitation-only' }],
    ] as const) {
      expect((await change(j, guest, type, body)).status).toBe(403);
      expect(await snapshot(j)).toBe(before);
    }
    expect((await request(`/v1/journeys/${j.id}/invites/pending`, 'GET', undefined, as(guest))).status).toBe(403);
    expect((await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(guest))).status).toBe(403);
    expect((await change(j, guest, 'member.remove', { member: own.principal })).status).toBe(201);
    expect((await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(guest))).status).toBe(409);
    expect((await change(j, guest, 'member.remove', { member: guest.principal })).status).toBe(201);
  });

  it('lets an either-role guide and their agent manage admissions and profiles without content writes', async () => {
    const { owner, j } = await fixture();
    const guest = await addPerson(j, owner);
    expect((await change(j, owner, 'member.role', { member: owner.principal, role: 'read-only' })).status).toBe(201);
    await settings(j, owner, 'read-only');
    expect((await change(j, owner, 'member.role', { member: guest.principal, role: 'read-only' })).status).toBe(201);
    expect((await change(j, owner, 'grant.add', { member: guest.principal, grant: 'members.manage' })).status).toBe(201);
    expect((await change(j, guest, 'grant.remove', { member: owner.principal, grant: 'members.manage' })).status).toBe(201);
    await settings(j, guest);
    await addPerson(j, guest);
    const a = await addAgent(j, guest);
    expect((await change(j, guest, 'grant.add', { member: a.principal, grant: 'members.manage' })).status).toBe(403);
    const path = `/v1/journeys/${j.id}/log`;
    const control = await proof(j, { principal: a.principal, signing: a.signing }, 'member.profile', { id: guest.principal, name: 'Updated by the person’s agent' });
    expect((await request(path, 'POST', { control }, await agentHeaders(a, 'POST', path, { control }))).status).toBe(201);
    j.controls.push(control);
    const invites = `/v1/journeys/${j.id}/invites/pending`;
    expect((await request(invites, 'GET', undefined, await agentHeaders(a, 'GET', invites))).status).toBe(200);
    expect((await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(guest))).status).toBe(403);
  });

  it('requires fresh passkey confirmation for approval, link creation and renewal, and binds the requested agent limit', async () => {
    const { owner, j } = await fixture();
    const pending = await agentRequest(j, owner, 'read', true);
    expect((await request('/v1/agent-sessions/' + pending.id + '/approve', 'POST', { ...pending.approval, scope: 'readwrite' }, as(owner))).status).toBe(400);
    const now = Date.now();
    try {
      vi.useFakeTimers(); vi.setSystemTime(now + 301_000);
      expect((await request('/v1/agent-sessions/' + pending.id + '/approve', 'POST', pending.approval, as(owner))).status).toBe(401);
      expect((await request(`/v1/journeys/${j.id}/agent-links`, 'POST', {}, as(owner))).status).toBe(401);
      expect((await request(`/v1/journeys/${j.id}/agent-links/${newId()}/renew`, 'POST', {}, as(owner))).status).toBe(401);
      expect((await change(j, owner, 'member.renew', { id: pending.principal, expiresAt: new Date(now + 3_600_000).toISOString() })).status).toBe(401);
    } finally { vi.useRealTimers(); }
    expect((await request('/v1/agent-sessions/' + pending.id + '/approve', 'POST', pending.approval, as(owner))).status).toBe(200);
  });
});
