import { Refused, type Command, type ToolData } from './commands.ts';
import { SEALED_FORMAT, SEALED_NOTICE, SEALED_LIMITS, sealedInputs, sealedAction, parseSealedRouting, envelopeBytes, type PreparedContent, type ContentContext, type DeviceBinding } from './sealed-contract.ts';
import { boardRule, roundRule, projectRule, taskRule, scalar, cell, sameState, type Snapshot } from './rules.ts';
import { encodeProject as projectInput } from '../../rules/src/encode.ts';
import type { Capability } from '../../rules/src/capabilities.ts';
import type { Actor } from './agents.ts';
import { taskOperation } from './tasks.ts';
import { taskDevice, type TaskAudience } from './sealed-task-audience.ts';
import { journeyEnabled, type OfferPort } from './offers.ts';
import type { JourneyState } from './journey.ts';
import type { KeyValueStorage } from './storage.ts';
import { decodeBytes, encodeBytes, type BlobStore } from './relay.ts';
import { tokenHash } from './oauth-store.ts';

export interface SealedAuthority { binding(deviceId:string):Promise<DeviceBinding>; reserve(expected:DeviceBinding,groupId:string):Promise<DeviceBinding> }
interface Group { id:string; task?:TaskAudience; owner?:string; roundId?:string; epoch:number; sequence:number; bytes:number; messages:number; handshakeBytes?:number; handshakeMessages?:number; devices:DeviceBinding[]; pendingDevices?:string[]; usedDevices?:string[]; checkpoints:Record<string,number>; createdAt:number }
interface Reference { context:ContentContext; blob:string; hash:string; size:number; sequence:number; attachment?:string }
interface RecordState { id:string; taskId?:string; type:string; parentId:string; owner:string; revision:number; createdAt:number; updatedAt:number; refs:Reference[]; rule?:Snapshot; visibility?:'members'|'private'; projectId?:string; target?:Record<string,string>; replyTo?:string; deleted?:boolean; hidden?:boolean; locked?:boolean; source?:{itemId:string;version:number}; previousRoundId?:string; relatedItemIds?:string[]; guidanceItemId?:string; documentItemId?:string }
interface Index { revision:number; ids:string[]; groups:string[]; pending:string[];uploadBytes?:number }
interface Ticket { prepared:PreparedContent; actor:string; personId:string; action:string; indexRevision:number; records:RecordState[]; uploads?:Record<string,{blob:string;hash:string;size:number;deviceId:string}>; hash?:string; cancelled?:boolean; result?:ToolData }
interface Message {sequence:number;epoch:number;kind:'bootstrap'|'add'|'remove'|'update'|'application'|'history';deviceId:string;data?:string;blob?:string;size:number;target?:DeviceBinding;context?:ContentContext;hash?:string}
export interface SealedEnvironment { state:JourneyState; offers?:OfferPort; runnable(agentId:string):Promise<boolean>; changeTask(command:Extract<Command,{tool:'task_create'|'task_step'}>,taskId?:string):Promise<void>; actor:Actor; slot:number; person:number; can(cap:Capability):boolean; livePerson(id:string):number; eligible(binding:DeviceBinding):boolean; now:number; storage:KeyValueStorage; blobs:BlobStore; authority:SealedAuthority; deviceIds:Set<string> }
const key=(...parts:(string|number)[])=>JSON.stringify(['sealed-v1',...parts]);
async function load<T>(s:KeyValueStorage,k:string):Promise<T|undefined>{const raw=await s.get(k);if(typeof raw!=='string')return undefined;try{return JSON.parse(raw) as T;}catch{throw new Refused('Invalid sealed stored record');}}
async function save(s:KeyValueStorage,k:string,v:unknown){await s.put(k,JSON.stringify(v));}
const check=(ok:unknown,message:string):void=>{if(!ok)throw new Refused(message);};
function change(before:Snapshot,after:Snapshot):Snapshot{check(!sameState(before,after),'Sealed operation refused by coordination rules');return after;}
function recordId(e:SealedEnvironment,type:string){return `${type}_${e.state.id.slice(8)}_${crypto.randomUUID()}`;}
function personId(e:SealedEnvironment){return e.actor.personId;}
function actorId(e:SealedEnvironment){return e.actor.agent?.id??personId(e);}
function privateGroup(e:SealedEnvironment,owner:string){return `private_${e.state.id.slice(8)}_${owner}`;}
function interviewGroup(roundId:string,owner:string){return `interview_${roundId}_${owner}`;}
function taskActor(e:SealedEnvironment,t:import('./tasks.ts').JourneyTask){const a=actorId(e);return t.sealed?.actors.includes(a)||!e.actor.agent&&t.sealed?.people.includes(personId(e))||t.offer?.owner===personId(e)&&e.can('offer.decide');}
function readable(e:SealedEnvironment,r:RecordState){return !r.deleted&&(!r.taskId||!!e.state.tasks.find(t=>t.id===r.taskId&&taskActor(e,t)))&&(r.visibility!=='private'||r.owner===personId(e));}
function view(r:RecordState):ToolData {return {recordId:r.id,[`${r.type==='library'?'item':r.type}Id`]:r.id,type:r.type,parentId:r.parentId,owner:r.owner,revision:r.revision,createdAt:r.createdAt,updatedAt:r.updatedAt,visibility:r.visibility,projectId:r.projectId,target:r.target,replyTo:r.replyTo,hidden:r.hidden,locked:r.locked,source:r.source,previousRoundId:r.previousRoundId,relatedItemIds:r.relatedItemIds,guidanceItemId:r.guidanceItemId,documentItemId:r.documentItemId,rule:r.rule,content:r.hidden?[]:r.refs,notice:SEALED_NOTICE};}
function page(records:RecordState[],cursor:number){const result:ToolData[]=[];let size=0;for(const r of records.slice(cursor,cursor+100)){const value=view(r),bytes=new TextEncoder().encode(JSON.stringify(value)).length;check(bytes<=SEALED_LIMITS.pageBytes-1024,'Record metadata exceeds page budget');if(size+bytes>SEALED_LIMITS.pageBytes-1024)break;result.push(value);size+=bytes;}return {records:result,cursor:cursor+result.length,more:cursor+result.length<records.length};}
async function record(e:SealedEnvironment,id:string):Promise<RecordState>{const r=await load<RecordState>(e.storage,key('record',id));check(r&&readable(e,r),'Sealed record not found or not readable');return r!;}
async function records(e:SealedEnvironment,index:Index){return Promise.all(index.ids.map(id=>load<RecordState>(e.storage,key('record',id))));}
function requireRead(e:SealedEnvironment){check(e.can('read'),'Reading sealed content refused');}
function requireDevice(e:SealedEnvironment){check(e.can('read')&&(!e.actor.agent||e.can('device.keys')),'Sealed content refused: needs read + device.keys; ask the owner to grant both explicitly');}
function cap(e:SealedEnvironment,c:Capability){check(e.can(c),`Sealed ${c} capability refused`);}
async function group(e:SealedEnvironment,index:Index,id:string):Promise<Group>{const g=await load<Group>(e.storage,key('group',id));check(g&&index.groups.includes(id),'Unknown sealed audience');check(!g!.owner||g!.owner===personId(e),'Sealed audience is private');if(g!.task)check(await taskDevice(g!.task,{personId:personId(e),agentId:e.actor.agent?.id} as DeviceBinding,e.offers),'Task audience refused');if(g!.roundId){const r=await record(e,g!.roundId);check(cell(r.rule!,'Participants',e.person)===1,'Interview participant required');}return g!;}
async function addGroup(e:SealedEnvironment,index:Index,id:string,owner?:string,roundId?:string){if(index.groups.includes(id))return;check(index.groups.length<128,'Sealed group capacity reached');index.groups.push(id);await save(e.storage,key('group',id),{id,owner,roundId,epoch:0,sequence:0,bytes:0,messages:0,devices:[],checkpoints:{},createdAt:e.now} satisfies Group);}
async function liveDevices(e:SealedEnvironment,g:Group){const live:DeviceBinding[]=[];for(const device of g.devices){try {const b=await e.authority.binding(device.deviceId);if(e.eligible(b)&&(!g.owner||g.owner===b.personId)&&(!g.task||await taskDevice(g.task,b,e.offers)))live.push(b);}catch{/* A dead binding is not eligible. */}}return live;}
async function current(e:SealedEnvironment,g:Group){const live=await liveDevices(e,g);check(live.length===g.devices.length,'Sealed roster needs removals before publication');check(g.devices.length>0,'Create or join the sealed MLS audience first');for(const d of live)e.deviceIds.add(d.deviceId);}
async function authorizedTarget(e:SealedEnvironment,g:Group,deviceId:string):Promise<DeviceBinding>{
  const target=await e.authority.binding(deviceId);
  check(e.eligible(target)&&(!g.owner||target.personId===g.owner)&&(!g.task||await taskDevice(g.task,target,e.offers)),'Target is not entitled to audience');
  e.deviceIds.add(target.deviceId);return target;
}
async function append(e:SealedEnvironment,g:Group,message:Omit<Message,'sequence'>){
  const handshake=!['application','history'].includes(message.kind),kind=handshake?'handshake':'content';
  const quotaKey=key('quota',g.id,message.deviceId,kind);
  const used=await load<{bytes:number;messages:number}>(e.storage,quotaKey)??{bytes:0,messages:0};
  check(used.bytes+message.size<=(handshake?4:16)*1024*1024&&used.messages<(handshake?128:2048),'Sealed device retention quota exhausted');
  if(handshake){check((g.handshakeMessages??0)<4096&&(g.handshakeBytes??0)+message.size<=32*1024*1024,'Sealed handshake retention budget exhausted');g.handshakeMessages=(g.handshakeMessages??0)+1;g.handshakeBytes=(g.handshakeBytes??0)+message.size;}
  else {check(g.messages<SEALED_LIMITS.messages&&g.bytes+message.size<=SEALED_LIMITS.bytes,'Sealed group retention budget exhausted');g.messages++;g.bytes+=message.size;}
  await save(e.storage,quotaKey,{bytes:used.bytes+message.size,messages:used.messages+1});
  const sequence=++g.sequence;await save(e.storage,key('message',g.id,sequence),{...message,sequence});await save(e.storage,key('group',g.id),g);return sequence;
}
async function refundUploads(e:SealedEnvironment,index:Index,t:Ticket){
  if(t.result)return;
  for(const upload of Object.values(t.uploads??{})){
    index.uploadBytes=Math.max(0,(index.uploadBytes??0)-upload.size);
    const k=key('upload-quota',upload.deviceId),used=await load<number>(e.storage,k)??0;
    await save(e.storage,k,Math.max(0,used-upload.size));await e.blobs.delete(upload.blob);
  }
  t.uploads={};t.cancelled=true;t.prepared.expiresAt=0;
  index.pending=index.pending.filter(id=>id!==t.prepared.ticketId);
  await save(e.storage,key('ticket',t.prepared.ticketId),t);
}
async function appendCiphertext(e:SealedEnvironment,g:Group,message:Omit<Message,'sequence'|'size'|'data'|'blob'>,bytes:Uint8Array){
  const blob=`sealed_message_${crypto.randomUUID()}`;await e.blobs.put(blob,bytes);
  return append(e,g,{...message,blob,size:bytes.length});
}
function roundStep(e:SealedEnvironment,r:RecordState,op:number,subject=e.person,to=0,allowDefaults=false){const before=r.rule!;r.rule=change(before,roundRule.step(before,{op,actor:e.person,subject,to,canCreate:+e.can('round.create'),canRun:+(allowDefaults||e.can('round.run')),canContribute:+e.can('round.contribute'),subjectLive:1}));}
async function plan(e:SealedEnvironment,index:Index,action:string,input:Record<string,unknown>,operationId:string):Promise<{records:RecordState[];slots:PreparedContent['slots']}> {
  requireDevice(e);const changed:RecordState[]=[],slots:PreparedContent['slots']=[];
  const all=(await records(e,index)).filter((r):r is RecordState=>!!r&&!r.deleted);
  const get=(id:unknown)=>{const r=all.find(r=>r.id===id);check(r&&readable(e,r),'Sealed record not found or not readable');return structuredClone(r!);};
  const make=(type:string,parentId=e.state.id):RecordState=>({id:recordId(e,type),type,parentId,owner:personId(e),revision:1,createdAt:e.now,updatedAt:e.now,refs:[]});
  const edit=(r:RecordState)=>{r.revision++;r.updatedAt=e.now;return r;};
  const seal=async(r:RecordState,keyName:string,audience=e.state.id)=>{await addGroup(e,index,audience,audience===e.state.id?undefined:personId(e),audience.startsWith('interview_')?String(input.roundId):undefined);const g=await group(e,index,audience);slots.push({key:keyName,context:{format:SEALED_FORMAT,groupId:audience,parentId:r.parentId,recordId:r.id,recordType:r.type,revision:r.revision,operationId,authorId:actorId(e),epoch:g.epoch}});};
  const own=(r:RecordState)=>check(r.owner===personId(e),'Only the owner may change this sealed record');
  if(action==='task_create'||action==='task_exchange'){
    const g=await group(e,index,`taskgroup_${String(input.taskId)}`),a=g.task!;await current(e,g);
    if(action==='task_create'){cap(e,'task.manage');check(a.requester===actorId(e)&&!e.state.tasks.some(t=>t.id===a.taskId),'Task creation refused');check(Number(input.deadline)>e.now,'Task deadline must be in the future');if(a.agentId){check(await e.runnable(a.agentId),'Offering endpoint needs read + device.keys and task.manage');check(g.devices.some(d=>d.agentId===a.agentId)&&g.devices.some(d=>!d.agentId&&d.personId===a.owner),'Required offering agent and owner key admission pending');}if(a.assignee&&!a.agentId)check(g.devices.some(d=>(d.agentId??d.personId)===a.assignee),'Assignee key admission pending');}
    else {const t=e.state.tasks.find(t=>t.id===a.taskId);check(t&&taskActor(e,t),'Task access refused');cap(e,input.action==='approve'||input.action==='decline'?'offer.decide':input.action==='cancel'?'task.manage':'read');check(![4,5,6,8,10].includes(scalar(t!.rule,'status')),'Task is final');const action=String(input.action),op=taskOperation(action);check(action!=='claim'||!t!.assignee||t!.assignee===actorId(e),'Only the task assignee may claim it');const next=taskRule.step(t!.rule,{op,actor:e.slot,actorIsLive:1,deadlinePassed:+(e.now>=t!.deadline),maxRounds:0,isDecider:+(t!.offer?.owner===personId(e)&&(!e.actor.agent||e.can('offer.decide'))),agent:0});check(!sameState(t!.rule,next)||action==='approve'&&t!.offer?.admitted&&scalar(t!.rule,'status')===2,'Task change refused by coordination rules');}
    const r=make(action==='task_create'?'task':'taskEvent',a.taskId);if(action==='task_create')r.id=a.taskId;r.taskId=a.taskId;changed.push(r);await seal(r,'content',g.id);
  }
  else if(action==='identity_descriptor'){cap(e,'read');if(input.kind==='profile')cap(e,'account.nickname');else check(!e.actor.agent||e.actor.agent.id===input.agentId,'Only owned agent descriptor');const r=make(String(input.kind));r.parentId=String(input.agentId??personId(e));r.target={personId:personId(e),...(input.agentId?{agentId:String(input.agentId)}:{})};r.revision=Number(input.contentRevision);r.visibility=input.private?'private':'members';changed.push(r);await seal(r,'content',input.private?privateGroup(e,personId(e)):e.state.id);}
  else if(action==='offer_definition'){cap(e,'read');const r=make('offer');r.parentId=String(input.agentId);r.target={agentId:String(input.agentId),offerId:String(input.offerId)};r.revision=Number(input.contentRevision);r.visibility=input.private?'private':'members';changed.push(r);await seal(r,'content',input.private?privateGroup(e,personId(e)):e.state.id);}
  else if(action==='journey_descriptor'){cap(e,'journey.policy');let r=all.find(r=>r.type==='journey');r=r?edit(structuredClone(r)):make('journey');r.id=e.state.id;changed.push(r);await seal(r,'descriptor');}
  else if(action==='board_create'||action==='board_update'){cap(e,'board.manage');const r=action==='board_create'?make('board'):edit(get(input.boardId));r.rule=change(r.rule??boardRule.init(),boardRule.step(r.rule??boardRule.init(),{op:action==='board_create'?0:1,actor:e.slot,guide:1,newArchived:+(input.archived===true)}));if(action==='board_update'&&input.archived!==undefined)r.rule=boardRule.step(r.rule,{op:2,actor:e.slot,guide:1,newArchived:+(input.archived===true)});changed.push(r);await seal(r,'descriptor');}
  else if(action==='project_create'||action==='project_update'){cap(e,action==='project_create'?'project.create':'project.edit');const r=action==='project_create'?make('project'):edit(get(input.projectId));if(action==='project_create')r.rule=change(projectRule.init(),projectRule.step(projectRule.init(),projectInput({op:'create',actor:e.slot,actorIsLive:true})));else {check(r.type==='project','Project required');if(input.status!==undefined)r.rule=change(r.rule!,projectRule.step(r.rule!,projectInput({op:'setStatus',actor:e.slot,actorIsLive:true,to:input.status as 'gettingStarted'|'active'|'lookingForOthers'|'archived'})));else r.rule=change(r.rule!,projectRule.step(r.rule!,projectInput({op:'setPurpose',actor:e.slot,actorIsLive:true})));}changed.push(r);await seal(r,'descriptor');}
  else if(action==='topic_create'){cap(e,'topic.create');cap(e,'post');const board=get(input.boardId);check(board.type==='board'&&scalar(board.rule!,'archived')===0,'Open board required');const topic=make('topic',board.id),post=make('post',topic.id);changed.push(topic,post);await seal(topic,'descriptor');await seal(post,'body');}
  else if(action==='post_create'||action==='post_edit'||action==='conversation_post'){
    cap(e,'post');let topic:RecordState;
    if(action==='post_edit'){const post=get(input.postId);check(post.type==='post'&&post.owner===personId(e)&&post.refs.at(-1)?.context.authorId===actorId(e),'Only the original author may edit a post');topic=get(post.parentId);edit(post);changed.push(post);await seal(post,'body',topic.taskId?`taskgroup_${topic.taskId}`:topic.visibility==='private'?privateGroup(e,topic.owner):e.state.id);}
    else {if(action==='conversation_post'){const target=input.target as Record<string,string>;const targetId=Object.values(target)[0]!;const parent=get(targetId);topic=structuredClone(all.find(r=>r.type==='topic'&&r.target&&Object.values(r.target)[0]===targetId)??make('topic',targetId));topic.target=target;topic.taskId=parent.taskId;topic.visibility=parent.visibility;topic.owner=parent.owner;if(!all.some(r=>r.id===topic.id)){changed.push(topic);await seal(topic,'descriptor',topic.taskId?`taskgroup_${topic.taskId}`:topic.visibility==='private'?privateGroup(e,topic.owner):e.state.id);}}
      else topic=get(input.topicId);check(topic.type==='topic'&&!topic.locked,'Open topic required');const parent=all.find(r=>r.id===topic.parentId);if(parent?.type==='board')check(scalar(parent.rule!,'archived')===0,'Open board required');if(input.replyTo){const reply=get(input.replyTo);check(reply.type==='post'&&reply.parentId===topic.id,'Reply must belong to this topic');}const post=make('post',topic.id);post.replyTo=input.replyTo as string|undefined;post.visibility=topic.visibility;post.taskId=topic.taskId;post.owner=personId(e);changed.push(post);await seal(post,'body',topic.taskId?`taskgroup_${topic.taskId}`:topic.visibility==='private'?privateGroup(e,topic.owner):e.state.id);}
  }
  else if(['library_add','library_update','library_version','artifact_create','artifact_version','artifact_rename'].includes(action)){
    cap(e,'artifact.write');const create=action==='library_add'||action==='artifact_create',r=create?make('library'):edit(get(input.itemId??input.artifactId));check(create||r.type==='library','Library item required');if(!create)own(r);if(input.baseVersion!==undefined)check(input.baseVersion===r.revision-1,'Library baseVersion mismatch');if(input.projectId!==undefined&&input.projectId!==null)check(get(input.projectId).type==='project','Project not found');r.projectId=input.projectId===null?undefined:input.projectId as string|undefined??r.projectId;
    const visibility=(input.visibility as 'members'|'private'|undefined)??r.visibility??'members';if(!create&&visibility!==r.visibility){const affected=[r,...all.filter(t=>t.target?.itemId===r.id)];const topics=all.filter(t=>t.target?.itemId===r.id);affected.push(...all.filter(p=>p.type==='post'&&topics.some(t=>t.id===p.parentId)));let n=0;for(const a of new Map(affected.map(a=>[a.id,a])).values()){const copy=a.id===r.id?r:structuredClone(a);copy.visibility=visibility;if(copy.id!==r.id)changed.push(copy);for(const old of copy.refs){check(n<99,'Visibility manifest too large');await seal(copy,`history_${n++}`,visibility==='private'?privateGroup(e,r.owner):e.state.id);const slot=slots.at(-1)!;slot.context.revision=old.context.revision;slot.context.authorId=actorId(e);slot.source=old.context;}}}
    r.visibility=visibility;changed.push(r);await seal(r,'content',visibility==='private'?privateGroup(e,r.owner):e.state.id);
  }
  else if(action==='round_create'||action==='round_next'){
    cap(e,'round.create');let previous:RecordState|undefined;if(action==='round_next'){previous=get(input.roundId);cap(e,'round.run');check(previous.owner===personId(e)&&scalar(previous.rule!,'status')===3,'Only a closed facilitated round starts a successor');}
    const r=make('round');r.rule=roundRule.init();roundStep(e,r,0);const people=Array.isArray(input.participants)?input.participants:e.state.identities.filter(p=>e.livePerson(p.id)>0).map(p=>p.id);for(const p of new Set(people)){const subject=e.livePerson(String(p));check(subject,'Live participant required');roundStep(e,r,2,subject,0,true);}
    for(const field of ['guidanceItemId','documentItemId'] as const){if(input[field]){const item=get(input[field]);check(item.type==='library'&&item.visibility==='members','Round artifacts must be shared');r[field]=item.id;}}
    for(const id of input.relatedItemIds as string[]??[])check(get(id).visibility==='members','Related artifacts must be shared');r.relatedItemIds=input.relatedItemIds as string[]??[];r.previousRoundId=previous?.id;
    const guidance=r.guidanceItemId?undefined:make('library'),document=r.documentItemId?undefined:make('library');for(const [keyName,item] of [['guidance',guidance],['document',document]] as const){if(item){item.visibility='members';changed.push(item);await seal(item,keyName);if(keyName==='guidance')r.guidanceItemId=item.id;else r.documentItemId=item.id;}}
    const conversation=make('topic',r.id);conversation.target={roundId:r.id};changed.push(r,conversation);await seal(r,'descriptor');await seal(conversation,'conversation');
  }
  else if(action==='interview_write'||action==='interview_share'){
    cap(e,'round.contribute');const round=get(input.roundId);check(round.type==='round'&&cell(round.rule!,'Participants',e.person)===1,'Only a participant may write their interview');const old=all.find(r=>r.type==='interview'&&r.parentId===round.id&&r.owner===personId(e));const r=old?edit(structuredClone(old)):make('interview',round.id);r.visibility='private';if(action==='interview_share'){check(old&&old.refs.length,'Materialise the private interview before sharing');roundStep(e,round,4);changed.push(round);}
    const assignment=await load<{itemId:string;version:number}>(e.storage,key('assignment',round.id,personId(e)));if(assignment)r.source=assignment;changed.push(r);await seal(r,'private',interviewGroup(round.id,personId(e)));if(action==='interview_share'||cell(round.rule!,'Shared',e.person)===1)await seal(r,'publication');
  }
  else if(action==='round_contribute'){cap(e,'round.contribute');const round=get(input.roundId);check(round.type==='round','Round required');roundStep(e,round,5);const r=make('contribution',round.id);r.revision=scalar(round.rule!,'contributions');changed.push(round,r);await seal(r,'content');}
  else throw new Refused('Unknown sealed content action');
  check(index.ids.length+changed.filter(r=>!index.ids.includes(r.id)).length<=1024,'Sealed record capacity reached');return {records:changed,slots};
}

