import rules from '@ai-wayfinding/rules';
import type { PrivateCopy as RuleCopy, PrivateAction, PrivateCredential, ProjectInfo } from '@ai-wayfinding/rules';
import { asBuffer, decode, encode, utf8 } from './codec.js';
import { canonical } from './log.js';
import type { Member, LogState } from './log.js';
import { verifyControlProofs, hashControlProof } from './controlProof.js';
import type { ControlProof } from './controlProof.js';
import type { Envelope } from './envelope.js';
import { isId } from './ids.js';
import { deriveRecipient, openIdentity, sealIdentity } from './keys.js';
import type { AgeIdentity } from './keys.js';
import { artifactTypeHash, ARTIFACT_TYPES, validDigest, validateArtifactPayload, MAX_ARTIFACT_PAYLOAD_BYTES, MAX_BLOB_BYTES, copyArtifactRecord } from './artifacts.js';
import type { ArtifactPayload } from './artifacts.js';
import type { JsonObject, ProtocolRecord } from './types.js';
import { normalizedMembers, ruleList } from './rules.js';
import { ruleVersion, CLIENT_VERSION, CLIENT_CAPABILITIES, supportsPrivate } from './versions.js';

export const PRIVATE_FORMAT = 'private-v1' as const;
export const PRIVATE_SLOT_COUNT = 64;
export const PRIVATE_SLOT_BYTES = 1_048_576;
export const PRIVATE_SYNC_MS = 300_000;
export const PRIVATE_PATCH_SLOTS = 2;
export const PRIVATE_ACTIONS = ['private.create', 'private.version', 'private.comment', 'private.delete', 'private.copy', 'private.project'] as const;
export type PrivateActionType = typeof PRIVATE_ACTIONS[number];
export interface PrivateIdentity { kind: 'person' | 'agent'; signingKey: string; recipient: string }
export interface PrivateBinding { journey: string; principal: string; admissionHash: string }
export interface PrivateAuthority extends PrivateBinding { head: string; epoch: number }
export interface PrivateBlob extends JsonObject { v: 1; vault: string; copy: string; id: string; generation: number; size: number; ciphertextSize: number; nonce: string; digest: string; contentHash: string }
export interface PrivateRecord {
  format: 'private-v1'; v: 1; id: string; vault: string; copy: string; seq: number; prev: string | null; at: string;
  actor: PrivateIdentity; authority: PrivateAuthority; type: PrivateActionType; body: JsonObject; payloadHash: string; sig: string;
}
export interface PrivateOrigin { journey: string; copy: string; artifact: string; version: string; recordHash: string }
export interface PrivatePayload { record: string; payload: ProtocolRecord }
export interface PrivateCopyState {
  copy: string; artifact: string; author: PrivateIdentity; journey: string; typeHash: string; head: string;
  deleted: boolean; project: string | null; placement: string | null; records: PrivateRecord[]; payloads: PrivatePayload[];
}
export interface PrivateAuthorityHistory { journey: string; creator: Member; controls: { proof: ControlProof; envelope: Envelope }[] }
/** Opaque verified authority. A cast, cloned object or caller-owned index is not a capability. */
export interface PrivateContext { readonly journey: string; readonly head: string; readonly visibility: 'private' | 'public' }
type ContextData = { state: LogState; admissions: Map<string, string>; history: PrivateAuthorityHistory; current: boolean; now: number };
const contexts = new WeakMap<PrivateContext, ContextData>();
const identities = new WeakMap<PrivateContext, Map<string, PrivateIdentity>>();
export const privateObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const privateShape = (v: Record<string, unknown>, fields: readonly string[]) => Object.keys(v).sort().join(',') === [...fields].sort().join(',');
const exact = (v: unknown, fields: readonly string[]) => privateObject(v) && privateShape(v, fields);
const nonnegative = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const positive = (v: unknown): v is number => nonnegative(v) && v > 0;
const base64 = (v: unknown, bytes: number): v is string => {
  if (typeof v !== 'string') return false;
  try { return decode(v).length === bytes && encode(decode(v)) === v; } catch { return false; }
};
export const validPrivateId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v) && base64(v.replace(/-/g, '+').replace(/_/g, '/') + '=', 32);
export function newPrivateId(): string { return encode(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export async function privateHash(value: unknown): Promise<string> { return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(utf8(canonical(value)))))); }
export const copyPrivateIdentity = (v: PrivateIdentity): PrivateIdentity => ({ kind: v.kind, signingKey: v.signingKey, recipient: v.recipient });
export function validatePrivateIdentity(v: unknown): v is PrivateIdentity {
  return exact(v, ['kind', 'signingKey', 'recipient']) && privateObject(v) && (v.kind === 'person' || v.kind === 'agent') && base64(v.signingKey, 32) && typeof v.recipient === 'string' && /^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(v.recipient);
}
export const privateIdentity = (v: Member): PrivateIdentity => ({ kind: v.kind, signingKey: v.signingKey, recipient: v.recipient });
const sameIdentity = (a: PrivateIdentity, b: PrivateIdentity) => canonical(a) === canonical(b);
const copyAuthority = (v: PrivateAuthority): PrivateAuthority => ({ journey: v.journey, principal: v.principal, admissionHash: v.admissionHash, head: v.head, epoch: v.epoch });
const validateAuthority = (v: unknown): v is PrivateAuthority => exact(v, ['journey', 'principal', 'admissionHash', 'head', 'epoch']) && privateObject(v) && isId(v.journey) && isId(v.principal) && validDigest(v.admissionHash) && validDigest(v.head) && positive(v.epoch);
function contextData(context: PrivateContext): ContextData {
  const data = contexts.get(context); if (!data) throw new Error('Unverified private authority'); return data;
}
export async function verifyPrivateContext(history: PrivateAuthorityHistory, options: { now: number; currentHead?: string; visibility?: 'private' | 'public' }): Promise<PrivateContext> {
  if (!exact(history, ['journey', 'creator', 'controls']) || !Array.isArray(history.controls) || !Number.isFinite(options.now)) throw new Error('Invalid private authority history');
  const checked = await verifyControlProofs(history.controls.map(c => c.proof), history.controls.map(c => c.envelope), { journey: history.journey, creator: history.creator });
  if (!checked.ok) throw new Error('Invalid private authority: ' + checked.error.message);
  if (options.currentHead !== undefined && options.currentHead !== checked.state.lastHash) throw new Error('Stale private authority');
  if (!supportsPrivate(CLIENT_VERSION, checked.state.minClientVersion, CLIENT_CAPABILITIES)) throw new Error('Unsupported private authority minimum');
  const admissions = new Map<string, string>();
  const known = new Map<string, PrivateIdentity>();
  for (const row of history.controls) {
    const proof = row.proof;
    if (proof.type === 'genesis' || proof.type === 'member.add') {
      // SAFETY: public replay has validated this action's exact admitted Member fields.
      const member = proof.body[proof.type === 'genesis' ? 'creator' : 'member'] as unknown as Member;
      admissions.set(member.id, await hashControlProof(proof)); known.set(member.id, privateIdentity(member));
    }
  }
  const context: PrivateContext = Object.freeze({ journey: history.journey, head: checked.state.lastHash!, visibility: options.visibility ?? 'private' });
  // Keep a detached copy: later caller mutation cannot change a verified authority.
  contexts.set(context, { state: checked.state, admissions, history: JSON.parse(canonical(history)) as PrivateAuthorityHistory, current: options.currentHead !== undefined, now: options.now });
  identities.set(context, known); return context;
}
export function privateBinding(context: PrivateContext, identity: PrivateIdentity): PrivateBinding {
  const data = contextData(context);
  const principal = [...identities.get(context)!].find(([id, value]) => sameIdentity(value, identity) && data.state.members[id])?.[0];
  if (!principal) throw new Error('Private identity has no verified admission');
  return { journey: context.journey, principal, admissionHash: data.admissions.get(principal)! };
}
export function privateAuthority(context: PrivateContext, actor: PrivateIdentity): PrivateAuthority {
  return { ...privateBinding(context, actor), head: context.head, epoch: contextData(context).state.currentEpoch };
}
export function privateAuthorityHistory(context: PrivateContext): PrivateAuthorityHistory { return JSON.parse(canonical(contextData(context).history)) as PrivateAuthorityHistory; }

