import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import { createAgeIdentity, createSigningIdentity, generateJourneyKey, hashControlProof, importSigningKey, newId, sealControlLabels, signControlProof, verifyControlProofs, wrapJourneyKey, type JourneyKey, type LogEntry, type ControlProof, type Envelope, type Member } from '@ai-wayfinding/core';
import { authenticator } from '../../server/test/authenticator.js';
import { connectJourney } from '../src/connection.js';
import type { JourneyClient } from '../src/journey.js';

export const root = resolve('../..'), server = 'http://localhost:18787';
export const scratch = join(root, '.scratch', 'client-integration');
let worker: ChildProcess, workerOutput = '';
const headers = { Origin: server, 'X-Wayfinding': '1', 'Content-Type': 'application/json', 'X-Client-Version': '0.1.6', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Project-Format': 'project-v1' };
export async function request(path: string, method = 'GET', body?: object, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(server + path, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function ready(): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (worker.exitCode !== null) break;
    try { const result = await fetch(server + '/__test/email?address=health@example.org'); if (result.ok) return; } catch { /* waiting for workerd */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('The local journey server did not start: ' + workerOutput.slice(-3000));
}
export function localServer() {
beforeAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  // API-only suites must not depend on a previous browser build creating assets.
  const assets = join(scratch, 'assets');
  await mkdir(assets, { recursive: true });
  worker = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', join(root, 'packages/server/test/wrangler.jsonc'), '--assets', assets, '--port', '18787', '--local', '--persist-to', scratch], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout!.on('data', (value: Buffer) => { workerOutput = (workerOutput + value.toString()).slice(-8000); });
  worker.stderr!.on('data', (value: Buffer) => { workerOutput = (workerOutput + value.toString()).slice(-8000); });
  await ready();
}, 45_000);
afterAll(async () => { if (worker && worker.exitCode === null) { await new Promise<void>(resolve => { worker.once('exit', () => resolve()); worker.kill('SIGTERM'); }); } await rm(scratch, { recursive: true, force: true }); });
}

export async function person() {
  const email = ('owner-' + newId().slice(0, 12) + '@example.org').toLowerCase();
  expect((await request('/v1/auth/email/start', 'POST', { email })).status).toBe(202);
  const sent = await (await request('/__test/email?address=' + email)).json() as { text: string };
  const token = /#token=([A-Za-z0-9_-]+)/.exec(sent.text ?? '')?.[1];
  if (!token) throw new Error('No local approval email was delivered. Server log: ' + workerOutput.slice(-900));
  const verified = await request('/v1/auth/email/verify', 'POST', { token });
  expect(verified.status).toBe(200);
  const cookie = verified.headers.get('set-cookie')!.split(';')[0]!;
  const device = await authenticator('localhost', server);
  const options = await request('/v1/auth/passkey/register/options', 'POST', {}, { Cookie: cookie });
  expect(options.status).toBe(200);
  const { challenge } = await options.json() as { challenge: string };
  const ciphertext = () => Buffer.from(crypto.getRandomValues(new Uint8Array(96))).toString('base64url');
  const result = await request('/v1/auth/passkey/register/verify', 'POST', { response: device.register(challenge), sealed: { version: 1, identity: ciphertext(), signing: ciphertext() } }, { Cookie: cookie });
  expect(result.status).toBe(200);
  return { email, cookie, principal: newId(), age: await createAgeIdentity(), signing: await createSigningIdentity() };
}
export type Owner = Awaited<ReturnType<typeof person>>;
export const as = (owner: Owner) => ({ Cookie: owner.cookie, 'X-Principal': owner.principal });
type Control = { proof: ControlProof; envelope: Envelope };
export async function signedControl(key: JourneyKey, id: string, entry: LogEntry, privateKey: string): Promise<Control> {
  const envelope = await sealControlLabels(entry, { id: newId(), journey: id, seq: entry.seq, epoch: key.epoch, createdAt: entry.at }, key);
  return { envelope, proof: await signControlProof(entry, envelope, id, await importSigningKey(privateKey)) };
}
export async function journey(owner: Owner) {
  // Stage 0 access scenarios now create Stage 1 artifacts under the signed minimum.
  const id = newId(), key = generateJourneyKey();
  const first = await signedControl(key, id, { v: 1, seq: 0, prev: null, at: new Date().toISOString(), actor: owner.principal, type: 'genesis', body: { journey: id, name: 'Journey test', creator: { id: owner.principal, kind: 'person', recipient: owner.age.recipient, signingKey: owner.signing.publicKey }, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: '0.1.5' } }, owner.signing.privateKey);
  const recovery = await createAgeIdentity();
  const recoveryWrap = (await wrapJourneyKey(key, [{ id: 'recovery', recipient: recovery.recipient }]))[0]!.ciphertext;
  const wraps = (await wrapJourneyKey(key, [{ id: owner.principal, recipient: owner.age.recipient }])).map(wrap => ({ principal: wrap.recipient, epoch: wrap.epoch, wrap: wrap.ciphertext }));
  const created = await request('/v1/journeys', 'POST', { id, name: 'Journey test', creator: { id: owner.principal, recipient: owner.age.recipient, signingKey: owner.signing.publicKey }, control: first, wraps, recoveryWrap, minClientVersion: '0.1.5' }, { Cookie: owner.cookie });
  expect(created.status).toBe(201);
  return { id, key, entries: [first] };
}
export type Fixture = Awaited<ReturnType<typeof journey>>;
export async function approve(owner: Owner, trip: Fixture, url: string, code: string, scope: 'read' | 'readwrite' = 'readwrite', name?: string): Promise<void> {
  const sessionId = url.split('/').at(-1)!;
  const info = await (await request('/v1/agent-sessions/' + sessionId)).json() as { principal: string; recipient: string; signingKey: string; name: string | null };
  if (name !== undefined) expect(info.name).toBe(name);
  const expiresAt = Date.now() + 3_600_000;
  const member = { id: info.principal, kind: 'agent', recipient: info.recipient, signingKey: info.signingKey, addedBy: owner.principal, scope, expiresAt: new Date(expiresAt).toISOString() };
  await refresh(trip, owner);
  const previous = trip.entries.at(-1)!;
  const entry = await signedControl(trip.key, trip.id, { v: 1, seq: trip.entries.length, prev: await hashControlProof(previous.proof), at: new Date().toISOString(), actor: owner.principal, type: 'member.add', body: { member, grants: [], kind: 'agent' } }, owner.signing.privateKey);
  expect((await verifyControlProofs([...trip.entries, entry].map(c => c.proof), [...trip.entries, entry].map(c => c.envelope), { journey: trip.id, creator: trip.entries[0]!.proof.body.creator as Member })).ok).toBe(true);
  const wrap = (await wrapJourneyKey(trip.key, [{ id: member.id, recipient: member.recipient }]))[0]!;
  const approved = await request('/v1/agent-sessions/' + sessionId + '/approve', 'POST', { code, principal: owner.principal, scope, expiresAt, wrap: wrap.ciphertext, control: entry }, { Cookie: owner.cookie });
  expect(approved.status).toBe(200);
  trip.entries.push(entry);
}
export async function connected(owner: Owner, trip: Fixture, scope: 'read' | 'readwrite' = 'readwrite', name?: string): Promise<JourneyClient> {
  let approval: Promise<void> | undefined;
  const connection = await connectJourney(trip.id, { server, scope, name, pollMs: 30, onApproval: (url, code) => { approval = approve(owner, trip, url, code, scope, name); } });
  await approval;
  return connection.client;
}

export async function refresh(trip: Fixture, actor: Owner): Promise<void> {
  const response = await request(`/v1/journeys/${trip.id}/log`, 'GET', undefined, as(actor));
  expect(response.status).toBe(200);
  trip.entries = (await response.json() as { log: Control[] }).log.map(row => ({ proof: row.proof, envelope: row.envelope }));
}
export async function control(trip: Fixture, actor: Owner, type: string, body: LogEntry['body']) {
  await refresh(trip, actor);
  return signedControl(trip.key, trip.id, { v: 1, seq: trip.entries.length, prev: await hashControlProof(trip.entries.at(-1)!.proof), at: new Date().toISOString(), actor: actor.principal, type, body }, actor.signing.privateKey);
}
export async function change(trip: Fixture, actor: Owner, type: string, body: LogEntry['body'], extra: object = {}, headers: Record<string, string> = {}) {
  const next = await control(trip, actor, type, body);
  const response = await request(`/v1/journeys/${trip.id}/log`, 'POST', { control: next, ...extra }, { ...as(actor), ...headers });
  expect(response.status).toBe(201); trip.entries.push(next);
}
export async function addPerson(trip: Fixture, owner: Owner) {
  const guest = await person(), secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const inviteIdHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))).toString('base64url');
  expect((await request(`/v1/journeys/${trip.id}/invites`, 'POST', { inviteIdHash, expiresAt: Date.now() + 3_600_000, support: false }, as(owner))).status).toBe(201);
  expect((await request('/v1/invites/accept', 'POST', { inviteId: secret, principal: { id: guest.principal, recipient: guest.age.recipient, signingKey: guest.signing.publicKey } }, as(guest))).status).toBe(200);
  const member = { id: guest.principal, kind: 'person', recipient: guest.age.recipient, signingKey: guest.signing.publicKey };
  const wraps = (await wrapJourneyKey(trip.key, [member])).map(w => ({ principal: w.recipient, epoch: w.epoch, wrap: w.ciphertext }));
  await change(trip, owner, 'member.add', { member, kind: 'person', grants: [] }, { wraps }); return guest;
}
