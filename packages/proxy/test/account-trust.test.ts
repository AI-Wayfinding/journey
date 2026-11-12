import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SealedClient,ConnectionPendingError,type SealedRemote} from '../src/sealed-client.ts';
import {generateSigningKey,signConnection,signIdentityEvent,safetyNumber,requestFingerprint,verifyDeviceBinding,verifyValue,connectionClaim,type AccountIdentity,type ConnectionClaim,type DeviceRegistration,type IdentityEvent} from '../../shared/account-identity.ts';

const journeyId='journey_12345678-1234-1234-1234-123456789abc';

function memoryStore(){
 const files=new Map<string,string>();
 return {files,store:{async read(name:string){return files.get(name)},async write(name:string,value:string){files.set(name,value)}}};
}

async function fixture(){
 const account=await generateSigningKey();
 let identity:AccountIdentity={publicKey:account.publicKey,generation:0};
 let approve=false,tamperBinding=false,registered:DeviceRegistration|undefined,journey:Record<string,unknown>={journeyId,members:[],identities:{},identityLog:[],descriptors:{}};
 const claims:Record<string,unknown>[]=[];
 const remote={
  async listTools(){return {tools:[]}},
  async callTool(request:{name:string;arguments?:Record<string,unknown>}){
   const name=request.name,input=(request.arguments??{}) as Record<string,unknown>;
   let structuredContent:Record<string,unknown>;
   if(name==='account_read')structuredContent={personId:'person-alice',personalGroupId:'personal-alice',contentFormat:'sealed-v1',accountKey:{identity,recoveryWrap:{format:'wayfinding-browser-vault-1',iv:'iv',ciphertext:'ciphertext'}}};
   else if(name==='whoami')structuredContent={personId:'person-alice',agent:null};
   else if(name==='sealed_connection_request'){
    const claim=connectionClaim(input.claim as never);claims.push(claim);
    assert.equal(await verifyValue(claim.verificationKey,String(input.proof),'wayfinding-connection-request-1',claim),true);
    if(!approve&&!input.certificate)structuredContent={pending:true,connectionId:claim.connectionId,fingerprint:await import('../../shared/account-identity.ts').then(m=>m.requestFingerprint(claim))};
    else structuredContent={certificate:input.certificate??await signConnection(account.privateKey,claim)};
   }else if(name==='sealed_device_register'){
    registered=input as DeviceRegistration;structuredContent={};
   }else if(name==='sealed_group')structuredContent={groupId:journeyId,epoch:0,sequence:0,devices:[],remove:[],pending:[]};
   else if(name==='sealed_device_binding'){
    if(!registered)throw new Error('registration missing');
    structuredContent={...registered,personId:'person-alice',hash:'package-hash',createdAt:1,...(tamperBinding?{data:btoa('substituted package')}:{})};
   }else if(name==='sealed_group_commit')structuredContent={sequence:1};
   else if(name==='sealed_catalog')structuredContent={records:[],more:false,cursor:0};
   else if(name==='journey_read')structuredContent=journey;
   else throw new Error(`unexpected tool ${name}`);
   return {content:[],structuredContent};
  }
 } as unknown as SealedRemote;
 return {account,remote,claims,get identity(){return identity},set identity(value:AccountIdentity){identity=value},get approve(){return approve},set approve(value:boolean){approve=value},get tamperBinding(){return tamperBinding},set tamperBinding(value:boolean){tamperBinding=value},get registered(){return registered},set journey(value:Record<string,unknown>){journey=value}};
}

test('pending connection retries the same persisted root and refuses account replacement',async()=>{
 const f=await fixture(),local=memoryStore();
 let pending:ConnectionPendingError|undefined;
 await assert.rejects(SealedClient.open(f.remote,local.store,'person-alice'),error=>{pending=error as ConnectionPendingError;return error instanceof ConnectionPendingError});
 const first=JSON.parse(local.files.get('connection-identity')!);
 assert.equal(pending!.connectionId,first.claim.connectionId);
 assert.equal(pending!.fingerprint,await requestFingerprint(first.claim));
 f.approve=true;
 await SealedClient.open(f.remote,local.store,'person-alice');
 const second=JSON.parse(local.files.get('connection-identity')!);
 assert.equal(second.secret,first.secret);
 assert.deepEqual(second.claim,first.claim);
 assert.ok(second.certificate);
 assert.deepEqual(f.claims[0],f.claims[1]);
 const replacement=await generateSigningKey();f.identity={publicKey:replacement.publicKey,generation:1};
 await assert.rejects(SealedClient.open(f.remote,local.store,'person-alice'),/account key|safety number|reconnect/i);
 assert.equal(JSON.parse(local.files.get('connection-identity')!).secret,first.secret);
});

test('inline endorsement signs registrations and bootstrap refuses a substituted package',async()=>{
 const f=await fixture(),local=memoryStore();f.approve=true;
 const client=await SealedClient.open(f.remote,local.store,'person-alice',{endorse:(claim:ConnectionClaim)=>signConnection(f.account.privateKey,claim)});
 f.tamperBinding=true;
 await assert.rejects(client.createGroup(journeyId),/package|binding|signature/i);
 assert.ok(f.registered);
 await verifyDeviceBinding({...f.registered!,personId:'person-alice'});
 const saved=JSON.parse(local.files.get('connection-identity')!);
 assert.equal(f.registered!.verificationKey,saved.claim.verificationKey);
 assert.deepEqual(f.registered!.credential,saved.certificate);
});