export interface PrivateSession { readonly identity: PrivateIdentity; readonly binding: PrivateBinding }
const sessions = new WeakMap<PrivateSession, { context: PrivateContext; credential: PrivateCredential }>();
async function verifySignature(identity: PrivateIdentity, message: unknown, sig: string): Promise<void> {
  if (!base64(sig, 64)) throw new Error('Invalid private signature');
  const key = await crypto.subtle.importKey('raw', asBuffer(decode(identity.signingKey)), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, asBuffer(decode(sig)), asBuffer(utf8(canonical(message))))) throw new Error('Private signature mismatch');
}
export async function signPrivateMessage(message: unknown, key: CryptoKey): Promise<string> { return encode(new Uint8Array(await crypto.subtle.sign('Ed25519', key, asBuffer(utf8(canonical(message)))))); }
function session(context: PrivateContext, identity: PrivateIdentity, credential: PrivateCredential): PrivateSession {
  const value = Object.freeze({ identity: Object.freeze(copyPrivateIdentity(identity)), binding: Object.freeze(privateBinding(context, identity)) });
  sessions.set(value, { context, credential }); return value;
}
/** Local authenticated agent keys prove possession independently of a person handoff.
 * Link/unknown credentials can never acquire this session. */
export async function privateAgentSession(context: PrivateContext, identity: PrivateIdentity, key: CryptoKey, age: AgeIdentity, credential: 'authenticated' | 'link' | 'unknown'): Promise<PrivateSession> {
  if (credential !== 'authenticated' || !validatePrivateIdentity(identity) || identity.kind !== 'agent' || await deriveRecipient(age) !== identity.recipient) throw new Error('Invalid authenticated private agent keys');
  const challenge = { format: PRIVATE_FORMAT, purpose: 'session', authority: privateAuthority(context, identity), challenge: newPrivateId() };
  await verifySignature(identity, challenge, await signPrivateMessage(challenge, key));
  return session(context, identity, { $: 'PrivateAuthenticatedAgent' });
}
export async function privatePersonSession(context: PrivateContext, identity: PrivateIdentity, key: CryptoKey, age: AgeIdentity): Promise<PrivateSession> {
  if (!validatePrivateIdentity(identity) || identity.kind !== 'person' || await deriveRecipient(age) !== identity.recipient) throw new Error('Invalid person private keys');
  const challenge = { format: PRIVATE_FORMAT, purpose: 'session', authority: privateAuthority(context, identity), challenge: newPrivateId() };
  await verifySignature(identity, challenge, await signPrivateMessage(challenge, key));
  return session(context, identity, { $: 'PrivatePersonCredential' });
}
export interface PrivateChallenge { message: { format: 'private-v1'; purpose: 'handoff'; author: PrivateIdentity; journey: string; principal: string; admissionHash: string; recipient: string; challenge: string }; ciphertext: string }
const challenges = new WeakMap<PrivateChallenge, { context: PrivateContext; author: PrivateIdentity; agent: PrivateIdentity; used: boolean }>();
export async function createPrivateChallenge(context: PrivateContext, author: PrivateSession, agent: PrivateIdentity): Promise<PrivateChallenge> {
  const auth = sessions.get(author); if (!auth || auth.context !== context || author.identity.kind !== 'person' || !contextData(context).current || !validatePrivateIdentity(agent) || agent.kind !== 'agent') throw new Error('Invalid private handoff author');
  const binding = privateBinding(context, agent);
  const message = { format: PRIVATE_FORMAT, purpose: 'handoff' as const, author: copyPrivateIdentity(author.identity), journey: context.journey, principal: binding.principal, admissionHash: binding.admissionHash, recipient: agent.recipient, challenge: newPrivateId() };
  const value = Object.freeze({ message: Object.freeze(message), ciphertext: await sealIdentity(message.challenge, [agent.recipient]) });
  challenges.set(value, { context, author: author.identity, agent: copyPrivateIdentity(agent), used: false }); return value;
}
/** Local-only possession protocol: no server hint or a default class can grant it. */
export async function authenticatePrivateAgent(challenge: PrivateChallenge, response: { sig: string; opened: string }, credential: 'authenticated' | 'link' | 'unknown'): Promise<PrivateSession> {
  const data = challenges.get(challenge); if (!data || data.used) throw new Error('Unknown or consumed private challenge');
  data.used = true;
  if (credential !== 'authenticated' || !exact(response, ['sig', 'opened']) || response.opened !== challenge.message.challenge) throw new Error('Private handoff possession failed');
  await verifySignature(data.agent, challenge.message, response.sig);
  const value = session(data.context, data.agent, { $: 'PrivateAuthenticatedAgent' });
  if (!privateAccess(data.context, data.author, value, false)) throw new Error('Private agent is not in audience'); return value;
}
export async function answerPrivateChallenge(challenge: PrivateChallenge, key: CryptoKey, identity: AgeIdentity): Promise<{ sig: string; opened: string }> {
  return { sig: await signPrivateMessage(challenge.message, key), opened: await openIdentity(challenge.ciphertext, [identity]) };
}
export function privateAccess(context: PrivateContext, author: PrivateIdentity, actor: PrivateSession, write = false): boolean {
  const data = contextData(context), auth = sessions.get(actor);
  if (!auth || auth.context !== context) return false;
  let binding: PrivateBinding;
  try { binding = privateBinding(context, author); } catch { return false; }
  const model = normalizedMembers(data.state, [binding.principal, actor.binding.principal], data.now);
  return write ? rules.private_write(model.members, model.id(binding.principal), model.id(actor.binding.principal), auth.credential, ruleVersion(data.state.minClientVersion), data.state.pendingRotation === true, data.current)
    : rules.private_audience(model.members, model.id(binding.principal), model.id(actor.binding.principal), auth.credential);
}

