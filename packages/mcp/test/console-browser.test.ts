import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {app,bridge,token} from './helpers.ts';
import {createHash} from 'node:crypto';
import {createLocalJWKSet} from 'jose';
import {MemoryBackend} from '../src/backend.ts';
import {createConsole} from '../src/console/index.ts';
import {ConsoleSessions,SESSION_COOKIE} from '../src/console/session.ts';
import {createVerifier} from '../src/auth.ts';
import {authenticator} from './console-authenticator.ts';
import {keyPair,ISSUER,RESOURCE} from './helpers.ts';
import {SealedClient} from '../../proxy/src/sealed-client.ts';
import {consoleRemote} from '../../browser/src/remote.ts';
import {browserBundle,browserIntegrity,browserPath,webauthnIntegrity} from '../../browser/generated/bundle.ts';
import {webauthn} from '../src/console/assets.ts';
import {createMlsGroup} from '../../proxy/src/mls/index.ts';
import {decode,utf8} from '../../proxy/src/codec.ts';
const origin=RESOURCE.origin,clientId=`${origin}/console/client.json`,secret='synthetic-browser-test-secret-at-least-32-bytes';
async function fixture(){
 const backend=new MemoryBackend({async get(s){return {name:s,email:`${s}@example.test`};}},Date.now,undefined,true),signer=await keyPair('browser-console');
 const target=createConsole({backend,secret,resource:RESOURCE,issuer:ISSUER,verifier:createVerifier({issuer:ISSUER,resource:RESOURCE,getKey:createLocalJWKSet(signer.jwks)})});
 const sessions=new ConsoleSessions(backend,secret,origin,Date.now),csrf='synthetic-csrf',identity={subject:'alice',clientId};
 const cookie=(await sessions.create(SESSION_COOKIE,{kind:'session',...identity,csrf,signedInAt:Date.now(),expiresAt:Date.now()+3600000})).split(';')[0]!;
 const requests:string[]=[];
 const send=(path:string,body?:Record<string,unknown>,headers:Record<string,string>={})=>target.fetch(new Request(origin+path,{method:body?'POST':'GET',headers:{cookie,origin,'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})}));
 const post=async(path:string,body:Record<string,unknown>)=>{requests.push(JSON.stringify(body));const r=await send(path,{csrf,...body});if(r.status!==200)throw new Error(`Console HTTP ${r.status} for ${path}`);return await r.json() as Record<string,unknown>;};
 const key=await authenticator(),registration=await post('/console/passkeys/options',{});assert.equal((await send('/console/passkeys/register',{csrf,credential:key.register(String(registration.challenge))})).status,303);
 let counter=0;
 const device=async()=>{const browserId=crypto.randomUUID(),remote=consoleRemote(post,browserId,async device=>{const fields={browserId,credentialId:key.id,device},o=await post('/console/device/enroll/options',fields);return post('/console/device/enroll/finish',{...fields,assertion:await key.assert(String(o.challenge),++counter)});}),files=new Map<string,string>(),account=await post('/console/device/info',{});return {browserId,remote,files,client:await SealedClient.open(remote,{async read(k){return files.get(k)},async write(k,v){files.set(k,v)}},String(account.personId)),personal:String(account.personalGroupId)};};
 const authorize=async(change:Parameters<typeof backend.beginAuthorization>[1])=>{const options=await backend.beginAuthorization(identity,change);return backend.completeAuthorization(identity,change,await key.assert(String(options.challenge),++counter));};
 return {backend,target,send,post,requests,device,csrf,identity,key,authorize};
}
test('console browser sealed writes never send plaintext; admission, local search and revocation fence',async()=>{
 const f=await fixture(),a=await f.device(),markers=['BROWSER-PROFILE-CANARY','BROWSER-CARD-CANARY','BROWSER-CLIENT-CANARY','BROWSER-POST-CANARY','BROWSER-LIBRARY-CANARY','BROWSER-OFFER-CANARY','BROWSER-NEW-CONTENT'];
 const j=String((await a.client.call('journey_create',{name:'Browser journey',policy:'invite',defaultRole:'write'})).journeyId);
 await a.client.enrollGroup(a.personal);
 await a.client.call('account_update',{name:markers[0]});assert.equal((await a.client.call('account_read',{})).name,markers[0]);
 const agentId=String((await a.client.call('agent_create',{name:markers[1]})).agentId);await a.client.call('agent_descriptor_set',{agentId,name:markers[1],clientName:markers[2]});assert.match(JSON.stringify(await a.client.call('agent_list',{})),/BROWSER-CLIENT-CANARY/);
 const boards=await a.client.call('forum_boards',{journeyId:j}),boardId=String((boards.records as {recordId:string}[])[0]!.recordId);
 const topic=await a.client.call('topic_create',{boardId,title:'Thread',body:'Synthetic'}),topicId=String((topic.records as {recordId:string}[])[0]!.recordId);
 await a.client.call('post_create',{topicId,body:markers[3]});assert.match(JSON.stringify(await a.client.call('topic_read',{topicId})),/BROWSER-POST-CANARY/);
 await a.client.call('library_add',{journeyId:j,name:'Browser note',kind:'markdown',text:markers[4]});const found=await a.client.call('library_search',{journeyId:j,query:markers[4]});assert.equal(found.localSearch,true);assert.equal((found.items as unknown[]).length,1);
 await a.client.call('offer_set',{agentId,offer:{id:`offer-${crypto.randomUUID()}`,name:markers[5],description:'Synthetic',inputSchema:{type:'object'}}});assert.match(JSON.stringify(await a.client.call('offer_list',{agentId})),/BROWSER-OFFER-CANARY/);
 const b=await f.device(),bd=await b.client.enrollGroup(j);assert.equal(bd.admitted,false);await a.client.addMember(j,b.client.personId,bd.deviceId);await b.client.sync(j);
 const personal=await b.client.enrollGroup(b.personal);assert.equal(personal.admitted,false);await a.client.addMember(a.personal,b.client.personId,personal.deviceId);assert.equal((await b.client.call('account_read',{})).name,markers[0]);
 assert.match(JSON.stringify(await b.client.call('topic_read',{topicId})),/BROWSER-POST-CANARY/);
 const stolen=await createMlsGroup(utf8.encode(bd.deviceId));await stolen.importState(decode(await b.client.exportGroup(j)));
 assert.deepEqual(await f.post('/console/device/revoke',{browserId:b.browserId}),{revoked:true,revocation:'complete'});
 await a.client.call('post_create',{topicId,body:markers[6]});await assert.rejects(b.client.call('topic_read',{topicId}),/Await authenticated device admission/);
 assert.equal((await f.send('/console/device/call',{csrf:f.csrf,browserId:b.browserId,tool:'sealed_group_fetch',input:{journeyId:j,groupId:j,deviceId:bd.deviceId,since:0,limit:100}})).status,403);
 const ad=await a.client.enrollGroup(j),wire=await f.post('/console/device/call',{browserId:a.browserId,tool:'sealed_group_fetch',input:{journeyId:j,groupId:j,deviceId:ad.deviceId,since:0,limit:100}}),messages=wire.messages as {kind:string,data:string}[];
 const latest=messages.filter(m=>m.kind==='application').at(-1)!;await assert.rejects(stolen.open(decode(latest.data)));
 assert.equal((await f.send('/console/device/call',{csrf:f.csrf,browserId:a.browserId,tool:'post_create',input:{journeyId:j,topicId,body:markers[3]}})).status,403);
 assert.equal((await f.send('/console/device/info',{csrf:'wrong'})).status,403);assert.equal((await f.send('/console/device/info',{csrf:f.csrf},{origin:'https://evil.test'})).status,403);
 for(const marker of markers){assert.equal(f.requests.join('\n').includes(marker),false,`request plaintext ${marker}`);assert.equal(f.backend.snapshot().includes(marker),false,`storage plaintext ${marker}`);for(const bytes of f.backend.blobs.data.values())assert.equal(Buffer.from(bytes).includes(Buffer.from(marker)),false,`blob plaintext ${marker}`);}
});
test('console browser approve and decline reasons are sealed; tasks and rounds decrypt through the shared client',async t=>{
 const f=await fixture(),a=await f.device(),j=String((await a.client.call('journey_create',{name:'Decision journey',policy:'invite',defaultRole:'write'})).journeyId);
 const agentId=String((await a.client.call('agent_create',{name:'Offering endpoint'})).agentId);
 await f.authorize({kind:'card',agentId,capabilities:['read','task.manage','device.keys']});await f.backend.execute('alice',{tool:'agent_add',input:{journeyId:j,agentId}},clientId);await f.authorize({kind:'bind',clientId:'browser-test-endpoint',agentId});
 const signer=await keyPair('browser-offering'),remote=new Client({name:'browser-offering',version:'1'});await remote.connect(new StreamableHTTPClientTransport(RESOURCE,{fetch:bridge(app(signer,f.backend)),requestInit:{headers:{authorization:`Bearer ${await token(signer,{sub:'alice',client_id:'browser-test-endpoint'})}`}}}));t.after(()=>remote.close());
 const files=new Map<string,string>(),endpoint=await SealedClient.open(remote,{async read(k){return files.get(k)},async write(k,v){files.set(k,v)}},a.client.personId),jd=await endpoint.prepareGroup(j);await a.client.addMember(j,endpoint.personId,jd.deviceId);
 const offerId=`offer-${crypto.randomUUID()}`;await a.client.call('offer_set',{agentId,offer:{id:offerId,name:'Review',description:'Synthetic',inputSchema:{type:'object'},admission:{rules:[],default:'hold'},journeySettings:{[j]:{enabled:true}}}});await a.client.call('offer_publish',{agentId,offerId});
 for(const action of ['approve','decline']){
  const p=await a.client.call('task_prepare',{journeyId:j,agentId,offerId}),taskId=String(p.taskId),groupId=String(p.groupId),ed=await endpoint.prepareGroup(groupId);await a.client.addMember(groupId,endpoint.personId,ed.deviceId);
  await a.client.call('task_create',{journeyId:j,taskId,agentId,offerId,name:'BROWSER-TASK-NAME-CANARY',input:{text:'BROWSER-TASK-INPUT-CANARY'},deadline:Date.now()+300000,maxRounds:2});
  await a.client.call('task_step',{journeyId:j,taskId,action,reason:`BROWSER-${action}-REASON-CANARY`});assert.match(JSON.stringify(await a.client.call('task_read',{journeyId:j,taskId})),new RegExp(`BROWSER-${action}-REASON-CANARY`));
 }
 const round=await a.client.call('round_create',{journeyId:j,title:'BROWSER-ROUND-CANARY',goal:'BROWSER-ROUND-GOAL',format:'Synthetic'}),roundId=String((round.records as {recordId:string;type:string}[]).find(r=>r.type==='round')!.recordId);assert.match(JSON.stringify(await a.client.call('round_read',{roundId})),/BROWSER-ROUND-CANARY/);
 for(const marker of ['BROWSER-TASK-NAME-CANARY','BROWSER-TASK-INPUT-CANARY','BROWSER-approve-REASON-CANARY','BROWSER-decline-REASON-CANARY','BROWSER-ROUND-CANARY','BROWSER-ROUND-GOAL']){assert.equal(f.requests.join('\n').includes(marker),false,marker);assert.equal(f.backend.snapshot().includes(marker),false,marker);for(const bytes of f.backend.blobs.data.values())assert.equal(Buffer.from(bytes).includes(Buffer.from(marker)),false,marker);}
});
test('console browser pinned module hash and strict CSP match served bytes',async()=>{
 const f=await fixture(),page=await f.send('/console'),html=await page.text(),csp=page.headers.get('content-security-policy')!;
 const expected='sha256-'+createHash('sha256').update(browserBundle).digest('base64');assert.equal(browserIntegrity,expected);assert.equal(webauthnIntegrity,'sha256-'+createHash('sha256').update(webauthn).digest('base64'));
 assert.match(csp,/default-src 'none'/);assert.match(csp,/object-src 'none'/);assert.ok(csp.includes(`script-src '${webauthnIntegrity}' '${expected}'`));assert.doesNotMatch(csp,/unsafe-inline|unsafe-eval/);
 assert.ok(html.includes(`type="module" src="${browserPath}" integrity="${expected}"`));assert.doesNotMatch(html,/<script[^>]*>\s*[^<\s]/);assert.match(html,/No key escrow/);
 const script=await f.send(browserPath);assert.equal(script.status,200);assert.equal(await script.text(),browserBundle);assert.match(script.headers.get('content-type')!,/javascript/);
});
