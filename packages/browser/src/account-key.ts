import * as z from 'zod';
import {generateSigningKey,accountKeyRecordSchema,signValue,verifyValue,signConnection,signIdentityEvent,connectionClaim,type SigningKey,type AccountKeyRecord,type ConnectionClaim,type IdentityEvent} from '../../shared/account-identity.ts';
import {recoveryAccountWrappingKey,wrap,unwrap,type VaultContext} from './vault.ts';
import type {LocalStore} from '../../proxy/src/store.ts';
import type {BrowserPost} from './remote.ts';
const keySchema=z.object({publicKey:z.string(),privateKey:z.string()}).strict();
const context=(origin:string,personId:string):VaultContext=>({origin,personId,deviceId:'account-signing-key-1'});
export async function sealAccountKey(key:SigningKey,code:string,origin:string,personId:string){return wrap(JSON.stringify(key),await recoveryAccountWrappingKey(code,origin,personId),context(origin,personId));}
export async function recoverAccountKey(record:AccountKeyRecord,code:string,origin:string,personId:string):Promise<SigningKey>{
 const key=keySchema.parse(JSON.parse(await unwrap(record.recoveryWrap,await recoveryAccountWrappingKey(code,origin,personId),context(origin,personId))));
 const proof=await signValue(key.privateKey,'wayfinding-account-key-check-1',personId);
 if(key.publicKey!==record.identity.publicKey||!await verifyValue(key.publicKey,proof,'wayfinding-account-key-check-1',personId))throw new Error('Recovered account key mismatch');return key;
}
export class BrowserAccountKey{
 private key:SigningKey|undefined;readonly personId:string;readonly generation:number;readonly publicKey:string;
 private constructor(key:SigningKey|undefined,personId:string,generation:number,publicKey:string){this.key=key;this.personId=personId;this.generation=generation;this.publicKey=publicKey;}
 get canSign(){return !!this.key;}
 static async open(store:LocalStore,post:BrowserPost,personId:string,origin:string,code?:string):Promise<BrowserAccountKey>{
  const info=await post('/console/device/identity',{op:'identity_read'}),generation=z.number().int().nonnegative().parse(info.generation);
  const record=info.accountKey?accountKeyRecordSchema.parse(info.accountKey):undefined,local=await store.read('account-key');let key=local?keySchema.parse(JSON.parse(local)):undefined;
  if(key&&key.publicKey!==record?.identity.publicKey)throw new Error('Account safety number changed. Discard the removed browser and recover again.');
  if(!record||record.identity.generation!==generation){
   if(!code)throw new Error('Use the saved recovery code to finish account key setup');
   key=await generateSigningKey();const next:AccountKeyRecord={identity:{publicKey:key.publicKey,generation},recoveryWrap:await sealAccountKey(key,code,origin,personId)};
   await post('/console/device/identity',{op:'identity_set',record:next,event:await signIdentityEvent(key.privateKey,{personId,generation,accountPublicKey:key.publicKey,action:'account-key-set',...(record?{previousPublicKey:record.identity.publicKey}:{}),at:Date.now()})});
  }else if(!key&&code)key=await recoverAccountKey(record,code,origin,personId);
  if(key)await store.write('account-key',JSON.stringify(key));
  return new BrowserAccountKey(key,personId,generation,key?.publicKey??record!.identity.publicKey);
 }
 async endorse(claim:ConnectionClaim){if(!this.key)throw new Error('Approve this connection in an already trusted browser, or unlock with the account recovery code');if(claim.personId!==this.personId||claim.generation!==this.generation||claim.accountPublicKey!==this.publicKey)throw new Error('Account connection mismatch');return signConnection(this.key.privateKey,connectionClaim(claim));}
 async event(action:IdentityEvent['action'],connectionId?:string){if(!this.key)throw new Error('An already trusted browser or recovery code is required');return signIdentityEvent(this.key.privateKey,{personId:this.personId,generation:this.generation,accountPublicKey:this.publicKey,action,...(connectionId?{connectionId}:{}),at:Date.now()});}
}
