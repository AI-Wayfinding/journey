import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePrfKey, deriveRecoveryKey, recoveryCode, wrap, unwrap } from '../src/vault.ts';
const context = { origin: 'https://poc.wayfinding.support', personId: 'person-alice', deviceId: 'browser-one' };
test('browser vault PRF derivation is domain separated and keys are nonextractable', async () => {
  const prf = new Uint8Array(32).fill(13), salt = new Uint8Array(32).fill(42);
  const key = await derivePrfKey(prf, salt, context);
  assert.equal(key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', key));
  const sealed = await wrap('SECRET-DEVICE-RATCHET', key, context);
  assert.equal(await unwrap(sealed, await derivePrfKey(prf, salt, context), context), 'SECRET-DEVICE-RATCHET');
  for (const other of [{ ...context, origin: 'https://evil.test' }, { ...context, personId: 'person-bob' }, { ...context, deviceId: 'browser-two' }]) {
    await assert.rejects(unwrap(sealed, await derivePrfKey(prf, salt, other), other));
  }
  await assert.rejects(derivePrfKey(new Uint8Array(31), salt, context));
});
test('browser vault recovery wrap rejects wrong code, tampering and changed context', async () => {
  const code = recoveryCode(), salt = new Uint8Array(32).fill(23);
  assert.match(code, /^(?:[A-F0-9]{8}-){7}[A-F0-9]{8}$/);
  const key = await deriveRecoveryKey(code, salt, context), sealed = await wrap('PRIVATE-KEY-AND-CACHE', key, context);
  assert.equal(await unwrap(sealed, await deriveRecoveryKey(code.toLowerCase(), salt, context), context), 'PRIVATE-KEY-AND-CACHE');
  await assert.rejects(unwrap(sealed, await deriveRecoveryKey(recoveryCode(), salt, context), context));
  await assert.rejects(unwrap({ ...sealed, ciphertext: 'AAAA' }, key, context));
  await assert.rejects(unwrap(sealed, key, { ...context, personId: 'person-bob' }));
  assert.equal(JSON.stringify(sealed).includes('PRIVATE-KEY'), false);
});
