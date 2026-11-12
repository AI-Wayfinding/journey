import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WayfindingProxy} from '../src/proxy.ts';
import type {SealedRemote} from '../src/sealed-client.ts';
import {syntheticAccountIdentity} from './account-fixture.ts';

test('proxy pins sealed-v1, refuses missing or downgraded modes, and persists the pin',async()=>{
 const identity=await syntheticAccountIdentity();let mode:string|undefined;const calls:string[]=[],files=new Map<string,string>();
 const store={async read(k:string){return files.get(k)},async write(k:string,v:string){files.set(k,v)}};
 const remote:SealedRemote={async listTools(){return {tools:[]}},async callTool(request){calls.push(request.name);const input=request.arguments??{};return {content:[],structuredContent:request.name==='account_read'?{personId:'person_a',personalGroupId:'personal_a',accountKey:identity.accountKey,...(mode?{contentFormat:mode}:{})}:request.name==='sealed_connection_request'?await identity.approve(input):{personId:'person_a',agent:null}}}};
 await assert.rejects(WayfindingProxy.open(remote,store),/sealed-v1/);assert.equal(files.size,0);
 mode='legacy';await assert.rejects(WayfindingProxy.open(remote,store),/sealed-v1/);
 mode='sealed-v1';const proxy=await WayfindingProxy.open(remote,store);assert.equal(JSON.parse(files.get('content-mode')!).contentFormat,'sealed-v1');
 mode=undefined;calls.length=0;await assert.rejects(proxy.call('whoami'),/sealed-v1/);assert.deepEqual(calls,['account_read']);
 mode='sealed-v1';files.set('content-mode',JSON.stringify({version:1,contentFormat:'legacy',personId:'person_a'}));await assert.rejects(WayfindingProxy.open(remote,store),/local.*mode/i);
});
