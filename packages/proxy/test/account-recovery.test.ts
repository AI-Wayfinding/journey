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
import {Refused} from '../../mcp/src/errors.ts';
import {RemoteFailure} from '../src/errors.ts';
import {consolePost,consoleRemote} from '../../browser/src/remote.ts';

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
for(const failure of ['Coordination operation failed','Coordination storage operation failed','lost','malformed'] as const)test(`MLS removal committed before ${failure} installs the staged epoch and keeps reading`,async()=>{
 const f=await fixture(),{alice,bob,journeyId}=f;
 const item=await alice.client.call('library_add',{journeyId,name:'Retained',kind:'markdown',text:'Readable after committed error'});
 const itemId=String((item.records as {type:string;recordId:string}[]).find(r=>r.type==='library')!.recordId);
 await alice.client.call('journey_remove',{journeyId,memberId:bob.client.personId});
 let commits=0;
 const remote:SealedRemote={listTools:()=>alice.remote.listTools(),callTool:async r=>{
  const result=await alice.remote.callTool(r);
  if(r.name==='sealed_group_commit'&&r.arguments?.action==='remove'){commits++;if(failure==='lost')throw new Error('Lost receipt');if(failure==='malformed')return {content:[],structuredContent:{sequence:'invalid'}};return {isError:true,content:[{type:'text',text:failure}]};}
  return result;
 }};
 const client=await SealedClient.open(remote,alice.store,alice.client.personId);
 await client.sync(journeyId);await client.sync(journeyId);
 assert.equal((await client.call('library_get',{itemId})).text,'Readable after committed error');
 await client.call('library_add',{journeyId,name:'After error',kind:'markdown',text:'Writable with accepted epoch'});
 const reopened=await SealedClient.open(remote,alice.store,alice.client.personId);await reopened.sync(journeyId);
 assert.equal((await reopened.call('library_get',{itemId})).text,'Readable after committed error');
 assert.equal(commits,1,'settlement must not resend the commit');
});
for(const transport of ['proxy','browser'] as const)test(`concurrent recovery removers leave the ${transport} CAS loser able to sync and read`,{timeout:30_000},async()=>{
 const f=await fixture(),{alice,bob,journeyId}=f,carol=await f.connect('carol');
 await carol.client.call('journey_join',{journeyId});const cd=await carol.client.prepareGroup(journeyId);await alice.client.addMember(journeyId,carol.client.personId,cd.deviceId);await carol.client.sync(journeyId);
 const item=await alice.client.call('library_add',{journeyId,name:'Race history',kind:'markdown',text:'Retained through concurrent removal'});
 const itemId=String((item.records as {type:string;recordId:string}[]).find(r=>r.type==='library')!.recordId);
 await carol.client.sync(journeyId);
 const recovered=await f.recoverBob(),publicKey=recovered.signer.key.publicKey,number=await safetyNumber(publicKey);
 await alice.client.trustAccountKey(bob.client.personId,publicKey,number);await carol.client.trustAccountKey(bob.client.personId,publicKey,number);
 let attempts=0,release!:()=>void,finish!:()=>void;
 const ready=new Promise<void>(r=>{release=r}),accepted=new Promise<void>(r=>{finish=r});
 const ordered=(remote:SealedRemote,loser:boolean):SealedRemote=>({listTools:()=>remote.listTools(),async callTool(r){
  if(r.name==='sealed_group_commit'&&r.arguments?.action==='remove'){
   if(++attempts===2)release();await ready;if(loser)await accepted;
   try{return await remote.callTool(r);}catch(error){return {isError:true,content:[{type:'text',text:error instanceof Refused?error.message:'Coordination operation failed'}]};}finally{if(!loser)finish();}
  }
  return remote.callTool(r);
 }});
 const winnerRemote=ordered(alice.remote,false),loserWire=ordered(carol.remote,true);
 const loserRemote=transport==='proxy'?loserWire:consoleRemote(consolePost('test-csrf',async(_path,init)=>{
  const body=JSON.parse(String(init.body)),r=await loserWire.callTool({name:body.tool,arguments:body.input});
  return r.isError?Response.json({error:r.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')},{status:409}):Response.json(r.structuredContent);
 }),crypto.randomUUID(),async()=>{throw new Error('Unexpected enrollment');});
 const winner=await SealedClient.open(winnerRemote,alice.store,alice.client.personId),loser=await SealedClient.open(loserRemote,carol.store,carol.client.personId);
 const oldEpoch=await loser.exportGroup(journeyId);
 const results=await Promise.allSettled([winner.sync(journeyId),loser.sync(journeyId)]);
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
 if(results[1].status!=='rejected')assert.fail('CAS loser must report the stale attempt');
 assert.ok(results[1].reason instanceof RemoteFailure);assert.equal(results[1].reason.code,'refused');
 assert.equal(await loser.exportGroup(journeyId),oldEpoch,'a definite CAS loser retains its old epoch');
 await loser.sync(journeyId);
 assert.equal((await loser.call('library_get',{itemId})).text,'Retained through concurrent removal');
 const next=await loser.call('library_add',{journeyId,name:'After race',kind:'markdown',text:'CAS loser can write'}),nextId=String((next.records as {type:string;recordId:string}[]).find(r=>r.type==='library')!.recordId);
 await winner.sync(journeyId);assert.equal((await winner.call('library_get',{itemId:nextId})).text,'CAS loser can write');
 assert.equal(attempts,2,'the losing epoch must not be resent');
});
for(const damage of ['ciphertext','sequence','kind','epoch','missing'] as const)test(`MLS settlement with ${damage} evidence mismatch stays fenced`,async()=>{
 const f=await fixture(),{alice,bob,journeyId}=f;
 await alice.client.call('journey_remove',{journeyId,memberId:bob.client.personId});let committed=false;
 const before=await alice.client.exportGroup(journeyId);
 const remote:SealedRemote={listTools:()=>alice.remote.listTools(),async callTool(r){
  const result=await alice.remote.callTool(r);
  if(r.name==='sealed_group_commit'){committed=true;return {isError:true,content:[{type:'text',text:'Coordination operation failed'}]};}
  if(committed&&r.name==='sealed_group_fetch'){
   const page=result.structuredContent as {messages:Record<string,unknown>[]},m=page.messages[0]!;
   const changed={...m};if(damage==='ciphertext')changed.data='e30=';if(damage==='sequence')changed.sequence=Number(m.sequence)+1;if(damage==='kind')changed.kind='update';if(damage==='epoch')changed.epoch=Number(m.epoch)+1;
   return {content:[],structuredContent:{messages:damage==='missing'?[]:[changed]}};
  }
  return result;
 }};
 const client=await SealedClient.open(remote,alice.store,alice.client.personId);
 await assert.rejects(client.sync(journeyId),/Remote operation refused/);
 await assert.rejects(client.sync(journeyId),/Ambiguous MLS delivery/);
 const saved=JSON.parse(alice.store.files.get('sealed-state')!).groups[journeyId];assert.equal(saved.mls,before);assert.equal(saved.blocked,true);
 const reopened=await SealedClient.open(remote,alice.store,alice.client.personId);await assert.rejects(reopened.sync(journeyId),/Ambiguous MLS delivery/);
});

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


for(const action of ['add','remove','bootstrap'] as const)test(`refused MLS ${action} commits retain the old durable epoch and can retry after reopen`,async()=>{
 const f=await fixture(),{alice,bob,journeyId}=f;
 const item=await alice.client.call('library_add',{journeyId,name:'Retained',kind:'markdown',text:'Readable after refusal'});
 const itemId=String((item.records as {type:string;recordId:string}[]).find(r=>r.type==='library')!.recordId);
 await alice.client.sync(journeyId);
 let groupId=journeyId;
 if(action==='add'){const carol=await f.connect('carol');await carol.client.call('journey_join',{journeyId});await carol.client.prepareGroup(journeyId);}
 if(action==='remove')await alice.client.call('journey_remove',{journeyId,memberId:bob.client.personId});
 if(action==='bootstrap')groupId=String((await f.backend.sealedExecute('alice','journey_create',{policy:'open',defaultRole:'write'})).journeyId);
 let refuse=true,during:Record<string,unknown>|undefined;
 const remote:SealedRemote={listTools:()=>alice.remote.listTools(),callTool:async r=>{
  if(r.name==='sealed_group_commit'&&r.arguments?.action===action&&refuse){during=JSON.parse(alice.store.files.get('sealed-state')!).groups[groupId];return {isError:true,content:[{type:'text',text:'Explicit commit refusal'}]};}
  return alice.remote.callTool(r);
 }};
 const client=await SealedClient.open(remote,alice.store,alice.client.personId);
 const before=action==='bootstrap'?undefined:JSON.parse(alice.store.files.get('sealed-state')!).groups[groupId];
 await assert.rejects(action==='bootstrap'?client.enrollGroup(groupId):client.sync(groupId),/Remote operation refused/);
 const after=JSON.parse(alice.store.files.get('sealed-state')!).groups[groupId];
 assert.equal(after.blocked,false,'a definitive refusal is not an ambiguous delivery');
 assert.equal(during!.mls,after.mls,'no epoch advance may be persisted while awaiting acceptance');
 assert.deepEqual(after.roster,before?.roster??[]);
 if(before){assert.equal(after.mls,before.mls);assert.equal(await client.exportGroup(groupId),before.mls);}
 refuse=false;
 const reopened=await SealedClient.open(remote,alice.store,alice.client.personId);
 if(action==='bootstrap'){assert.equal((await reopened.enrollGroup(groupId)).admitted,true);}
 else await reopened.sync(groupId);
 assert.equal((await reopened.call('library_get',{itemId})).text,'Readable after refusal');
});


for(const receipt of ['lost','malformed','Coordination operation failed','permission','capacity','Task is final','Prepared epoch is stale'] as const)test(`an MLS commit with a ${receipt} receipt and unreadable outcome keeps the old epoch fenced, including after reopen`,async()=>{
 const f=await fixture(),{alice,journeyId}=f;
 const dave=await f.connect('dave');await dave.client.call('journey_join',{journeyId});await dave.client.prepareGroup(journeyId);
 const before=JSON.parse(alice.store.files.get('sealed-state')!).groups[journeyId];let commits=0;
 const remote:SealedRemote={listTools:()=>alice.remote.listTools(),callTool:async r=>{
  if(commits&&r.name==='sealed_group')throw new Error('Outcome unavailable');
  const result=await alice.remote.callTool(r);
  if(r.name==='sealed_group_commit'){commits++;if(receipt==='lost')throw new Error('Lost acceptance receipt');if(receipt==='malformed')return {content:[],structuredContent:{sequence:'invalid'}};return {isError:true,content:[{type:'text',text:receipt}]};}
  return result;
 }};
 const client=await SealedClient.open(remote,alice.store,alice.client.personId);
 await assert.rejects(client.sync(journeyId));
 const after=JSON.parse(alice.store.files.get('sealed-state')!).groups[journeyId];
 assert.equal(after.blocked,true);assert.equal(after.mls,before.mls);assert.deepEqual(after.roster,before.roster);
 await assert.rejects(client.sync(journeyId),/Ambiguous MLS delivery/);
 const reopened=await SealedClient.open(remote,alice.store,alice.client.personId);
 await assert.rejects(reopened.sync(journeyId),/Ambiguous MLS delivery/);assert.equal(commits,1,'unknown delivery must never resend');
});
