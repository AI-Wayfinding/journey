import { isId, PROJECT_STATES, validProjectPurpose } from '@ai-wayfinding/core';
import type { Project, ProjectState, ProjectParticipation } from '@ai-wayfinding/core';

export interface ProjectView extends Project { participants: string[]; participation: ProjectParticipation[] }
/** Format checks only; production Bend decides authority and predecessor freshness. */
export function projectId(value: unknown): string {
  if (!isId(value)) throw new Error('Give a project ULID.');
  return value;
}
export function observedRevision(value: unknown): number | null {
  if (value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error('Supply the observed predecessor sequence, or null for an unassigned artifact.');
}
export function purposeText(value: unknown): string {
  if (typeof value !== 'string' || !validProjectPurpose(value.trim())) throw new Error('Project purpose must be nonempty text of at most 10,000 UTF-8 bytes.');
  return value.trim();
}
export function stateValue(value: unknown): ProjectState {
  if (typeof value !== 'string' || !(PROJECT_STATES as readonly string[]).includes(value)) throw new Error('Use getting-started, active, looking-for-others or archived.');
  return value as ProjectState;
}
