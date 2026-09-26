import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { prfOutput } from './prf.js';

it('reads a cross-realm ArrayBuffer directly instead of requesting a second passkey tap', () => {
  const foreign = runInNewContext('new Uint8Array(Array.from({length:32}, (_, i) => i + 1)).buffer') as ArrayBuffer;
  expect(foreign instanceof ArrayBuffer).toBe(false);
  expect(prfOutput(foreign)).toEqual(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
  expect(new Uint8Array(foreign)).toEqual(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
  expect(prfOutput(new Uint8Array(32).fill(7).subarray(0))).toEqual(new Uint8Array(32).fill(7));
  expect(prfOutput(undefined)).toBeNull();
});
