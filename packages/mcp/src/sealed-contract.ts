import * as z from 'zod';
import { sealedDescriptor, sealedOfferDefinition } from './sealed-descriptors.ts';
import { admissionSchema, journeySettingsSchema } from './offers.ts';
import { decodeBytes } from './relay.ts';
import { Refused } from './errors.ts';

export const SEALED_FORMAT = 'application/vnd.wayfinding.sealed+json;v=1' as const;
export const SEALED_NOTICE = 'sealed — open in your client';
export const SEALED_LIMITS = Object.freeze({ blob: 10 * 1024 * 1024, envelope: 1024 * 1024, package: 64 * 1024, messages: 4096, bytes: 32 * 1024 * 1024, pageBytes: 4 * 1024 * 1024, page: 100, pending: 600_000, checkpoint: 30 * 86400_000 });
export const sid = z.string().min(1).max(200);
export const snat = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const sealedEnvelope = z.object({ groupId: sid, epoch: snat, ciphertext: z.string().min(4).max(4 * Math.ceil(SEALED_LIMITS.envelope / 3)), contentType: z.literal(SEALED_FORMAT), size: snat.min(1).max(SEALED_LIMITS.envelope) }).strict();
export type SealedEnvelope = z.infer<typeof sealedEnvelope>;
export function envelopeBytes(value: unknown, groupId: string, epoch: number): Uint8Array {
  const envelope = sealedEnvelope.parse(value);
  if (envelope.groupId !== groupId) throw new Refused('Sealed audience mismatch');
  if (envelope.epoch !== epoch) throw new Refused('Sealed epoch mismatch; synchronize before retry');
  const bytes = decodeBytes(envelope.ciphertext, SEALED_LIMITS.envelope);
  if (bytes.length !== envelope.size) throw new Refused('Sealed ciphertext size mismatch');
  return bytes;
}
const target = z.union([z.object({projectId:sid}).strict(),z.object({itemId:sid}).strict(),z.object({roundId:sid}).strict(),z.object({taskId:sid}).strict()]);
const item = { itemId: sid };
const round = { roundId: sid };
// Each action copies only named coordination fields. All descriptive values live inside MLS.
export const sealedRouting = {
  journey_descriptor: z.object({}).strict(),
  task_create:z.object({taskId:sid,maxRounds:snat.min(1),deadline:snat.max(8_640_000_000_000_000)}).strict(),
  task_exchange:z.object({taskId:sid,action:z.enum(['claim','startRound','endRound','finish','cancel','expire','approve','decline','askInput','answer','fail']),standing:z.enum(['always_allow','always_deny']).optional()}).strict(),
  identity_descriptor:z.object({kind:z.enum(['profile','card']),agentId:sid.optional(),contentRevision:snat.min(1),private:z.boolean()}).strict().refine(v=>(v.kind==='card')===(v.agentId!==undefined)),
  offer_definition: z.object({agentId:sid,offerId:sid,contentRevision:snat.min(1),private:z.boolean()}).strict(),
  project_create: z.object({}).strict(),
  project_update: z.object({projectId:sid,status:z.enum(['gettingStarted','active','lookingForOthers','archived']).optional()}).strict(),
  board_create: z.object({}).strict(),
  board_update: z.object({boardId:sid,archived:z.boolean().optional()}).strict(),
  topic_create: z.object({boardId:sid}).strict(),
  post_create: z.object({topicId:sid,replyTo:sid.optional()}).strict(),
  post_edit: z.object({postId:sid}).strict(),
  conversation_post: z.object({target,replyTo:sid.optional()}).strict(),
  library_add: z.object({visibility:z.enum(['members','private']).default('members'),projectId:sid.optional()}).strict(),
  library_version: z.object({...item,baseVersion:snat.min(1)}).strict(),
  library_update: z.object({...item,projectId:sid.nullable().optional(),visibility:z.enum(['members','private']).optional()}).strict(),
  artifact_create: z.object({}).strict(),
  artifact_version: z.object({artifactId:sid,baseVersion:snat.min(1)}).strict(),
  artifact_rename: z.object({artifactId:sid}).strict(),
  round_create: z.object({participants:z.array(sid).max(1024).optional(),guidanceItemId:sid.optional(),documentItemId:sid.optional(),relatedItemIds:z.array(sid).max(128).optional()}).strict(),
  round_next: z.object(round).strict(),
  interview_write: z.object(round).strict(),
  interview_share: z.object(round).strict(),
  round_contribute: z.object(round).strict(),
} as const;
export type SealedAction = keyof typeof sealedRouting;
export const sealedAction = z.enum(Object.keys(sealedRouting) as [SealedAction,...SealedAction[]]);
export const sealedRoute = z.record(z.string(),z.unknown());
export function parseSealedRouting(action:SealedAction,input:unknown):Record<string,unknown> { return sealedRouting[action].parse(input); }
const ctx = {journeyId:sid};
const ticket = z.object({...ctx,ticketId:sid,devices:z.record(z.string(),sid),envelopes:z.record(z.string(),sealedEnvelope)}).strict();
export const contentContext=z.object({format:z.literal(SEALED_FORMAT),groupId:sid,parentId:sid,recordId:sid,recordType:sid,revision:snat.min(1),operationId:sid,authorId:sid,epoch:snat}).strict();
export type ContentContext=z.infer<typeof contentContext>;
export const sealedInputs: Record<string,z.ZodObject> = {
  agent_create:z.object({}).strict(),
  account_update:z.object({sealed:sealedDescriptor}).strict(),
  agent_descriptor_set:z.object({agentId:sid,sealed:sealedDescriptor}).strict(),
  task_prepare:z.object({journeyId:sid,assignee:sid.optional(),agentId:sid.optional(),offerId:sid.optional()}).strict(),
  task_claim_prepare:z.object({journeyId:sid,taskId:sid}).strict(),
  task_step:ticket,
  task_read:z.object({journeyId:sid,taskId:sid}).strict(),
  sealed_record_read:z.object({journeyId:sid,recordId:sid,revision:snat.min(1)}).strict(),
  offer_set:z.object({agentId:sid,offer:z.object({id:sid,sealed:sealedOfferDefinition,journeySettings:journeySettingsSchema,admission:admissionSchema}).strict(),expectedVersion:snat.min(1).optional()}).strict(),
  offer_search:z.object({journeyId:sid}).strict(),
  journey_create:z.object({policy:z.enum(['request','open','invite']).default('request'),defaultRole:z.enum(['read','write']).default('read')}).strict(),
  sealed_catalog:z.object({...ctx,cursor:snat.default(0)}).strict(),
  ...Object.fromEntries(Object.keys(sealedRouting).map(name=>[name,ticket])),
  content_prepare:z.object({...ctx,action:sealedAction,routing:sealedRoute}).strict(),
  content_status:z.object({...ctx,ticketId:sid}).strict(),
  content_abandon:z.object({...ctx,ticketId:sid}).strict(),
  sealed_blob_put:z.object({...ctx,ticketId:sid,slot:sid,data:z.string().min(4).max(4*Math.ceil(SEALED_LIMITS.blob/3))}).strict(),
  sealed_blob_get:z.object({...ctx,recordId:sid,revision:snat.min(1),blob:sid}).strict(),
  sealed_group:z.object({...ctx,groupId:sid}).strict(),
  sealed_group_commit:z.object({...ctx,groupId:sid,deviceId:sid,expectedSequence:snat,expectedEpoch:snat,action:z.enum(['bootstrap','add','remove','update']),targetDeviceId:sid.optional(),data:z.string().min(4).max(4*Math.ceil(SEALED_LIMITS.envelope/3))}).strict(),
  sealed_group_fetch:z.object({...ctx,groupId:sid,deviceId:sid,since:snat.default(0),limit:snat.min(1).max(100).default(100)}).strict(),
  sealed_device_register:z.object({deviceId:sid,verificationKey:z.string().min(4).max(200),data:z.string().min(4).max(4*Math.ceil(SEALED_LIMITS.package/3))}).strict(),
  sealed_device_binding:z.object({deviceId:sid}).strict(),
  sealed_package_reserve:z.object({...ctx,groupId:sid,deviceId:sid}).strict(),
  sealed_history_post:z.object({...ctx,groupId:sid,deviceId:sid,contexts:z.array(contentContext).min(1).max(100),envelope:sealedEnvelope}).strict(),
  round_status:z.object({...ctx,...round,to:z.enum(['planned','open','synthesising','closed'])}).strict(),
  round_participants:z.object({...ctx,...round,add:z.array(sid).max(128).default([]),remove:z.array(sid).max(128).default([])}).strict(),
  post_hide:z.object({...ctx,postId:sid}).strict(),post_unhide:z.object({...ctx,postId:sid}).strict(),
  topic_lock:z.object({...ctx,topicId:sid}).strict(),topic_unlock:z.object({...ctx,topicId:sid}).strict(),
  project_join:z.object({...ctx,projectId:sid}).strict(),project_leave:z.object({...ctx,projectId:sid}).strict(),
  forum_boards:z.object(ctx).strict(), topic_list:z.object({...ctx,boardId:sid.optional(),attachedTo:target.optional(),cursor:snat.default(0)}).strict(),
  topic_read:z.object({...ctx,topicId:sid,cursor:snat.default(0)}).strict(),
  conversation_read:z.object({...ctx,target,cursor:snat.default(0)}).strict(),
  library_get:z.object({...ctx,...item,version:snat.min(1).optional()}).strict(),
  library_search:z.object({...ctx,projectId:sid.optional(),includeProjects:z.boolean().default(false),cursor:snat.default(0)}).strict(),
  library_delete:z.object({...ctx,...item}).strict(),
  round_list:z.object({...ctx,cursor:snat.default(0)}).strict(),round_read:z.object({...ctx,...round,cursor:snat.default(0)}).strict(),
  interview_read:z.object({...ctx,...round,personId:sid.optional()}).strict(),
  interview_assign:z.object({...ctx,...round,personId:sid,itemId:sid,version:snat.min(1)}).strict(),
};
export const bindingSchema=z.object({deviceId:sid,personId:sid,agentId:sid.optional(),verificationKey:z.string().max(200),data:z.string(),hash:sid,createdAt:snat}).strict();
export type DeviceBinding=z.infer<typeof bindingSchema>;
export const contentSlot=z.object({key:sid,context:contentContext,source:contentContext.optional()}).strict();
export const preparedContent=z.object({ticketId:sid,expiresAt:snat,slots:z.array(contentSlot).max(100),routing:sealedRoute}).strict();
export type PreparedContent=z.infer<typeof preparedContent>;
export function requireSynthetic(mode: 'synthetic'|'real'):void { if(mode!=='synthetic')throw new Refused('Real-data mode refused: independent security review, rule review and MLS audit are launch blockers'); }
