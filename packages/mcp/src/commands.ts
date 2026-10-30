import * as z from 'zod';

const id = z.string().min(1).max(200);
const text = z.string().min(1).max(4096);
const nat = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const role = z.enum(['read', 'write']);
const policy = z.enum(['request', 'open', 'invite']);
const status = z.enum(['gettingStarted', 'active', 'lookingForOthers', 'archived']);
const context = { journeyId: id, actingAgent: id.optional() };
const target = { ...context, personId: id };
const project = { ...context, projectId: id };
const limits = { read: z.boolean(), write: z.boolean(), grant: z.boolean() };
const relayContext = { groupId: id, actingAgent: id.optional(), memberId: id.optional() };
// Canonical padded base64 only; decoded limits are checked before any storage write.
const opaque = (bytes: number) => z.string().min(4).max(4 * Math.ceil(bytes / 3))
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

// Strict, named inputs: callers cannot supply authority flags, profile fields or plaintext.
export const inputs = {
  account_read: z.object({}).strict(),
  journey_create: z.object({ name: text, policy: policy.default('request'), defaultRole: role.default('read') }).strict(),
  journey_list: z.object({}).strict(),
  journey_read: z.object(context).strict(),
  journey_policy: z.object({ ...context, policy, defaultRole: role }).strict(),
  journey_invite: z.object({ ...context, personId: id.optional(), email: z.email().max(320).optional() }).strict()
    .refine(v => (v.personId !== undefined) !== (v.email !== undefined), 'Supply exactly one of personId or email'),
  journey_request: z.object(context).strict(),
  journey_join: z.object(context).strict(),
  journey_admit: z.object(target).strict(),
  journey_refuse: z.object(target).strict(),
  journey_role: z.object({ ...target, role }).strict(),
  journey_guide: z.object(target).strict(),
  journey_unguide: z.object(target).strict(),
  journey_remove: z.object({ ...context, memberId: id }).strict(),
  journey_leave: z.object(context).strict(),
  agent_add: z.object({ journeyId: id, name: text, ...limits }).strict(),
  agent_card: z.object({ journeyId: id, agentId: id, action: z.enum(['edit', 'withdraw', 'sign']), ...limits }).strict(),
  agent_capabilities: z.object({ journeyId: id, actingAgent: id }).strict(),
  project_create: z.object({ ...context, name: text, purpose: text }).strict(),
  project_join: z.object(project).strict(),
  project_leave: z.object(project).strict(),
  project_update: z.object({ ...project, purpose: text.optional(), status: status.optional() }).strict()
    .refine((v) => v.purpose !== undefined || v.status !== undefined, 'Supply purpose or status'),
  grant_issue: z.object({ ...context, grantee: id, need: z.enum(['read', 'write', 'guide']), resource: id, uses: nat.min(1), expiresAt: nat }).strict(),
  grant_use: z.object({ ...context, grantId: id, need: z.enum(['read', 'write', 'guide']), resource: id }).strict(),
  grant_revoke: z.object({ ...context, grantId: id }).strict(),
  artifact_create: z.object({ ...context, name: text, type: id, size: nat }).strict(),
  artifact_version: z.object({ ...context, artifactId: id, size: nat, baseVersion: nat }).strict(),
  artifact_rename: z.object({ ...context, artifactId: id, name: text }).strict(),
  artifact_delete: z.object({ ...context, artifactId: id }).strict(),
  task_create: z.object({ ...context, name: text, assignee: id.optional(), maxRounds: nat.min(1), deadline: nat.max(8_640_000_000_000_000) }).strict(),
  task_step: z.object({ ...context, taskId: id, action: z.enum(['claim', 'startRound', 'endRound', 'finish', 'cancel', 'expire']) }).strict(),
  personal_group_read: z.object({}).strict(),
  personal_group_add: z.object({ name: text, kind: z.enum(['device', 'agent']) }).strict(),
  personal_group_remove: z.object({ memberId: id }).strict(),
  mls_key_package_publish: z.object({ deviceId: id, data: opaque(64 * 1024) }).strict(),
  mls_key_package_fetch: z.object({ personId: id, deviceId: id }).strict(),
  mls_message_post: z.object({ ...relayContext, epoch: nat, kind: z.enum(['handshake', 'application']), data: opaque(1024 * 1024) }).strict(),
  mls_message_fetch: z.object({ ...relayContext, since: nat.default(0), limit: nat.min(1).max(100).default(100) }).strict(),
  artifact_blob_put: z.object({ ...relayContext, artifactId: id, version: nat.min(1), data: opaque(10 * 1024 * 1024) }).strict(),
  artifact_blob_get: z.object({ ...relayContext, artifactId: id, version: nat.min(1) }).strict(),
  artifact_blob_delete: z.object({ ...relayContext, artifactId: id }).strict(),
  account_update: z.object({ nickname: z.string().trim().min(1).max(80) }).strict(),
} as const;

