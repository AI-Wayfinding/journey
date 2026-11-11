import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {MemoryBackend} from '../../mcp/src/backend.ts';
import {app,bridge,keyPair,RESOURCE,token,testPasskeys} from '../../mcp/test/helpers.ts';
import {SealedClient} from '../src/sealed-client.ts';

test('sealed identity storage canary and explicit journey aliases',async t=>{
 const markers=['PRIVATE-PROFILE-NAME','PRIVATE-PROFILE-EMAIL@example.test','PRIVATE-NICKNAME','PRIVATE-DEVICE-LABEL','PRIVATE-PASSKEY-LABEL','PRIVATE-AGENT-NAME','PRIVATE-CLIENT-NAME','PUBLIC-JOURNEY-NICKNAME','PUBLIC-JOURNEY-AGENT'];
 const backend=new MemoryBackend({async get(subject){return {name:markers[0]!,email:subject==='alice'?markers[1]!:'bob@example.test'};}},Date.now,testPasskeys,true),signer=await keyPair('identities');
 const connect=async(subject:string)=>{const remote=new Client({name:'identity-test',version:'1'});await remote.connect(new StreamableHTTPClientTransport(RESOURCE,{fetch:bridge(app(signer,backend)),requestInit:{headers:{authorization:`Bearer ${await token(signer,{sub:subject})}`}}}));t.after(()=>remote.close());const files=new Map<string,string>(),personId=String((await backend.execute(subject,{tool:'account_read',input:{}})).personId);return {remote,client:await SealedClient.open(remote,{async read(k){return files.get(k)},async write(k,v){files.set(k,v)}},personId)};};
 const a=await connect('alice'),b=await connect('bob');
 assert.ok(!backend.snapshot().includes(markers[0]!),'provisioning must not persist fetched name');assert.ok(!backend.snapshot().includes(markers[1]!),'provisioning must not persist fetched email');
 const journeyId=String((await a.client.call('journey_create',{name:'Identity journey',policy:'open',defaultRole:'write'})).journeyId);await b.client.call('journey_join',{journeyId});const bd=await b.client.prepareGroup(journeyId);await a.client.addMember(journeyId,b.client.personId,bd.deviceId);
 await a.client.call('account_update',{name:markers[0],email:markers[1],nickname:markers[2],deviceLabels:{device_owned:markers[3]},passkeyLabels:{credential_owned:markers[4]},publications:{[journeyId]:{nickname:markers[7]}}});
 for(const bytes of backend.blobs.data.values())for(const marker of markers)assert.ok(!new TextDecoder().decode(bytes).includes(marker),`blob leaked ${marker}`);
 const profile=await a.client.call('account_read',{});assert.equal(profile.name,markers[0]);assert.equal(profile.email,markers[1]);assert.equal(profile.nickname,markers[2]);assert.deepEqual(profile.deviceLabels,{device_owned:markers[3]});assert.deepEqual(profile.passkeyLabels,{credential_owned:markers[4]});
 assert.equal(await backend.accountsHost.personIdByEmail(markers[1]!.toLowerCase()),a.client.personId);assert.equal(await backend.accountsHost.personIdByEmail('nobody@example.test'),undefined);
 const created=await a.client.call('agent_create',{name:markers[5]}),agentId=String(created.agentId);await a.client.call('agent_add',{journeyId,agentId});await a.client.call('agent_descriptor_set',{agentId,name:markers[5],clientName:markers[6],publications:{[journeyId]:{name:markers[8]}}});
 const agents=await a.client.call('agent_list',{});assert.ok(JSON.stringify(agents).includes(markers[5]!));assert.ok(JSON.stringify(agents).includes(markers[6]!));const publicJourney=await b.client.call('journey_read',{journeyId});assert.ok(JSON.stringify(publicJourney).includes(markers[7]!));assert.ok(JSON.stringify(publicJourney).includes(markers[8]!));for(const marker of markers.slice(0,7))assert.ok(!JSON.stringify(publicJourney).includes(marker));
 const wire=await backend.execute('alice',{tool:'account_read',input:{}});assert.equal(wire.name,a.client.personId);assert.equal(wire.email,'');const descriptor=wire.descriptor as {privateDefinition:Record<string,unknown>};await assert.rejects(backend.sealedExecute('bob','sealed_record_read',descriptor.privateDefinition),/read|member|capability|found/i);
 await assert.rejects(backend.sealedExecute('alice','account_update',{nickname:'plaintext'}),/Invalid sealed/);await assert.rejects(backend.sealedExecute('alice','agent_create',{name:'plaintext'}),/Invalid sealed/);await assert.rejects(backend.passkey({subject:'alice',clientId:'trusted-host'},{op:'rename',id:'credential_owned',name:'plaintext'}),/sealed|proxy/i);
 for(const marker of markers)assert.ok(!backend.snapshot().includes(marker),`storage leaked ${marker}`);for(const bytes of backend.blobs.data.values())for(const marker of markers)assert.ok(!new TextDecoder().decode(bytes).includes(marker),`blob leaked ${marker}`);
});


test('sealed consent drops custom client labels and preserves id-only authority controls',async()=>{
 const backend=new MemoryBackend({async get(){return {name:'WORKOS-PRIVATE-NAME',email:'workos-private@example.test'};}},Date.now,testPasskeys,true),account=await backend.accountsHost.provision('owner');
 const {clientMetadata}=await import('../../mcp/src/oauth-contract.ts');const registration=await backend.oauth({op:'register',client:clientMetadata.parse({client_name:'CUSTOM-OAUTH-LABEL',redirect_uris:['http://127.0.0.1:8717/callback']})});assert.equal(registration.kind,'client');
 const clientId='https://example.com/'+ 'metadata'.repeat(20);await backend.oauth({op:'request',id:'request',request:{clientId,clientName:'CUSTOM-PENDING-LABEL',redirectUri:'http://127.0.0.1:8717/callback',challenge:'a'.repeat(43),expiresAt:Date.now()+300000}});
 await assert.rejects(backend.consentAgent('owner','request',{name:'CUSTOM-AGENT-LABEL',capabilities:['read'],journeys:[]}),/sealed/);
 const agentId=await backend.consentAgent('owner','request',{name:'MCP client',capabilities:['read'],journeys:[]});assert.equal((await backend.accountsHost.lookup('owner'))!.agents[0]!.name,agentId);await backend.manageAgent({subject:'owner',clientId:'console'},agentId,agentId,[]);await assert.rejects(backend.manageAgent({subject:'owner',clientId:'console'},agentId,'CUSTOM-MANAGE-LABEL',[]),/sealed/);
 const options=await backend.passkey({subject:'owner',clientId:'console'},{op:'begin'});assert.equal((options.user as {name:string}).name,account.personId);
 for(const marker of ['WORKOS-PRIVATE-NAME','workos-private@example.test','CUSTOM-OAUTH-LABEL','CUSTOM-PENDING-LABEL','CUSTOM-AGENT-LABEL','CUSTOM-MANAGE-LABEL'])assert.ok(!backend.snapshot().includes(marker),`storage leaked ${marker}`);
});
