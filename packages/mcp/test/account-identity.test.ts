import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryBackend} from '../src/backend.ts';
import {testPasskeys} from './helpers.ts';
import {generateSigningKey,signIdentityEvent,signConnection,connectionClaim,signValue,signPackage} from '../../shared/account-identity.ts';
import {browserPost} from '../src/console/browser-api.ts';

test('legacy unsigned device bindings return an explicit connection refusal',async()=>{
 const {backend,account}=await fixture(),deviceId=`device_${crypto.randomUUID()}`,root=await generateSigningKey();
 await backend.accountStorage.put(`sealed:device:${deviceId}`,JSON.stringify({deviceId,personId:account.personId,verificationKey:root.publicKey,data:btoa('legacy package'),hash:'legacy',createdAt:1}));
 await assert.rejects(backend.accountsHost.deviceBinding(deviceId),{message:'Unsigned connection refused'});
});
async function fixture(){
 const backend=new MemoryBackend({async get(){return {name:'Alice',email:'alice@example.test'}}},Date.now,testPasskeys,true),account=await backend.accountsHost.provision('alice');
 const state=JSON.parse(String(await backend.accountStorage.get('accounts')));state.accounts[0].passkeys=[{id:'test',publicKey:'AA==',counter:0,transports:[]}];await backend.accountStorage.put('accounts',JSON.stringify(state));
 const key=await generateSigningKey(),identity={subject:'alice',clientId:'trusted-host',signedInAt:Date.now()},event=await signIdentityEvent(key.privateKey,{personId:account.personId,accountPublicKey:key.publicKey,generation:0,action:'account-key-set',at:Date.now()});
 const record={identity:{publicKey:key.publicKey,generation:0},recoveryWrap:{format:'wayfinding-browser-vault-1' as const,iv:'AA==',ciphertext:'AA=='}};
 await backend.passkey(identity,{op:'identity_set',record,event});return {backend,account,key,identity,record};
}
test('account identity requires an account signature before any connection or MLS package is usable',async()=>{
 const {backend,account,key,identity}=await fixture(),root=await generateSigningKey();
 const claim={personId:account.personId,connectionId:'connection-test',verificationKey:root.publicKey,generation:0,accountPublicKey:key.publicKey};
 const request={claim,proof:await signValue(root.privateKey,'wayfinding-connection-request-1',connectionClaim(claim))};
 assert.equal((await backend.sealedExecute('alice','sealed_connection_request',request)).pending,true);
 const certificate=await signConnection(key.privateKey,claim),event=await signIdentityEvent(key.privateKey,{personId:account.personId,generation:0,accountPublicKey:key.publicKey,connectionId:claim.connectionId,action:'connection-added',at:Date.now()});
 await backend.passkey(identity,{op:'connection_approve',certificate,event});
 const data={deviceId:'device_00000000-0000-4000-8000-000000000001',verificationKey:root.publicKey,data:btoa('MLS PACKAGE'),credential:certificate};
 const signed={...data,packageSignature:await signPackage(root.privateKey,data)};
 await assert.rejects(backend.sealedExecute('alice','sealed_device_register',{...signed,data:btoa('SUBSTITUTION')}));
 const binding=await backend.sealedExecute('alice','sealed_device_register',signed);assert.equal(binding.personId,account.personId);
 await backend.passkey(identity,{op:'connection_remove',connectionId:claim.connectionId,event:await signIdentityEvent(key.privateKey,{personId:account.personId,generation:0,accountPublicKey:key.publicKey,connectionId:claim.connectionId,action:'connection-removed',at:Date.now()})});
 await assert.rejects(backend.accountsHost.deviceBinding(String(binding.deviceId)),/revoked|connection/i);
 const replacement=await generateSigningKey();await assert.rejects(backend.passkey(identity,{op:'identity_set',record:{identity:{publicKey:replacement.publicKey,generation:0},recoveryWrap:{format:'wayfinding-browser-vault-1',iv:'AA==',ciphertext:'AA=='}},event:await signIdentityEvent(replacement.privateKey,{personId:account.personId,generation:0,accountPublicKey:replacement.publicKey,action:'account-key-set',at:Date.now()})}),/already|identity|key/i);
});

test('journey journal retains events through departure without disclosing later connection changes',async()=>{
 const {backend,account,key,identity}=await fixture();
 const initial=await backend.accountsHost.publishedDescriptors('journey-test',[account.personId]);assert.equal((initial.identityLog as unknown[]).length,1);
 const root=await generateSigningKey(),claim={personId:account.personId,connectionId:'departing-connection',verificationKey:root.publicKey,generation:0,accountPublicKey:key.publicKey};
 await backend.sealedExecute('alice','sealed_connection_request',{claim,proof:await signValue(root.privateKey,'wayfinding-connection-request-1',connectionClaim(claim))});
 const certificate=await signConnection(key.privateKey,claim),added=await signIdentityEvent(key.privateKey,{personId:account.personId,generation:0,accountPublicKey:key.publicKey,connectionId:claim.connectionId,action:'connection-added',at:Date.now()});
 await backend.passkey(identity,{op:'connection_approve',certificate,event:added});
 const departed=await backend.accountsHost.publishedDescriptors('journey-test',[]);assert.deepEqual(departed.identityLog,[...(initial.identityLog as unknown[]),added]);
 await backend.passkey(identity,{op:'connection_remove',connectionId:claim.connectionId,event:await signIdentityEvent(key.privateKey,{personId:account.personId,generation:0,accountPublicKey:key.publicKey,connectionId:claim.connectionId,action:'connection-removed',at:Date.now()})});
 const later=await backend.accountsHost.publishedDescriptors('journey-test',[]);assert.deepEqual(later.identityLog,departed.identityLog);
});

