import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {MemoryBackend} from '../../mcp/src/backend.ts';
import {app,bridge,keyPair,RESOURCE,token,testPasskeys,setAgentCard} from '../../mcp/test/helpers.ts';
import {SealedClient,type SealedRemote} from '../src/sealed-client.ts';
import {WayfindingProxy} from '../src/proxy.ts';
import {openTestSealed,testAccount} from './account-fixture.ts';
import {parseCommand} from '../../mcp/src/commands.ts';
import * as z from 'zod';

async function fixture(t:TestContext,now:()=>number=Date.now){
 const backend=new MemoryBackend({async get(s){return {name:s,email:`${s}@example.test`};}},now,testPasskeys,true),signer=await keyPair('sealed');
 const connect=async(subject:string)=>{const remote=new Client({name:'sealed-test',version:'1'});await remote.connect(new StreamableHTTPClientTransport(RESOURCE,{fetch:bridge(app(signer,backend)),requestInit:{headers:{authorization:`Bearer ${await token(signer,{sub:subject})}`}}}));t.after(()=>remote.close());const files=new Map<string,string>(),store={async read(k:string){return files.get(k)},async write(k:string,v:string){files.set(k,v)}};const opened=await openTestSealed(backend,remote,store,subject);return {...opened,files,store};};
 return {backend,connect,a:await connect('alice')};
}
const records=(value:Record<string,unknown>)=>z.array(z.record(z.string(),z.unknown())).parse(value.records);
const recordId=(value:Record<string,unknown>,type:string)=>String(records(value).find(r=>r.type===type)!.recordId);

test('sealed proxy whoami reports the authenticated person and acting agent',async t=>{
 const {a}=await fixture(t);
 const remote=await a.remote.callTool({name:'whoami',arguments:{}});
 assert.deepEqual(await a.client.call('whoami'),remote.structuredContent);
});

test('sealed proxy advertised tools all reach a local handler or input validation',async t=>{
 const {a}=await fixture(t),unhandled:string[]=[];
 const tools=await a.client.tools();
 for(const tool of tools){
  try{await a.client.call(tool.name,{});}catch(error){
   if(error instanceof Error&&error.message==='Unknown local content tool')unhandled.push(tool.name);
   else assert.ok(error instanceof z.ZodError,`${tool.name}: ${String(error)}`);
  }
 }
 assert.deepEqual(unhandled,[]);
 const names=new Set(tools.map(tool=>tool.name));
 for(const name of ['whoami','agent_descriptor_set','task_prepare','task_claim_prepare','task_read'])assert.ok(names.has(name),`${name} stays available`);
});

test('sealed proxy unhandled tools stay hidden and cannot forward plaintext',async t=>{
 const {a}=await fixture(t);
 // Wire operations need local sealing; view/App wrappers need local rendering or sealing.
 const hidden=[
  'journey_descriptor','task_exchange','identity_descriptor','offer_definition',
  'forum_view','forum_topic_create_view','forum_post_create_view','library_view','apps_v2_library',
  'round_view','apps_v2_round','agent_capabilities_view','apps_v2_agents','forum_view_v3','apps_v2_forum',
  'apps_v2_topic','apps_v2_reply','apps_v2_interview_read','apps_v2_interview_write',
  'apps_v2_interview_share','apps_v2_contribute','journey_view','project_view',
  'apps_journey_refresh','apps_project_refresh','apps_artifacts_refresh','apps_journey_policy',
  'apps_journey_invite','apps_project_update','apps_artifact_rename',
 ];
 const listed=await a.remote.listTools(),remoteNames=new Set(listed.tools.map(tool=>tool.name));
 for(const name of hidden.filter(name=>!name.includes('view')&&!name.startsWith('apps_')))assert.ok(remoteNames.has(name),`${name} is registered remotely`);
 const forwarded:unknown[]=[];
 const remote:SealedRemote={
  async listTools(){return {...listed,tools:[...listed.tools,{name:'future_content_write',inputSchema:{type:'object',properties:{body:{type:'string'}}}}]};},
  async callTool(request){forwarded.push(request);return a.remote.callTool(request);},
 };
 const client=await SealedClient.open(remote,a.store,a.client.personId);forwarded.length=0;
 const tools=await client.tools(),names=new Set(tools.map(tool=>tool.name));
 for(const name of [...hidden,'future_content_write']){
  assert.equal(names.has(name),false,`${name} must not be advertised`);
  await assert.rejects(client.call(name,{body:'NEVER-FORWARD-PLAINTEXT'}),/Unknown local content tool/);
 }
 for(const tool of tools)assert.doesNotMatch(tool.name,/^(artifact_|mls_|sealed_|content_)/);
 await assert.rejects(client.call('whoami',{body:'NEVER-FORWARD-PLAINTEXT'}),z.ZodError);
 assert.deepEqual(forwarded,[]);
 await client.call('whoami');assert.deepEqual(forwarded,[{name:'account_read',arguments:{}},{name:'whoami',arguments:{}}]);
});

