import * as z from 'zod';
import { encode, decode } from '../../proxy/src/codec.ts';
import type { LocalStore } from '../../proxy/src/store.ts';
import { derivePrfKey, deriveRecoveryKey, wrap, unwrap, wrappedSchema, type VaultContext } from './vault.ts';
const recordSchema=z.object({context:z.object({origin:z.string(),personId:z.string(),deviceId:z.string().uuid()}).strict(),credentialId:z.string(),salt:z.string(),prfSalt:z.string(),prfWrap:wrappedSchema.optional(),recoveryWrap:wrappedSchema,state:wrappedSchema}).strict();
export type VaultRecord=z.infer<typeof recordSchema>;
const database=()=>new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('wayfinding-browser-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('vaults');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('Private browser storage unavailable'));r.onblocked=()=>reject(new Error('Close other Wayfinding tabs'));});
const recordKey=(origin:string,personId:string)=>JSON.stringify([origin,personId]);
export async function readVault(origin:string,personId:string):Promise<VaultRecord|undefined>{
 const db=await database();try{return await new Promise((resolve,reject)=>{const r=db.transaction('vaults','readonly').objectStore('vaults').get(recordKey(origin,personId));r.onsuccess=()=>{try{const record=r.result===undefined?undefined:recordSchema.parse(r.result);if(record&&(record.context.origin!==origin||record.context.personId!==personId))throw new Error('Browser storage identity mismatch');resolve(record);}catch(error){reject(error);}};r.onerror=()=>reject(new Error('Cannot read private browser storage'));});}finally{db.close();}
}
async function saveVault(record:VaultRecord):Promise<void>{
 const db=await database();try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('vaults','readwrite',{durability:'strict'});tx.objectStore('vaults').put(record,recordKey(record.context.origin,record.context.personId));tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(new Error('Cannot commit private browser state; lock and reopen'));});}finally{db.close();}
}
/** Held for the entire unlocked lifetime. Never fall back to concurrent ratchet writers. */
export async function singleWriter(origin:string,personId:string):Promise<()=>void>{
 if(!navigator.locks)throw new Error('This browser needs Web Locks for safe MLS storage');
 let release=()=>{};
 return new Promise((resolve,reject)=>{void navigator.locks.request(recordKey(origin,personId),{ifAvailable:true},async lock=>{if(!lock){reject(new Error('Another tab has this device unlocked'));return;}await new Promise<void>(done=>{release=done;resolve(()=>release());});}).catch(reject);});
}
export class BrowserStore implements LocalStore{
 private record:VaultRecord;private key:CryptoKey|undefined;private values:Record<string,string>;private release:()=>void;private pending:Promise<void>=Promise.resolve();
 private constructor(record:VaultRecord,key:CryptoKey,values:Record<string,string>,release:()=>void){this.record=record;this.key=key;this.values=values;this.release=release;}
 get browserId(){return this.record.context.deviceId;}
 get credentialId(){return this.record.credentialId;}
 static async create(context:VaultContext,credentialId:string,code:string,prfSalt:Uint8Array,prf:Uint8Array|undefined,release:()=>void):Promise<BrowserStore>{
  if(await readVault(context.origin,context.personId))throw new Error('A local device exists; unlock it instead');
  const raw=crypto.getRandomValues(new Uint8Array(32)),salt=crypto.getRandomValues(new Uint8Array(32)),key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
  const record:VaultRecord={context,credentialId,salt:encode(salt),prfSalt:encode(prfSalt),recoveryWrap:await wrap(encode(raw),await deriveRecoveryKey(code,salt,context),context),state:await wrap('{}',key,context)};
  if(prf)record.prfWrap=await wrap(encode(raw),await derivePrfKey(prf,salt,context),context);raw.fill(0);
  await saveVault(record);return new BrowserStore(record,key,{},release);
 }
 static async unlock(record:VaultRecord,method:{code:string}|{prf:Uint8Array},release:()=>void):Promise<BrowserStore>{
  const latest=await readVault(record.context.origin,record.context.personId);if(!latest||latest.context.deviceId!==record.context.deviceId||latest.credentialId!==record.credentialId)throw new Error('Browser record changed; reload');record=latest;
  const c=record.context,salt=decode(record.salt),wrapper='code'in method?record.recoveryWrap:record.prfWrap;if(!wrapper)throw new Error('Use your recovery code for this passkey');
  const key='code'in method?await deriveRecoveryKey(method.code,salt,c):await derivePrfKey(method.prf,salt,c);
  const raw=decode(await unwrap(wrapper,key,c));if(raw.length!==32)throw new Error('Invalid private key wrapper');
  const dataKey=await crypto.subtle.importKey('raw',new Uint8Array(raw),'AES-GCM',false,['encrypt','decrypt']);raw.fill(0);
  const values=z.record(z.string(),z.string()).parse(JSON.parse(await unwrap(record.state,dataKey,c)));
  return new BrowserStore(record,dataKey,values,release);
 }
 async read(name:string){if(!this.key)throw new Error('Device locked');return this.values[name];}
 async write(name:string,value:string){
  if(!this.key)throw new Error('Device locked');if(name!=='sealed-state')throw new Error('Unknown browser storage record');
  const commit=this.pending.then(async()=>{
   if(!this.key)throw new Error('Device locked');
   const values={...this.values,[name]:value},record={...this.record,state:await wrap(JSON.stringify(values),this.key,this.record.context)};
   await saveVault(record);this.record=record;if(this.key)this.values=values;
  });
  this.pending=commit.catch(()=>{});return commit;
 }
 // A pagehide can race an IndexedDB commit. Keep the writer fence until it drains.
 lock(){this.key=undefined;this.values={};void this.pending.then(()=>this.release());}
}
