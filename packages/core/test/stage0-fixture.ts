import { expect } from 'vitest';
import { createAgeIdentity, createSigningIdentity, importSigningKey, newId, hashEntry, signEntry, verifyLog } from '../src/index.js';
import type { LogEntry, Member, ControlProof, Envelope, JsonObject, ArtifactActionType, ProjectActionType } from '../src/index.js';
import { generateJourneyKey, hashControlProof, sealControlLabels, sealArtifactPayload, signControlProof, verifyControlProofs, isArtifactAction, artifactTypeHash, isProjectAction, sealProjectPayload } from '../src/index.js';
export async function person() {
  const sign = await createSigningIdentity(), age = await createAgeIdentity();
  return { member: { id: newId(), kind: 'person', recipient: age.recipient, signingKey: sign.publicKey } as Member, key: await importSigningKey(sign.privateKey), identity: age.identity };
}
export async function agent(owner: string, scope: 'read' | 'readwrite' = 'readwrite') {
  const p = await person(); p.member = { id: p.member.id, kind: 'agent', recipient: p.member.recipient, signingKey: p.member.signingKey, addedBy: owner, scope }; return p;
}
export async function genesis(p: Awaited<ReturnType<typeof person>>, minimum = '0.1.5') {
  return [await signEntry({ v: 1, seq: 0, prev: null, at: '2026-01-01T00:00:00.000Z', actor: p.member.id, type: 'genesis', body: { journey: newId(), name: 'Journey', description: 'Private', creator: p.member, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: minimum } }, p.key)];
}
export async function append(entries: LogEntry[], p: Awaited<ReturnType<typeof person>>, type: string, body: LogEntry['body']) {
  return [...entries, await signEntry({ v: 1, seq: entries.length, prev: await hashEntry(entries.at(-1)!), at: '2026-01-02T00:00:00.000Z', actor: p.member.id, type, body }, p.key)];
}
export async function state(entries: LogEntry[]) { const v = await verifyLog(entries); if (!v.ok) throw Error(v.error.message); return v.state; }
export async function rejected(entries: LogEntry[], code?: string) { const v = await verifyLog(entries); expect(v.ok).toBe(false); if (!v.ok && code) expect(v.error.code).toBe(code); }
export const settings = { name: 'Changed', description: 'New description', defaultRole: 'read-only', visibility: 'private', joiningPolicy: 'invitation-only' };

/** Signed public-chain fixture; legacy regression helpers above remain unchanged. */
export async function artifactFixture(minimum = '0.1.5') {
  const guide = await person(), key = generateJourneyKey(), journey = newId();
  const f = { guide, key, journey, controls: [] as { proof: ControlProof; envelope: Envelope }[], trust: { journey, creator: guide.member } };
  await artifactAppend(f, guide, 'genesis', { journey, name: 'Secret journey', description: 'Private description', creator: guide.member, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: minimum });
  return f;
}
export type ArtifactFixture = Awaited<ReturnType<typeof artifactFixture>>;
export const documentPayload = () => ({ title: 'Secret title', tags: ['Note', 'note'], content: { kind: 'document', markdown: 'Private Markdown' }, attachments: [] });
export async function artifactBody(actor: string, overrides: JsonObject = {}): Promise<JsonObject> {
  return { format: 'artifact-v1', artifact: newId(), version: newId(), author: actor, actor, typeHash: await artifactTypeHash('document'), blobs: [], ...overrides };
}
export async function artifactAppend(f: ArtifactFixture, actor: Awaited<ReturnType<typeof person>>, type: string, body: JsonObject, payload: JsonObject = documentPayload(), at = '2026-01-02T00:00:00.000Z') {
  const entry = { v: 1 as const, seq: f.controls.length, prev: f.controls.length ? await hashControlProof(f.controls.at(-1)!.proof) : null, at, actor: actor.member.id, type, body };
  const outside = { id: newId(), journey: f.journey, seq: entry.seq, epoch: f.key.epoch, createdAt: at };
  const envelope = isProjectAction(type) ? await sealProjectPayload(type as ProjectActionType, body, payload, outside, f.key) : isArtifactAction(type) ? await sealArtifactPayload(type as ArtifactActionType, body, payload, outside, f.key) : await sealControlLabels(entry, outside, f.key);
  const control = { proof: await signControlProof(entry, envelope, f.journey, actor.key), envelope };
  f.controls.push(control);
  return control;
}
export const artifactResult = (f: ArtifactFixture, keyed = true) => verifyControlProofs(f.controls.map(c => c.proof), f.controls.map(c => c.envelope), f.trust, keyed ? [f.key] : []);

