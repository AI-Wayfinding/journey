import { projectMembers, replayControl, normalizedMembers, replayJourneyControl, ruleSettings, stage0Rules, replayArtifact, replayProject, invalidateProjectParticipation, ruleValues } from './rules.js';
import { isId } from './ids.js';
import { asBuffer, decode, encode, utf8 } from './codec.js';
import { ruleVersion } from './versions.js';
import type { JsonObject, Validation } from './types.js';
export type Grant = 'members.manage';
export interface Member extends JsonObject { id: string; recipient: string; signingKey: string; kind: 'person' | 'agent'; name?: string; scope?: 'read' | 'readwrite'; addedBy?: string; expiresAt?: string; support?: true }
export const validAgentName = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 60 && value.trim() === value && !/[\x00-\x1f\x7f-\x9f]/.test(value);
export interface LogEntry { v: 1; seq: number; prev: string | null; at: string; actor: string; type: string; body: JsonObject; sig: string }
export interface LogDefinition { name: string; fields: readonly string[]; validate(body: JsonObject): Validation; apply?: (state: LogState, body: JsonObject, actor: string, at?: string) => Promise<EffectError | null> }
export interface MemberProfile extends JsonObject { name: string; email?: string }
export interface DerivedMember { member: Member; grants: Grant[]; profile?: MemberProfile }
export type ContentRole = 'read-only' | 'read-write';
export type JoiningPolicy = 'invitation-only' | 'guide-approved' | 'immediate';
export const validJoiningPolicy = (value: unknown): value is JoiningPolicy => ['invitation-only', 'guide-approved', 'immediate'].includes(value as string);
export interface JourneySettings { name: string; description: string; defaultRole: ContentRole; visibility: 'private' | 'public'; joiningPolicy: JoiningPolicy }
export interface LogState { projects?: ProjectHistory; artifacts?: ArtifactHistory; settings?: JourneySettings; pendingRotation?: boolean; journey: string; members: Record<string, DerivedMember>; grants: Record<string, Grant[]>; currentEpoch: number; minClientVersion: string; lastSeq: number; lastHash: string | null }
export interface LogError { code: 'invalid-entry' | 'broken-chain' | 'invalid-signature' | 'unauthorized' | 'last-holder' | 'client-too-old'; seq: number; message: string }
export type LogResult = { ok: true; state: LogState } | { ok: false; error: LogError };
type EffectError = { code: LogError['code']; message: string };
function control(state: LogState, body: JsonObject, actor: string, operation: Parameters<typeof replayControl>[2], target?: string, member?: Member, guide = false, role = { $: 'ReadWrite' as 'ReadOnly' | 'ReadWrite' }, at?: string): EffectError | null {
  const { transition, model, journey } = replayControl(state, actor, operation, target, member, guide, role, at === undefined ? undefined : Date.parse(at));
  if (transition.$ === 'Denied') return { code: 'unauthorized', message: 'Control is not authorized for this person' };
  if (transition.$ === 'Invalid') return { code: 'invalid-entry', message: 'Duplicate member or required upgrade barrier missing' };
  if (transition.$ === 'LastGuide') return { code: 'last-holder', message: 'At least one person must retain members.manage' };
  if (operation === 'Remove' && target !== undefined) invalidateProjectParticipation(state, target);
  projectMembers(state, transition, model, member);
  if (journey.$ === 'JourneyAccepted') state.pendingRotation = journey.state.pending;
  return null;
}
async function addMember(state: LogState, body: JsonObject, actor: string, at?: string): Promise<EffectError | null> {
  return control(state, body, actor, 'Add', undefined, body.member as Member, (body.grants as Grant[]).includes('members.manage'), undefined, at);
}
async function renameMember(state: LogState, body: JsonObject, actor: string, at?: string): Promise<EffectError | null> {
  const denied = control(state, body, actor, 'Rename', body.id as string, undefined, false, undefined, at);
  if (denied) return denied;
  state.members[body.id as string]!.member.name = body.name as string;
  return null;
}
async function setProfile(state: LogState, body: JsonObject, actor: string, at?: string): Promise<EffectError | null> {
  const denied = control(state, body, actor, 'Profile', body.id as string, undefined, false, undefined, at);
  if (denied) return denied;
  state.members[actor]!.profile = { name: body.name as string, ...(body.email === undefined ? {} : { email: body.email as string }) };
  return null;
}
async function removeMember(state: LogState, body: JsonObject, actor: string, at?: string): Promise<EffectError | null> {
  return control(state, body, actor, 'Remove', body.member as string, undefined, false, undefined, at);
}
function setGrant(add: boolean): LogDefinition['apply'] {
  return async (state, body, actor, at) => control(state, body, actor, 'Guide', body.member as string, undefined, add, undefined, at);
}
async function rotate(state: LogState, body: JsonObject, actor: string, at?: string): Promise<EffectError | null> {
  const denied = control(state, body, actor, 'Rotate', undefined, undefined, false, undefined, at);
  if (denied) return denied;
  if (body.epoch !== state.currentEpoch + 1 || body.recipientsHash !== await recipientsHash(state.members)) return { code: 'invalid-entry', message: 'Invalid key rotation recipients or epoch' };
  state.currentEpoch++;
  return null;
}
async function setMinimum(state: LogState, body: JsonObject, actor: string, at?: string): Promise<EffectError | null> {
  const model = normalizedMembers(state, [actor], at === undefined ? undefined : Date.parse(at));
  const result = replayJourneyControl(state, model, { $: 'Minimum', actor: model.id(actor), version: ruleVersion(body.version as string) });
  if (result.$ !== 'JourneyAccepted') return { code: 'unauthorized', message: 'Minimum requires a guide and cannot decrease' };
  state.minClientVersion = body.version as string;
  return null;
}
async function configure(state: LogState, body: JsonObject, actor: string, at?: string): Promise<EffectError | null> {
  const model = normalizedMembers(state, [actor], at === undefined ? undefined : Date.parse(at));
  const settings = ruleSettings({ ...state, settings: { name: body.name as string, description: body.description as string, defaultRole: body.defaultRole as ContentRole, visibility: body.visibility as JourneySettings['visibility'], joiningPolicy: body.joiningPolicy as JoiningPolicy } });
  const result = replayJourneyControl(state, model, { $: 'Configure', actor: model.id(actor), settings });
  if (result.$ !== 'JourneyAccepted') return { code: 'unauthorized', message: 'Settings require upgraded person-guide authority and active private/invitation-only settings' };
  const next = result.state.settings;
  state.settings = { name: next.name, description: next.description, defaultRole: next.defaultRole.$ === 'ReadOnly' ? 'read-only' : 'read-write', visibility: next.visibility.$ === 'Private' ? 'private' : 'public', joiningPolicy: next.joining.$ === 'InvitationOnly' ? 'invitation-only' : next.joining.$ === 'GuideApproved' ? 'guide-approved' : 'immediate' };
  return null;
}
async function changeRole(state: LogState, body: JsonObject, actor: string, at?: string): Promise<EffectError | null> {
  return control(state, body, actor, 'RoleChange', body.member as string, undefined, false, { $: body.role === 'read-only' ? 'ReadOnly' : 'ReadWrite' }, at);
}
function validVersion(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try { ruleVersion(value); return true; } catch { return false; }
}
import { isArtifactAction, validateArtifactPublic, emptyArtifactHistory, projectArtifact } from './artifacts.js';
import type { ArtifactHistory, BlobDescriptor } from './artifacts.js';
async function artifactEffect(state: LogState, type: string, body: JsonObject, actor: string, at?: string): Promise<EffectError | null> {
  if (!isArtifactAction(type)) return { code: 'invalid-entry', message: 'Unknown artifact action' };
  const blobs = body.blobs as BlobDescriptor[] | undefined;
  if (blobs?.some(b => b.journey !== state.journey || b.epoch > state.currentEpoch)) return { code: 'invalid-entry', message: 'Invalid artifact blob journey or epoch' };
  const previousBlobs = Object.values(state.artifacts?.items ?? {}).flatMap(item => item.versions.flatMap(v => v.blobs));
  if (blobs?.some(b => previousBlobs.some(old => old.id === b.id && canonical(old) !== canonical(b)))) return { code: 'invalid-entry', message: 'Blob descriptor changed' };
  const result = replayArtifact(state, type, body, actor, at === undefined ? undefined : Date.parse(at));
  if (result.transition.$ !== 'ArtifactAccepted') return { code: result.transition.$ === 'ArtifactDenied' ? 'unauthorized' : 'invalid-entry', message: result.transition.$ === 'ArtifactDenied' ? 'Artifact action requires current write access and Stage 1 minimum' : 'Artifact predecessor, attribution or reference conflict' };
  state.artifacts ??= emptyArtifactHistory();
  projectArtifact(state.artifacts, type, body, actor, state.lastSeq + 1);
  return null;
}
import { emptyProjectHistory, PROJECT_ACTIONS, projectFields, validateProjectPublic } from './projects.js';
import type { ProjectHistory, ProjectActionType, ProjectChange, ProjectState } from './projects.js';
async function projectEffect(state: LogState, type: ProjectActionType, body: JsonObject, actor: string, at?: string): Promise<EffectError | null> {
  const seq = state.lastSeq + 1;
  const result = replayProject(state, type, body, actor, at === undefined ? undefined : Date.parse(at));
  if (result.transition.$ !== 'ProjectAccepted') return { code: result.transition.$ === 'ProjectDenied' ? 'unauthorized' : 'invalid-entry', message: result.transition.$ === 'ProjectDenied' ? 'Project action is not authorized or requires Stage 2 minimum' : 'Project predecessor, state or placement conflict; refresh' };
  const old = state.projects ?? emptyProjectHistory();
  const next: ProjectHistory = { items: {}, participation: [], placements: {} };
  const names = new Map(Object.keys(old.items).map(id => [result.projectId(id), id]));
  if (type === 'project.create') names.set(result.projectId(body.project as string), body.project as string);
  const change: ProjectChange = { seq, actor, at: at ?? '', type };
  for (const value of ruleValues(result.transition.index.items)) {
    const id = names.get(value.id)!;
    const previous = old.items[id];
    const stateName: ProjectState = value.phase.$ === 'GettingStarted' ? 'getting-started' : value.phase.$ === 'LookingForOthers' ? 'looking-for-others' : value.phase.$ === 'Archived' ? 'archived' : 'active';
    const changed = Number(value.revision) - 1 === seq;
    next.items[id] = { id, purpose: previous?.purpose ?? '[unavailable]', purposeHash: previous?.purposeHash ?? body.purposeHash as string, state: stateName, revision: Number(value.revision) - 1, creator: previous?.creator ?? actor, at: previous?.at ?? at ?? '', history: previous?.history.slice() ?? [] };
    if (changed) {
      if (type === 'project.create' || type === 'project.purpose') {
        next.items[id]!.purposeHash = body.purposeHash as string;
        next.items[id]!.purpose = typeof body.purpose === 'string' ? body.purpose : '[unavailable]';
      }
      next.items[id]!.history.push(type === 'project.state' ? { ...change, from: previous!.state, to: stateName } : { ...change });
    }
  }
  next.participation = ruleValues(result.transition.index.pairs).map(p => ({ project: names.get(p.project)!, member: result.model.ids[Number(p.person) - 1]!, revision: Number(p.revision) - 1, active: p.active }));
  for (const p of ruleValues(result.transition.index.placements)) {
    const id = result.model.ids[Number(p.artifact) - 1]!;
    next.placements[id] = { artifact: id, project: p.project === 0n ? null : names.get(p.project)!, revision: Number(p.revision) - 1, history: [...(old.placements[id]?.history ?? []), ...(Number(p.revision) - 1 === seq ? [{ seq, actor, at: at ?? '', from: old.placements[id]?.project ?? null, to: p.project === 0n ? null : names.get(p.project)! }] : [])] };
  }
  state.projects = next;
  return null;
}
export const projectDefinitions: readonly LogDefinition[] = PROJECT_ACTIONS.map(name => ({ name, fields: projectFields(name), validate: b => validateProjectPublic(name, b), apply: (state, body, actor, at) => projectEffect(state, name, body, actor, at) }));
const ok: Validation = { ok: true };
const fail = (reason: string): Validation => ({ ok: false, reason });
const object = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const shape = (body: Record<string, unknown>, required: string[], allowed: string[] = required): boolean => required.every(k => Object.hasOwn(body, k)) && Object.keys(body).every(k => allowed.includes(k));
function validMember(value: unknown): value is Member {
  if (!object(value) || !shape(value, ['id', 'recipient', 'signingKey', 'kind'], ['id', 'recipient', 'signingKey', 'kind', 'name', 'scope', 'addedBy', 'expiresAt', 'support'])) return false;
  if (!isId(value.id) || !str(value.recipient) || !str(value.signingKey)) return false;
  return value.kind === 'person' ? value.name === undefined && value.addedBy === undefined && (value.support === true ? value.scope === 'read' && typeof value.expiresAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.expiresAt) && Number.isFinite(Date.parse(value.expiresAt)) : value.support === undefined && value.scope === undefined && (value.expiresAt === undefined || str(value.expiresAt))) : value.kind === 'agent' && value.support === undefined && (value.name === undefined || validAgentName(value.name)) && (value.scope === 'read' || value.scope === 'readwrite') && str(value.addedBy) && (value.expiresAt === undefined || str(value.expiresAt));
}
const grants = (value: unknown): value is Grant[] => Array.isArray(value) && value.every(v => v === 'members.manage') && new Set(value).size === value.length;
const memberBody = (body: JsonObject): Validation => shape(body, ['member', 'grants', 'kind']) && validMember(body.member) && body.kind === body.member.kind && grants(body.grants) ? ok : fail('Invalid member.add');
export const artifactDefinitions: readonly LogDefinition[] = (['artifact.create', 'artifact.version', 'artifact.comment', 'artifact.delete'] as const).map(name => ({ name, fields: ['format', 'artifact', 'author', 'actor', 'version', 'predecessor', 'typeHash', 'blobs', 'comment', 'onVersion'], validate: (body: JsonObject) => validateArtifactPublic(name, body), apply: (state: LogState, body: JsonObject, actor: string, at?: string) => artifactEffect(state, name, body, actor, at) }));
export const logDefinitions: readonly LogDefinition[] = [
  { name: 'genesis', fields: ['journey', 'name', 'creator', 'grants', 'mode', 'visibility', 'minClientVersion', 'description', 'journeyKind'], validate: b => shape(b, ['journey', 'name', 'creator', 'grants', 'mode', 'visibility', 'minClientVersion'], ['journey', 'name', 'creator', 'grants', 'mode', 'visibility', 'minClientVersion', 'description', 'journeyKind']) && isId(b.journey) && str(b.name) && validMember(b.creator) && b.creator.kind === 'person' && grants(b.grants) && b.grants.includes('members.manage') && b.mode === 'sealed' && b.visibility === 'private' && validVersion(b.minClientVersion) && (b.description === undefined || typeof b.description === 'string' && b.description.length <= 2000) && (b.journeyKind === undefined || b.journeyKind === 'individual' || b.journeyKind === 'team') ? ok : fail('Invalid genesis') },
  { name: 'journey.settings', fields: ['name', 'description', 'defaultRole', 'visibility', 'joiningPolicy'], validate: b => shape(b, ['name', 'description', 'defaultRole', 'visibility', 'joiningPolicy']) && str(b.name) && typeof b.description === 'string' && b.description.length <= 2000 && (b.defaultRole === 'read-only' || b.defaultRole === 'read-write') && (b.visibility === 'private' || b.visibility === 'public') && validJoiningPolicy(b.joiningPolicy) ? ok : fail('Invalid journey.settings'), apply: configure },
  { name: 'member.renew', fields: ['id', 'expiresAt'], validate: b => shape(b, ['id', 'expiresAt']) && isId(b.id) && typeof b.expiresAt === 'string' && Number.isFinite(Date.parse(b.expiresAt)) ? ok : fail('Invalid member.renew'), apply: async (state, body, actor, at) => {
    const denied = control(state, body, actor, 'Renew', body.id as string, undefined, false, undefined, at);
    if (denied) return denied;
    state.members[body.id as string]!.member.expiresAt = body.expiresAt as string;
    return null;
  } },
  { name: 'member.role', fields: ['member', 'role'], validate: b => shape(b, ['member', 'role']) && isId(b.member) && (b.role === 'read-only' || b.role === 'read-write') ? ok : fail('Invalid member.role'), apply: changeRole },
  { name: 'member.add', fields: ['member', 'grants', 'kind'], validate: memberBody, apply: addMember },
  { name: 'member.rename', fields: ['id', 'name'], validate: b => shape(b, ['id', 'name']) && isId(b.id) && validAgentName(b.name) ? ok : fail('Invalid member.rename'), apply: renameMember },
  { name: 'member.profile', fields: ['id', 'name', 'email'], validate: b => shape(b, ['id', 'name'], ['id', 'name', 'email']) && isId(b.id) && (b.name === '' || validAgentName(b.name)) && (b.email === undefined || typeof b.email === 'string' && b.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) ? ok : fail('Invalid member.profile'), apply: setProfile },
  { name: 'member.remove', fields: ['member'], validate: b => shape(b, ['member']) && isId(b.member) ? ok : fail('Invalid member.remove'), apply: removeMember },
  { name: 'grant.add', fields: ['member', 'grant'], validate: b => shape(b, ['member', 'grant']) && isId(b.member) && b.grant === 'members.manage' ? ok : fail('Invalid grant.add'), apply: setGrant(true) },
  { name: 'grant.remove', fields: ['member', 'grant'], validate: b => shape(b, ['member', 'grant']) && isId(b.member) && b.grant === 'members.manage' ? ok : fail('Invalid grant.remove'), apply: setGrant(false) },
  { name: 'key.rotate', fields: ['epoch', 'recipientsHash'], validate: b => shape(b, ['epoch', 'recipientsHash']) && Number.isSafeInteger(b.epoch) && str(b.recipientsHash) ? ok : fail('Invalid key.rotate'), apply: rotate },
  { name: 'client.minVersion', fields: ['version'], validate: b => shape(b, ['version']) && validVersion(b.version) ? ok : fail('Invalid client.minVersion'), apply: setMinimum },
];
/** Public-proof definitions are additive; legacy signed logs remain a separate format. */
export const controlDefinitions: readonly LogDefinition[] = [...logDefinitions, ...artifactDefinitions, ...projectDefinitions];
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
  for (const field of ['name', 'scope', 'addedBy', 'expiresAt', 'support']) if (Object.hasOwn(member, field)) result[field] = member[field];
  return result;
}
export async function signEntry(unsigned: Omit<LogEntry, 'sig'>, privateKey: CryptoKey): Promise<LogEntry> {
  const definition = logDefinitions.find(d => d.name === unsigned.type);
  if (isArtifactAction(unsigned.type)) throw new Error('Artifact actions require a public ControlProof');
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
export function initialLogState(entry: LogEntry): LogState {
  const member = entry.body.creator as Member;
  const settings = stage0Rules.legacy_settings(entry.body.name as string, entry.body.description as string ?? '');
  return { projects: emptyProjectHistory(), artifacts: emptyArtifactHistory(), settings: { name: settings.name, description: settings.description, defaultRole: 'read-write', visibility: 'private', joiningPolicy: 'invitation-only' }, pendingRotation: false, journey: entry.body.journey as string, members: { [member.id]: { member, grants: ['members.manage'] } }, grants: { [member.id]: ['members.manage'] }, currentEpoch: 1, minClientVersion: entry.body.minClientVersion as string, lastSeq: 0, lastHash: null };
}
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
    if (isArtifactAction(entry.type)) return error('invalid-entry', index, 'Artifact actions require a public ControlProof');
    if (index !== 0) {
      const validation = definition.validate(entry.body);
      if (!validation.ok) return error('invalid-entry', index, validation.reason);
    }
    if (index === 0) {
      state = initialLogState(entry);
      state.lastHash = await hashEntry(entry);
      continue;
    }
    const current = state!;
    const failure = await definition.apply?.(current, entry.body, entry.actor, entry.at);
    if (failure) return error(failure.code, index, failure.message);
    current.lastSeq = index;
    current.lastHash = await hashEntry(entry);
  }
  return { ok: true, state: state! };
}
