import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountsHost } from '../src/accounts.ts';
import { MemoryStorage } from '../src/storage.ts';
import { authenticator } from './console-authenticator.ts';
import { generateSigningKey, signIdentityEvent, signConnection, signValue, connectionClaim, signPackage } from '../../shared/account-identity.ts';

const identity = {subject:'alice',clientId:'https://poc.wayfinding.support/console/client.json'};
async function fixture() {
 const storage=new MemoryStorage(); let now=Date.now();
 const host=()=>new AccountsHost(storage,{async get(){return {name:'Alice',email:'alice@example.test'};}},undefined,undefined,()=>now,true);
 await host().provision('alice');
 const key=await authenticator(),options=await host().passkey(identity,{op:'begin'});
 await host().passkey(identity,{op:'finish',credential:key.register(String(options.challenge))});
 return {host,key,storage,advance:(ms:number)=>{now+=ms;},now:()=>now};
}
test('F6: console sign-in alone cannot add a second passkey',async()=>{
 const f=await fixture();
 await assert.rejects(f.host().passkey(identity,{op:'begin'}),/existing passkey|recovery code/i);
});

test('F6: existing UV assertion authorizes one addition, not a replay',async()=>{
 const f=await fixture(),options=await f.host().passkey(identity,{op:'addition_options'}),assertion=await f.key.assert(String(options.challenge));
 const next=await f.host().passkey(identity,{op:'begin',assertion});
 const second=await authenticator();
 await f.host().passkey(identity,{op:'finish',credential:second.register(String(next.challenge))});
 assert.equal(((await f.host().passkey(identity,{op:'list'})).passkeys as unknown[]).length,2);
 await assert.rejects(f.host().passkey(identity,{op:'begin',assertion}));
});
test('recovery: removes all connections immediately; persistent 72h clock cannot be restarted or cancelled',async()=>{
 const f=await fixture(),before=await f.host().lookup('alice');
 const start=await f.host().passkey({...identity,signedInAt:f.now()},{op:'recovery_start'});
 assert.equal(start.readyAt,f.now()+259200000);
 assert.deepEqual((await f.host().passkey(identity,{op:'list'})).passkeys,[]);
 await assert.rejects(f.host().passkey(identity,{op:'begin'}),/72|recovery/i);
 f.advance(259199999);
 await assert.rejects(f.host().passkey(identity,{op:'begin'}),/72|recovery/i);
 assert.equal((await f.host().passkey({...identity,signedInAt:f.now()},{op:'recovery_start'})).readyAt,start.readyAt);
 await assert.rejects(f.host().passkey(identity,{op:'recovery_cancel'} as never));
 f.advance(1);
 assert.ok((await f.host().passkey({...identity,signedInAt:f.now()},{op:'begin'})).challenge);
 assert.equal((await f.host().lookup('alice'))!.personId,before!.personId);
});

test('recovery: agent cannot start recovery; tokens and bindings are dead immediately',async()=>{
 const f=await fixture(),host=f.host(),clientId='agent-client',verifier='a'.repeat(43);
 const {tokenHash}=await import('../src/oauth-store.ts');
 const complete=JSON.parse(String(await f.storage.get('accounts')));complete.accounts[0].onboarding.complete=true;await f.storage.put('accounts',JSON.stringify(complete));
 await host.oauth({op:'request',id:'request',request:{clientId,clientName:'MCP client',redirectUri:'http://127.0.0.1/callback',challenge:await tokenHash(verifier),expiresAt:f.now()+600000}});
 const agent=await host.oauth({op:'consent',id:'request',subject:'alice',consent:{name:'MCP client',capabilities:['read'],journeys:[]}});assert.equal(agent.kind,'agent');if(agent.kind!=='agent')return;
 const code=await host.oauth({op:'code',id:'request',subject:'alice',agentId:agent.agentId});if(code.kind!=='code')throw Error('code');
 const tokens=await host.oauth({op:'exchange',clientId,code:code.code,redirectUri:'http://127.0.0.1/callback',verifier});if(tokens.kind!=='tokens')throw Error('tokens');
 await assert.rejects(host.passkey({subject:'alice',clientId},{op:'recovery_start'}),/person|live/i);
 await host.passkey({...identity,signedInAt:f.now()},{op:'recovery_start'});
 assert.equal((await host.oauth({op:'verify',token:tokens.tokens.access_token})).kind,'error');
 assert.equal((await host.oauth({op:'refresh',clientId,token:tokens.tokens.refresh_token})).kind,'error');
 await assert.rejects(host.passkey({subject:'alice',clientId},{op:'recovery_cancel'} as never));
 await assert.rejects(host.passkey({subject:'alice',clientId},{op:'recovery_start'}),/person|live/i);
 await host.oauth({op:'request',id:'new-request',request:{clientId,clientName:'MCP client',redirectUri:'http://127.0.0.1/callback',challenge:await tokenHash(verifier),expiresAt:f.now()+600000}});
 await assert.rejects(host.oauth({op:'consent',id:'new-request',subject:'alice',consent:{name:'MCP client',capabilities:['read'],journeys:[]}}),/recovery/i);
});

