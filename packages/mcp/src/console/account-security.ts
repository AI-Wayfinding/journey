import type { Account } from '../accounts.ts';
import type { KeyValueStorage } from '../storage.ts';
import type { ClientIdentity, PasskeyVerifier } from '../agents.ts';
import { assertionSchema } from '../agents.ts';
import { Refused, type ToolData } from '../commands.ts';
import { randomToken, tokenHash } from '../oauth-store.ts';
import type { PasskeyOperation } from './contract.ts';
import { personalGroupRule, cell, bindingRule } from '../rules.ts';
import { stepCard } from '../agents.ts';

/** Called only inside the Accounts serial turn, after resolving the live person. */
export async function accountSecurity(account: Account, _accounts: Account[], storage: KeyValueStorage, verifier: PasskeyVerifier, identity: ClientIdentity, operation: PasskeyOperation, now: number): Promise<ToolData | undefined> {
 const complete=account.onboarding?.complete??Boolean(account.passkeys.length&&(account.browsers??[]).length);
 if(operation.op==='setup_status')return {complete,readyAt:account.recovery?.readyAt??null,recoveredAt:account.recovery?.recoveredAt??null,personId:account.personId};
 if(operation.op==='recovery_start') {
  if(account.recovery?.readyAt!==undefined)return {readyAt:account.recovery.readyAt};
  for(const [i,agent] of account.agents.entries()) {
   agent.live=false;agent.card=stepCard(agent.card,'withdraw');
   account.bindings=bindingRule.step(account.bindings,{op:2,client:0,agent:i+2,personAsserted:0,agentIsOwnLive:0,personLive:1,boundAgentLive:0});
  }
  for(const [i] of account.identities.entries())if(cell(account.group,'Members',i+2)!==0)account.group=personalGroupRule(1).step(account.group,{op:1,subject:i+2,kind:0,belongsTo:1});
  account.browsers=[];account.passkeys=[];account.assertions=[];account.onboarding={complete:false};
  delete account.descriptor; // No surviving keys: a fresh P workspace, never a ratchet rollback.
  account.recovery={generation:(account.recovery?.generation??0)+1,startedAt:now,readyAt:now+259200000};
  await storage.put(`passkey-registration:${account.personId}`,'null');
  return {readyAt:account.recovery.readyAt};
 }
 if(account.recovery?.readyAt!==undefined&&account.recovery.readyAt>now&&!['list','browser_list'].includes(operation.op))throw new Refused('Account recovery requires the full 72 hours');
 if(operation.op==='delete'&&account.passkeys.length===1&&account.passkeys[0]!.id===operation.id)throw new Refused('Keep your last passkey; use account recovery to remove all connections');
 if(operation.op==='setup_complete') {
  const browser=account.browsers?.find(b=>b.id===operation.browserId&&account.passkeys.some(k=>k.id===b.credentialId));
  if(!browser||!browser.devices.length||(!account.descriptor || account.descriptor.contentRevision < 2))throw new Refused('Set your name and create a trusted browser connection first');
  if(complete)throw new Refused('Onboarding already complete');
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
  if(operation.recoveryProof && account.recovery?.verifier===await tokenHash(operation.recoveryProof))return undefined;
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
