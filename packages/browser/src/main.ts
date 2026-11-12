import * as z from 'zod';
import {SealedClient,ConnectionPendingError} from '../../proxy/src/sealed-client.ts';
import {BrowserStore,readVault,singleWriter,forgetRevokedVault} from './store.ts';
import {BrowserAccountKey} from './account-key.ts';
import {connectionClaimSchema,requestFingerprint,safetyNumber} from '../../shared/account-identity.ts';
import {recoveryCode,recoveryAuthorization} from './vault.ts';
import {decode} from '../../proxy/src/codec.ts';
import {evaluatePrf,assertion,registerPasskey} from './webauthn.ts';
import {consolePost,consoleRemote} from './remote.ts';
import {finishOnboarding} from './onboarding.ts';
import {renderPrivateWorkspace} from './workspace.ts';
z.config({jitless:true});
const object=z.record(z.string(),z.unknown()),objects=(v:unknown)=>z.array(object).parse(v??[]);
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
function field(parent:HTMLElement,label:string,password=false){const l=el('label',label),n=el('input');n.autocomplete='off';if(password)n.type='password';l.append(n);parent.append(l);return n;}
function button(parent:HTMLElement,label:string,action:()=>Promise<void>){const b=el('button',label);b.type='button';b.addEventListener('click',()=>void run(action));parent.append(b);return b;}
const setup=document.getElementById('onboarding'),main=document.getElementById('main');
const needsSetup=Boolean(setup)&&setup?.dataset.complete!=='true';
const root=document.getElementById('connection-controls')??el('section');
if(!root.parentNode&&main){root.append(el('h2','This browser connection'));main.append(root);}
const status=el('p','Locked. Unlock this connection to read private content.');status.role='status';
const controls=el('div'),work=el('section');root.append(status,controls);main?.append(work);
const csrf=document.querySelector<HTMLInputElement>('input[name="csrf"]')?.value;
const post=consolePost(csrf);
let busy=false,client:SealedClient|undefined,store:BrowserStore|undefined,release:(()=>void)|undefined;
let refreshPrivate:((repaint?:boolean)=>Promise<void>)|undefined,syncTimer:number|undefined;
async function run(action:()=>Promise<void>){if(busy)return;busy=true;try{await action();}catch(e){status.textContent=e instanceof Error?e.message:'Connection refused';}finally{busy=false;}}
function stamp(browserId:string,unlocked:boolean){for(const row of document.querySelectorAll<HTMLElement>('[data-browser-id]'))if(row.dataset.browserId===browserId){const label=row.querySelector('[data-connection-state]');if(label)label.textContent=`This browser · ${unlocked?'Unlocked':'Locked'}`;}}
function lock(){refreshPrivate=undefined;if(syncTimer!==undefined)window.clearInterval(syncTimer);syncTimer=undefined;if(store)stamp(store.browserId,false);client=undefined;store?.lock();store=undefined;release?.();release=undefined;work.replaceChildren();controls.replaceChildren();status.textContent='Locked. Private keys and decrypted content were removed from this page.';const profile=document.getElementById('profile-editor');if(profile)profile.replaceChildren(el('h2','Your name'),el('p','Unlock this connection to read or change your private name.'));}
async function renderWorkspace(){const current=client;if(!current)return;try{await renderPrivateWorkspace(current,work,button,()=>client===current);}catch(error){if(error instanceof Error&&error.message==='Await authenticated device admission'){if(client===current)work.replaceChildren(el('p','Waiting for another online trusted connection to share private history. Keep both connections unlocked, then refresh private content.'));}else throw error;}}
window.addEventListener('pagehide',lock);document.querySelector('form[action="/console/logout"]')?.addEventListener('submit',lock);
window.addEventListener('online',()=>void run(async()=>{await refreshPrivate?.();}));
async function open(info:Record<string,unknown>,render=true,code?:string,onReady:()=>Promise<void>=async()=>{},pendingCode?:string){
 const current=store!;
 const accountKey=await BrowserAccountKey.open(current,post,String(info.personId),location.origin,code);
 const remote=consoleRemote(async(path,body)=>{if(store!==current)throw new Error('Connection locked');
  if(path==='/console/device/call'&&body.tool==='sealed_connection_request'){const input=object.parse(body.input);if(input.certificate&&accountKey.canSign)body={...body,input:{...input,event:await accountKey.event('connection-added',String(connectionClaimSchema.parse(input.claim).connectionId))}};}
  return post(path,body);},current.browserId,async device=>{
  const body={browserId:current.browserId,credentialId:current.credentialId,device},options=await post('/console/device/enroll/options',body);
  return post('/console/device/enroll/finish',{...body,assertion:(await assertion(options)).assertion});
 });
 try{client=await SealedClient.open(remote,current,z.string().parse(info.personId),accountKey.canSign?{endorse:claim=>accountKey.endorse(claim)}:{});}
 catch(error){
  if(!(error instanceof ConnectionPendingError))throw error;
  controls.replaceChildren(el('p','Waiting for a trusted browser to sign this connection. Compare this request code there.'),el('code',error.fingerprint));
  if(pendingCode)controls.append(el('p','Save this connection unlock code before leaving this page.'),el('code',pendingCode));
  status.textContent='Connection signature required. Your connection identity is saved in this browser.';
  const accountCode=field(controls,'Account recovery code (optional)',true);button(controls,'Use account recovery code to sign this connection',async()=>{const code=accountCode.value;accountCode.value='';await open(info,render,code,onReady,pendingCode);});
  button(controls,'Check for approval',async()=>{try{await open(info,render,undefined,onReady,pendingCode);}catch(e){lock();await connectionControls();throw e;}});
  button(controls,'Discard pending connection from this browser',async()=>{await current.discardPending();lock();await connectionControls();});
  button(controls,'Lock this connection',async()=>{lock();await connectionControls();});return;
 }
 const unlocked=client;
 // Use metadata here: hydrated journey_list synchronizes before a pending leaf has a Welcome.
 const synchronize=async()=>{
  const list=await post('/console/device/call',{browserId:current.browserId,tool:'journey_list',input:{}});
  const audiences=new Set([String(info.personalGroupId),...objects(list.journeys).filter(j=>!j.pending).map(j=>z.string().parse(j.journeyId))]);
  const pending:string[]=[],failures:string[]=[];
  for(const audience of audiences){
   if(store!==current||client!==unlocked)return;
   try{if(!(await unlocked.enrollGroup(audience)).admitted)pending.push(audience);}catch(error){failures.push(error instanceof Error?error.message:'Audience synchronization refused');}
  }
  if(store!==current||client!==unlocked)return;
  return {waiting:pending,failures};
 };
 const initial=await synchronize();if(!initial)return;stamp(current.browserId,true);
 let awaitingHistory=initial.waiting;
 status.textContent=initial.waiting.length?'Connection trusted. Waiting for another online connection to share private history.':initial.failures.join('; ')||'Unlocked in this tab. Private content is encrypted before sending.';
 controls.replaceChildren();button(controls,'Lock this connection',async()=>{lock();await connectionControls();});
 await renderIdentityControls(accountKey);
 if(render)await renderWorkspace();await onReady();
 if(store!==current||client!==unlocked)return;
 refreshPrivate=async(repaint=true)=>{
  if(store!==current||client!==unlocked)return;
  status.textContent='Synchronizing private audiences…';
  const result=await synchronize();if(!result)return;
  const newlyReadable=awaitingHistory.some(audience=>!result.waiting.includes(audience));awaitingHistory=result.waiting;
  if(repaint||newlyReadable)await renderWorkspace();
  if(store!==current||client!==unlocked)return;
  status.textContent=result.failures.join('; ')||(result.waiting.length?'Connection trusted. Waiting for another online connection to share private history.':'Private content refreshed. Private content is encrypted before sending.');
 };
 button(controls,'Refresh private content',()=>refreshPrivate?.()??Promise.resolve());
 if(syncTimer!==undefined)window.clearInterval(syncTimer);
 syncTimer=window.setInterval(()=>void run(async()=>{await refreshPrivate?.(false);}),15000);
}
async function renderIdentityControls(key:BrowserAccountKey){
 const panel=el('section');controls.append(panel);panel.append(el('h3','Your safety number'),el('code',await safetyNumber(key.publicKey)),el('p','Compare this number with other members outside Wayfinding. A changed number needs a fresh comparison.'));
 const refresh=async()=>{
 panel.replaceChildren(el('p','Verifying the connection log against this browser’s pinned account keys.'));
 const info=await post('/console/device/identity',{op:'identity_read'});let events;
 try{events=await client!.verifyAccountLog(key.personId,info.events??[]);}catch(error){panel.replaceChildren(el('p','Connection log verification failed. No entries are trusted.'));button(panel,'Refresh connection requests',refresh);throw error;}
 const list=el('section');panel.replaceChildren(el('h3','Your safety number'),el('code',await safetyNumber(key.publicKey)),el('p',key.canSign?'This browser can sign new connections. Compare each request code on the new connection before signing.':'Use an already trusted browser or unlock with the account recovery code to sign new connections.'),list);
 if(!key.canSign){const accountCode=field(panel,'Account recovery code (not this connection’s unlock code)',true);button(panel,'Recover account signing key',async()=>{const code=accountCode.value;accountCode.value='';const current=store;if(!current)throw new Error('Connection locked');key=await BrowserAccountKey.open(current,post,key.personId,location.origin,code);if(store!==current)throw new Error('Connection locked');await refresh();});}
 for(const entry of objects(info.connections)){
  const claim=connectionClaimSchema.parse(entry.claim),row=el('article');list.append(row);row.append(el('p',`${claim.agentId?'Agent':'Browser'} connection ${claim.connectionId} · ${entry.revokedAt?'Removed':entry.certificate?'Signed':'Awaiting signature'}`));
  if(!entry.revokedAt&&!entry.certificate&&key.canSign){const compared=field(row,'Request code shown on the new connection');button(row,'Sign this compared connection',async()=>{if(compared.value.trim()!==await requestFingerprint(claim))throw new Error('Compare the exact request code on the new connection');await post('/console/device/identity',{op:'connection_approve',certificate:await key.endorse(claim),event:await key.event('connection-added',claim.connectionId)});await refresh();});}
  if(!entry.revokedAt&&entry.certificate&&key.canSign)button(row,'Remove this connection',async()=>{await post('/console/device/identity',{op:'connection_remove',connectionId:claim.connectionId,event:await key.event('connection-removed',claim.connectionId)});await refresh();});
 }
 const log=el('details');log.append(el('summary','Your connection and safety-number log'));for(const event of events)log.append(el('p',`${new Date(event.at).toISOString()} · ${event.action} · ${event.connectionId??'Safety number'} · ${event.verified?'Signature verified':'Server report — unsigned'}`));panel.append(log);
 button(panel,'Refresh connection requests',refresh);};await refresh();
}
async function connectionControls(){
 controls.replaceChildren();
 const info=await post('/console/device/info',{}),personId=z.string().parse(info.personId),origin=location.origin;
 const record=await readVault(origin,personId),keys=objects(info.passkeys),browsers=objects(info.browsers);
 if(record){
  stamp(record.context.deviceId,false);
  // A vault can be written just before its first enrollment; keep it while setup is pending.
  const revoked=!keys.some(k=>k.id===record.credentialId)||browsers.some(b=>b.id===record.context.deviceId&&!b.live);
  if(revoked){status.textContent='This browser connection was removed. Its old encrypted storage cannot be reused.';button(controls,'Discard removed connection from this browser',async()=>{await forgetRevokedVault(origin,personId);await connectionControls();});return;}
  const unlock=async(method:{code:string}|{prf:Uint8Array})=>{
   release=await singleWriter(origin,personId);
   try{store=await BrowserStore.unlock(record,method,release);release=undefined;await open(info,!needsSetup,needsSetup&&'code'in method?method.code:undefined,async()=>{if(needsSetup)await resumeSetup(info);});}catch(e){lock();await connectionControls();throw e;}finally{if('prf'in method)method.prf.fill(0);}
  };
  button(controls,'Unlock with passkey',async()=>{const prf=await evaluatePrf(record.credentialId,decode(record.prfSalt));if(!prf)throw new Error('This passkey does not support private-key unlock. Use your recovery code.');await unlock({prf});});
  const saved=field(controls,'Recovery code',true);button(controls,'Unlock with recovery code',async()=>{const code=saved.value;saved.value='';await unlock({code});});
  return;
 }
 const needsName=setup?.dataset.complete!=='true'&&Boolean(setup);
 const name=needsName?field(controls,'Your name'):undefined;if(name){name.required=true;name.maxLength=200;}
 const codeInput=keys.length?field(controls,'Recovery code (or leave blank to confirm an existing passkey)',true):undefined;
 const trustBrowser=async(reuse=false)=>{
  const displayName=name?.value.trim();if(needsName&&!displayName)throw new Error('Set your name before continuing');
  let savedCode=codeInput?.value??'';if(codeInput)codeInput.value='';
  const proof:Record<string,unknown>={};
  if(savedCode)proof.recoveryProof=await recoveryAuthorization(savedCode,origin,personId);
  let credentialId:string;
  if(reuse){
   // Enrollment below verifies a fresh assertion bound to this browser's exact keys.
   credentialId=(await assertion(await post('/console/passkeys/addition-options',{}))).assertion.id;
  }else{
   if(!savedCode&&keys.length)proof.assertion=(await assertion(await post('/console/passkeys/addition-options',{}))).assertion;
   const credential=await registerPasskey(await post('/console/passkeys/options',proof));
   await post('/console/connections/register',{credential});credentialId=credential.id;
  }
  const code=savedCode||recoveryCode();savedCode='';
  release=await singleWriter(origin,personId);
  try{
   const salt=crypto.getRandomValues(new Uint8Array(32)),prf=await evaluatePrf(credentialId,salt);
   store=await BrowserStore.create({origin,personId,deviceId:crypto.randomUUID()},credentialId,code,salt,prf,release);release=undefined;prf?.fill(0);
   await open(info,false,proof.recoveryProof||needsName?code:undefined,async()=>{
   if(needsName){await client!.call('account_update',{name:displayName});await confirmSavedCode(code,info);}
   else if(codeInput&&!proof.recoveryProof){
    controls.replaceChildren(el('p','Save this connection unlock code. It unlocks only this browser; it does not replace your account recovery code.'),el('code',code));
    const confirmation=field(controls,'Retype your connection unlock code',true);
    button(controls,'I saved this connection unlock code',async()=>{if(confirmation.value.replaceAll('-','').replaceAll(' ','').toUpperCase()!==code.replaceAll('-',''))throw new Error('Retype the connection unlock code');confirmation.value='';controls.replaceChildren();button(controls,'Lock this connection',async()=>{lock();await connectionControls();});button(controls,'Refresh private content',()=>refreshPrivate?.()??Promise.resolve());await renderWorkspace();});
   }else{status.textContent+=' Keep using your existing account recovery code.';await renderWorkspace();}
   },code);
  }catch(e){lock();controls.replaceChildren(el('p','Connection setup was interrupted. Save this code before reloading or trying again.'),el('code',code));button(controls,'Retry saved connection',connectionControls);throw e;}
 };
 if(keys.length&&!needsName)button(controls,'Trust this browser with an existing passkey',()=>trustBrowser(true));
 button(controls,keys.length?'Add passkey and trust this browser':'Create passkey and trust this browser',()=>trustBrowser());
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
