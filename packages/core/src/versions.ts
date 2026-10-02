import rules from '@ai-wayfinding/rules';
import type { Version } from '@ai-wayfinding/rules';
export const PROTOCOL_VERSION = 1 as const;
export const CLIENT_VERSION = '0.1.7' as const;
export const CONTROL_FORMAT = 'control-proof-v1' as const;
export const ARTIFACT_CLIENT_VERSION = '0.1.5' as const;
export const CLIENT_CAPABILITIES = [CONTROL_FORMAT, 'artifact-v1', 'project-v1', 'private-v1'] as const;
export function supportsArtifacts(client: string, minimum: string, capabilities: readonly string[]): boolean {
  try { return rules.artifact_client(ruleVersion(client), ruleVersion(minimum), capabilities.includes(CONTROL_FORMAT), capabilities.includes('artifact-v1')); } catch { return false; }
}
function parts(value: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Invalid client version');
  const numbers = value.split('.').map(Number);
  if (numbers.some(n => !Number.isSafeInteger(n))) throw new Error('Invalid client version');
  return numbers;
}
export function ruleVersion(value: string): Version {
  const [major, minor, patch] = parts(value);
  return { $: 'Version', major: BigInt(major!), minor: BigInt(minor!), patch: BigInt(patch!) };
}
export function meetsMinClientVersion(client: string, minimum: string): boolean {
  return rules.version_ge(ruleVersion(client), ruleVersion(minimum));
}

export const PRIVATE_CLIENT_VERSION = '0.1.7' as const;
export function supportsPrivate(client: string, minimum: string, capabilities: readonly string[]): boolean {
  try { return rules.private_client(ruleVersion(client), ruleVersion(minimum), capabilities.includes(CONTROL_FORMAT), capabilities.includes('artifact-v1'), capabilities.includes('project-v1'), capabilities.includes('private-v1')); } catch { return false; }
}
export const PROJECT_CLIENT_VERSION = '0.1.6' as const;
export function supportsProjects(client: string, minimum: string, capabilities: readonly string[]): boolean {
  try { return rules.project_client(ruleVersion(client), ruleVersion(minimum), capabilities.includes(CONTROL_FORMAT), capabilities.includes('artifact-v1'), capabilities.includes('project-v1')); } catch { return false; }
}
