import * as z from 'zod';
import { encode, decode, utf8, text } from '../../proxy/src/codec.ts';
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
export interface VaultContext { origin: string; personId: string; deviceId: string }
const FORMAT = 'wayfinding-browser-vault-1';
const aad = (c: VaultContext) => utf8.encode(JSON.stringify([FORMAT, c.origin, c.personId, c.deviceId]));
export const wrappedSchema = z.object({ format: z.literal(FORMAT), iv: z.string(), ciphertext: z.string() }).strict();
export type Wrapped = z.infer<typeof wrappedSchema>;
export function recoveryCode(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{8}/g)!.join('-');
}
export async function derivePrfKey(output: Uint8Array, salt: Uint8Array, context: VaultContext): Promise<CryptoKey> {
  if (output.length !== 32 || salt.length !== 32) throw new Error('32-byte PRF output and salt required');
  const material = await crypto.subtle.importKey('raw', new Uint8Array(output), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(salt), info: aad(context) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function deriveRecoveryKey(code: string, salt: Uint8Array, context: VaultContext): Promise<CryptoKey> {
  const normalized = code.replaceAll('-', '').replaceAll(' ', '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized) || salt.length !== 32) throw new Error('Invalid recovery code');
  const material = await crypto.subtle.importKey('raw', utf8.encode(normalized), 'PBKDF2', false, ['deriveKey']);
  const domainSalt = new Uint8Array([...salt, ...aad(context)]);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: domainSalt, iterations: 210000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function wrap(value: string, key: CryptoKey, context: VaultContext): Promise<Wrapped> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(context) }, key, utf8.encode(value));
  return { format: FORMAT, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function unwrap(value: Wrapped, key: CryptoKey, context: VaultContext): Promise<string> {
  const envelope = wrappedSchema.parse(value), iv = decode(envelope.iv);
  if (iv.length !== 12) throw new Error('Invalid wrapping nonce');
  return text.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: aad(context) }, key, new Uint8Array(decode(envelope.ciphertext))));
}

/** Account recovery uses stable account/origin domains, never a browser id. */
async function recoveryMaterial(code:string,origin:string,personId:string,purpose:string):Promise<Uint8Array> {
 const normalized=code.replaceAll('-','').replaceAll(' ','').toUpperCase();
 if(!/^[A-F0-9]{64}$/.test(normalized))throw new Error('Invalid recovery code');
 const material=await crypto.subtle.importKey('raw',utf8.encode(normalized),'HKDF',false,['deriveBits']);
 return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:utf8.encode('wayfinding-account-recovery-1'),info:utf8.encode(JSON.stringify([purpose,origin,personId]))},material,256));
}
export async function recoveryAuthorization(code:string,origin:string,personId:string):Promise<string> {
 const bytes=await recoveryMaterial(code,origin,personId,'authorize-passkey');
 try{return encode(bytes).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}finally{bytes.fill(0);}
}
/** Future account-key envelope seam. This key cannot be derived from the server proof. */
export async function recoveryAccountWrappingKey(code:string,origin:string,personId:string):Promise<CryptoKey> {
 const bytes=await recoveryMaterial(code,origin,personId,'wrap-account-key');
 try{return await crypto.subtle.importKey('raw',new Uint8Array(bytes),'AES-GCM',false,['encrypt','decrypt']);}finally{bytes.fill(0);}
}