export type RelayCommand = Extract<Command, { tool: 'mls_message_post' | 'mls_message_fetch' | 'artifact_blob_put' | 'artifact_blob_get' | 'artifact_blob_delete' }>;
export type KeyPackageCommand = Extract<Command, { tool: 'mls_key_package_publish' | 'mls_key_package_fetch' }>;
export function isRelay(command: Command): command is RelayCommand {
  return ['mls_message_post', 'mls_message_fetch', 'artifact_blob_put', 'artifact_blob_get', 'artifact_blob_delete'].includes(command.tool);
}
export const descriptions: Record<ToolName, string> = {
  account_read: 'Read your account, WorkOS profile, nickname, personId and personalGroupId.',
  account_update: 'Set your display nickname using a trimmed nickname of 1 to 80 characters.',
  journey_create: 'Create a journey with a name, joining policy and default member role; you become its guide.',
  journey_list: 'List the journeys you can currently read.',
  journey_read: 'Read a journey by journeyId, including its members, pending people, projects, artifacts and tasks.',
  journey_policy: 'Set a journey joining policy and defaultRole as a guide using journeyId.',
  journey_invite: 'Invite a person as a journey guide using journeyId and exactly one of personId or email; they must already have an account.',
  journey_request: 'Ask to join a journey whose policy is request; a guide must admit you.',
  journey_join: 'Join an open journey or accept an invitation using journeyId.',
  journey_admit: 'Admit a pending person as a journey guide using journeyId and personId.',
  journey_refuse: 'Refuse a pending person as a journey guide using journeyId and personId.',
  journey_role: 'Set a person role to read or write as a guide using journeyId and personId.',
  journey_guide: 'Make a journey person a guide using journeyId and personId.',
  journey_unguide: 'Remove guide authority from a person using journeyId and personId, keeping at least one guide.',
  journey_remove: 'Remove a journey member using journeyId and memberId, subject to current guide or agent-owner authority.',
  journey_leave: 'Leave a journey using journeyId, provided at least one guide remains.',
  agent_add: 'Add your named journey agent with a signed card specifying read, write and grant limits.',
  agent_card: 'Edit, withdraw or sign your agent card using journeyId, agentId, action and permission limits.',
  agent_capabilities: 'Read effective agent permissions using journeyId and actingAgent, intersecting its card with your live authority.',
  project_create: 'Create a project in a journey using journeyId, name and purpose.',
  project_join: 'Join a project using journeyId and projectId.',
  project_leave: 'Leave a project using journeyId and projectId.',
  project_update: 'Update a project purpose or status using journeyId and projectId.',
  grant_issue: 'Issue a bounded grant using journeyId, grantee, need, resource, uses and expiresAt in milliseconds.',
  grant_use: 'Use one grant allowance using journeyId, grantId, need and resource.',
  grant_revoke: 'Revoke your grant using journeyId and grantId.',
  artifact_create: 'Create artifact metadata in a journey using name, type and size, without uploading content.',
  artifact_version: 'Add artifact version metadata using journeyId, artifactId, size and the current baseVersion.',
  artifact_rename: 'Rename artifact metadata using journeyId, artifactId and name.',
  artifact_delete: 'Delete an artifact and its stored ciphertext using journeyId and artifactId.',
  task_create: 'Create a bounded task using journeyId, name, optional assignee, maxRounds and a deadline in Unix milliseconds.',
  task_step: 'Advance a task using journeyId, taskId and a claim, round, finish, cancel or expire action.',
  personal_group_read: 'Read your personal encryption group and its registered identities.',
  personal_group_add: 'Register a named device or agent in your personal encryption group using name and kind.',
  personal_group_remove: 'Remove one of your personal encryption group identities using memberId.',
  mls_key_package_publish: 'Publish an opaque MLS key package for your registered deviceId using base64 data.',
  mls_key_package_fetch: 'Consume an available MLS key package using its authenticated personId and deviceId.',
  mls_message_post: 'Post an opaque MLS handshake or application message using groupId, epoch, kind and base64 data.',
  mls_message_fetch: 'Fetch opaque MLS messages using groupId, a since cursor and a bounded limit.',
  artifact_blob_put: 'Store encrypted artifact bytes using groupId, artifactId, version and base64 data.',
  artifact_blob_get: 'Fetch encrypted artifact bytes using groupId, artifactId and version.',
  artifact_blob_delete: 'Delete encrypted artifact bytes using groupId and artifactId.',
};
export const relayNote = 'Relay data is opaque base64; artifact metadata tools never accept plaintext content. Personal group IDs are personal_<personId>.';
export type ToolName = keyof typeof inputs;
export type Command = { [K in ToolName]: { tool: K; input: z.output<(typeof inputs)[K]> } }[ToolName];
export const TOOL_NAMES = Object.keys(inputs) as ToolName[];
export function parseCommand(tool: string, input: unknown): Command {
  if (!Object.hasOwn(inputs, tool)) throw new Error('Unknown coordination tool');
  const name = tool as ToolName;
  // The discriminant and corresponding validated input are kept together here.
  return { tool: name, input: inputs[name].parse(input) } as Command;
}
export class Refused extends Error {}
export type ToolData = Record<string, unknown>;
export type TaskMethod = 'get' | 'update' | 'cancel';
export interface CoordinationBackend {
  execute(subject: string, command: Command): Promise<ToolData>;
  inbox?(subject: string, journeyId: string): Promise<ToolData>;
  watchInbox?(subject: string, journeyId: string): Promise<ReadableStream<Uint8Array>>;
  task?(subject: string, method: TaskMethod, taskId: string): Promise<ToolData>;
}
