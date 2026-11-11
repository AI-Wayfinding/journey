import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {MemoryBackend} from '../../mcp/src/backend.ts';
import {app,bridge,keyPair,RESOURCE,token,testPasskeys,setAgentCard} from '../../mcp/test/helpers.ts';
import {SealedClient} from '../src/sealed-client.ts';
import {WayfindingProxy} from '../src/proxy.ts';
import {parseCommand} from '../../mcp/src/commands.ts';
import * as z from 'zod';

async function fixture(t:TestContext){
 const backend=new MemoryBackend({async get(s){return {name:s,email:`${s}@example.test`};}},Date.now,testPasskeys,true),signer=await keyPair('sealed');
 const connect=async(subject:string)=>{const remote=new Client({name:'sealed-test',version:'1'});await remote.connect(new StreamableHTTPClientTransport(RESOURCE,{fetch:bridge(app(signer,backend)),requestInit:{headers:{authorization:`Bearer ${await token(signer,{sub:subject})}`}}}));t.after(()=>remote.close());const files=new Map<string,string>(),store={async read(k:string){return files.get(k)},async write(k:string,v:string){files.set(k,v)}};return {client:await SealedClient.open(remote,store,z.object({personId:z.string()}).parse((await remote.callTool({name:'account_read',arguments:{}})).structuredContent).personId),remote,files,store};};
 return {backend,connect,a:await connect('alice')};
}
const records=(value:Record<string,unknown>)=>z.array(z.record(z.string(),z.unknown())).parse(value.records);
const recordId=(value:Record<string,unknown>,type:string)=>String(records(value).find(r=>r.type===type)!.recordId);

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
 await assert.rejects(b.client.call('interview_read',{roundId,personId:a.client.personId}),/private/);
 await a.client.call('interview_share',{roundId});assert.equal((await b.client.call('interview_read',{roundId,personId:a.client.personId})).text,'PRIVATE-I-CANARY');
 await a.client.call('round_participants',{roundId,add:[b.client.personId],remove:[]});
 await b.client.call('interview_write',{roundId,text:'BOB-PUBLISHED-PERSISTS'});await b.client.call('interview_share',{roundId});
 const c=await connect('carol');await c.client.call('journey_join',{journeyId});const third=await c.client.prepareGroup(journeyId);await a.client.addMember(journeyId,c.client.personId,third.deviceId);await c.client.sync(journeyId);assert.equal((await c.client.call('interview_read',{roundId,personId:a.client.personId})).text,'PRIVATE-I-CANARY');
 await a.client.call('journey_remove',{journeyId,memberId:b.client.personId});
 await a.client.call('library_version',{itemId,baseVersion:1,text:'After removal'});
 await assert.rejects(b.client.sync(journeyId),/refused|required|member|not found/i);
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
 for(const capability of ['device.keys','read'] as const){
  await setAgentCard(backend,'alice',agentId,['post','artifact.write','round.contribute',capability]);const before=backend.snapshot();
  await assert.rejects(backend.sealedExecute('alice','content_prepare',{journeyId,action:'library_add',routing:{}},'writer'),/needs read \+ device.keys; ask the owner/);
  await assert.rejects(backend.sealedExecute('alice','sealed_device_register',{deviceId:'device_ungranted',verificationKey:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',data:'AQ=='},'writer'),/needs read \+ device.keys; ask the owner/);
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
