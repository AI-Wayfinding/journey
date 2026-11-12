import * as z from 'zod';
import {SealedClient} from '../../proxy/src/sealed-client.ts';
import {BrowserStore,readVault,singleWriter,forgetRevokedVault} from './store.ts';
import {recoveryCode,recoveryAuthorization} from './vault.ts';
import {decode} from '../../proxy/src/codec.ts';
import {evaluatePrf,assertion,registerPasskey} from './webauthn.ts';
import {consoleRemote,type BrowserPost} from './remote.ts';
import {finishOnboarding} from './onboarding.ts';
import {renderPrivateWorkspace} from './workspace.ts';
z.config({jitless:true});
const object=z.record(z.string(),z.unknown()),objects=(v:unknown)=>z.array(object).parse(v??[]);
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
function field(parent:HTMLElement,label:string,password=false){const l=el('label',label),n=el('input');n.autocomplete='off';if(password)n.type='password';l.append(n);parent.append(l);return n;}
function button(parent:HTMLElement,label:string,action:()=>Promise<void>){const b=el('button',label);b.type='button';b.addEventListener('click',()=>void run(action));parent.append(b);return b;}
const setup=document.getElementById('onboarding'),main=document.getElementById('main');
const root=document.getElementById('connection-controls')??el('section');
if(!root.parentNode&&main){root.append(el('h2','This browser connection'));main.append(root);}
const status=el('p','Locked. Unlock this connection to read private content.');status.role='status';
const controls=el('div'),work=el('section');root.append(status,controls);main?.append(work);
const csrf=document.querySelector<HTMLInputElement>('input[name="csrf"]')?.value;
const post:BrowserPost=async(path,body)=>{const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({csrf,...body})});if(!r.ok||r.redirected)throw new Error('Request refused. Check your passkey or recovery code, permissions and sign-in.');return object.parse(await r.json());};
let busy=false,client:SealedClient|undefined,store:BrowserStore|undefined,release:(()=>void)|undefined;
async function run(action:()=>Promise<void>){if(busy)return;busy=true;try{await action();}catch(e){status.textContent=e instanceof Error?e.message:'Connection refused';}finally{busy=false;}}
function stamp(browserId:string,unlocked:boolean){for(const row of document.querySelectorAll<HTMLElement>('[data-browser-id]'))if(row.dataset.browserId===browserId){const label=row.querySelector('[data-connection-state]');if(label)label.textContent=`This browser · ${unlocked?'Unlocked':'Locked'}`;}}
function lock(){if(store)stamp(store.browserId,false);client=undefined;store?.lock();store=undefined;release?.();release=undefined;work.replaceChildren();controls.replaceChildren();status.textContent='Locked. Private keys and decrypted content were removed from this page.';const profile=document.getElementById('profile-editor');if(profile)profile.replaceChildren(el('h2','Your name'),el('p','Unlock this connection to read or change your private name.'));}
async function renderWorkspace(){const current=client;if(current)await renderPrivateWorkspace(current,work,button,()=>client===current);}
window.addEventListener('pagehide',lock);document.querySelector('form[action="/console/logout"]')?.addEventListener('submit',lock);
async function open(info:Record<string,unknown>,render=true){
 const current=store!;
 const remote=consoleRemote(async(path,body)=>{if(store!==current)throw new Error('Connection locked');return post(path,body);},current.browserId,async device=>{
  const body={browserId:current.browserId,credentialId:current.credentialId,device},options=await post('/console/device/enroll/options',body);
  return post('/console/device/enroll/finish',{...body,assertion:(await assertion(options)).assertion});
 });
 client=await SealedClient.open(remote,current,z.string().parse(info.personId));
 const admission=await client.enrollGroup(String(info.personalGroupId));stamp(current.browserId,true);
 status.textContent=admission.admitted?'Unlocked in this tab. Private content is encrypted before sending.':'Connection trusted. Waiting for another online connection to share private history.';
 controls.replaceChildren();button(controls,'Lock this connection',async()=>{lock();await connectionControls();});
 if(render)await renderWorkspace();
}
async function connectionControls(){
 controls.replaceChildren();
 const info=await post('/console/device/info',{}),personId=z.string().parse(info.personId),origin=location.origin;
 const record=await readVault(origin,personId),keys=objects(info.passkeys),browsers=objects(info.browsers);
 if(record){
  stamp(record.context.deviceId,false);
  // A vault can be written just before its first enrollment; keep it while setup is pending.
  const revoked=!keys.some(k=>k.id===record.credentialId)||browsers.some(b=>b.id===record.context.deviceId&&!b.live)||(!setup&&!browsers.some(b=>b.id===record.context.deviceId&&b.live));
  if(revoked){status.textContent='This browser connection was removed. Its old encrypted storage cannot be reused.';button(controls,'Discard removed connection from this browser',async()=>{await forgetRevokedVault(origin,personId);await connectionControls();});return;}
  const unlock=async(method:{code:string}|{prf:Uint8Array})=>{
   release=await singleWriter(origin,personId);
   try{store=await BrowserStore.unlock(record,method,release);release=undefined;await open(info,!setup);if(setup)await resumeSetup(info);}catch(e){lock();throw e;}finally{if('prf'in method)method.prf.fill(0);}
  };
  button(controls,'Unlock with passkey',async()=>{const prf=await evaluatePrf(record.credentialId,decode(record.prfSalt));if(!prf)throw new Error('This passkey does not support private-key unlock. Use your recovery code.');await unlock({prf});});
  const saved=field(controls,'Recovery code',true);button(controls,'Unlock with recovery code',async()=>{const code=saved.value;saved.value='';await unlock({code});});
  return;
 }
 const needsName=setup?.dataset.complete!=='true'&&Boolean(setup);
 const name=needsName?field(controls,'Your name'):undefined;if(name){name.required=true;name.maxLength=200;}
 const codeInput=keys.length?field(controls,'Recovery code (or leave blank to confirm an existing passkey)',true):undefined;
 button(controls,keys.length?'Add passkey and trust this browser':'Create passkey and trust this browser',async()=>{
  const displayName=name?.value.trim();if(needsName&&!displayName)throw new Error('Set your name before continuing');
  let savedCode=codeInput?.value??'';if(codeInput)codeInput.value='';
  const proof:Record<string,unknown>={};
  if(savedCode)proof.recoveryProof=await recoveryAuthorization(savedCode,origin,personId);
  else if(keys.length)proof.assertion=(await assertion(await post('/console/passkeys/addition-options',{}))).assertion;
  const credential=await registerPasskey(await post('/console/passkeys/options',proof));
  await post('/console/connections/register',{credential});
  const code=savedCode||recoveryCode();savedCode='';
  release=await singleWriter(origin,personId);
  try{
   const salt=crypto.getRandomValues(new Uint8Array(32)),prf=await evaluatePrf(credential.id,salt);
   store=await BrowserStore.create({origin,personId,deviceId:crypto.randomUUID()},credential.id,code,salt,prf,release);release=undefined;prf?.fill(0);
   await open(info,false);
   if(needsName){await client!.call('account_update',{name:displayName});await confirmSavedCode(code,info);}
   else if(codeInput&&!proof.recoveryProof){
    controls.replaceChildren(el('p','Save this connection unlock code. It unlocks only this browser; it does not replace your account recovery code.'),el('code',code));
    const confirmation=field(controls,'Retype your connection unlock code',true);
    button(controls,'I saved this connection unlock code',async()=>{if(confirmation.value.replaceAll('-','').replaceAll(' ','').toUpperCase()!==code.replaceAll('-',''))throw new Error('Retype the connection unlock code');confirmation.value='';controls.replaceChildren();button(controls,'Lock this connection',async()=>{lock();await connectionControls();});await renderWorkspace();});
   }else{status.textContent+=' Keep using your existing account recovery code.';await renderWorkspace();}
  }catch(e){lock();controls.replaceChildren(el('p','Connection setup was interrupted. Save this code before reloading or trying again.'),el('code',code));throw e;}
 });
}
async function confirmSavedCode(code:string,info:Record<string,unknown>){
 controls.replaceChildren(el('p','Save this recovery code. It will be shown only here, until you confirm.'),el('code',code));
 const confirmation=field(controls,'Retype your saved recovery code',true);
 button(controls,'I saved my recovery code — continue',async()=>{await finishOnboarding(post,{code,confirmation:confirmation.value,browserId:store!.browserId,origin:location.origin,personId:String(info.personId)});confirmation.value='';controls.replaceChildren();location.assign('/console');});
}
async function resumeSetup(info:Record<string,unknown>){
 const name=field(controls,'Set your name');name.required=true;
 const code=field(controls,'Retype the recovery code you saved',true);
 button(controls,'Finish account setup',async()=>{if(!name.value.trim())throw new Error('Set your name');const record=await readVault(location.origin,String(info.personId));if(!record)throw new Error('Connection storage missing');await client!.call('account_update',{name:name.value.trim()});await finishOnboarding(post,{code:code.value,confirmation:code.value,browserId:store!.browserId,origin:location.origin,personId:String(info.personId)},record);code.value='';location.assign('/console');});
}
if(csrf&&main&&(!document.title.startsWith('Account recovery')))void run(connectionControls);
