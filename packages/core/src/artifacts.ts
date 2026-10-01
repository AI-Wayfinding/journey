import { isId } from './ids.js';
import { asBuffer, decode, encode, utf8 } from './codec.js';
import { canonical } from './log.js';
import type { JsonObject, ProtocolRecord, Validation } from './types.js';
import { seal, open } from './envelope.js';
import type { Envelope, OuterMeta } from './envelope.js';
import type { JourneyKey } from './teamKey.js';
import type { ControlProof } from './controlProof.js';

export const ARTIFACT_FORMAT = 'artifact-v1' as const;
export const MAX_BLOB_BYTES = 25_000_000;
export const MAX_ARTIFACT_PAYLOAD_BYTES = 1_048_576;
export const MAX_ARTIFACT_ATTACHMENTS = 8;
export const ARTIFACT_TYPES = ['skill', 'prompt', 'document', 'image', 'file', 'data', 'link'] as const;
export type ArtifactType = typeof ARTIFACT_TYPES[number];
export type ArtifactActionType = 'artifact.create' | 'artifact.version' | 'artifact.comment' | 'artifact.delete';
/** Binary AES-GCM descriptor. size is raw bytes; digest is base64 SHA-256 of ciphertext. */
export interface BlobDescriptor extends JsonObject { v: 1; journey: string; id: string; epoch: number; size: number; ciphertextSize: number; nonce: string; digest: string }
export interface ArtifactAttachment extends JsonObject { blob: BlobDescriptor; name: string; mime: string; path?: string }
export type ArtifactContent =
  | ({ kind: 'skill'; skill: string } & JsonObject)
  | ({ kind: 'prompt'; text: string } & JsonObject)
  | ({ kind: 'document'; markdown: string } & JsonObject)
  | ({ kind: 'image' | 'file'; primary: string } & JsonObject)
  | ({ kind: 'data'; format: 'json' | 'csv' | 'toml' | 'yaml' | 'sqlite'; text?: string; primary?: string } & JsonObject)
  | ({ kind: 'link'; url: string; summary: string; notes: string } & JsonObject);
