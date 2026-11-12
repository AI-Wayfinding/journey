import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePrfKey, deriveRecoveryKey, recoveryCode, wrap, unwrap } from '../src/vault.ts';
import { authenticator } from '../../mcp/test/console-authenticator.ts';
async function confirmation(){const key=await authenticator();return async(options:Record<string,unknown>)=>({assertion:await key.assert(String(options.challenge)),prf:undefined});}
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

test('account recovery is stable across browsers, origin/account bound and not an account-key oracle',async()=>{
 const {recoveryAuthorization,recoveryAccountWrappingKey}=await import('../src/vault.ts');
 const code=recoveryCode(),proof=await recoveryAuthorization(code,context.origin,context.personId);
 assert.match(proof,/^[A-Za-z0-9_-]{43}$/);
 assert.equal(proof,await recoveryAuthorization(code.toLowerCase().replaceAll('-',' '),context.origin,context.personId));
 assert.notEqual(proof,await recoveryAuthorization(code,'https://other.test',context.personId));
 assert.notEqual(proof,await recoveryAuthorization(code,context.origin,'other-person'));
 const key=await recoveryAccountWrappingKey(code,context.origin,context.personId);assert.equal(key.extractable,false);
 const sealed=await wrap('FUTURE-ACCOUNT-KEY',key,context);
 assert.equal(await unwrap(sealed,await recoveryAccountWrappingKey(code,context.origin,context.personId),context),'FUTURE-ACCOUNT-KEY');
 const verifierKey=await crypto.subtle.importKey('raw',Buffer.from(proof,'base64url'),'AES-GCM',false,['decrypt']);
 await assert.rejects(unwrap(sealed,verifierKey,context));
 await assert.rejects(crypto.subtle.exportKey('raw',key));
});
test('onboarding confirmation rejects missing/wrong saved code before any server call',async()=>{
 const {finishOnboarding}=await import('../src/onboarding.ts');let calls=0;const code=recoveryCode();
 const confirm=await confirmation();
 const post=async(path:string,body:Record<string,unknown>)=>{calls++;assert.equal(path,calls===1?'/console/setup/options':'/console/setup/complete');assert.equal(body.browserId,'browser-one');assert.equal(JSON.stringify(body).includes(code),false);return {challenge:'a'.repeat(43)};};
 const input={code,confirmation:'',browserId:'browser-one',origin:context.origin,personId:context.personId};
 await assert.rejects(finishOnboarding(post,input),/Retype/);await assert.rejects(finishOnboarding(post,{...input,confirmation:recoveryCode()}),/Retype/);assert.equal(calls,0);
 await finishOnboarding(post,{...input,confirmation:code.toLowerCase()},undefined,confirm);assert.equal(calls,2);
});

test('resumed onboarding must confirm the code that actually unlocks its existing vault',async()=>{
 const {finishOnboarding}=await import('../src/onboarding.ts');const {encode}=await import('../../proxy/src/codec.ts');
 const code=recoveryCode(),wrong=recoveryCode(),salt=new Uint8Array(32).fill(25);
 const record={context,salt:encode(salt),recoveryWrap:await wrap(encode(new Uint8Array(32).fill(7)),await deriveRecoveryKey(code,salt,context),context)};
 let calls=0;const post=async()=>{calls++;return {challenge:'a'.repeat(43)};},confirm=await confirmation();
 const input={code:wrong,confirmation:wrong,browserId:context.deviceId,origin:context.origin,personId:context.personId};
 await assert.rejects(finishOnboarding(post,input,record));assert.equal(calls,0);
 await finishOnboarding(post,{...input,code,confirmation:code},record,confirm);assert.equal(calls,2);
});
