import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {MemoryBackend} from '../../mcp/src/backend.ts';
import {app,bridge,keyPair,RESOURCE,token,testPasskeys} from '../../mcp/test/helpers.ts';
import {FileStore} from '../src/file-store.ts';
import {AuthKitProvider} from '../src/oauth.ts';
import {WayfindingProxy} from '../src/proxy.ts';
import {openTestProxy} from './account-fixture.ts';

test('proxy: sealed bootstrap with the real FileStore persists and reopens sealed state',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'wayfinding-sealed-bootstrap-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const backend=new MemoryBackend({async get(s){return {name:s,email:`${s}@example.test`};}},Date.now,testPasskeys,true);
 const signer=await keyPair('file-store-bootstrap');
 const remote=new Client({name:'file-store-bootstrap',version:'1'});
 await remote.connect(new StreamableHTTPClientTransport(RESOURCE,{fetch:bridge(app(signer,backend)),requestInit:{headers:{authorization:`Bearer ${await token(signer,{sub:'alice'})}`}}}));
 t.after(()=>remote.close());
 let store=await FileStore.open(directory);
 try{
  // These are the same storage-backed bootstrap calls used by cli.ts after sign-in.
  await AuthKitProvider.open(store,new URL('http://127.0.0.1:8717/callback'),async()=>{});
  const opened=await openTestProxy(backend,remote,store,'alice'),proxy=opened.proxy;
  const journey=await proxy.call('journey_create',{name:'Synthetic persisted journey',policy:'open',defaultRole:'write'});
  const journeyId=String(journey.journeyId);
  assert.equal((await stat(join(directory,'sealed-state.json'))).mode&0o777,0o600);
  await store.close();store=await FileStore.open(directory);
  const reopened=await WayfindingProxy.open(opened.remote,store);
  assert.equal((await reopened.call('journey_read',{journeyId})).name,'Synthetic persisted journey');
 }finally{await store.close();}
});