test('sealed proxy storage canary covers forum library versions projects rounds interviews and contributions',async t=>{
 const {backend,a}=await fixture(t);const markers:string[]=[];const canary=(field:string)=>{const v=`CANARY-${field}-40fa64`;markers.push(v);return v;};
 const journey=await a.client.call('journey_create',{name:canary('journey-name'),policy:'open',defaultRole:'write'}),journeyId=String(journey.journeyId);
 const project=await a.client.call('project_create',{journeyId,name:canary('project-name'),purpose:canary('project-purpose')}),projectId=recordId(project,'project');
 const board=await a.client.call('board_create',{journeyId,name:canary('board-name'),description:canary('board-description')}),boardId=recordId(board,'board');
 const topic=await a.client.call('topic_create',{boardId,title:canary('topic-title'),body:canary('opening-body')}),topicId=recordId(topic,'topic');
 const post=await a.client.call('post_create',{topicId,body:canary('post-body')}),postId=recordId(post,'post');
 await a.client.call('post_edit',{postId,body:canary('post-edit')});
 assert.equal((await a.client.call('topic_read',{topicId})).title,markers.find(x=>x.includes('topic-title')));
 const item=await a.client.call('library_add',{journeyId,name:canary('library-name'),description:canary('library-description'),mimeType:`application/${canary('library-mime')}`,labels:[canary('library-label')],text:canary('library-body'),projectId}),itemId=recordId(item,'library');
 await a.client.call('library_version',{itemId,baseVersion:1,text:canary('library-version')});
 const read=await a.client.call('library_get',{itemId});assert.equal(read.text,markers.at(-1));
 await a.client.call('library_add',{journeyId,name:canary('link-name'),kind:'link',url:`https://example.test/${canary('link-url')}`,summary:canary('link-summary')});
 await a.client.call('library_update',{itemId,name:canary('library-renamed'),description:canary('library-updated-description'),labels:[canary('library-updated-label')]});
 await a.client.call('conversation_post',{journeyId,target:{projectId},body:canary('project-attached-body')});
 await a.client.call('conversation_post',{journeyId,target:{itemId},body:canary('attached-body')});
 const round=await a.client.call('round_create',{journeyId,title:canary('round-title'),goal:canary('round-goal'),format:canary('round-format')}),roundId=recordId(round,'round');
 await a.client.call('interview_write',{roundId,text:canary('interview-private')});
 await a.client.call('interview_share',{roundId});
 await a.client.call('interview_write',{roundId,text:canary('interview-shared-update')});
 await a.client.call('round_status',{roundId,to:'open'});
 await a.client.call('round_contribute',{roundId,text:canary('contribution')});
 const found=await a.client.call('library_search',{journeyId,query:'library-version',includeProjects:true});assert.equal(z.array(z.unknown()).parse(found.items).length,1);
 const stored=[...backend.accountStorage.data.values(),...[...backend.journeyStores.values()].flatMap(s=>[...s.data.values()])];
 for(const bytes of [...stored.map(v=>Buffer.from(v)),...[...backend.blobs.data.values()].map(v=>Buffer.from(v))])for(const marker of markers)assert.equal(bytes.includes(Buffer.from(marker)),false,`plaintext in server storage: ${marker}`);
 assert.equal((await a.client.call('interview_read',{roundId})).text,markers.find(x=>x.includes('interview-shared-update')));
});


test('sealed proxy new readers get live retained journey history but never private interviews',async t=>{
 const {a,connect}=await fixture(t),journey=await a.client.call('journey_create',{name:'Group',policy:'open',defaultRole:'write'}),journeyId=String(journey.journeyId);
 const item=await a.client.call('library_add',{journeyId,name:'Retained title',text:'Retained body'}),itemId=recordId(item,'library');
 const roundId=recordId(await a.client.call('round_create',{journeyId,title:'Round',goal:'Goal'}),'round');
 await a.client.call('interview_write',{roundId,text:'PRIVATE-I-CANARY'});
 const b=await connect('bob');await b.client.call('journey_join',{journeyId});const device=await b.client.prepareGroup(journeyId);await a.client.addMember(journeyId,b.client.personId,device.deviceId);await b.client.sync(journeyId);
 assert.equal((await b.client.call('library_get',{itemId})).text,'Retained body');
 await assert.rejects(b.client.call('interview_read',{roundId,personId:a.client.personId}),{code:'permission'});
 await a.client.call('interview_share',{roundId});assert.equal((await b.client.call('interview_read',{roundId,personId:a.client.personId})).text,'PRIVATE-I-CANARY');
 await a.client.call('round_participants',{roundId,add:[b.client.personId],remove:[]});
 await b.client.call('interview_write',{roundId,text:'BOB-PUBLISHED-PERSISTS'});await b.client.call('interview_share',{roundId});
 const c=await connect('carol');await c.client.call('journey_join',{journeyId});const third=await c.client.prepareGroup(journeyId);await a.client.addMember(journeyId,c.client.personId,third.deviceId);await c.client.sync(journeyId);assert.equal((await c.client.call('interview_read',{roundId,personId:a.client.personId})).text,'PRIVATE-I-CANARY');
 await a.client.call('journey_remove',{journeyId,memberId:b.client.personId});
 await a.client.call('library_version',{itemId,baseVersion:1,text:'After removal'});
 await assert.rejects(b.client.sync(journeyId),{code:'permission'});
 assert.equal((await c.client.call('library_get',{itemId})).text,'After removal');
 assert.equal((await c.client.call('interview_read',{roundId,personId:b.client.personId})).text,'BOB-PUBLISHED-PERSISTS');
});

test('sealed server rejects clear fields unknown formats audience size and incomplete manifests without publication',async t=>{
 const {backend,a}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Group',policy:'open',defaultRole:'write'})).journeyId);
 for(const tool of ['board_create','topic_create','post_create','post_edit','conversation_post','library_add','library_version','library_update','artifact_create','artifact_version','artifact_rename','round_create','round_next','interview_write','interview_share','round_contribute','project_create','project_update']){const before=backend.snapshot();await assert.rejects(backend.sealedExecute('alice',tool,{journeyId,name:'CLEAR',body:'CLEAR',text:'CLEAR'}),/Invalid sealed/);assert.equal(backend.snapshot(),before,tool);}
 const prepared=await backend.sealedExecute('alice','content_prepare',{journeyId,action:'board_create',routing:{}}),ticketId=String(prepared.ticketId),state=JSON.parse(a.files.get('sealed-state')!),deviceId=state.groups[journeyId].deviceId;
 const envelope={groupId:journeyId,epoch:0,ciphertext:'eA==',contentType:'application/vnd.wayfinding.sealed+json;v=1',size:1};
 for(const bad of [{...envelope,groupId:'wrong-audience'},{...envelope,size:2},{...envelope,contentType:'text/plain'},{...envelope,ciphertext:' eA=='},{...envelope,size:1048577}]){const before=backend.snapshot();await assert.rejects(backend.sealedExecute('alice','board_create',{journeyId,ticketId,devices:{[journeyId]:deviceId},envelopes:{descriptor:bad}}));assert.equal(backend.snapshot(),before);}
 await assert.rejects(backend.sealedExecute('alice','board_create',{journeyId,ticketId,devices:{[journeyId]:deviceId},envelopes:{}}),/manifest/);
});


