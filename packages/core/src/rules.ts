import rules from './rules/rules.mjs';
import type { Control, List, Member as RuleMember, Role, Transition, JourneySettings, JourneyControl } from './rules/rules.mjs';
import { ruleVersion } from './versions.js';
import { addingPerson } from './membership.js';
import type { LogState, Member } from './log.js';

export const contentRole = (scope: Member['scope']): Role => ({ $: scope === 'read' ? 'ReadOnly' : 'ReadWrite' });
export function ruleList<T>(values: readonly T[]): List<T> {
  let list: List<T> = { $: 'Nil' };
  for (let index = values.length - 1; index >= 0; index--) list = { $: 'Con', head: values[index]!, tail: list };
  return list;
}
export function ruleValues<T>(list: List<T>): T[] {
  const result: T[] = [];
  while (list.$ === 'Con') { result.push(list.head); list = list.tail; }
  return result;
}
/** Named-field adapter. Call only with a verified state, never an access row.
 * Time parsing belongs to TypeScript; role/authority decisions belong to Bend.
 * History replay uses entry-time membership (the legacy signed-log contract).
 */
export function normalizedMembers(state: LogState, extraIds: readonly string[] = [], now?: number) {
  const ids = [...new Set([...Object.keys(state.members), ...Object.values(state.members).map(v => v.member.addedBy).filter((id): id is string => id !== undefined), ...extraIds])];
  const id = (value: string | undefined): bigint => value === undefined ? 0n : BigInt(ids.indexOf(value) + 1);
  const member = (value: Member, guide: boolean): RuleMember => ({
    $: 'Member', id: id(value.id), kind: { $: value.kind === 'person' ? 'Person' : 'Agent' },
    role: contentRole(value.scope), guide, owner: id(value.addedBy), support: value.support === true,
    live: now === undefined || value.expiresAt === undefined || Date.parse(value.expiresAt) > now,
  });
  const members = ruleList(Object.values(state.members).map(v => member(v.member, v.grants.includes('members.manage'))));
  const authorityId = (principal: string | undefined): bigint => principal === undefined ? 0n : id(addingPerson(state, principal, now)?.id);
  return { members, id, member, ids, authorityId };
}
export function isPersonGuide(state: LogState, principal: string): boolean {
  const model = normalizedMembers(state, [principal], Date.now());
  return rules.is_guide(rules.find(model.members, model.authorityId(principal)));
}
export function canWriteContent(state: LogState, principal: string, now = Date.now()): boolean {
  const model = normalizedMembers(state, [principal], now);
  return rules.content_write(rules.member_access(rules.find(model.members, model.id(principal)), model.members), state.pendingRotation === true);
}
export function canReadContent(state: LogState, principal: string, now = Date.now()): boolean {
  const model = normalizedMembers(state, [principal], now);
  return rules.access_read(rules.member_access(rules.find(model.members, model.id(principal)), model.members));
}
export function effectiveScope(state: LogState, principal: string, now = Date.now()): 'read' | 'readwrite' | null {
  const model = normalizedMembers(state, [principal], now);
  const access = rules.member_access(rules.find(model.members, model.id(principal)), model.members);
  return access.$ === 'None' ? null : access.value.$ === 'ReadOnly' ? 'read' : 'readwrite';
}
export function replayControl(state: LogState, actor: string, operation: Control['$'], target?: string, addition?: Member, guide = false, role: Role = { $: 'ReadWrite' }, now?: number): { transition: Transition; model: ReturnType<typeof normalizedMembers>; journey: ReturnType<typeof replayJourneyControl> } {
  const model = normalizedMembers(state, [actor, ...(target ? [target] : []), ...(addition ? [addition.id, ...(addition.addedBy ? [addition.addedBy] : [])] : [])], now);
  const authority = model.authorityId(actor);
  let control: Control;
  switch (operation) {
    case 'Add': control = { $: 'Add', actor: authority, member: model.member(addition!, guide) }; break;
    case 'Guide': control = { $: 'Guide', actor: authority, target: model.id(target), guide }; break;
    case 'RoleChange': control = { $: 'RoleChange', actor: authority, target: model.id(target), role }; break;
    case 'Settings': case 'Rotate': control = { $: operation, actor: authority }; break;
    default: control = { $: operation, actor: authority, target: model.id(target) }; break;
  }
  const result = replayJourneyControl(state, model, { $: operation === 'RoleChange' || operation === 'Renew' ? 'NewControl' : 'LegacyControl', control });
  const transition: Transition = result.$ === 'JourneyAccepted' ? { $: 'Accepted', members: result.state.members }
    : { $: result.$ === 'JourneyLastGuide' ? 'LastGuide' : result.$ === 'JourneyInvalid' || result.$ === 'UpgradeRequired' ? 'Invalid' : 'Denied' };
  return { transition, model, journey: result };
}
/** Project the Bend result into host-owned names, keys and profiles. */
export function projectMembers(state: LogState, transition: Extract<Transition, { $: 'Accepted' }>, model: ReturnType<typeof normalizedMembers>, addition?: Member): void {
  const members: LogState['members'] = {};
  const grants: LogState['grants'] = {};
  for (const next of ruleValues(transition.members)) {
    const id = model.ids[Number(next.id) - 1]!;
    const old = state.members[id];
    const value = old?.member ?? addition!;
    const member: Member = { id: value.id, recipient: value.recipient, signingKey: value.signingKey, kind: value.kind };
    if (value.name !== undefined) member.name = value.name;
    if (value.scope !== undefined || next.role.$ === 'ReadOnly') member.scope = next.role.$ === 'ReadOnly' ? 'read' : 'readwrite';
    if (value.addedBy !== undefined) member.addedBy = value.addedBy;
    if (value.expiresAt !== undefined) member.expiresAt = value.expiresAt;
    if (value.support !== undefined) member.support = value.support;
    const held: LogState['grants'][string] = next.guide ? ['members.manage'] : [];
    members[id] = { member, grants: held, ...(old?.profile ? { profile: old.profile } : {}) };
    grants[id] = held;
  }
  state.members = members; state.grants = grants;
}
export { rules as stage0Rules };

