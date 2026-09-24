const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = -1;
let lastRandom = 0n;
const maxRandom = (1n << 80n) - 1n;
function base32(value: bigint, length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) { result = alphabet[Number(value & 31n)] + result; value >>= 5n; }
  return result;
}
export function newId(): string {
  const now = Date.now();
  if (now > lastTime || lastRandom === maxRandom) {
    lastTime = Math.max(now, lastTime + (lastRandom === maxRandom ? 1 : 0));
    lastRandom = crypto.getRandomValues(new BigUint64Array(2)).reduce((v, part) => (v << 64n) | part, 0n) & maxRandom;
  } else lastRandom++;
  return base32(BigInt(lastTime), 10) + base32(lastRandom, 16);
}
export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}