test('sealed large bodies use fresh keys and committed references, and lost replies recover exactly once',async t=>{
 const {backend,a,connect}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Blob',policy:'open',defaultRole:'write'})).journeyId);
 const body='LARGE-SEALED-CANARY-'+ 'x'.repeat(70000),itemId=recordId(await a.client.call('library_add',{journeyId,name:'Large',text:body}),'library');
 assert.equal((await a.client.call('library_get',{itemId})).text,body);
 const packets=()=>Object.values(JSON.parse(a.files.get('sealed-state')!).groups[journeyId].cache) as {context:{recordId:string;revision:number};payload:{blob?:{blob:string;key:string}}}[];
 const first=packets().find(p=>p.context.recordId===itemId)!.payload.blob!;assert.ok(first);
 await a.client.call('library_version',{itemId,baseVersion:1,text:body+'-NEXT'});
 const second=packets().find(p=>p.context.recordId===itemId&&p.context.revision===2)!.payload.blob!;assert.notEqual(first.key,second.key);assert.notEqual(first.blob,second.blob);
 assert.equal((await a.client.call('library_get',{itemId,version:1})).text,body);
 const bytes=backend.blobs.data.get(second.blob)!.slice();backend.blobs.data.set(second.blob,new Uint8Array([1,2,3]));await assert.rejects(a.client.call('library_get',{itemId}),/integrity/);backend.blobs.data.set(second.blob,bytes);
 await assert.rejects(backend.sealedExecute('alice','sealed_blob_get',{journeyId,recordId:'not-a-record',revision:2,blob:second.blob}),/Entitled/);
 await connect('stranger');await assert.rejects(backend.sealedExecute('stranger','sealed_blob_get',{journeyId,recordId:itemId,revision:2,blob:second.blob}));
 const execute=backend.sealedExecute.bind(backend);let lose=true;backend.sealedExecute=async(...args)=>{const r=await execute(...args);if(lose&&args[1]==='library_add'){lose=false;throw new Error('Lost response after commit');}return r;};
 await assert.rejects(a.client.call('library_add',{journeyId,name:'Exactly once',text:'RECOVERED'}));assert.ok(JSON.parse(a.files.get('sealed-state')!).pending);
 const reopened=await SealedClient.open(a.remote,a.store,a.client.personId);assert.equal(JSON.parse(a.files.get('sealed-state')!).pending,undefined);
 const items=z.array(z.record(z.string(),z.unknown())).parse((await reopened.call('library_search',{journeyId,query:'RECOVERED'})).items);assert.equal(items.length,1);assert.equal(items[0]!.text,'RECOVERED');
 for(const blob of backend.blobs.data.values())assert.equal(Buffer.from(blob).includes(Buffer.from('LARGE-SEALED-CANARY')),false);
});

test('sealed audience binding is rechecked at permit issuance after a device revocation race',async t=>{
 const {backend,a,connect}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Fence',policy:'open',defaultRole:'write'})).journeyId),b=await connect('bob');
 await b.client.call('journey_join',{journeyId});const device=await b.client.prepareGroup(journeyId);await a.client.addMember(journeyId,b.client.personId,device.deviceId);
 const issue=backend.accountsHost.issueWrite.bind(backend.accountsHost);let raced=false;
 backend.accountsHost.issueWrite=async request=>{if(!raced&&request.deviceIds?.includes(device.deviceId)){raced=true;await backend.execute('bob',parseCommand('personal_group_remove',{memberId:device.deviceId}));}return issue(request);};
 await assert.rejects(a.client.call('library_add',{journeyId,name:'Must not publish',text:'FENCED'}));assert.equal(raced,true);
 const result=await backend.sealedExecute('alice','sealed_catalog',{journeyId});assert.equal(records(result).filter(r=>r.type==='library').length,0);
});


test('sealed round sources stay private, contributions retain attribution, and closed successors carry synthesis',async t=>{
 const {a}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Rounds',policy:'open',defaultRole:'write'})).journeyId);
 const sourceId=recordId(await a.client.call('library_add',{journeyId,name:'Source',text:'ASSIGNED-PRIVATE-SOURCE'}),'library');
 const roundId=recordId(await a.client.call('round_create',{journeyId,title:'Round',goal:'Learn'}),'round');await a.client.call('interview_assign',{roundId,personId:a.client.personId,itemId:sourceId});
 assert.equal((await a.client.call('interview_read',{roundId})).text,'ASSIGNED-PRIVATE-SOURCE');await a.client.call('interview_write',{roundId,text:'Private changes'});assert.equal((await a.client.call('library_get',{itemId:sourceId})).text,'ASSIGNED-PRIVATE-SOURCE');
 await a.client.call('round_status',{roundId,to:'open'});await a.client.call('round_contribute',{roundId,text:'FIRST-CONTRIBUTION'});await a.client.call('round_contribute',{roundId,text:'SECOND-CONTRIBUTION'});
 const round=await a.client.call('round_read',{roundId}),synthesis=z.object({text:z.string()}).parse(round.synthesis);assert.match(synthesis.text,/FIRST-CONTRIBUTION/);assert.match(synthesis.text,/SECOND-CONTRIBUTION/);assert.ok(synthesis.text.includes(a.client.personId));
 await a.client.call('round_status',{roundId,to:'synthesising'});await a.client.call('round_status',{roundId,to:'closed'});await assert.rejects(a.client.call('round_contribute',{roundId,text:'Too late'}));
 const nextId=recordId(await a.client.call('round_next',{roundId,title:'Next',goal:'Continue'}),'round'),next=await a.client.call('round_read',{roundId:nextId});assert.equal(z.object({text:z.string()}).parse(next.synthesis).text,synthesis.text);
 assert.equal((await a.client.call('journey_read',{journeyId})).name,'Rounds');
});

