import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateSigningKey,signConnection,signPackage,verifyDeviceBinding,safetyNumber,signIdentityEvent,verifyIdentityEvent} from '../../shared/account-identity.ts';

test('account identity refuses substituted packages, credentials, owners and unsigned bindings',async()=>{
 const account=await generateSigningKey(),device=await generateSigningKey(),other=await generateSigningKey();
 const claim={personId:'person-alice',connectionId:'connection-one',verificationKey:device.publicKey,generation:0,accountPublicKey:account.publicKey};
 const credential=await signConnection(account.privateKey,claim);
 const body={deviceId:'device-one',personId:claim.personId,verificationKey:device.publicKey,data:btoa('original MLS package'),credential};
 const binding={...body,packageSignature:await signPackage(device.privateKey,body),hash:'metadata',createdAt:1};
 await verifyDeviceBinding(binding);
 for(const patch of [{data:btoa('substituted MLS package')},{personId:'person-bob'},{deviceId:'device-two'},{agentId:'agent-other'},{verificationKey:other.publicKey},{credential:{...credential,accountPublicKey:other.publicKey}},{credential:undefined},{packageSignature:undefined}])await assert.rejects(verifyDeviceBinding({...binding,...patch}));
 assert.match(await safetyNumber(account.publicKey),/^(?:\d{5} ){5}\d{5}$/);
 assert.notEqual(await safetyNumber(account.publicKey),await safetyNumber(other.publicKey));
});
test('identity log signatures bind event kind, member, connection, generation and previous key',async()=>{
 const key=await generateSigningKey(),event=await signIdentityEvent(key.privateKey,{personId:'alice',generation:1,accountPublicKey:key.publicKey,action:'account-key-set',at:100,previousPublicKey:'old'});
 assert.equal(await verifyIdentityEvent(event),true);
 for(const patch of [{personId:'bob'},{generation:2},{previousPublicKey:'other'},{action:'connection-removed'},{at:101}])assert.equal(await verifyIdentityEvent({...event,...patch}),false);
 assert.equal(await verifyIdentityEvent({...event,signature:undefined}),false);
});