export function canControl(state: LogState, actor: string, operation: Control['$'], target?: string, guide = false): boolean {
  return replayControl(state, actor, operation, target, undefined, guide, undefined, Date.now()).transition.$ === 'Accepted';
}
export function canRenameAgent(state: LogState, actor: string, target: string): boolean {
  const model = normalizedMembers(state, [actor, target], Date.now());
  return rules.rename_authority(model.members, model.authorityId(actor), rules.find(model.members, model.id(target)));
}

export function ownsAgent(state: LogState, actor: string, target: string): boolean {
  const model = normalizedMembers(state, [actor, target], Date.now());
  return rules.own_agent(model.members, model.authorityId(actor), rules.find(model.members, model.id(target)));
}

export function ruleSettings(state: LogState): JourneySettings {
  const settings = state.settings;
  return settings ? { $: 'JourneySettings', name: settings.name, description: settings.description,
    defaultRole: { $: settings.defaultRole === 'read-only' ? 'ReadOnly' : 'ReadWrite' },
    visibility: { $: settings.visibility === 'private' ? 'Private' : 'Public' },
    joining: { $: settings.joiningPolicy === 'invitation-only' ? 'InvitationOnly' : settings.joiningPolicy === 'guide-approved' ? 'GuideApproved' : 'Immediate' } }
    : rules.legacy_settings('', '');
}
export function replayJourneyControl(state: LogState, model: ReturnType<typeof normalizedMembers>, control: JourneyControl) {
  if (control.$ === 'Configure') control = { $: 'Configure', actor: model.authorityId(model.ids[Number(control.actor) - 1]), settings: control.settings };
  else if (control.$ === 'Minimum') control = { $: 'Minimum', actor: model.authorityId(model.ids[Number(control.actor) - 1]), version: control.version };
  return rules.journey_replay(ruleList([control]), { $: 'JourneyAccepted', state: {
    $: 'JourneyState', members: model.members, settings: ruleSettings(state), minimum: ruleVersion(state.minClientVersion), pending: state.pendingRotation === true,
  } });
}

