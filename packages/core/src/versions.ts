export const PROTOCOL_VERSION = 1 as const;
export const CLIENT_VERSION = '0.1.0' as const;
function parts(value: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Invalid client version');
  const numbers = value.split('.').map(Number);
  if (numbers.some(n => !Number.isSafeInteger(n))) throw new Error('Invalid client version');
  return numbers;
}
export function meetsMinClientVersion(client: string, minimum: string): boolean {
  const a = parts(client), b = parts(minimum);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}
