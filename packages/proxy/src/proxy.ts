import type {Client} from '@modelcontextprotocol/client';
import * as z from 'zod';
import {createMlsGroup,type MlsGroup,type MlsCommit} from './mls/index.ts';
import {id,nat,base64,decode,encode,json,text,utf8} from './codec.ts';
import {contentKey,encrypt,decrypt} from './crypto.ts';
import type {LocalStore} from './store.ts';

const artifactSchema=z.object({artifactId:id,name:z.string(),type:z.string(),size:nat,version:nat.min(1),deleted:z.boolean()}).strict();
export type Artifact=z.infer<typeof artifactSchema>;
const keySchema=base64.refine(k=>decode(k).length===32,'Expected AES-256 key');
const memberSchema=z.object({personId:id,deviceId:id,keyPackage:base64}).strict();
const savedGroupSchema=z.object({mls:base64,deviceId:id,cursor:nat,own:z.array(nat),keys:z.record(z.string(),keySchema),artifacts:z.array(artifactSchema),members:z.array(memberSchema),blocked:z.boolean()}).strict();
const stateSchema=z.object({version:z.literal(1),personId:id,groups:z.record(z.string(),savedGroupSchema)}).strict();
type SavedGroup=z.infer<typeof savedGroupSchema>;
type Group={saved:SavedGroup;mls:MlsGroup};
const handshake=z.object({format:z.literal('wayfinding-handshake-1'),action:z.enum(['add','remove','update']),commit:base64,welcome:base64.optional(),personId:id,deviceId:id,keyPackage:base64}).strict();
const application=z.discriminatedUnion('action',[
 z.object({action:z.literal('keys'),entries:z.array(z.object({artifact:artifactSchema,key:keySchema}).strict()),members:z.array(memberSchema)}).strict(),
 z.object({action:z.literal('delete'),artifactId:id}).strict(),
]);
const messagesSchema=z.object({messages:z.array(z.object({sequence:nat,epoch:nat,kind:z.enum(['handshake','application']),sender:id,data:base64})),cursor:nat});
export interface CreateArtifact {groupId:string;name:string;type:string;content:string}
export interface UpdateArtifact {groupId:string;artifactId:string;content:string}

