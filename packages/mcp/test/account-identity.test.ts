import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryBackend} from '../src/backend.ts';
import {testPasskeys} from './helpers.ts';
import {generateSigningKey,signIdentityEvent,signConnection,connectionClaim,signValue,signPackage} from '../../shared/account-identity.ts';

async function fixture(){
 const backend=new MemoryBackend({async get(){return {name:'Alice',email:'alice@example.test'}}},Date.now,testPasskeys,true),account=await backend.accountsHost.provision('alice');
 const state=JSON.parse(String(await backend.accountStorage.get('accounts')));state.accounts[0].passkeys=[{id:'test',publicKey:'AA==',counter:0,transports:[]}];await backend.accountStorage.put('accounts',JSON.stringify(state));
 const key=await generateSigningKey(),identity={subject:'alice',clientId:'trusted-host'},event=await signIdentityEvent(key.privateKey,{personId:account.personId,accountPublicKey:key.publicKey,generation:0,action:'account-key-set',at:Date.now()});
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
