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


test('proxy asks for connector sign-in again on typed authentication failures, not arbitrary remote text',async()=>{
 const {sealedRemoteCall}=await import('../src/mode.ts'),{localError}=await import('../src/errors.ts');
 const {UnauthorizedError,SdkHttpError,SdkErrorCode}=await import('@modelcontextprotocol/client');
 const f=await syntheticAccountIdentity(),files=new Map<string,string>(),store={async read(k:string){return files.get(k)},async write(k:string,v:string){files.set(k,v)}};
 let failure:Error|undefined;
 const remote:SealedRemote={async listTools(){if(failure)throw failure;return {tools:[]}},async callTool(r){if(failure)throw failure;return {content:[],structuredContent:r.name==='account_read'?{personId:'person_a',personalGroupId:'personal_a',contentFormat:'sealed-v1',accountKey:f.accountKey}:r.name==='sealed_connection_request'?await f.approve(r.arguments??{}):{}}}};
 const client=await import('../src/sealed-client.ts').then(m=>m.SealedClient.open(remote,store,'person_a'));
 for(const error of [new UnauthorizedError('SECRET'),new SdkHttpError(SdkErrorCode.ClientHttpAuthentication,'SECRET',{status:401})]){
  failure=error;
  for(const call of [()=>sealedRemoteCall(remote,'whoami',{}),()=>client.call('whoami',{}),()=>client.tools()]){
   await assert.rejects(call,error=>{assert.equal(localError(error),'Sign in again to re-authorise the connector');return true;});
  }
 }
 for(const error of [new Error('401 Unauthorized SECRET'),new SdkHttpError(SdkErrorCode.ClientHttpForbidden,'SECRET',{status:403}),new Error('network SECRET')]){
  failure=error;await assert.rejects(()=>client.call('whoami',{}),error=>{assert.equal(localError(error),'Remote service unavailable');return true;});
 }
});