export function validatePrivateBlob(v: unknown): v is PrivateBlob {
  return exact(v, ['v', 'vault', 'copy', 'id', 'generation', 'size', 'ciphertextSize', 'nonce', 'digest', 'contentHash']) && privateObject(v) && v.v === 1 && validPrivateId(v.vault) && validPrivateId(v.copy) && validPrivateId(v.id) && positive(v.generation) && nonnegative(v.size) && v.size <= MAX_BLOB_BYTES && v.ciphertextSize === v.size + 16 && base64(v.nonce, 12) && validDigest(v.digest) && validDigest(v.contentHash);
}
export const copyPrivateBlob = (v: PrivateBlob): PrivateBlob => ({ v: 1, vault: v.vault, copy: v.copy, id: v.id, generation: v.generation, size: v.size, ciphertextSize: v.ciphertextSize, nonce: v.nonce, digest: v.digest, contentHash: v.contentHash });
function bodyFields(type: PrivateActionType, onVersion: boolean): string[] {
  const common = ['artifact', 'author', 'actor'];
  switch (type) {
    case 'private.create': case 'private.version': return [...common, 'version', 'typeHash', 'blobs', 'predecessor'];
    case 'private.copy': return [...common, 'version', 'typeHash', 'blobs', 'predecessor', 'origin', 'destination', 'snapshotHash'];
    case 'private.comment': return [...common, 'comment', ...(onVersion ? ['onVersion'] : [])];
    case 'private.delete': return [...common, 'predecessor'];
    case 'private.project': return [...common, 'project', 'predecessor'];
  }
}
export function validatePrivateRecord(v: unknown): v is PrivateRecord {
  if (!exact(v, ['format', 'v', 'id', 'vault', 'copy', 'seq', 'prev', 'at', 'actor', 'authority', 'type', 'body', 'payloadHash', 'sig']) || !privateObject(v) || v.format !== PRIVATE_FORMAT || v.v !== 1 || !isId(v.id) || !validPrivateId(v.vault) || !validPrivateId(v.copy) || !nonnegative(v.seq) || !(v.prev === null || validDigest(v.prev)) || typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at)) || !validatePrivateIdentity(v.actor) || !validateAuthority(v.authority) || !(PRIVATE_ACTIONS as readonly unknown[]).includes(v.type) || !privateObject(v.body) || !validDigest(v.payloadHash) || !base64(v.sig, 64)) return false;
  const b = v.body, type = v.type as PrivateActionType;
  if (!privateShape(b, bodyFields(type, Object.hasOwn(b, 'onVersion'))) || !validPrivateId(b.artifact) || !validatePrivateIdentity(b.author) || !validatePrivateIdentity(b.actor) || !sameIdentity(b.actor, v.actor)) return false;
  if (type === 'private.comment') return isId(b.comment) && (b.onVersion === undefined || isId(b.onVersion));
  const { project, predecessor } = b;
  if (type === 'private.project') return (project === null || isId(project)) && (predecessor === null || validDigest(predecessor));
  if (type === 'private.delete') return isId(b.predecessor);
  if (!isId(b.version) || !validDigest(b.typeHash) || !Array.isArray(b.blobs) || b.blobs.length > 8 || !b.blobs.every(validatePrivateBlob) || new Set(b.blobs.map(blob => blob.id)).size !== b.blobs.length || b.blobs.some(blob => blob.vault !== v.vault || blob.copy !== v.copy)) return false;
  if (type === 'private.version') return isId(b.predecessor);
  if (b.predecessor !== null) return false;
  if (type === 'private.create') return true;
  const o = b.origin, d = b.destination;
  return exact(o, ['journey', 'copy', 'artifact', 'version', 'recordHash']) && privateObject(o) && isId(o.journey) && validPrivateId(o.copy) && o.artifact === b.artifact && isId(o.version) && validDigest(o.recordHash) && exact(d, ['journey', 'copy']) && privateObject(d) && d.journey === v.authority.journey && d.copy === v.copy && validDigest(b.snapshotHash);
}
export function copyPrivateRecord(v: PrivateRecord): PrivateRecord {
  if (!validatePrivateRecord(v)) throw new Error('Invalid private record');
  const b = v.body;
  if (!validatePrivateIdentity(b.author)) throw new Error('Invalid private author');
  const body: JsonObject = { artifact: b.artifact, author: { kind: b.author.kind, signingKey: b.author.signingKey, recipient: b.author.recipient }, actor: { kind: v.actor.kind, signingKey: v.actor.signingKey, recipient: v.actor.recipient } };
  for (const key of ['version', 'typeHash', 'predecessor', 'comment', 'onVersion', 'project', 'snapshotHash']) if (Object.hasOwn(b, key)) body[key] = b[key];
  if (Array.isArray(b.blobs)) body.blobs = (b.blobs as PrivateBlob[]).map(copyPrivateBlob);
  if (v.type === 'private.copy') {
    // SAFETY: validatePrivateRecord checked the exact origin/destination fields above.
    const o = b.origin as unknown as PrivateOrigin, d = b.destination as JsonObject;
    body.origin = { journey: o.journey, copy: o.copy, artifact: o.artifact, version: o.version, recordHash: o.recordHash }; body.destination = { journey: d.journey, copy: d.copy };
  }
  return { format: PRIVATE_FORMAT, v: 1, id: v.id, vault: v.vault, copy: v.copy, seq: v.seq, prev: v.prev, at: v.at, actor: copyPrivateIdentity(v.actor), authority: copyAuthority(v.authority), type: v.type, body, payloadHash: v.payloadHash, sig: v.sig };
}
function unsignedRecord(v: PrivateRecord): Omit<PrivateRecord, 'sig'> { return { format: v.format, v: v.v, id: v.id, vault: v.vault, copy: v.copy, seq: v.seq, prev: v.prev, at: v.at, actor: v.actor, authority: v.authority, type: v.type, body: v.body, payloadHash: v.payloadHash }; }
export async function signPrivateRecord(v: Omit<PrivateRecord, 'sig'>, key: CryptoKey): Promise<PrivateRecord> {
  if (!exact(v, ['format', 'v', 'id', 'vault', 'copy', 'seq', 'prev', 'at', 'actor', 'authority', 'type', 'body', 'payloadHash'])) throw new Error('Invalid unsigned private record');
  const clean = copyPrivateRecord({ format: v.format, v: v.v, id: v.id, vault: v.vault, copy: v.copy, seq: v.seq, prev: v.prev, at: v.at, actor: v.actor, authority: v.authority, type: v.type, body: v.body, payloadHash: v.payloadHash, sig: encode(new Uint8Array(64)) });
  clean.sig = await signPrivateMessage(unsignedRecord(clean), key); return clean;
}
function copyPrivateContent(value: JsonObject): JsonObject {
  const fields = ['kind', 'skill', 'text', 'markdown', 'primary', 'format', 'url', 'summary', 'notes'];
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error('Invalid private content fields');
  const result: JsonObject = {};
  for (const key of fields) if (Object.hasOwn(value, key)) result[key] = value[key];
  return result;
}
/** Private attachment descriptors never enter journey storage. Only this validation
 * projection reuses Stage 1's content syntax; its fake IDs are not persisted. */
