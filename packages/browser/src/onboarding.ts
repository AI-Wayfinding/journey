import {assertion} from './webauthn.ts';
import {recoveryAuthorization,deriveRecoveryKey,unwrap} from './vault.ts';
import {decode} from '../../proxy/src/codec.ts';
import type {VaultRecord} from './store.ts';
import type {BrowserPost} from './remote.ts';
export async function finishOnboarding(post:BrowserPost,input:{code:string;confirmation:string;browserId:string;origin:string;personId:string},record?:Pick<VaultRecord,'context'|'salt'|'recoveryWrap'>,confirm:typeof assertion=assertion):Promise<void>{
 const normalize=(s:string)=>s.replaceAll('-','').replaceAll(' ','').toUpperCase();
 if(normalize(input.code)!==normalize(input.confirmation))throw new Error('Retype your saved recovery code to continue');
 if(record){
  if(record.context.deviceId!==input.browserId||record.context.origin!==input.origin||record.context.personId!==input.personId)throw new Error('Connection identity changed');
  const raw=decode(await unwrap(record.recoveryWrap,await deriveRecoveryKey(input.code,decode(record.salt),record.context),record.context));
  const valid=raw.length===32;raw.fill(0);if(!valid)throw new Error('Invalid private key wrapper');
 }
 const recoveryProof=await recoveryAuthorization(input.code,input.origin,input.personId);
 const fields={browserId:input.browserId,recoveryProof},options=await post('/console/setup/options',fields);
 await post('/console/setup/complete',{...fields,assertion:(await confirm(options)).assertion});
}