test('journey display shows changed safety numbers, labels unsigned events, and rejects invalid signatures',async()=>{
 const f=await fixture(),local=memoryStore();f.approve=true;
 const client=await SealedClient.open(f.remote,local.store,'person-alice',{endorse:(claim:ConnectionClaim)=>signConnection(f.account.privateKey,claim)});
 const oldKey=await generateSigningKey(),nextKey=await generateSigningKey();
 await client.trustAccountKey('person-bob',oldKey.publicKey,await safetyNumber(oldKey.publicKey));
 const signed=await signIdentityEvent(nextKey.privateKey,{personId:'person-bob',generation:1,accountPublicKey:nextKey.publicKey,action:'account-key-set',previousPublicKey:oldKey.publicKey,at:10});
 const carolKey=await generateSigningKey(),unsigned:IdentityEvent={personId:'person-carol',generation:0,accountPublicKey:carolKey.publicKey,action:'account-key-set',at:11};
 f.journey={journeyId,members:[{memberId:'person-bob',personId:'person-bob'},{memberId:'person-carol',personId:'person-carol'}],identities:{'person-bob':{publicKey:nextKey.publicKey,generation:1,safetyNumber:await safetyNumber(nextKey.publicKey)},'person-carol':{publicKey:carolKey.publicKey,generation:0,safetyNumber:await safetyNumber(carolKey.publicKey)}},identityLog:[signed,unsigned],descriptors:{}};
 const view=await client.call('journey_read',{journeyId});
 const members=view.members as Record<string,unknown>[];
 assert.equal(members[0]!.accountTrust,'changed');assert.equal(members[0]!.accountKeyChanged,true);assert.equal(members[0]!.safetyNumber,await safetyNumber(nextKey.publicKey));
 const log=view.identityLog as Record<string,unknown>[];
 assert.equal(log[0]!.verified,true);assert.equal(log[0]!.verification,'self-signed');assert.equal(log[0]!.accountTrust,'changed');assert.equal(log[1]!.verified,false);assert.equal(log[1]!.verification,'server-asserted');assert.equal(log[1]!.accountTrust,'untrusted');
 await client.trustAccountKey('person-bob',nextKey.publicKey,await safetyNumber(nextKey.publicKey));
 assert.equal(((await client.call('journey_read',{journeyId})).members as Record<string,unknown>[])[0]!.accountTrust,'trusted');
 f.journey={journeyId,members:[],identities:{'person-bob':{publicKey:nextKey.publicKey,generation:1,safetyNumber:await safetyNumber(nextKey.publicKey)}},identityLog:[{...signed,signature:signed.signature!.slice(0,-2)+'AA'}],descriptors:{}};
 await assert.rejects(client.call('journey_read',{journeyId}),/signed identity log/i);
});

test('pinned account log verifies predecessor generations but refuses unrelated roots and broken historical signatures',async()=>{
 const {pinnedIdentityLog}=await import('../../shared/account-trust.ts');
 const old=await generateSigningKey(),current=await generateSigningKey(),forged=await generateSigningKey(),personId='person-history';
 const oldEvent=await signIdentityEvent(old.privateKey,{personId,generation:0,accountPublicKey:old.publicKey,action:'connection-added',connectionId:'old',at:1});
 const transition=await signIdentityEvent(current.privateKey,{personId,generation:1,accountPublicKey:current.publicKey,previousPublicKey:old.publicKey,action:'account-key-set',at:2});
 const pin={publicKey:current.publicKey,generation:1,compared:true,history:[]};
 const checked=await pinnedIdentityLog(pin,personId,[oldEvent,transition]);
 assert.deepEqual(checked.entries.map(e=>e.verified),[true,true]);assert.deepEqual(checked.pin.history,[{publicKey:old.publicKey,generation:0}]);
 await assert.rejects(pinnedIdentityLog(pin,personId,[oldEvent]),{message:'Identity log key is not pinned'});
 await assert.rejects(pinnedIdentityLog(pin,personId,[{...oldEvent,signature:'A'.repeat(88)},transition]),{message:'Invalid signed identity log entry'});
 const forgedTransition=await signIdentityEvent(forged.privateKey,{personId,generation:2,accountPublicKey:forged.publicKey,previousPublicKey:current.publicKey,action:'account-key-set',at:3});
 await assert.rejects(pinnedIdentityLog(pin,personId,[forgedTransition]),{message:'Identity log key is not pinned'});
 const unsigned={...oldEvent};delete unsigned.signature;
 assert.equal((await pinnedIdentityLog(checked.pin,personId,[unsigned])).entries[0]!.verified,false);
 // History is authenticated, not a new current pin.
 assert.equal(checked.pin.publicKey,current.publicKey);assert.equal(checked.pin.generation,1);
});

test('first-seen journey roots are distinct from an explicit safety-number comparison',async()=>{
 const f=await fixture(),local=memoryStore();f.approve=true;
 const client=await SealedClient.open(f.remote,local.store,'person-alice'),bob=await generateSigningKey(),number=await safetyNumber(bob.publicKey);
 f.journey={journeyId,members:[],identities:{'person-bob':{publicKey:bob.publicKey,generation:0,safetyNumber:number}},identityLog:[],descriptors:{}};
 const first=await client.call('journey_read',{journeyId});assert.equal((first.identities as Record<string,{accountCompared:boolean}>)['person-bob']!.accountCompared,false);
 await client.trustAccountKey('person-bob',bob.publicKey,number);
 const second=await client.call('journey_read',{journeyId});assert.equal((second.identities as Record<string,{accountCompared:boolean}>)['person-bob']!.accountCompared,true);
});
