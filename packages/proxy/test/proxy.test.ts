import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,stat,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client,StreamableHTTPClientTransport,InMemoryTransport} from '@modelcontextprotocol/client';
import {MemoryBackend} from '../../mcp/src/backend.ts';
import {app,bridge,keyPair,RESOURCE,token} from '../../mcp/test/helpers.ts';
import {WayfindingProxy} from '../src/proxy.ts';
import {FileStore} from '../src/file-store.ts';
import {buildProxyServer} from '../src/server.ts';
import {decode} from '../src/codec.ts';
import * as z from 'zod';

async function fixture(t:TestContext) {
 const backend=new MemoryBackend({async get(s){return {name:s,email:`${s}@example.test`};}});
 const signer=await keyPair('proxy');
 const dirs:string[]=[],stores:FileStore[]=[];
 t.after(async()=>{for(const s of stores)await s.close();for(const d of dirs)await rm(d,{recursive:true,force:true});});
 const connect=async(s:string,dir?:string,fault?:{loseNextPost:boolean})=>{
  const remote=new Client({name:'proxy-test',version:'1'});
  const send=bridge(app(signer,backend));
  await remote.connect(new StreamableHTTPClientTransport(RESOURCE,{fetch:async(url,init)=>{
   const response=await send(String(url),init);
   const request=typeof init?.body==='string'?JSON.parse(init.body):undefined;
   if(fault?.loseNextPost&&request?.method==='tools/call'&&request.params.name==='mls_message_post'){
    fault.loseNextPost=false;await response.text();throw new Error('Synthetic response lost after delivery');
   }
   return response;
  },requestInit:{headers:{authorization:`Bearer ${await token(signer,{sub:s})}`}}}));
  t.after(()=>remote.close());
  const directory=dir??await mkdtemp(join(tmpdir(),'wayfinding-proxy-')); if(!dir)dirs.push(directory);
  const store=await FileStore.open(directory);
  stores.push(store);
  const proxy=await WayfindingProxy.open(remote,store);
  return {proxy,store,remote,dir:directory};
 };
 const a=await connect('alice'),b=await connect('bob'),c=await connect('carol');
 return {backend,connect,a,b,c};
}