export async function validatePrivatePayload(record: PrivateRecord, payload: ProtocolRecord): Promise<ProtocolRecord> {
  if (!exact(payload, ['type', 'typeVersion', 'body']) || !privateObject(payload.body) || payload.typeVersion !== 1 || utf8(canonical(payload)).length > MAX_ARTIFACT_PAYLOAD_BYTES || await privateHash(payload) !== record.payloadHash) throw new Error('Invalid private payload hash or size');
  if (record.type === 'private.comment') {
    if (payload.type !== 'artifact.comment-content' || !exact(payload.body, ['text']) || typeof payload.body.text !== 'string') throw new Error('Invalid private comment');
    return { type: payload.type, typeVersion: 1, body: { text: payload.body.text } };
  }
  if (record.type === 'private.delete' || record.type === 'private.project') {
    if (payload.type !== 'artifact.tombstone' || !exact(payload.body, [])) throw new Error('Invalid private marker');
    return { type: payload.type, typeVersion: 1, body: {} };
  }
  const b = payload.body;
  if (payload.type !== 'artifact.content' || !exact(b, ['title', 'tags', 'content', 'attachments']) || !Array.isArray(b.attachments) || !privateObject(b.content)) throw new Error('Invalid private content');
  const attachments: JsonObject[] = [], blobs: PrivateBlob[] = [];
  for (const row of b.attachments) {
    if (!privateObject(row) || !privateShape(row, ['blob', 'name', 'mime', ...(Object.hasOwn(row, 'path') ? ['path'] : [])]) || !validatePrivateBlob(row.blob)) throw new Error('Invalid private attachment');
    blobs.push(copyPrivateBlob(row.blob));
    attachments.push({ blob: { v: 1, journey: '00000000000000000000000000', id: '0000000000000000000000000' + attachments.length, epoch: row.blob.generation, size: row.blob.size, ciphertextSize: row.blob.ciphertextSize, nonce: row.blob.nonce, digest: row.blob.digest }, name: row.name, mime: row.mime, ...(row.path === undefined ? {} : { path: row.path }) });
  }
  const content = copyPrivateContent(b.content);
  if (Object.hasOwn(content, 'primary')) {
    const index = blobs.findIndex(blob => blob.id === content.primary);
    if (index < 0) throw new Error('Private primary attachment missing');
    content.primary = (attachments[index]!.blob as JsonObject).id;
  }
  const checked = validateArtifactPayload({ title: b.title, tags: b.tags, content, attachments });
  if (!checked.ok || canonical(blobs) !== canonical(record.body.blobs) || await artifactTypeHash(b.content.kind as ArtifactPayload['content']['kind']) !== record.body.typeHash) throw new Error('Invalid private content projection');
  const copied = copyArtifactRecord({ type: 'artifact.content', typeVersion: 1, body: { title: b.title, tags: b.tags, content, attachments } });
  const result = copied.body as ArtifactPayload;
  if (Object.hasOwn(result.content, 'primary')) result.content.primary = b.content.primary;
  return { type: copied.type, typeVersion: copied.typeVersion, body: { title: result.title, tags: result.tags, content: result.content, attachments: result.attachments.map((a, i) => ({ blob: copyPrivateBlob(blobs[i]!), name: a.name, mime: a.mime, ...(a.path === undefined ? {} : { path: a.path }) })) } };
}

