import type { SealedRemote } from '../../proxy/src/sealed-client.ts';
export type BrowserPost=(path:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
export function consoleRemote(post:BrowserPost,browserId:string,enroll:(device:Record<string,unknown>)=>Promise<Record<string,unknown>>):SealedRemote{
 return {async listTools(){return {tools:[]};},async callTool(request){
  const structuredContent=request.name==='sealed_device_register'?await enroll(request.arguments??{}):await post('/console/device/call',{browserId,tool:request.name,input:request.arguments??{}});
  return {structuredContent,content:[{type:'text',text:'Sealed console operation'}]};
 }};
}
