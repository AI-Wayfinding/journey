import * as z from 'zod';
import { forumView } from './forum-contract.ts';
const id = z.string().min(1).max(200), label = z.string().max(4096), nat = z.number().int().nonnegative().safe();
export const kinds = ['markdown', 'html', 'pdf', 'code', 'image', 'video', 'audio', 'data', 'link', 'skill', 'prompt', 'agent', 'applet', 'other'] as const;
// Metadata only. Library text, URLs, blob locations and unknown nested fields are stripped.
export const itemMetadata = z.object({ journeyId: id, itemId: id, name: label, kind: z.enum(kinds), description: label, labels: z.array(label), owner: id, projectId: id.optional(), visibility: z.enum(['members', 'private']), storage: z.enum(['server', 'sealed']), size: nat, version: nat });
export const conversationView = z.object({ topic: forumView.shape.topic.nullable() });
const roundSummary = z.object({ journeyId: id, roundId: id, title: label, goal: label, format: label, facilitator: id, status: z.enum(['planned', 'open', 'synthesising', 'closed']), contributions: nat, conversationId: id });
export const roundDetail = roundSummary.extend({ guidance: itemMetadata.optional(), document: itemMetadata.optional(), related: z.array(itemMetadata), participants: z.array(z.object({ personId: id, live: z.boolean(), interviewShared: z.boolean() })), contributionSummary: z.array(z.object({ personId: id, count: nat })) });
export const ownInterview = z.object({ roundId: id, personId: id, label, shared: z.boolean(), text: z.string().max(256 * 1024) });
export const agentCard = z.object({ agentId: id, name: label, live: z.boolean(), capabilities: z.array(label) });
export const v2View = z.discriminatedUnion('view', [
  z.object({ view: z.literal('library'), journeyId: id, items: z.array(itemMetadata), item: itemMetadata.optional(), conversation: conversationView.optional() }),
  forumView,
  z.object({ view: z.literal('round'), journeyId: id, rounds: z.array(roundSummary), round: roundDetail.optional(), conversation: conversationView.optional(), interview: ownInterview.optional() }),
  z.object({ view: z.literal('agents'), journeyId: id.optional(), agents: z.array(agentCard) }),
]);
export type V2View = z.output<typeof v2View>;
export type V2Kind = V2View['view'];
export const CONSOLE_URL = 'https://poc.wayfinding.support/console';
export const v2Uris: Record<V2Kind, string> = { library: 'ui://wayfinding/v2/library.html', forum: 'ui://wayfinding/v3/forum.html', round: 'ui://wayfinding/v2/round.html', agents: 'ui://wayfinding/v2/agents.html' };
