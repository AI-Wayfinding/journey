import * as z from 'zod';
import { SealedClient } from '../../proxy/src/sealed-client.ts';
import { BrowserStore, readVault, singleWriter } from './store.ts';
import { recoveryCode } from './vault.ts';
import { decode } from '../../proxy/src/codec.ts';
import { evaluatePrf, assertion } from './webauthn.ts';
import { consoleRemote, type BrowserPost } from './remote.ts';
const object=z.record(z.string(),z.unknown()),objects=(v:unknown)=>z.array(object).parse(v??[]);
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
const output=(parent:HTMLElement,value:unknown)=>{parent.replaceChildren(el('pre',JSON.stringify(value,(_key,v)=>_key==='content'&&v?.format?'[sealed envelope]':v,2)));};
// CSP forbids Zod's optional JIT; all validation uses its interpreter.
z.config({jitless:true});
function field(parent:HTMLElement,label:string,value='',multiline=false){const wrap=el('label',label),input=multiline?el('textarea'):el('input');input.value=value;input.autocomplete='off';wrap.append(input);parent.append(wrap);return input;}
function button(parent:HTMLElement,label:string,action:()=>Promise<void>){const b=el('button',label);b.type='button';b.addEventListener('click',()=>{void run(action);});parent.append(b);return b;}
let busy=false,client:SealedClient|undefined,store:BrowserStore|undefined,release:(()=>void)|undefined;
const root=el('section');root.id='browser-device';root.append(el('h2','Private browser device'));
const status=el('p','Locked. Only ids and status are shown.');status.setAttribute('role','status');root.append(status);
const controls=el('div'),work=el('section');root.append(controls,work);
const csrf=document.querySelector<HTMLInputElement>('input[name="csrf"]')?.value;
const post:BrowserPost=async(path,body)=>{const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({csrf,...body})});if(!r.ok)throw new Error('Request refused. Check device admission, current permissions and sign-in.');return object.parse(await r.json());};
async function run(action:()=>Promise<void>){if(busy)return;busy=true;for(const b of root.querySelectorAll('button'))b.disabled=true;try{await action();}catch(error){status.textContent=error instanceof Error?error.message:'Device operation refused';}finally{busy=false;for(const b of root.querySelectorAll('button'))b.disabled=false;}}
function lock(){client=undefined;store?.lock();store=undefined;release?.();release=undefined;work.replaceChildren();controls.replaceChildren();status.textContent='Locked. Private keys and decrypted content were removed from this page.';}
window.addEventListener('pagehide',lock);
document.querySelector<HTMLFormElement>('form[action="/console/logout"]')?.addEventListener('submit',lock);
async function deviceControls(){
 controls.replaceChildren();const info=await post('/console/device/info',{}),personId=z.string().parse(info.personId),origin=location.origin;
 const record=await readVault(origin,personId);
 const keys=objects(info.passkeys),select=el('select');select.setAttribute('aria-label','Wrapping passkey');for(const k of keys){const o=el('option',String(k.label??k.id));o.value=String(k.id);select.append(o);}controls.append(select);
 controls.append(el('p','Synthetic data only. No server holds your keys. Losing all devices and recovery material loses the content. A recovery code unlocks this browser’s existing encrypted storage; a new browser needs admission from a surviving member.'));
 if(record){
  button(controls,'Unlock with passkey',async()=>{release=await singleWriter(origin,personId);try{const prf=await evaluatePrf(record.credentialId,decode(record.prfSalt));if(!prf)throw new Error('This passkey has no PRF; use your recovery code');store=await BrowserStore.unlock(record,{prf},release);release=undefined;prf.fill(0);await unlocked(info);}catch(error){store?.lock();store=undefined;client=undefined;release?.();release=undefined;throw error;}});
  const recovery=field(controls,'Recovery code');recovery.setAttribute('type','password');
  button(controls,'Unlock with recovery code',async()=>{release=await singleWriter(origin,personId);try{const code=recovery.value;recovery.value='';store=await BrowserStore.unlock(record,{code},release);release=undefined;await unlocked(info);}catch(error){store?.lock();store=undefined;client=undefined;release?.();release=undefined;throw error;}});
 }else if(keys.length){
  button(controls,'Create browser device',async()=>{
   const code=recoveryCode();controls.replaceChildren(el('p','Save this recovery code now. It will not be displayed again after confirmation.'),el('pre',code));
   const confirmation=field(controls,'Retype your saved recovery code');confirmation.setAttribute('type','password');
   button(controls,'I saved the code — create device',async()=>{
    if(confirmation.value.replaceAll('-','').replaceAll(' ','').toUpperCase()!==code.replaceAll('-',''))throw new Error('Recovery code confirmation differs');
    confirmation.value='';release=await singleWriter(origin,personId);
    try{const salt=crypto.getRandomValues(new Uint8Array(32)),prf=await evaluatePrf(select.value,salt);store=await BrowserStore.create({origin,personId,deviceId:crypto.randomUUID()},select.value,code,salt,prf,release);release=undefined;prf?.fill(0);controls.replaceChildren();await unlocked(info);}catch(error){store?.lock();store=undefined;client=undefined;release?.();release=undefined;throw error;}
   });
  });
 }else controls.append(el('p','Add a passkey on the Passkeys page first, then return here.'));
 const devices=el('details');devices.append(el('summary','Listed browser devices'));
 for(const b of objects(info.browsers)){const item=el('div',`${b.id} · ${b.live?'live':'revoked'}`);item.append(el('pre',JSON.stringify(b.devices)));if(b.live)button(item,'Revoke this browser',async()=>{const r=await post('/console/device/revoke',{browserId:b.id});if(store?.browserId===b.id)lock();status.textContent=r.revoked?'Browser revoked. Other members will remove its leaves before the next sealed write.':'Revocation pending; retry to confirm the fence.';});devices.append(item);}controls.append(devices);
}
async function unlocked(info:Record<string,unknown>){
 const current=store!;const remote=consoleRemote(async(path,body)=>{if(store!==current)throw new Error('Device locked');return post(path,body);},current.browserId,async device=>{const body={browserId:current.browserId,credentialId:current.credentialId,device};const options=await post('/console/device/enroll/options',body);const proof=await assertion(options);return post('/console/device/enroll/finish',{...body,assertion:proof.assertion});});
 client=await SealedClient.open(remote,current,z.string().parse(info.personId));controls.replaceChildren();button(controls,'Lock device',async()=>{lock();await deviceControls();});
 status.textContent='Unlocked in this tab. Cleartext stays here; writes are sealed before sending.';
 const group=field(controls,'Audience id',String(info.personalGroupId));
 const admission=el('pre');controls.append(admission);
 button(controls,'Synchronize audience',async()=>{const r=await client!.enrollGroup(group.value);admission.textContent=r.admitted?'Audience synchronized.':'Waiting for an online member’s client. Admission is automatic.';});
 // Every browser joins the personal audience. Journey and narrow audiences use the same path.
 output(admission,await client.enrollGroup(String(info.personalGroupId)));
 await renderWorkspace();
}
async function renderWorkspace(){
 work.replaceChildren();const c=client!;
 const readout=el('section'),editor=el('section');work.append(readout,editor);
 const show=async(name:string,input:Record<string,unknown>)=>{output(readout,await c.call(name,input));};
 button(editor,'Read my private profile',async()=>show('account_read',{}));
 const profile=field(editor,'Private profile name'),nickname=field(editor,'Private nickname');
 button(editor,'Seal profile',async()=>{await c.call('account_update',{name:profile.value,nickname:nickname.value});profile.value='';nickname.value='';await show('account_read',{});});
 const route=/\/console\/journeys\/([^/]+)/.exec(location.pathname),journey=field(editor,'Journey id',route?decodeURIComponent(route[1]!):'');
 button(editor,'Prepare journey audience',async()=>{output(readout,await c.enrollGroup(journey.value));});
 button(editor,'Read forum',async()=>show('forum_boards',{journeyId:journey.value}));
 button(editor,'Read topics',async()=>show('topic_list',{journeyId:journey.value}));
 button(editor,'Read rounds',async()=>show('round_list',{journeyId:journey.value}));
 button(editor,'Read journey and tasks',async()=>{
  const view=await c.call('journey_read',{journeyId:journey.value});output(readout,view);
  for(const task of objects(view.tasks)){const panel=el('details');panel.append(el('summary',`${task.name??task.taskId} · ${task.status}`));
   button(panel,'Prepare private task audience',async()=>{output(readout,await c.enrollGroup(`taskgroup_${String(task.taskId)}`));});
   button(panel,'Read private task',async()=>show('task_read',{journeyId:journey.value,taskId:task.taskId}));
   const reason=field(panel,'Decision reason', '',true);
   for(const action of ['approve','decline'])button(panel,action==='approve'?'Approve sealed':'Decline sealed',async()=>{await c.call('task_step',{journeyId:journey.value,taskId:task.taskId,action,reason:reason.value});reason.value='';await show('task_read',{journeyId:journey.value,taskId:task.taskId});});
   editor.append(panel);
  }
 });
 const topic=field(editor,'Topic id'),postText=field(editor,'Post', '',true);
 button(editor,'Read topic',async()=>show('topic_read',{topicId:topic.value}));
 button(editor,'Seal post',async()=>{await c.call('post_create',{topicId:topic.value,body:postText.value});postText.value='';await show('topic_read',{topicId:topic.value});});
 const round=field(editor,'Round id');button(editor,'Read round',async()=>show('round_read',{roundId:round.value}));
 const query=field(editor,'Search locally');button(editor,'Search library',async()=>show('library_search',{journeyId:journey.value,query:query.value,includeProjects:true}));
 button(editor,'Search offers',async()=>show('offer_search',{journeyId:journey.value,query:query.value}));
 const item=field(editor,'Library name'),body=field(editor,'Library text', '',true);
 button(editor,'Seal library item',async()=>{const r=await c.call('library_add',{journeyId:journey.value,name:item.value,kind:'markdown',text:body.value});item.value='';body.value='';output(readout,r);});
 const itemId=field(editor,'Library item id');button(editor,'Read library item',async()=>show('library_get',{itemId:itemId.value}));
 const card=field(editor,'Agent id',/\/console\/agents\/([^/]+)/.exec(location.pathname)?.[1]??'');
 button(editor,'Read card and offers',async()=>{const agents=await c.call('agent_list',{});output(readout,{agents,offers:await c.call('offer_list',{agentId:card.value})});});
 const cardName=field(editor,'Card name'),cardText=field(editor,'Card client name', '',true);
 button(editor,'Seal card',async()=>{await c.call('agent_descriptor_set',{agentId:card.value,name:cardName.value,clientName:cardText.value});cardName.value='';cardText.value='';status.textContent='Card sealed.';});
 const offer=field(editor,'Offer id'),offerName=field(editor,'Offer name'),offerText=field(editor,'Offer description', '',true);
 button(editor,'Seal offer edit',async()=>{const list=objects((await c.call('offer_list',{agentId:card.value})).offers),old=list.find(o=>o.id===offer.value);if(!old)throw new Error('Read an existing offer first');
  const definition=object.parse(old.definition??old);const pick=(key:string)=>definition[key]??old[key];
  await c.call('offer_set',{agentId:card.value,expectedVersion:old.version,offer:{id:old.id,name:offerName.value,description:offerText.value,tags:pick('tags'),examples:pick('examples'),inputSchema:pick('inputSchema'),outputSchema:pick('outputSchema'),resource:pick('resource'),instructions:pick('instructions'),journeySettings:old.journeySettings,admission:old.admission}});offerText.value='';offerName.value='';await show('offer_list',{agentId:card.value});});
}
if(csrf&&document.getElementById('main')){document.getElementById('main')!.prepend(root);void run(deviceControls);}
