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
import {installTestAccountIdentity,trustedAccountRemote,type TestAccountIdentity} from './account-fixture.ts';
import {workspaceDom} from '../../browser/test/workspace-dom.ts';
import {browserBundle,browserIntegrity,browserPath,webauthnIntegrity} from '../../browser/generated/bundle.ts';
import {webauthn} from '../src/console/assets.ts';
import {createMlsGroup} from '../../proxy/src/mls/index.ts';
import {decode,utf8} from '../../proxy/src/codec.ts';
const origin=RESOURCE.origin,clientId=`${origin}/console/client.json`,secret='synthetic-browser-test-secret-at-least-32-bytes';
async function fixture(){
 let now=Date.now();
 const backend=new MemoryBackend({async get(s){return {name:s,email:`${s}@example.test`};}},()=>now,undefined,true),signer=await keyPair('browser-console');
 const target=createConsole({backend,secret,resource:RESOURCE,issuer:ISSUER,now:()=>now,verifier:createVerifier({issuer:ISSUER,resource:RESOURCE,getKey:createLocalJWKSet(signer.jwks)})});
 const sessions=new ConsoleSessions(backend,secret,origin,()=>now),csrf='synthetic-csrf',identity={subject:'alice',clientId};
 let cookie='',signedInAt=now;
 const signIn=async()=>{signedInAt=now;cookie=(await sessions.create(SESSION_COOKIE,{kind:'session',...identity,csrf,signedInAt,expiresAt:now+3600000})).split(';')[0]!;};
 await signIn();
 const requests:string[]=[];
 const send=(path:string,body?:Record<string,unknown>,headers:Record<string,string>={})=>target.fetch(new Request(origin+path,{method:body?'POST':'GET',headers:{cookie,origin,'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})}));
 const post=async(path:string,body:Record<string,unknown>)=>{requests.push(JSON.stringify(body));const r=await send(path,{csrf,...body});if(r.status!==200)throw new Error(`Console HTTP ${r.status} for ${path}`);return await r.json() as Record<string,unknown>;};
 const key=await authenticator(),registration=await post('/console/passkeys/options',{});assert.equal((await send('/console/passkeys/register',{csrf,credential:key.register(String(registration.challenge))})).status,303);
 let signing:TestAccountIdentity|undefined,signingGeneration=-1;
 const signingAccount=async()=>{const sessionIdentity={...identity,signedInAt},info=await backend.passkey(sessionIdentity,{op:'identity_read'}),generation=Number(info?.generation);if(!signing||generation!==signingGeneration){signing=await installTestAccountIdentity(backend,'alice',clientId,signedInAt);signingGeneration=generation;}return signing;};
 let counter=0;
 const device=async(enrollmentKey=key)=>{const browserId=crypto.randomUUID(),raw=consoleRemote(post,browserId,async device=>{const fields={browserId,credentialId:enrollmentKey.id,device},o=await post('/console/device/enroll/options',fields);return post('/console/device/enroll/finish',{...fields,assertion:await enrollmentKey.assert(String(o.challenge),++counter)});}),files=new Map<string,string>(),account=await post('/console/device/info',{}),identity=await signingAccount(),remote=trustedAccountRemote(raw,identity);return {browserId,remote,files,client:await SealedClient.open(remote,{async read(k){return files.get(k)},async write(k,v){files.set(k,v)}},String(account.personId),{endorse:async claim=>(await identity.artifacts(claim)).certificate}),personal:String(account.personalGroupId)};};
 const authorize=async(change:Parameters<typeof backend.beginAuthorization>[1])=>{const options=await backend.beginAuthorization(identity,change);return backend.completeAuthorization(identity,change,await key.assert(String(options.challenge),++counter));};
 const complete=async(browserId:string,recoveryProof:string,wrappingKey=key)=>{const fields={browserId,recoveryProof},options=await post('/console/setup/options',fields);await post('/console/setup/complete',{...fields,assertion:await wrappingKey.assert(String(options.challenge),++counter)});};
 const ready=async(a:Awaited<ReturnType<typeof device>>)=>{await a.client.enrollGroup(a.personal);await a.client.call('account_update',{name:'Synthetic browser'});await complete(a.browserId,'b'.repeat(43));};
 return {get now(){return now},backend,target,send,post,requests,device,signingAccount,complete,ready,csrf,identity,key,authorize,advance:(ms:number)=>{now+=ms;},signIn};
}

test('console browser publish carries newly enabled journey settings into sealed publications',async t=>{
 const f=await fixture(),a=await f.device();await f.ready(a);
 const j=String((await a.client.call('journey_create',{name:'Publish journey',policy:'invite',defaultRole:'write'})).journeyId),other=String((await a.client.call('journey_create',{name:'Off journey',policy:'invite',defaultRole:'write'})).journeyId);
 const agentId=String((await a.client.call('agent_create',{name:'Offering endpoint'})).agentId);
 await f.authorize({kind:'card',agentId,capabilities:['read','task.manage','device.keys']});
 for(const journeyId of [j,other])await f.backend.execute('alice',{tool:'agent_add',input:{journeyId,agentId}},clientId);
 await f.authorize({kind:'bind',clientId:'publishing-endpoint',agentId});
 const signer=await keyPair('publishing'),remote=new Client({name:'publishing',version:'1'});await remote.connect(new StreamableHTTPClientTransport(RESOURCE,{fetch:bridge(app(signer,f.backend)),requestInit:{headers:{authorization:`Bearer ${await token(signer,{sub:'alice',client_id:'publishing-endpoint'})}`}}}));t.after(()=>remote.close());
 const files=new Map<string,string>(),account=await f.signingAccount(),endpoint=await SealedClient.open(trustedAccountRemote(remote,account),{async read(k){return files.get(k)},async write(k,v){files.set(k,v)}},a.client.personId,{endorse:async claim=>(await account.artifacts(claim)).certificate});
 const jd=await endpoint.prepareGroup(j);await a.client.addMember(j,endpoint.personId,jd.deviceId);
 const offerId=`offer-${crypto.randomUUID()}`;
 await a.client.call('offer_set',{agentId,offer:{id:offerId,name:'PUBLISH-OFFER-CANARY',description:'Synthetic',inputSchema:{type:'object'},admission:{rules:[],default:'hold'}}});
 const list=await a.client.call('offer_list',{agentId}),version=(list.offers as {version:number}[])[0]!.version;
 assert.equal((await f.send('/console/offers/journey',{csrf:f.csrf,agentId,offerId,journeyId:j,expectedVersion:version,enabled:true,limitMode:'limit',maxRequestsPerDay:2})).status,303);
 const bypass=await f.send('/console/offers/publish',{csrf:f.csrf,agentId,offerId,expectedVersion:version+1});assert.equal(bypass.status,403,'Metadata-only publication must not bypass browser encryption');assert.equal(((await a.client.call('offer_list',{agentId})).offers as {status:string}[])[0]!.status,'draft');
 const ui=workspaceDom(`/console/agents/${agentId}`);try{await ui.render(a.client);await ui.click('Publish offer');}finally{ui.restore();}
 const published=((await a.client.call('offer_list',{agentId})).offers as {status:string;journeySettings:unknown;sealed:{publications:Record<string,unknown>}}[])[0]!;
 assert.equal(published.status,'published');assert.deepEqual(published.journeySettings,{[j]:{enabled:true,maxRequestsPerDay:2}});assert.deepEqual(Object.keys(published.sealed.publications),[j]);
 assert.match(JSON.stringify(await a.client.call('offer_search',{journeyId:j})),/PUBLISH-OFFER-CANARY/);
 const task=await a.client.call('task_create',{journeyId:j,agentId,offerId,name:'Published task',input:{},maxRounds:1,deadline:f.now+300000});
 const ed=await endpoint.prepareGroup(String(task.groupId));await a.client.addMember(String(task.groupId),endpoint.personId,ed.deviceId);
 await a.client.call('task_create',{journeyId:j,taskId:task.taskId,agentId,offerId,name:'Published task',input:{},maxRounds:1,deadline:f.now+300000});
 assert.equal(((await a.client.call('journey_read',{journeyId:j})).tasks as unknown[]).length,1);
 await assert.rejects(a.client.call('task_prepare',{journeyId:other,agentId,offerId}));
 assert.equal(f.requests.join('\n').includes('PUBLISH-OFFER-CANARY'),false);assert.equal(f.backend.snapshot().includes('PUBLISH-OFFER-CANARY'),false);
});
test('browser device call preserves a CAS refusal as JSON 409',async()=>{
 const f=await fixture(),a=await f.device();await f.ready(a);
 const journeyId=String((await a.client.call('journey_create',{name:'CAS refusal',policy:'invite',defaultRole:'write'})).journeyId);
 const view=await f.post('/console/device/call',{browserId:a.browserId,tool:'sealed_group',input:{journeyId,groupId:journeyId}});
 const deviceId=(view.devices as {deviceId:string}[])[0]!.deviceId;
 const r=await f.send('/console/device/call',{csrf:f.csrf,browserId:a.browserId,tool:'sealed_group_commit',input:{journeyId,groupId:journeyId,deviceId,expectedSequence:0,expectedEpoch:0,action:'update',data:'e30='}});
 assert.equal(r.status,409);assert.deepEqual(await r.json(),{error:'Sealed group CAS mismatch'});
 await a.client.sync(journeyId);
 assert.equal((await a.client.call('journey_read',{journeyId})).name,'CAS refusal');
});
test('console browser sealed writes never send plaintext; admission, local search and revocation fence',async()=>{
 const f=await fixture(),a=await f.device(),markers=['BROWSER-PROFILE-CANARY','BROWSER-CARD-CANARY','BROWSER-CLIENT-CANARY','BROWSER-POST-CANARY','BROWSER-LIBRARY-CANARY','BROWSER-OFFER-CANARY','BROWSER-NEW-CONTENT'];
 await f.ready(a);
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
 assert.equal((await f.send('/console/device/call',{csrf:f.csrf,browserId:b.browserId,tool:'sealed_group_fetch',input:{journeyId:j,groupId:j,deviceId:bd.deviceId,since:0,limit:100}})).status,409);
 const ad=await a.client.enrollGroup(j),wire=await f.post('/console/device/call',{browserId:a.browserId,tool:'sealed_group_fetch',input:{journeyId:j,groupId:j,deviceId:ad.deviceId,since:0,limit:100}}),messages=wire.messages as {kind:string,data:string}[];
 const latest=messages.filter(m=>m.kind==='application').at(-1)!;await assert.rejects(stolen.open(decode(latest.data)));
 const invalid=await f.send('/console/device/call',{csrf:f.csrf,browserId:a.browserId,tool:'post_create',input:{journeyId:j,topicId,body:markers[3]}});assert.equal(invalid.status,400);assert.deepEqual(await invalid.json(),{error:'Invalid browser tool input'});
 assert.equal((await f.send('/console/device/info',{csrf:'wrong'})).status,403);assert.equal((await f.send('/console/device/info',{csrf:f.csrf},{origin:'https://evil.test'})).status,403);
 for(const marker of markers){assert.equal(f.requests.join('\n').includes(marker),false,`request plaintext ${marker}`);assert.equal(f.backend.snapshot().includes(marker),false,`storage plaintext ${marker}`);for(const bytes of f.backend.blobs.data.values())assert.equal(Buffer.from(bytes).includes(Buffer.from(marker)),false,`blob plaintext ${marker}`);}
});
test('console sealed journey overview is metadata-only and accessible to a member',async()=>{
 const f=await fixture(),a=await f.device();await f.ready(a);
 const j=String((await a.client.call('journey_create',{name:'PRIVATE-OVERVIEW-NAME',policy:'invite',defaultRole:'write'})).journeyId);
 const response=await f.send(`/console/journeys/${j}`);assert.equal(response.status,200);
 const html=await response.text();assert.ok(html.includes(j));assert.doesNotMatch(html,/PRIVATE-OVERVIEW-NAME|Console request refused/);
 assert.ok(html.includes(browserPath),'browser device loads the sealed content');
 const ui=workspaceDom(`/console/journeys/${j}`);try{await ui.render(a.client);assert.match(ui.work.textContent,/PRIVATE-OVERVIEW-NAME/);}finally{ui.restore();}
 assert.equal((await f.send('/console/journeys/journey_unknown')).status,403);
});
test('console browser approve and decline reasons are sealed; tasks and rounds decrypt through the shared client',async t=>{
 const f=await fixture(),a=await f.device();await f.ready(a);const j=String((await a.client.call('journey_create',{name:'Decision journey',policy:'invite',defaultRole:'write'})).journeyId);
 const agentId=String((await a.client.call('agent_create',{name:'Offering endpoint'})).agentId);
 await f.authorize({kind:'card',agentId,capabilities:['read','task.manage','device.keys']});await f.backend.execute('alice',{tool:'agent_add',input:{journeyId:j,agentId}},clientId);await f.authorize({kind:'bind',clientId:'browser-test-endpoint',agentId});
 const signer=await keyPair('browser-offering'),remote=new Client({name:'browser-offering',version:'1'});await remote.connect(new StreamableHTTPClientTransport(RESOURCE,{fetch:bridge(app(signer,f.backend)),requestInit:{headers:{authorization:`Bearer ${await token(signer,{sub:'alice',client_id:'browser-test-endpoint'})}`}}}));t.after(()=>remote.close());
 const files=new Map<string,string>(),account=await f.signingAccount(),trusted=trustedAccountRemote(remote,account),endpoint=await SealedClient.open(trusted,{async read(k){return files.get(k)},async write(k,v){files.set(k,v)}},a.client.personId,{endorse:async claim=>(await account.artifacts(claim)).certificate}),jd=await endpoint.prepareGroup(j);await a.client.addMember(j,endpoint.personId,jd.deviceId);
 const offerId=`offer-${crypto.randomUUID()}`;await a.client.call('offer_set',{agentId,offer:{id:offerId,name:'Review',description:'Synthetic',inputSchema:{type:'object'},admission:{rules:[],default:'hold'},journeySettings:{[j]:{enabled:true}}}});await a.client.call('offer_publish',{agentId,offerId});
 // One recovered member in another journey must not hide decisions here.
 const changedJourney=String((await a.client.call('journey_create',{name:'Needs comparison',policy:'open',defaultRole:'write'})).journeyId);
 await f.backend.execute('alice',{tool:'agent_add',input:{journeyId:changedJourney,agentId}},clientId);
 await installTestAccountIdentity(f.backend,'carol','test-console',f.now);await f.backend.execute('carol',{tool:'journey_join',input:{journeyId:changedJourney}},clientId);
 await a.client.call('journey_read',{journeyId:changedJourney});
 const b=await f.device();await b.client.enrollGroup(b.personal);await a.client.sync(a.personal);await b.client.sync(b.personal);await b.client.call('journey_read',{journeyId:changedJourney});
 await f.backend.passkey({subject:'carol',clientId:'test-console',signedInAt:f.now},{op:'recovery_start'});f.advance(259200001);
 await installTestAccountIdentity(f.backend,'carol','test-console',f.now);await f.signIn();
 const bob=await f.backend.execute('bob',{tool:'account_read',input:{}},clientId);
 await f.backend.execute('alice',{tool:'journey_invite',input:{journeyId:j,personId:String(bob.personId)}},clientId);
 await f.backend.execute('bob',{tool:'journey_join',input:{journeyId:j}},clientId);
 for(const action of ['approve','decline'] as const){
  const draft=await endpoint.call('task_create',{journeyId:j,agentId,offerId,name:'BROWSER-TASK-NAME-CANARY',input:{text:'BROWSER-TASK-INPUT-CANARY'},deadline:f.now+300000,maxRounds:2});
  const taskId=String(draft.taskId),groupId=String(draft.groupId);
  assert.equal(draft.admission,'pending');
  const metadata=await f.backend.execute('alice',{tool:'journey_read',input:{journeyId:j}},clientId);
  const pending=metadata.taskPreparations as {taskId:string;groupId:string;agentId:string}[];
  assert.ok(pending.some(p=>p.taskId===taskId&&p.groupId===groupId&&p.agentId===agentId),'owner discovers the pending audience without content');
  const other=await f.backend.execute('bob',{tool:'journey_read',input:{journeyId:j}},clientId);
  assert.equal(JSON.stringify(other).includes(taskId),false,'unrelated journey members cannot discover private task preparations');
  await assert.rejects(f.backend.sealedExecute('bob','sealed_group',{journeyId:j,groupId},clientId),/Task audience refused/);
  await assert.rejects(f.backend.execute('alice',{tool:'task_step',input:{journeyId:j,taskId,action}},clientId),/sealed.*contract/);
  const ui=workspaceDom(`/console/agents/${agentId}`);
  try {
   await ui.render(b.client);await ui.click('Prepare request connection');
  }finally{ui.restore();}
  await a.client.sync(j);
  await endpoint.sync(groupId);assert.equal((await b.client.enrollGroup(groupId)).admitted,true);
  await endpoint.call('task_create',{journeyId:j,taskId,agentId,offerId,name:'BROWSER-TASK-NAME-CANARY',input:{text:'BROWSER-TASK-INPUT-CANARY'},deadline:f.now+300000,maxRounds:2});
  const agentHtml=await (await f.send(`/console/agents/${agentId}`)).text();assert.doesNotMatch(agentHtml,/action="\/console\/offers\/decide"/);
  const decisionUi=workspaceDom(`/console/agents/${agentId}`);
  try {
   await decisionUi.render(b.client);assert.match(decisionUi.work.textContent,/safety number comparison required/);assert.match(decisionUi.work.textContent,/BROWSER-TASK-NAME-CANARY/);assert.match(decisionUi.work.textContent,/BROWSER-TASK-INPUT-CANARY/);
   decisionUi.input('Decision reason (optional)',`BROWSER-${action}-REASON-CANARY`);
   await decisionUi.click(action==='approve'?'Approve request':'Decline request');
  }finally{decisionUi.restore();}
  const task=await b.client.call('task_read',{journeyId:j,taskId});
  assert.equal(task.status,action==='approve'?2:8);assert.match(JSON.stringify(task),new RegExp(`BROWSER-${action}-REASON-CANARY`));
  assert.equal((await f.send('/console/offers/decide',{csrf:f.csrf,agentId,journeyId:j,taskId,action,reason:'RAW-DECISION-REASON'})).status,403);
  assert.equal(f.backend.snapshot().includes('RAW-DECISION-REASON'),false);
 }
 const round=await a.client.call('round_create',{journeyId:j,title:'BROWSER-ROUND-CANARY',goal:'BROWSER-ROUND-GOAL',format:'Synthetic'}),roundId=String((round.records as {recordId:string;type:string}[]).find(r=>r.type==='round')!.recordId);assert.match(JSON.stringify(await a.client.call('round_read',{roundId})),/BROWSER-ROUND-CANARY/);
 for(const marker of ['BROWSER-TASK-NAME-CANARY','BROWSER-TASK-INPUT-CANARY','BROWSER-approve-REASON-CANARY','BROWSER-decline-REASON-CANARY','BROWSER-ROUND-CANARY','BROWSER-ROUND-GOAL']){assert.equal(f.requests.join('\n').includes(marker),false,marker);assert.equal(f.backend.snapshot().includes(marker),false,marker);for(const bytes of f.backend.blobs.data.values())assert.equal(Buffer.from(bytes).includes(Buffer.from(marker)),false,marker);}
});
test('console browser pinned module hash and strict CSP match served bytes',async()=>{
 const f=await fixture(),page=await f.send('/console/onboarding'),html=await page.text(),csp=page.headers.get('content-security-policy')!;
 const expected='sha256-'+createHash('sha256').update(browserBundle).digest('base64');assert.equal(browserIntegrity,expected);assert.equal(webauthnIntegrity,'sha256-'+createHash('sha256').update(webauthn).digest('base64'));
 assert.match(csp,/default-src 'none'/);assert.match(csp,/object-src 'none'/);assert.ok(csp.includes(`script-src '${webauthnIntegrity}' '${expected}'`));assert.doesNotMatch(csp,/unsafe-inline|unsafe-eval/);
 assert.ok(html.includes(`type="module" src="${browserPath}" integrity="${expected}"`));assert.doesNotMatch(html,/<script[^>]*>\s*[^<\s]/);assert.match(html,/No key escrow/);
 const script=await f.send(browserPath);assert.equal(script.status,200);assert.equal(await script.text(),browserBundle);assert.match(script.headers.get('content-type')!,/javascript/);
});

test('onboarding and code recovery: private name, saved code, unified connections and removal',async()=>{
 const {recoveryCode,recoveryAuthorization}=await import('../../browser/src/vault.ts');
 const f=await fixture(),a=await f.device(),personId=a.client.personId,code=recoveryCode(),recoveryProof=await recoveryAuthorization(code,origin,personId);
 assert.equal((await f.send('/console/setup/complete',{csrf:f.csrf,browserId:a.browserId,recoveryProof})).status,403,'no enrolled browser or profile yet');
 await a.client.enrollGroup(a.personal);
 assert.equal((await f.send('/console/setup/complete',{csrf:f.csrf,browserId:a.browserId,recoveryProof})).status,403,'name/profile required');
 await a.client.call('account_update',{name:'ONBOARDING-PRIVATE-NAME'});
 await f.complete(a.browserId,recoveryProof);
 const before=await f.backend.execute('alice',{tool:'account_read',input:{}},clientId),html=await (await f.send('/console')).text();
 assert.match(html,/Your connections/);assert.match(html,/Browser/);assert.match(html,/Added/);assert.match(html,/Last used/);assert.ok(html.includes(a.browserId));assert.doesNotMatch(html,/Private browser device|<h2>Agents<\/h2>|ONBOARDING-PRIVATE-NAME/);
 assert.equal((await f.send('/console/passkeys/options',{csrf:f.csrf})).status,403);
 const wrong=await recoveryAuthorization(recoveryCode(),origin,personId);assert.equal((await f.send('/console/passkeys/options',{csrf:f.csrf,recoveryProof:wrong})).status,403);
 const next=await authenticator(),options=await f.post('/console/passkeys/options',{recoveryProof});
 await f.post('/console/connections/register',{credential:next.register(String(options.challenge))});
 const b=await f.device(next);assert.equal((await b.client.enrollGroup(b.personal)).admitted,false);
 const enrolled=await b.client.enrollGroup(b.personal);await a.client.addMember(a.personal,personId,enrolled.deviceId);await b.client.sync(b.personal);
 assert.equal((await b.client.call('account_read',{})).name,'ONBOARDING-PRIVATE-NAME');
 const after=await f.backend.execute('alice',{tool:'account_read',input:{}},clientId);assert.equal(after.personId,before.personId);assert.deepEqual(after.descriptor,before.descriptor,'code recovery preserves private identity descriptor');
 assert.equal((await f.send('/console/connections/remove',{csrf:f.csrf,browserId:crypto.randomUUID()})).status,403,'cannot remove another browser');
 assert.equal((await f.send('/console/connections/remove',{csrf:f.csrf,browserId:b.browserId})).status,303);
 assert.equal((await f.send('/console/device/call',{csrf:f.csrf,browserId:b.browserId,tool:'sealed_group_fetch',input:{journeyId:b.personal,groupId:b.personal,deviceId:enrolled.deviceId,since:0,limit:100}})).status,409);
 assert.equal(f.backend.snapshot().includes(code),false);assert.equal(f.backend.snapshot().includes('ONBOARDING-PRIVATE-NAME'),false);
});


test('onboarding: a second console session cannot plant its own recovery verifier',async()=>{
 const f=await fixture(),a=await f.device();await a.client.enrollGroup(a.personal);await a.client.call('account_update',{name:'Alice'});
 const second=new ConsoleSessions(f.backend,secret,origin,Date.now),cookie=(await second.create(SESSION_COOKIE,{kind:'session',...f.identity,csrf:'attacker-csrf',signedInAt:Date.now(),expiresAt:Date.now()+600000})).split(';')[0]!;
 const recoveryProof='x'.repeat(43);
 const response=await f.send('/console/setup/complete',{csrf:'attacker-csrf',browserId:a.browserId,recoveryProof},{cookie});
 assert.equal(response.status,403,'session and visible browser id are not passkey authority');
 assert.equal((await f.backend.passkey(f.identity,{op:'setup_status'})).complete,false);
 assert.equal((await f.send('/console/passkeys/options',{csrf:f.csrf,recoveryProof})).status,403,'planted code must not authorize a passkey');
 assert.equal((await f.send('/console/device/revoke',{csrf:f.csrf,browserId:a.browserId})).status,403,'device revocation is not a setup operation');
 const enrolled=await f.backend.passkey(f.identity,{op:'browser_check',browserId:a.browserId});
 for(const memberId of enrolled.devices as string[]){
  const live=(await f.backend.execute('alice',{tool:'personal_group_read',input:{}},f.identity.clientId) as {members:{id:string}[]}).members;
  if(live.some(member=>member.id===memberId))await f.backend.execute('alice',{tool:'personal_group_remove',input:{memberId}},f.identity.clientId);
 }
 assert.equal((await f.send('/console/setup/options',{csrf:f.csrf,browserId:a.browserId,recoveryProof})).status,403,'a removed leaf cannot complete onboarding');
});

test('no-code recovery completes only after 72h and fresh sign-in; old browsers and agents stay revoked',async()=>{
 const {recoveryCode,recoveryAuthorization}=await import('../../browser/src/vault.ts');
 const f=await fixture(),old=await f.device(),enrolled=await old.client.enrollGroup(old.personal);await old.client.call('account_update',{name:'Before recovery'});
 const recoveryProof=await recoveryAuthorization(recoveryCode(),origin,old.client.personId);
 await f.complete(old.browserId,recoveryProof);
 const agent=await old.client.call('agent_create',{name:'Old agent'});
 assert.equal((await f.send('/console/recovery/start',{csrf:f.csrf,confirm:'wrong'})).status,403);
 assert.equal((await f.send('/console/recovery/start',{csrf:f.csrf,confirm:'REMOVE ALL CONNECTIONS'})).status,303);
 await f.signIn();
 assert.equal((await f.send('/console/device/info',{csrf:f.csrf})).status,403);
 assert.equal((await f.send('/console/passkeys/options',{csrf:f.csrf,recoveryProof})).status,403);
 f.advance(259199999);await f.signIn();assert.equal((await f.send('/console/passkeys/options',{csrf:f.csrf})).status,403);
 f.advance(1);await f.signIn();
 const key=await authenticator(),optionsResponse=await f.send('/console/passkeys/options',{csrf:f.csrf});assert.equal(optionsResponse.status,200);
 const options=await optionsResponse.json() as {challenge:string};
 await f.signIn();
 await f.post('/console/connections/register',{credential:key.register(String(options.challenge))});
 const fresh=await f.device(key);assert.equal((await fresh.client.enrollGroup(fresh.personal)).admitted,true);
 await fresh.client.call('account_update',{name:'After recovery'});
 const newProof=await recoveryAuthorization(recoveryCode(),origin,fresh.client.personId);
 await f.complete(fresh.browserId,newProof,key);
 assert.equal(fresh.client.personId,old.client.personId);
 assert.equal((await fresh.client.call('account_read',{})).name,'After recovery');
 const status=await f.backend.passkey(f.identity,{op:'setup_status'});assert.equal(status.complete,true);assert.equal(typeof status.recoveredAt,'number');assert.equal(status.readyAt,null);
 const html=await (await f.send('/console')).text();assert.ok(html.includes(fresh.browserId));assert.ok(!html.includes(old.browserId));assert.ok(!html.includes(String(agent.agentId)));
 assert.equal((await f.send('/console/passkeys/options',{csrf:f.csrf,recoveryProof})).status,403,'old recovery proof remains invalid');
 assert.equal((await f.send('/console/device/call',{csrf:f.csrf,browserId:old.browserId,tool:'sealed_group_fetch',input:{journeyId:old.personal,groupId:old.personal,deviceId:enrolled.deviceId,since:0,limit:100}})).status,409);
 await assert.rejects(f.backend.execute('alice',{tool:'agent_capabilities',input:{agentId:String(agent.agentId)}},clientId),/live agent/i);
});

test('legacy completed accounts cannot replace recovery authority through setup completion',async()=>{
 const {recoveryCode,recoveryAuthorization}=await import('../../browser/src/vault.ts');
 const f=await fixture(),a=await f.device();await a.client.enrollGroup(a.personal);await a.client.call('account_update',{name:'Legacy private name'});
 const state=JSON.parse(String(await f.backend.accountStorage.get('accounts'))) as {accounts:import('../src/accounts.ts').Account[]};
 delete state.accounts[0]!.onboarding;delete state.accounts[0]!.recovery;await f.backend.accountStorage.put('accounts',JSON.stringify(state));
 assert.equal((await f.backend.passkey(f.identity,{op:'setup_status'})).complete,true);
 const recoveryProof=await recoveryAuthorization(recoveryCode(),origin,a.client.personId);
 assert.equal((await f.send('/console/setup/complete',{csrf:f.csrf,browserId:a.browserId,recoveryProof})).status,403);
 assert.equal((await f.send('/console/passkeys/options',{csrf:f.csrf,recoveryProof})).status,403);
});
