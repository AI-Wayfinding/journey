import type { DeviceBinding } from './sealed-contract.ts';
import type { DefinitionRef } from './sealed-descriptors.ts';
import type { OfferPort } from './offers.ts';
import { cell } from './rules.ts';
import { capabilities } from '../../rules/src/capabilities.ts';

export interface TaskAudience {
 taskId:string; requester:string; requesterPerson:string; assignee?:string; owner?:string;
 agentId?:string; offerId?:string; version?:number; definition?:DefinitionRef; claimant?:string;
}
export async function taskDevice(a:TaskAudience,b:DeviceBinding,offers?:OfferPort):Promise<boolean>{
 const actor=b.agentId??b.personId;
 if(actor===a.requester||!b.agentId&&b.personId===a.requesterPerson||actor===a.assignee||actor===a.claimant||!b.agentId&&b.personId===a.owner)return true;
 if(b.personId!==a.owner||!b.agentId)return false;
 const agent=(await offers?.directory())?.find(g=>g.id===b.agentId&&g.owner===a.owner);
 return !!agent&&cell(agent.card,'Caps',capabilities.find(c=>c.name==='offer.decide')!.id)===1;
}
