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
 assert.equal(response.status,409,tool);assert.deepEqual(await response.json(),{error:'Only setup tools are allowed before onboarding completes'});
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


test('recovery HTTP: stale sign-in explains the refusal and offers sign-in again',async()=>{
 const f=await fixture();f.advance(600001);
 const response=await f.send('/console/recovery/start',{confirm:'REMOVE ALL CONNECTIONS'});
 assert.equal(response.status,403);const text=await response.text();
 assert.match(text,/A fresh sign-in is required to start recovery/);
 assert.match(text,/<a href="\/console\/login">Sign in again<\/a>/);
 assert.equal((await f.backend.passkey(identity,{op:'setup_status'})).readyAt,null);
});

test('console refusals expose only exact safe messages, never arbitrary exception text',async()=>{
 const f=await fixture(),{Refused}=await import('../src/commands.ts'),original=f.backend.passkey.bind(f.backend);
 for(const error of [new Error('A fresh sign-in is required to start recovery'),new Refused('A fresh sign-in is required to start recovery<script>SECRET</script>'),new Refused('SECRET')]){
  f.backend.passkey=async(identity,operation)=>{if(operation.op==='recovery_start')throw error;return original(identity,operation);};
  const response=await f.send('/console/recovery/start',{confirm:'REMOVE ALL CONNECTIONS'}),text=await response.text();
  assert.equal(response.status,403);assert.match(text,/Console request refused/);assert.doesNotMatch(text,/SECRET|<script>|A fresh sign-in is required to start recovery/);
 }
 const response=await f.send('/console/recovery/start',{confirm:'wrong'});
 assert.match(await response.text(),/Confirm removal of all connections/);
});
