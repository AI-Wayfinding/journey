import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {MemoryBackend} from '../../mcp/src/backend.ts';
import {app,bridge,keyPair,RESOURCE,token} from '../../mcp/test/helpers.ts';
import {WayfindingProxy} from '../src/proxy.ts';
import {createMlsGroup} from '../src/mls/index.ts';
import {decode} from '../src/codec.ts';
import type {LocalStore} from '../src/store.ts';

test('proxy: a server-side removal forces an MLS removal before any later content key is distributed',async t=>{
 const backend=new MemoryBackend({async get(s){return {name:s,email:`${s}@example.test`};}}),signer=await keyPair('reconcile');
 const connect=async(sub:string)=>{const client=new Client({name:'proxy',version:'1'});await client.connect(new StreamableHTTPClientTransport(RESOURCE,{fetch:bridge(app(signer,backend)),requestInit:{headers:{authorization:`Bearer ${await token(signer,{sub})}`}}}));t.after(()=>client.close());
  const records=new Map<string,string>();const store:LocalStore={async read(n){return records.get(n);},async write(n,v){records.set(n,v);}};
  return {proxy:await WayfindingProxy.open(client,store),client};};
 const a=await connect('a'),b=await connect('b');const g=(await a.proxy.call('journey_create',{name:'Reconcile',policy:'open',defaultRole:'write'})).journeyId as string;
 await b.proxy.call('journey_join',{journeyId:g});await a.proxy.createGroup(g);const kp=await b.proxy.prepareGroup(g);await a.proxy.addMember(g,b.proxy.personId,kp.deviceId);await b.proxy.sync(g);
 const stale=await createMlsGroup(new TextEncoder().encode('b'));await stale.importState(decode(await b.proxy.exportGroup(g)));
 await a.client.callTool({name:'journey_remove',arguments:{journeyId:g,memberId:b.proxy.personId}});
 await a.proxy.createArtifact({groupId:g,name:'After',type:'text',content:'SYNTHETIC-RECONCILE'});
 const data=[...backend.blobs.data.entries()].filter(([k])=>k.startsWith(JSON.stringify(['mls',g]).slice(0,-1)+','));
 const message=JSON.parse(new TextDecoder().decode(data.at(-2)![1]));assert.equal(message.action,'remove');
 await stale.processHandshake(decode(message.commit));await assert.rejects(stale.open(data.at(-1)![1]));
});
