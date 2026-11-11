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
