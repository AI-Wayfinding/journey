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

// Strict, named inputs: callers cannot supply authority flags, profile fields or content.
export const inputs = {
  account_read: z.object({}).strict(),
  journey_create: z.object({ name: text, policy: policy.default('request'), defaultRole: role.default('read') }).strict(),
  journey_list: z.object({}).strict(),
  journey_read: z.object(context).strict(),
  journey_policy: z.object({ ...context, policy, defaultRole: role }).strict(),
  journey_invite: z.object(target).strict(),
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
} as const;

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
  inbox(subject: string, journeyId: string): Promise<ToolData>;
  watchInbox(subject: string, journeyId: string): Promise<ReadableStream<Uint8Array>>;
  task(subject: string, method: TaskMethod, taskId: string): Promise<ToolData>;
}