test('sealed personal artifact copy and move never expose personal names or bodies to storage',async t=>{
 const {backend,a}=await fixture(t),proxy=await WayfindingProxy.open(a.remote,a.store);await proxy.createGroup(proxy.personalGroupId);
 const artifact=await proxy.createArtifact({groupId:proxy.personalGroupId,name:'PRIVATE-ARTIFACT-NAME',type:'text/plain',content:'PRIVATE-ARTIFACT-BODY'});assert.equal((await proxy.readArtifact(proxy.personalGroupId,artifact.artifactId)).content,'PRIVATE-ARTIFACT-BODY');
 const journey=await proxy.call('journey_create',{name:'Destination',policy:'open',defaultRole:'write'}),copy=await proxy.copyArtifact(proxy.personalGroupId,artifact.artifactId,String(journey.journeyId),true);assert.equal((await proxy.readArtifact(String(journey.journeyId),copy.artifactId)).content,'PRIVATE-ARTIFACT-BODY');await assert.rejects(proxy.readArtifact(proxy.personalGroupId,artifact.artifactId));
 assert.equal(backend.snapshot().includes('PRIVATE-ARTIFACT-NAME'),false);for(const blob of backend.blobs.data.values())assert.equal(Buffer.from(blob).includes(Buffer.from('PRIVATE-ARTIFACT-BODY')),false);
});


test('sealed concurrent contributions both publish once without overwriting each other',async t=>{
 const {backend,a,connect}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Concurrent',policy:'open',defaultRole:'write'})).journeyId),b=await connect('bob');
 await b.client.call('journey_join',{journeyId});const device=await b.client.prepareGroup(journeyId);await a.client.addMember(journeyId,b.client.personId,device.deviceId);await b.client.sync(journeyId);
 const roundId=recordId(await a.client.call('round_create',{journeyId,title:'Concurrent round',goal:'Keep both perspectives'}),'round');await a.client.call('round_status',{roundId,to:'open'});
 const execute=backend.sealedExecute.bind(backend);let arrivals=0,release!:()=>void;const ready=new Promise<void>(resolve=>{release=resolve;});backend.sealedExecute=async(...args)=>{if(args[1]==='round_contribute'&&arrivals<2){arrivals++;if(arrivals===2)release();await ready;}return execute(...args);};
 await Promise.all([a.client.call('round_contribute',{roundId,text:'ALICE-CONCURRENT'}),b.client.call('round_contribute',{roundId,text:'BOB-CONCURRENT'})]);
 const result=await a.client.call('round_read',{roundId}),contributions=z.array(z.object({owner:z.string(),text:z.string()})).parse(result.contributions);assert.equal(contributions.length,2);assert.deepEqual(contributions.map(c=>c.text).sort(),['ALICE-CONCURRENT','BOB-CONCURRENT']);assert.deepEqual(new Set(contributions.map(c=>c.owner)),new Set([a.client.personId,b.client.personId]));
});


test('sealed capability-only authors receive an actionable refusal without a silent read or device grant',async()=>{
 const backend=new MemoryBackend({async get(s){return {name:s,email:`${s}@example.test`};}},Date.now,testPasskeys,true);
 const journey=await backend.sealedExecute('alice','journey_create',{policy:'open',defaultRole:'write'}),journeyId=String(journey.journeyId);
 const agentId=String((await backend.sealedExecute('alice','agent_create',{})).agentId);
 await backend.execute('alice',parseCommand('agent_add',{journeyId,agentId}));
 const identity={subject:'alice',clientId:'test-console'},change={kind:'bind' as const,clientId:'writer',agentId};const {challenge}=await backend.beginAuthorization(identity,change);
 await backend.completeAuthorization(identity,change,{id:'synthetic',rawId:'synthetic',type:'public-key',clientExtensionResults:{},response:{clientDataJSON:challenge,authenticatorData:'',signature:'test-valid'}});
 const account=await testAccount(backend,'alice'),signed=await account.detachedDevice({deviceId:'device_ungranted',data:'AQ==',agentId});
 for(const capability of ['device.keys','read'] as const){
  await setAgentCard(backend,'alice',agentId,['post','artifact.write','round.contribute',capability]);const before=backend.snapshot();
  await assert.rejects(backend.sealedExecute('alice','content_prepare',{journeyId,action:'library_add',routing:{}},'writer'),/needs read \+ device.keys; ask the owner/);
  await assert.rejects(backend.sealedExecute('alice','sealed_device_register',signed.registration,'writer'),/needs read \+ device.keys; ask the owner/);
  assert.equal(backend.snapshot(),before,'refusal must neither grant authority nor register a device or content ticket');
 }
});


