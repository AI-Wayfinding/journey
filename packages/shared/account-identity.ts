import * as z from 'zod';
import {encode,decode,json} from '../proxy/src/codec.ts';

const id=z.string().min(1).max(200),nat=z.number().int().nonnegative().safe();
export const publicKeySchema=z.string().length(44);
export const accountIdentitySchema=z.object({publicKey:publicKeySchema,generation:nat}).strict();
export type AccountIdentity=z.infer<typeof accountIdentitySchema>;
export const connectionClaimSchema=z.object({personId:id,agentId:id.optional(),connectionId:id,verificationKey:publicKeySchema,generation:nat,accountPublicKey:publicKeySchema}).strict();
export type ConnectionClaim=z.infer<typeof connectionClaimSchema>;
export const connectionCertificateSchema=connectionClaimSchema.extend({signature:z.string().length(88)}).strict();
export type ConnectionCertificate=z.infer<typeof connectionCertificateSchema>;
export const identityEventBodySchema=z.object({personId:id,generation:nat,accountPublicKey:publicKeySchema,action:z.enum(['account-key-set','connection-added','connection-removed']),connectionId:id.optional(),previousPublicKey:z.string().max(200).optional(),at:nat}).strict();
export const identityEventSchema=identityEventBodySchema.extend({signature:z.string().length(88).optional()}).strict();
export type IdentityEvent=z.infer<typeof identityEventSchema>;
export const accountKeyWrapSchema=z.object({format:z.literal('wayfinding-browser-vault-1'),iv:z.string().max(32),ciphertext:z.string().max(4096)}).strict();
export const accountKeyRecordSchema=z.object({identity:accountIdentitySchema,recoveryWrap:accountKeyWrapSchema}).strict();
export type AccountKeyRecord=z.infer<typeof accountKeyRecordSchema>;
export const deviceRegistrationSchema=z.object({deviceId:id,verificationKey:publicKeySchema,data:z.string().min(4).max(87384),credential:connectionCertificateSchema,packageSignature:z.string().length(88)}).strict();
export type DeviceRegistration=z.infer<typeof deviceRegistrationSchema>;
export interface SigningKey {publicKey:string;privateKey:string}
export async function generateSigningKey():Promise<SigningKey>{
 const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
 if(!('privateKey'in pair))throw new Error('Ed25519 key pair required');
 return {publicKey:encode(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey))),privateKey:encode(new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey)))};
}
export async function signValue(secret:string,domain:string,value:unknown):Promise<string>{
 const key=await crypto.subtle.importKey('pkcs8',decode(secret),'Ed25519',false,['sign']);
 return encode(new Uint8Array(await crypto.subtle.sign('Ed25519',key,json([domain,value]))));
}
export async function verifyValue(publicKey:string,signature:string,domain:string,value:unknown):Promise<boolean>{
 try{const bytes=decode(publicKey);if(bytes.length!==32)return false;const key=await crypto.subtle.importKey('raw',bytes,'Ed25519',false,['verify']);return await crypto.subtle.verify('Ed25519',key,decode(signature),json([domain,value]));}catch{return false;}
}
export function connectionClaim(value:ConnectionClaim):ConnectionClaim{return connectionClaimSchema.parse({personId:value.personId,...(value.agentId?{agentId:value.agentId}:{}),connectionId:value.connectionId,verificationKey:value.verificationKey,generation:value.generation,accountPublicKey:value.accountPublicKey});}
export async function signConnection(secret:string,value:ConnectionClaim):Promise<ConnectionCertificate>{const body=connectionClaim(value);return {...body,signature:await signValue(secret,'wayfinding-connection-1',body)};}
export async function verifyConnection(value:unknown):Promise<ConnectionCertificate>{
 const cert=connectionCertificateSchema.parse(value);if(!await verifyValue(cert.accountPublicKey,cert.signature,'wayfinding-connection-1',connectionClaim(cert)))throw new Error('Account connection signature mismatch');return cert;
}
function packageBody(value:Omit<DeviceRegistration,'packageSignature'>){return {deviceId:value.deviceId,verificationKey:value.verificationKey,data:value.data,credential:connectionCertificateSchema.parse(value.credential)};}
export async function signPackage(secret:string,value:Omit<DeviceRegistration,'packageSignature'>):Promise<string>{return signValue(secret,'wayfinding-mls-package-1',packageBody(value));}
/** Both the MLS key package and its packet signing key chain to the member's account key. */
export async function verifyDeviceBinding(value:unknown):Promise<ConnectionCertificate>{
 const b=z.object({deviceId:id,personId:id,agentId:id.optional(),verificationKey:publicKeySchema,data:z.string(),credential:connectionCertificateSchema,packageSignature:z.string()}).parse(value);
 const cert=await verifyConnection(b.credential);
 if(cert.personId!==b.personId||cert.agentId!==b.agentId||cert.verificationKey!==b.verificationKey)throw new Error('Account connection owner/key mismatch');
 if(!await verifyValue(b.verificationKey,b.packageSignature,'wayfinding-mls-package-1',packageBody(b)))throw new Error('Account-endorsed MLS package signature mismatch');
 return cert;
}
export async function safetyNumber(publicKey:string):Promise<string>{
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',json(['wayfinding-safety-number-1',publicKey])));
 // Six 16-bit chunks (~96 bits), rendered as six fixed-width human-comparable groups.
 return Array.from({length:6},(_,i)=>String(bytes[i*2]!*256+bytes[i*2+1]!).padStart(5,'0')).join(' ');
}
export async function requestFingerprint(value:ConnectionClaim):Promise<string>{return safetyNumber(encode(new Uint8Array(await crypto.subtle.digest('SHA-256',json(['wayfinding-connection-request-1',connectionClaim(value)])))));}
export function identityEventBody(value:IdentityEvent):z.infer<typeof identityEventBodySchema>{return identityEventBodySchema.parse({personId:value.personId,generation:value.generation,accountPublicKey:value.accountPublicKey,action:value.action,...(value.connectionId?{connectionId:value.connectionId}:{}),...(value.previousPublicKey?{previousPublicKey:value.previousPublicKey}:{}),at:value.at});}
export async function signIdentityEvent(secret:string,value:z.infer<typeof identityEventBodySchema>):Promise<IdentityEvent>{const body=identityEventBody(value);return {...body,signature:await signValue(secret,'wayfinding-identity-event-1',body)};}
export async function verifyIdentityEvent(value:unknown):Promise<boolean>{try{const event=identityEventSchema.parse(value);return !!event.signature&&await verifyValue(event.accountPublicKey,event.signature,'wayfinding-identity-event-1',identityEventBody(event));}catch{return false;}}
