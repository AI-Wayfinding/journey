import * as z from 'zod';
const sid = z.string().min(1).max(200);
const snat = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// Immutable references identify ciphertext held by the audience's Journey host.
export const definitionRef = z.object({ journeyId: sid, recordId: sid, revision: snat.min(1) }).strict();
export type DefinitionRef = z.infer<typeof definitionRef>;
export const sealedOfferDefinition = z.object({
  privateDefinition: definitionRef,
  publications: z.record(sid, definitionRef).refine(v => Object.keys(v).length <= 128),
  contentRevision: snat.min(1),
}).strict();
export type SealedOfferDefinition = z.infer<typeof sealedOfferDefinition>;
export const sealedDescriptor = sealedOfferDefinition;
export type SealedDescriptor = z.infer<typeof sealedDescriptor>;
const label = z.string().max(4096);
export const privateProfile = z.object({name:label,nickname:label.optional(),email:z.email().max(320).optional(),deviceLabels:z.record(sid,label).optional(),passkeyLabels:z.record(sid,label).optional()}).strict();
export const publicProfile = z.object({nickname:label}).strict();
export const cardDescriptor = z.object({name:label,clientName:label.optional()}).strict();