test('sealed offers keep definitions private and publish current authenticated journey copies',async t=>{
 const {a,backend,connect}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Offers',policy:'open',defaultRole:'write'})).journeyId);
 const agentId=String((await a.client.call('agent_create',{name:'Agent'})).agentId);await setAgentCard(backend,'alice',agentId,['read','task.manage','device.keys']);await a.client.call('agent_add',{journeyId,agentId});
 const markers=['OFFER-NAME-CANARY','OFFER-DESCRIPTION-CANARY','OFFER-TAG-CANARY','OFFER-EXAMPLE-CANARY','OFFER-SCHEMA-CANARY','OFFER-INSTRUCTIONS-CANARY','OFFER-RESOURCE-CANARY','OFFER-OUTPUT-SCHEMA-CANARY'];
 const source={name:markers[0],description:markers[1],tags:[markers[2]],examples:[markers[3]],inputSchema:{type:'object',properties:{value:{type:'string',description:markers[4]}},required:['value'],additionalProperties:false},outputSchema:{type:'object',description:markers[7]},instructions:markers[5],resource:markers[6],journeySettings:{[journeyId]:{enabled:true}}};
 const saved=await a.client.call('offer_set',{agentId,offer:source}),definition={...source,id:z.object({id:z.string()}).parse(saved.offer).id};assert.match(definition.id,/^offer-[0-9a-f-]{36}$/);await a.client.call('offer_publish',{agentId,offerId:definition.id});
 const before=backend.snapshot();await assert.rejects(a.client.call('offer_set',{agentId,offer:{...source,id:'private-human-title'}}));assert.equal(backend.snapshot(),before,'invalid offer ids must not create records or tickets');
 for(const bytes of backend.blobs.data.values())for(const marker of markers)assert.ok(!new TextDecoder().decode(bytes).includes(marker),`blob leaked ${marker}`);
 const result=await a.client.call('offer_search',{journeyId,query:markers[0],tags:[markers[2]]});assert.equal(z.array(z.object({name:z.string()})).parse(result.offers)[0]!.name,markers[0]);
 const b=await connect('bob');await b.client.call('journey_join',{journeyId});const device=await b.client.prepareGroup(journeyId);await a.client.addMember(journeyId,b.client.personId,device.deviceId);const found=await b.client.call('offer_search',{journeyId});assert.equal(z.array(z.object({description:z.string()})).parse(found.offers)[0]!.description,markers[1]);
 const metadata=await backend.sealedExecute('bob','offer_search',{journeyId});assert.equal(JSON.stringify(metadata).includes('privateDefinition'),false);
 const own=await a.client.call('offer_list',{agentId}),offer=z.array(z.record(z.string(),z.unknown())).parse(own.offers)[0]!;assert.equal(offer.name,markers[0],'owner opens the private definition');assert.equal(offer.instructions,markers[5]);const sealed=z.object({privateDefinition:z.record(z.string(),z.unknown()),publications:z.record(z.string(),z.unknown()),contentRevision:z.number()}).parse(offer.sealed);
 await assert.rejects(backend.sealedExecute('alice','offer_set',{agentId,expectedVersion:offer.version,offer:{id:definition.id,sealed:{...sealed,privateDefinition:sealed.publications[journeyId]},journeySettings:{[journeyId]:{enabled:true}},admission:{rules:[],default:'hold'}}}));
 for(const marker of markers){assert.equal(backend.snapshot().includes(marker),false,marker);for(const blob of backend.blobs.data.values())assert.equal(Buffer.from(blob).includes(Buffer.from(marker)),false,marker);}
 await assert.rejects(backend.sealedExecute('alice','offer_set',{agentId,offer:definition}),/Invalid sealed/);
 await assert.rejects(backend.sealedExecute('alice','offer_set',{agentId,offer:{id:'private-human-title',sealed,journeySettings:{[journeyId]:{enabled:true}},admission:{rules:[],default:'hold'}}}),/Invalid sealed/);
});


test('sealed board archive refuses posting and can reopen',async t=>{
 const {a,backend}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Archive',policy:'open',defaultRole:'write'})).journeyId);
 const boardId=recordId(await a.client.call('board_create',{journeyId,name:'Board'}),'board');
 const topicId=recordId(await a.client.call('topic_create',{boardId,title:'Topic',body:'Initial'}),'topic');
 await a.client.call('board_update',{boardId,archived:true});
 const boards=records(await backend.sealedExecute('alice','forum_boards',{journeyId}));
 assert.equal(z.object({scalars:z.object({archived:z.number()})}).parse(boards.find(b=>b.recordId===boardId)!.rule).scalars.archived,1);
 await assert.rejects(a.client.call('post_create',{topicId,body:'Refused'}),{code:'lifecycle'});
 await assert.rejects(a.client.call('topic_create',{boardId,title:'Refused',body:'Refused'}),{code:'lifecycle'});
 await a.client.call('board_update',{boardId,archived:false});
 await a.client.call('post_create',{topicId,body:'Reopened'});
 assert.equal(z.array(z.object({body:z.string()})).parse((await a.client.call('topic_read',{topicId})).posts).at(-1)!.body,'Reopened');
});


test('sealed project membership needs only read for a person and read-only agent',async t=>{
 const {a,backend,connect}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Read membership',policy:'open',defaultRole:'read'})).journeyId);
 const projectId=recordId(await a.client.call('project_create',{journeyId,name:'Project',purpose:'Purpose'}),'project');
 const b=await connect('bob');await b.client.call('journey_join',{journeyId});
 const agentId=String((await backend.sealedExecute('alice','agent_create',{})).agentId);
 await setAgentCard(backend,'alice',agentId,['read']);await backend.execute('alice',parseCommand('agent_add',{journeyId,agentId}));
 const identity={subject:'alice',clientId:'test-console'},change={kind:'bind' as const,clientId:'reader',agentId};
 const {challenge}=await backend.beginAuthorization(identity,change);
 await backend.completeAuthorization(identity,change,{id:'synthetic',rawId:'synthetic',type:'public-key',clientExtensionResults:{},response:{clientDataJSON:challenge,authenticatorData:'',signature:'test-valid'}});
 for(const [subject,clientId] of [['bob',undefined],['alice','reader']] as const){
  const joined=await backend.sealedExecute(subject,'project_join',{journeyId,projectId},clientId);
  assert.equal(z.object({maps:z.object({Members:z.array(z.tuple([z.number(),z.number()]))})}).parse(joined.rule).maps.Members.filter(([,value])=>value===1).length,2);
  const left=await backend.sealedExecute(subject,'project_leave',{journeyId,projectId},clientId);
  assert.equal(z.object({maps:z.object({Members:z.array(z.tuple([z.number(),z.number()]))})}).parse(left.rule).maps.Members.filter(([,value])=>value===1).length,1);
  await assert.rejects(backend.sealedExecute(subject,'content_prepare',{journeyId,action:'project_update',routing:{projectId}},clientId),/project.edit|refused/i);
 }
});