/** The Journey host owns the serial turn and WriteReceiver. No write escapes its staged transaction. */
export async function sealedContent(e:SealedEnvironment,tool:string,supplied:unknown):Promise<ToolData>{
  const schema=sealedInputs[tool];check(schema,'Unknown sealed operation');const input=schema!.parse(supplied) as Record<string,unknown>;
  const index=await load<Index>(e.storage,key('index'))??{revision:0,ids:[],groups:[],pending:[]};
  for(const id of [...index.pending]){const t=await load<Ticket>(e.storage,key('ticket',id));if(t&&!t.result&&t.prepared.expiresAt<=e.now)await refundUploads(e,index,t);}
  await addGroup(e,index,e.state.id);await save(e.storage,key('index'),index);
  if(tool==='task_prepare'){
    requireDevice(e);cap(e,'task.manage');const taskId=`task_${e.state.id.slice(8)}_${crypto.randomUUID()}`,groupId=`taskgroup_${taskId}`;
    const a:TaskAudience={taskId,requester:actorId(e),requesterPerson:personId(e)};
    if(input.agentId||input.offerId){const agent=(await e.offers?.directory())?.find(g=>g.id===input.agentId),offer=agent?.offers.find(o=>o.id===input.offerId);check(agent&&offer?.status==='published'&&journeyEnabled(offer,e.state.id)&&offer.sealed&&await e.runnable(agent.id),'Offer is not available');a.agentId=agent!.id;a.assignee=agent!.id;a.owner=agent!.owner;a.offerId=offer!.id;a.version=offer!.version;a.definition=offer!.sealed!.publications[e.state.id];}
    else if(input.assignee){check(e.state.identities.some(i=>i.id===input.assignee&&e.livePerson(i.id)),'Live assignee required');a.assignee=String(input.assignee);}
    await addGroup(e,index,groupId);const g=await load<Group>(e.storage,key('group',groupId));g!.task=a;await save(e.storage,key('group',groupId),g);await save(e.storage,key('index'),index);return {taskId,groupId,definition:a.definition,requiredActors:[a.requester,a.assignee,a.owner].filter(Boolean)};
  }
  if(tool==='task_claim_prepare'){requireDevice(e);const t=e.state.tasks.find(t=>t.id===input.taskId);check(t&&t.sealed&&!t.assignee&&scalar(t.rule,'status')===1&&e.now<t.deadline,'Unassigned open task required');const g=await load<Group>(e.storage,key('group',t!.sealed!.groupId));check(g?.task,'Task audience unavailable');check(!g!.task!.claimant||g!.task!.claimant===actorId(e),'Claimant admission already pending');g!.task!.claimant=actorId(e);await save(e.storage,key('group',g!.id),g);t!.sealed!.actors=[...new Set([...t!.sealed!.actors,actorId(e)])];await e.storage.put('journey',JSON.stringify(e.state));return {groupId:g!.id,admission:'pending'};}
  if(tool==='content_prepare'){
    const action=sealedAction.parse(input.action),routing=parseSealedRouting(action,input.routing),ticketId=crypto.randomUUID();
    const p=await plan(e,index,action,routing,ticketId),prepared:PreparedContent={ticketId,expiresAt:e.now+SEALED_LIMITS.pending,slots:p.slots,routing};
    const active:string[]=[];for(const id of index.pending){const t=await load<Ticket>(e.storage,key('ticket',id));if(t&&t.prepared.expiresAt>e.now&&!t.result)active.push(id);}check(active.length<128,'Pending content capacity reached');index.pending=[...active,ticketId];
    await save(e.storage,key('ticket',ticketId),{prepared,actor:actorId(e),personId:personId(e),action,indexRevision:index.revision,records:p.records} satisfies Ticket);await save(e.storage,key('index'),index);return prepared;
  }
  if(tool==='sealed_blob_put'){
    requireDevice(e);const t=await load<Ticket>(e.storage,key('ticket',String(input.ticketId)));
    check(t&&t.actor===actorId(e)&&t.personId===personId(e)&&!t.result&&t.prepared.expiresAt>e.now,'Live author upload ticket required');
    const slot=String(input.slot);check(t!.prepared.slots.some(s=>s.key===slot),'Unknown upload slot');
    const bytes=decodeBytes(String(input.data),SEALED_LIMITS.blob),hash=await tokenHash(encodeBytes(bytes));
    const binding=await e.authority.binding(String(input.deviceId)),audience=await group(e,index,t!.prepared.slots.find(s=>s.key===slot)!.context.groupId);
    check(binding.personId===personId(e)&&binding.agentId===e.actor.agent?.id&&e.eligible(binding)&&audience.devices.some(d=>d.deviceId===binding.deviceId),'Authenticated upload device required');
    const prior=t!.uploads?.[slot];if(prior){check(prior.hash===hash,'Upload slot already bound to different ciphertext');return prior;}
    e.deviceIds.add(binding.deviceId);const quotaKey=key('upload-quota',binding.deviceId),used=await load<number>(e.storage,quotaKey)??0;
    check(used+bytes.length<=16*1024*1024,'Sealed device upload quota exhausted');await save(e.storage,quotaKey,used+bytes.length);
    check(Object.values(t!.uploads??{}).reduce((n,u)=>n+u.size,bytes.length)<=SEALED_LIMITS.blob,'Ticket upload budget exhausted');
    check((index.uploadBytes??0)+bytes.length<=SEALED_LIMITS.bytes,'Retained upload budget exhausted');index.uploadBytes=(index.uploadBytes??0)+bytes.length;await save(e.storage,key('index'),index);
    const upload={blob:`blob_${crypto.randomUUID()}`,hash,size:bytes.length,deviceId:binding.deviceId};await e.blobs.put(upload.blob,bytes);
    t!.uploads??={};t!.uploads[slot]=upload;await save(e.storage,key('ticket',t!.prepared.ticketId),t);return upload;
  }
  if(tool==='content_status'||tool==='content_abandon'||sealedAction.safeParse(tool).success){
    const t=await load<Ticket>(e.storage,key('ticket',String(input.ticketId)));check(t&&t.actor===actorId(e)&&t.personId===personId(e),'Unknown content ticket');requireDevice(e);if(tool==='content_status')return t!.result?{state:'committed',hash:t!.hash,result:t!.result}:{state:'uncommitted',expiresAt:t!.prepared.expiresAt};
    if(tool==='content_abandon'){check(!t!.result,'Committed content cannot be abandoned');await refundUploads(e,index,t!);t!.cancelled=true;t!.prepared.expiresAt=0;index.pending=index.pending.filter(id=>id!==t!.prepared.ticketId);await save(e.storage,key('ticket',t!.prepared.ticketId),t);await save(e.storage,key('index'),index);return {state:'cancelled'};}
    check(t!.action===tool,'Ticket action mismatch');const hash=await tokenHash(JSON.stringify(input.envelopes));if(t!.result){check(t!.hash===hash,'Committed operation hash conflict');return t!.result;}
    check(!t!.cancelled&&t!.prepared.expiresAt>e.now,'Content ticket expired');check(t!.indexRevision===index.revision,'Content revision changed; prepare again');
    // Re-run live capability/ownership/lifecycle checks without publishing the freshly allocated plan.
    await plan(e,index,t!.action,t!.prepared.routing,t!.prepared.ticketId);
    const envelopes=input.envelopes as Record<string,unknown>;check(Object.keys(envelopes).length===t!.prepared.slots.length,'Exact complete envelope manifest required');
    const devices=new Map<string,DeviceBinding>();for(const groupId of new Set(t!.prepared.slots.map(s=>s.context.groupId))){const device=await e.authority.binding(String((input.devices as Record<string,string>)[groupId]));check(device.personId===personId(e)&&device.agentId===e.actor.agent?.id&&e.eligible(device),'Authenticated author device required');devices.set(groupId,device);}
    const refs:Reference[]=[];
    for(const slot of t!.prepared.slots){
      check(Object.hasOwn(envelopes,slot.key),'Missing sealed envelope');const g=await group(e,index,slot.context.groupId),device=devices.get(g.id)!;await current(e,g);
      check(g.devices.some(d=>d.deviceId===device.deviceId),'Author device is not in audience');const bytes=envelopeBytes(envelopes[slot.key],g.id,g.epoch);check(g.epoch===slot.context.epoch,'Prepared epoch is stale');
      const upload=t!.uploads?.[slot.key];let attachment=upload?.blob;
      if(slot.source){const source=await load<RecordState>(e.storage,key('record',slot.source.recordId));attachment=source?.refs.find(ref=>JSON.stringify(ref.context)===JSON.stringify(slot.source))?.attachment;}
      const blob=key('envelope',t!.prepared.ticketId,slot.key);await e.blobs.put(blob,bytes);const hash=await tokenHash(encodeBytes(bytes));
      const sequence=await append(e,g,{epoch:g.epoch,kind:'application',deviceId:device.deviceId,blob,size:bytes.length+(upload?.size??0),context:slot.context,hash});refs.push({context:slot.context,blob,hash,size:bytes.length,sequence,...(attachment?{attachment}:{})});
    }
    if(t!.action==='task_create'||t!.action==='task_exchange'){
      const route=t!.prepared.routing,g=await group(e,index,`taskgroup_${String(route.taskId)}`),a=g.task!;
      if(t!.action==='task_create'){
        const command={tool:'task_create',input:{journeyId:e.state.id,name:SEALED_NOTICE,deadline:Number(route.deadline),maxRounds:Number(route.maxRounds),...(a.agentId?{agentId:a.agentId,offerId:a.offerId,input:{}}:{assignee:a.assignee})}} as Extract<Command,{tool:'task_create'}>;
        if(a.agentId){const offer=(await e.offers?.directory())?.find(g=>g.id===a.agentId)?.offers.find(o=>o.id===a.offerId);check(offer&&offer.version===a.version&&JSON.stringify(offer.sealed?.publications[e.state.id])===JSON.stringify(a.definition),'Pinned offer changed; prepare a new task');}
        await e.changeTask(command,a.taskId);const task=e.state.tasks.find(t=>t.id===a.taskId)!;task.sealed={groupId:g.id,recordId:a.taskId,definition:a.definition,actors:[a.requester,a.assignee].filter((id):id is string=>!!id),people:[a.requesterPerson,a.owner].filter((id):id is string=>!!id)};
      }else {if(route.action==='claim')check(g.devices.some(d=>(d.agentId??d.personId)===actorId(e)),'Claimant key admission pending');await e.changeTask({tool:'task_step',input:{journeyId:e.state.id,taskId:a.taskId,action:route.action,standing:route.standing}} as Extract<Command,{tool:'task_step'}>);}
      // Persist the sealed audience association with the same staged task/alarm transaction.
      await e.storage.put('journey',JSON.stringify(e.state));
    }
    for(const r of t!.records){const incoming=refs.filter(ref=>ref.context.recordId===r.id);if(t!.action==='library_update'&&t!.prepared.routing.visibility!==undefined)r.refs=r.refs.filter(old=>!incoming.some(ref=>ref.context.revision===old.context.revision));r.refs.push(...incoming);await save(e.storage,key('record',r.id),r);if(!index.ids.includes(r.id))index.ids.push(r.id);}
    index.revision++;index.pending=index.pending.filter(id=>id!==t!.prepared.ticketId);const result={journeyId:e.state.id,accepted:true,records:t!.records.map(view)};t!.result=result;t!.hash=hash;await save(e.storage,key('ticket',t!.prepared.ticketId),t);await save(e.storage,key('index'),index);return result;
  }
  if(tool==='sealed_history_post'){requireDevice(e);const g=await group(e,index,String(input.groupId));await current(e,g);const b=await e.authority.binding(String(input.deviceId));check(b.personId===personId(e)&&b.agentId===e.actor.agent?.id&&g.devices.some(d=>d.deviceId===b.deviceId),'History sender device refused');const contexts=input.contexts as ContentContext[];const all=(await records(e,index)).filter((r):r is RecordState=>!!r&&!r.deleted&&(readable(e,r)||r.type==='interview'&&r.refs.some(ref=>ref.context.groupId===e.state.id)));for(const ctx of contexts)check(ctx.groupId===g.id&&all.some(r=>!r.hidden&&r.refs.some(ref=>JSON.stringify(ref.context)===JSON.stringify(ctx))),'History must reference entitled retained content');const bytes=envelopeBytes(input.envelope,g.id,g.epoch);const sequence=await appendCiphertext(e,g,{epoch:g.epoch,kind:'history',deviceId:b.deviceId},bytes);return {sequence};}
  if(tool.startsWith('sealed_group')){
    requireDevice(e);const g=await group(e,index,String(input.groupId));
    if(tool==='sealed_group'){
      if(input.deviceId){
        const b=await authorizedTarget(e,g,String(input.deviceId));
        check(b.personId===personId(e)&&b.agentId===e.actor.agent?.id,'Only own device may request automatic admission');
        if(!g.devices.some(d=>d.deviceId===b.deviceId)&&!g.pendingDevices?.includes(b.deviceId)){
          check((g.pendingDevices?.length??0)<128,'Pending device capacity reached');
          g.pendingDevices=[...(g.pendingDevices??[]),b.deviceId];await save(e.storage,key('group',g.id),g);
        }
      }
      const live=await liveDevices(e,g),pending:DeviceBinding[]=[];
      for(const id of g.pendingDevices??[])if(!g.devices.some(d=>d.deviceId===id)){
        try{pending.push(await authorizedTarget(e,g,id));}catch{/* Ineligible packages are never admitted. */}
      }
      return {groupId:g.id,definition:g.task?.definition,epoch:g.epoch,sequence:g.sequence,devices:g.devices,pending,remove:g.devices.filter(d=>!live.some(l=>l.deviceId===d.deviceId)).map(d=>d.deviceId),checkpointLifetimeMs:SEALED_LIMITS.checkpoint};
    }
    if(tool==='sealed_group_commit'){
      const binding=await e.authority.binding(String(input.deviceId));check(binding.personId===personId(e)&&binding.agentId===e.actor.agent?.id&&e.eligible(binding),'Authenticated device binding required');check(input.expectedEpoch===g.epoch&&input.expectedSequence===g.sequence,'Sealed group CAS mismatch');
      const action=String(input.action);let target:DeviceBinding|undefined;
      if(action==='bootstrap'){check(!g.devices.length&&!g.sequence,'Group already bootstrapped');target=await authorizedTarget(e,g,binding.deviceId);g.devices.push(binding);}
      else {check(g.devices.some(d=>d.deviceId===binding.deviceId),'Current group device required');if(action==='add'){check(g.devices.length<128,'Audience device capacity reached');target=await authorizedTarget(e,g,String(input.targetDeviceId));check(!g.devices.some(d=>d.deviceId===target!.deviceId),'Device already admitted');g.devices.push(target);}else if(action==='remove'){const id=String(input.targetDeviceId);target=g.devices.find(d=>d.deviceId===id);check(target,'Unknown removed device');check(target!.personId===binding.personId||!(await liveDevices(e,g)).some(d=>d.deviceId===id),'Only own devices or server-ineligible devices may be removed');g.devices=g.devices.filter(d=>d.deviceId!==id);}g.epoch++;}
      if(target&&(action==='bootstrap'||action==='add')){check(!g.usedDevices?.includes(target.deviceId),'Key package was already consumed; register a new device package');await e.authority.reserve(target,g.id);g.usedDevices=[...(g.usedDevices??[]),target.deviceId];}
      if(target&&action==='add'||action==='bootstrap')g.checkpoints[target!.deviceId]=e.now;const bytes=decodeBytes(String(input.data),SEALED_LIMITS.envelope);if(action!=='remove')await current(e,g);if(action==='add')g.pendingDevices=g.pendingDevices?.filter(id=>id!==target!.deviceId);const sequence=await appendCiphertext(e,g,{epoch:g.epoch,kind:action as Message['kind'],deviceId:binding.deviceId,target},bytes);await save(e.storage,key('index'),index);return {sequence,epoch:g.epoch};
    }
    const binding=await e.authority.binding(String(input.deviceId));check(binding.personId===personId(e)&&binding.agentId===e.actor.agent?.id&&g.devices.some(d=>d.deviceId===binding.deviceId),'Current device required for retained history');const since=Number(input.since),limit=Number(input.limit);check(e.now-(g.checkpoints[binding.deviceId]??0)<=SEALED_LIMITS.checkpoint,'Offline checkpoint expired; rejoin through a live member');const messages:Message[]=[];let size=0;for(let n=since+1;n<=g.sequence&&messages.length<limit;n++){const m=await load<Message>(e.storage,key('message',g.id,n));check(m,'Missing retained MLS message');if(m!.blob){const b=await e.blobs.get(m!.blob);check(b,'Missing retained ciphertext');m!.data=encodeBytes(new Uint8Array(await b!.arrayBuffer()));}const wireSize=new TextEncoder().encode(JSON.stringify(m)).length;if(size+wireSize>SEALED_LIMITS.pageBytes)break;messages.push(m!);size+=wireSize;}g.checkpoints[binding.deviceId]=e.now;await save(e.storage,key('group',g.id),g);return {messages,cursor:messages.at(-1)?.sequence??since};
  }
  if(tool==='sealed_blob_get'){
    requireRead(e);const r=await load<RecordState>(e.storage,key('record',String(input.recordId)));check(r&&!r.deleted&&!r.hidden&&r.refs.some(ref=>ref.context.revision===input.revision&&ref.attachment===input.blob&&(readable(e,r)||r.type==='interview'&&ref.context.groupId===e.state.id)),'Entitled committed blob reference required');
    const blob=await e.blobs.get(String(input.blob));check(blob,'Missing sealed blob');return {data:encodeBytes(new Uint8Array(await blob!.arrayBuffer()))};
  }
  requireRead(e);const all=(await records(e,index)).filter((r):r is RecordState=>!!r&&readable(e,r));const get=(id:unknown)=>{const r=all.find(r=>r.id===id);check(r,'Sealed record not readable');return r!;};
  if(tool==='sealed_package_reserve'){requireDevice(e);const g=await group(e,index,String(input.groupId));await current(e,g);const target=await authorizedTarget(e,g,String(input.deviceId));return e.authority.reserve(target,g.id);}
  if(['round_status','round_participants','post_hide','post_unhide','topic_lock','topic_unlock','project_join','project_leave'].includes(tool)){const r=get(input.roundId??input.postId??input.topicId??input.projectId);if(tool==='round_status'){cap(e,'round.run');check(r.type==='round','Round required');roundStep(e,r,1,e.person,['planned','open','synthesising','closed'].indexOf(String(input.to)));}else if(tool==='round_participants'){cap(e,'round.run');check(r.type==='round','Round required');const add=input.add as string[],remove=input.remove as string[];check(add.length+remove.length>0&&!add.some(p=>remove.includes(p)),'Invalid participant changes');for(const p of add){const s=e.livePerson(p);check(s,'Live participant required');roundStep(e,r,2,s);}for(const p of remove){const s=e.state.identities.findIndex(i=>i.id===p)+1;check(s,'Known participant required');roundStep(e,r,3,s);}}else if(tool.startsWith('post_')){cap(e,'board.manage');check(r.type==='post','Post required');r.hidden=tool==='post_hide';}else if(tool.startsWith('topic_')){check(r.type==='topic','Topic required');check(e.can('board.manage')||r.owner===personId(e)&&e.can('topic.create'),'Topic author or guide required');r.locked=tool==='topic_lock';}else {check(r.type==='project','Project required');cap(e,'read');r.rule=change(r.rule!,projectRule.step(r.rule!,projectInput({op:tool==='project_join'?'join':'leave',actor:e.slot,actorIsLive:true})));}r.updatedAt=e.now;index.revision++;await save(e.storage,key('record',r.id),r);await save(e.storage,key('index'),index);return view(r);}
  if(tool==='library_delete'){cap(e,'artifact.delete');const r=get(input.itemId);check(r.type==='library'&&(r.owner===personId(e)||e.can('board.manage')),'Library owner or guide required');r.deleted=true;index.revision++;await save(e.storage,key('record',r.id),r);await save(e.storage,key('index'),index);return {deleted:true};}
  if(tool==='interview_assign'){cap(e,'round.run');const r=get(input.roundId),subject=e.livePerson(String(input.personId));check(r.owner===personId(e)&&subject&&cell(r.rule!,'Participants',subject)===1,'Facilitator and live participant required');check(!all.some(i=>i.type==='interview'&&i.parentId===r.id&&i.owner===input.personId),'Cannot replace a materialised interview');const item=get(input.itemId);check(item.type==='library'&&item.visibility==='members'&&item.refs.some(ref=>ref.context.revision===input.version),'Readable source version required');const assignment={itemId:item.id,version:Number(input.version)};await save(e.storage,key('assignment',r.id,String(input.personId)),assignment);return {assigned:true,source:assignment};}
  if(tool==='interview_read'){const round=get(input.roundId),owner=String(input.personId??personId(e)),slot=e.state.identities.findIndex(i=>i.id===owner)+1,own=owner===personId(e);check(own||cell(round.rule!,'Shared',slot)===1,'Interview is private');const r=(await records(e,index)).find(r=>r?.type==='interview'&&r.parentId===round.id&&r.owner===owner);if(!r)return {roundId:round.id,personId:owner,source:own?await load(e.storage,key('assignment',round.id,owner)):undefined,content:[]};return {...view(r),content:r.refs.filter(ref=>own?ref.context.groupId!==e.state.id:ref.context.groupId===e.state.id)};}
  if(tool==='sealed_catalog'){const cursor=Number(input.cursor),visible=all.filter(r=>r.type!=='interview');for(const r of (await records(e,index)).filter((r):r is RecordState=>!!r&&!r.deleted&&r.type==='interview')){const round=await record(e,r.parentId),owner=e.state.identities.findIndex(i=>i.id===r.owner)+1;if(cell(round.rule!,'Shared',owner)===1)visible.push({...r,refs:r.refs.filter(ref=>ref.context.groupId===e.state.id)});}return page(visible,cursor);}
  if(tool==='task_read'){const t=e.state.tasks.find(t=>t.id===input.taskId);check(t&&t.sealed&&taskActor(e,t),'Task access refused');return {taskId:t!.id,definition:t!.sealed!.definition,status:scalar(t!.rule,'status'),records:all.filter(r=>r.taskId===t!.id).map(view)};}
  if(tool==='sealed_record_read'){const r=get(input.recordId);check(r.refs.some(ref=>ref.context.revision===input.revision),'Unknown sealed revision');return {...view(r),content:r.refs.filter(ref=>ref.context.revision===input.revision)};}
  if(tool==='library_get'){const r=get(input.itemId);return {...view(r),content:r.refs.filter(ref=>ref.context.revision===(input.version??r.revision))};}
  if(tool==='round_read'){const r=get(input.roundId),p=page(all.filter(c=>c.type==='contribution'&&c.parentId===r.id),Number(input.cursor));return {...view(r),contributions:p.records,cursor:p.cursor,more:p.more};}
  if(tool==='topic_read'||tool==='conversation_read'){const r=tool==='topic_read'?get(input.topicId):all.find(r=>r.type==='topic'&&JSON.stringify(r.target)===JSON.stringify(input.target));if(!r)return {topic:null};const p=page(all.filter(post=>post.type==='post'&&post.parentId===r.id),Number(input.cursor));return {...view(r),posts:p.records,cursor:p.cursor,more:p.more};}
  const type=tool==='forum_boards'?'board':tool==='topic_list'?'topic':tool==='round_list'?'round':'library';const cursor=Number(input.cursor??0);const matches=all.filter(r=>r.type===type&&(!input.boardId||r.parentId===input.boardId)&&(!input.projectId||r.projectId===input.projectId)&&(!input.attachedTo||JSON.stringify(r.target)===JSON.stringify(input.attachedTo)));return {journeyId:e.state.id,...page(matches,cursor)};
}