interface VerifiedCopies { vault: string; copies: Map<string, PrivateCopyState> }
export interface PrivateView { readonly vault: string }
const views = new WeakMap<PrivateView, VerifiedCopies>();
export function privateCopies(view: PrivateView): PrivateCopyState[] {
  const data = views.get(view); if (!data) throw new Error('Unverified private view'); return JSON.parse(canonical([...data.copies.values()])) as PrivateCopyState[];
}
const projectPhase = { 'getting-started': 'GettingStarted', active: 'Active', 'looking-for-others': 'LookingForOthers', archived: 'Archived' } as const;
function namespace(strings: string[]) { const ids = [...new Set(strings)]; return { id: (s: string | null | undefined): bigint => s == null ? 0n : BigInt(ids.indexOf(s) + 2), ids }; }
function ruleCopyStrings(value: PrivateCopyState): string[] {
  return [value.copy, value.artifact, canonical(value.author), value.journey, value.head, value.typeHash, value.project ?? '', value.placement ?? '', ...value.records.flatMap(r => [r.sig, canonical(r.actor), ...[r.body.version, r.body.comment].filter((v): v is string => typeof v === 'string'), ...((r.body.blobs as PrivateBlob[] | undefined) ?? []).map(b => b.id)])];
}
function ruleCopy(value: PrivateCopyState, id: (s: string | null | undefined) => bigint): RuleCopy {
  const versions = value.records.filter(r => ['private.create', 'private.copy', 'private.version'].includes(r.type));
  return { $: 'PrivateCopy', id: id(value.copy), artifact: id(value.artifact), author: id(canonical(value.author)), journey: id(value.journey), head: id(value.head), record: id(value.records.at(-1)!.sig), seq: BigInt(value.records.at(-1)!.seq), deleted: value.deleted, versions: ruleList(versions.map(r => ({ $: 'ArtifactVersion', id: id(r.body.version as string), writer: id(canonical(r.actor)), blobs: ruleList((r.body.blobs as PrivateBlob[]).map(b => id(b.id))) }))), used: ruleList(value.records.flatMap(r => [r.body.version, r.body.comment].filter((v): v is string => typeof v === 'string')).map(id)), project: id(value.project), placement: id(value.placement), typeHash: id(value.typeHash) };
}
/** All-or-nothing, signed per-copy replay. Supporting authority is independently
 * verified; caller indexes, payload actions and claimed credential classes are ignored. */