/** Local state and plaintext never cross the remote MCP boundary. One serialized device per store. */
export class WayfindingProxy {
 readonly personId:string;
 readonly personalGroupId:string;
 readonly audited=false;
 private remote:Client;
 private store:LocalStore;
 private groups=new Map<string,Group>();
 private tail:Promise<unknown>=Promise.resolve();
 private failed=false;
 private constructor(remote:Client,store:LocalStore,personId:string,personalGroupId:string){this.remote=remote;this.store=store;this.personId=personId;this.personalGroupId=personalGroupId;}
 static async open(remote:Client,store:LocalStore):Promise<WayfindingProxy>{
  const account=z.object({personId:id,personalGroupId:id}).parse(await remoteCall(remote,'account_read',{}));
  const proxy=new WayfindingProxy(remote,store,account.personId,account.personalGroupId);
  const raw=await store.read('state');
  if(raw){const saved=stateSchema.parse(JSON.parse(raw));if(saved.personId!==proxy.personId)throw new Error('Local store belongs to a different account');
   for(const [groupId,s] of Object.entries(saved.groups)){const mls=await createMlsGroup(utf8.encode(s.deviceId));await mls.importState(decode(s.mls));proxy.groups.set(groupId,{saved:s,mls});}
  }
  return proxy;
 }
 private serial<T>(op:()=>Promise<T>):Promise<T>{const result=this.tail.then(()=>{if(this.failed)throw new Error('Local persistence failed; restart from the latest store');return op();});this.tail=result.catch(()=>{});return result;}
 private async persist():Promise<void>{
  const groups:Record<string,SavedGroup>={};for(const [id,g] of this.groups){g.saved.mls=encode(await g.mls.exportState());groups[id]=g.saved;}
  try{await this.store.write('state',JSON.stringify({version:1,personId:this.personId,groups}));}catch(e){this.failed=true;throw e;}
 }
 private async access(groupId:string):Promise<Record<string,unknown>>{
  id.parse(groupId);
  if(groupId.startsWith('personal_')){if(groupId!==this.personalGroupId)throw new Error('Only the personal group owner may access this group');return remoteCall(this.remote,'personal_group_read',{});}
  return remoteCall(this.remote,'journey_read',{journeyId:groupId});
 }
 private group(groupId:string):Group {const g=this.groups.get(groupId);if(!g)throw new Error('Prepare or create the MLS group first');if(g.saved.blocked)throw new Error('MLS delivery interrupted; refusing unsafe retry');return g;}
 private async newGroup(groupId:string):Promise<Group>{
  await this.access(groupId);if(this.groups.has(groupId))throw new Error('Group already prepared');
  const roster=z.object({members:z.array(z.object({id:id}))}).parse(await remoteCall(this.remote,'personal_group_add',{name:`Wayfinding proxy ${crypto.randomUUID()}`,kind:'device'}));
  const deviceId=roster.members.at(-1)!.id;
  const mls=await createMlsGroup(utf8.encode(deviceId));
  const g:Group={mls,saved:{mls:'',deviceId,cursor:0,own:[],keys:{},artifacts:[],members:[],blocked:false}};this.groups.set(groupId,g);await this.persist();return g;
 }
 createGroup(groupId:string):Promise<void>{return this.serial(async()=>{
  await this.access(groupId);const log=messagesSchema.parse(await remoteCall(this.remote,'mls_message_fetch',{groupId}));
  if(log.messages.length)throw new Error('MLS group already exists; prepare and request admission');
  const g=await this.newGroup(groupId);await g.mls.create(utf8.encode(groupId));
  g.saved.members.push({personId:this.personId,deviceId:g.saved.deviceId,keyPackage:encode(g.mls.keyPackage())});
  await this.persist();
  // Reserve the group in the relay with a real epoch update, not an empty marker.
  const commit=await g.mls.commit();await this.postHandshake(groupId,g,commit,'update',this.personId,g.saved.deviceId,encode(g.mls.keyPackage()));
 });}
 prepareGroup(groupId:string):Promise<{deviceId:string}>{return this.serial(async()=>{
  const g=await this.newGroup(groupId);await remoteCall(this.remote,'mls_key_package_publish',{deviceId:g.saved.deviceId,data:encode(g.mls.keyPackage())});return {deviceId:g.saved.deviceId};
 });}
 private async post(groupId:string,g:Group,kind:'handshake'|'application',data:Uint8Array):Promise<void>{
  // Persist consumed ratchets BEFORE network I/O. An ambiguous delivery fails closed.
  g.saved.blocked=true;await this.persist();
  const result=z.object({sequence:nat}).parse(await remoteCall(this.remote,'mls_message_post',{groupId,...(groupId===this.personalGroupId?{memberId:g.saved.deviceId}:{}),epoch:g.mls.epoch,kind,data:encode(data)}));
  g.saved.own.push(result.sequence);g.saved.blocked=false;await this.persist();
 }
 private async postHandshake(groupId:string,g:Group,c:MlsCommit,action:'add'|'remove'|'update',personId:string,deviceId:string,keyPackage:string):Promise<void>{
  await this.post(groupId,g,'handshake',json({format:'wayfinding-handshake-1',action,commit:encode(c.commit),...(c.welcome?{welcome:encode(c.welcome)}:{}),personId,deviceId,keyPackage}));
 }
 addMember(groupId:string,personId:string,deviceId:string):Promise<void>{return this.serial(async()=>{
  await this.syncInner(groupId);const g=this.group(groupId),view=await this.access(groupId);
  if(groupId===this.personalGroupId){if(personId!==this.personId)throw new Error('Personal group admits only the owner devices');
   const members=z.array(z.object({id:id})).parse(view.members);if(!members.some(m=>m.id===deviceId))throw new Error('Device is not an owned live member');
  }else{const members=z.array(z.object({memberId:id})).parse(view.members);if(!members.some(m=>m.memberId===personId))throw new Error('Person is not a live journey member');}
  const kp=z.object({data:base64}).parse(await remoteCall(this.remote,'mls_key_package_fetch',{personId,deviceId}));
  const c=await g.mls.add(decode(kp.data));g.saved.members.push({personId,deviceId,keyPackage:kp.data});
  await this.postHandshake(groupId,g,c,'add',personId,deviceId,kp.data);await this.share(groupId,g);
 });}
 removeMember(groupId:string,personId:string):Promise<void>{return this.serial(async()=>{
  await this.syncInner(groupId);const g=this.group(groupId);
  const members=g.saved.members.filter(m=>m.personId===personId);if(!members.length)throw new Error('MLS member not found');
  for(const m of members){const c=await g.mls.remove(decode(m.keyPackage));g.saved.members=g.saved.members.filter(x=>x.deviceId!==m.deviceId);await this.postHandshake(groupId,g,c,'remove',m.personId,m.deviceId,m.keyPackage);}
 });}
 sync(groupId:string):Promise<void>{return this.serial(()=>this.syncInner(groupId));}
 private async syncInner(groupId:string):Promise<void>{
  await this.access(groupId);const g=this.group(groupId);let reshare=false;
  for(;;){const page=messagesSchema.parse(await remoteCall(this.remote,'mls_message_fetch',{groupId,since:g.saved.cursor}));if(!page.messages.length)break;
   for(const m of page.messages){
    if(m.sequence<=g.saved.cursor)throw new Error('Non-monotone MLS relay');
    if(g.saved.own.includes(m.sequence)){g.saved.own=g.saved.own.filter(n=>n!==m.sequence);}
    else if(m.kind==='handshake'){
     const h=handshake.parse(JSON.parse(text.decode(decode(m.data))));
     if(g.mls.epoch===null){if(h.action==='add'&&h.deviceId===g.saved.deviceId&&h.welcome){await g.mls.processHandshake(decode(h.welcome));g.saved.members.push({personId:h.personId,deviceId:h.deviceId,keyPackage:h.keyPackage});}}
     else {await g.mls.processHandshake(decode(h.commit));
      if(h.action==='add'){g.saved.members.push({personId:h.personId,deviceId:h.deviceId,keyPackage:h.keyPackage});reshare=true;}
      if(h.action==='remove')g.saved.members=g.saved.members.filter(x=>x.deviceId!==h.deviceId);
     }
    }else if(g.mls.epoch!==null){
     const value=application.parse(JSON.parse(text.decode(await g.mls.open(decode(m.data)))));
     if(value.action==='keys'){g.saved.members=value.members;for(const e of value.entries){if(g.saved.artifacts.some(a=>a.artifactId===e.artifact.artifactId&&a.deleted))continue;g.saved.keys[e.artifact.artifactId]=e.key;const index=g.saved.artifacts.findIndex(a=>a.artifactId===e.artifact.artifactId);if(index<0)g.saved.artifacts.push(e.artifact);else if(g.saved.artifacts[index]!.version<=e.artifact.version)g.saved.artifacts[index]=e.artifact;}}
     else {delete g.saved.keys[value.artifactId];const a=g.saved.artifacts.find(a=>a.artifactId===value.artifactId);if(a)a.deleted=true;}
    }
    g.saved.cursor=m.sequence;await this.persist();
   }
  }
  // Server membership is authoritative. Remove departed leaves before sharing ANY new keys.
  if(g.mls.epoch!==null){
   const view=await this.access(groupId);
   const live=new Set(groupId===this.personalGroupId?z.array(z.object({id:id})).parse(view.members).map(m=>m.id):z.array(z.object({memberId:id})).parse(view.members).map(m=>m.memberId));
   const departed=g.saved.members.filter(m=>!live.has(groupId===this.personalGroupId?m.deviceId:m.personId));
   for(const m of departed){const c=await g.mls.remove(decode(m.keyPackage));g.saved.members=g.saved.members.filter(x=>x.deviceId!==m.deviceId);await this.postHandshake(groupId,g,c,'remove',m.personId,m.deviceId,m.keyPackage);}
  }
  if(reshare)await this.share(groupId,g);
 }
 private async share(groupId:string,g:Group):Promise<void>{
  const view=await this.access(groupId);
  const live=groupId===this.personalGroupId?g.saved.artifacts:z.array(artifactSchema).parse(view.artifacts);
  const entries=live.filter(a=>!a.deleted&&g.saved.keys[a.artifactId]).map(artifact=>({artifact,key:g.saved.keys[artifact.artifactId]!}));
  await this.post(groupId,g,'application',await g.mls.seal(json({action:'keys',entries,members:g.saved.members})));
 }
 exportGroup(groupId:string):Promise<string>{return this.serial(async()=>encode(await this.group(groupId).mls.exportState()));}
 async coordinationTools(){return (await this.remote.listTools()).tools.filter(t=>!t.name.startsWith('artifact_')&&!t.name.startsWith('mls_'));}
 call(name:string,input:Record<string,unknown>={}):Promise<Record<string,unknown>>{return this.serial(async()=>{
  if(name.startsWith('artifact_')||name.startsWith('mls_'))throw new Error('Use local encrypted tools');return remoteCall(this.remote,name,input);
 });}
 createArtifact(input:CreateArtifact):Promise<Artifact>{return this.serial(()=>this.createInner(input));}
 private async createInner(input:CreateArtifact):Promise<Artifact>{
  const {groupId,name,type,content}=input;await this.syncInner(groupId);const g=this.group(groupId);if(g.mls.epoch===null)throw new Error('Await MLS admission');
  let artifact:Artifact;
  if(groupId===this.personalGroupId)artifact={artifactId:`artifact_${crypto.randomUUID()}`,name,type,size:utf8.encode(content).length,version:1,deleted:false};
  else {const before=new Set(z.array(artifactSchema).parse((await this.access(groupId)).artifacts).map(a=>a.artifactId));
   const result=await remoteCall(this.remote,'artifact_create',{journeyId:groupId,name,type,size:utf8.encode(content).length});artifact=z.array(artifactSchema).parse(result.artifacts).find(a=>!before.has(a.artifactId))!;if(!artifact)throw new Error('Missing created artifact');}
  const key=contentKey();g.saved.keys[artifact.artifactId]=encode(key);g.saved.artifacts.push(artifact);await this.persist();
  await remoteCall(this.remote,'artifact_blob_put',{groupId,artifactId:artifact.artifactId,version:1,data:await encrypt(utf8.encode(content),key,groupId,artifact.artifactId,1)});
  await this.share(groupId,g);return artifact;
 }
 listArtifacts(groupId:string):Promise<Artifact[]>{return this.serial(()=>this.listInner(groupId));}
 private async listInner(groupId:string):Promise<Artifact[]>{await this.syncInner(groupId);return (groupId===this.personalGroupId?this.group(groupId).saved.artifacts:z.array(artifactSchema).parse((await this.access(groupId)).artifacts)).filter(a=>!a.deleted);}
 readArtifact(groupId:string,artifactId:string):Promise<Artifact&{content:string}>{return this.serial(()=>this.readInner(groupId,artifactId));}
 private async readInner(groupId:string,artifactId:string):Promise<Artifact&{content:string}>{
  const artifact=(await this.listInner(groupId)).find(a=>a.artifactId===artifactId);if(!artifact)throw new Error('Artifact not found or deleted');
  const key=this.group(groupId).saved.keys[artifactId];if(!key)throw new Error('Artifact key not available; an existing member must synchronize');
  const blob=z.object({data:base64}).parse(await remoteCall(this.remote,'artifact_blob_get',{groupId,artifactId,version:artifact.version}));
  return {...artifact,content:text.decode(await decrypt(blob.data,decode(key),groupId,artifactId,artifact.version))};
 }
 updateArtifact(input:UpdateArtifact):Promise<Artifact>{return this.serial(async()=>{
  const {groupId,artifactId,content}=input;const previous=await this.readInner(groupId,artifactId),g=this.group(groupId);
  const artifact:Artifact={artifactId,name:previous.name,type:previous.type,size:utf8.encode(content).length,version:nat.parse(previous.version+1),deleted:false};
  if(groupId!==this.personalGroupId)await remoteCall(this.remote,'artifact_version',{journeyId:groupId,artifactId,baseVersion:previous.version,size:artifact.size});
  await remoteCall(this.remote,'artifact_blob_put',{groupId,artifactId,version:artifact.version,data:await encrypt(utf8.encode(content),decode(g.saved.keys[artifactId]!),groupId,artifactId,artifact.version)});
  g.saved.artifacts=g.saved.artifacts.map(a=>a.artifactId===artifactId?artifact:a);await this.persist();await this.share(groupId,g);return artifact;
 });}
 deleteArtifact(groupId:string,artifactId:string):Promise<void>{return this.serial(()=>this.deleteInner(groupId,artifactId));}
 private async deleteInner(groupId:string,artifactId:string):Promise<void>{
  await this.readInner(groupId,artifactId);const g=this.group(groupId);
  if(groupId===this.personalGroupId)await remoteCall(this.remote,'artifact_blob_delete',{groupId,artifactId});
  else await remoteCall(this.remote,'artifact_delete',{journeyId:groupId,artifactId});
  delete g.saved.keys[artifactId];const a=g.saved.artifacts.find(a=>a.artifactId===artifactId);if(a)a.deleted=true;await this.persist();
  await this.post(groupId,g,'application',await g.mls.seal(json({action:'delete',artifactId})));
 }
 copyArtifact(sourceGroupId:string,artifactId:string,destinationGroupId:string,move=false):Promise<Artifact>{return this.serial(async()=>{
  if(sourceGroupId===destinationGroupId)throw new Error('Choose a different destination group');
  const source=await this.readInner(sourceGroupId,artifactId);
  const copy=await this.createInner({groupId:destinationGroupId,name:source.name,type:source.type,content:source.content});
  if(move)await this.deleteInner(sourceGroupId,artifactId);return copy;
 });}
}
async function remoteCall(remote:Client,name:string,input:Record<string,unknown>):Promise<Record<string,unknown>>{
 const result=await remote.callTool({name,arguments:input});if(result.isError)throw new Error(`Remote ${name} refused: ${JSON.stringify(result.content)}`);
 if(!result.structuredContent)throw new Error('Missing remote tool data');return z.record(z.string(),z.unknown()).parse(result.structuredContent);
}
