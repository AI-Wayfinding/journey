import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend } from '../src/backend.ts';
import { createConsole } from '../src/console/index.ts';
import { ConsoleSessions,SESSION_COOKIE } from '../src/console/session.ts';
import { RESOURCE,ISSUER } from './helpers.ts';
const identity={subject:'alice',clientId:`${RESOURCE.origin}/console/client.json`};
async function fixture(){
 let now=Date.now();const backend=new MemoryBackend({async get(){return {name:'Alice',email:'alice@example.test'};}},()=>now,undefined,true);
 await backend.execute('alice',{tool:'account_read',input:{}},identity.clientId);
 const secret='onboarding-test-secret-at-least-32-bytes',sessions=new ConsoleSessions(backend,secret,RESOURCE.origin,()=>now);
 const cookie=(await sessions.create(SESSION_COOKIE,{kind:'session',...identity,csrf:'test-csrf',signedInAt:now,expiresAt:now+300000000})).split(';')[0]!;
 const target=createConsole({backend,secret,resource:RESOURCE,issuer:ISSUER,now:()=>now,verifier:{async verifyAccessToken(){throw Error('not used');}}});
 const send=(path:string,body?:Record<string,unknown>)=>target.fetch(new Request(RESOURCE.origin+path,{method:body?'POST':'GET',headers:{cookie,origin:RESOURCE.origin,'content-type':'application/json'},...(body?{body:JSON.stringify({csrf:'test-csrf',...body})}:{})}));
 return {backend,send,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
test('onboarding: incomplete account cannot reach console, profile work or agent controls',async()=>{
 const f=await fixture();
 for(const path of ['/console','/console/agents/example','/console/profile','/']){const r=await f.send(path);assert.equal(r.status,303,path);assert.equal(r.headers.get('location'),'/console/onboarding');}
 assert.equal((await f.send('/console/agents/update',{agentId:'example',name:'Attack'})).status,403);
 const r=await f.send('/console/onboarding');assert.equal(r.status,200);assert.match(await r.text(),/Set your name/);
});


for(const tool of ['agent_list','journey_list','sealed_catalog'])test(`onboarding setup call refuses ${tool}`,async()=>{
 const f=await fixture(),j=await f.backend.sealedExecute('alice','journey_create',{policy:'invite',defaultRole:'read'},identity.clientId);
 const input=tool==='sealed_catalog'?{journeyId:String(j.journeyId)}:{};
 const response=await f.send('/console/device/call',{browserId:crypto.randomUUID(),tool,input});
 assert.equal(response.status,403,tool);
});
test('recovery HTTP: all registration endpoints need a sign-in after the uncancellable deadline',async()=>{
 const f=await fixture();await f.backend.passkey({...identity,signedInAt:f.now()},{op:'recovery_start'});
 assert.equal((await f.send('/console/device/info',{})).status,403);
 const waiting=await f.send('/console/onboarding');assert.match(await waiting.text(),/Nothing can cancel/);
 f.advance(259200000);
 for(const path of ['/console/passkeys/options','/console/passkeys/register','/console/connections/register','/console/setup/complete','/console/device/info']){
  const r=await f.send(path,{});assert.equal(r.status,303,path);assert.equal(r.headers.get('location'),'/console/login');
 }
});