test('proxy: three local agents share encrypted artifacts, later history, removal, personal copy/move and restart',async t=>{
 const {a,b,c,backend,connect}=await fixture(t);
 const journey=await a.proxy.call('journey_create',{name:'Synthetic',policy:'open',defaultRole:'write'});
 const groupId=journey.journeyId as string;
 await b.proxy.call('journey_join',{journeyId:groupId});
 await a.proxy.createGroup(groupId);
 const bp=await b.proxy.prepareGroup(groupId);
 await a.proxy.addMember(groupId,b.proxy.personId,bp.deviceId);
 await b.proxy.sync(groupId);
 const marker='SYNTHETIC-PLAINTEXT-PROXY-2026';
 const artifact=await a.proxy.createArtifact({groupId,name:'Doc',type:'text/plain',content:marker});
 assert.equal((await b.proxy.readArtifact(groupId,artifact.artifactId)).content,marker);
 await b.proxy.updateArtifact({groupId,artifactId:artifact.artifactId,content:'SYNTHETIC-UPDATE'});
 assert.equal((await a.proxy.readArtifact(groupId,artifact.artifactId)).content,'SYNTHETIC-UPDATE');
 await c.proxy.call('journey_join',{journeyId:groupId});
 const cp=await c.proxy.prepareGroup(groupId);
 await b.proxy.addMember(groupId,c.proxy.personId,cp.deviceId);
 await a.proxy.sync(groupId); // existing member notices add and re-shares entitled history
 assert.equal((await c.proxy.readArtifact(groupId,artifact.artifactId)).content,'SYNTHETIC-UPDATE');
 const personal=a.proxy.personalGroupId;
 await a.proxy.createGroup(personal);
 const secret=await a.proxy.createArtifact({groupId:personal,name:'Private',type:'text/plain',content:'SYNTHETIC-PERSONAL'});
 await assert.rejects(b.proxy.readArtifact(personal,secret.artifactId));
 await assert.rejects(c.proxy.prepareGroup(personal));
 const originalKey=JSON.parse((await a.store.read('state'))!).groups[personal].keys[secret.artifactId];
 const copied=await a.proxy.copyArtifact(personal,secret.artifactId,groupId,false);
 assert.notEqual(originalKey,JSON.parse((await a.store.read('state'))!).groups[groupId].keys[copied.artifactId]);
 assert.equal((await b.proxy.readArtifact(groupId,copied.artifactId)).content,'SYNTHETIC-PERSONAL');
 assert.equal((await a.proxy.readArtifact(personal,secret.artifactId)).content,'SYNTHETIC-PERSONAL');
 const moved=await a.proxy.copyArtifact(personal,secret.artifactId,groupId,true);
 assert.equal((await c.proxy.readArtifact(groupId,moved.artifactId)).content,'SYNTHETIC-PERSONAL');
 await assert.rejects(a.proxy.readArtifact(personal,secret.artifactId),/not found|deleted/);
 const local=JSON.parse((await a.store.read('state'))!);
 const keys=[originalKey,...Object.values(local.groups).flatMap((g:unknown)=>Object.values((g as {keys:Record<string,string>}).keys))];
 assert.ok(keys.length>=3);
 const serverValues=[...backend.accountStorage.data.values(),...[...backend.journeyStores.values()].flatMap(s=>[...s.data.values()])];
 const allBytes=[...serverValues.map(v=>Buffer.from(v)),...[...backend.blobs.data.values()].map(v=>Buffer.from(v))];
 for(const bytes of allBytes) {
  for(const plain of [marker,'SYNTHETIC-UPDATE','SYNTHETIC-PERSONAL'])assert.equal(bytes.includes(Buffer.from(plain)),false);
  for(const key of keys) {assert.equal(bytes.includes(Buffer.from(decode(String(key)))),false);assert.equal(bytes.includes(Buffer.from(String(key))),false);}
 }
 assert.equal(local.groups[personal].keys[secret.artifactId],undefined,'move forgets source key');
 assert.equal([...backend.blobs.data.keys()].some(k=>k.startsWith(JSON.stringify(['artifact',personal,secret.artifactId]).slice(0,-1)+',')),false,'move removes every source blob');
 const prior=await b.proxy.exportGroup(groupId);
 await c.proxy.removeMember(groupId,b.proxy.personId);
 await a.proxy.call('journey_remove',{journeyId:groupId,memberId:b.proxy.personId});
 const fresh=await a.proxy.createArtifact({groupId,name:'After',type:'text/plain',content:'SYNTHETIC-AFTER-REMOVAL'});
 assert.equal((await c.proxy.readArtifact(groupId,fresh.artifactId)).content,'SYNTHETIC-AFTER-REMOVAL');
 await assert.rejects(b.proxy.readArtifact(groupId,fresh.artifactId));
 // Crypto rejection independently of the HTTP membership gate.
 const {createMlsGroup}=await import('../src/mls/index.ts');
 const stale=await createMlsGroup(new TextEncoder().encode('stale'));
 await stale.importState(decode(prior));
 const messages=[...backend.blobs.data.entries()].filter(([k])=>k.startsWith(JSON.stringify(['mls',groupId]).slice(0,-1)+','));
 const removedCommit=JSON.parse(new TextDecoder().decode(messages.at(-2)![1]));
 await stale.processHandshake(decode(removedCommit.commit));
 await assert.rejects(stale.open(messages.at(-1)![1]));
 await a.store.close();
 const resumed=await connect('alice',a.dir);
 assert.equal((await resumed.proxy.readArtifact(groupId,fresh.artifactId)).content,'SYNTHETIC-AFTER-REMOVAL');
 for(const file of await readdir(a.dir)) assert.equal((await stat(join(a.dir,file))).mode&0o777,0o600);
 const disk=await readFile(join(a.dir,'state.json'),'utf8');
 assert.equal(disk.includes('SYNTHETIC-AFTER-REMOVAL'),false);
 const finalKeys=[originalKey,...Object.values(JSON.parse((await resumed.store.read('state'))!).groups).flatMap((g:unknown)=>Object.values((g as {keys:Record<string,string>}).keys))];
 const finalValues=[...backend.accountStorage.data.values(),...[...backend.journeyStores.values()].flatMap(s=>[...s.data.values()])];
 assert.ok(finalValues.length>0);assert.ok(backend.blobs.data.size>0);
 for(const bytes of [...finalValues.map(v=>Buffer.from(v)),...[...backend.blobs.data.values()].map(v=>Buffer.from(v))]){
  for(const plain of [marker,'SYNTHETIC-UPDATE','SYNTHETIC-PERSONAL','SYNTHETIC-AFTER-REMOVAL'])assert.equal(bytes.includes(Buffer.from(plain)),false);
  for(const key of finalKeys){assert.equal(bytes.includes(Buffer.from(decode(String(key)))),false);assert.equal(bytes.includes(Buffer.from(String(key))),false);}
 }
});