/** Signed artifact history -> production Bend, with one ID namespace including type commitments. */
export function normalizedArtifacts(state: LogState, body: import('./types.js').JsonObject = {}, actor = '', now?: number, extraIds: readonly string[] = []) {
  const history = state.artifacts ?? { items: {}, used: [] };
  const strings = [...history.used, actor, ...extraIds, ...Object.keys(state.projects?.items ?? {})];
  for (const item of Object.values(history.items)) {
    strings.push(item.id, item.author, item.typeHash, item.head);
    for (const version of item.versions) strings.push(version.id, version.actor, ...version.blobs.map(b => b.id));
    for (const comment of item.comments) strings.push(comment.id, comment.actor, ...(comment.onVersion ? [comment.onVersion] : []));
  }
  for (const field of ['artifact', 'author', 'actor', 'version', 'predecessor', 'typeHash', 'comment', 'onVersion']) if (typeof body[field] === 'string') strings.push(body[field]);
  if (Array.isArray(body.blobs)) for (const blob of body.blobs as import('./artifacts.js').BlobDescriptor[]) strings.push(blob.id);
  const model = normalizedMembers(state, strings, now);
  const index: import('./rules/rules.mjs').ArtifactIndex = { $: 'ArtifactIndex', used: ruleList([...history.used, ...Object.keys(state.projects?.items ?? {})].map(model.id)), items: ruleList(Object.values(history.items).map(item => ({
    $: 'Artifact' as const, id: model.id(item.id), author: model.id(item.author), typeHash: model.id(item.typeHash), head: model.id(item.head), deleted: item.deleted,
    versions: ruleList(item.versions.map(v => ({ $: 'ArtifactVersion' as const, id: model.id(v.id), writer: model.id(v.actor), blobs: ruleList(v.blobs.map(b => model.id(b.id))) }))),
  }))) };
  return { model, index };
}
export function replayArtifact(state: LogState, type: import('./artifacts.js').ArtifactActionType, body: import('./types.js').JsonObject, actor: string, now?: number) {
  const { model, index } = normalizedArtifacts(state, body, actor, now);
  const common = { id: model.id(body.artifact as string), author: model.id(body.author as string), writer: model.id(body.actor as string) };
  let action: import('./rules/rules.mjs').ArtifactAction;
  if (type === 'artifact.create' || type === 'artifact.version') {
    const version = { version: model.id(body.version as string), typeHash: model.id(body.typeHash as string), blobs: ruleList((body.blobs as import('./artifacts.js').BlobDescriptor[]).map(b => model.id(b.id))) };
    action = type === 'artifact.create' ? { $: 'ArtifactCreate', ...common, ...version } : { $: 'ArtifactEdit', ...common, ...version, predecessor: model.id(body.predecessor as string) };
  } else if (type === 'artifact.comment') action = { $: 'ArtifactComment', ...common, comment: model.id(body.comment as string), onVersion: model.id(body.onVersion as string | undefined) };
  else action = { $: 'ArtifactDelete', ...common };
  return { transition: rules.artifact_apply(model.members, model.id(actor), ruleVersion(state.minClientVersion), state.pendingRotation === true, index, action), model };
}
export function liveArtifactBlobIds(state: LogState): string[] {
  const { model, index } = normalizedArtifacts(state);
  const blobs = Object.values(state.artifacts?.items ?? {}).flatMap(a => a.versions.flatMap(v => v.blobs.map(b => b.id)));
  return [...new Set(blobs)].filter(id => rules.artifact_live_blob(index.items, model.id(id)));
}

