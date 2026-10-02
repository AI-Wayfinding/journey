import { isId } from './ids.js';
import { asBuffer, encode, utf8 } from './codec.js';
import { canonical } from './log.js';
import { validDigest, MAX_ARTIFACT_PAYLOAD_BYTES } from './artifacts.js';
import { open, seal } from './envelope.js';
import type { Envelope, OuterMeta } from './envelope.js';
import type { JourneyKey } from './teamKey.js';
import type { ControlProof } from './controlProof.js';
import type { JsonObject, ProtocolRecord, Validation } from './types.js';

export const PROJECT_FORMAT = 'project-v1' as const;
export const PROJECT_STATES = ['getting-started', 'active', 'looking-for-others', 'archived'] as const;
export type ProjectState = typeof PROJECT_STATES[number];
export type ProjectActionType = 'project.create' | 'project.purpose' | 'project.state' | 'project.join' | 'project.leave' | 'artifact.project';
/** A hoisted factory lets log definitions initialize even when adapters load first. */
export function projectActions(): readonly ProjectActionType[] {
  return ['project.create', 'project.purpose', 'project.state', 'project.join', 'project.leave', 'artifact.project'];
}
export const PROJECT_ACTIONS = projectActions();
export interface ProjectChange { seq: number; actor: string; at: string; type: ProjectActionType; from?: ProjectState; to?: ProjectState }
export interface Project { id: string; purpose: string; purposeHash: string; state: ProjectState; revision: number; creator: string; at: string; history: ProjectChange[] }
export interface ProjectParticipation { project: string; member: string; revision: number; active: boolean }
export interface PlacementChange { seq: number; actor: string; at: string; from: string | null; to: string | null }
export interface ArtifactPlacement { artifact: string; project: string | null; revision: number; history: PlacementChange[] }
export interface ProjectHistory { items: Record<string, Project>; participation: ProjectParticipation[]; placements: Record<string, ArtifactPlacement> }
export const emptyProjectHistory = (): ProjectHistory => ({ items: {}, participation: [], placements: {} });
export const isProjectAction = (type: string): type is ProjectActionType => (PROJECT_ACTIONS as readonly string[]).includes(type);
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const shape = (v: JsonObject, keys: readonly string[]) => keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k));
export const validProjectPurpose = (v: unknown): v is string => typeof v === 'string' && v.trim() === v && v.length > 0 && utf8(v).length <= 10_000;
export async function projectPurposeHash(purpose: string): Promise<string> {
  if (!validProjectPurpose(purpose)) throw new Error('Invalid project purpose');
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(utf8(canonical(purpose))))));
}
export function projectFields(type: string): readonly string[] {
  switch (type) {
    case 'project.create': return ['format', 'project', 'purposeHash', 'state'];
    case 'project.purpose': return ['format', 'project', 'purposeHash', 'predecessor'];
    case 'project.state': return ['format', 'project', 'state', 'predecessor'];
    case 'project.join': case 'project.leave': return ['format', 'project', 'member', 'predecessor'];
    case 'artifact.project': return ['format', 'project', 'artifact', 'author', 'actor', 'predecessor'];
    default: return [];
  }
}
export function validateProjectPublic(type: string, body: JsonObject): Validation {
  const bad: Validation = { ok: false, reason: 'Invalid public project action' };
  if (!isProjectAction(type) || !object(body) || !shape(body, projectFields(type)) || body.format !== PROJECT_FORMAT || !(isId(body.project) || type === 'artifact.project' && body.project === null)) return bad;
  if (type !== 'project.create' && !(body.predecessor === null || Number.isSafeInteger(body.predecessor) && (body.predecessor as number) >= 0)) return bad;
  if ((type === 'project.create' || type === 'project.purpose') && !validDigest(body.purposeHash)) return bad;
  if (type === 'project.create' && body.state !== 'getting-started' || type === 'project.state' && !(PROJECT_STATES as readonly unknown[]).includes(body.state)) return bad;
  for (const field of ['member', 'artifact', 'author', 'actor']) if (Object.hasOwn(body, field) && !isId(body[field])) return bad;
  return { ok: true };
}
export function copyProjectPublic(type: string, body: JsonObject): JsonObject {
  const check = validateProjectPublic(type, body); if (!check.ok) throw new Error(check.reason);
  const result: JsonObject = {};
  for (const field of projectFields(type)) result[field] = body[field];
  return result;
}
export async function validateProjectRecord(type: ProjectActionType, body: JsonObject, record: ProtocolRecord): Promise<void> {
  if (!object(record) || !shape(record, ['type', 'typeVersion', 'body']) || !object(record.body) || record.typeVersion !== 1 || utf8(JSON.stringify(record)).length > MAX_ARTIFACT_PAYLOAD_BYTES) throw new Error('Invalid encrypted project record');
  if (type === 'project.create' || type === 'project.purpose') {
    if (record.type !== 'project.content' || !shape(record.body, ['purpose']) || !validProjectPurpose(record.body.purpose) || await projectPurposeHash(record.body.purpose) !== body.purposeHash) throw new Error('Invalid project purpose commitment');
  } else if (record.type !== 'project.marker' || !shape(record.body, [])) throw new Error('Invalid project marker');
}
export async function sealProjectPayload(type: ProjectActionType, body: JsonObject, payload: JsonObject, outside: Omit<OuterMeta, 'v' | 'size'>, key: JourneyKey): Promise<Envelope> {
  copyProjectPublic(type, body);
  const record: ProtocolRecord = { type: type === 'project.create' || type === 'project.purpose' ? 'project.content' : 'project.marker', typeVersion: 1, body: payload };
  await validateProjectRecord(type, body, record);
  return seal({ type: record.type, typeVersion: 1, body: record.type === 'project.content' ? { purpose: payload.purpose } : {} }, outside, key);
}
/** Keyed reads fail as a whole; encrypted text is never a second control. */
export async function readProjectPayload(proof: ControlProof, envelope: Envelope, key: JourneyKey): Promise<ProtocolRecord> {
  if (!isProjectAction(proof.type)) throw new Error('Not a project action');
  copyProjectPublic(proof.type, proof.body);
  const hash = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(utf8(canonical(envelope))))));
  if (proof.envelopeHash !== hash || proof.journey !== envelope.outside.journey || proof.seq !== envelope.outside.seq) throw new Error('Project ciphertext mismatch');
  const record = await open(envelope, key);
  await validateProjectRecord(proof.type, proof.body, record);
  return { type: record.type, typeVersion: 1, body: record.type === 'project.content' ? { purpose: record.body.purpose } : {} };
}
/** Selector syntax only. Existence, deletion and placement intersection live in Bend. */
export type ProjectSelector = 'main' | 'all' | string;
export function projectSelector(value?: unknown): ProjectSelector {
  if (value === undefined || value === 'main') return 'main';
  if (value === 'all' || isId(value)) return value;
  throw new Error('Invalid project selector');
}
