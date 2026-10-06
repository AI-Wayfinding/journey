import { expect, type BrowserContext, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { PrivateVault, decodeVaultWire, privateIdentity, memberVaultId, verifyPrivateHeader, openPrivateFrame, verifyPrivateContext, importSigningKey, privateHash, privateBytesHash } from '@ai-wayfinding/core';
import type { PrivateCheckpoint, PrivateHeader, VaultCacheRecord } from '@ai-wayfinding/core';
import { headers as previousHeaders, personSecrets } from './stage1-fixtures.js';
import { verifyControlProofs, unwrapJourneyKey, sealControlLabels, sealProjectPayload, signControlProof, newId } from '@ai-wayfinding/core';
import type { Member, JsonObject } from '@ai-wayfinding/core';

export const headers = { ...previousHeaders, 'X-Private-Format': 'private-v1' };
export async function principal(page: Page, id: string): Promise<string> {
  const response = await page.request.get('/v1/journeys', { headers }); expect(response.status()).toBe(200);
  return (await response.json()).journeys.find((j: { id: string }) => j.id === id).principal;
}
export async function controls(page: Page, id: string) {
  const response = await page.request.get(`/v1/journeys/${id}/log`, { headers: { ...headers, 'X-Principal': await principal(page, id) } }); expect(response.status()).toBe(200);
  return (await response.json()).log.map((r: import('@ai-wayfinding/core').ControlInput) => ({ proof: r.proof, envelope: r.envelope })) as import('@ai-wayfinding/core').ControlInput[];
}
export async function stored(page: Page, id: string) {
  const actor = await principal(page, id), secrets = await personSecrets(page), rows = await controls(page, id);
  const response = await page.request.get(`/v1/journeys/${id}/wraps/me`, { headers: { ...headers, 'X-Principal': actor } }); expect(response.status()).toBe(200);
  const keys = await Promise.all(((await response.json()).wraps as { epoch: number; wrap: string }[]).map(w => unwrapJourneyKey({ epoch: w.epoch, recipient: actor, ciphertext: w.wrap }, secrets.identity)));
  const checked = await verifyControlProofs(rows.map(r => r.proof), rows.map(r => r.envelope), { journey: id, creator: rows[0]!.proof.body.creator as Member }, keys);
  if (!checked.ok) throw new Error(checked.error.message);
  return { actor, secrets, rows, keys, state: checked.state, key: keys.find(k => k.epoch === checked.state.currentEpoch)! };
}
export async function change(page: Page, id: string, type: string, body: JsonObject) {
  const c = await stored(page, id), at = new Date().toISOString(), seq = c.state.lastSeq + 1;
  const entry = { v: 1 as const, seq, prev: c.state.lastHash, at, actor: c.actor, type, body };
  const outside = { id: newId(), journey: id, seq, epoch: c.key.epoch, createdAt: at };
  const envelope = type.startsWith('project.') ? await sealProjectPayload(type as 'project.join' | 'project.state', body, {}, outside, c.key) : await sealControlLabels(entry, outside, c.key);
  const proof = await signControlProof(entry, envelope, id, await importSigningKey(c.secrets.signing));
  const response = await page.request.post(`/v1/journeys/${id}/log`, { headers: { ...headers, 'X-Principal': c.actor, 'X-Wayfinding': '1', Origin: new URL(page.url()).origin }, data: { control: { proof, envelope } } }); expect(response.status(), await response.text()).toBe(201);
}
/** Read the actual server API and independently verify all 64 slot digests, signed
 * head and complete decrypted history. Historical opens cannot write or poll. */
export async function forkSnapshot(saved: Awaited<ReturnType<typeof durable>>, text: string) {
  const { signPrivateRecord, newId, sealPrivateSlot, privatePlainBytes, privateDecode, sealPrivateFrame, signPrivateHeader, privateBytesHash, privateHash, canonical } = await import('@ai-wayfinding/core');
  const bundle = structuredClone(saved.branches[0]!.bundle), old = bundle.records.at(-1)!;
  const payload = structuredClone(bundle.payloads.find(p => p.record === old.id)!.payload);
  payload.body.content = { kind: 'document', markdown: text };
  const { sig: _recordSig, ...record } = old;
  const alternate = await signPrivateRecord({ ...record, id: newId(), body: { ...record.body, version: newId() }, payloadHash: await privateHash(payload) }, await importSigningKey(saved.current.secrets.signing));
  bundle.records[bundle.records.length - 1] = alternate; bundle.payloads[bundle.payloads.length - 1] = { record: alternate.id, payload };
  const frame = await openPrivateFrame(saved.snapshot.frame, saved.current.secrets.identity, saved.author.recipient) as { header: PrivateHeader; root: string; directory: { branches: number[][]; initialized: number[] }; contentIdentity: string };
  expect(frame.directory.branches[0]).toHaveLength(1);
  const slots = saved.snapshot.slots.slice(), index = frame.directory.branches[0]![0]!;
  slots[index] = await sealPrivateSlot(privateDecode(frame.root), saved.vault, index, privatePlainBytes(bundle));
  const hashes = await Promise.all(slots.map(s => privateBytesHash(privateDecode(s))));
  const { sig: _headerSig, ...header } = frame.header;
  frame.header = await signPrivateHeader({ ...header, slots: hashes, contentsHash: await privateHash({ slots: hashes, root: frame.root, directory: frame.directory, contentIdentity: frame.contentIdentity }) }, await importSigningKey(saved.current.secrets.signing));
  return { token: saved.snapshot.token, frame: await sealPrivateFrame(frame, saved.author.recipient), slots, checkpoint: { ...saved.snapshot.checkpoint, head: await privateHash(frame.header) }, changed: index };
}
export async function durable(page: Page, id: string) {
  const current = await stored(page, id), author = privateIdentity(current.state.members[current.actor]!.member);
  const vault = await memberVaultId(id, current.actor, author.signingKey, author.recipient);
  const response = await page.request.get(`/v1/journeys/${id}/private-vault?slots=all`, { headers: { ...headers, 'X-Principal': current.actor } });
  expect(response.status()).toBe(200);
  const bytes = await response.body(); await response.dispose();
  const wire = decodeVaultWire(new Uint8Array(bytes), 'all');
  expect(wire.slots).toHaveLength(64);
  for (const slot of wire.slots) expect(Buffer.from(slot.ciphertext, 'base64')).toHaveLength(1_048_576);
  if (!wire.frame) throw new Error('Expected initialized signed vault');
  const frame = await openPrivateFrame(wire.frame, current.secrets.identity, author.recipient) as { header: PrivateHeader };
  expect(await Promise.all(wire.slots.map(s => privateBytesHash(new Uint8Array(Buffer.from(s.ciphertext, 'base64')))))).toEqual(frame.header.slots);
  const context = await verifyPrivateContext({ journey: id, creator: current.rows[0]!.proof.body.creator as import('@ai-wayfinding/core').Member, controls: current.rows }, { now: Date.now(), currentHead: current.state.lastHash! });
  const checked = await verifyPrivateHeader(frame.header, { vault, author }, { contentsHash: frame.header.contentsHash, contexts: [context] });
  const snapshot: VaultCacheRecord = { token: wire.token, frame: wire.frame, slots: wire.slots.map(s => s.ciphertext), checkpoint: checked.checkpoint };
  const reader = new PrivateVault({ identity: current.secrets.identity, signingKey: await importSigningKey(current.secrets.signing), trust: { vault, author }, historical: true, contexts: [context], cache: { read: async () => snapshot, commit: async () => { throw new Error('Historical verifier must not commit'); } }, transport: { read: async () => { throw new Error('Historical verifier must not fetch'); }, commit: async () => { throw new Error('Historical verifier must not commit'); } } });
  await reader.open(); const branches = reader.branches; reader.close();
  return { current, vault, author, snapshot, branches, head: await privateHash(frame.header) };
}
export async function frozen(page: Page) {
  const now = new Date(); await page.clock.install({ time: now }); await page.clock.pauseAt(now);
}
export async function scheduled(page: Page) {
  const committed = page.waitForResponse(r => r.url().endsWith('/private-vault') && r.request().method() === 'PUT');
  await page.clock.runFor(300_000); expect((await committed).status()).toBe(200);
  await expect.poll(async () => { await page.clock.runFor(1000); return page.locator('#private-save-status').textContent(); }).toContain('Verified committed');
}
export async function navigate(page: Page, path: string) {
  await page.evaluate(path => { history.pushState(null, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
  await expect(page.locator('main')).not.toHaveText('Loading…');
}
export async function addPrivate(page: Page, path: string, title: string, body: string, file?: Buffer) {
  await navigate(page, path + '/private/add'); await page.getByLabel('Private title', { exact: true }).fill(title); await page.getByLabel('Private body', { exact: true }).fill(body);
  if (file) await page.getByLabel('Private attachments', { exact: true }).setInputFiles({ name: 'secret.bin', mimeType: 'application/octet-stream', buffer: file });
  await page.getByRole('button', { name: 'Save private artifact', exact: true }).click();
  await expect(page).toHaveURL(/\/private\/[A-Za-z0-9_-]{43}$/);
  await expect(page.locator('#private-save-status')).toContainText('Pending scheduled sync');
  return new URL(page.url()).pathname;
}
export function observe(page: Page) {
  const rows: { method: string; path: string; bytes: number; headers: Record<string, string>; at: number }[] = [];
  page.on('request', request => { if (request.url().includes('/private-vault')) rows.push({ method: request.method(), path: new URL(request.url()).pathname + new URL(request.url()).search.replace(/slots=\d\d,\d\d/, 'slots=two'), bytes: request.postDataBuffer()?.length ?? 0, headers: request.headers(), at: Date.now() }); });
  return rows;
}

// Test-only bundles load the real browser adapters, never a replacement or a
// production test hook. Blank device pages avoid running two UI controllers.
let bundle: Promise<string> | undefined;
async function adapterBundle(): Promise<string> {
  bundle ??= build({ stdin: { contents: "export { BrowserPrivateArtifacts } from './src/private.ts'; export { restorePersonKeys, clearPersonKeys, lockPersonKeys, getPersonKeys } from './src/keys.ts'; export { verifiedJourney } from './src/journey.ts'; export { createProject, participateProject, stateProject } from './src/projects.ts'; export { closePrivateVaults, openJourneyVault, BrowserPrivateStore } from './src/private-store.ts'; export * from '@ai-wayfinding/core';", resolveDir: resolve('.'), sourcefile: 'stage3-device.ts', loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'Stage3', platform: 'browser', target: 'es2022' }).then(r => r.outputFiles[0]!.text);
  return bundle;
}
export async function signedAgent(page: Page, agent: { id: string; signingPrivateKey: CryptoKey }, method: 'GET' | 'PUT', path: string, bytes = new Uint8Array()) {
  const encode = (b: Uint8Array) => Buffer.from(b).toString('base64url'), timestamp = String(Date.now()), nonce = encode(crypto.getRandomValues(new Uint8Array(16)));
  const hash = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
  const signature = encode(new Uint8Array(await crypto.subtle.sign('Ed25519', agent.signingPrivateKey, new TextEncoder().encode([method, path, hash, timestamp, nonce].join('\n')))));
  return page.request.fetch(path, { method, ...(method === 'PUT' ? { data: Buffer.from(bytes) } : {}), headers: { ...headers, 'X-Agent-Session': agent.id, 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': signature, ...(method === 'PUT' ? { 'X-Wayfinding': '1', Origin: new URL(page.url()).origin, 'Content-Type': 'application/octet-stream' } : {}) } });
}
export async function firstDeviceCheckpoint(page: Page, vault: string, identity: string): Promise<PrivateCheckpoint> {
  const encrypted = await page.evaluate(async vault => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('wayfinding-private-' + vault, 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise<string>((resolve, reject) => { const r = db.transaction('encrypted').objectStore('encrypted').get('checkpoint'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); } finally { db.close(); }
  }, vault);
  const { openIdentity } = await import('@ai-wayfinding/core');
  return JSON.parse(await openIdentity(encrypted, [identity]));
}
export async function device(context: BrowserContext, source: Page, id: string, paired?: PrivateCheckpoint) {
  const secrets = await personSecrets(source), actor = (await stored(source, id)).actor;
  const page = await context.newPage();
  await page.route('**/__stage3-device', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Private test device</title>' }));
  await page.goto('/__stage3-device'); await frozen(page); await page.addScriptTag({ content: await adapterBundle() });
  await page.evaluate(async ({ secrets, actor, id, paired }) => {
    const core = (window as any).Stage3;
    // Simulated out-of-band transfer of the SAME existing person keys. No new
    // pairing ceremony or trust protocol is introduced by this fixture.
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const response = await fetch(`/v1/journeys/${id}/log`, { headers: { 'X-Principal': actor, 'X-Client-Version': '0.1.7', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Project-Format': 'project-v1', 'X-Private-Format': 'private-v1' } });
    const rows = (await response.json()).log, publicKey = rows[0].proof.body.creator.signingKey;
    const seal = async (field: string, text: string) => {
      const nonce = crypto.getRandomValues(new Uint8Array(12)), ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode('wayfinding/person-keys/v1/' + field) }, key, new TextEncoder().encode(text)));
      const bytes = new Uint8Array(nonce.length + ciphertext.length); bytes.set(nonce); bytes.set(ciphertext, nonce.length); return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('wayfinding-person-keys', 1); r.onupgradeneeded = () => r.result.createObjectStore('person'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const sealed = { version: 1, identity: await seal('identity', secrets.identity), signing: await seal('signing', JSON.stringify({ publicKey, privateKey: secrets.signing })) };
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('person', 'readwrite'); tx.objectStore('person').put({ key, sealed }, 'current'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
    const keys = await core.restorePersonKeys();
    (window as any).privateContext = await core.verifiedJourney(id, actor, keys);
    (window as any).privateWork = await core.BrowserPrivateArtifacts.open((window as any).privateContext, paired);
  }, { secrets, actor, id, paired });
  return page;
}
