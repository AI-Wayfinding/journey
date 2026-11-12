import * as z from 'zod';
import type { ConsoleBackend } from './contract.ts';
import { browserBinding } from './contract.ts';
import { assertionSchema, type ClientIdentity } from '../agents.ts';
import { sealedInputs } from '../sealed-contract.ts';
import {passkeyOperation} from './contract.ts';
import { Refused, parseCommand, type ToolData } from '../commands.ts';
const browserId=z.string().uuid();
const enrollment=z.object({csrf:z.string(),browserId,credentialId:z.string().max(2048),device:browserBinding,assertion:assertionSchema.optional()}).strict();
const metadata=new Set(['account_read','agent_list','agent_capabilities','offer_list','offer_settings','offer_journey_set','offer_publish','offer_retire','journey_list','journey_read','personal_group_read','personal_group_remove','tasks_list']);
// SealedClient.open, enrollGroup(personal), account_update and resumed profile reads.
// Personal workspace bootstrap also prepares its General board and private audience.
const setupTools=new Set(['whoami','account_read','account_update','personal_group_read',
 'journey_create','journey_descriptor','board_create','identity_descriptor',
 'content_prepare','content_status','content_abandon','sealed_blob_put','sealed_blob_get',
 'sealed_record_read','sealed_group','sealed_group_commit','sealed_group_fetch',
 'sealed_connection_request','sealed_device_binding','sealed_package_reserve','sealed_history_post']);
function setupTool(tool:string,input:Record<string,unknown>):boolean {
 if(!setupTools.has(tool))return false;
 if(tool==='journey_create')return input.policy==='invite'&&input.defaultRole==='read';
 if(tool==='content_prepare')return ['journey_descriptor','board_create'].includes(String(input.action))||input.action==='library_add'&&z.object({visibility:z.literal('private')}).strict().safeParse(input.routing).success||input.action==='identity_descriptor'&&z.object({kind:z.literal('profile'),contentRevision:z.number(),private:z.literal(true)}).strict().safeParse(input.routing).success;
 const publications=z.object({sealed:z.object({publications:z.record(z.string(),z.unknown())})}).safeParse(input);
 if(tool==='account_update')return !publications.success||Object.keys(publications.data.sealed.publications).length===0;
 return true;
}
export async function browserPost(backend:ConsoleBackend,identity:ClientIdentity,path:string,body:Record<string,unknown>,now:number=Date.now()):Promise<ToolData>{
  if(!backend.sealedMode||!backend.sealedExecute||!backend.whoami)throw new Refused('Browser sealed generation required');
  if(path==='/console/device/identity'){const operation=passkeyOperation.parse(Object.fromEntries(Object.entries(body).filter(([k])=>k!=='csrf')));if(!['identity_read','identity_set','connection_approve','connection_remove'].includes(operation.op))throw new Refused('Identity operation required');return backend.passkey(identity,operation);}
  const setup=await backend.passkey(identity,{op:'setup_status'});
  if(!setup.complete&&(!['/console/device/identity','/console/device/info','/console/device/enroll/options','/console/device/enroll/finish','/console/device/call'].includes(path)||typeof setup.readyAt==='number'&&(setup.readyAt>now||identity.signedInAt===undefined||identity.signedInAt<setup.readyAt)))throw new Refused('Complete onboarding before using browser controls');
  if(path==='/console/device/info'){
    z.object({csrf:z.string()}).strict().parse(body);
    const account=await backend.execute(identity.subject,parseCommand('account_read',{}),identity.clientId);
    const passkeys=await backend.passkey(identity,{op:'list'}),browsers=await backend.passkey(identity,{op:'browser_list'});
    return {personId:account.personId,personalGroupId:account.personalGroupId,accountKey:account.accountKey,passkeys:passkeys.passkeys,browsers:browsers.browsers};
  }
  if(path==='/console/device/enroll/options'||path==='/console/device/enroll/finish'){
    const fields=enrollment.parse(body),binding={browserId:fields.browserId,credentialId:fields.credentialId,device:fields.device};
    return backend.passkey(identity,path.endsWith('/options')?{op:'browser_begin',...binding}:{op:'browser_finish',...binding,assertion:assertionSchema.parse(fields.assertion)});
  }
  if(path==='/console/device/revoke'){
    const input=z.object({csrf:z.string(),browserId}).strict().parse(body),listed=await backend.passkey(identity,{op:'browser_list'});
    const own=z.array(z.object({id:browserId,devices:z.array(z.string())})).parse(listed.browsers).find(b=>b.id===input.browserId);
    if(!own)throw new Refused('Owned browser required');
    const live=z.array(z.object({id:z.string()})).parse((await backend.execute(identity.subject,parseCommand('personal_group_read',{}),identity.clientId)).members);
    let pending=false;for(const memberId of own.devices.filter(d=>live.some(m=>m.id===d))){const result=await backend.execute(identity.subject,parseCommand('personal_group_remove',{memberId}),identity.clientId);if(result.revocation)pending=true;}
    return {revoked:!pending,revocation:pending?'pending':'complete'};
  }
  if(path!=='/console/device/call')throw new Refused('Unknown browser route');
  const input=z.object({csrf:z.string(),browserId,tool:z.string().min(1).max(100),input:z.record(z.string(),z.unknown())}).strict().parse(body);
  if(!setup.complete&&!setupTool(input.tool,input.input))throw new Refused('Only setup tools are allowed before onboarding completes');
  if(input.tool==='sealed_device_register')throw new Refused('Fresh passkey enrollment required');
  const schema=sealedInputs[input.tool];
  if(schema){
    const wire=z.record(z.string(),z.unknown()).parse(schema.parse(input.input));
    const needsLeaf=(typeof wire.deviceId==='string'&&!['sealed_device_binding','sealed_package_reserve'].includes(input.tool))||wire.devices!==undefined;
    const owned=needsLeaf?z.array(z.string()).parse((await backend.passkey(identity,{op:'browser_check',browserId:input.browserId})).devices):[];
    if(typeof wire.deviceId==='string'&&input.tool!=='sealed_device_binding'&&input.tool!=='sealed_package_reserve'&&!owned.includes(wire.deviceId))throw new Refused('Browser leaf binding required');
    if(wire.devices)for(const device of Object.values(z.record(z.string(),z.string()).parse(wire.devices)))if(!owned.includes(device))throw new Refused('Browser leaf binding required');
    return backend.sealedExecute(identity.subject,input.tool,wire,identity.clientId);
  }
  if(input.tool==='whoami'){z.object({}).strict().parse(input.input);return backend.whoami(identity.subject,identity.clientId);}
  if(!metadata.has(input.tool))throw new Refused('Browser tool not allowed');
  return backend.execute(identity.subject,parseCommand(input.tool,input.input),identity.clientId);
}