test('rejected sealed admission never consumes cross-journey or cross-account packages',async t=>{
 const {a,backend,connect}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Audience',policy:'open',defaultRole:'read'})).journeyId),b=await connect('bob');
 const otherJourney=String((await backend.sealedExecute('bob','journey_create',{policy:'open',defaultRole:'read'})).journeyId),device=await b.client.prepareGroup(otherJourney);
 const reservations=()=>[...backend.accountStorage.data.entries()].filter(([k])=>k.startsWith('sealed:reservation:'));
 const before=reservations();
 const binding=await backend.accountsHost.deviceBinding(device.deviceId);
 await assert.rejects(backend.accountsHost.reserveDevice({...binding,hash:'stale-authorized-package'},journeyId),/Authorized device binding changed/);
 assert.deepEqual(reservations(),before);
 await assert.rejects(backend.sealedExecute('alice','sealed_package_reserve',{journeyId,groupId:journeyId,deviceId:device.deviceId}),/refused|entitled/i);
 assert.deepEqual(reservations(),before);
 const group=await backend.sealedExecute('alice','sealed_group',{journeyId,groupId:journeyId});
 const sender=z.array(z.object({deviceId:z.string()})).parse(group.devices)[0]!.deviceId;
 await assert.rejects(backend.sealedExecute('alice','sealed_group_commit',{journeyId,groupId:journeyId,deviceId:sender,targetDeviceId:device.deviceId,action:'add',expectedEpoch:group.epoch,expectedSequence:group.sequence,data:'e30='}),/refused|entitled/i);
 assert.deepEqual(reservations(),before);
 await b.client.call('journey_join',{journeyId});
 await a.client.call('library_add',{journeyId,name:'Private',visibility:'private',text:'Synthetic private text'});const privateId=`private_${journeyId.slice(8)}_${a.client.personId}`;
 const privateView=await backend.sealedExecute('alice','sealed_group',{journeyId,groupId:privateId}),privateSender=z.array(z.object({deviceId:z.string()})).parse(privateView.devices)[0]!.deviceId;
 const ownBefore=reservations();
 for(const tool of ['sealed_package_reserve','sealed_group_commit']){
  const args=tool==='sealed_package_reserve'?{deviceId:device.deviceId}:{deviceId:privateSender,targetDeviceId:device.deviceId,action:'add',expectedEpoch:privateView.epoch,expectedSequence:privateView.sequence,data:'e30='};
  await assert.rejects(backend.sealedExecute('alice',tool,{journeyId,groupId:privateId,...args}),/refused|entitled/i);
  assert.deepEqual(reservations(),ownBefore);
 }
 await a.client.addMember(journeyId,b.client.personId,device.deviceId);assert.equal(backend.accountStorage.data.get(`sealed:reservation:${device.deviceId}`),journeyId);
});


test('sealed ciphertext and fetch receipts respect the 128 KiB DO value limit',async t=>{
 const {a,backend,connect}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Large payloads',policy:'open',defaultRole:'write'})).journeyId);
 let largest=0;for(const storage of [backend.accountStorage,...backend.journeyStores.values()]){
  const put=storage.put.bind(storage);storage.put=async(key,value)=>{const size=new TextEncoder().encode(value).length;largest=Math.max(largest,size);assert.ok(size<=128*1024,`DO value limit exceeded: ${key} (${size} bytes)`);await put(key,value);};
 }
 const marker='SYNTHETIC-LARGE-SEALED-',body=marker+'x'.repeat(512*1024),itemId=recordId(await a.client.call('library_add',{journeyId,name:'Large item',text:body}),'library');
 assert.equal((await a.client.call('library_get',{itemId})).text,body);
 const b=await connect('bob');await b.client.call('journey_join',{journeyId});const device=await b.client.prepareGroup(journeyId);await a.client.addMember(journeyId,b.client.personId,device.deviceId);await b.client.sync(journeyId);
 assert.equal((await b.client.call('library_get',{itemId})).text,body);
 await a.client.call('library_version',{itemId,baseVersion:1,text:body+'v2'});await b.client.sync(journeyId);assert.equal((await b.client.call('library_get',{itemId})).text,body+'v2');
 const view=await backend.sealedExecute('alice','sealed_group',{journeyId,groupId:journeyId}),sender=z.array(z.object({deviceId:z.string()})).parse(view.devices)[0]!.deviceId;
 const data=Buffer.alloc(1024*1024,77).toString('base64');
 const committed=await backend.sealedExecute('alice','sealed_group_commit',{journeyId,groupId:journeyId,deviceId:sender,expectedEpoch:view.epoch,expectedSequence:view.sequence,action:'update',data});
 const page=await backend.sealedExecute('alice','sealed_group_fetch',{journeyId,groupId:journeyId,deviceId:sender,since:view.sequence,limit:100});
 assert.equal(z.array(z.object({data:z.string()})).parse(page.messages)[0]!.data,data);assert.equal(page.cursor,committed.sequence);
 const metadata=await backend.sealedExecute('alice','library_get',{journeyId,itemId});const contexts=z.array(z.object({context:z.record(z.string(),z.unknown())})).parse(metadata.content).map(r=>r.context);
 const history=await backend.sealedExecute('alice','sealed_history_post',{journeyId,groupId:journeyId,deviceId:sender,contexts,envelope:{groupId:journeyId,epoch:committed.epoch,ciphertext:data,contentType:'application/vnd.wayfinding.sealed+json;v=1',size:1024*1024}});
 const historyPage=await backend.sealedExecute('alice','sealed_group_fetch',{journeyId,groupId:journeyId,deviceId:sender,since:committed.sequence,limit:100});
 assert.equal(z.array(z.object({data:z.string()})).parse(historyPage.messages)[0]!.data,data);assert.equal(historyPage.cursor,history.sequence);
 for(const raw of [...backend.accountStorage.data.values(),...[...backend.journeyStores.values()].flatMap(s=>[...s.data.values()]),...[...backend.blobs.data.values()].map(b=>new TextDecoder().decode(b))])assert.ok(!String(raw).includes(marker));
 for(const s of backend.journeyStores.values())for(const [key,raw] of s.data)if(key.startsWith('write:receipt:')){const receipt=JSON.parse(String(raw));assert.equal(receipt.result,undefined,'Sealed receipts retain no response bodies');}
 assert.ok(largest<=128*1024);
});


