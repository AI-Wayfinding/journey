import type {Account} from './accounts.ts';
import type {KeyValueStorage} from './storage.ts';
import type {PasskeyOperation} from './console/contract.ts';
import {Refused,type ToolData} from './commands.ts';
import {cell,personalGroupRule,bindingRule} from './rules.ts';
import {stepCard} from './agents.ts';
import {accountKeyRecordSchema,connectionClaim,verifyValue,verifyConnection,verifyDeviceBinding,verifyIdentityEvent,requestFingerprint,safetyNumber,type ConnectionClaim,type ConnectionCertificate,type IdentityEvent} from '../../shared/account-identity.ts';

const check=(condition:unknown,message:string)=>{if(!condition)throw new Refused(message);};
export function activeIdentity(account:Account){const key=account.accountKey;check(key&&key.identity.generation===(account.recovery?.generation??0),'Set up or recover your account key in a trusted browser');return key!;}
export function appendIdentityEvent(account:Account,event:IdentityEvent){const events=account.identityEvents??=[];check(events.length<4096,'Account identity log capacity reached');events.push(event);}
async function checkEvent(account:Account,event:IdentityEvent,action:IdentityEvent['action'],connectionId?:string){const key=activeIdentity(account);check(event.personId===account.personId&&event.generation===key.identity.generation&&event.accountPublicKey===key.identity.publicKey&&event.action===action&&event.connectionId===connectionId&&await verifyIdentityEvent(event),'Account identity event signature mismatch');}
export async function requireConnection(account:Account,certificate:ConnectionCertificate){
 const key=activeIdentity(account),cert=await verifyConnection(certificate);
 check(cert.personId===account.personId&&cert.accountPublicKey===key.identity.publicKey&&cert.generation===key.identity.generation,'Account connection generation/key mismatch');
 const connection=account.connections?.find(c=>c.claim.connectionId===cert.connectionId);
 check(connection?.certificate&&!connection.revokedAt&&JSON.stringify(connection.certificate)===JSON.stringify(cert),'Connection is not signed or was revoked');
 return connection!;
}
export async function connectionRequest(account:Account,agentId:string|undefined,claim:ConnectionClaim,proof:string,certificate:ConnectionCertificate|undefined,event:IdentityEvent|undefined,now:number):Promise<ToolData>{
 const key=activeIdentity(account);
 check(claim.personId===account.personId&&claim.agentId===agentId&&claim.accountPublicKey===key.identity.publicKey&&claim.generation===key.identity.generation,'Authenticated connection claim mismatch');
 check(await verifyValue(claim.verificationKey,proof,'wayfinding-connection-request-1',connectionClaim(claim)),'Connection possession proof refused');
 const connections=account.connections??=[];let connection=connections.find(c=>c.claim.connectionId===claim.connectionId);
 if(connection){check(!connection.revokedAt&&JSON.stringify(connection.claim)===JSON.stringify(connectionClaim(claim)),'Connection revoked or request changed');}
 else {check(connections.length<128&&connections.filter(c=>!c.certificate&&c.createdAt>now-600000).length<16,'Connection capacity reached');connection={claim:connectionClaim(claim),createdAt:now};connections.push(connection);}
 if(certificate&&!connection.certificate){
  check(JSON.stringify(connectionClaim(certificate))===JSON.stringify(connection.claim),'Connection certificate mismatch');await verifyConnection(certificate);
  check(certificate.accountPublicKey===key.identity.publicKey,'Account key changed');
  check(event,'Signed connection log entry required');await checkEvent(account,event!,'connection-added',claim.connectionId);
  connection.certificate=certificate;appendIdentityEvent(account,event!);
 }
 return connection.certificate?{certificate:connection.certificate}:{pending:true,connectionId:claim.connectionId,fingerprint:await requestFingerprint(claim)};
}
export async function removeConnection(account:Account,storage:KeyValueStorage,connectionId:string,now:number){
 const connection=account.connections?.find(c=>c.claim.connectionId===connectionId);check(connection&&!connection.revokedAt,'Owned live connection required');connection!.revokedAt=now;
 for(const [i,identity] of account.identities.entries()){
  const raw=await storage.get(`sealed:device:${identity.id}`);if(typeof raw!=='string')continue;
  const stored:unknown=JSON.parse(raw);if(!stored||typeof stored!=='object'||!('credential'in stored))continue;
  const cert=await verifyDeviceBinding(stored);if(cert.connectionId===connectionId&&cell(account.group,'Members',i+2)!==0)account.group=personalGroupRule(1).step(account.group,{op:1,subject:i+2,kind:0,belongsTo:1});
 }
 if(connection!.claim.agentId){const i=account.agents.findIndex(a=>a.id===connection!.claim.agentId);if(i>=0){const agent=account.agents[i]!;agent.live=false;agent.card=stepCard(agent.card,'withdraw');account.bindings=bindingRule.step(account.bindings,{op:2,client:0,agent:i+2,personAsserted:0,agentIsOwnLive:0,personLive:+account.live,boundAgentLive:0});}}
}
export async function manageIdentity(account:Account,storage:KeyValueStorage,operation:PasskeyOperation,now:number):Promise<ToolData|undefined>{
 if(operation.op==='identity_read')return {accountKey:account.accountKey??null,generation:account.recovery?.generation??0,connections:account.connections??[],events:account.identityEvents??[],safetyNumber:account.accountKey?await safetyNumber(account.accountKey.identity.publicKey):null};
 if(operation.op==='identity_set'){
  const record=accountKeyRecordSchema.parse(operation.record),generation=account.recovery?.generation??0;
  check(account.passkeys.length&&record.identity.generation===generation&&!account.onboarding?.complete,'A first passkey/browser setup is required for the account key');
  check(!account.accountKey||account.accountKey.identity.generation<generation,'Account key already set; recover it instead');
  check(!account.accountKey||account.accountKey.identity.publicKey!==record.identity.publicKey,'No-code recovery requires a different account key');
  const event=operation.event;
  check(event.personId===account.personId&&event.generation===generation&&event.accountPublicKey===record.identity.publicKey&&event.action==='account-key-set'&&event.connectionId===undefined&&event.previousPublicKey===account.accountKey?.identity.publicKey&&await verifyIdentityEvent(event),'Account key initialization signature mismatch');
  account.accountKey=record;appendIdentityEvent(account,event);return {accountKey:record};
 }
 if(operation.op==='connection_approve'){
  const cert=await verifyConnection(operation.certificate),key=activeIdentity(account),connection=account.connections?.find(c=>c.claim.connectionId===cert.connectionId);
  check(connection&&!connection.revokedAt&&connection.createdAt>now-600000,'Live pending connection required');
  check(cert.accountPublicKey===key.identity.publicKey&&cert.generation===key.identity.generation&&JSON.stringify(connectionClaim(cert))===JSON.stringify(connection!.claim),'Exact pending connection required');
  await checkEvent(account,operation.event,'connection-added',cert.connectionId);
  if(!connection!.certificate){connection!.certificate=cert;appendIdentityEvent(account,operation.event);}return {certificate:cert};
 }
 if(operation.op==='connection_remove'){
  await checkEvent(account,operation.event,'connection-removed',operation.connectionId);await removeConnection(account,storage,operation.connectionId,now);appendIdentityEvent(account,operation.event);return {removed:true};
 }
 return undefined;
}