test('F6: deleting the last passkey cannot turn email sign-in back into enrollment authority',async()=>{
 const f=await fixture();await assert.rejects(f.host().passkey(identity,{op:'delete',id:f.key.id}),/last passkey|recovery/i);
 await assert.rejects(f.host().passkey(identity,{op:'begin'}),/existing passkey|recovery code/i);
});


for(const op of ['consent','consent-options','code'] as const)test(`onboarding backend: ${op} refuses an incomplete account`,async()=>{
 const f=await fixture(),host=f.host();
 await host.oauth({op:'request',id:'incomplete',request:{clientId:'client',clientName:'MCP client',redirectUri:'http://127.0.0.1/callback',challenge:'x'.repeat(43),expiresAt:f.now()+600000}});
 const consent={name:'MCP client',capabilities:['read' as const,...(op==='consent-options'?['device.keys' as const]:[])],journeys:[]};
 let agentId='agent';
 if(op==='code'){
  const state=JSON.parse(String(await f.storage.get('accounts')));state.accounts[0].onboarding.complete=true;await f.storage.put('accounts',JSON.stringify(state));
  const agent=await host.oauth({op:'consent',id:'incomplete',subject:'alice',consent});if(agent.kind!=='agent')throw Error('agent required');agentId=agent.agentId;
  const incomplete=JSON.parse(String(await f.storage.get('accounts')));incomplete.accounts[0].onboarding.complete=false;await f.storage.put('accounts',JSON.stringify(incomplete));
 }
 await assert.rejects(host.oauth(op==='code'?{op,id:'incomplete',subject:'alice',agentId}:{op,id:'incomplete',subject:'alice',consent}),/onboarding/i);
});

for(const age of [undefined,600001,-1])test(`recovery: fresh sign-in is required (${age})`,async()=>{
 const f=await fixture(),session={...identity,...(age===undefined?{}:{signedInAt:f.now()-age})};
 await assert.rejects(f.host().passkey(session,{op:'recovery_start'}),/fresh sign-in/i);
 assert.equal(((await f.host().passkey(identity,{op:'list'})).passkeys as unknown[]).length,1);
});
test('recovery: registration resumes only for sign-in after deadline in Accounts',async()=>{
 const f=await fixture();await f.host().passkey({...identity,signedInAt:f.now()},{op:'recovery_start'});
 f.advance(259200000);
 await assert.rejects(f.host().passkey(identity,{op:'begin'}),/sign.in/i);
 await assert.rejects(f.host().passkey({...identity,signedInAt:f.now()-1},{op:'begin'}),/sign.in/i);
 assert.ok((await f.host().passkey({...identity,signedInAt:f.now()},{op:'begin'})).challenge);
});
test('recovery atomically invalidates registration and saves account state',async()=>{
 const f=await fixture(),options=await f.host().passkey(identity,{op:'addition_options'});
 await f.host().passkey(identity,{op:'begin',assertion:await f.key.assert(String(options.challenge))});
 const before=new Map(f.storage.data),put=f.storage.put.bind(f.storage);
 f.storage.put=async(k,v)=>{if(k==='accounts')throw Error('synthetic account write failure');await put(k,v);};
 await assert.rejects(f.host().passkey({...identity,signedInAt:f.now()},{op:'recovery_start'}),/synthetic account write failure/);
 assert.deepEqual(f.storage.data,before,'registration and connections roll back together');
});

