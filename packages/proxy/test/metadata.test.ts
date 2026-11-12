import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {MemoryBackend} from '../../mcp/src/backend.ts';
import {app,bridge,keyPair,RESOURCE,token,testPasskeys} from '../../mcp/test/helpers.ts';
import {SealedClient} from '../src/sealed-client.ts';
import {scalar,cell} from '../../mcp/src/rules.ts';

async function fixture(t:TestContext,sealed:boolean){
 const backend=new MemoryBackend({async get(s){return {name:s,email:`${s}@example.test`};}},Date.now,testPasskeys,sealed),signer=await keyPair('metadata');
 const connect=async(subject:string)=>{
  const remote=new Client({name:'metadata-test',version:'1'});await remote.connect(new StreamableHTTPClientTransport(RESOURCE,{fetch:bridge(app(signer,backend)),requestInit:{headers:{authorization:`Bearer ${await token(signer,{sub:subject})}`}}}));t.after(()=>remote.close());
  const call=async(name:string,input:Record<string,unknown>={})=>{const r=await remote.callTool({name,arguments:input});if(r.isError)throw new Error(JSON.stringify(r.content));return r.structuredContent as Record<string,unknown>;};
  const personId=String((await call('account_read')).personId),files=new Map<string,string>();
  const client=sealed?await SealedClient.open(remote,{async read(k){return files.get(k)},async write(k,v){files.set(k,v)}},personId):undefined;
  return {personId,client,call:client?(name:string,input:Record<string,unknown>={})=>client.call(name,input):call};
 };
 const a=await connect('alice'),b=await connect('bob'),journeyId=String((await a.call('journey_create',{name:'Metadata contract',policy:'open',defaultRole:'write'})).journeyId);
 await b.call('journey_join',{journeyId});
 if(sealed){const device=await b.client!.prepareGroup(journeyId);await a.client!.addMember(journeyId,b.personId,device.deviceId);await b.client!.sync(journeyId);}
 const id=(r:Record<string,unknown>,kind:string)=>String(sealed?(r.records as Record<string,unknown>[]).find(v=>v.type===kind)![kind==='library'?'itemId':`${kind}Id`]:r[kind==='library'?'itemId':`${kind}Id`]);
 return {a,b,journeyId,id};
}

// The same contract runs against both metadata hosts; content representation is irrelevant.
for(const sealed of [false,true]){
 test(`metadata contract ${sealed?'sealed':'legacy'}: writers version and update; ownership guards visibility and deletion`,async t=>{
  const {a,b,journeyId,id}=await fixture(t,sealed);
  const itemId=id(await a.call('library_add',{journeyId,name:'Original',text:'v1',storage:'server'}),'library');
  await b.call('library_version',{itemId,baseVersion:1,text:'v2'});
  await assert.rejects(b.call('library_version',{itemId,baseVersion:1,text:'stale'}));
  await b.call('library_update',{itemId,name:'Writer metadata'});
  await assert.rejects(b.call('library_update',{itemId,visibility:'private'}));
  await assert.rejects(b.call('library_delete',{itemId}));
  const read=await a.call('library_get',{itemId});assert.equal(read.text,'v2');assert.equal(read.name,'Writer metadata');assert.equal(read.owner,a.personId);
  if(sealed){assert.equal(scalar(read.rule as Parameters<typeof scalar>[0],'version'),2);assert.equal(scalar(read.rule as Parameters<typeof scalar>[0],'edits'),1);}
  await b.call('library_version',{itemId,baseVersion:2,text:'v3'});assert.equal((await a.call('library_get',{itemId})).version,3);
  if(sealed)assert.equal((await a.call('library_get',{itemId,version:1})).text,'v1');
  await a.call('library_delete',{itemId});await assert.rejects(a.call('library_get',{itemId}));
 });
 test(`metadata contract ${sealed?'sealed':'legacy'}: topic attribution, locks and moderation preserve author edits`,async t=>{
  const {a,b,journeyId,id}=await fixture(t,sealed),boardId=id(await a.call('board_create',{journeyId,name:'Board'}),'board');
  const created=await b.call('topic_create',{boardId,title:'Writer topic',body:'Opening'}),topicId=id(created,'topic');
  const thread=await b.call('topic_read',{topicId}),posts=thread.posts as Record<string,unknown>[],postId=String(posts[0]!.postId);
  await assert.rejects(a.call('post_edit',{postId,body:'Impersonation'}));
  await b.call('topic_lock',{topicId});await assert.rejects(b.call('post_create',{topicId,body:'Locked'}));
  await b.call('post_edit',{postId,body:'Author correction'});
  await assert.rejects(b.call('post_hide',{postId}));await a.call('post_hide',{postId});await a.call('post_unhide',{postId});
  await a.call('topic_unlock',{topicId});await b.call('post_create',{topicId,body:'Unlocked'});
  const final=await b.call('topic_read',{topicId});assert.equal((final.posts as Record<string,unknown>[])[0]!.body,'Author correction');
  if(sealed){assert.equal(cell(final.rule as Parameters<typeof cell>[0],'Topics',0),1);const post=(final.posts as Record<string,unknown>[])[0]!;assert.equal(scalar(post.rule as Parameters<typeof scalar>[0],'edits'),1);assert.equal(scalar(post.rule as Parameters<typeof scalar>[0],'hidden'),0);}
 });
 test(`metadata contract ${sealed?'sealed':'legacy'}: one attached conversation, authored by its creator not its target owner`,async t=>{
  const {a,b,journeyId,id}=await fixture(t,sealed),itemId=id(await a.call('library_add',{journeyId,name:'Target',text:'Body',storage:'server'}),'library'),target={itemId};
  await b.call('conversation_post',{journeyId,target,body:'First'});await b.call('conversation_post',{journeyId,target,body:'Second'});
  const read=await b.call('conversation_read',{journeyId,target}),topicId=String(sealed?read.topicId:(read.topic as Record<string,unknown>).topicId);
  const listed=await b.call('topic_list',{journeyId,attachedTo:target}),topics=sealed?listed.records:listed.topics;assert.ok(Array.isArray(topics));assert.equal(topics.length,1);
  await b.call('topic_lock',{topicId});await assert.rejects(a.call('conversation_post',{journeyId,target,body:'Locked'}));await b.call('topic_unlock',{topicId});
  await a.call('conversation_post',{journeyId,target,body:'Third'});assert.equal((await a.call('conversation_read',{journeyId,target})).posts instanceof Array,true);
 });
}