export async function verifyPrivateRecords(records: readonly PrivateRecord[], payloads: readonly PrivatePayload[], authorities: readonly PrivateContext[], trust: { vault: string; author: PrivateIdentity }, options: { sessions?: readonly PrivateSession[]; source?: PrivateView; historical?: boolean } = {}): Promise<PrivateView> {
  if (!validPrivateId(trust.vault) || !validatePrivateIdentity(trust.author)) throw new Error('Invalid private trust');
  const copies = new Map<string, PrivateCopyState>(), operations = new Map<string, string>();
  const historicalSources = new Map<string, Map<string, PrivateCopyState>>();
  const payloadMap = new Map<string, ProtocolRecord>();
  for (const row of payloads) {
    if (!exact(row, ['record', 'payload']) || !isId(row.record) || payloadMap.has(row.record)) throw new Error('Duplicate private payload'); payloadMap.set(row.record, row.payload);
  }
  const knownTypes = await Promise.all(ARTIFACT_TYPES.map(artifactTypeHash));
  const sourceCopies = options.source ? views.get(options.source)?.copies : undefined;
  if (options.source && !sourceCopies) throw new Error('Unverified private source');
  for (const input of records) {
    const r = copyPrivateRecord(input), hash = await privateHash(r);
    if (r.vault !== trust.vault || !validatePrivateIdentity(r.body.author) || !sameIdentity(r.body.author, trust.author)) throw new Error('Private author/vault mismatch');
    const priorOperation = operations.get(r.id);
    if (priorOperation) { if (priorOperation !== hash) throw new Error('Private operation conflict'); continue; }
    operations.set(r.id, hash);
    const authorityIds = namespace([r.authority.journey, r.authority.head, ...authorities.flatMap(c => [c.journey, c.head])]);
    const context = authorities.find(c => rules.private_authority_snapshot(authorityIds.id(c.journey), authorityIds.id(c.head), authorityIds.id(r.authority.journey), authorityIds.id(r.authority.head)));
    if (!context) throw new Error('Missing private authority snapshot');
    const data = contextData(context), binding = privateBinding(context, r.actor);
    if (canonical(binding) !== canonical({ journey: r.authority.journey, principal: r.authority.principal, admissionHash: r.authority.admissionHash }) || r.authority.epoch !== data.state.currentEpoch) throw new Error('Private admission/epoch mismatch');
    privateBinding(context, trust.author);
    await verifySignature(r.actor, unsignedRecord(r), r.sig);
    const payload = payloadMap.get(r.id); if (!payload) throw new Error('Missing private payload');
    const cleanPayload = await validatePrivatePayload(r, payload);
    const old = copies.get(r.copy);
    if (old && old.journey !== r.authority.journey) throw new Error('Private copy changed journey');
    const actorSession = options.sessions?.find(s => sessions.get(s)?.context === context && sameIdentity(s.identity, r.actor));
    // Historical cryptographic replay checks entry-time authority. It never issues
    // a session or authorizes a new mutation/key handoff.
    const model = normalizedMembers(data.state, [], options.historical ? Date.parse(r.at) : data.now);
    const historicalCredential: PrivateCredential = { $: r.actor.kind === 'person' ? 'PrivatePersonCredential' : 'PrivateAuthenticatedAgent' };
    const allowed = options.historical ? rules.private_write(model.members, model.id(privateBinding(context, trust.author).principal), model.id(binding.principal), historicalCredential, ruleVersion(data.state.minClientVersion), data.state.pendingRotation === true, true)
      : !!actorSession && privateAccess(context, trust.author, actorSession, true);
    const strings = [r.copy, r.body.artifact as string, canonical(trust.author), canonical(r.actor), r.authority.journey, r.sig, r.prev ?? '', ...Object.keys(data.state.projects?.items ?? {})];
    for (const c of [...copies.values(), ...(sourceCopies?.values() ?? [])]) strings.push(...ruleCopyStrings(c));
    for (const key of ['version', 'typeHash', 'predecessor', 'comment', 'onVersion', 'project']) if (typeof r.body[key] === 'string') strings.push(r.body[key]);
    if (r.type === 'private.copy') {
      // SAFETY: validatePrivateRecord above checks the exact origin fields.
      const origin = r.body.origin as unknown as PrivateOrigin;
      strings.push(origin.version);
      const historicalSource = options.historical ? historicalSources.get(origin.copy)?.get(origin.version) : undefined;
      if (historicalSource) strings.push(...ruleCopyStrings(historicalSource));
    }
    for (const b of (r.body.blobs as PrivateBlob[] | undefined) ?? []) strings.push(b.id);
    const { id } = namespace(strings);
    const previous = old ? old.records.at(-1)! : undefined;
    // Hash comparison is cryptographic validation, not host lifecycle policy.
    if (r.prev !== (previous ? await privateHash(previous) : null)) throw new Error('Private predecessor hash mismatch');
    const current = old ? ruleCopy(old, id) : undefined;
    const projects = ruleList<ProjectInfo>(Object.values(data.state.projects?.items ?? {}).map(p => ({ $: 'ProjectInfo', id: id(p.id), revision: BigInt(p.revision + 1), phase: { $: projectPhase[p.state] } })));
    const common = { artifact: id(r.body.artifact as string), author: id(canonical(trust.author)), writer: id(canonical(r.actor)) };
    let transition: ReturnType<typeof rules.private_apply>;
    if (r.type === 'private.copy') {
      // SAFETY: copyPrivateRecord validated the exact private.copy origin fields.
      const o = r.body.origin as unknown as PrivateOrigin;
      let source = sourceCopies?.get(o.copy);
      // A complete author backup carries the independently signed source history.
      // Replay only its origin prefix: later edits/deletion cannot invalidate a
      // snapshot already copied into another journey. Live proposals still need
      // the explicitly supplied current source and current write sessions.
      if (options.historical && !source) source = historicalSources.get(o.copy)?.get(o.version);
      if (!source || source.journey !== o.journey || source.artifact !== o.artifact || !rules.private_origin_version(id(source.head), id(o.version)) || !sameIdentity(source.author, trust.author)) throw new Error('Private copy origin mismatch');
      const versionRecord = source.records.find(v => v.body.version === o.version)!;
      const sourcePayload = source.payloads.find(v => v.record === versionRecord.id)!.payload;
      if (await privateHash(versionRecord) !== o.recordHash || await privateSnapshotHash(sourcePayload) !== r.body.snapshotHash || await privateSnapshotHash(cleanPayload) !== r.body.snapshotHash) throw new Error('Private copy snapshot mismatch');
      const srcContext = authorities.find(c => c.journey === source.journey && contextData(c).current);
      const srcSession = options.sessions?.find(s => sessions.get(s)?.context === srcContext && sameIdentity(s.identity, r.actor));
      const copyAllowed = options.historical ? allowed : rules.private_copy_access(!!srcContext && !!srcSession && privateAccess(srcContext, trust.author, srcSession, true), allowed, o.journey !== context.journey, { $: context.visibility === 'public' ? 'Public' : 'Private' });
      if ((r.body.blobs as PrivateBlob[]).some(b => source.records.some(v => ((v.body.blobs as PrivateBlob[] | undefined) ?? []).some(oldBlob => oldBlob.id === b.id || oldBlob.nonce === b.nonce || oldBlob.digest === b.digest)))) throw new Error('Private copy reused source ciphertext');
      transition = rules.private_copied(ruleCopy(source, id), id(r.copy), id(canonical(r.actor)), id(r.sig), id(context.journey), id(r.body.version as string), ruleList((r.body.blobs as PrivateBlob[]).map(b => id(b.id))), id(source.records.at(-1)!.sig), !old && r.seq === 0 && r.prev === null, copyAllowed);
    } else {
      let action: PrivateAction;
      switch (r.type) {
        case 'private.create': case 'private.version': action = r.type === 'private.create' ? { $: 'PrivateCreate', ...common, journey: id(context.journey), version: id(r.body.version as string), typeHash: id(r.body.typeHash as string), blobs: ruleList((r.body.blobs as PrivateBlob[]).map(b => id(b.id))) } : { $: 'PrivateEdit', ...common, version: id(r.body.version as string), typeHash: id(r.body.typeHash as string), predecessor: id(r.body.predecessor as string), blobs: ruleList((r.body.blobs as PrivateBlob[]).map(b => id(b.id))) }; break;
        case 'private.comment': action = { $: 'PrivateComment', ...common, comment: id(r.body.comment as string), context: id(r.body.onVersion as string | undefined) }; break;
        case 'private.delete': action = { $: 'PrivateDelete', ...common, predecessor: id(r.body.predecessor as string) }; break;
        case 'private.project': action = { $: 'PrivateProject', ...common, project: id(r.body.project as string | null), predecessor: id(r.body.predecessor as string | null) }; break;
      }
      transition = rules.private_apply(allowed, current ? { $: 'Some', value: current } : { $: 'None' }, id(r.copy), id(canonical(r.actor)), id(r.sig), BigInt(r.seq), old ? id(old.records.at(-1)!.sig) : 0n, action, projects);
    }
    if (transition.$ !== 'PrivateAccepted') throw new Error(transition.$ === 'PrivateDenied' ? 'Private authority denied' : 'Private lifecycle conflict');
    if (r.body.typeHash !== undefined && !knownTypes.includes(r.body.typeHash as string)) throw new Error('Unsupported private type');
    const next = transition.value;
    const names = (n: bigint) => namespace(strings).ids[Number(n) - 2]!;
    const value: PrivateCopyState = { copy: r.copy, artifact: r.body.artifact as string, author: copyPrivateIdentity(trust.author), journey: context.journey, typeHash: names(next.typeHash), head: names(next.head), deleted: next.deleted, project: names(next.project) ?? null, placement: names(next.placement) ?? null, records: [...(old?.records ?? []), r], payloads: [...(old?.payloads ?? []), { record: r.id, payload: cleanPayload }] };
    copies.set(r.copy, value);
    if (options.historical && typeof r.body.version === 'string') {
      const versions = historicalSources.get(r.copy) ?? new Map<string, PrivateCopyState>();
      versions.set(r.body.version, value); historicalSources.set(r.copy, versions);
    }
  }
  if (payloadMap.size !== operations.size) throw new Error('Unreferenced private payload');
  const view = Object.freeze({ vault: trust.vault }); views.set(view, { vault: trust.vault, copies }); return view;
}
/** Snapshot hashes bind logical content/attachment bytes, not destination handles. */
export async function privateSnapshotHash(payload: ProtocolRecord): Promise<string> {
  const p = payload.body;
  const content = privateObject(p.content) ? copyPrivateContent(p.content as JsonObject) : {};
  if (!Array.isArray(p.attachments)) throw new Error('Invalid private snapshot attachments');
  const rows = p.attachments.map(a => {
    if (!privateObject(a) || !validatePrivateBlob(a.blob)) throw new Error('Invalid private snapshot blob');
    return { blob: a.blob, name: a.name, mime: a.mime, path: a.path };
  });
  const attachments = rows.map(a => ({ name: a.name, mime: a.mime, ...(a.path === undefined ? {} : { path: a.path }), size: a.blob.size, contentHash: a.blob.contentHash }));
  if (Object.hasOwn(content, 'primary')) content.primary = rows.findIndex(a => a.blob.id === content.primary);
  return privateHash({ title: p.title, tags: p.tags, content, attachments });
}
export function selectPrivateCopies(view: PrivateView, context: PrivateContext, actor: PrivateSession, selector: 'main' | 'all' | string = 'main'): PrivateCopyState[] {
  const data = contextData(context), values = privateCopies(view), { id } = namespace([selector, ...Object.keys(data.state.projects?.items ?? {}), ...values.flatMap(ruleCopyStrings)]);
  if (!(selector === 'main' || selector === 'all' || isId(selector))) throw new Error('Invalid private selector');
  const projects = ruleList<ProjectInfo>(Object.values(data.state.projects?.items ?? {}).map(p => ({ $: 'ProjectInfo', id: id(p.id), revision: BigInt(p.revision + 1), phase: { $: projectPhase[p.state] } })));
  const chosen = selector === 'main' ? 0n : selector === 'all' ? 1n : id(selector);
  if (!rules.project_selector(projects, chosen)) throw new Error('Unknown private project');
  return values.filter(v => v.journey === context.journey && rules.private_selected(ruleCopy(v, id), chosen, privateAccess(context, v.author, actor)));
}