// Portable Stage 3 fixtures use complete signed Stage 0–2 authority histories.
import { PRIVATE_FORMAT, PRIVATE_SLOT_COUNT, newPrivateId, privateIdentity, privateAuthority, privatePersonSession, verifyPrivateContext, privateHash, signPrivateRecord, verifyPrivateRecords, signPrivateHeader, memberVaultId } from '../src/index.js';
import type { PrivateRecord, PrivatePayload, PrivateIdentity, PrivateContext, PrivateHeader, ProtocolRecord } from '../src/index.js';
export const now = Date.parse('2026-01-02T00:00:00.000Z');
export type Actor = Awaited<ReturnType<typeof person>>;
export const jsonIdentity = (v: PrivateIdentity) => ({ kind: v.kind, signingKey: v.signingKey, recipient: v.recipient });
export const content = (title = 'Private title 🌱'): ProtocolRecord => ({ type: 'artifact.content', typeVersion: 1, body: { title, tags: ['Private'], content: { kind: 'document', markdown: 'Never shared' }, attachments: [] } });
export const marker = (): ProtocolRecord => ({ type: 'artifact.tombstone', typeVersion: 1, body: {} });
export async function contextFor(f: Awaited<ReturnType<typeof artifactFixture>>, options: { current?: boolean; visibility?: 'private' | 'public'; now?: number } = {}) {
  const head = await (await import('../src/index.js')).hashControlProof(f.controls.at(-1)!.proof);
  return verifyPrivateContext({ journey: f.journey, creator: f.guide.member, controls: f.controls }, { now: options.now ?? now, ...(options.current === false ? {} : { currentHead: head }), visibility: options.visibility });
}
export async function privateFixture() {
  const f = await artifactFixture('0.1.7'), author = await person(), reader = await agent(author.member.id, 'read'), writer = await agent(author.member.id), foreign = await agent(f.guide.member.id);
  await artifactAppend(f, f.guide, 'member.add', { member: author.member, kind: 'person', grants: [] });
  await artifactAppend(f, f.guide, 'member.role', { member: author.member.id, role: 'read-write' });
  for (const p of [reader, writer]) await artifactAppend(f, author, 'member.add', { member: p.member, kind: 'agent', grants: [] });
  await artifactAppend(f, f.guide, 'member.add', { member: foreign.member, kind: 'agent', grants: [] });
  const context = await contextFor(f), identity = privateIdentity(author.member), session = await privatePersonSession(context, identity, author.key, author.identity);
  return { f, author, reader, writer, foreign, context, identity, session, vault: await memberVaultId(context.journey, author.member.id, identity.signingKey, identity.recipient), copy: newPrivateId(), artifact: newPrivateId() };
}
export async function record(context: PrivateContext, actor: Actor, vault: string, copy: string, artifact: string, author: PrivateIdentity, type: PrivateRecord['type'] = 'private.create', old: readonly PrivateRecord[] = [], payload: ProtocolRecord = content(), body: JsonObject = {}) {
  const defaults: JsonObject = type === 'private.create' || type === 'private.version' || type === 'private.copy' ? { version: newId(), typeHash: await artifactTypeHash('document'), blobs: [], predecessor: type === 'private.version' ? old.filter(r => ['private.create', 'private.version', 'private.copy'].includes(r.type)).at(-1)!.body.version : null }
    : type === 'private.comment' ? { comment: newId() } : type === 'private.project' ? { project: null, predecessor: null } : { predecessor: old.filter(r => ['private.create', 'private.version', 'private.copy'].includes(r.type)).at(-1)!.body.version };
  const r = await signPrivateRecord({ format: PRIVATE_FORMAT, v: 1, id: newId(), vault, copy, seq: old.length, prev: old.length ? await privateHash(old.at(-1)!) : null, at: new Date(now).toISOString(), actor: privateIdentity(actor.member), authority: privateAuthority(context, privateIdentity(actor.member)), type, body: { artifact, author: jsonIdentity(author), actor: jsonIdentity(privateIdentity(actor.member)), ...defaults, ...body }, payloadHash: await privateHash(payload) }, actor.key);
  return { record: r, payload: { record: r.id, payload } as PrivatePayload };
}
export async function created(f: Awaited<ReturnType<typeof privateFixture>>) {
  const first = await record(f.context, f.author, f.vault, f.copy, f.artifact, f.identity);
  const records = [first.record], payloads = [first.payload];
  const view = await verifyPrivateRecords(records, payloads, [f.context], { vault: f.vault, author: f.identity }, { sessions: [f.session] });
  return { ...first, records, payloads, view };
}
export async function header(f: Awaited<ReturnType<typeof privateFixture>>, version = 1, prev: string | null = null, digest?: string): Promise<PrivateHeader> {
  const contentsHash = digest ?? await privateHash('complete ciphertext slots');
  return signPrivateHeader({ format: PRIVATE_FORMAT, v: 1, vault: f.vault, author: f.identity, version, prev, contentsHash, slots: Array(PRIVATE_SLOT_COUNT).fill(await privateHash('slot')) }, f.author.key);
}
