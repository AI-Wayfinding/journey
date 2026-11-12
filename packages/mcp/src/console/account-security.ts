import type { Account } from '../accounts.ts';
import type { KeyValueStorage } from '../storage.ts';
import type { ClientIdentity, PasskeyVerifier } from '../agents.ts';
import { assertionSchema } from '../agents.ts';
import { Refused, type ToolData } from '../commands.ts';
import { randomToken, tokenHash } from '../oauth-store.ts';
import type { PasskeyOperation } from './contract.ts';
import { personalGroupRule, cell, bindingRule } from '../rules.ts';
import { stepCard } from '../agents.ts';

/** Keep the secret-hash comparison inside Web Crypto's native HMAC verification. */
async function recoveryMatches(expected:string,proof:string):Promise<boolean>{
 const bytes=new TextEncoder(),key=await crypto.subtle.importKey('raw',bytes.encode(expected),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
 const mac=await crypto.subtle.sign('HMAC',key,bytes.encode(expected));
 return crypto.subtle.verify('HMAC',key,mac,bytes.encode(await tokenHash(proof)));
}
export const onboardingComplete=(account:Account):boolean=>account.onboarding?.complete??Boolean(account.passkeys.length&&(account.browsers??[]).length);
/** Called only inside the Accounts serial turn, after resolving the live person. */
export async function accountSecurity(account: Account, _accounts: Account[], storage: KeyValueStorage, verifier: PasskeyVerifier, identity: ClientIdentity, operation: PasskeyOperation, now: number): Promise<ToolData | undefined> {
 const complete=onboardingComplete(account);
 if(operation.op==='setup_status')return {complete,readyAt:account.recovery?.readyAt??null,recoveredAt:account.recovery?.recoveredAt??null,personId:account.personId};
 if(operation.op==='recovery_start') {
  if(identity.signedInAt===undefined||!Number.isFinite(identity.signedInAt)||identity.signedInAt>now||now-identity.signedInAt>600000)throw new Refused('A fresh sign-in is required to start recovery');
  if(account.recovery?.readyAt!==undefined)return {readyAt:account.recovery.readyAt};
  for(const [i,agent] of account.agents.entries()) {
   agent.live=false;agent.card=stepCard(agent.card,'withdraw');
   account.bindings=bindingRule.step(account.bindings,{op:2,client:0,agent:i+2,personAsserted:0,agentIsOwnLive:0,personLive:1,boundAgentLive:0});
  }
  for(const [i] of account.identities.entries())if(cell(account.group,'Members',i+2)!==0)account.group=personalGroupRule(1).step(account.group,{op:1,subject:i+2,kind:0,belongsTo:1});
  for(const connection of account.connections??[])if(!connection.revokedAt){connection.revokedAt=now;const key=account.accountKey;if(key)(account.identityEvents??=[]).push({personId:account.personId,generation:key.identity.generation,accountPublicKey:key.identity.publicKey,action:'connection-removed',connectionId:connection.claim.connectionId,at:now});}
  account.browsers=[];account.passkeys=[];account.assertions=[];account.onboarding={complete:false};
  delete account.descriptor; // No surviving keys: a fresh P workspace, never a ratchet rollback.
  account.recovery={generation:(account.recovery?.generation??0)+1,startedAt:now,readyAt:now+259200000};
  await storage.put(`passkey-registration:${account.personId}`,'null');
  return {readyAt:account.recovery.readyAt};
 }
 if(account.recovery?.readyAt!==undefined&&!['list','browser_list'].includes(operation.op)){
  if(account.recovery.readyAt>now)throw new Refused('Account recovery requires the full 72 hours');
  if(identity.signedInAt===undefined||!Number.isFinite(identity.signedInAt)||identity.signedInAt<account.recovery.readyAt||identity.signedInAt>now)throw new Refused('Sign in again after the recovery deadline');
 }
 if(operation.op==='delete'&&account.passkeys.length===1&&account.passkeys[0]!.id===operation.id)throw new Refused('Keep your last passkey; use account recovery to remove all connections');
 if(operation.op==='setup_options'||operation.op==='setup_complete') {
  const browser=account.browsers?.find(b=>b.id===operation.browserId&&account.passkeys.some(k=>k.id===b.credentialId));
  const live=(id:string)=>{const i=account.identities.findIndex(d=>d.id===id);return i>=0&&cell(account.group,'Members',i+2)!==0;};
  if(!browser||!browser.devices.some(live)||(!account.descriptor || account.descriptor.contentRevision < 2))throw new Refused('Set your name and create a trusted browser connection first');
  if(complete)throw new Refused('Onboarding already complete');
  const digest=await tokenHash(JSON.stringify(['setup-complete-1',account.personId,identity.clientId,operation.browserId,await tokenHash(operation.recoveryProof)]));
  if(operation.op==='setup_options') {
   const challenge=randomToken();account.assertions=account.assertions.filter(p=>p.digest!==digest&&p.expiresAt>now);
   account.assertions.push({digest,challenge,expiresAt:now+300000});
   return {challenge,rpId:'poc.wayfinding.support',userVerification:'required',allowCredentials:[{type:'public-key',id:browser.credentialId}],timeout:60000};
  }
  const pending=account.assertions.find(p=>p.digest===digest&&p.expiresAt>now);
  if(!pending||!operation.assertion)throw new Refused('Fresh wrapping passkey assertion required to confirm recovery code');
  const proof=await verifier.verify(assertionSchema.parse(operation.assertion),pending.challenge,account.passkeys);
  if(proof.credentialId!==browser.credentialId)throw new Refused('Wrapping passkey required');
  const credential=account.passkeys.find(k=>k.id===proof.credentialId)!;credential.counter=proof.counter;credential.lastUsedAt=now;
  account.assertions=account.assertions.filter(p=>p!==pending);
  const recovery=account.recovery??{generation:0};
  recovery.verifier=await tokenHash(operation.recoveryProof);
  if(recovery.readyAt!==undefined){recovery.recoveredAt=now;delete recovery.startedAt;delete recovery.readyAt;}
  account.recovery=recovery;account.onboarding={complete:true};
  return {complete:true};
 }
 const digest=await tokenHash(JSON.stringify(['passkey-add-1',account.personId,identity.clientId]));
 if(operation.op==='addition_options') {
  if(!account.passkeys.length)throw new Refused('Use your recovery code');
  const challenge=randomToken();
  account.assertions=account.assertions.filter(p=>p.digest!==digest&&p.expiresAt>now);
  account.assertions.push({digest,challenge,expiresAt:now+300000});
  return {challenge,rpId:'poc.wayfinding.support',userVerification:'required',allowCredentials:account.passkeys.map(k=>({type:'public-key',id:k.id})),timeout:60000};
 }
 if(operation.op==='begin'&&(account.passkeys.length||account.recovery?.verifier)) {
  if(operation.recoveryProof&&account.recovery?.verifier&&await recoveryMatches(account.recovery.verifier,operation.recoveryProof))return undefined;
  const pending=account.assertions.find(p=>p.digest===digest&&p.expiresAt>now);
  if(!pending||!operation.assertion)throw new Refused('An existing passkey assertion or recovery code is required');
  const proof=await verifier.verify(assertionSchema.parse(operation.assertion),pending.challenge,account.passkeys);
  const key=account.passkeys.find(k=>k.id===proof.credentialId);
  if(!key)throw new Refused('Existing passkey required');
  key.counter=proof.counter;key.lastUsedAt=now;
  account.assertions=account.assertions.filter(p=>p!==pending);
 }
 return undefined;
}