test('no-code recovery cannot retain the old safety number by reusing its account key',async()=>{
 const {backend,account,key,identity,record}=await fixture(),state=JSON.parse(String(await backend.accountStorage.get('accounts')));
 // State at the fresh first-passkey setup after the recovery cooldown.
 state.accounts[0].recovery={generation:1,startedAt:1,readyAt:2,recoveredAt:3};state.accounts[0].onboarding={complete:false};await backend.accountStorage.put('accounts',JSON.stringify(state));
 const body={personId:account.personId,generation:1,accountPublicKey:key.publicKey,previousPublicKey:key.publicKey,action:'account-key-set' as const,at:Date.now()};
 await assert.rejects(backend.passkey(identity,{op:'identity_set',record:{...record,identity:{publicKey:key.publicKey,generation:1}},event:await signIdentityEvent(key.privateKey,body)}),/different.*key|new.*key/i);
 const replacement=await generateSigningKey(),event=await signIdentityEvent(replacement.privateKey,{...body,accountPublicKey:replacement.publicKey});
 const changed=await backend.passkey(identity,{op:'identity_set',record:{...record,identity:{publicKey:replacement.publicKey,generation:1}},event});assert.equal((changed.accountKey as typeof record).identity.publicKey,replacement.publicKey);
});

test('console revocation succeeds for two MLS leaves sharing one account-signed browser connection',async()=>{
 const {backend,account,key,identity}=await fixture(),root=await generateSigningKey(),connectionId='multi-leaf-browser';
 const claim={personId:account.personId,connectionId,verificationKey:root.publicKey,generation:0,accountPublicKey:key.publicKey},certificate=await signConnection(key.privateKey,claim);
 await backend.sealedExecute('alice','sealed_connection_request',{claim,proof:await signValue(root.privateKey,'wayfinding-connection-request-1',connectionClaim(claim)),certificate,event:await signIdentityEvent(key.privateKey,{personId:account.personId,generation:0,accountPublicKey:key.publicKey,connectionId,action:'connection-added',at:Date.now()})});
 const devices=[`device_${crypto.randomUUID()}`,`device_${crypto.randomUUID()}`];for(const deviceId of devices){const registration={deviceId,verificationKey:root.publicKey,data:btoa(deviceId),credential:certificate};await backend.sealedExecute('alice','sealed_device_register',{...registration,packageSignature:await signPackage(root.privateKey,registration)});}
 const browserId=crypto.randomUUID(),state=JSON.parse(String(await backend.accountStorage.get('accounts')));state.accounts[0].onboarding={complete:true};state.accounts[0].browsers=[{id:browserId,credentialId:'test',devices}];await backend.accountStorage.put('accounts',JSON.stringify(state));
 const result=await browserPost(backend,identity,'/console/device/revoke',{csrf:'test',browserId});assert.equal(result.revoked,true);assert.equal(result.revocation,'complete');
 const listed=await backend.passkey(identity,{op:'browser_list'});assert.equal((listed.browsers as Array<{live:boolean}>)[0]!.live,false);for(const deviceId of devices)await assert.rejects(backend.accountsHost.deviceBinding(deviceId),/revoked|connection/i);
});

for(const storedAlias of [false,true])test(`no-code recovery compares actual public-key bytes, including base64 aliases (storedAlias=${storedAlias})`,async()=>{
 const {backend,account,key,identity,record}=await fixture(),alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',alias=key.publicKey.slice(0,-2)+alphabet[alphabet.indexOf(key.publicKey.at(-2)!)|1]+'=';
 assert.deepEqual(Buffer.from(alias,'base64'),Buffer.from(key.publicKey,'base64'));
 const state=JSON.parse(String(await backend.accountStorage.get('accounts')));state.accounts[0].recovery={generation:1,readyAt:2};state.accounts[0].onboarding={complete:false};if(storedAlias)state.accounts[0].accountKey.identity.publicKey=alias;await backend.accountStorage.put('accounts',JSON.stringify(state));
 const publicKey=storedAlias?key.publicKey:alias,previousPublicKey=storedAlias?alias:key.publicKey,body={personId:account.personId,generation:1,accountPublicKey:publicKey,action:'account-key-set' as const,previousPublicKey,at:Date.now()};
 const event={...body,signature:await signValue(key.privateKey,'wayfinding-identity-event-1',body)},before=backend.snapshot();
 await assert.rejects(backend.passkey(identity,{op:'identity_set',record:{...record,identity:{publicKey,generation:1}},event}),/different.*key|canonical/i);assert.equal(backend.snapshot(),before);
});
