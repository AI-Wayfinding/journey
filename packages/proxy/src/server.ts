import {McpServer,fromJsonSchema} from '@modelcontextprotocol/server';
import * as z from 'zod';
import {id} from './codec.ts';
import type {WayfindingProxy} from './proxy.ts';
const group=z.object({groupId:id}).strict();
const artifact=z.object({groupId:id,artifactId:id}).strict();
const create=z.object({groupId:id,name:z.string().min(1).max(4096),type:id,content:z.string().max(9*1024*1024)}).strict();
const transfer=z.object({sourceGroupId:id,artifactId:id,destinationGroupId:id}).strict();
export async function buildProxyServer(proxy:WayfindingProxy):Promise<McpServer>{
 const server=new McpServer({name:'wayfinding-local-proxy',version:'0.1.0'},{capabilities:{tools:{}},instructions:'Artifact content is encrypted locally. ts-mls 1.6.4 is unaudited; do not use real confidential data in this PoC.'});
 const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:{...(typeof value==='object'&&value!==null&&!Array.isArray(value)?value:{result:value})}});
 const safe=async(op:()=>Promise<unknown>)=>{try{return result(await op());}catch(e){return {isError:true,content:[{type:'text' as const,text:e instanceof Error?e.message:'Local operation failed'}]};}};
 server.registerTool('artifact_create',{description:'Encrypt a new artifact locally.',inputSchema:create},i=>safe(()=>proxy.createArtifact(i)));
 server.registerTool('artifact_read',{description:'Fetch and decrypt the latest artifact.',inputSchema:artifact},i=>safe(()=>proxy.readArtifact(i.groupId,i.artifactId)));
 server.registerTool('artifact_list',{description:'List live artifacts without fetching content.',inputSchema:group},i=>safe(async()=>({artifacts:await proxy.listArtifacts(i.groupId)})));
 server.registerTool('artifact_update',{description:'Encrypt a new artifact version.',inputSchema:artifact.extend({content:z.string().max(9*1024*1024)}).strict()},i=>safe(()=>proxy.updateArtifact(i)));
 for(const move of [false,true])server.registerTool(move?'artifact_move':'artifact_copy',{description:move?'Copy with a fresh destination key, then delete the source.':'Decrypt locally and re-encrypt under a fresh destination key.',inputSchema:transfer},i=>safe(()=>proxy.copyArtifact(i.sourceGroupId,i.artifactId,i.destinationGroupId,move)));
 server.registerTool('artifact_delete',{description:'Delete all source ciphertext versions and forget the local key.',inputSchema:artifact},i=>safe(async()=>{await proxy.deleteArtifact(i.groupId,i.artifactId);return {deleted:true};}));
 server.registerTool('mls_group_create',{description:'Create a new MLS group. ts-mls 1.6.4 is unaudited.',inputSchema:group},i=>safe(async()=>{await proxy.createGroup(i.groupId);return {created:true,audited:false};}));
 server.registerTool('mls_group_prepare',{description:'Publish a device key package and return its deviceId for admission.',inputSchema:group},i=>safe(()=>proxy.prepareGroup(i.groupId)));
 server.registerTool('mls_group_add',{description:'Add a live journey member or owned personal device; share entitled history.',inputSchema:group.extend({personId:id,deviceId:id}).strict()},i=>safe(async()=>{await proxy.addMember(i.groupId,i.personId,i.deviceId);return {added:true};}));
 server.registerTool('mls_group_remove',{description:'Commit removal of all known devices for a person before journey removal.',inputSchema:group.extend({personId:id}).strict()},i=>safe(async()=>{await proxy.removeMember(i.groupId,i.personId);return {removed:true};}));
 server.registerTool('mls_group_sync',{description:'Process ordered MLS messages and re-share keys after admission.',inputSchema:group},i=>safe(async()=>{await proxy.sync(i.groupId);return {synchronized:true};}));
 for(const tool of await proxy.coordinationTools()){
  // The wire SDK types permit arbitrary JSON here; validate the schema shape at this boundary.
  const shape=z.object({type:z.literal('object'),properties:z.record(z.string(),z.record(z.string(),z.unknown())).optional(),required:z.array(z.string()).optional(),additionalProperties:z.boolean().optional()}).parse(tool.inputSchema);
  server.registerTool(tool.name,{description:tool.description??tool.name,inputSchema:fromJsonSchema(shape)},i=>safe(()=>proxy.call(tool.name,z.record(z.string(),z.unknown()).parse(i))));
 }
 return server;
}
