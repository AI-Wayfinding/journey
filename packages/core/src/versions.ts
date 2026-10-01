import rules from '@ai-wayfinding/rules';
import type { Version } from '@ai-wayfinding/rules';
export const PROTOCOL_VERSION = 1 as const;
export const CLIENT_VERSION = '0.1.4' as const;
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
