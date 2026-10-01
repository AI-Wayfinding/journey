import { env, runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import { createAgeIdentity, createSigningIdentity, hashControlProof, importSigningKey, newId, sealControlLabels, signControlProof, wrapJourneyKey, verifyControlProofs, type JourneyKey, type JsonObject, type Member } from '@ai-wayfinding/core';
import { as, person, journey, request as baseRequest } from './fixtures.js';
import type { ControlInput } from '../src/types.js';
import type { Env } from '../src/index.js';
import { base64url, digest } from '../src/crypto.js';
export { as, person, journey };
export const request: typeof baseRequest = (path, method, body, extra = {}, overrides = {}) => baseRequest(path, method, body, { 'X-Client-Version': '0.1.5', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', ...extra }, overrides);
export type Person = Awaited<ReturnType<typeof person>>;
export type Journey = Awaited<ReturnType<typeof journey>>;
let serial = 0;
export async function fixture() { const owner = await person(`stage0-${++serial}-${newId()}@example.org`); return { owner, j: await journey(owner) }; }
export async function proof(j: Journey, actor: Pick<Person, 'principal' | 'signing'>, type: string, body: JsonObject, key: JourneyKey = j.key): Promise<ControlInput> {
  const entry = { v: 1 as const, seq: j.controls.length, prev: await hashControlProof(j.controls.at(-1)!.proof), at: new Date().toISOString(), actor: actor.principal, type, body };
  const envelope = await sealControlLabels(entry, { id: newId(), journey: j.id, seq: entry.seq, epoch: key.epoch, createdAt: entry.at }, key);
  return { proof: await signControlProof(entry, envelope, j.id, await importSigningKey(actor.signing.privateKey)), envelope };
}
export async function submit(j: Journey, actor: Person, control: ControlInput, extra: object = {}) {
  const response = await request(`/v1/journeys/${j.id}/log`, 'POST', { control, ...extra }, as(actor));
  if (response.ok) j.controls.push(control);
  return response;
}
export async function change(j: Journey, actor: Person, type: string, body: JsonObject) { return submit(j, actor, await proof(j, actor, type, body)); }
export async function state(j: Journey) {
  const result = await verifyControlProofs(j.controls.map(c => c.proof), j.controls.map(c => c.envelope), { journey: j.id, creator: j.controls[0]!.proof.body.creator as Member });
  if (!result.ok) throw new Error(result.error.message);
  return result.state;
}
export async function settings(j: Journey, owner: Person, defaultRole = 'read-write') {
  expect((await change(j, owner, 'journey.settings', { name: 'Private name', description: 'Private description', defaultRole, visibility: 'private', joiningPolicy: 'invitation-only' })).status).toBe(201);
}
export async function pending(j: Journey, guide: Person, guest: Person, support = false, expiresAt = Date.now() + 3_600_000) {
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  expect((await request(`/v1/journeys/${j.id}/invites`, 'POST', { inviteIdHash: await digest(secret), expiresAt, support }, as(guide))).status).toBe(201);
  expect((await request('/v1/invites/accept', 'POST', { inviteId: secret, principal: { id: guest.principal, recipient: guest.age.recipient, signingKey: guest.signing.publicKey } }, as(guest))).status).toBe(200);
  return expiresAt;
}
export async function wraps(j: Journey, recipients: { id: string; recipient: string }[], key = j.key) { return (await wrapJourneyKey(key, recipients)).map(w => ({ principal: w.recipient, epoch: w.epoch, wrap: w.ciphertext })); }
export async function addPerson(j: Journey, guide: Person, options: { support?: boolean; grants?: string[]; expiresAt?: number } = {}) {
  const guest = await person(`guest-${++serial}-${newId()}@example.org`);
  const expiresAt = await pending(j, guide, guest, options.support, options.expiresAt);
  const member: Member = { id: guest.principal, kind: 'person', recipient: guest.age.recipient, signingKey: guest.signing.publicKey };
  if (options.support) { member.support = true; member.scope = 'read'; member.expiresAt = new Date(expiresAt).toISOString(); }
  expect((await submit(j, guide, await proof(j, guide, 'member.add', { member, kind: 'person', grants: options.grants ?? [] }), { wraps: await wraps(j, [member]) })).status).toBe(201);
  return guest;
}
export async function agentRequest(j: Journey, owner: Person, scope: 'read' | 'readwrite' = 'read', link = false) {
  const age = await createAgeIdentity(), signing = await createSigningIdentity();
  const started = await request('/v1/agent-sessions', 'POST', { journeyId: j.id, agentPublicKey: { recipient: age.recipient, signingKey: signing.publicKey }, requestedScope: scope, ...(link ? { keyStorage: 'link', remembered: true } : {}) });
  expect(started.status).toBe(201);
  const { id, code } = await started.json() as { id: string; code: string };
  const { principal } = await (await request('/v1/agent-sessions/' + id)).json() as { principal: string };
  const expiresAt = Date.now() + 3_600_000;
  const member: Member = { id: principal, recipient: age.recipient, signingKey: signing.publicKey, kind: 'agent', scope, addedBy: owner.principal, expiresAt: new Date(expiresAt).toISOString(), name: 'Bot' };
  const control = await proof(j, owner, 'member.add', { member, kind: 'agent', grants: [] });
  const approval = { principal: owner.principal, code, scope, expiresAt, wrap: (await wraps(j, [member]))[0]!.wrap, control };
  return { id, principal, age, signing, member, expiresAt, approval };
}
export async function addAgent(j: Journey, owner: Person, scope: 'read' | 'readwrite' = 'read', link = false) {
  const a = await agentRequest(j, owner, scope, link);
  expect((await request('/v1/agent-sessions/' + a.id + '/approve', 'POST', a.approval, as(owner))).status).toBe(200);
  j.controls.push(a.approval.control);
  return a;
}
export async function agentHeaders(a: Awaited<ReturnType<typeof agentRequest>>, method: string, path: string, body?: object, nonce = newId(), timestamp = String(Date.now())) {
  const sig = await crypto.subtle.sign('Ed25519', await importSigningKey(a.signing.privateKey), new TextEncoder().encode([method, path, await digest(body ? JSON.stringify(body) : ''), timestamp, nonce].join('\n')));
  return { 'X-Agent-Session': a.id, 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': base64url(new Uint8Array(sig)) };
}
export const enclaveStub = (id: string) => (env as unknown as Env).ENCLAVES.get((env as unknown as Env).ENCLAVES.idFromName(id));
export const registryStub = () => (env as unknown as Env).REGISTRY.get((env as unknown as Env).REGISTRY.idFromName('registry-v2'));
export async function snapshot(j: Journey) { return runInDurableObject(enclaveStub(j.id), (_object, state) => JSON.stringify(['meta','log','principals','wraps','authority','records','reservations'].map(table => state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()))); }