test('proxy: stdio-facing MCP exposes artifact lifecycle, MLS controls and coordination but no raw blob bypass',async t=>{
 const {a}=await fixture(t);
 const server=await buildProxyServer(a.proxy);
 const [left,right]=InMemoryTransport.createLinkedPair();
 const local=new Client({name:'local-agent',version:'1'});
 await Promise.all([server.connect(left),local.connect(right)]);t.after(()=>local.close());
 const names=(await local.listTools()).tools.map(t=>t.name);
 for(const n of ['artifact_create','artifact_read','artifact_list','artifact_update','artifact_copy','artifact_move','artifact_delete','journey_create','mls_group_create','mls_group_prepare','mls_group_add','mls_group_remove','mls_group_sync'])assert.ok(names.includes(n),n);
 assert.equal(names.includes('artifact_blob_put'),false);
 const groupId=a.proxy.personalGroupId;await a.proxy.createGroup(groupId);
 const result=await local.callTool({name:'artifact_create',arguments:{groupId,name:'MCP',type:'text/plain',content:'SYNTHETIC-MCP'}});
 assert.notEqual(result.isError,true);
 const id=z.object({artifactId:z.string()}).parse(result.structuredContent).artifactId;
 const read=await local.callTool({name:'artifact_read',arguments:{groupId,artifactId:id}});
 assert.equal(z.object({content:z.string()}).parse(read.structuredContent).content,'SYNTHETIC-MCP');
 const refusal=await local.callTool({name:'artifact_create',arguments:{groupId,name:'Bad',type:'text/plain',content:'SYNTHETIC',authority:true}});
 assert.equal(refusal.isError,true);
});


test('proxy: personal groups admit only owned devices and synchronize private history and deletion',async t=>{
 const {a,b,connect}=await fixture(t);
 const groupId=a.proxy.personalGroupId;
 await a.proxy.createGroup(groupId);
 const privateArtifact=await a.proxy.createArtifact({groupId,name:'Private history',type:'text',content:'SYNTHETIC-OWNED-DEVICES'});
 const second=await connect('alice');
 const prepared=await second.proxy.prepareGroup(groupId);
 await assert.rejects(a.proxy.addMember(groupId,b.proxy.personId,prepared.deviceId),/only the owner/);
 await a.proxy.addMember(groupId,a.proxy.personId,prepared.deviceId);
 assert.equal((await second.proxy.readArtifact(groupId,privateArtifact.artifactId)).content,'SYNTHETIC-OWNED-DEVICES');
 await second.proxy.updateArtifact({groupId,artifactId:privateArtifact.artifactId,content:'SYNTHETIC-DEVICE-UPDATE'});
 assert.equal((await a.proxy.readArtifact(groupId,privateArtifact.artifactId)).content,'SYNTHETIC-DEVICE-UPDATE');
 await a.proxy.deleteArtifact(groupId,privateArtifact.artifactId);
 assert.deepEqual(await second.proxy.listArtifacts(groupId),[]);
 await assert.rejects(second.proxy.readArtifact(groupId,privateArtifact.artifactId),/not found|deleted/);
});


test('proxy: ambiguous MLS delivery fails closed in memory and after a file-store restart',async t=>{
 const {connect,backend}=await fixture(t);
 const fault={loseNextPost:false},a=await connect('ambiguous',undefined,fault);
 const groupId=a.proxy.personalGroupId;await a.proxy.createGroup(groupId);
 fault.loseNextPost=true;
 await assert.rejects(a.proxy.createArtifact({groupId,name:'Lost response',type:'text',content:'SYNTHETIC-AMBIGUOUS'}),/response lost/);
 const afterDelivery=backend.snapshot();
 await assert.rejects(a.proxy.createArtifact({groupId,name:'Retry',type:'text',content:'MUST-NOT-SEND'}),/refusing unsafe retry/);
 assert.equal(backend.snapshot(),afterDelivery);
 await a.store.close();
 const restored=await connect('ambiguous',a.dir);
 await assert.rejects(restored.proxy.sync(groupId),/refusing unsafe retry/);
 assert.equal(backend.snapshot(),afterDelivery);
});