test('sealed device removals are same-person only, never guide power',async t=>{
 const {a,backend,connect}=await fixture(t);
 const journeyId=String((await a.client.call('journey_create',{name:'Removal',policy:'open',defaultRole:'read'})).journeyId);
 const b=await connect('bob');await b.client.call('journey_join',{journeyId});
 const device=await b.client.prepareGroup(journeyId);await a.client.addMember(journeyId,b.client.personId,device.deviceId);
 const view=await backend.sealedExecute('alice','sealed_group',{journeyId,groupId:journeyId});
 const devices=z.array(z.object({deviceId:z.string(),personId:z.string()})).parse(view.devices);
 for(const [subject,sender,target] of [['alice',devices.find(d=>d.personId===a.client.personId)!,device],['bob',device,devices.find(d=>d.personId===a.client.personId)!]] as const){
  await assert.rejects(backend.sealedExecute(subject,'sealed_group_commit',{journeyId,groupId:journeyId,deviceId:sender.deviceId,targetDeviceId:target.deviceId,action:'remove',expectedEpoch:view.epoch,expectedSequence:view.sequence,data:'e30='}),/own devices|ineligible/);
 }
});

test('sealed eligible device admission is automatic between clients',async t=>{
 const {a,connect}=await fixture(t);
 const journeyId=String((await a.client.call('journey_create',{name:'Automatic',policy:'open',defaultRole:'read'})).journeyId);
 const b=await connect('bob');await b.client.call('journey_join',{journeyId});
 assert.equal((await b.client.enrollGroup(journeyId)).admitted,false);
 await a.client.sync(journeyId);
 assert.equal((await b.client.enrollGroup(journeyId)).admitted,true);
});


test('sealed member may remove an own second device without guide authority',async t=>{
 const {a,backend,connect}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Own devices',policy:'open',defaultRole:'read'})).journeyId);
 const b=await connect('bob');await b.client.call('journey_join',{journeyId});const first=await b.client.prepareGroup(journeyId);await a.client.sync(journeyId);
 const second=await connect('bob');const next=await second.client.prepareGroup(journeyId);await a.client.sync(journeyId);
 const view=await backend.sealedExecute('bob','sealed_group',{journeyId,groupId:journeyId});
 await backend.sealedExecute('bob','sealed_group_commit',{journeyId,groupId:journeyId,deviceId:first.deviceId,targetDeviceId:next.deviceId,action:'remove',expectedEpoch:view.epoch,expectedSequence:view.sequence,data:'e30='});
 const after=await backend.sealedExecute('bob','sealed_group',{journeyId,groupId:journeyId});assert.ok(!z.array(z.object({deviceId:z.string()})).parse(after.devices).some(d=>d.deviceId===next.deviceId));
});

test('sealed eligible reader bootstraps a new empty audience without a guide',async t=>{
 const {backend,connect}=await fixture(t),journeyId=String((await backend.sealedExecute('alice','journey_create',{policy:'open',defaultRole:'read'})).journeyId);
 const b=await connect('bob');await b.client.call('journey_join',{journeyId});assert.equal((await b.client.enrollGroup(journeyId)).admitted,true);
});


test('sealed rounds decrypted default guidance contains the first-position interview',async t=>{
 const {a}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Guidance',policy:'open',defaultRole:'write'})).journeyId);
 const roundId=recordId(await a.client.call('round_create',{journeyId,title:'First position',goal:'Locate ourselves'}),'round');
 const round=await a.client.call('round_read',{roundId}),guidance=await a.client.call('library_get',{itemId:round.guidanceItemId});
 assert.equal(String(guidance.text).match(/^\d+\./gm)?.length,15);
 assert.match(String(guidance.text),/Ask one question at a time/);
 assert.doesNotMatch(String(guidance.text),/server can read/);
});


test('sealed direct clients do not advertise incompatible App tools but retain frozen resources',async t=>{
 const {a}=await fixture(t),tools=(await a.rawRemote.listTools()).tools;
 const resources=(await a.rawRemote.listResources()).resources;assert.ok(resources.some(r=>r.uri==='ui://wayfinding/v1/journey.html'));
 for(const name of ['library_view','round_view','forum_view','apps_v2_reply','apps_v2_interview_write']){
  assert.ok(!tools.some(tool=>tool.name===name),name);
  await assert.rejects(a.rawRemote.callTool({name,arguments:{}}),/Unknown tool|not found/i);
 }
});


test('sealed handshakes have a separate budget and a per-person quota',async t=>{
 const {a,backend}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Budget',policy:'open',defaultRole:'write'})).journeyId);
 const store=backend.journeyStores.get(journeyId)!,key=JSON.stringify(['sealed-v1','group',journeyId]);
 const original=JSON.parse(String(await store.get(key))),deviceId=original.devices[0].deviceId;
 const data=Buffer.alloc(1024*1024).toString('base64');let refused=false;
 for(let i=0;i<8;i++){
  const view=await backend.sealedExecute('alice','sealed_group',{journeyId,groupId:journeyId});
  try{await backend.sealedExecute('alice','sealed_group_commit',{journeyId,groupId:journeyId,deviceId,expectedSequence:view.sequence,expectedEpoch:view.epoch,action:'update',data});}
  catch(error){assert.match(String(error),/person.*quota/i);refused=true;break;}
 }
 const after=JSON.parse(String(await store.get(key)));
 assert.equal(after.bytes,original.bytes,'Handshake bytes never consume application content budget');assert.ok(refused,'One person cannot fill the whole retained handshake log');
});

test('sealed abandoned uploads refund their journey reservation and delete unreferenced bytes',async t=>{
 const {a,backend}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Uploads',policy:'open',defaultRole:'write'})).journeyId);
 const state=JSON.parse(a.files.get('sealed-state')!),deviceId=state.groups[journeyId].deviceId;
 const prepared=await backend.sealedExecute('alice','content_prepare',{journeyId,action:'library_add',routing:{visibility:'members'}});
 const upload=await backend.sealedExecute('alice','sealed_blob_put',{journeyId,ticketId:prepared.ticketId,slot:'content',deviceId,data:'eA=='});
 await backend.sealedExecute('alice','content_abandon',{journeyId,ticketId:prepared.ticketId});
 const index=JSON.parse(String(await backend.journeyStores.get(journeyId)!.get(JSON.stringify(['sealed-v1','index']))));
 assert.equal(index.uploadBytes,0);assert.equal(backend.blobs.data.has(String(upload.blob)),false);
 await backend.sealedExecute('alice','content_abandon',{journeyId,ticketId:prepared.ticketId});
 assert.equal(JSON.parse(String(await backend.journeyStores.get(journeyId)!.get(JSON.stringify(['sealed-v1','index'])))).uploadBytes,0);
});


