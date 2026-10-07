import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { newId, type JsonObject } from '@ai-wayfinding/core';
import { digest, base64url } from '../src/crypto.js';
import { fixture, as, request, addAgent, addPerson, agentRequest, agentHeaders, proof, change, registryStub, state, person, wraps, artifact, body, payload, snapshot } from './stage3-fixtures.js';

describe('member agents inherit only live adding-person authority', () => {
  it('performs guide settings, invitations, person admission, role and grant changes using its own signatures', async () => {
    const { owner, j } = await fixture(), a = await addAgent(j, owner, 'read');
    const path = `/v1/journeys/${j.id}/log`;
    const act = async (type: string, fields: JsonObject, extra: object = {}) => {
      const control = await proof(j, a, type, fields), data = { control, ...extra };
      const response = await request(path, 'POST', data, await agentHeaders(a, 'POST', path, data));
      if (response.ok) j.controls.push(control);
      return response;
    };
    expect((await act('journey.settings', { name: 'Agent-managed', description: 'Live guide authority', defaultRole: 'read-write', visibility: 'private', joiningPolicy: 'invitation-only' })).status).toBe(201);
    const invites = `/v1/journeys/${j.id}/invites`, secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const invitation = { inviteIdHash: await digest(secret), expiresAt: Date.now() + 60_000 };
    expect((await request(invites, 'POST', invitation, await agentHeaders(a, 'POST', invites, invitation))).status).toBe(201);
    const guest = await person(`agent-admitted-${newId()}@example.org`);
    expect((await request('/v1/invites/accept', 'POST', { inviteId: secret, principal: { id: guest.principal, recipient: guest.age.recipient, signingKey: guest.signing.publicKey } }, as(guest))).status).toBe(200);
    const pending = invites + '/pending';
    expect((await request(pending, 'GET', undefined, await agentHeaders(a, 'GET', pending))).status).toBe(200);
    const member = { id: guest.principal, kind: 'person', recipient: guest.age.recipient, signingKey: guest.signing.publicKey };
    expect((await act('member.add', { member, kind: 'person', grants: [] }, { wraps: await wraps(j, [member]) })).status).toBe(201);
    expect((await act('member.role', { member: guest.principal, role: 'read-only' })).status).toBe(201);
    expect((await act('grant.add', { member: guest.principal, grant: 'members.manage' })).status).toBe(201);
    expect((await act('grant.remove', { member: guest.principal, grant: 'members.manage' })).status).toBe(201);
    expect((await act('member.profile', { id: owner.principal, name: 'Owner profile via agent' })).status).toBe(201);
    expect((await act('member.rename', { id: a.principal, name: 'Renamed agent' })).status).toBe(201);
    expect((await act('member.renew', { id: a.principal, expiresAt: new Date(Date.now() + 7_200_000).toISOString() })).status).toBe(201);
    const derived = await state(j);
    expect(j.controls.at(-1)!.proof.actor).toBe(a.principal);
    expect(derived.members[a.principal]!.grants).toEqual([]);
    expect((await act('member.profile', { id: guest.principal, name: 'Foreign profile' })).status).toBe(403);
    expect((await change(j, owner, 'grant.add', { member: guest.principal, grant: 'members.manage' })).status).toBe(201);
    expect((await change(j, guest, 'grant.remove', { member: owner.principal, grant: 'members.manage' })).status).toBe(201);
    const before = await snapshot(j);
    expect((await act('member.role', { member: guest.principal, role: 'read-write' })).status).toBe(403);
    expect((await request(pending, 'GET', undefined, await agentHeaders(a, 'GET', pending))).status).toBe(403);
    expect(await snapshot(j)).toBe(before);
    expect(derived.members[owner.principal]!.profile).toEqual({ name: '[unavailable]' });
  }, 60000);

  it('ignores legacy registry/request scopes and permits agent approval without impersonating the person', async () => {
    const { owner, j } = await fixture(), actor = await addAgent(j, owner, 'read');
    const pending = await agentRequest(j, owner, 'read');
    await runInDurableObject(registryStub(), (_o, s) => { s.storage.sql.exec("UPDATE agent_sessions SET requestedScope='read' WHERE id=?", pending.id); });
    const control = await proof(j, actor, 'member.add', { member: pending.member, kind: 'agent', grants: [] });
    const data = { ...pending.approval, principal: actor.principal, control, scope: 'obsolete-and-ignored' };
    const path = `/v1/agent-sessions/${pending.id}/approve`;
    expect((await request(path, 'POST', data, await agentHeaders(actor, 'POST', path, data))).status).toBe(200);
    j.controls.push(control);
    const status = await (await request(`/v1/agent-sessions/${pending.id}`)).json();
    expect(status).not.toHaveProperty('requestedScope'); expect(status).not.toHaveProperty('scope');
    const seq = `/v1/journeys/${j.id}/seq`;
    expect((await request(seq, 'POST', {}, await agentHeaders(pending, 'POST', seq, {}))).status).toBe(200);
    expect((await change(j, owner, 'member.role', { member: owner.principal, role: 'read-only' })).status).toBe(201);
    expect((await request(seq, 'POST', {}, await agentHeaders(pending, 'POST', seq, {}))).status).toBe(403);
    expect((await change(j, owner, 'member.role', { member: owner.principal, role: 'read-write' })).status).toBe(201);
    const guide = await addPerson(j, owner, { grants: ['members.manage'] });
    expect((await change(j, guide, 'member.remove', { member: owner.principal })).status).toBe(201);
    expect((await request(seq, 'POST', {}, await agentHeaders(pending, 'POST', seq, {}))).status).toBe(403);
    const privatePath = `/v1/journeys/${j.id}/private-agents`;
    expect((await request(privatePath, 'GET', undefined, await agentHeaders(pending, 'GET', privatePath))).status).toBe(403);
    const draft = await agentRequest(j, guide);
    const approve = `/v1/agent-sessions/${draft.id}/approve`;
    expect((await request(approve, 'POST', draft.approval, { ...as(guide), 'X-Agent-Session': 'invalid' })).status).toBe(401);
  }, 60000);

  it('accepts omitted or obsolete member requestedScope but retains link-only write restrictions', async () => {
    const { owner, j } = await fixture(), a = await addAgent(j, owner, 'read'), link = await addAgent(j, owner, 'read', true);
    for (const requestedScope of [undefined, 'obsolete', { elevated: true }]) {
      const data = { journeyId: j.id, agentPublicKey: { recipient: a.age.recipient, signingKey: a.signing.publicKey }, requestedScope };
      expect((await request('/v1/agent-sessions', 'POST', data)).status).toBe(201);
    }
    const log = `/v1/journeys/${j.id}/log`, publicBody = await body(a);
    const control = await artifact(j, a, 'artifact.create', publicBody, payload()), data = { control };
    expect((await request(log, 'POST', data, await agentHeaders(a, 'POST', log, data))).status).toBe(201);
    j.controls.push(control);
    expect((await state(j)).artifacts!.items[String(publicBody.artifact)]!.author).toBe(a.principal);
    for (const suffix of ['seq', 'blobs']) {
      const path = `/v1/journeys/${j.id}/${suffix}`, fields = suffix === 'blobs' ? { size: 0 } : {};
      expect((await request(path, 'POST', fields, await agentHeaders(link, 'POST', path, fields))).status).toBe(403);
    }
    const forbidden = { control: await proof(j, link, 'journey.settings', { name: 'Link takeover', description: '', defaultRole: 'read-write', visibility: 'private', joiningPolicy: 'invitation-only' }) };
    expect((await request(log, 'POST', forbidden, await agentHeaders(link, 'POST', log, forbidden))).status).toBe(403);
  }, 60000);
});
