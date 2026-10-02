import { createServer } from 'node:http';
import { newId, hashControlProof, projectPurposeHash, sealProjectPayload, signControlProof, importSigningKey, wrapJourneyKey, type ProjectActionType, type JsonObject } from '@ai-wayfinding/core';
import { expect } from 'vitest';
import { journey as legacyJourney, connected as connectAgent, change, refresh, request, as, server, person, type Owner, type Fixture } from './stage1-fixtures.js';
export * from './stage1-fixtures.js';
// Keep real approval-first connections below the local server's 10/minute limit.
const approvals: number[] = [];
export async function connected(...args: Parameters<typeof connectAgent>): ReturnType<typeof connectAgent> {
  if (approvals.length === 10) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, approvals[0]! + 60_100 - Date.now())));
    approvals.shift();
  }
  approvals.push(Date.now());
  return connectAgent(...args);
}
export async function journey(owner: Owner): Promise<Fixture> {
  const trip = await legacyJourney(owner);
  await change(trip, owner, 'client.minVersion', { version: '0.1.6' });
  return trip;
}
export async function projectControl(trip: Fixture, actor: Owner, type: ProjectActionType, fields: JsonObject, purpose?: string) {
  await refresh(trip, actor);
  const body = { format: 'project-v1', ...fields }, seq = trip.entries.length, at = new Date().toISOString();
  const envelope = await sealProjectPayload(type, body, purpose === undefined ? {} : { purpose }, { id: newId(), journey: trip.id, epoch: trip.key.epoch, seq, createdAt: at }, trip.key);
  const proof = await signControlProof({ v: 1, seq, prev: await hashControlProof(trip.entries.at(-1)!.proof), at, actor: actor.principal, type, body }, envelope, trip.id, await importSigningKey(actor.signing.privateKey));
  return { proof, envelope };
}
export async function projectChange(trip: Fixture, actor: Owner, type: ProjectActionType, fields: JsonObject, purpose?: string) {
  const control = await projectControl(trip, actor, type, fields, purpose);
  expect((await request(`/v1/journeys/${trip.id}/log`, 'POST', { control }, as(actor))).status).toBe(201);
  trip.entries.push(control);
  return control.proof.seq;
}
export async function createProject(trip: Fixture, actor: Owner, purpose = 'A private project') {
  const id = newId();
  const revision = await projectChange(trip, actor, 'project.create', { project: id, state: 'getting-started', purposeHash: await projectPurposeHash(purpose) }, purpose);
  return { id, revision, purpose };
}
export async function addExpiringPerson(trip: Fixture, actor: Owner, expiresAt: number) {
  const guest = await person(), secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const inviteIdHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))).toString('base64url');
  expect((await request(`/v1/journeys/${trip.id}/invites`, 'POST', { inviteIdHash, expiresAt, support: true }, as(actor))).status).toBe(201);
  expect((await request('/v1/invites/accept', 'POST', { inviteId: secret, principal: { id: guest.principal, recipient: guest.age.recipient, signingKey: guest.signing.publicKey } }, as(guest))).status).toBe(200);
  const member = { id: guest.principal, kind: 'person', recipient: guest.age.recipient, signingKey: guest.signing.publicKey, support: true, scope: 'read', expiresAt: new Date(expiresAt).toISOString() };
  const wraps = (await wrapJourneyKey(trip.key, [member])).map(wrap => ({ principal: wrap.recipient, epoch: wrap.epoch, wrap: wrap.ciphertext }));
  await change(trip, actor, 'member.add', { member, kind: 'person', grants: [] }, { wraps });
  return guest;
}
/** Fault-injection transport only. Production workerd still authorizes every forwarded request. */
export async function faultProxy(options: { omitCapability?: boolean; response?: (text: string) => string; beforePost?: () => Promise<void> } = {}) {
  const requests: { path: string; method: string; body: string }[] = [];
  const forwarding = createServer(async (req, res) => {
    try {
      const path = req.url!, method = req.method!, chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks); requests.push({ path, method, body: body.toString() });
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string' && !['host','connection','content-length'].includes(name)) headers.set(name, value);
      if (headers.has('origin')) headers.set('origin', server);
      if (options.omitCapability) headers.delete('X-Project-Format');
      if (method === 'POST' && path.endsWith('/log')) await options.beforePost?.();
      const response = await fetch(server + path, { method, headers, ...(body.length ? { body } : {}) });
      const text = await response.text();
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(response.ok && method === 'GET' && path.endsWith('/log') && options.response ? options.response(text) : text);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => forwarding.listen(0, '127.0.0.1', resolve));
  const address = forwarding.address(); if (!address || typeof address === 'string') throw new Error('No local fault proxy');
  return { origin: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>(resolve => forwarding.close(() => resolve())) };
}
