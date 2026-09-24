import { isId } from './ids.js';
import { asBuffer, decode, encode, utf8 } from './codec.js';
import { meetsMinClientVersion } from './versions.js';
import type { JsonObject, Validation } from './types.js';
export type Grant = 'members.manage';
export interface Member extends JsonObject { id: string; recipient: string; signingKey: string; kind: 'person' | 'agent'; scope?: 'read' | 'readwrite'; addedBy?: string; expiresAt?: string; support?: true }
export interface LogEntry { v: 1; seq: number; prev: string | null; at: string; actor: string; type: string; body: JsonObject; sig: string }
export interface LogDefinition { name: string; fields: readonly string[]; validate(body: JsonObject): Validation; apply?: (state: LogState, body: JsonObject, actor: string, holder: boolean) => Promise<EffectError | null> }
export interface DerivedMember { member: Member; grants: Grant[] }
export interface LogState { journey: string; members: Record<string, DerivedMember>; grants: Record<string, Grant[]>; currentEpoch: number; minClientVersion: string; lastSeq: number; lastHash: string | null }
export interface LogError { code: 'invalid-entry' | 'broken-chain' | 'invalid-signature' | 'unauthorized' | 'last-holder' | 'client-too-old'; seq: number; message: string }
export type LogResult = { ok: true; state: LogState } | { ok: false; error: LogError };
type EffectError = { code: LogError['code']; message: string };
const denied = (message: string): EffectError => ({ code: 'unauthorized', message });
function addMember(state: LogState, body: JsonObject, actor: string, holder: boolean): Promise<EffectError | null> {
  const member = body.member as Member;
  if (state.members[member.id]) return Promise.resolve({ code: 'invalid-entry', message: 'Duplicate member' });
  if (member.kind === 'agent') {
    if (member.addedBy !== actor || !state.members[member.addedBy] || (body.grants as Grant[]).length) return Promise.resolve(denied('An agent must belong to its acting person and hold no grants'));
  } else {
    if (!holder) return Promise.resolve(denied('Only a holder may add people'));
    if (member.support && (body.grants as Grant[]).length) return Promise.resolve(denied('Support members cannot hold grants'));
  }
  state.members[member.id] = { member, grants: [...body.grants as Grant[]] };
  state.grants[member.id] = [...body.grants as Grant[]];
  return Promise.resolve(null);
}
function removeMember(state: LogState, body: JsonObject, actor: string, holder: boolean): Promise<EffectError | null> {
  const target = body.member as string;
  const removed = state.members[target];
  if (!removed) return Promise.resolve({ code: 'invalid-entry', message: 'Member not found' });
  if (!holder && target !== actor && removed.member.addedBy !== actor) return Promise.resolve(denied('Cannot remove another member'));
  delete state.members[target]; delete state.grants[target];
  if (removed.member.kind === 'person') for (const [id, value] of Object.entries(state.members)) if (value.member.addedBy === target) { delete state.members[id]; delete state.grants[id]; }
  return Promise.resolve(null);
}
function setGrant(add: boolean): LogDefinition['apply'] {
  return async (state, body, _actor, holder) => {
    if (!holder) return denied('Only a holder may change grants');
    const target = body.member as string;
    if (state.members[target]?.member.kind !== 'person') return denied('Only people may hold grants');
    if (state.members[target]?.member.support) return denied('Support members cannot hold grants');
    state.grants[target] = add ? ['members.manage'] : [];
    state.members[target]!.grants = state.grants[target]!;
    return null;
  };
}
async function rotate(state: LogState, body: JsonObject, _actor: string, holder: boolean): Promise<EffectError | null> {
  if (!holder) return denied('Only a holder may rotate keys');
  if (body.epoch !== state.currentEpoch + 1 || body.recipientsHash !== await recipientsHash(state.members)) return { code: 'invalid-entry', message: 'Invalid key rotation recipients or epoch' };
  state.currentEpoch++;
  return null;
}
async function setMinimum(state: LogState, body: JsonObject, _actor: string, holder: boolean): Promise<EffectError | null> {
  if (!holder) return denied('Only a holder may update minimum client version');
  if (!meetsMinClientVersion(body.version as string, state.minClientVersion)) return { code: 'invalid-entry', message: 'Minimum client version cannot decrease' };
  state.minClientVersion = body.version as string;
  return null;
}
const ok: Validation = { ok: true };
const fail = (reason: string): Validation => ({ ok: false, reason });
const object = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const shape = (body: object, required: string[], allowed: string[] = required): boolean => required.every(k => Object.hasOwn(body, k)) && Object.keys(body).every(k => allowed.includes(k));
function validMember(value: unknown): value is Member {
  if (!object(value) || !shape(value, ['id', 'recipient', 'signingKey', 'kind'], ['id', 'recipient', 'signingKey', 'kind', 'scope', 'addedBy', 'expiresAt', 'support'])) return false;
  if (!isId(value.id) || !str(value.recipient) || !str(value.signingKey)) return false;
  return value.kind === 'person' ? value.addedBy === undefined && (value.support === true ? value.scope === 'read' && typeof value.expiresAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.expiresAt) && Number.isFinite(Date.parse(value.expiresAt)) : value.support === undefined && value.scope === undefined && (value.expiresAt === undefined || str(value.expiresAt))) : value.kind === 'agent' && value.support === undefined && (value.scope === 'read' || value.scope === 'readwrite') && str(value.addedBy) && (value.expiresAt === undefined || str(value.expiresAt));
}
const grants = (value: unknown): value is Grant[] => Array.isArray(value) && value.every(v => v === 'members.manage') && new Set(value).size === value.length;
const memberBody = (body: JsonObject): Validation => shape(body, ['member', 'grants', 'kind']) && validMember(body.member) && body.kind === body.member.kind && grants(body.grants) ? ok : fail('Invalid member.add');
export const logDefinitions: readonly LogDefinition[] = [
  { name: 'genesis', fields: ['journey', 'name', 'creator', 'grants', 'mode', 'visibility', 'minClientVersion', 'description', 'journeyKind'], validate: b => shape(b, ['journey', 'name', 'creator', 'grants', 'mode', 'visibility', 'minClientVersion'], ['journey', 'name', 'creator', 'grants', 'mode', 'visibility', 'minClientVersion', 'description', 'journeyKind']) && isId(b.journey) && str(b.name) && validMember(b.creator) && b.creator.kind === 'person' && grants(b.grants) && b.grants.includes('members.manage') && b.mode === 'sealed' && b.visibility === 'private' && str(b.minClientVersion) && (b.description === undefined || typeof b.description === 'string' && b.description.length <= 2000) && (b.journeyKind === undefined || b.journeyKind === 'individual' || b.journeyKind === 'team') ? ok : fail('Invalid genesis') },
  { name: 'member.add', fields: ['member', 'grants', 'kind'], validate: memberBody, apply: addMember },
  { name: 'member.remove', fields: ['member'], validate: b => shape(b, ['member']) && isId(b.member) ? ok : fail('Invalid member.remove'), apply: removeMember },
  { name: 'grant.add', fields: ['member', 'grant'], validate: b => shape(b, ['member', 'grant']) && isId(b.member) && b.grant === 'members.manage' ? ok : fail('Invalid grant.add'), apply: setGrant(true) },
  { name: 'grant.remove', fields: ['member', 'grant'], validate: b => shape(b, ['member', 'grant']) && isId(b.member) && b.grant === 'members.manage' ? ok : fail('Invalid grant.remove'), apply: setGrant(false) },
  { name: 'key.rotate', fields: ['epoch', 'recipientsHash'], validate: b => shape(b, ['epoch', 'recipientsHash']) && Number.isSafeInteger(b.epoch) && str(b.recipientsHash) ? ok : fail('Invalid key.rotate'), apply: rotate },
  { name: 'client.minVersion', fields: ['version'], validate: b => shape(b, ['version']) && str(b.version) ? ok : fail('Invalid client.minVersion'), apply: setMinimum },
];
/** Canonical JSON: lexicographically sorted object keys, array order retained, UTF-8 for signing. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  throw new TypeError('Non-JSON value in signed log');
}
export async function hashEntry(entry: LogEntry): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(utf8(canonical(entry))))));
}
export async function recipientsHash(members: LogState['members']): Promise<string> {
  const sorted = Object.values(members).map(({ member }) => [member.id, member.recipient]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(utf8(canonical(sorted))))));
}
function copyMember(member: JsonObject): JsonObject {
  const result: JsonObject = { id: member.id, recipient: member.recipient, signingKey: member.signingKey, kind: member.kind };
  for (const field of ['scope', 'addedBy', 'expiresAt', 'support']) if (Object.hasOwn(member, field)) result[field] = member[field];
  return result;
}
export async function signEntry(unsigned: Omit<LogEntry, 'sig'>, privateKey: CryptoKey): Promise<LogEntry> {
  const definition = logDefinitions.find(d => d.name === unsigned.type);
  if (!definition) throw new Error('Cannot sign an unknown membership entry');
  const body: JsonObject = {};
  for (const field of definition.fields) if (Object.hasOwn(unsigned.body, field)) {
    const value = unsigned.body[field];
    body[field] = (field === 'creator' || field === 'member' && object(value)) && object(value) ? copyMember(value) : field === 'grants' && Array.isArray(value) ? [...value] : value;
  }
  const validation = definition.validate(body);
  if (!validation.ok) throw new Error(validation.reason);
  const message = { v: unsigned.v, seq: unsigned.seq, prev: unsigned.prev, at: unsigned.at, actor: unsigned.actor, type: unsigned.type, body };
  const sig = encode(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, asBuffer(utf8(canonical(message))))));
  return { ...message, sig };
}
function error(code: LogError['code'], seq: number, message: string): LogResult { return { ok: false, error: { code, seq, message } }; }
export async function verifyLog(entries: readonly LogEntry[]): Promise<LogResult> {
  if (!entries.length) return error('invalid-entry', 0, 'Missing genesis');
  let state: LogState | undefined;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!object(entry) || !shape(entry, ['v', 'seq', 'prev', 'at', 'actor', 'type', 'body', 'sig']) || entry.v !== 1 || !Number.isSafeInteger(entry.seq) || entry.seq !== index || entry.prev !== (state?.lastHash ?? null)) return error('broken-chain', index, 'Sequence or previous hash mismatch');
    if (!str(entry.at) || !str(entry.actor) || !str(entry.type) || !object(entry.body) || !str(entry.sig)) return error('invalid-entry', index, 'Invalid entry fields');
    if ((index === 0) !== (entry.type === 'genesis')) return error('invalid-entry', index, 'Genesis must be the first and only genesis');
    const definition = logDefinitions.find(d => d.name === entry.type);
    if (index === 0) {
      const validation = definition!.validate(entry.body);
      if (!validation.ok) return error('invalid-entry', index, validation.reason);
    }
    const signer = index === 0 ? entry.body.creator as Member : state?.members[entry.actor]?.member;
    if (!signer || (index === 0 && signer.id !== entry.actor)) return error('unauthorized', index, 'Actor is not a current member');
    try {
      const publicKey = await crypto.subtle.importKey('raw', asBuffer(decode(signer.signingKey)), 'Ed25519', false, ['verify']);
      const { sig, ...unsigned } = entry;
      if (!await crypto.subtle.verify('Ed25519', publicKey, asBuffer(decode(sig)), asBuffer(utf8(canonical(unsigned))))) return error('invalid-signature', index, 'Entry signature mismatch');
    } catch { return error('invalid-signature', index, 'Invalid signature or signing key'); }
    if (!definition) return error('client-too-old', index, 'Unknown membership entry type: ' + entry.type);
    if (index !== 0) {
      const validation = definition.validate(entry.body);
      if (!validation.ok) return error('invalid-entry', index, validation.reason);
    }
    if (index === 0) {
      const member = entry.body.creator as Member;
      state = { journey: entry.body.journey as string, members: { [member.id]: { member, grants: ['members.manage'] } }, grants: { [member.id]: ['members.manage'] }, currentEpoch: 1, minClientVersion: entry.body.minClientVersion as string, lastSeq: 0, lastHash: await hashEntry(entry) };
      continue;
    }
    const current = state!;
    const holder = signer.kind === 'person' && current.grants[entry.actor]?.includes('members.manage');
    if (signer.kind !== 'person') return error('unauthorized', index, 'Agents cannot sign membership changes');
    const failure = await definition.apply?.(current, entry.body, entry.actor, Boolean(holder));
    if (failure) return error(failure.code, index, failure.message);
    if (!Object.entries(current.members).some(([id, value]) => value.member.kind === 'person' && current.grants[id]?.includes('members.manage'))) return error('last-holder', index, 'At least one person must retain members.manage');
    current.lastSeq = index;
    current.lastHash = await hashEntry(entry);
  }
  return { ok: true, state: state! };
}
