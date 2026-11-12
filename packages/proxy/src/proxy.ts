import * as z from 'zod';
import {id,utf8} from './codec.ts';
import type {LocalStore} from './store.ts';
import {SealedClient,type SealedRemote} from './sealed-client.ts';
import {sealedRemoteCall} from './mode.ts';

export interface Artifact {artifactId:string;name:string;type:string;size:number;version:number;deleted:boolean}
export interface CreateArtifact {groupId:string;name:string;type:string;content:string}
export interface UpdateArtifact {groupId:string;artifactId:string;content:string}
/** Sealed-only compatibility facade. Local state and plaintext never cross the remote boundary. */
export class WayfindingProxy {
 readonly audited=false;
 private tail:Promise<unknown>=Promise.resolve();
 private sealed:SealedClient;readonly personId:string;readonly personalGroupId:string;
 private constructor(sealed:SealedClient,personId:string,personalGroupId:string){this.sealed=sealed;this.personId=personId;this.personalGroupId=personalGroupId;}
 static async open(remote:SealedRemote,store:LocalStore):Promise<WayfindingProxy>{
  const account=z.object({personId:id,personalGroupId:id}).parse(await sealedRemoteCall(remote,'account_read',{}));
  return new WayfindingProxy(await SealedClient.open(remote,store,account.personId),account.personId,account.personalGroupId);
 }
 private serial<T>(op:()=>Promise<T>):Promise<T>{const result=this.tail.then(op);this.tail=result.catch(()=>{});return result;}
 createGroup(groupId:string){return this.serial(()=>this.sealed.createGroup(groupId));}
 prepareGroup(groupId:string){return this.serial(()=>this.sealed.prepareGroup(groupId));}
 addMember(groupId:string,personId:string,deviceId:string){return this.serial(()=>this.sealed.addMember(groupId,personId,deviceId));}
 removeMember(groupId:string,personId:string){return this.serial(()=>this.sealed.removeMember(groupId,personId));}
 sync(groupId:string){return this.serial(()=>this.sealed.sync(groupId));}
 exportGroup(groupId:string){return this.serial(()=>this.sealed.exportGroup(groupId));}
 coordinationTools(){return this.sealed.tools();}
 call(name:string,input:Record<string,unknown>={}){return this.serial(()=>this.sealed.call(name,input));}
 private artifact(item:Record<string,unknown>):Artifact{return {artifactId:id.parse(item.recordId),name:String(item.name??''),type:String(item.mimeType??item.kind??'other'),size:utf8.encode(String(item.text??item.content??'')).length,version:Number(item.revision),deleted:false};}
 createArtifact(input:CreateArtifact){return this.serial(()=>this.createInner(input));}
 private async createInner(input:CreateArtifact):Promise<Artifact>{
  const r=await this.sealed.call('library_add',{journeyId:await this.sealed.artifactJourney(input.groupId),visibility:input.groupId===this.personalGroupId?'private':'members',name:input.name,mimeType:input.type,text:input.content});
  const item=z.array(z.record(z.string(),z.unknown())).parse(r.records).find(r=>r.type==='library');if(!item)throw new Error('Missing created artifact');return this.artifact(item);
 }
 listArtifacts(groupId:string){return this.serial(async()=>{const result=await this.sealed.call('library_search',{journeyId:await this.sealed.artifactJourney(groupId),includeProjects:true});return z.array(z.record(z.string(),z.unknown())).parse(result.items).map(item=>this.artifact(item));});}
 readArtifact(groupId:string,artifactId:string){return this.serial(()=>this.readInner(groupId,artifactId));}
 private async readInner(groupId:string,artifactId:string):Promise<Artifact&{content:string}>{
  const item=await this.sealed.call('library_get',{itemId:artifactId});
  return {...this.artifact(item),content:String(item.text??item.content??'')};
 }
 updateArtifact(input:UpdateArtifact):Promise<Artifact>{return this.serial(async()=>{const previous=await this.readInner(input.groupId,input.artifactId);await this.sealed.call('library_version',{itemId:input.artifactId,baseVersion:previous.version,text:input.content});return {...previous,size:utf8.encode(input.content).length,version:previous.version+1};});}
 deleteArtifact(groupId:string,artifactId:string){return this.serial(()=>this.deleteInner(groupId,artifactId));}
 private async deleteInner(_groupId:string,artifactId:string){await this.sealed.call('library_delete',{itemId:artifactId});}
 copyArtifact(sourceGroupId:string,artifactId:string,destinationGroupId:string,move=false):Promise<Artifact>{return this.serial(async()=>{
  if(sourceGroupId===destinationGroupId)throw new Error('Choose a different destination group');
  const source=await this.readInner(sourceGroupId,artifactId),copy=await this.createInner({groupId:destinationGroupId,name:source.name,type:source.type,content:source.content});
  if(move)await this.deleteInner(sourceGroupId,artifactId);return copy;
 });}
}
