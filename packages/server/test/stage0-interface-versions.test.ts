import { expect, it } from 'vitest';
import { newLinkSecret, linkLookupHash, sealLinkIdentity } from '@ai-wayfinding/core';
import { readLink, type Enclave } from '../src/agentLink.js';
import { fixture, as, request, addAgent, change, settings, wraps as keyWraps } from './stage0-fixtures.js';
it('live links show signed settings, stay read-only and require an update rather than reapproval', async () => {
  const { owner, j } = await fixture(), agent = await addAgent(j, owner, 'read', true);
  const secret = newLinkSecret(), blob = await sealLinkIdentity(secret, agent.age.identity, j.id, agent.principal);
  expect((await request(`/v1/journeys/${j.id}/agent-links`, 'POST', { sessionId: agent.id, hash: await linkLookupHash(secret), blob }, as(owner))).status).toBe(201);
  await settings(j, owner);
  const result = await request('/a/' + secret);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ journey: { name: 'Private name', description: 'Private description' }, access: { scope: 'read' }, howToWrite: expect.stringContaining('read-only') });
  const raw = await (await request(`/v1/journeys/${j.id}/export`, 'GET', undefined, as(owner))).json() as { log: { seq: number; proof: { type: string } }[] };
  raw.log.at(-1)!.proof.type = 'future.control';
  let recordRequests = 0;
  const call: Enclave = async message => {
    if (message.op === 'log') return Response.json({ log: raw.log });
    if (message.op === 'wraps') return request(`/v1/journeys/${j.id}/wraps/me`, 'GET', undefined, as(owner));
    recordRequests++; return Response.json({ records: [] });
  };
  // Substitute only a future control type; wraps still belong to the link identity.
  const wraps = { wraps: await keyWraps(j, [agent.member]) };
  await expect(readLink({ journeyId: j.id, memberId: agent.principal, blob, expires: agent.expiresAt, since: Date.now() }, secret, 'https://example.org', message => message.op === 'wraps' ? Promise.resolve(Response.json(wraps)) : call(message))).rejects.toThrow('Update the server');
  expect(recordRequests).toBe(0);
  expect((await change(j, owner, 'client.minVersion', { version: '0.1.7' })).status).toBe(201);
  recordRequests = 0;
  await expect(readLink({ journeyId: j.id, memberId: agent.principal, blob, expires: agent.expiresAt, since: Date.now() }, secret, 'https://example.org', async message => {
    if (message.op === 'log') return Response.json({ log: j.controls.map(control => ({ seq: control.proof.seq, proof: control.proof, envelope: control.envelope })) });
    if (message.op === 'wraps') return Response.json(wraps);
    recordRequests++; return Response.json({ records: [] });
  })).rejects.toThrow('Update the server');
  expect(recordRequests).toBe(0);
  const gated = await request('/a/' + secret);
  expect(gated.status).toBe(502);
  const body = JSON.stringify(await gated.json());
  expect(body).toContain('Update the server'); expect(body).toContain('do not request approval again'); expect(body).not.toContain('Private description');
});
