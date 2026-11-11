import * as z from 'zod';
import type { Account } from '../accounts.ts';
import type { KeyValueStorage } from '../storage.ts';
import type { ClientIdentity, PasskeyVerifier } from '../agents.ts';
import { Refused, type ToolData } from '../commands.ts';
import { tokenHash, randomToken } from '../oauth-store.ts';
import { cell } from '../rules.ts';
import { browserBinding, type PasskeyOperation } from './contract.ts';
export type BrowserRegistration = z.infer<typeof browserBinding>;
export async function browserEnrollment(account:Account,storage:KeyValueStorage,verifier:PasskeyVerifier,identity:ClientIdentity,operation:PasskeyOperation,now:number,register:(input:BrowserRegistration)=>Promise<ToolData>):Promise<ToolData>{
  const browsers=account.browsers??=[],live=(id:string)=>{const i=account.identities.findIndex(x=>x.id===id);return i>=0&&cell(account.group,'Members',i+2)!==0;};
  if(operation.op==='browser_list')return {browsers:browsers.map(b=>({id:b.id,credentialId:b.credentialId,devices:b.devices,live:b.devices.some(live)}))};
  if(operation.op==='browser_check'){
    const b=browsers.find(b=>b.id===operation.browserId);
    if(!b||!account.passkeys.some(p=>p.id===b.credentialId)||!b.devices.every(live))throw new Refused('Browser device revoked');
    return {devices:b.devices};
  }
  if(operation.op!=='browser_begin'&&operation.op!=='browser_finish')throw new Refused('Unknown browser operation');
  const {browserId,credentialId,device}=operation;
  if(!account.passkeys.some(c=>c.id===credentialId))throw new Refused('Registered wrapping passkey required');
  const old=browsers.find(b=>b.id===browserId);
  if(old&&(old.credentialId!==credentialId||!old.devices.every(live)))throw new Refused('Browser device revoked or wrapping credential changed');
  if(!old&&browsers.length>=16)throw new Refused('Browser capacity reached');
  const digest=await tokenHash(JSON.stringify(['browser-enroll-1',account.personId,identity.clientId,browserId,credentialId,device.deviceId,device.verificationKey,device.data])),key=`browser-enroll:${account.personId}:${browserId}`;
  if(operation.op==='browser_begin'){
    const challenge=randomToken();await storage.put(key,JSON.stringify({digest,challenge,expiresAt:now+300000}));
    return {challenge,rpId:'poc.wayfinding.support',allowCredentials:[{id:credentialId,type:'public-key'}],userVerification:'required',timeout:60000};
  }
  const raw=await storage.get(key),pending=z.object({digest:z.string(),challenge:z.string(),expiresAt:z.number()}).nullable().parse(typeof raw==='string'?JSON.parse(raw):null);
  if(!pending||pending.digest!==digest||pending.expiresAt<=now)throw new Refused('Fresh exact browser enrollment assertion required');
  const proof=await verifier.verify(operation.assertion,pending.challenge,account.passkeys);
  if(proof.credentialId!==credentialId)throw new Refused('Wrapping passkey mismatch');
  const binding=await register(device);const browser=old??{id:browserId,credentialId,devices:[]};browser.devices.push(device.deviceId);if(!old)browsers.push(browser);account.browsers=browsers;
  const credential=account.passkeys.find(c=>c.id===credentialId)!;credential.counter=proof.counter;credential.lastUsedAt=now;
  await storage.put(key,'null');return binding;
}
