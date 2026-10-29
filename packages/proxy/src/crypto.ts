import {decode,encode,json} from './codec.ts';
/** Every new artifact gets an independent 256-bit key. No server receives it. */
export function contentKey():Uint8Array { return crypto.getRandomValues(new Uint8Array(32)); }
function context(groupId:string,artifactId:string,version:number):Uint8Array<ArrayBuffer> { return new Uint8Array(json({groupId,artifactId,version})); }
export async function encrypt(content:Uint8Array,key:Uint8Array,groupId:string,artifactId:string,version:number):Promise<string> {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const imported=await crypto.subtle.importKey('raw',new Uint8Array(key),'AES-GCM',false,['encrypt']);
  const sealed=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:context(groupId,artifactId,version)},imported,new Uint8Array(content)));
  const bytes=new Uint8Array(12+sealed.length); bytes.set(iv); bytes.set(sealed,12); return encode(bytes);
}
export async function decrypt(data:string,key:Uint8Array,groupId:string,artifactId:string,version:number):Promise<Uint8Array> {
  const bytes=decode(data); if(bytes.length<28) throw new Error('Invalid artifact ciphertext');
  const imported=await crypto.subtle.importKey('raw',new Uint8Array(key),'AES-GCM',false,['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(bytes.slice(0,12)),additionalData:context(groupId,artifactId,version)},imported,new Uint8Array(bytes.slice(12))));
}