export interface ArtifactPayload extends JsonObject { title: string; tags: string[]; content: ArtifactContent; attachments: ArtifactAttachment[] }
export interface ArtifactCommentPayload extends JsonObject { text: string }
export interface ArtifactVersionState { id: string; actor: string; blobs: BlobDescriptor[]; seq: number }
export interface ArtifactCommentState { id: string; actor: string; onVersion?: string; seq: number }
export interface ArtifactState { id: string; author: string; typeHash: string; head: string; deleted: boolean; versions: ArtifactVersionState[]; comments: ArtifactCommentState[] }
export interface ArtifactHistory { items: Record<string, ArtifactState>; used: string[] }
export const emptyArtifactHistory = (): ArtifactHistory => ({ items: {}, used: [] });
export const isArtifactAction = (type: string): type is ArtifactActionType => ['artifact.create', 'artifact.version', 'artifact.comment', 'artifact.delete'].includes(type);
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const shape = (v: JsonObject, required: readonly string[], allowed = required): boolean => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown): v is string => typeof v === 'string';
export const validDigest = (v: unknown): v is string => text(v) && /^[A-Za-z0-9+/]{43}=$/.test(v) && encode(decode(v)) === v;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const good: Validation = { ok: true };
const bad = (reason: string): Validation => ({ ok: false, reason });
export function validateBlobDescriptor(value: unknown): value is BlobDescriptor {
  if (!object(value) || !shape(value, ['v', 'journey', 'id', 'epoch', 'size', 'ciphertextSize', 'nonce', 'digest'])) return false;
  return value.v === 1 && isId(value.journey) && isId(value.id) && positive(value.epoch) && Number.isSafeInteger(value.size) && (value.size as number) >= 0 && (value.size as number) <= MAX_BLOB_BYTES && value.ciphertextSize === (value.size as number) + 16 && text(value.nonce) && /^[A-Za-z0-9+/]{16}$/.test(value.nonce) && decode(value.nonce).length === 12 && validDigest(value.digest);
}
export function copyBlobDescriptor(value: BlobDescriptor): BlobDescriptor {
  return { v: 1, journey: value.journey, id: value.id, epoch: value.epoch, size: value.size, ciphertextSize: value.ciphertextSize, nonce: value.nonce, digest: value.digest };
}
/** Package paths are relative display names, not host paths. */
export function validPackagePath(value: unknown): value is string {
  return text(value) && value.length > 0 && value.length <= 255 && !/[\\\x00-\x1f\x7f:]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
export function validArtifactUrl(value: unknown): value is string {
  if (!text(value) || /[\x00-\x20\x7f-\x9f]/.test(value)) return false;
  try { const u = new URL(value); return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && !u.username && !u.password; } catch { return false; }
}
export function suggestedArtifact(category: string, tags: readonly string[] = []): { type: 'document'; tags: string[] } | null {
  if (category === 'recovery') return null;
  return { type: 'document', tags: [...new Set([...tags, category])] };
}
export async function artifactTypeHash(type: ArtifactType): Promise<string> {
  if (!(ARTIFACT_TYPES as readonly string[]).includes(type)) throw new Error('Unsupported artifact type');
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(utf8(canonical(type))))));
}
export function validateArtifactPayload(value: unknown): Validation {
  if (!object(value) || !shape(value, ['title', 'tags', 'content', 'attachments']) || !text(value.title) || !Array.isArray(value.tags) || !value.tags.every(text) || new Set(value.tags).size !== value.tags.length || !object(value.content) || !Array.isArray(value.attachments) || value.attachments.length > MAX_ARTIFACT_ATTACHMENTS) return bad('Invalid artifact payload');
  const attachments = value.attachments;
  if (!attachments.every(a => object(a) && shape(a, ['blob', 'name', 'mime'], ['blob', 'name', 'mime', 'path']) && validateBlobDescriptor(a.blob) && text(a.name) && a.name.length > 0 && !/[\x00-\x1f\x7f]/.test(a.name) && text(a.mime) && (a.path === undefined || validPackagePath(a.path)))) return bad('Invalid artifact attachment');
  const ids = attachments.map(a => (a as ArtifactAttachment).blob.id);
  const paths = attachments.filter(a => (a as ArtifactAttachment).path !== undefined).map(a => (a as ArtifactAttachment).path);
  if (new Set(ids).size !== ids.length || new Set(paths).size !== paths.length) return bad('Duplicate attachment');
  const c = value.content;
  let valid = false;
  switch (c.kind) {
    case 'skill': valid = shape(c, ['kind', 'skill']) && text(c.skill) && c.skill.length > 0 && attachments.every(a => (a as ArtifactAttachment).path !== undefined && (a as ArtifactAttachment).path !== 'SKILL.md'); break;
    case 'prompt': valid = shape(c, ['kind', 'text']) && text(c.text) && c.text.length > 0; break;
    case 'document': valid = shape(c, ['kind', 'markdown']) && text(c.markdown); break;
    case 'file': case 'image': valid = shape(c, ['kind', 'primary']) && isId(c.primary) && ids.includes(c.primary); break;
    case 'data': valid = shape(c, ['kind', 'format'], ['kind', 'format', 'text', 'primary']) && ['json', 'csv', 'toml', 'yaml', 'sqlite'].includes(c.format as string) && (Object.hasOwn(c, 'text') !== Object.hasOwn(c, 'primary')) && (c.text === undefined || text(c.text) && c.format !== 'sqlite') && (c.primary === undefined || isId(c.primary) && ids.includes(c.primary)); break;
    case 'link': valid = shape(c, ['kind', 'url', 'summary', 'notes']) && validArtifactUrl(c.url) && text(c.summary) && text(c.notes); break;
  }
  return valid && utf8(JSON.stringify(value)).length <= MAX_ARTIFACT_PAYLOAD_BYTES ? good : bad('Unsupported artifact content or payload size');
}
export function validateArtifactPublic(type: string, body: JsonObject): Validation {
  const required = ['format', 'artifact', 'author', 'actor'];
  if (type === 'artifact.create' || type === 'artifact.version') required.push('version', 'typeHash', 'blobs');
  if (type === 'artifact.version') required.push('predecessor');
  if (type === 'artifact.comment') required.push('comment');
  if (!isArtifactAction(type) || !shape(body, required, type === 'artifact.comment' ? [...required, 'onVersion'] : required) || body.format !== ARTIFACT_FORMAT || !isId(body.artifact) || !isId(body.author) || !isId(body.actor)) return bad('Invalid public artifact action');
  for (const field of ['version', 'predecessor', 'comment', 'onVersion']) if (Object.hasOwn(body, field) && !isId(body[field])) return bad('Invalid artifact identity');
  if (type === 'artifact.create' || type === 'artifact.version') {
    if (!validDigest(body.typeHash) || !Array.isArray(body.blobs) || body.blobs.length > MAX_ARTIFACT_ATTACHMENTS || !body.blobs.every(validateBlobDescriptor) || new Set(body.blobs.map(b => (b as BlobDescriptor).id)).size !== body.blobs.length) return bad('Invalid artifact blob references');
  }
  return good;
}
export function copyArtifactPublic(type: string, body: JsonObject): JsonObject {
  const checked = validateArtifactPublic(type, body); if (!checked.ok) throw new Error(checked.reason);
  const copy: JsonObject = { format: ARTIFACT_FORMAT, artifact: body.artifact, author: body.author, actor: body.actor };
  for (const field of ['version', 'predecessor', 'typeHash', 'comment', 'onVersion']) if (Object.hasOwn(body, field)) copy[field] = body[field];
  if (Array.isArray(body.blobs)) copy.blobs = (body.blobs as BlobDescriptor[]).map(copyBlobDescriptor);
  return copy;
}
export async function validateArtifactRecord(type: ArtifactActionType, body: JsonObject, record: ProtocolRecord, journey: string): Promise<void> {
  if (!shape(record, ['type', 'typeVersion', 'body']) || record.typeVersion !== 1) throw new Error('Invalid artifact encrypted record');
  if (type === 'artifact.comment') {
    if (record.type !== 'artifact.comment-content' || !shape(record.body, ['text']) || !text(record.body.text) || utf8(JSON.stringify(record)).length > MAX_ARTIFACT_PAYLOAD_BYTES) throw new Error('Invalid artifact comment payload');
  } else if (type === 'artifact.delete') {
    if (record.type !== 'artifact.tombstone' || !shape(record.body, [])) throw new Error('Invalid artifact deletion payload');
  } else {
    const checked = validateArtifactPayload(record.body);
    if (record.type !== 'artifact.content' || !checked.ok || utf8(JSON.stringify(record)).length > MAX_ARTIFACT_PAYLOAD_BYTES) throw new Error('Invalid artifact content payload');
    const payload = record.body as ArtifactPayload;
    if (await artifactTypeHash(payload.content.kind) !== body.typeHash || payload.attachments.some(a => a.blob.journey !== journey) || canonical(payload.attachments.map(a => a.blob)) !== canonical(body.blobs)) throw new Error('Artifact content projection mismatch');
  }
}
export async function sealArtifactPayload(type: ArtifactActionType, body: JsonObject, payload: JsonObject, outside: Omit<OuterMeta, 'v' | 'size'>, key: JourneyKey): Promise<Envelope> {
  const checked = validateArtifactPublic(type, body); if (!checked.ok) throw new Error(checked.reason);
  const record: ProtocolRecord = { type: type === 'artifact.comment' ? 'artifact.comment-content' : type === 'artifact.delete' ? 'artifact.tombstone' : 'artifact.content', typeVersion: 1, body: payload };
  await validateArtifactRecord(type, body, record, outside.journey);
  return seal(copyArtifactRecord(record), outside, key);
}
/** Copy validated private content using only its defined fields. */
export function copyArtifactRecord(record: ProtocolRecord): ProtocolRecord {
  let body: JsonObject;
  if (record.type === 'artifact.comment-content') body = { text: record.body.text };
  else if (record.type === 'artifact.tombstone') body = {};
  else {
    const payload = record.body as ArtifactPayload, c = payload.content;
    const content: JsonObject = { kind: c.kind };
    for (const field of ['skill', 'text', 'markdown', 'primary', 'format', 'url', 'summary', 'notes']) if (Object.hasOwn(c, field)) content[field] = c[field];
    body = { title: payload.title, tags: payload.tags.slice(), content, attachments: payload.attachments.map(a => ({ blob: copyBlobDescriptor(a.blob), name: a.name, mime: a.mime, ...(a.path === undefined ? {} : { path: a.path }) })) };
  }
  return { type: record.type, typeVersion: 1, body };
}
/** Call only after verifying the signed proof chain. Content never grants authority. */
export async function readArtifactPayload(proof: ControlProof, envelope: Envelope, key: JourneyKey): Promise<ProtocolRecord> {
  if (!isArtifactAction(proof.type)) throw new Error('Not an artifact action');
  const hash = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(utf8(canonical(envelope))))));
  if (proof.envelopeHash !== hash || proof.journey !== envelope.outside.journey || proof.seq !== envelope.outside.seq) throw new Error('Artifact ciphertext mismatch');
  const record = await open(envelope, key);
  await validateArtifactRecord(proof.type, proof.body, record, proof.journey);
  return record;
}

/** Named-field projection of an accepted Bend transition. No host authorization. */
export function projectArtifact(history: ArtifactHistory, type: ArtifactActionType, body: JsonObject, actor: string, seq: number): void {
  const id = body.artifact as string;
  if (type === 'artifact.create') {
    history.items[id] = { id, author: actor, typeHash: body.typeHash as string, head: body.version as string, deleted: false, versions: [], comments: [] };
    history.used.push(id);
  }
  const item = history.items[id]!;
  if (type === 'artifact.create' || type === 'artifact.version') {
    const version = body.version as string;
    item.versions.push({ id: version, actor, blobs: (body.blobs as BlobDescriptor[]).map(copyBlobDescriptor), seq });
    item.head = version; history.used.push(version);
  } else if (type === 'artifact.comment') {
    const comment = body.comment as string;
    item.comments.push({ id: comment, actor, ...(body.onVersion === undefined ? {} : { onVersion: body.onVersion as string }), seq });
    history.used.push(comment);
  } else item.deleted = true;
}