export interface PrivateHeader { format: 'private-v1'; v: 1; vault: string; author: PrivateIdentity; version: number; prev: string | null; contentsHash: string; slots: string[]; sig: string }
export interface PrivateCheckpoint { vault: string; author: PrivateIdentity; version: number; head: string; prev: string | null; freshness: 'paired' | 'unverified' }
export interface PrivatePatch { format: 'private-v1'; v: 1; vault: string; token: string; header: PrivateHeader; slots: { index: number; ciphertext: string }[] }
export function copyPrivateHeader(h: PrivateHeader): PrivateHeader {
  if (!exact(h, ['format', 'v', 'vault', 'author', 'version', 'prev', 'contentsHash', 'slots', 'sig']) || h.format !== PRIVATE_FORMAT || h.v !== 1 || !validPrivateId(h.vault) || !validatePrivateIdentity(h.author) || !positive(h.version) || !(h.prev === null || validDigest(h.prev)) || !validDigest(h.contentsHash) || !Array.isArray(h.slots) || h.slots.length !== PRIVATE_SLOT_COUNT || !h.slots.every(validDigest) || !base64(h.sig, 64)) throw new Error('Invalid private signed header');
  return { format: PRIVATE_FORMAT, v: 1, vault: h.vault, author: copyPrivateIdentity(h.author), version: h.version, prev: h.prev, contentsHash: h.contentsHash, slots: h.slots.slice(), sig: h.sig };
}
function unsignedHeader(h: PrivateHeader): Omit<PrivateHeader, 'sig'> { return { format: h.format, v: h.v, vault: h.vault, author: h.author, version: h.version, prev: h.prev, contentsHash: h.contentsHash, slots: h.slots }; }
export async function signPrivateHeader(h: Omit<PrivateHeader, 'sig'>, key: CryptoKey): Promise<PrivateHeader> {
  if (!exact(h, ['format', 'v', 'vault', 'author', 'version', 'prev', 'contentsHash', 'slots'])) throw new Error('Invalid unsigned private header');
  const clean = copyPrivateHeader({ format: h.format, v: h.v, vault: h.vault, author: h.author, version: h.version, prev: h.prev, contentsHash: h.contentsHash, slots: h.slots, sig: encode(new Uint8Array(64)) });
  clean.sig = await signPrivateMessage(unsignedHeader(clean), key); return clean;
}
export async function verifyPrivateHeader(value: PrivateHeader, trust: { vault: string; author: PrivateIdentity }, options: { checkpoint?: PrivateCheckpoint; paired?: PrivateCheckpoint; contentsHash: string }): Promise<{ header: PrivateHeader; checkpoint: PrivateCheckpoint; decision: 'verified' | 'unverified' | 'merge' }> {
  const h = copyPrivateHeader(value);
  if (h.vault !== trust.vault || !sameIdentity(h.author, trust.author) || h.contentsHash !== options.contentsHash) throw new Error('Private header binding/digest mismatch');
  await verifySignature(h.author, unsignedHeader(h), h.sig);
  // The trusted input comes from a paired device, not the journey server. A
  // signature authorizes skipped versions; no unbounded ancestry is transported.
  for (const retained of [options.checkpoint, options.paired]) if (retained && (!exact(retained, ['vault', 'author', 'version', 'head', 'prev', 'freshness']) || retained.vault !== h.vault || !sameIdentity(retained.author, h.author) || !positive(retained.version) || !validDigest(retained.head) || !(retained.prev === null || validDigest(retained.prev)) || !['paired', 'unverified'].includes(retained.freshness))) throw new Error('Invalid retained private checkpoint');
  if (options.paired && options.paired.freshness !== 'paired') throw new Error('Unverified pairing checkpoint');
  if (options.checkpoint && options.paired && options.checkpoint.version === options.paired.version && canonical(options.checkpoint.head) !== canonical(options.paired.head)) throw new Error('Private pairing checkpoint conflict');
  const retained = options.paired && (!options.checkpoint || options.paired.version > options.checkpoint.version) ? options.paired : options.checkpoint ?? options.paired;
  const head = await privateHash(h);
  const predecessor = h.version === 1 ? h.prev === null : h.prev !== null;
  const result = rules.private_header(BigInt(retained?.version ?? 0), BigInt(h.version), canonical(retained?.head ?? null) === canonical(head), predecessor, !!options.paired || retained?.freshness === 'paired');
  if (result.$ === 'PrivateRollback' || result.$ === 'PrivateHeaderConflict') throw new Error(result.$ === 'PrivateRollback' ? 'Private vault rollback' : 'Private header predecessor conflict');
  return { header: h, checkpoint: { vault: h.vault, author: copyPrivateIdentity(h.author), version: h.version, head, prev: h.prev, freshness: options.paired || retained?.freshness === 'paired' ? 'paired' : 'unverified' }, decision: result.$ === 'PrivateMergeRequired' ? 'merge' : result.$ === 'PrivateUnverifiedFreshness' ? 'unverified' : 'verified' };
}
export async function copyPrivatePatch(value: PrivatePatch): Promise<PrivatePatch> {
  if (!exact(value, ['format', 'v', 'vault', 'token', 'header', 'slots']) || value.format !== PRIVATE_FORMAT || value.v !== 1 || !validPrivateId(value.vault) || !validPrivateId(value.token) || !Array.isArray(value.slots) || value.slots.length !== PRIVATE_PATCH_SLOTS) throw new Error('Invalid private atomic patch');
  const header = copyPrivateHeader(value.header);
  if (header.vault !== value.vault) throw new Error('Private patch vault mismatch');
  const slots: PrivatePatch['slots'] = [];
  for (const row of value.slots) {
    if (!exact(row, ['index', 'ciphertext']) || !nonnegative(row.index) || row.index >= PRIVATE_SLOT_COUNT || slots.some(s => s.index === row.index) || !base64(row.ciphertext, PRIVATE_SLOT_BYTES) || await privateBytesHash(decode(row.ciphertext)) !== header.slots[row.index]) throw new Error('Invalid private patch slot');
    slots.push({ index: row.index, ciphertext: row.ciphertext });
  }
  return { format: PRIVATE_FORMAT, v: 1, vault: value.vault, token: value.token, header, slots };
}
export async function privateBytesHash(bytes: Uint8Array): Promise<string> { return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(bytes)))); }
export function privateCapacity(bytes: number): boolean { return nonnegative(bytes) && bytes <= 0xffff_ffff && rules.private_capacity(bytes); }
export function privateSyncDue(open: boolean, elapsed: number): boolean { return nonnegative(elapsed) && rules.private_sync_due(open, BigInt(elapsed)); }
/** Both inputs must already have verified complete histories. Ties retain both,
 * and any verified tombstone wins over a longer live branch. No indexes merge. */
export function mergePrivateViews(left: PrivateView, right: PrivateView): { copy: string; branches: PrivateCopyState[] }[] {
  if (!views.has(left) || !views.has(right) || left.vault !== right.vault) throw new Error('Unverified private fork');
  const a = new Map(privateCopies(left).map(v => [v.copy, v])), b = new Map(privateCopies(right).map(v => [v.copy, v]));
  return [...new Set([...a.keys(), ...b.keys()])].map(copy => {
    const x = a.get(copy), y = b.get(copy);
    if (!x || !y) return { copy, branches: [x ?? y!] };
    if (!sameIdentity(x.author, y.author) || x.artifact !== y.artifact || x.journey !== y.journey) throw new Error('Private fork identity conflict');
    const version = (v: PrivateCopyState) => BigInt(v.records.filter(r => ['private.create', 'private.copy', 'private.version'].includes(r.type)).length);
    const decision = rules.private_merge(version(x), version(y), x.deleted, y.deleted, canonical(x.records) === canonical(y.records));
    return { copy, branches: decision.$ === 'PrivateTombstone' ? [x.deleted ? x : y] : decision.$ === 'PrivateLeft' ? [x] : decision.$ === 'PrivateRight' ? [y] : [x, y] };
  });
}