test('recovery verifier uses native constant-time verification; wrong proofs never authorize',async()=>{
 const f=await fixture(),proof='b'.repeat(43),{tokenHash}=await import('../src/oauth-store.ts');
 const state=JSON.parse(String(await f.storage.get('accounts')));state.accounts[0].recovery={generation:0,verifier:await tokenHash(proof)};await f.storage.put('accounts',JSON.stringify(state));
 const verify=crypto.subtle.verify.bind(crypto.subtle);let comparisons=0;
 crypto.subtle.verify=async(...args:Parameters<typeof crypto.subtle.verify>)=>{if(args[0]==='HMAC')comparisons++;return verify(...args);};
 try {
  for(const bad of ['a'+proof.slice(1),proof.slice(0,-1)+'a'])await assert.rejects(f.host().passkey(identity,{op:'begin',recoveryProof:bad}));
  assert.ok((await f.host().passkey(identity,{op:'begin',recoveryProof:proof})).challenge);
  assert.equal(comparisons,3,'each verifier comparison uses Web Crypto, not string equality');
 }finally{crypto.subtle.verify=verify;}
});


test('recovery: real DO adapters preserve sign-in freshness and revoke connections immediately',async()=>{
 const f=await fixture(),{Accounts,durableBackend}=await import('../src/objects.ts'),{MemoryBlobs}=await import('../src/relay.ts');
 const blobs=new MemoryBlobs(),backend=durableBackend({WORKOS_API_KEY:'unused',BLOBS:blobs,
  ACCOUNTS:{getByName(){return new Accounts({storage:f.storage},{WORKOS_API_KEY:'unused',BLOBS:blobs},undefined,true);}},
  JOURNEYS:{getByName(){throw Error('No journey expected');}},
 },true);
 const agent=await backend.sealedExecute('alice','agent_create',{},identity.clientId);
 const account=await f.host().lookup('alice');assert.ok(account);
 const accountKey=await generateSigningKey(),root=await generateSigningKey(),generation=Number((await backend.passkey(identity,{op:'identity_read'})).generation);
 const record={identity:{publicKey:accountKey.publicKey,generation},recoveryWrap:{format:'wayfinding-browser-vault-1' as const,iv:'AA==',ciphertext:'AA=='}};
 await backend.passkey(identity,{op:'identity_set',record,event:await signIdentityEvent(accountKey.privateKey,{personId:account.personId,accountPublicKey:accountKey.publicKey,generation,action:'account-key-set',at:Date.now()})});
 const claim={personId:account.personId,connectionId:`connection-${crypto.randomUUID()}`,verificationKey:root.publicKey,generation,accountPublicKey:accountKey.publicKey};
 const credential=await signConnection(accountKey.privateKey,claim),event=await signIdentityEvent(accountKey.privateKey,{personId:account.personId,accountPublicKey:accountKey.publicKey,generation,connectionId:claim.connectionId,action:'connection-added',at:Date.now()});
 await backend.sealedExecute('alice','sealed_connection_request',{claim,proof:await signValue(root.privateKey,'wayfinding-connection-request-1',connectionClaim(claim)),certificate:credential,event},identity.clientId);
 const browserId=crypto.randomUUID(),body={deviceId:`device_${crypto.randomUUID()}`,verificationKey:root.publicKey,data:Buffer.from('synthetic key package').toString('base64'),credential},device={...body,packageSignature:await signPackage(root.privateKey,body)};
 const fields={browserId,credentialId:f.key.id,device},options=await backend.passkey(identity,{op:'browser_begin',...fields});
 await backend.passkey(identity,{op:'browser_finish',...fields,assertion:await f.key.assert(String(options.challenge))});
 assert.equal(((await backend.passkey(identity,{op:'browser_list'})).browsers as unknown[]).length,1);
 for(const signedInAt of [undefined,Date.now()-600001,Date.now()+60000])await assert.rejects(backend.passkey({...identity,signedInAt},{op:'recovery_start'}),/fresh sign-in/);
 const started=Date.now(),result=await backend.passkey({...identity,signedInAt:started},{op:'recovery_start'});
 assert.ok(Number(result.readyAt)>=started+259200000);
 assert.deepEqual((await backend.passkey(identity,{op:'list'})).passkeys,[]);
 assert.deepEqual((await backend.passkey(identity,{op:'browser_list'})).browsers,[]);
 const agents=(await backend.execute('alice',{tool:'agent_list',input:{}},identity.clientId)).agents as {agentId:string;live:boolean;capabilities:unknown[]}[];
 assert.equal(agents.find(a=>a.agentId===agent.agentId)!.live,false);
 assert.deepEqual(agents.find(a=>a.agentId===agent.agentId)!.capabilities,[]);
 await assert.rejects(backend.passkey(identity,{op:'browser_check',browserId}));
 await assert.rejects(backend.execute('alice',{tool:'agent_capabilities',input:{agentId:String(agent.agentId)}},identity.clientId));
});
