import * as z from 'zod';
import { Refused } from './errors.ts';
import { definitionRef, sealedOfferDefinition, type DefinitionRef } from './sealed-descriptors.ts';
import { contentContext, SEALED_NOTICE } from './sealed-contract.ts';
import { offerDefinitionSchema, presetPolicy } from './offers.ts';
import type { ToolData } from './commands.ts';

export async function verifyDefinition(ref: DefinitionRef, owner: string, agentId: string, offerId: string, revision: number, privateSource: boolean, read: (ref: DefinitionRef) => Promise<ToolData>): Promise<void> {
  const r = z.object({type:z.literal('offer'),owner:z.literal(owner),parentId:z.literal(agentId),target:z.object({agentId:z.literal(agentId),offerId:z.literal(offerId)}),content:z.array(z.object({context:contentContext}))}).parse(await read(ref));
  const expected = privateSource ? `private_${ref.journeyId.slice(8)}_${owner}` : ref.journeyId;
  if (ref.revision !== revision || r.content.length !== 1 || r.content[0]!.context.groupId !== expected || r.content[0]!.context.revision !== revision) throw new Refused('Offer publication audience or revision mismatch');
}
export function internalDefinition(id:string, value:unknown, journeys:unknown, admission:unknown) {
  return offerDefinitionSchema.parse({id,name:SEALED_NOTICE,description:'',tags:[],examples:[],inputSchema:{type:'object'},sealed:sealedOfferDefinition.parse(value),journeySettings:journeys,admission:admission??presetPolicy('Members')});
}
export const parseDefinitionRef = (value:unknown) => definitionRef.parse(value);
