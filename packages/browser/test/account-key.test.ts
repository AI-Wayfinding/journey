import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateSigningKey,signConnection,verifyConnection,verifyIdentityEvent,type AccountKeyRecord} from '../../shared/account-identity.ts';
import {BrowserAccountKey,recoverAccountKey,sealAccountKey} from '../src/account-key.ts';
import {recoveryCode} from '../src/vault.ts';
test('account key recovery preserves the signing identity across browsers and rejects server substitution',async()=>{
 const key=await generateSigningKey(),code=recoveryCode(),origin='https://poc.wayfinding.support',personId='alice';
 const record:AccountKeyRecord={identity:{publicKey:key.publicKey,generation:0},recoveryWrap:await sealAccountKey(key,code,origin,personId)};
 const recovered=await recoverAccountKey(record,code,origin,personId);
 assert.deepEqual(recovered,key);
 const cert=await signConnection(recovered.privateKey,{personId,connectionId:'second-browser',verificationKey:key.publicKey,generation:0,accountPublicKey:key.publicKey});assert.equal((await verifyConnection(cert)).personId,personId);
 await assert.rejects(recoverAccountKey(record,recoveryCode(),origin,personId));
 await assert.rejects(recoverAccountKey(record,code,origin,'bob'));
 const other=await generateSigningKey();await assert.rejects(recoverAccountKey({...record,identity:{publicKey:other.publicKey,generation:0}},code,origin,personId),/mismatch/);
 assert.equal(JSON.stringify(record).includes(key.privateKey),false);
});

test('trusted browser onboarding, additional approval and both recovery paths preserve the account-key boundary',async()=>{
 const origin='https://poc.wayfinding.support',personId='alice',code=recoveryCode();let generation=0,record:AccountKeyRecord|undefined,previousPublicKey:string|undefined;
 const post=async(_path:string,body:Record<string,unknown>):Promise<Record<string,unknown>>=>{
  if(body.op==='identity_read')return {generation,accountKey:record};
  assert.equal(body.op,'identity_set');assert.equal(await verifyIdentityEvent(body.event as never),true);previousPublicKey=(body.event as {previousPublicKey?:string}).previousPublicKey;record=body.record as AccountKeyRecord;return {accountKey:record};
 };
 const memory=()=>{const values=new Map<string,string>();return {values,async read(name:string){return values.get(name)},async write(name:string,value:string){values.set(name,value)}}};
 const firstStore=memory(),first=await BrowserAccountKey.open(firstStore,post,personId,origin,code);assert.equal(first.canSign,true);const original=first.publicKey;assert.ok(firstStore.values.has('account-key'));assert.equal(record!.identity.publicKey,original);
 const freshStore=memory(),pending=await BrowserAccountKey.open(freshStore,post,personId,origin);assert.equal(pending.canSign,false);assert.equal(freshStore.values.has('account-key'),false);
 const claim={personId,connectionId:'fresh-browser',generation,accountPublicKey:original,verificationKey:(await generateSigningKey()).publicKey};
 await assert.rejects(pending.endorse(claim),/trusted browser|recovery code/i);assert.equal((await verifyConnection(await first.endorse(claim))).connectionId,'fresh-browser');
 const recovered=await BrowserAccountKey.open(memory(),post,personId,origin,code);assert.equal(recovered.publicKey,original);assert.equal(recovered.canSign,true);assert.equal((await verifyConnection(await recovered.endorse(claim))).accountPublicKey,original);
 generation=1;const replacement=await BrowserAccountKey.open(memory(),post,personId,origin,recoveryCode());assert.notEqual(replacement.publicKey,original);assert.equal(replacement.generation,1);assert.equal(previousPublicKey,original);
 await assert.rejects(BrowserAccountKey.open(firstStore,post,personId,origin),/safety number changed/i);
});
