import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryBackend} from '../src/backend.ts';
import {testPasskeys} from './helpers.ts';
import {installTestAccountIdentity} from './account-fixture.ts';
import {authenticator} from './console-authenticator.ts';
import {generateSigningKey,signIdentityEvent} from '../../shared/account-identity.ts';

async function fixture(events:number,live:boolean){
 let now=Date.now();
 const backend=new MemoryBackend({async get(){return {name:'Alice',email:'alice@example.test'}}},()=>now,testPasskeys,true);
 const signed=await installTestAccountIdentity(backend,'alice','trusted-host',now),root=await generateSigningKey(),certificate=await signed.connect(root);
 const state=JSON.parse(String(await backend.accountStorage.get('accounts'))),account=state.accounts[0];
 account.onboarding={complete:true};account.identityEvents=Array.from({length:events},()=>account.identityEvents[0]);
 account.connections=Array.from({length:127},(_,i)=>({claim:{personId:signed.account.personId,connectionId:`historical-${i}`,verificationKey:root.publicKey,generation:0,accountPublicKey:signed.key.publicKey},createdAt:now-1000,revokedAt:now-1}));
 account.connections.push({claim:{personId:certificate.personId,connectionId:certificate.connectionId,verificationKey:certificate.verificationKey,generation:0,accountPublicKey:certificate.accountPublicKey},certificate,createdAt:now-1000,...(live?{}:{revokedAt:now-1})});
 await backend.accountStorage.put('accounts',JSON.stringify(state));
 return {backend,signed,identity:{subject:'alice',clientId:'trusted-host',signedInAt:now},advance(){now+=259200000;return now;}};
}

for(const live of [false,true])test(`recovery compacts 128 historical roots and reserves the first new key and connection (live=${live})`,async()=>{
 const f=await fixture(live?4093:4094,live);
 const started=await f.backend.passkey(f.identity,{op:'recovery_start'});assert.equal(started.readyAt,f.identity.signedInAt+259200000);
 let state=JSON.parse(String(await f.backend.accountStorage.get('accounts'))),account=state.accounts[0];
 assert.deepEqual(account.connections,[]);assert.equal(account.identityEvents.length,4094);assert.equal(account.passkeys.length,0);
 const signedInAt=f.advance(),identity={...f.identity,signedInAt},passkey=await authenticator(),options=await f.backend.passkey(identity,{op:'begin'});
 await f.backend.passkey(identity,{op:'finish',credential:passkey.register(String(options.challenge))});
 const next=await installTestAccountIdentity(f.backend,'alice','trusted-host',signedInAt);assert.notEqual(next.key.publicKey,f.signed.key.publicKey);
 const device=await next.device({deviceId:`device_${crypto.randomUUID()}`,data:btoa('fresh package')});
 await f.backend.sealedExecute('alice','sealed_device_register',device.registration);
 state=JSON.parse(String(await f.backend.accountStorage.get('accounts')));account=state.accounts[0];
 assert.equal(account.identityEvents.length,4096);assert.equal(account.connections.length,1);assert.equal(account.connections[0].claim.generation,1);
 const before=f.backend.snapshot();await assert.rejects(f.backend.passkey(identity,{op:'connection_remove',connectionId:device.credential.connectionId,event:await signIdentityEvent(next.key.privateKey,{personId:next.account.personId,generation:1,accountPublicKey:next.key.publicKey,connectionId:device.credential.connectionId,action:'connection-removed',at:signedInAt})}),{message:'Account identity log capacity reached'});assert.equal(f.backend.snapshot(),before);
 assert.equal(JSON.parse(String(await f.backend.accountStorage.get('accounts'))).accounts[0].identityEvents.length,4096);
});

for(const [events,live] of [[4096,false],[4095,true],[4096,true]] as const)test(`recovery refuses before destructive changes when its journal cannot fit (${events},live=${live})`,async()=>{
 const f=await fixture(events,live),before=f.backend.snapshot();
 await assert.rejects(f.backend.passkey(f.identity,{op:'recovery_start'}),{message:'Account identity log capacity reached; recovery was not started'});
 assert.equal(f.backend.snapshot(),before);
 const account=JSON.parse(String(await f.backend.accountStorage.get('accounts'))).accounts[0];assert.equal(account.identityEvents.length,events);assert.equal(account.passkeys.length,1);assert.equal(account.onboarding.complete,true);assert.equal(account.recovery?.readyAt,undefined);
});
