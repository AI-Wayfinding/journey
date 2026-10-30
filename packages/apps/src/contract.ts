import * as z from 'zod';

export const viewKinds = ['journey', 'project', 'artifacts'] as const;
export type ViewKind = (typeof viewKinds)[number];
const id = z.string().min(1).max(200);
const name = z.string().max(4096);
const nat = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const member = z.object({ memberId: id, kind: z.enum(['person', 'agent']), role: z.enum(['read', 'write']), guide: z.boolean(), owner: id.optional() });
const project = z.object({ projectId: id, name, purpose: name, status: z.enum(['gettingStarted', 'active', 'lookingForOthers', 'archived']), members: z.array(id) });
const agent = z.object({ agentId: id, owner: id, signed: z.boolean(), read: z.boolean(), write: z.boolean(), grant: z.boolean() });
const pending = z.object({ personId: id, status: z.enum(['invited', 'requested']) });
// A UI output boundary, not stored state. Unknown fields are stripped at every
// level: artifact content, storage locations and access URLs cannot cross it.
const artifact = z.object({ artifactId: id, name, size: nat, version: nat });
export const journeyView = z.object({ view: z.literal('journey'), journeyId: id, name,
  policy: z.enum(['request', 'open', 'invite']), defaultRole: z.enum(['read', 'write']),
  members: z.array(member), agents: z.array(agent), projects: z.array(project), pending: z.array(pending) });
export const projectView = z.object({ view: z.literal('project'), journeyId: id, project });
export const artifactsView = z.object({ view: z.literal('artifacts'), journeyId: id, artifacts: z.array(artifact) });
export const viewData = z.discriminatedUnion('view', [journeyView, projectView, artifactsView]);
export type ViewData = z.output<typeof viewData>;
export const SIGNIN_URL = 'https://poc.wayfinding.support/signin';
export const refreshTools: Record<ViewKind, string> = {
  journey: 'apps_journey_refresh', project: 'apps_project_refresh', artifacts: 'apps_artifacts_refresh',
};
