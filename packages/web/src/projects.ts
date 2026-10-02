import { PROJECT_FORMAT, newId, projectPurposeHash, replayProject, sealProjectPayload, signControlProof, verifyControlProofs } from '@ai-wayfinding/core';
import type { ArtifactState, JsonObject, Member, Project, ProjectActionType, ProjectState } from '@ai-wayfinding/core';
import { api, currentKey, verifiedJourney } from './journey.js';
import type { JourneyContext } from './journey.js';

/** Availability and signed replay use the same production Bend decisions as commit. */
export function canCreateProject(ctx: JourneyContext): boolean {
  return replayProject(ctx.state, 'project.create', { format: PROJECT_FORMAT, project: newId(), state: 'getting-started' }, ctx.principal).transition.$ === 'ProjectAccepted';
}
export function participationBody(ctx: JourneyContext, project: string): JsonObject {
  const pair = ctx.state.projects?.participation.find(p => p.project === project && p.member === ctx.principal);
  return { format: PROJECT_FORMAT, project, member: ctx.principal, predecessor: pair?.revision ?? null };
}
export function canParticipate(ctx: JourneyContext, type: 'project.join' | 'project.leave', project: string): boolean {
  return replayProject(ctx.state, type, participationBody(ctx, project), ctx.principal).transition.$ === 'ProjectAccepted';
}
async function commit(ctx: JourneyContext, type: ProjectActionType, body: JsonObject, payload: JsonObject = {}): Promise<void> {
  // Refresh the chain and live authority, never the caller's observed predecessor.
  const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys), key = currentKey(latest);
  const at = new Date().toISOString(), seq = latest.state.lastSeq + 1;
  const envelope = await sealProjectPayload(type, body, payload, { id: newId(), journey: ctx.id, seq, epoch: key.epoch, createdAt: at }, key);
  const proof = await signControlProof({ v: 1, seq, prev: latest.state.lastHash, at, actor: ctx.principal, type, body }, envelope, ctx.id, ctx.keys.signingPrivateKey);
  const controls = [...latest.controls, { proof, envelope }];
  const checked = await verifyControlProofs(controls.map(c => c.proof), controls.map(c => c.envelope), { journey: ctx.id, creator: controls[0]!.proof.body.creator as Member }, [...latest.epochs.values()]);
  if (!checked.ok) throw new Error(checked.error.message === 'Project predecessor, state or placement conflict; refresh' ? 'Something changed while you were working. Reload and try again.' : checked.error.message);
  await api(`/journeys/${ctx.id}/log`, 'POST', { control: { proof, envelope } }, ctx.principal);
}
export async function createProject(ctx: JourneyContext, purpose: string): Promise<string> {
  const project = newId();
  await commit(ctx, 'project.create', { format: PROJECT_FORMAT, project, purposeHash: await projectPurposeHash(purpose), state: 'getting-started' }, { purpose });
  return project;
}
export async function purposeProject(ctx: JourneyContext, project: Project, purpose: string): Promise<void> {
  await commit(ctx, 'project.purpose', { format: PROJECT_FORMAT, project: project.id, purposeHash: await projectPurposeHash(purpose), predecessor: project.revision }, { purpose });
}
export async function stateProject(ctx: JourneyContext, project: Project, state: ProjectState): Promise<void> {
  await commit(ctx, 'project.state', { format: PROJECT_FORMAT, project: project.id, state, predecessor: project.revision });
}
export async function participateProject(ctx: JourneyContext, type: 'project.join' | 'project.leave', project: string): Promise<void> {
  await commit(ctx, type, participationBody(ctx, project));
}
export async function placeArtifact(ctx: JourneyContext, artifact: ArtifactState, project: string | null): Promise<void> {
  await commit(ctx, 'artifact.project', { format: PROJECT_FORMAT, project, artifact: artifact.id, author: artifact.author, actor: ctx.principal, predecessor: ctx.state.projects?.placements[artifact.id]?.revision ?? null });
}