test('sealed expired uploads refund on the next request and retries do not double charge',async t=>{
 let now=Date.now();const {a,backend}=await fixture(t,()=>now),journeyId=String((await a.client.call('journey_create',{name:'Expiry',policy:'open',defaultRole:'write'})).journeyId);
 const deviceId=JSON.parse(a.files.get('sealed-state')!).groups[journeyId].deviceId;
 const prepared=await backend.sealedExecute('alice','content_prepare',{journeyId,action:'library_add',routing:{visibility:'members'}});
 const args={journeyId,ticketId:prepared.ticketId,slot:'content',deviceId,data:'eA=='};
 const upload=await backend.sealedExecute('alice','sealed_blob_put',args);assert.deepEqual(await backend.sealedExecute('alice','sealed_blob_put',args),upload);
 const storage=backend.journeyStores.get(journeyId)!,quota=JSON.stringify(['sealed-v1','upload-quota',a.client.personId]);assert.equal(JSON.parse(String(await storage.get(quota))),1);
 now+=600001;await backend.sealedExecute('alice','sealed_catalog',{journeyId});
 assert.equal(JSON.parse(String(await storage.get(quota))),0);assert.equal(backend.blobs.data.has(String(upload.blob)),false);
 await assert.rejects(backend.sealedExecute('alice','sealed_blob_put',args),/ticket required/);
});

test('sealed per-person upload quotas cannot be charged to another member',async t=>{
 const {a,backend,connect}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Quota',policy:'open',defaultRole:'write'})).journeyId);
 const b=await connect('bob');await b.client.call('journey_join',{journeyId});const device=await b.client.prepareGroup(journeyId);await a.client.sync(journeyId);
 const prepared=await backend.sealedExecute('alice','content_prepare',{journeyId,action:'library_add',routing:{visibility:'members'}});
 await assert.rejects(backend.sealedExecute('alice','sealed_blob_put',{journeyId,ticketId:prepared.ticketId,slot:'content',deviceId:device.deviceId,data:'eA=='}),/Authenticated upload device/);
 const own=JSON.parse(a.files.get('sealed-state')!).groups[journeyId].deviceId,storage=backend.journeyStores.get(journeyId)!;
 await storage.put(JSON.stringify(['sealed-v1','upload-quota',a.client.personId]),JSON.stringify(16*1024*1024));
 await assert.rejects(backend.sealedExecute('alice','sealed_blob_put',{journeyId,ticketId:prepared.ticketId,slot:'content',deviceId:own,data:'eA=='}),/person upload quota/);
});


test('sealed move refuses non-owner deletion before creating any destination copy',async t=>{
 const {a,connect}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Shared source',policy:'open',defaultRole:'write'})).journeyId),b=await connect('bob');
 await b.client.call('journey_join',{journeyId});await b.client.prepareGroup(journeyId);await a.client.sync(journeyId);await b.client.sync(journeyId);
 const itemId=recordId(await a.client.call('library_add',{journeyId,name:'Owned by Alice',text:'Body'}),'library'),destination=String((await b.client.call('journey_create',{name:'Bob destination',policy:'open',defaultRole:'write'})).journeyId),proxy=await WayfindingProxy.open(b.remote,b.store);
 await assert.rejects(proxy.copyArtifact(journeyId,itemId,destination,true));assert.deepEqual(await proxy.listArtifacts(destination),[]);assert.equal((await proxy.readArtifact(journeyId,itemId)).content,'Body');
 const copy=await proxy.copyArtifact(journeyId,itemId,destination,false);assert.equal((await proxy.readArtifact(destination,copy.artifactId)).content,'Body');
});

test('sealed move returns an explicit partial receipt when source deletion is unconfirmed',async t=>{
 const {a}=await fixture(t),journeyId=String((await a.client.call('journey_create',{name:'Source',policy:'open',defaultRole:'write'})).journeyId),itemId=recordId(await a.client.call('library_add',{journeyId,name:'Original',text:'Body'}),'library'),destination=String((await a.client.call('journey_create',{name:'Destination',policy:'open',defaultRole:'write'})).journeyId);
 let deleteAccepted=false;const remote:SealedRemote={listTools:()=>a.remote.listTools(),callTool:async r=>{if(r.name==='library_delete'){if(deleteAccepted)await a.remote.callTool(r);throw new Error('UNTRUSTED deletion transport detail');}return a.remote.callTool(r);}},proxy=await WayfindingProxy.open(remote,a.store);
 const {buildProxyServer}=await import('../src/server.ts'),{InMemoryTransport}=await import('@modelcontextprotocol/server'),server=await buildProxyServer(proxy),client=new Client({name:'partial-move',version:'1'}),[left,right]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(left),client.connect(right)]);t.after(()=>client.close());
 const result=await client.callTool({name:'artifact_move',arguments:{sourceGroupId:journeyId,artifactId:itemId,destinationGroupId:destination}});assert.equal(result.isError,true);assert.doesNotMatch(JSON.stringify(result),/UNTRUSTED/);
 const receipt=z.object({status:z.literal('partial'),sourceArtifactId:z.literal(itemId),destinationArtifactId:z.string(),sourceState:z.literal('unknown'),destinationState:z.literal('created')}).parse(result.structuredContent);
 assert.equal((await proxy.readArtifact(destination,receipt.destinationArtifactId)).content,'Body');assert.equal((await proxy.listArtifacts(destination)).length,1);
 deleteAccepted=true;const lostReply=await client.callTool({name:'artifact_move',arguments:{sourceGroupId:journeyId,artifactId:itemId,destinationGroupId:destination}});assert.equal(lostReply.isError,true);
 const accepted=z.object({status:z.literal('partial'),sourceState:z.literal('unknown'),destinationArtifactId:z.string()}).parse(lostReply.structuredContent);assert.equal((await proxy.readArtifact(destination,accepted.destinationArtifactId)).content,'Body');await assert.rejects(proxy.readArtifact(journeyId,itemId));
});
