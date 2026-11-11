import * as z from 'zod';
import { offerDefinitionSchema, presetPolicy, validateData, boundedJson } from '../../mcp/src/offers.ts';
import { privateProfile, publicProfile, cardDescriptor, sealedDescriptor, definitionRef } from '../../mcp/src/sealed-descriptors.ts';
import type { Client } from '@modelcontextprotocol/client';
const localInputs={...inputs,offer_set:inputs.offer_set.extend({offer:offerDefinitionSchema.omit({sealed:true}).extend({id:sealedOfferId.optional()})}),account_update:privateProfile.partial().extend({publications:z.record(id,publicProfile).optional()}).strict(),agent_descriptor_set:cardDescriptor.extend({agentId:id,publications:z.record(id,cardDescriptor).optional()}).strict(),task_create:inputs.task_create.safeExtend({taskId:id.optional()}),library_get:inputs.library_get.safeExtend({version:z.number().int().min(1).optional()}),library_add:inputs.library_add.safeExtend({text:z.string().max(9*1024*1024).optional()}),library_version:inputs.library_version.safeExtend({text:z.string().max(9*1024*1024)})};
import { inputs } from '../../mcp/src/commands.ts';
import {detectKind} from '../../mcp/src/library.ts';
import { sealedRouting, sealedInputs, sealedOfferId, sealedAction, sealedEnvelope, preparedContent, contentContext, bindingSchema, SEALED_FORMAT, SEALED_LIMITS, requireSynthetic, type ContentContext, type DeviceBinding, type SealedEnvelope } from '../../mcp/src/sealed-contract.ts';
import { createMlsGroup, type MlsGroup } from './mls/index.ts';
import { encode, decode, json, text, utf8, id, base64, nat } from './codec.ts';
import type { LocalStore } from './store.ts';
import { contentKey, encrypt, decrypt } from './crypto.ts';

const payloadSchema=z.object({profile:z.union([privateProfile,publicProfile]).optional(),descriptor:cardDescriptor.optional(),definition:offerDefinitionSchema.optional(),input:z.unknown().optional(),output:z.unknown().optional(),reason:z.string().max(1000).optional(),inputRequests:z.record(z.string(),z.unknown()).optional(),answers:z.record(z.string(),z.unknown()).optional(),name:z.string().max(4096).optional(),title:z.string().max(4096).optional(),purpose:z.string().max(4096).optional(),description:z.string().max(4096).optional(),body:z.string().max(9*1024*1024).optional(),text:z.string().max(9*1024*1024).optional(),kind:id.optional(),mimeType:id.optional(),labels:z.array(id).max(64).optional(),url:z.string().max(4096).optional(),summary:z.string().max(4096).optional(),goal:z.string().max(4096).optional(),format:z.string().max(4096).optional(),type:id.optional(),content:z.string().max(9*1024*1024).optional(),blob:z.object({blob:id,key:base64,hash:id,size:nat,groupId:id,recordId:id,revision:nat}).strict().optional()}).strict();
type Payload=z.infer<typeof payloadSchema>;
const signedSchema=z.object({context:contentContext,deviceId:id,payload:payloadSchema,origin:z.string().max(SEALED_LIMITS.envelope).optional(),signature:base64}).strict();
type Signed=z.infer<typeof signedSchema>;
const savedGroup=z.object({mls:base64,deviceId:id,secret:base64,cursor:nat,own:z.array(nat),roster:z.array(bindingSchema),blocked:z.boolean(),cache:z.record(z.string(),signedSchema)}).strict();
type Saved=z.infer<typeof savedGroup>;
type Group={saved:Saved,mls:MlsGroup};
const pendingSchema=z.object({journeyId:id,action:sealedAction,ticketId:id,devices:z.record(z.string(),id),envelopes:z.record(z.string(),sealedEnvelope),packets:z.array(signedSchema)}).strict();
type Pending=z.infer<typeof pendingSchema>;
const stateSchema=z.object({version:z.literal(1),actorId:id,personalJourney:id.optional(),pending:pendingSchema.optional(),groups:z.record(z.string(),savedGroup)}).strict();
const groupView=z.object({groupId:id,epoch:nat,sequence:nat,devices:z.array(bindingSchema),remove:z.array(id)});
const messageSchema=z.object({sequence:nat,epoch:nat,kind:z.enum(['bootstrap','add','remove','update','application','history']),deviceId:id,data:base64,context:contentContext.optional(),target:bindingSchema.optional()});
const handshake=z.object({commit:base64,welcome:base64.optional()}).strict();
const packetKey=(c:ContentContext)=>JSON.stringify(c);
function parseJSON<T extends z.ZodType>(schema:T,raw:string):z.output<T>{let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error('Invalid sealed JSON');}return schema.parse(value);}
function journeyFor(value:string):string {const match=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(value);if(!match)throw new Error('Journey id required');return `journey_${match[0]}`;}
function unsigned(p:Signed){return {context:p.context,deviceId:p.deviceId,payload:p.payload,...(p.origin===undefined?{}:{origin:p.origin})};}

