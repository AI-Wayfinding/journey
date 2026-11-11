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
test('proxy: removed member cannot decrypt a new version of an old artifact with a cached key',async t=>{
 const {a,b,c,backend}=await fixture(t);
 const groupId=String((await a.proxy.call('journey_create',{name:'Key rotation',policy:'open',defaultRole:'write'})).journeyId);
 await b.proxy.call('journey_join',{journeyId:groupId});await c.proxy.call('journey_join',{journeyId:groupId});
 await a.proxy.createGroup(groupId);
 for(const member of [b,c]){const prepared=await member.proxy.prepareGroup(groupId);await a.proxy.addMember(groupId,member.proxy.personId,prepared.deviceId);await member.proxy.sync(groupId);}
 const artifact=await a.proxy.createArtifact({groupId,name:'Revision',type:'text/plain',content:'SYNTHETIC-BEFORE'});
 assert.equal((await b.proxy.readArtifact(groupId,artifact.artifactId)).content,'SYNTHETIC-BEFORE');
 const oldKey=JSON.parse((await b.store.read('state'))!).groups[groupId].keys[artifact.artifactId] as string;
 await a.proxy.call('journey_remove',{journeyId:groupId,memberId:b.proxy.personId});
 await a.proxy.updateArtifact({groupId,artifactId:artifact.artifactId,content:'SYNTHETIC-AFTER-OLD-ARTIFACT'});
 assert.equal((await c.proxy.readArtifact(groupId,artifact.artifactId)).content,'SYNTHETIC-AFTER-OLD-ARTIFACT');
 const {decrypt}=await import('../src/crypto.ts');
 const {encode}=await import('../src/codec.ts');
 const versions=[...backend.blobs.data.entries()].filter(([key])=>{const parts=JSON.parse(key);return parts[0]==='artifact'&&parts[1]===groupId&&parts[2]===artifact.artifactId&&parts[3]===2;});
 assert.equal(versions.length,1);
 // Test the actual encrypted bytes independently of HTTP denial and the removed flag.
 await assert.rejects(decrypt(encode(versions[0]![1]),decode(oldKey),groupId,artifact.artifactId,2));
 const currentKey=JSON.parse((await a.store.read('state'))!).groups[groupId].keys[artifact.artifactId];
 assert.notEqual(currentKey,oldKey);
});
test('proxy: authenticated MLS artifact ids cannot write through the revision cache prototype',async t=>{
 const {a,b}=await fixture(t);
 assert.equal(Object.hasOwn(Object.prototype,'1'),false);
 t.after(()=>{Reflect.deleteProperty(Object.prototype,'1');});
 const groupId=String((await a.proxy.call('journey_create',{name:'Cache identifiers',policy:'open',defaultRole:'write'})).journeyId);
 await b.proxy.call('journey_join',{journeyId:groupId});await a.proxy.createGroup(groupId);
 const prepared=await b.proxy.prepareGroup(groupId);await a.proxy.addMember(groupId,b.proxy.personId,prepared.deviceId);await b.proxy.sync(groupId);
 const {createMlsGroup}=await import('../src/mls/index.ts');
 const {encode,json}=await import('../src/codec.ts');
 const sender=await createMlsGroup(new TextEncoder().encode('synthetic-sender'));await sender.importState(decode(await a.proxy.exportGroup(groupId)));
 const key=encode(new Uint8Array(32));
 const message=await sender.seal(json({action:'keys',entries:[{artifact:{artifactId:'__proto__',name:'Synthetic',type:'text',size:0,version:1,deleted:false},key}],members:[]}));
 const posted=await a.remote.callTool({name:'mls_message_post',arguments:{groupId,epoch:sender.epoch,kind:'application',data:encode(message)}});
 assert.notEqual(posted.isError,true);const [syncResult]=await Promise.allSettled([b.proxy.sync(groupId)]);
 assert.equal(Object.hasOwn(Object.prototype,'1'),false,'an authenticated artifact id must not modify Object.prototype');
 assert.equal(syncResult!.status,'fulfilled');
});
test('proxy: every personal artifact revision rotates its key and an aborted upload preserves the old readable revision',async t=>{
 const {a,backend,connect}=await fixture(t),groupId=a.proxy.personalGroupId;
 await a.proxy.createGroup(groupId);
 const artifact=await a.proxy.createArtifact({groupId,name:'Personal revisions',type:'text/plain',content:'SYNTHETIC-V1'});
 const key1=JSON.parse((await a.store.read('state'))!).groups[groupId].keys[artifact.artifactId];
 const put=backend.blobs.put.bind(backend.blobs);
 backend.blobs.put=async(key,value)=>{if(JSON.parse(key)[0]==='artifact'&&JSON.parse(key)[3]===2)throw new Error('Synthetic blob upload failure');await put(key,value);};
 await assert.rejects(a.proxy.updateArtifact({groupId,artifactId:artifact.artifactId,content:'SYNTHETIC-FAILED-V2'}),{message:'Remote artifact_blob_put refused: [{"type":"text","text":"Coordination operation failed"}]'});
 assert.equal((await a.proxy.readArtifact(groupId,artifact.artifactId)).content,'SYNTHETIC-V1');
 const failedKey=JSON.parse((await a.store.read('state'))!).groups[groupId].revisionKeys.find((entry:{artifactId:string;version:number})=>entry.artifactId===artifact.artifactId&&entry.version===2).key;
 assert.equal(typeof failedKey,'string');
 await a.store.close();backend.blobs.put=put;
 const resumed=await connect('alice',a.dir);
 assert.equal((await resumed.proxy.readArtifact(groupId,artifact.artifactId)).content,'SYNTHETIC-V1');
 await resumed.proxy.updateArtifact({groupId,artifactId:artifact.artifactId,content:'SYNTHETIC-V2'});
 const key2=JSON.parse((await resumed.store.read('state'))!).groups[groupId].keys[artifact.artifactId];
 assert.notEqual(key2,key1);assert.notEqual(key2,failedKey);
 await resumed.proxy.updateArtifact({groupId,artifactId:artifact.artifactId,content:'SYNTHETIC-V3'});
 const key3=JSON.parse((await resumed.store.read('state'))!).groups[groupId].keys[artifact.artifactId];
 assert.notEqual(key3,key2);assert.notEqual(key3,key1);
 assert.equal((await resumed.proxy.readArtifact(groupId,artifact.artifactId)).content,'SYNTHETIC-V3');
});
// This guards the existing artifact body path only, not the still-plaintext forum/library/round paths.
test('proxy: artifact body canary never reaches DO values side keys or blob bytes',async t=>{
 const {a,backend}=await fixture(t),groupId=a.proxy.personalGroupId,marker='SYNTHETIC-STORAGE-SCAN-CANARY-ROTATION';
 await a.proxy.createGroup(groupId);
 const artifact=await a.proxy.createArtifact({groupId,name:'Storage scan',type:'text/plain',content:marker});
 const records=[...backend.accountStorage.data.entries(),...[...backend.journeyStores.values()].flatMap(s=>[...s.data.entries()])];
 assert.ok(records.some(([key])=>key==='accounts'));
 assert.ok(records.some(([key])=>key===JSON.stringify(['artifactVersions',groupId,artifact.artifactId])));
 assert.ok([...backend.blobs.data.keys()].some(key=>{const parts=JSON.parse(key);return parts[0]==='artifact'&&parts[1]===groupId&&parts[2]===artifact.artifactId;}));
 const bytes=[...records.map(([key,value])=>Buffer.from(key+value)),...[...backend.blobs.data.entries()].map(([key,value])=>Buffer.concat([Buffer.from(key),Buffer.from(value)]))];
 for(const value of bytes)assert.equal(value.includes(Buffer.from(marker)),false,'artifact plaintext marker found in server storage');
 assert.equal((await a.proxy.readArtifact(groupId,artifact.artifactId)).content,marker);
});
test('proxy: malformed local JSON refuses without exposing stored content in errors',async t=>{
 const {a}=await fixture(t);
 const store={async read(){return '{"SYNTHETIC-LOCAL-SECRET":';},async write(){throw new Error('Unexpected write');}};
 await assert.rejects(WayfindingProxy.open(a.remote,store),{message:'Invalid local or MLS JSON'});
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
