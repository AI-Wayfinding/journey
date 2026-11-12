import * as z from 'zod';
import type { SealedRemote } from '../../proxy/src/sealed-client.ts';
export type BrowserPost=(path:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
const refusal='Request refused. Check your passkey or recovery code, permissions and sign-in.';
class BrowserRefusal extends Error {
 readonly reason:string;
 constructor(reason:string){super(refusal);this.reason=reason;}
}
export function consolePost(csrf:string|undefined,send:(path:string,init:RequestInit)=>Promise<Response>=fetch):BrowserPost{
 return async(path,body)=>{
  const r=await send(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({csrf,...body})});
  if(r.redirected)throw new Error(refusal);
  if(r.status===409){
   const reason=z.object({error:z.string().min(1).max(4096)}).safeParse(await r.json());
   if(reason.success)throw new BrowserRefusal(reason.data.error);
   throw new Error(refusal);
  }
  if(!r.ok)throw new Error(refusal);
  return z.record(z.string(),z.unknown()).parse(await r.json());
 };
}
export function consoleRemote(post:BrowserPost,browserId:string,enroll:(device:Record<string,unknown>)=>Promise<Record<string,unknown>>):SealedRemote{
 return {async listTools(){return {tools:[]};},async callTool(request){
  try{
   const structuredContent=request.name==='sealed_device_register'?await enroll(request.arguments??{}):await post('/console/device/call',{browserId,tool:request.name,input:request.arguments??{}});
   return {structuredContent,content:[{type:'text',text:'Sealed console operation'}]};
  }catch(error){
   if(error instanceof BrowserRefusal)return {isError:true,content:[{type:'text',text:error.reason}]};
   throw error;
  }
 }};
}
