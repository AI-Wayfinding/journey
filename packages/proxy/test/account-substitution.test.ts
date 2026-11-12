import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {MemoryBackend} from '../../mcp/src/backend.ts';
import {app,bridge,keyPair,RESOURCE,token,testPasskeys} from '../../mcp/test/helpers.ts';
import {openTestSealed} from './account-fixture.ts';
import {SealedClient,type SealedRemote} from '../src/sealed-client.ts';
import {createMlsGroup} from '../src/mls/index.ts';
import {encode,utf8} from '../src/codec.ts';
import {verifyDeviceBinding} from '../../shared/account-identity.ts';

type Intercept=(name:string,args:Record<string,unknown>,value:Record<string,unknown>)=>Record<string,unknown>;
async function fixture(t:TestContext){
 const backend=new MemoryBackend({async get(subject){return {name:subject,email:`${subject}@example.test`}}},Date.now,testPasskeys,true),signer=await keyPair('account-substitution');
 const connect=async(subject:string)=>{
  const transport=new Client({name:'account-substitution',version:'1'});await transport.connect(new StreamableHTTPClientTransport(RESOURCE,{fetch:bridge(app(signer,backend)),requestInit:{headers:{authorization:`Bearer ${await token(signer,{sub:subject})}`}}}));t.after(()=>transport.close());
  let intercept:Intercept=(_name,_args,value)=>value;const calls:string[]=[],files=new Map<string,string>(),store={async read(name:string){return files.get(name)},async write(name:string,value:string){files.set(name,value)}};
  const remote:SealedRemote={listTools:(...args)=>transport.listTools(...args),async callTool(request){calls.push(request.name);const response=await transport.callTool(request),value=response.structuredContent as Record<string,unknown>;return {...response,structuredContent:intercept(request.name,request.arguments??{},value)}}};
  const opened=await openTestSealed(backend,remote,store,subject);
  return {...opened,store,files,calls,setIntercept(value:Intercept){intercept=value}};
 };
 const a=await connect('alice'),journeyId=String((await a.client.call('journey_create',{name:'Signed audience',policy:'open',defaultRole:'write'})).journeyId);
 return {backend,connect,a,journeyId};
}

test('reservation refuses another valid account-signed connection before committing or sharing history',async t=>{
 const {backend,connect,a,journeyId}=await fixture(t),b=await connect('bob');await b.client.call('journey_join',{journeyId});
 const first=await b.client.prepareGroup(journeyId),second=await connect('bob'),replacement=await second.client.prepareGroup(journeyId),binding=await backend.accountsHost.deviceBinding(replacement.deviceId);
 await verifyDeviceBinding(binding);assert.notEqual(binding.deviceId,first.deviceId);
 a.calls.length=0;a.setIntercept((name,_args,value)=>name==='sealed_package_reserve'?binding:value);
 await assert.rejects(a.client.addMember(journeyId,b.client.personId,first.deviceId),/device.*mismatch/i);
 assert.equal(a.calls.includes('sealed_group_commit'),false);assert.equal(a.calls.includes('sealed_group_history'),false);
});

test('reservation refuses a valid attacker MLS package substituted beneath the account signature',async t=>{
 const {connect,a,journeyId}=await fixture(t),b=await connect('bob');await b.client.call('journey_join',{journeyId});const device=await b.client.prepareGroup(journeyId),attacker=await createMlsGroup(utf8.encode('attacker'));
 // The substituted bytes are a valid MLS package: MLS parsing alone must not be the rejecting control.
 const control=await createMlsGroup(utf8.encode('control'));await control.create(utf8.encode('control-group'));await control.add(attacker.keyPackage());
 a.calls.length=0;a.setIntercept((name,_args,value)=>name==='sealed_package_reserve'?{...value,data:encode(attacker.keyPackage())}:value);
 await assert.rejects(a.client.addMember(journeyId,b.client.personId,device.deviceId),/package.*signature|signature.*package/i);
 assert.equal(a.calls.includes('sealed_group_commit'),false);assert.equal(a.calls.includes('sealed_group_history'),false);
});

test('packet verification refuses a valid signing binding for a different device',async t=>{
 const {backend,connect,a,journeyId}=await fixture(t),item=await a.client.call('library_add',{journeyId,name:'Original',text:'Original body'}),itemId=String((item.records as Array<Record<string,unknown>>).find(row=>row.type==='library')!.recordId);
 const second=await connect('alice'),device=await second.client.prepareGroup(journeyId),replacement=await backend.accountsHost.deviceBinding(device.deviceId);await verifyDeviceBinding(replacement);
 const root=JSON.parse(second.files.get('connection-identity')!),state=JSON.parse(a.files.get('sealed-state')!);let expectedDevice='';
 for(const group of Object.values(state.groups) as Array<{cache:Record<string,Record<string,unknown>>}>){for(const packet of Object.values(group.cache)){if((packet.context as Record<string,unknown>).recordId!==itemId)continue;expectedDevice=String(packet.deviceId);packet.payload={name:'Forged',text:'Forged by a different signed device'};const {signature:_signature,...body}=packet;const key=await crypto.subtle.importKey('pkcs8',Buffer.from(root.secret,'base64'),'Ed25519',false,['sign']);packet.signature=Buffer.from(await crypto.subtle.sign('Ed25519',key,utf8.encode(JSON.stringify(body)))).toString('base64');}}
 assert.ok(expectedDevice);assert.notEqual(expectedDevice,replacement.deviceId);a.files.set('sealed-state',JSON.stringify(state));
 a.setIntercept((name,args,value)=>name==='sealed_device_binding'&&args.deviceId===expectedDevice?replacement:value);
 const reopened=await SealedClient.open(a.remote,a.store,a.client.personId);
 await assert.rejects(reopened.call('library_get',{itemId}),/device.*mismatch/i);
});

for(const audience of ['journey','private'] as const)test(`automatic admission refuses a hidden or foreign pending identity (${audience})`,async t=>{
 const {backend,connect,a,journeyId}=await fixture(t),b=await connect('bob');await b.client.call('journey_join',{journeyId});
 const device=await b.client.prepareGroup(journeyId),binding=await backend.accountsHost.deviceBinding(device.deviceId);await verifyDeviceBinding(binding);
 const personal=String((await backend.execute('alice',{tool:'account_read',input:{}})).personalGroupId);if(audience==='private')await a.client.enrollGroup(personal);
 a.calls.length=0;a.setIntercept((name,_args,value)=>{
  if(audience==='journey'&&name==='journey_read'){const identities={...(value.identities as Record<string,unknown>)};delete identities[b.client.personId];return {...value,identities};}
  if(audience==='private'&&name==='sealed_group'&&String(value.groupId).startsWith('private_'))return {...value,pending:[binding]};
  return value;
 });
 await assert.rejects(a.client.sync(audience==='journey'?journeyId:personal),{message:audience==='journey'?'Pending connection owner is not a displayed journey member':'Private audience admits only the owner’s current account key'});
 assert.equal(a.calls.includes('sealed_package_reserve'),false);assert.equal(a.calls.includes('sealed_group_commit'),false);assert.equal(a.calls.includes('sealed_history_post'),false);
});
