import { env, runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import { artifactTypeHash, hashControlProof, importSigningKey, newId, sealArtifactPayload, sealBlob, signControlProof, type ArtifactActionType, type ArtifactPayload, type EncryptedBlob, type JsonObject } from '@ai-wayfinding/core';
import worker, { type Env } from '../src/index.js';
import { base64url } from '../src/crypto.js';
import { fixture as stage0, change, request, as, enclaveStub, type Journey, type Person } from './stage0-fixtures.js';
export * from './stage0-fixtures.js';
export const bucket = () => (env as unknown as Env).ARTIFACT_BLOBS;
export const bucketKey = (j: Journey, id: string) => `journeys/${j.id}/blobs/${id}`;
export async function fixture() {
  const f = await stage0();
  expect((await change(f.j, f.owner, 'client.minVersion', { version: '0.1.5' })).status).toBe(201);
  return f;
}
export async function begin(j: Journey, actor: Person, size: number) {
  const response = await request(`/v1/journeys/${j.id}/blobs`, 'POST', { size }, as(actor));
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string; journey: string; epoch: number; size: number; expiresAt: number }>;
}
export async function staged(j: Journey, actor: Person, bytes = new TextEncoder().encode('SECRET attachment bytes')) {
  const stage = await begin(j, actor, bytes.length);
  return sealBlob(bytes, { id: stage.id, journey: j.id, epoch: stage.epoch }, j.key);
}
export async function upload(j: Journey, actor: Person | Awaited<ReturnType<typeof import('./stage0-fixtures.js').addAgent>>, blob: EncryptedBlob, bytes: Uint8Array | ReadableStream<Uint8Array> = blob.ciphertext, extra: Record<string, string> = {}) {
  const path = `/v1/journeys/${j.id}/blobs/${blob.descriptor.id}`;
  let auth: Record<string, string>;
  if ('cookie' in actor) auth = as(actor);
  else {
    if (!(bytes instanceof Uint8Array)) throw new Error('Sign explicit binary bytes');
    const timestamp = String(Date.now()), nonce = newId();
    const hash = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)));
    const signature = await crypto.subtle.sign('Ed25519', await importSigningKey(actor.signing.privateKey), new TextEncoder().encode(['PUT', path, hash, timestamp, nonce].join('\n')));
    auth = { 'X-Agent-Session': actor.id, 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': base64url(new Uint8Array(signature)) };
  }
  return worker.fetch(new Request('https://app.wayfinding.support' + path, { method: 'PUT', headers: { Origin: 'https://app.wayfinding.support', 'X-Wayfinding': '1', 'X-Client-Version': '0.1.5', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Blob-Descriptor': JSON.stringify(blob.descriptor), ...auth, ...extra }, body: bytes as BodyInit }), { ...env, RP_ID: 'app.wayfinding.support', ORIGIN: 'https://app.wayfinding.support', EMAIL_HASH_KEY: 'test-key' } as Env);
}
export const payload = (blobs: EncryptedBlob[] = []): ArtifactPayload => ({ title: 'SECRET title', tags: ['SECRET tag'], content: { kind: 'document', markdown: 'SECRET markdown' }, attachments: blobs.map(b => ({ blob: b.descriptor, name: 'SECRET filename.txt', mime: 'text/plain' })) });
export async function body(actor: { principal: string }, blobs: EncryptedBlob[] = []): Promise<JsonObject> {
  return { format: 'artifact-v1', artifact: newId(), version: newId(), author: actor.principal, actor: actor.principal, typeHash: await artifactTypeHash('document'), blobs: blobs.map(b => b.descriptor) };
}
export async function artifact(j: Journey, actor: Pick<Person, 'principal' | 'signing'>, type: ArtifactActionType, publicBody: JsonObject, privateBody: JsonObject = type === 'artifact.comment' ? { text: 'SECRET comment' } : type === 'artifact.delete' ? {} : payload()) {
  const at = new Date().toISOString(), seq = j.controls.length;
  const entry = { v: 1 as const, seq, prev: await hashControlProof(j.controls.at(-1)!.proof), at, actor: actor.principal, type, body: publicBody };
  const envelope = await sealArtifactPayload(type, publicBody, privateBody, { id: newId(), journey: j.id, epoch: j.key.epoch, seq, createdAt: at }, j.key);
  return { proof: await signControlProof(entry, envelope, j.id, await importSigningKey(actor.signing.privateKey)), envelope };
}
export const rows = (j: Journey) => runInDurableObject(enclaveStub(j.id), (_o, s) => s.storage.sql.exec('SELECT * FROM blobs ORDER BY id').toArray());
export const collect = (j: Journey) => runInDurableObject(enclaveStub(j.id), o => o.alarm!());
export const expireStage = (j: Journey, id: string) => runInDurableObject(enclaveStub(j.id), (_o, s) => { s.storage.sql.exec('UPDATE blobs SET expires=0 WHERE id=?', id); });
export async function stored(j: Journey) {
  return runInDurableObject(enclaveStub(j.id), (_o, s) => JSON.stringify(['meta', 'log', 'authority', 'blobs', 'records'].map(t => s.storage.sql.exec(`SELECT * FROM ${t} ORDER BY 1`).toArray())));
}
