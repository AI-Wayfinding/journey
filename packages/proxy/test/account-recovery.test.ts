import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryBackend} from '../../mcp/src/backend.ts';
import {sealedInputs} from '../../mcp/src/sealed-contract.ts';
import {installTestAccountIdentity,trustedAccountRemote} from '../../mcp/test/account-fixture.ts';
import {SealedClient,type SealedRemote} from '../src/sealed-client.ts';
import {safetyNumber} from '../../shared/account-identity.ts';
import * as z from 'zod';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {WayfindingProxy} from '../src/proxy.ts';
import {buildProxyServer} from '../src/server.ts';

function local(){const files=new Map<string,string>();return {files,async read(k:string){return files.get(k)},async write(k:string,v:string){files.set(k,v)}};}
async function fixture(){
 let now=Date.now(),badBinding=false;
 const backend=new MemoryBackend({async get(subject){return {email:`${subject}@example.test`,name:subject}}},()=>now,undefined,true);
 async function connect(subject:string,signer?:Awaited<ReturnType<typeof installTestAccountIdentity>>){
  signer??=await installTestAccountIdentity(backend,subject,'test-console',now);
  const raw={async listTools(){return {tools:[]}},async callTool(request:{name:string;arguments?:Record<string,unknown>}){
   const name=request.name,args=request.arguments??{};
   const result=name==='whoami'?await backend.whoami(subject,'trusted-host'):sealedInputs[name]?await backend.sealedExecute(subject,name,args):await backend.execute(subject,{tool:name,input:args} as Parameters<typeof backend.execute>[1]);
   if(badBinding&&name==='sealed_device_binding')return {content:[],structuredContent:{...result,packageSignature:'A'.repeat(88)}};
   return {content:[],structuredContent:result};
  }} as SealedRemote;
  const store=local(),remote=trustedAccountRemote(raw,signer),client=await SealedClient.open(remote,store,signer.account.personId,{endorse:async c=>(await signer.artifacts(c)).certificate});
  return {client,store,signer,remote};
 }
 const alice=await connect('alice'),bob=await connect('bob');
 const journeyId=String((await alice.client.call('journey_create',{name:'Recovery history',policy:'open',defaultRole:'write'})).journeyId);
 await bob.client.call('journey_join',{journeyId});const device=await bob.client.prepareGroup(journeyId);await alice.client.addMember(journeyId,bob.client.personId,device.deviceId);await bob.client.sync(journeyId);
 return {backend,alice,bob,journeyId,device,connect,set badBinding(v:boolean){badBinding=v},async recoverBob(){
  await backend.passkey({subject:'bob',clientId:'test-console',signedInAt:now},{op:'recovery_start'});now+=259200001;
  const signer=await installTestAccountIdentity(backend,'bob','test-console',now);return connect('bob',signer);
 }};
}

test('real MLS recovery exposes changed keys before sync, retains old signatures and gives new joiners verified history',async()=>{
 const f=await fixture(),{alice,bob,journeyId}=f;
 const item=await bob.client.call('library_add',{journeyId,name:'Before recovery',kind:'markdown',text:'Old-generation content'}),itemId=String((item.records as {type:string;recordId:string}[]).find(r=>r.type==='library')!.recordId);await alice.client.sync(journeyId);
 const recovered=await f.recoverBob(),newDevice=await recovered.client.prepareGroup(journeyId);
 const view=await alice.client.call('journey_read',{journeyId}),identity=(view.identities as Record<string,{publicKey:string;accountTrust:string;safetyNumber:string}>)[bob.client.personId]!;
 assert.equal(identity.accountTrust,'changed');assert.equal(view.contentUnavailable,true);
 await assert.rejects(alice.client.sync(journeyId),/safety number changed/i);
 await alice.client.trustAccountKey(bob.client.personId,identity.publicKey,identity.safetyNumber);
 await alice.client.addMember(journeyId,bob.client.personId,newDevice.deviceId);await recovered.client.sync(journeyId);
 assert.equal((await recovered.client.call('library_get',{itemId})).text,'Old-generation content');
 assert.equal((await alice.client.call('library_get',{itemId})).text,'Old-generation content');
 const carol=await f.connect('carol');await carol.client.call('journey_join',{journeyId});
 const pending=await carol.client.prepareGroup(journeyId);await alice.client.addMember(journeyId,carol.client.personId,pending.deviceId);await carol.client.sync(journeyId);
 assert.equal((await carol.client.call('library_get',{itemId})).text,'Old-generation content');
 assert.equal((JSON.parse(carol.store.files.get('account-trust')!).pins[bob.client.personId]).publicKey,recovered.signer.key.publicKey);
 // The old root remains valid only as authenticated history, not as a current replacement.
 const reopened=await SealedClient.open(alice.remote,alice.store,alice.client.personId);await reopened.sync(journeyId);
 assert.equal((await reopened.call('library_get',{itemId})).text,'Old-generation content');
 assert.notEqual(await safetyNumber(bob.signer.key.publicKey),identity.safetyNumber);
});

