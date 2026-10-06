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
export async function forkSnapshot(saved: Awaited<ReturnType<typeof durable>>, text: string, mode: 'tied' | 'higher' | 'delete' | 'live-against-delete' = 'tied') {
  const { signPrivateRecord, newId, sealPrivateSlot, privatePlainBytes, privateDecode, sealPrivateFrame, signPrivateHeader, privateBytesHash, privateHash } = await import('@ai-wayfinding/core');
  const bundle = structuredClone(saved.branches[0]!.bundle), key = await importSigningKey(saved.current.secrets.signing);
  if (mode === 'live-against-delete') { const deleted = bundle.records.pop()!; expect(deleted.type).toBe('private.delete'); bundle.payloads = bundle.payloads.filter(p => p.record !== deleted.id); }
  for (let step = 0; step < (mode === 'live-against-delete' ? 2 : 1); step++) {
    const old = bundle.records.at(-1)!, { sig: _recordSig, ...record } = old;
    const payload = mode === 'delete' ? { type: 'artifact.tombstone', typeVersion: 1, body: {} } : structuredClone(bundle.payloads.find(p => p.record === old.id)!.payload);
    if (mode !== 'delete') payload.body.content = { kind: 'document', markdown: text };
    const body = mode === 'delete' ? { artifact: old.body.artifact, author: old.body.author, actor: old.body.actor, predecessor: old.body.version } : { ...old.body, version: newId(), predecessor: mode === 'tied' ? old.body.predecessor : old.body.version };
    const alternate = await signPrivateRecord({ ...record, id: newId(), seq: mode === 'tied' ? old.seq : old.seq + 1, prev: mode === 'tied' ? old.prev : await privateHash(old), type: mode === 'tied' ? old.type : mode === 'delete' ? 'private.delete' : 'private.version', body, payloadHash: await privateHash(payload) }, key);
    if (mode === 'tied') { bundle.records[bundle.records.length - 1] = alternate; bundle.payloads[bundle.payloads.length - 1] = { record: alternate.id, payload }; }
    else { bundle.records.push(alternate); bundle.payloads.push({ record: alternate.id, payload }); }
  }
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
  bundle ??= build({ stdin: { contents: "export { BrowserPrivateArtifacts } from './src/private.ts'; export { restorePersonKeys, clearPersonKeys, lockPersonKeys, getPersonKeys } from './src/keys.ts'; export { verifiedJourney } from './src/journey.ts'; export { createProject, participateProject, stateProject } from './src/projects.ts'; export { closePrivateVaults, openJourneyVault, BrowserPrivateStore, browserVaultTransport } from './src/private-store.ts'; export * from '@ai-wayfinding/core';", resolveDir: resolve('.'), sourcefile: 'stage3-device.ts', loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'Stage3', platform: 'browser', target: 'es2022' }).then(r => r.outputFiles[0]!.text);
  return bundle;
}
export async function signedAgent(page: Page, agent: { id: string; signingPrivateKey: CryptoKey }, method: 'GET' | 'PUT', path: string, bytes = new Uint8Array()) {
  const encode = (b: Uint8Array) => Buffer.from(b).toString('base64url'), timestamp = String(Date.now()), nonce = encode(crypto.getRandomValues(new Uint8Array(16)));
  const hash = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
  const signature = encode(new Uint8Array(await crypto.subtle.sign('Ed25519', agent.signingPrivateKey, new TextEncoder().encode([method, path, hash, timestamp, nonce].join('\n')))));
  return page.request.fetch(path, { method, ...(method === 'PUT' ? { data: Buffer.from(bytes) } : {}), headers: { ...headers, 'X-Agent-Session': agent.id, 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': signature, ...(method === 'PUT' ? { 'X-Wayfinding': '1', Origin: new URL(page.url()).origin, 'Content-Type': 'application/octet-stream' } : {}) } });
}
/** Admit real authenticated/link credentials with a signed person approval. */
export async function credentialAgent(page: Page, id: string, keyStorage: 'memory' | 'link' = 'memory', lifetime = 3_600_000) {
  const core = await import('@ai-wayfinding/core'), age = await core.createAgeIdentity(), signing = await core.createSigningIdentity();
  const started = await page.request.post('/v1/agent-sessions', { headers: { ...headers, 'X-Wayfinding': '1', Origin: new URL(page.url()).origin }, data: { journeyId: id, agentPublicKey: { recipient: age.recipient, signingKey: signing.publicKey }, requestedScope: 'read', keyStorage, remembered: keyStorage === 'link' } });
  expect(started.status()).toBe(201); const pending = await started.json();
  const agent = await (await page.request.get('/v1/agent-sessions/' + pending.id)).json(), c = await stored(page, id), expiresAt = Date.now() + lifetime;
  const member: Member = { id: agent.principal, kind: 'agent', recipient: age.recipient, signingKey: signing.publicKey, addedBy: c.actor, scope: 'read', expiresAt: new Date(expiresAt).toISOString() };
  const entry = { v: 1 as const, seq: c.state.lastSeq + 1, prev: c.state.lastHash, at: new Date().toISOString(), actor: c.actor, type: 'member.add', body: { member, kind: 'agent', grants: [] } };
  const envelope = await sealControlLabels(entry, { id: newId(), journey: id, seq: entry.seq, epoch: c.key.epoch, createdAt: entry.at }, c.key);
  const proof = await signControlProof(entry, envelope, id, await importSigningKey(c.secrets.signing)), [wrap] = await core.wrapJourneyKey(c.key, [member]);
  const approved = await page.request.post('/v1/agent-sessions/' + pending.id + '/approve', { headers: { ...headers, 'X-Wayfinding': '1', Origin: new URL(page.url()).origin }, data: { code: pending.code, principal: c.actor, scope: 'read', expiresAt, wrap: wrap!.ciphertext, control: { proof, envelope } } });
  expect(approved.status(), await approved.text()).toBe(200);
  return { id: pending.id as string, principal: agent.principal as string, identity: age.identity, signingPrivateKey: await importSigningKey(signing.privateKey), expiresAt };
}
/** Exercise fetch in Chromium with real signed credentials, not the person's cookie. */
export async function credentialRead(page: Page, agent: { id: string; signingPrivateKey: CryptoKey }, path: string, extra: Record<string, string> = {}) {
  const encode = (b: Uint8Array) => Buffer.from(b).toString('base64url'), timestamp = String(Date.now()), nonce = encode(crypto.getRandomValues(new Uint8Array(16)));
  const hash = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array())));
  const signature = encode(new Uint8Array(await crypto.subtle.sign('Ed25519', agent.signingPrivateKey, new TextEncoder().encode(['GET', path, hash, timestamp, nonce].join('\n')))));
  return page.evaluate(async ({ path, headers }) => {
    const response = await fetch(path, { credentials: 'omit', headers }), bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) return { status: response.status, text: new TextDecoder().decode(bytes), frame: null, bytes: bytes.length };
    if (path.includes('/private-vault?')) return { status: response.status, text: '', frame: (window as any).Stage3.decodeVaultWire(bytes, [0, 1]).frame as string | null, bytes: bytes.length };
    return { status: response.status, text: new TextDecoder().decode(bytes), frame: null, bytes: bytes.length };
  }, { path, headers: { ...headers, ...extra, 'X-Agent-Session': agent.id, 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': signature } });
}
export async function adapterPage(context: BrowserContext) {
  const page = await context.newPage();
  await page.route('**/__stage3-device', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Private test device</title>' }));
  await page.goto('/__stage3-device'); await frozen(page); await page.addScriptTag({ content: await adapterBundle() });
  return page;
}
export async function firstDeviceCheckpoint(page: Page, vault: string, identity: string): Promise<PrivateCheckpoint> {
  const encrypted = await page.evaluate(async vault => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('wayfinding-private-' + vault, 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise<string>((resolve, reject) => { const r = db.transaction('encrypted').objectStore('encrypted').get('checkpoint'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); } finally { db.close(); }
  }, vault);
  const { openIdentity } = await import('@ai-wayfinding/core');
  return JSON.parse(await openIdentity(encrypted, [identity]));
}
export async function device(context: BrowserContext, source: Page, id: string, paired?: PrivateCheckpoint, transferred?: { secrets: { identity: string; signing: string }; actor: string }) {
  const secrets = transferred?.secrets ?? await personSecrets(source), actor = transferred?.actor ?? (await stored(source, id)).actor;
  const page = await context.newPage();
  await page.route('**/__stage3-device', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Private test device</title>' }));
  await page.goto('/__stage3-device'); await frozen(page); await page.addScriptTag({ content: await adapterBundle() });
  await page.evaluate(async ({ secrets, actor, id, paired }) => {
    const core = (window as any).Stage3;
    // Simulated out-of-band transfer of the SAME existing person keys. No new
    // pairing ceremony or trust protocol is introduced by this fixture.
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const response = await fetch(`/v1/journeys/${id}/log`, { headers: { 'X-Principal': actor, 'X-Client-Version': '0.1.7', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Project-Format': 'project-v1', 'X-Private-Format': 'private-v1' } });
    const rows = (await response.json()).log;
    const authority = await core.verifyControlProofs(rows.map((r: any) => r.proof), rows.map((r: any) => r.envelope), { journey: id, creator: rows[0].proof.body.creator });
    if (!authority.ok) throw new Error(authority.error.message);
    const publicKey = authority.state.members[actor].member.signingKey;
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

/** Real browser storage/transport with only the portable RNG seam injected. */
export async function deterministicVault(page: Page, bundle?: import('@ai-wayfinding/core').PrivateBundle) {
  return page.evaluate(async bundle => {
    const core = (window as any).Stage3, ctx = (window as any).privateContext;
    core.closePrivateVaults();
    const author = core.privateIdentity(ctx.state.members[ctx.principal].member), vault = await core.memberVaultId(ctx.id, ctx.principal, author.signingKey, author.recipient);
    const context = await core.verifyPrivateContext({ journey: ctx.id, creator: ctx.controls[0].proof.body.creator, controls: ctx.controls }, { now: Date.now(), currentHead: ctx.state.lastHash });
    const session = await core.privatePersonSession(context, author, ctx.keys.signingPrivateKey, ctx.keys.identity);
    (window as any).traffic = []; (window as any).orders = 0;
    const transport = core.browserVaultTransport(ctx.id, ctx.principal, async (path: string, init: RequestInit) => {

      const bytes = init.body ? new Uint8Array(init.body as Uint8Array) : undefined;
      const indices = bytes ? core.decodeVaultPatch(bytes).slots.map((s: { index: number }) => s.index) : new URL(path, location.origin).searchParams.get('slots');
      const row = { at: Date.now(), method: init.method, path, indices, requestBytes: bytes?.length ?? 0, requestHeaders: init.headers, status: 0, responseBytes: 0, responseHeaders: {} };
      (window as any).traffic.push(row);
      const response = await fetch(path, init); row.status = response.status; row.responseBytes = (await response.clone().arrayBuffer()).byteLength; row.responseHeaders = Object.fromEntries(response.headers);
      return response;
    });
    const options = { identity: ctx.keys.identity, signingKey: ctx.keys.signingPrivateKey, trust: { vault, author }, contexts: [context], sessions: [session], transport, randomOrder: () => {
      const first = [[47, 12], [31, 6], [55, 18], [24, 3]][(window as any).orders++];
      if (!first) throw new Error('Unexpected extra private sync');
      return [...first, ...Array.from({ length: 64 }, (_, i) => i).filter(i => !first.includes(i))];
    } };
    const controller = new core.PrivateVault({ ...options, cache: new core.BrowserPrivateStore(vault, options) });
    (window as any).trafficVault = controller; await controller.open();
    if (bundle) await controller.stage(bundle);
    controller.start(); return Date.now();
  }, bundle);
}
