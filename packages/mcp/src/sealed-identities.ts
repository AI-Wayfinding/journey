import * as z from 'zod';
import {Refused} from './errors.ts';
import type {DefinitionRef} from './sealed-descriptors.ts';
import {contentContext} from './sealed-contract.ts';
import type {ToolData} from './commands.ts';

export async function verifyDescriptor(ref:DefinitionRef,owner:string,agentId:string|undefined,revision:number,privateSource:boolean,read:(ref:DefinitionRef)=>Promise<ToolData>):Promise<void>{
 const r=z.object({type:z.literal(agentId?'card':'profile'),owner:z.literal(owner),parentId:z.literal(agentId??owner),target:z.object({personId:z.literal(owner),agentId:agentId?z.literal(agentId):z.undefined().optional()}).strict(),content:z.array(z.object({context:contentContext}))}).parse(await read(ref));
 const groupId=privateSource?`private_${ref.journeyId.slice(8)}_${owner}`:ref.journeyId;
 if(ref.revision!==revision||r.content.length!==1||r.content[0]!.context.groupId!==groupId||r.content[0]!.context.revision!==revision)throw new Refused('Descriptor audience or revision mismatch');
}
