import { env, runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import { PrivateVault, newPrivateId, privateIdentity, privatePersonSession, verifyPrivateContext, hashControlProof, privateAuthority, privateAuthorityHistory, signPrivateRecord, privateHash, artifactTypeHash, decodeVaultWire, encodeVaultPatch, importSigningKey, newId, privateEncode, privateRandomBytes, PRIVATE_HEADER_BYTES, PRIVATE_SLOT_BYTES, type VaultOptions, type PrivateBundle, type VaultCacheRecord, type Member, type VaultPatch } from '@ai-wayfinding/core';
import worker, { type Env } from '../src/index.js';
import { base64url } from '../src/crypto.js';
import { fixture as stage2, change, type Journey } from './stage2-fixtures.js';
export * from './stage2-fixtures.js';
export const formats = { 'X-Client-Version': '0.1.7', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Project-Format': 'project-v1', 'X-Private-Format': 'private-v1' };
export async function fixture() {
  const f = await stage2();
  expect((await change(f.j, f.owner, 'client.minVersion', { version: '0.1.7' })).status).toBe(201);
  return f;
}
export const vault = (j: Journey, principal: string) => (env as unknown as Env).PRIVATE_VAULTS.get((env as unknown as Env).PRIVATE_VAULTS.idFromName(JSON.stringify([j.id, principal])));
export function binary(path: string, auth: Record<string, string>, body?: Uint8Array, extra: Record<string, string> = {}) {
  return worker.fetch(new Request('https://app.wayfinding.support' + path, { method: body ? 'PUT' : 'GET', headers: { ...formats, ...auth, Origin: 'https://app.wayfinding.support', 'X-Wayfinding': '1', 'Content-Type': 'application/octet-stream', ...extra }, ...(body ? { body: Uint8Array.from(body) } : {}) }), { ...env, RP_ID: 'app.wayfinding.support', ORIGIN: 'https://app.wayfinding.support', EMAIL_HASH_KEY: 'test-key' } as Env);
}
export async function wire(j: Journey, auth: Record<string, string>) {
  const response = await binary(`/v1/journeys/${j.id}/private-vault?slots=00,01`, auth);
  expect(response.status).toBe(200);
  return decodeVaultWire(new Uint8Array(await response.arrayBuffer()), [0, 1]);
}
export async function patch(j: Journey, auth: Record<string, string>): Promise<VaultPatch> {
  const current = await wire(j, auth);
  return { token: current.token, frame: privateEncode(privateRandomBytes(PRIVATE_HEADER_BYTES)), slots: [0, 1].map(index => ({ index, ciphertext: privateEncode(privateRandomBytes(PRIVATE_SLOT_BYTES)) })) };
}
export async function signedBinary(actor: { id: string; signing: { privateKey: string } }, path: string, bytes: Uint8Array) {
  const timestamp = String(Date.now()), nonce = newId();
  const hash = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)));
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('Ed25519', await importSigningKey(actor.signing.privateKey), new TextEncoder().encode(['PUT', path, hash, timestamp, nonce].join('\n')))));
  return { 'X-Agent-Session': actor.id, 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': signature };
}
export async function vaultShape(j: Journey, principal: string) {
  return runInDurableObject(vault(j, principal), (_o, s) => ({
    slots: s.storage.sql.exec('SELECT id,length(ciphertext) AS bytes FROM slots ORDER BY id').toArray(),
    head: s.storage.sql.exec('SELECT length(token) AS token,length(frame) AS frame FROM head').toArray(),
  }));
}
export { encodeVaultPatch };
export function headerEntries(headers: Headers): [string, string][] { const entries: [string, string][] = []; headers.forEach((value, key) => entries.push([key, value])); return entries; }

/** Real controller and signed bundle, using the Worker API rather than a fake store. */
export async function controller(j: Journey, owner: { principal: string; cookie: string; age: { identity: string; recipient: string }; signing: { privateKey: string; publicKey: string } }) {
  const creator = j.controls[0]!.proof.body.creator as Member;
  const context = await verifyPrivateContext({ journey: j.id, creator, controls: j.controls }, { now: Date.now(), currentHead: await hashControlProof(j.controls.at(-1)!.proof) });
  const author = privateIdentity({ id: owner.principal, kind: 'person', signingKey: owner.signing.publicKey, recipient: owner.age.recipient });
  const key = await importSigningKey(owner.signing.privateKey), session = await privatePersonSession(context, author, key, owner.age.identity), vaultId = newPrivateId(), copy = newPrivateId();
  const content = { type: 'artifact.content', typeVersion: 1, body: { title: 'PRIVATE TITLE CANARY', tags: ['PRIVATE TAG CANARY'], content: { kind: 'document', markdown: 'PRIVATE BODY CANARY' }, attachments: [] } };
  const record = await signPrivateRecord({ format: 'private-v1', v: 1, id: newId(), vault: vaultId, copy, seq: 0, prev: null, at: new Date().toISOString(), actor: author, authority: privateAuthority(context, author), type: 'private.create', body: { artifact: newPrivateId(), author: { kind: author.kind, signingKey: author.signingKey, recipient: author.recipient }, actor: { kind: author.kind, signingKey: author.signingKey, recipient: author.recipient }, version: newId(), typeHash: await artifactTypeHash('document'), blobs: [], predecessor: null }, payloadHash: await privateHash(content) }, key);
  const bundle: PrivateBundle = { format: 'private-v1', version: 1, vault: vaultId, author, scope: 'author-backup', authorityHistories: [privateAuthorityHistory(context)], records: [record], payloads: [{ record: record.id, payload: content }], copyKeys: [{ copy, key: privateEncode(privateRandomBytes(32)) }], blobs: [], unavailableDeletedBlobs: [] };
  let time = 0, cache: VaultCacheRecord | null = null;
  const trace: { at: number; method: string; path: string; requestBytes: number; responseBytes: number; status: number; headers: [string, string][] }[] = [];
  const auth = { Cookie: owner.cookie, 'X-Principal': owner.principal }, prefix = `/v1/journeys/${j.id}/private-vault`;
  const options: VaultOptions = { trust: { vault: vaultId, author }, identity: owner.age.identity, signingKey: key, contexts: [context], sessions: [session], now: () => time, randomOrder: () => Array.from({ length: 64 }, (_, i) => i), cache: { read: async () => cache, commit: async (_expected, value) => { cache = value; } }, transport: {
    read: async indices => {
      const selection = indices === 'all' ? 'all' : indices.map(i => String(i).padStart(2, '0')).join(','), response = await binary(prefix + '?slots=' + selection, auth);
      const bytes = new Uint8Array(await response.arrayBuffer());
      trace.push({ at: time, method: 'GET', path: '?slots=' + (indices === 'all' ? 'all' : 'XX,XX'), requestBytes: 0, responseBytes: bytes.length, status: response.status, headers: headerEntries(response.headers) });
      if (!response.ok) throw new Error('vault read failed');
      return decodeVaultWire(bytes, indices);
    },
    commit: async patch => {
      const bytes = encodeVaultPatch(patch), response = await binary(prefix, auth, bytes), result = await response.text();
      trace.push({ at: time, method: 'PUT', path: '', requestBytes: bytes.length, responseBytes: new TextEncoder().encode(result).length, status: response.status, headers: headerEntries(response.headers) });
      if (!response.ok) throw new Error('vault commit failed');
      return JSON.parse(result) as { token: string };
    },
  } };
  return { vault: new PrivateVault(options), options, bundle, trace, time: (value: number) => { time = value; } };
}
