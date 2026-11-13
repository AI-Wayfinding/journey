import * as z from 'zod';
import {RemoteFailure,remoteFailure,transportFailure} from './errors.ts';
import type {SealedRemote} from './sealed-client.ts';
import type {LocalStore} from './store.ts';

export async function sealedRemoteCall(remote:SealedRemote,name:string,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const read=async(tool:string,input:Record<string,unknown>)=>{
  let r;try{r=await remote.callTool({name:tool,arguments:input});}catch(error){throw transportFailure(error);}
  if(r.isError)throw remoteFailure(r.content?.map(c=>c.type==='text'?c.text:'').join('\n').slice(0,4096)??'');
  const parsed=z.record(z.string(),z.unknown()).safeParse(r.structuredContent);if(!parsed.success)throw new RemoteFailure('response');return parsed.data;
 };
 const account=await read('account_read',{});
 if(account.contentFormat!=='sealed-v1')throw new RemoteFailure('mode');
 return name==='account_read'?account:read(name,args);
}
export async function pinSealedMode(store:LocalStore,personId:string):Promise<void>{
 const pin={version:1,contentFormat:'sealed-v1',personId},raw=await store.read('content-mode');
 if(raw){let saved:unknown;try{saved=JSON.parse(raw)}catch{throw new Error('Invalid local sealed mode');}
  const parsed=z.object({version:z.literal(1),contentFormat:z.literal('sealed-v1'),personId:z.literal(personId)}).strict().safeParse(saved);if(!parsed.success)throw new Error('Unsupported local sealed mode or account');
 }else{if(await store.read('state'))throw new Error('Legacy local state requires an explicit migration; sealed-v1 only');await store.write('content-mode',JSON.stringify(pin));}
}