import type { ProjectState, ProjectActionType } from './projects.js';
import { projectSelector } from './projects.js';
import type { JsonObject } from './types.js';
const phases = { 'getting-started': 'GettingStarted', active: 'Active', 'looking-for-others': 'LookingForOthers', archived: 'Archived' } as const;
const revision = (seq: number | null): bigint => seq === null ? 0n : BigInt(seq + 1);
/** Normalization reserves 0 for main and 1 for all; all IDs share a namespace. */
export function normalizedProjects(state: LogState, body: JsonObject = {}, actor = '', now?: number) {
  const history = state.projects ?? { items: {}, participation: [], placements: {} };
  const strings = [actor, ...Object.keys(history.items), ...history.participation.flatMap(p => [p.project, p.member]), ...Object.values(history.placements).flatMap(p => [p.artifact, ...(p.project ? [p.project] : [])])];
  for (const key of ['project', 'member', 'artifact', 'actor', 'author']) if (typeof body[key] === 'string') strings.push(body[key]);
  const { model, index: artifacts } = normalizedArtifacts(state, {}, actor, now, strings);
  // Shift only project identifiers: the artifact/member namespace remains aligned.
  const projectId = (value: string | null) => value === null ? 0n : model.id(value) + 1n;
  const index: import('./rules/rules.mjs').ProjectIndex = { $: 'ProjectIndex',
    items: ruleList(Object.values(history.items).map(p => ({ $: 'ProjectInfo' as const, id: projectId(p.id), revision: revision(p.revision), phase: { $: phases[p.state] } }))),
    pairs: ruleList(history.participation.map(p => ({ $: 'Participation' as const, project: projectId(p.project), person: model.id(p.member), revision: revision(p.revision), active: p.active }))),
    placements: ruleList(Object.values(history.placements).map(p => ({ $: 'Placement' as const, artifact: model.id(p.artifact), project: projectId(p.project), revision: revision(p.revision) }))),
  };
  // Project IDs are shifted, so translate used IDs to that same namespace for collision checks.
  const reserved: import('./rules/rules.mjs').ArtifactIndex = { $: 'ArtifactIndex', items: artifacts.items, used: ruleList((state.artifacts?.used ?? []).map(v => model.id(v) + 1n)) };
  return { model, index, artifacts, reserved, projectId };
}
export function replayProject(state: LogState, type: ProjectActionType, body: JsonObject, actor: string, now?: number) {
  const { model, index, reserved, projectId } = normalizedProjects(state, body, actor, now);
  const id = projectId(body.project as string | null);
  const predecessor = revision((body.predecessor ?? null) as number | null);
  let action: import('./rules/rules.mjs').ProjectAction;
  switch (type) {
    case 'project.create': action = { $: 'ProjectCreate', id }; break;
    case 'project.purpose': action = { $: 'ProjectPurpose', id, predecessor }; break;
    case 'project.state': action = { $: 'ProjectStateChange', id, predecessor, phase: { $: phases[body.state as ProjectState] } }; break;
    case 'project.join': case 'project.leave': action = { $: type === 'project.join' ? 'ProjectJoin' : 'ProjectLeave', id, member: model.authorityId(body.member as string), predecessor }; break;
    case 'artifact.project': action = { $: 'ArtifactProject', id: model.id(body.artifact as string), project: id, author: model.id(body.author as string), writer: model.id(body.actor as string), predecessor }; break;
  }
  return { transition: rules.project_apply(model.members, model.id(actor), ruleVersion(state.minClientVersion), state.pendingRotation === true, index, reserved, revision(state.lastSeq + 1), action), model, projectId };
}
export function effectiveProjectParticipants(state: LogState, project: string, now = Date.now()): string[] {
  const { model, index, projectId } = normalizedProjects(state, { project }, '', now);
  return Object.keys(state.members).filter(actor => rules.project_participant(model.members, index.pairs, projectId(project), model.id(actor)));
}
export function canEditProject(state: LogState, actor: string, project: string, now = Date.now()): boolean {
  const { model, index, projectId } = normalizedProjects(state, { project }, actor, now);
  return rules.project_participant(model.members, index.pairs, projectId(project), model.id(actor));
}
export function invalidateProjectParticipation(state: LogState, person: string): void {
  if (!state.projects) return;
  const { model, index, projectId } = normalizedProjects(state, { member: person });
  const names = new Map(Object.keys(state.projects.items).map(id => [projectId(id), id]));
  state.projects.participation = ruleValues(rules.project_remove(index.pairs, model.id(person), revision(state.lastSeq + 1))).map(p => ({ project: names.get(p.project)!, member: model.ids[Number(p.person) - 1]!, revision: Number(p.revision) - 1, active: p.active }));
}
/** Bend selects only live matching artifacts; host type/tag/text filters intersect this result. */
export function selectProjectArtifacts(state: LogState, selector?: unknown): string[] {
  const selection = projectSelector(selector);
  const { model, index, artifacts, projectId } = normalizedProjects(state, { project: selection });
  const chosen = selection === 'main' ? 0n : selection === 'all' ? 1n : projectId(selection);
  if (!rules.project_selector(index.items, chosen)) throw new Error('Unknown project');
  return Object.keys(state.artifacts?.items ?? {}).filter(id => rules.project_selected(rules.artifact_find(artifacts.items, model.id(id)), index.placements, chosen, model.id(id)));
}
