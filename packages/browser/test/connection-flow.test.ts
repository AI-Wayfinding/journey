import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryBackend} from '../../mcp/src/backend.ts';
import {browserPost} from '../../mcp/src/console/browser-api.ts';
import {authenticator} from '../../mcp/test/console-authenticator.ts';
import {installTestAccountIdentity} from '../../mcp/test/account-fixture.ts';
import {BrowserStore,readVault} from '../src/store.ts';
import {recoveryCode} from '../src/vault.ts';
import {sealAccountKey} from '../src/account-key.ts';
import {SealedClient} from '../../proxy/src/sealed-client.ts';
import {consoleRemote} from '../src/remote.ts';
import {connectionClaimSchema,generateSigningKey,signIdentityEvent,type IdentityEvent} from '../../shared/account-identity.ts';

// Browser platform boundaries only. Production UI, vault, crypto, WebAuthn verifier,
// console routes, connection requests and MLS enrollment all run unmodified.
class NodeElement {
 children:NodeElement[]=[];parentNode:NodeElement|undefined;dataset:Record<string,string>={};value='';type='';role='';ownText='';listeners=new Map<string,()=>void>();
 tagName:string;constructor(tagName:string){this.tagName=tagName;}
 set textContent(v:string){this.ownText=v;this.children=[];}get textContent():string{return this.ownText+this.children.map(c=>c.textContent).join(' ');}
 get childNodes(){return this.children;}
 append(...nodes:NodeElement[]){for(const n of nodes){n.parentNode=this;this.children.push(n);}}
 replaceChildren(...nodes:NodeElement[]){this.ownText='';this.children=[];this.append(...nodes);}
 addEventListener(name:string,fn:()=>void){this.listeners.set(name,fn);}
 all():NodeElement[]{return [this,...this.children.flatMap(c=>c.all())];}
}
function idb(){
 const values=new Map<string,unknown>();
 const db={createObjectStore(){},close(){},transaction(){
  const tx={oncomplete:undefined as undefined|(()=>void),objectStore(){return {
   get(key:string){const r={result:structuredClone(values.get(key)),onsuccess:undefined as undefined|(()=>void)};queueMicrotask(()=>r.onsuccess?.());return r;},
   put(value:unknown,key:string){values.set(key,structuredClone(value));queueMicrotask(()=>tx.oncomplete?.());},
   delete(key:string){values.delete(key);queueMicrotask(()=>tx.oncomplete?.());},
  };}};return tx;
 }};
 return {open(){const r={result:db,onsuccess:undefined as undefined|(()=>void)};queueMicrotask(()=>r.onsuccess?.());return r;}};
}
async function until(check:()=>boolean,message:string|(()=>string)){const end=Date.now()+5000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,5));assert.ok(check(),typeof message==='function'?message():message);}
async function flow(){
 const original=new Map<string,PropertyDescriptor|undefined>();
 const set=(key:string,value:unknown)=>{original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});};
 const main=new NodeElement('main'),controls=new NodeElement('section'),csrf=new NodeElement('input');csrf.value='test-csrf';main.append(controls);
 const windowEvents=new Map<string,()=>void>();const prf=new Uint8Array(32).fill(11),code=recoveryCode(),accountCode=recoveryCode(),browserId=crypto.randomUUID();
 const backend=new MemoryBackend({async get(){return {name:'Alice',email:'alice@example.test'};}},Date.now,undefined,true),identity={subject:'alice',clientId:'browser-test',signedInAt:Date.now()};
 await backend.accountsHost.provision('alice');
 const auth=await authenticator();const options=await backend.passkey(identity,{op:'begin'});await backend.passkey(identity,{op:'finish',credential:auth.register(String(options.challenge))});
 const signed=await installTestAccountIdentity(backend,'alice',identity.clientId);
 const state=JSON.parse(String(await backend.accountStorage.get('accounts')));state.accounts[0].onboarding={complete:true};state.accounts[0].accountKey.recoveryWrap=await sealAccountKey(signed.key,accountCode,'https://poc.wayfinding.support',signed.account.personId);await backend.accountStorage.put('accounts',JSON.stringify(state));
 const post=async(path:string,body:Record<string,unknown>)=>browserPost(backend,identity,path,{csrf:'test-csrf',...body});
 class AssertionResponse {clientDataJSON:ArrayBuffer;authenticatorData:ArrayBuffer;signature:ArrayBuffer;constructor(clientDataJSON:ArrayBuffer,authenticatorData:ArrayBuffer,signature:ArrayBuffer){this.clientDataJSON=clientDataJSON;this.authenticatorData=authenticatorData;this.signature=signature;}}
 class Credential {id:string;rawId:ArrayBuffer;response:AssertionResponse;withPrf:boolean;constructor(id:string,rawId:ArrayBuffer,response:AssertionResponse,withPrf:boolean){this.id=id;this.rawId=rawId;this.response=response;this.withPrf=withPrf;}getClientExtensionResults(){return this.withPrf?{prf:{results:{first:prf.slice().buffer}}}:{};}}
 let count=0;
 set('indexedDB',idb());set('location',{origin:'https://poc.wayfinding.support',hostname:'poc.wayfinding.support',pathname:'/console/connections',assign(){}});
 set('window',{addEventListener:(n:string,f:()=>void)=>windowEvents.set(n,f)});
 set('document',{title:'Connections',getElementById:(id:string)=>id==='main'?main:id==='connection-controls'?controls:null,createElement:(t:string)=>new NodeElement(t),querySelector:(s:string)=>s==='input[name="csrf"]'?csrf:null,querySelectorAll:()=>[]});
 set('PublicKeyCredential',Credential);set('AuthenticatorAssertionResponse',AssertionResponse);
 set('navigator',{locks:{async request(_name:string,_options:unknown,fn:(lock:object)=>Promise<void>){await fn({});}},credentials:{async get(input:{publicKey:{challenge:Uint8Array;extensions?:{prf?:unknown}}}){
  const proof=await auth.assert(Buffer.from(input.publicKey.challenge).toString('base64url'),++count),r=proof.response;
  const bytes=(s:string)=>new Uint8Array(Buffer.from(s,'base64url')).buffer;
  return new Credential(auth.id,bytes(auth.id),new AssertionResponse(bytes(r.clientDataJSON),bytes(r.authenticatorData),bytes(r.signature)),!!input.publicKey.extensions?.prf);
 }}});
 let identityEvents:IdentityEvent[]|undefined;
 set('fetch',async(path:string,init:RequestInit)=>{try{const body=JSON.parse(String(init.body)),result=await post(path,body);return Response.json(path==='/console/device/identity'&&body.op==='identity_read'&&identityEvents?{...result,events:identityEvents}:result);}catch(error){return Response.json({error:String(error)},{status:400});}});
 const vault=await BrowserStore.create({origin:location.origin,personId:signed.account.personId,deviceId:browserId},auth.id,code,new Uint8Array(32),prf,()=>{});
 const enroll=async(device:Record<string,unknown>)=>{const body={browserId,credentialId:auth.id,device},options=await post('/console/device/enroll/options',body);return post('/console/device/enroll/finish',{...body,assertion:await auth.assert(String(options.challenge),++count)});};
 return {set events(value:IdentityEvent[]){identityEvents=value},main,controls,backend,identity,signed,code,accountCode,browserId,vault,post,enroll,
  async load(){await import(`../src/main.ts?flow=${crypto.randomUUID()}`);await until(()=>controls.all().some(e=>e.tagName==='button'),'UI did not start');},
  async reload(){windowEvents.get('pagehide')?.();controls.replaceChildren();main.replaceChildren(controls);await import(`../src/main.ts?reload=${crypto.randomUUID()}`);await until(()=>controls.all().some(e=>e.tagName==='button'),'Reloaded UI did not start');},
  click(label:string){const b=controls.all().find(e=>e.tagName==='button'&&e.textContent===label);assert.ok(b,`Missing ${label}; UI: ${controls.textContent}`);b.listeners.get('click')!();},
  async stop(){windowEvents.get('pagehide')?.();await new Promise(r=>setTimeout(r,10));for(const [k,d]of original)d?Object.defineProperty(globalThis,k,d):Reflect.deleteProperty(globalThis,k);},
 };
}
test('browser pending request survives reload and later enrollment keeps its connection identity',async()=>{
 const f=await flow();try{
  f.vault.lock();await f.load();f.click('Unlock with passkey');
  await until(()=>f.controls.textContent.includes('Check for approval'),'Pending request needs a visible comparison code and retry control, not a removed-vault action');
  let info=await f.post('/console/device/identity',{op:'identity_read'});const pending=(info.connections as {claim:unknown;certificate?:unknown}[]).find(c=>!c.certificate);assert.ok(pending);
  const claim=connectionClaimSchema.parse(pending.claim),{certificate,event}=await f.signed.artifacts(claim);
  assert.ok(f.controls.all().some(e=>e.tagName==='code'&&e.textContent.length>10));
  // Reload while still pending: the same encrypted root must remain unlockable.
  await f.reload();f.click('Unlock with passkey');await until(()=>f.controls.textContent.includes('Check for approval'),'Reload discarded the pending connection');
  const retried=await f.post('/console/device/identity',{op:'identity_read'});assert.equal((retried.connections as {claim:{connectionId:string}}[])[0]!.claim.connectionId,claim.connectionId);
  await f.backend.passkey(f.identity,{op:'connection_approve',certificate,event});f.click('Check for approval');
  await until(()=>f.controls.textContent.includes('Refresh connection requests'),'Approved connection did not enroll');
  info=await f.post('/console/device/identity',{op:'identity_read'});assert.equal((info.connections as unknown[]).length,1);
  const record=await readVault(location.origin,f.signed.account.personId);assert.equal(record?.context.deviceId,f.browserId);
  const reopened=await BrowserStore.unlock(record!,{code:f.code},()=>{});assert.equal(JSON.parse((await reopened.read('connection-identity'))!).claim.connectionId,claim.connectionId);reopened.lock();
 }finally{await f.stop();}
});
test('browser without a local account key unlocks with its connection unlock code',async()=>{
 const f=await flow();try{
  const remote=consoleRemote(f.post,f.browserId,f.enroll);
  // Explicit signer is used only for this fixture's prior enrollment, never UI requests.
  const original=remote.callTool.bind(remote);remote.callTool=async request=>{if(request.name==='sealed_connection_request'&&request.arguments?.certificate){const claim=connectionClaimSchema.parse(request.arguments.claim);request={...request,arguments:{...request.arguments,event:(await f.signed.artifacts(claim)).event}};}return original(request);};
  const client=await SealedClient.open(remote,f.vault,f.signed.account.personId,{endorse:claim=>f.signed.artifacts(claim).then(a=>a.certificate)});
  const info=await f.post('/console/device/info',{});await client.enrollGroup(String(info.personalGroupId));assert.equal(await f.vault.read('account-key'),undefined);f.vault.lock();
  await f.load();const input=f.controls.all().find(e=>e.tagName==='input');assert.ok(input);input.value=f.code;f.click('Unlock with recovery code');
  await until(()=>f.controls.textContent.includes('Refresh connection requests'),()=>`Connection code must unlock without attempting to decrypt the account recovery envelope: ${f.main.textContent}`);
  assert.match(f.main.textContent,/already trusted browser|account recovery code/);
  const accountInput=f.controls.all().find(e=>e.tagName==='label'&&e.ownText==='Account recovery code (not this connection’s unlock code)')?.children[0];assert.ok(accountInput,'Account-key recovery needs its own explicit action');accountInput.value=f.accountCode;f.click('Recover account signing key');
  await until(()=>f.controls.textContent.includes('This browser can sign new connections.'),'Explicit account code did not recover the signer');
 }finally{await f.stop();}
});