/** Synthetic-only sealed content generation. Never restores a ratchet after a network attempt. */
export class SealedClient {
 readonly actorId:string;
 private groups=new Map<string,Group>();
 private pending?:Pending;
 private personalJourney?:string;private personalAlias='';
 private failed=false;
 private remote:Client;private store:LocalStore;readonly personId:string;
 private constructor(remote:Client,store:LocalStore,personId:string,actorId:string){this.remote=remote;this.store=store;this.personId=personId;this.actorId=actorId;}
 static async open(remote:Client,store:LocalStore,personId:string):Promise<SealedClient>{
  requireSynthetic('synthetic');const who=await SealedClient.remoteCall(remote,'whoami',{});const agent=z.object({id}).nullable().optional().parse(who.agent);const c=new SealedClient(remote,store,personId,agent?.id??personId);
  c.personalAlias=id.parse((await c.callRemote('account_read',{})).personalGroupId);
  const raw=await store.read('sealed-state');if(raw){const state=parseJSON(stateSchema,raw);if(state.actorId!==c.actorId)throw new Error('Sealed store belongs to another actor');c.pending=state.pending;c.personalJourney=state.personalJourney;for(const [key,saved] of Object.entries(state.groups)){const mls=await createMlsGroup(utf8.encode(saved.deviceId));await mls.importState(decode(saved.mls));c.groups.set(key,{saved,mls});}}
  await c.recover();return c;
 }
 private static async remoteCall(remote:Client,name:string,args:Record<string,unknown>):Promise<Record<string,unknown>> {const r=await remote.callTool({name,arguments:args});if(r.isError)throw new Error(r.content?.map(c=>c.type==='text'?c.text:'').join('\n')??'Sealed operation refused');return z.record(z.string(),z.unknown()).parse(r.structuredContent);}
 private callRemote(name:string,args:Record<string,unknown>){if(this.failed)throw new Error('Local persistence failed; reopen latest store');return SealedClient.remoteCall(this.remote,name,args);}
 private async persist(){try{const groups:Record<string,Saved>={};for(const [id,g] of this.groups){g.saved.mls=encode(await g.mls.exportState());groups[id]=g.saved;}await this.store.write('sealed-state',JSON.stringify({version:1,actorId:this.actorId,personalJourney:this.personalJourney,pending:this.pending,groups}));}catch(error){this.failed=true;throw error;}}
 private group(id:string){const g=this.groups.get(id);if(!g)throw new Error('Prepare or create the sealed audience first');if(g.saved.blocked)throw new Error('Ambiguous MLS delivery; refusing ratchet rollback or retry');return g;}
 private async prepare(groupId:string){if(this.groups.has(groupId))throw new Error('Audience already prepared');const deviceId=`device_${crypto.randomUUID()}`;const keys=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);if(!('privateKey' in keys))throw new Error('Asymmetric signing key required');const mls=await createMlsGroup(utf8.encode(deviceId));const g:Group={mls,saved:{mls:'',deviceId,secret:encode(new Uint8Array(await crypto.subtle.exportKey('pkcs8',keys.privateKey))),cursor:0,own:[],roster:[],blocked:false,cache:{}}};this.groups.set(groupId,g);await this.persist();await this.callRemote('sealed_device_register',{deviceId,verificationKey:encode(new Uint8Array(await crypto.subtle.exportKey('raw',keys.publicKey))),data:encode(mls.keyPackage())});return g;}
 async artifactJourney(groupId:string):Promise<string>{
  if(!groupId.startsWith('personal_'))return groupId;
  if(groupId!==this.personalAlias)throw new Error('Only the personal group owner may access this audience');
  if(!this.personalJourney){const created=await this.call('journey_create',{name:'Personal workspace',policy:'invite',defaultRole:'read'});this.personalJourney=id.parse(created.journeyId);await this.persist();}
  return this.personalJourney;
 }
 private async openDefinition(ref:z.infer<typeof definitionRef>){const raw=await this.callRemote('sealed_record_read',ref);await this.sync(ref.journeyId);return offerDefinitionSchema.parse((await this.render(raw)).definition);}
 private async audienceId(groupId:string){if(!groupId.startsWith('personal_'))return groupId;const journey=await this.artifactJourney(groupId);return `private_${journey.slice(8)}_${this.personId}`;}
 async createGroup(groupId:string):Promise<void>{if(groupId.startsWith('personal_')){const journey=await this.artifactJourney(groupId);await this.callRemote('content_prepare',{journeyId:journey,action:'library_add',routing:{visibility:'private'}});return this.createGroup(`private_${journey.slice(8)}_${this.personId}`);}const journeyId=journeyFor(groupId),v=groupView.parse(await this.callRemote('sealed_group',{journeyId,groupId}));if(v.sequence)throw new Error('Audience exists; prepare and request admission');const g=await this.prepare(groupId);await g.mls.create(utf8.encode(groupId));g.saved.roster=[bindingSchema.parse(await this.callRemote('sealed_device_binding',{deviceId:g.saved.deviceId}))];await this.commit(groupId,g,v,'bootstrap',json({}));}
 async prepareGroup(groupId:string){groupId=await this.audienceId(groupId);await this.callRemote('sealed_group',{journeyId:journeyFor(groupId),groupId});const g=await this.prepare(groupId);return {deviceId:g.saved.deviceId};}
 private async commit(groupId:string,g:Group,v:z.infer<typeof groupView>,action:'bootstrap'|'add'|'remove'|'update',data:Uint8Array,targetDeviceId?:string){g.saved.blocked=true;await this.persist();const r=await this.callRemote('sealed_group_commit',{journeyId:journeyFor(groupId),groupId,deviceId:g.saved.deviceId,expectedSequence:v.sequence,expectedEpoch:v.epoch,action,data:encode(data),...(targetDeviceId?{targetDeviceId}:{})});g.saved.own.push(nat.parse(r.sequence));g.saved.blocked=false;await this.persist();}
 private assertRoster(g:Group){if(!g.mls.matchesRoster(g.saved.roster.map(d=>decode(d.data))))throw new Error('MLS roster differs from authenticated device bindings');}
 async addMember(groupId:string,personId:string,deviceId:string){groupId=await this.audienceId(groupId);await this.sync(groupId);const g=this.group(groupId),v=groupView.parse(await this.callRemote('sealed_group',{journeyId:journeyFor(groupId),groupId}));const target=bindingSchema.parse(await this.callRemote('sealed_package_reserve',{journeyId:journeyFor(groupId),groupId,deviceId}));if(target.personId!==personId)throw new Error('Authenticated target owner mismatch');const c=await g.mls.add(decode(target.data));g.saved.roster.push(target);this.assertRoster(g);await this.commit(groupId,g,v,'add',json({commit:encode(c.commit),welcome:c.welcome?encode(c.welcome):undefined}),deviceId);await this.sync(groupId);await this.shareHistory(groupId);}
 async removeMember(groupId:string,personId:string){groupId=await this.audienceId(groupId);await this.sync(groupId);const g=this.group(groupId);for(const d of [...g.saved.roster].filter(d=>d.personId===personId))await this.remove(groupId,g,d);}
 private async remove(groupId:string,g:Group,d:DeviceBinding){const v=groupView.parse(await this.callRemote('sealed_group',{journeyId:journeyFor(groupId),groupId}));const c=await g.mls.remove(decode(d.data));g.saved.roster=g.saved.roster.filter(b=>b.deviceId!==d.deviceId);this.assertRoster(g);await this.commit(groupId,g,v,'remove',json({commit:encode(c.commit)}),d.deviceId);}
 private async verify(p:Signed,depth=0):Promise<void>{if(depth>1)throw new Error('Nested sealed origins refused');const b=bindingSchema.parse(await this.callRemote('sealed_device_binding',{deviceId:p.deviceId}));const key=await crypto.subtle.importKey('raw',decode(b.verificationKey),'Ed25519',false,['verify']);if(!await crypto.subtle.verify('Ed25519',key,decode(p.signature),json(unsigned(p))))throw new Error('Sealed signature mismatch');if(p.context.authorId!==(b.agentId??b.personId))throw new Error('Sealed author binding mismatch');if(p.origin){const origin=parseJSON(signedSchema,p.origin);await this.verify(origin,depth+1);if(origin.context.recordId!==p.context.recordId||origin.context.recordType!==p.context.recordType||origin.context.parentId!==p.context.parentId||origin.context.revision!==p.context.revision||JSON.stringify(origin.payload)!==JSON.stringify(p.payload))throw new Error('Sealed rewrap origin mismatch');}}
 private async accept(g:Group,value:unknown,expected?:ContentContext){const p=signedSchema.parse(value);if(expected&&packetKey(p.context)!==packetKey(expected))throw new Error('Sealed context mismatch');await this.verify(p);g.saved.cache[packetKey(p.context)]=p;}
 async sync(groupId:string):Promise<void>{if(groupId.startsWith('personal_')){const journey=await this.artifactJourney(groupId);return this.sync(`private_${journey.slice(8)}_${this.personId}`);}const g=this.group(groupId),journeyId=journeyFor(groupId);let v=groupView.parse(await this.callRemote('sealed_group',{journeyId,groupId}));if(!v.devices.some(d=>d.deviceId===g.saved.deviceId))throw new Error('Await authenticated device admission');
  for(;;){const page=await this.callRemote('sealed_group_fetch',{journeyId,groupId,deviceId:g.saved.deviceId,since:g.saved.cursor,limit:100});const messages=z.array(messageSchema).parse(page.messages);if(!messages.length)break;
   for(const m of messages){if(m.sequence!==g.saved.cursor+1)throw new Error('MLS sequence gap');g.saved.blocked=true;await this.persist();if(!g.saved.own.includes(m.sequence)){
    if(m.kind==='bootstrap'){if(m.target)g.saved.roster=[m.target];}
    else if(m.kind==='add'||m.kind==='remove'||m.kind==='update'){const h=parseJSON(handshake,text.decode(decode(m.data)));const target=m.target;if(m.kind==='add'&&!target)throw new Error('Missing authenticated admission');if(g.mls.epoch===null){if(target?.deviceId===g.saved.deviceId){if(!h.welcome)throw new Error('Missing welcome');await g.mls.processHandshake(decode(h.welcome));}}else await g.mls.processHandshake(decode(h.commit));if(m.kind==='add'&&target)g.saved.roster.push(target);else if(m.kind==='remove'&&target)g.saved.roster=g.saved.roster.filter(d=>d.deviceId!==target.deviceId);if(g.mls.epoch!==null)this.assertRoster(g);}
    else if(g.mls.epoch!==null){const raw=text.decode(await g.mls.open(decode(m.data)));if(m.kind==='application'){if(!m.context)throw new Error('Missing sealed context');await this.accept(g,parseJSON(signedSchema,raw),m.context);}else {const h=parseJSON(z.object({history:z.array(signedSchema).max(100)}).strict(),raw);for(const p of h.history){if(p.context.groupId!==groupId)throw new Error('Cross-audience history refused');await this.accept(g,p);}}}
   }g.saved.cursor=m.sequence;g.saved.blocked=false;g.saved.own=g.saved.own.filter(s=>s>m.sequence);await this.persist();}
  }
  v=groupView.parse(await this.callRemote('sealed_group',{journeyId,groupId}));if(g.mls.epoch!==v.epoch)throw new Error('MLS epoch mismatch');this.assertRoster(g);if(JSON.stringify([...g.saved.roster.map(d=>d.deviceId)].sort())!==JSON.stringify(v.devices.map(d=>d.deviceId).sort()))throw new Error('Server roster mismatch');for(const id of v.remove){const d=g.saved.roster.find(d=>d.deviceId===id);if(d)await this.remove(groupId,g,d);}await this.persist();
 }
 private async catalog(journeyId:string){const result:Record<string,unknown>[]=[];let cursor=0;for(;;){const page=await this.callRemote('sealed_catalog',{journeyId,cursor});result.push(...z.array(z.record(z.string(),z.unknown())).parse(page.records));if(!page.more)break;cursor=nat.parse(page.cursor);}return result;}
 private async shareHistory(groupId:string){
  const g=this.group(groupId),records=await this.catalog(journeyFor(groupId));
  if(groupId.startsWith('interview_'))records.push(await this.callRemote('interview_read',{journeyId:journeyFor(groupId),roundId:groupId.slice(10,groupId.lastIndexOf('_person_')),personId:this.personId}));
  const live=new Set(records.flatMap(r=>z.array(z.object({context:contentContext})).parse(r.content??[]).filter(ref=>ref.context.groupId===groupId).map(ref=>packetKey(ref.context))));
  const history=Object.entries(g.saved.cache).filter(([k])=>live.has(k)).map(([,p])=>p);
  if(history.length!==live.size)throw new Error('Retained history incomplete; synchronize with an existing live device before sharing history');
  while(history.length){const page:Signed[]=[];let size=1024;while(history.length&&page.length<100){const next=history[0]!,bytes=json(next).length+1;if(size+bytes>SEALED_LIMITS.envelope-4096)break;page.push(history.shift()!);size+=bytes;}if(!page.length)throw new Error('History entry exceeds envelope budget');
   const bytes=await g.mls.seal(json({history:page}));g.saved.blocked=true;await this.persist();const r=await this.callRemote('sealed_history_post',{journeyId:journeyFor(groupId),groupId,deviceId:g.saved.deviceId,contexts:page.map(p=>p.context),envelope:this.envelope(groupId,g,bytes)});g.saved.own.push(nat.parse(r.sequence));g.saved.blocked=false;await this.persist();
  }
 }
 private envelope(groupId:string,g:Group,bytes:Uint8Array):SealedEnvelope {if(bytes.length>SEALED_LIMITS.envelope)throw new Error('Sealed envelope too large');return {groupId,epoch:g.mls.epoch!,ciphertext:encode(bytes),contentType:SEALED_FORMAT,size:bytes.length};}
 private async sign(g:Group,context:ContentContext,payload:Payload,origin?:Signed):Promise<Signed>{const body={context,deviceId:g.saved.deviceId,payload:payloadSchema.parse(payload),...(origin?{origin:origin.origin??JSON.stringify(origin)}:{})};const key=await crypto.subtle.importKey('pkcs8',decode(g.saved.secret),'Ed25519',false,['sign']);return {...body,signature:encode(new Uint8Array(await crypto.subtle.sign('Ed25519',key,json(body))))};}
 private cached(context:ContentContext):Signed {const g=this.group(context.groupId),p=g.saved.cache[packetKey(context)];if(!p)throw new Error('Retained sealed content unavailable; synchronize with a live device');return p;}
 private latest(recordId:string):Signed|undefined {let result:Signed|undefined;for(const g of this.groups.values())for(const p of Object.values(g.saved.cache))if(p.context.recordId===recordId&&(!result||p.context.revision>result.context.revision))result=p;return result;}
 private async pack(journeyId:string,ticketId:string,slot:string,context:ContentContext,payload:Payload):Promise<Payload>{
  const plaintext=json(payload);if(plaintext.length<=65536)return payload;
  const key=contentKey(),data=await encrypt(plaintext,key,context.groupId,context.recordId,context.revision);
  const upload=z.object({blob:id,hash:id,size:nat}).parse(await this.callRemote('sealed_blob_put',{journeyId,ticketId,slot,data}));
  if(await this.hash(data)!==upload.hash||decode(data).length!==upload.size)throw new Error('Uploaded ciphertext receipt mismatch');
  return {blob:{...upload,key:encode(key),groupId:context.groupId,recordId:context.recordId,revision:context.revision}};
 }
 private async hash(data:string){return encode(new Uint8Array(await crypto.subtle.digest('SHA-256',utf8.encode(data)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
 private async unpack(p:Signed):Promise<Payload>{
  const b=p.payload.blob;if(!b)return p.payload;const source=p.origin?parseJSON(signedSchema,p.origin).context:p.context;
  if(b.groupId!==source.groupId||b.recordId!==p.context.recordId||b.revision!==p.context.revision)throw new Error('Blob authenticated context mismatch');
  const result=z.object({data:base64}).parse(await this.callRemote('sealed_blob_get',{journeyId:journeyFor(p.context.groupId),recordId:p.context.recordId,revision:p.context.revision,blob:b.blob}));
  if(decode(result.data).length!==b.size||await this.hash(result.data)!==b.hash)throw new Error('Blob ciphertext integrity mismatch');
  const payload=parseJSON(payloadSchema,text.decode(await decrypt(result.data,decode(b.key),b.groupId,b.recordId,b.revision)));if(payload.blob)throw new Error('Nested blob manifests refused');return payload;
 }
 private async write(action:string,journeyId:string,routing:Record<string,unknown>,data:Payload,defaults?:{guidance:Payload;document:Payload},attempt=0):Promise<Record<string,unknown>> {
  // Allocate audiences first, then prepare again after synchronization changes epochs.
  let prepared=preparedContent.parse(await this.callRemote('content_prepare',{journeyId,action,routing}));for(const groupId of new Set(prepared.slots.map(s=>s.context.groupId))){if(!this.groups.has(groupId)){const v=groupView.parse(await this.callRemote('sealed_group',{journeyId,groupId}));if(v.sequence)throw new Error(`Prepare and request admission to ${groupId}`);await this.createGroup(groupId);}await this.sync(groupId);}prepared=preparedContent.parse(await this.callRemote('content_prepare',{journeyId,action,routing}));
  const envelopes:Record<string,SealedEnvelope>={};const pending:Signed[]=[];
  for(const slot of prepared.slots){const g=this.group(slot.context.groupId);const old=this.latest(slot.context.recordId);let payload:Payload={...(old?await this.unpack(old):{}),...data};let origin:Signed|undefined;if(slot.source){origin=this.cached(slot.source);payload=origin.payload;}else if(slot.key==='guidance')payload=defaults?.guidance??{name:'Round guidance',kind:'skill',text:'Listen, reflect, and contribute your perspective.'};else if(slot.key==='document')payload=defaults?.document??{name:'Sensemaking document',kind:'markdown',text:''};else if(slot.key==='conversation')payload={title:'Round conversation'};else if(slot.key==='body')payload={body:data.body??''};else if(slot.key==='descriptor'){const {body:_body,text:_text,content:_content,...descriptor}=data;payload={...(old?await this.unpack(old):{}),...descriptor};}else if(slot.key==='private'||slot.key==='publication'){payload={text:data.text??(old?(await this.unpack(old)).text:undefined)??''};}
   if(!slot.source)payload=await this.pack(journeyId,prepared.ticketId,slot.key,slot.context,payload);const p=await this.sign(g,slot.context,payload,origin),bytes=await g.mls.seal(json(p));envelopes[slot.key]=this.envelope(slot.context.groupId,g,bytes);pending.push(p);
  }
  // All groups were advanced locally; ambiguity blocks them all, never rolls back.
  const devices:Record<string,string>={};for(const p of pending){const g=this.groups.get(p.context.groupId)!;devices[p.context.groupId]=g.saved.deviceId;g.saved.blocked=true;}
  this.pending={journeyId,action:sealedAction.parse(action),ticketId:prepared.ticketId,devices,envelopes,packets:pending};await this.persist();
  let result:Record<string,unknown>;
  try{result=await this.callRemote(action,{journeyId,ticketId:prepared.ticketId,devices,envelopes});}
  catch(error){
   if(attempt<2&&error instanceof Error&&/Content revision changed|Prepared epoch is stale|Sealed epoch mismatch/.test(error.message)){
    await this.callRemote('content_abandon',{journeyId,ticketId:prepared.ticketId});await this.recover();
    return this.write(action,journeyId,routing,data,defaults,attempt+1);
   }throw error;
  }
  await this.finishPending(result);return this.render(result);
 }
 private async finishPending(result:Record<string,unknown>){
  const pending=this.pending;if(!pending)throw new Error('Missing pending sealed write');
  for(const p of pending.packets){const g=this.groups.get(p.context.groupId)!;g.saved.cache[packetKey(p.context)]=p;g.saved.blocked=false;}
  for(const r of z.array(z.record(z.string(),z.unknown())).parse(result.records))for(const ref of z.array(z.object({context:contentContext,sequence:nat})).parse(r.content??[])){const g=this.groups.get(ref.context.groupId);if(g)g.saved.own.push(ref.sequence);}
  this.pending=undefined;await this.persist();
 }
 private async recover(){
  const p=this.pending;if(!p)return;
  const status=await this.callRemote('content_status',{journeyId:p.journeyId,ticketId:p.ticketId});
  if(status.state==='committed'){
   if(status.hash!==await this.hash(JSON.stringify(p.envelopes)))throw new Error('Committed sealed receipt hash mismatch');
   await this.finishPending(z.record(z.string(),z.unknown()).parse(status.result));
  }else if(Number(status.expiresAt)>Date.now()){
   const result=await this.callRemote(p.action,{journeyId:p.journeyId,ticketId:p.ticketId,devices:p.devices,envelopes:p.envelopes});await this.finishPending(result);
  }else{
   // The server proves no publication. Keep the advanced ratchets, never restore snapshots.
   for(const packet of p.packets){const g=this.groups.get(packet.context.groupId);if(g)g.saved.blocked=false;}
   this.pending=undefined;await this.persist();
  }
 }
 private async render(value:Record<string,unknown>):Promise<Record<string,unknown>> {
  const out:Record<string,unknown>={};for(const [k,v] of Object.entries(value)){
   if(k==='content'&&Array.isArray(v)){
    for(const ref of z.array(z.object({context:contentContext})).parse(v)){
     const g=this.groups.get(ref.context.groupId),p=g?.saved.cache[packetKey(ref.context)];
     if(p){if(packetKey(p.context)!==packetKey(ref.context))throw new Error('Cached sealed context mismatch');await this.verify(p);const {type,...payload}=await this.unpack(p);if(payload.profile){if(p.context.groupId.startsWith('private_'))privateProfile.parse(payload.profile);else publicProfile.parse(payload.profile);}Object.assign(out,payload);if(type!==undefined)out.mimeType=type;}else out.contentUnavailable=true;
    }out.sealed=true;
   }else if(Array.isArray(v))out[k]=await Promise.all(v.map(x=>x&&typeof x==='object'&&!Array.isArray(x)?this.render(z.record(z.string(),z.unknown()).parse(x)):x));else out[k]=v;
  }return out;
 }
 private async openDescriptor(value:unknown):Promise<Record<string,unknown>> {const who=await this.callRemote('whoami',{});if(who.agent){const caps=z.array(z.string()).parse(z.object({capabilities:z.unknown()}).parse(who.agent).capabilities);if(!caps.includes('read')||!caps.includes('device.keys'))return {contentUnavailable:true,notice:'Sealed content refused: needs read + device.keys; ask the owner to grant both explicitly'};}const d=sealedDescriptor.parse(value),raw=await this.callRemote('sealed_record_read',d.privateDefinition);for(const ref of z.array(z.object({context:contentContext})).parse(raw.content))if(this.groups.has(ref.context.groupId))await this.sync(ref.context.groupId);return this.render(raw);}
 private async hydrateJourney(value:Record<string,unknown>){
  if(typeof value.pending==='string')return {...value,name:'sealed — open in your client'};const journeyId=id.parse(value.journeyId),catalog=await this.catalog(journeyId);if(this.groups.has(journeyId))await this.sync(journeyId);
  const records=await Promise.all(catalog.map(r=>this.render(r))),descriptor=records.find(r=>r.type==='journey');
  const aliases:Record<string,string>={};for(const [target,ref] of Object.entries(z.record(id,definitionRef).parse(value.descriptors??{}))){const r=await this.render(await this.callRemote('sealed_record_read',ref));if(r.profile)aliases[target]=publicProfile.parse(r.profile).nickname;else if(r.descriptor)aliases[target]=cardDescriptor.parse(r.descriptor).name;}
  if(Array.isArray(value.members))value.members=z.array(z.record(z.string(),z.unknown())).parse(value.members).map(m=>({...m,name:aliases[String(m.memberId)]??m.name}));
  return {...value,name:descriptor?.name??'sealed — open in your client',projects:records.filter(r=>r.type==='project'),boards:records.filter(r=>r.type==='board'),artifacts:records.filter(r=>r.type==='library'),contentUnavailable:descriptor?.contentUnavailable??!descriptor};
 }
 async call(name:string,supplied:Record<string,unknown>={}):Promise<Record<string,unknown>> {
  if(name==='agent_create'){const input=inputs.agent_create.parse(supplied),created=await this.callRemote(name,{});await this.call('agent_descriptor_set',{agentId:id.parse(created.agentId),name:input.name});return {...created,name:input.name};}
  if(name==='account_read'){const value=await this.callRemote(name,inputs.account_read.parse(supplied));if(!value.descriptor)return value;const r=await this.openDescriptor(value.descriptor);return {...value,...(r.profile?privateProfile.parse(r.profile):{contentUnavailable:true,notice:r.notice??'Prepare and request admission to the private audience'})};}
  if(name==='agent_list'){const value=await this.callRemote(name,inputs.agent_list.parse(supplied));return {...value,agents:await Promise.all(z.array(z.record(z.string(),z.unknown())).parse(value.agents).map(async a=>{if(!a.descriptor)return a;const r=await this.openDescriptor(a.descriptor);return {...a,...(r.descriptor?cardDescriptor.parse(r.descriptor):{contentUnavailable:true,notice:r.notice??'Prepare and request admission to the private audience'})};}))};}
  if(name==='offer_list'){const value=await this.callRemote(name,inputs.offer_list.parse(supplied));return {...value,offers:await Promise.all(z.array(z.record(z.string(),z.unknown())).parse(value.offers).map(async o=>{if(!o.sealed)return o;const r=await this.openDescriptor(o.sealed);if(!r.definition)return {...o,contentUnavailable:true,notice:r.notice??'Prepare and request admission to the private audience'};const d=offerDefinitionSchema.parse(r.definition);if(d.id!==o.id)throw new Error('Private offer identity mismatch');return {...o,name:d.name,description:d.description,tags:d.tags,examples:d.examples,inputSchema:d.inputSchema,outputSchema:d.outputSchema,resource:d.resource,instructions:d.instructions};}))};}
  if(name==='account_update'||name==='agent_descriptor_set'){
   const card=name==='agent_descriptor_set',input=(card?localInputs.agent_descriptor_set:localInputs.account_update).parse(supplied),fields=z.record(z.string(),z.unknown()).parse(input);const agentId=card?id.parse(fields.agentId):undefined,meta=card?z.array(z.record(z.string(),z.unknown())).parse((await this.callRemote('agent_list',{})).agents).find(a=>a.agentId===agentId):await this.callRemote('account_read',{});if(!meta)throw new Error('Owned live descriptor required');const revision=meta.descriptor?sealedDescriptor.parse(meta.descriptor).contentRevision+1:1;
   let data:Payload;if(card)data={descriptor:cardDescriptor.parse({name:fields.name,clientName:fields.clientName})};else{const previous=meta.descriptor?(await this.openDescriptor(meta.descriptor)).profile:undefined,patch:Record<string,unknown>={};for(const key of Object.keys(privateProfile.shape))if(fields[key]!==undefined)patch[key]=fields[key];data={profile:privateProfile.parse({name:this.personId,...(previous?privateProfile.parse(previous):{}),...patch})};}
   const personal=await this.artifactJourney(this.personalAlias),publications:Record<string,z.infer<typeof definitionRef>>={};const write=async(journeyId:string,privateSource:boolean,payload:Payload)=>{const result=await this.write('identity_descriptor',journeyId,{kind:card?'card':'profile',agentId,contentRevision:revision,private:privateSource},payload),record=z.array(z.object({recordId:id,revision:nat})).parse(result.records)[0]!;return {journeyId,recordId:record.recordId,revision:record.revision};};const privateDefinition=await write(personal,true,data);for(const [journeyId,value] of Object.entries(z.record(id,z.unknown()).parse(fields.publications??{})))publications[journeyId]=await write(journeyId,false,card?{descriptor:cardDescriptor.parse(value)}:{profile:publicProfile.parse(value)});return this.callRemote(name,{...(agentId?{agentId}:{}),sealed:{privateDefinition,publications,contentRevision:revision}});
  }
  if(name==='task_prepare'){const r=await this.callRemote(name,sealedInputs.task_prepare!.parse(supplied));await this.createGroup(id.parse(r.groupId));return r;}
  if(name==='task_claim_prepare')return this.callRemote(name,sealedInputs.task_claim_prepare!.parse(supplied));
  if(name==='task_create'){
   const input=localInputs.task_create.parse(supplied);let taskId=input.taskId;
   if(!taskId){const p=await this.call('task_prepare',{journeyId:input.journeyId,assignee:input.assignee,agentId:input.agentId,offerId:input.offerId});taskId=id.parse(p.taskId);if(input.assignee||input.agentId)return {...p,admission:'pending',notice:'Required devices must prepare and be added to this task group; then retry task_create with taskId.'};}
   let snapshot:z.infer<typeof offerDefinitionSchema>|undefined;const groupId=`taskgroup_${taskId}`;await this.sync(groupId);
   const p=await this.callRemote('sealed_group',{journeyId:input.journeyId,groupId});if(p.definition){const ref=definitionRef.parse(p.definition);const definition=await this.openDefinition(ref);validateData(input.input,definition.inputSchema,'Input');snapshot=definition;}
   return this.write('task_create',input.journeyId,{taskId,maxRounds:input.maxRounds,deadline:input.deadline},payloadSchema.parse({name:input.name,input:input.input,definition:snapshot}));
  }
  if(name==='task_read'){
   const r=await this.callRemote(name,sealedInputs.task_read!.parse(supplied));await this.sync(`taskgroup_${id.parse(r.taskId)}`);const rendered=await this.render(r);
   const definition=r.definition?await this.openDefinition(definitionRef.parse(r.definition)):undefined;for(const record of z.array(z.record(z.string(),z.unknown())).parse(rendered.records)){if(record.type==='task'&&definition){if(JSON.stringify(record.definition)!==JSON.stringify(definition))throw new Error('Task contract does not match the authenticated publication');validateData(record.input,definition.inputSchema,'Input');}if(record.output!==undefined){boundedJson(record.output,'Output');if(definition?.outputSchema)validateData(record.output,definition.outputSchema,'Output');}}
   return rendered;
  }
  if(name==='task_step'){
   const input=inputs.task_step.parse(supplied);if(input.output!==undefined)boundedJson(input.output,'Output');if(['claim','startRound','endRound','finish','askInput','answer'].includes(input.action)){const task=await this.call('task_read',{journeyId:input.journeyId,taskId:input.taskId});if(input.action==='finish'&&task.definition){const definition=await this.openDefinition(definitionRef.parse(task.definition));if(definition.outputSchema)validateData(input.output,definition.outputSchema,'Output');}}
   return this.write('task_exchange',input.journeyId,{taskId:input.taskId,action:input.action,standing:input.standing},payloadSchema.parse({output:input.output,reason:input.reason,inputRequests:input.inputRequests,answers:input.answers}));
  }
  if(name==='offer_set'){
   const input=localInputs.offer_set.parse(supplied),s=input.offer,source=offerDefinitionSchema.parse({id:s.id??`offer-${crypto.randomUUID()}`,name:s.name,description:s.description,tags:s.tags,examples:s.examples,inputSchema:s.inputSchema,outputSchema:s.outputSchema,journeySettings:s.journeySettings,admission:s.admission,preset:s.preset,resource:s.resource,instructions:s.instructions}),existing=await this.callRemote('offer_list',{agentId:input.agentId});const previous=z.array(z.object({id,contentRevision:nat})).parse(existing.offers).find(o=>o.id===source.id),contentRevision=(previous?.contentRevision??0)+1;
   const personal=await this.artifactJourney(this.personalAlias),pubs:Record<string,z.infer<typeof definitionRef>>={};
   const store=async(journeyId:string,privateSource:boolean)=>{const result=await this.write('offer_definition',journeyId,{agentId:input.agentId,offerId:source.id,contentRevision,private:privateSource},{definition:source});const r=z.array(z.object({recordId:id,revision:nat})).parse(result.records)[0]!;return {journeyId,recordId:r.recordId,revision:r.revision};};
   const privateDefinition=await store(personal,true);for(const [journeyId,row] of Object.entries(source.journeySettings??{}))if(row.enabled)pubs[journeyId]=await store(journeyId,false);
   return this.callRemote('offer_set',{agentId:input.agentId,expectedVersion:input.expectedVersion,offer:{id:source.id,sealed:{privateDefinition,publications:pubs,contentRevision},journeySettings:source.journeySettings??{},admission:source.admission??presetPolicy(source.preset)}});
  }
  if(name==='offer_search'){
   const input=inputs.offer_search.parse(supplied),remote=await this.callRemote(name,{journeyId:input.journeyId}),offers:Record<string,unknown>[]=[];let partialIndex=false;
   for(const meta of z.array(z.record(z.string(),z.unknown())).parse(remote.offers)){if(!meta.publication)continue;const ref=definitionRef.parse(meta.publication);const record=await this.callRemote('sealed_record_read',ref);if(this.groups.has(ref.journeyId))await this.sync(ref.journeyId);const rendered=await this.render(record);if(!rendered.definition){partialIndex=true;offers.push(meta);continue;}const definition=offerDefinitionSchema.parse(rendered.definition);if((input.tags??[]).every(t=>definition.tags.includes(t))&&(!input.query||JSON.stringify(definition).toLowerCase().includes(input.query.toLowerCase())))offers.push({...meta,...definition});}return {offers,localSearch:true,partialIndex};
  }
  if(name==='journey_read')return this.hydrateJourney(await this.callRemote(name,inputs.journey_read.parse(supplied)));
  if(name==='journey_list'){const list=await this.callRemote(name,inputs.journey_list.parse(supplied));return {journeys:await Promise.all(z.array(z.record(z.string(),z.unknown())).parse(list.journeys).map(j=>this.hydrateJourney(j)))};}
  if(name==='journey_create'){const input=inputs.journey_create.parse(supplied);const result=await this.callRemote(name,{policy:input.policy,defaultRole:input.defaultRole}),journeyId=id.parse(result.journeyId);await this.createGroup(journeyId);await this.write('journey_descriptor',journeyId,{}, {name:input.name});await this.write('board_create',journeyId,{}, {name:'General',description:''});return {...result,name:input.name};}
  const schema=localInputs[name as keyof typeof localInputs];if(!schema)throw new Error('Unknown local content tool');const parsed=z.record(z.string(),z.unknown()).parse(schema.parse(supplied));if(!Object.hasOwn(sealedRouting,name)&&!Object.hasOwn(sealedInputs,name))return this.callRemote(name,parsed);const journeyId=typeof parsed.journeyId==='string'?parsed.journeyId:journeyFor(String(parsed.boardId??parsed.topicId??parsed.postId??parsed.itemId??parsed.roundId??parsed.projectId));
  if(name==='interview_share'){const own=await this.call('interview_read',{roundId:parsed.roundId});if(!own.sealed)await this.write('interview_write',journeyId,{roundId:parsed.roundId},{text:''});}
  if(name==='round_next'){
   const previous=await this.call('round_read',{roundId:parsed.roundId}),guide=await this.call('library_get',{itemId:previous.guidanceItemId});
   const synthesis=z.record(z.string(),z.unknown()).parse(previous.synthesis);
   return this.write(name,journeyId,{roundId:parsed.roundId},payloadSchema.parse({title:parsed.title,goal:parsed.goal,format:parsed.format}),{guidance:payloadSchema.parse({name:'Round guidance',kind:'skill',text:guide.text??''}),document:payloadSchema.parse({name:'Sensemaking document',kind:'markdown',text:synthesis.text??''})});
  }
  if(Object.hasOwn(sealedRouting,name)){const action=name as keyof typeof sealedRouting;const routing:Record<string,unknown>={};for(const field of Object.keys(sealedRouting[action].shape))if(parsed[field]!==undefined)routing[field]=parsed[field];const data:Record<string,unknown>={};for(const field of Object.keys(payloadSchema.shape))if(parsed[field]!==undefined)data[field]=parsed[field];if(name==='library_add'&&data.kind===undefined)data.kind=detectKind(String(data.name??''),String(data.mimeType??''));return this.write(name,journeyId,routing,payloadSchema.parse(data));}
  if(name==='library_search'){
   const records=await this.catalog(journeyId),needed=new Set(records.flatMap(r=>z.array(z.object({context:contentContext})).parse(r.content??[]).map(ref=>ref.context.groupId))),missingGroups:string[]=[];
   for(const groupId of needed){if(this.groups.has(groupId))await this.sync(groupId);else missingGroups.push(groupId);}
   const rendered=await Promise.all(records.filter(r=>r.type==='library').map(r=>this.render(r))),tokens=String(parsed.query??'').toLowerCase().split(/\s+/).filter(Boolean);
   const items=rendered.filter(r=>(!parsed.projectId?parsed.includeProjects||!r.projectId:r.projectId===parsed.projectId)&&(!parsed.kind||r.kind===parsed.kind)&&(!parsed.label||Array.isArray(r.labels)&&r.labels.includes(parsed.label))&&tokens.every(t=>JSON.stringify(r).toLowerCase().includes(t)));
   return {journeyId,items,localSearch:true,partialIndex:missingGroups.length>0||rendered.some(r=>r.contentUnavailable),missingGroups};
  }
  if(Object.hasOwn(sealedInputs,name)){
   const wire:Record<string,unknown>={journeyId};for(const field of Object.keys(sealedInputs[name]!.shape))if(parsed[field]!==undefined)wire[field]=parsed[field];
   if(name==='interview_assign'&&wire.version===undefined){const item=await this.callRemote('library_get',{journeyId,itemId:parsed.itemId});wire.version=item.revision;}
   const result=await this.callRemote(name,wire),syncGroups=new Set<string>();const walk=(value:unknown)=>{if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(walk);return;}const obj=value as Record<string,unknown>;if(obj.context){const c=contentContext.parse(obj.context);syncGroups.add(c.groupId);}Object.values(obj).forEach(walk);};walk(result);for(const groupId of syncGroups)if(this.groups.has(groupId))await this.sync(groupId);
   if(name==='round_read'&&result.more){const contributions=z.array(z.unknown()).parse(result.contributions);let cursor=nat.parse(result.cursor);for(;;){const next=await this.callRemote(name,{...wire,cursor});contributions.push(...z.array(z.unknown()).parse(next.contributions));cursor=nat.parse(next.cursor);if(!next.more)break;}result.contributions=contributions;result.more=false;result.cursor=cursor;}
   const rendered=await this.render(result);
   if(name==='interview_read'&&(!parsed.personId||parsed.personId===this.personId)&&!z.array(z.unknown()).parse(result.content).length&&result.source){const source=z.object({itemId:id,version:nat}).parse(result.source),item=await this.call('library_get',source);await this.write('interview_write',journeyId,{roundId:parsed.roundId},{text:String(item.text??item.summary??'')});return this.call(name,supplied);}
   if(name==='round_read'){
    const document=await this.call('library_get',{itemId:result.documentItemId}),contributions=z.array(z.record(z.string(),z.unknown())).parse(rendered.contributions);
    rendered.synthesis={...document,text:String(document.text??'')+contributions.map(c=>`\n\n## ${String(c.owner)}\n\n${String(c.text??'')}`).join('')};
   }
   return rendered;
  }
  return this.callRemote(name,parsed);
 }
 async tools(){const tools=(await this.remote.listTools()).tools;return tools.filter(t=>!t.name.startsWith('artifact_')&&!t.name.startsWith('mls_')&&!t.name.startsWith('sealed_')&&!t.name.startsWith('content_')).map(t=>{const schema=localInputs[t.name as keyof typeof localInputs];return schema?{...t,inputSchema:z.toJSONSchema(schema,{io:'input'})}:t;});}
 async exportGroup(groupId:string){return encode(await this.group(await this.audienceId(groupId)).mls.exportState());}
}