test('a failure inside inbound packet accept never blocks or advances the durable MLS audience',async()=>{
 const f=await fixture(),{alice,bob,journeyId}=f;
 await alice.client.sync(journeyId);await bob.client.call('library_add',{journeyId,name:'Incoming',kind:'markdown',text:'Retry verified receive'});
 const before=JSON.parse(alice.store.files.get('sealed-state')!).groups[journeyId];
 f.badBinding=true;await assert.rejects(alice.client.sync(journeyId),/signature mismatch/i);
 const after=JSON.parse(alice.store.files.get('sealed-state')!).groups[journeyId];
 assert.equal(after.blocked,false);assert.equal(after.cursor,before.cursor);assert.equal(after.mls,before.mls);
 f.badBinding=false;await alice.client.sync(journeyId);
 const reopened=await SealedClient.open(alice.remote,alice.store,alice.client.personId);await reopened.sync(journeyId);
});
test('historical signatures cannot authorize a fresh admission after comparing a recovered key',async()=>{
 const f=await fixture(),{alice,bob,journeyId}=f,oldDevice=f.device,oldBinding=await f.backend.accountsHost.deviceBinding(oldDevice.deviceId);
 await f.recoverBob();const view=await alice.client.call('journey_read',{journeyId}),identity=(view.identities as Record<string,{publicKey:string;safetyNumber:string}>)[bob.client.personId]!;
 await alice.client.trustAccountKey(bob.client.personId,identity.publicKey,identity.safetyNumber);await alice.client.call('journey_read',{journeyId});
 const calls:string[]=[],remote:SealedRemote={listTools:(...args)=>alice.remote.listTools(...args),async callTool(request){calls.push(request.name);const result=await alice.remote.callTool(request);if(request.name==='sealed_group')return {...result,structuredContent:{...z.record(z.string(),z.unknown()).parse(result.structuredContent),pending:[oldBinding]}};return result;}};
 const reopened=await SealedClient.open(remote,alice.store,alice.client.personId);calls.length=0;
 await assert.rejects(reopened.sync(journeyId),{message:'Pending connection must use the displayed current account key'});
 assert.equal(calls.includes('sealed_package_reserve'),false);assert.equal(calls.includes('sealed_group_commit'),false);assert.equal(calls.includes('sealed_history_post'),false);
});

test('local MCP tools show and accept changed safety numbers and resume synchronization',async t=>{
 const f=await fixture(),{alice,bob,journeyId}=f;
 const added=await alice.client.call('library_add',{journeyId,name:'Retained',text:'Retained before recovery',kind:'markdown'}),itemId=String((added.records as {recordId:string;type:string}[]).find(r=>r.type==='library')!.recordId);
 const recovered=await f.recoverBob();await recovered.client.prepareGroup(journeyId);
 const proxy=await WayfindingProxy.open(alice.remote,alice.store),server=await buildProxyServer(proxy),client=new Client({name:'local-safety-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(a),client.connect(b)]);t.after(()=>client.close());
 const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='account_safety_numbers'),'Local comparison tool must be advertised');assert.ok(tools.tools.some(t=>t.name==='account_trust_key'));
 const blocked=await client.callTool({name:'mls_group_sync',arguments:{groupId:journeyId}});assert.equal(blocked.isError,true);assert.match(JSON.stringify(blocked),/account_safety_numbers.*account_trust_key/);
 const view=await client.callTool({name:'account_safety_numbers',arguments:{journeyId}}),identities=z.object({identities:z.record(z.string(),z.object({publicKey:z.string(),safetyNumber:z.string(),accountTrust:z.string()}))}).parse(view.structuredContent).identities;
 const changed=identities[bob.client.personId]!;assert.equal(changed.accountTrust,'changed');assert.equal(changed.publicKey,recovered.signer.key.publicKey);
 const mismatch=await client.callTool({name:'account_trust_key',arguments:{personId:bob.client.personId,publicKey:changed.publicKey,expectedSafetyNumber:'wrong'}});assert.equal(mismatch.isError,true);
 assert.equal((await client.callTool({name:'mls_group_sync',arguments:{groupId:journeyId}})).isError,true,'A wrong comparison must not move the pin');
 const accepted=await client.callTool({name:'account_trust_key',arguments:{personId:bob.client.personId,publicKey:changed.publicKey,expectedSafetyNumber:changed.safetyNumber}});assert.notEqual(accepted.isError,true);
 assert.notEqual((await client.callTool({name:'mls_group_sync',arguments:{groupId:journeyId}})).isError,true);
 const read=await client.callTool({name:'artifact_read',arguments:{groupId:journeyId,artifactId:itemId}});assert.equal(z.object({content:z.string()}).parse(read.structuredContent).content,'Retained before recovery');
});