for(const attack of ['broken signature','server-minted key'] as const)test(`browser account log fails closed on a ${attack}`,async()=>{
 const f=await flow();try{
  // Only the prior, explicit enrollment is signed by the fixture. UI requests run normally.
  const remote=consoleRemote(f.post,f.browserId,f.enroll),original=remote.callTool.bind(remote);
  remote.callTool=async request=>{if(request.name==='sealed_connection_request'&&request.arguments?.certificate){const claim=connectionClaimSchema.parse(request.arguments.claim);request={...request,arguments:{...request.arguments,event:(await f.signed.artifacts(claim)).event}};}return original(request);};
  const client=await SealedClient.open(remote,f.vault,f.signed.account.personId,{endorse:claim=>f.signed.artifacts(claim).then(a=>a.certificate)});
  const info=await f.post('/console/device/info',{});await client.enrollGroup(String(info.personalGroupId));f.vault.lock();
  await f.load();f.click('Unlock with passkey');await until(()=>f.controls.textContent.includes('Refresh connection requests'),'Log view did not finish');
  assert.match(f.controls.textContent,/Signature verified/);
  const key=attack==='server-minted key'?await generateSigningKey():f.signed.key;
  const event=await signIdentityEvent(key.privateKey,{personId:f.signed.account.personId,generation:0,accountPublicKey:key.publicKey,action:'connection-added',connectionId:'forged',at:Date.now()});
  if(attack==='broken signature')event.signature='A'.repeat(88);
  f.events=[event];f.click('Refresh connection requests');
  await until(()=>/Invalid signed identity log entry|Identity log key is not pinned/.test(f.main.textContent),()=>`Expected a pinned-key verification error, got: ${f.main.textContent}`);
  assert.doesNotMatch(f.controls.textContent,/Signature verified|Server report — unsigned/);
 }finally{await f.stop();}
});
