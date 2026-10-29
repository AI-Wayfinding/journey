import * as z from 'zod';
export const id = z.string().min(1).max(200);
export const nat = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const utf8 = new TextEncoder();
export const text = new TextDecoder('utf-8', {fatal:true});
export function encode(bytes:Uint8Array):string {
  let raw=''; for(let i=0;i<bytes.length;i+=8192) raw+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(raw);
}
export function decode(value:string):Uint8Array { base64.parse(value); return Uint8Array.from(atob(value),c=>c.charCodeAt(0)); }
export function json(value:unknown):Uint8Array { return utf8.encode(JSON.stringify(value)); }
