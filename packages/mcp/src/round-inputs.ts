import * as z from 'zod';
import { serverTextLimit } from './library-inputs.ts';
const id = z.string().min(1).max(200);
const label = z.string().trim().min(1).max(4096);
const body = z.string().max(serverTextLimit).refine(text => new TextEncoder().encode(text).length <= serverTextLimit, 'Round text exceeds 256 KiB');
const acting = { actingAgent: id.optional() };
const round = { roundId: id, ...acting };
export const roundStatuses = ['planned', 'open', 'synthesising', 'closed'] as const;
export const roundInputs = {
  round_create: z.object({ journeyId: id, ...acting, title: label, goal: label, format: label.optional(), guidanceItemId: id.optional(), documentItemId: id.optional(), relatedItemIds: z.array(id).max(128).optional(), participants: z.array(id).max(1024).optional() }).strict(),
  round_list: z.object({ journeyId: id, ...acting }).strict(),
  round_read: z.object(round).strict(),
  round_status: z.object({ ...round, to: z.enum(roundStatuses) }).strict(),
  round_participants: z.object({ ...round, add: z.array(id).max(1024).optional(), remove: z.array(id).max(1024).optional() }).strict().refine(i => (i.add?.length ?? 0) + (i.remove?.length ?? 0) > 0, 'Supply participant changes').refine(i => !(i.add ?? []).some(p => i.remove?.includes(p)), 'Cannot add and remove the same person'),
  interview_read: z.object({ ...round, personId: id.optional() }).strict(),
  interview_write: z.object({ ...round, text: body }).strict(),
  interview_assign: z.object({ ...round, personId: id, itemId: id }).strict(),
  interview_share: z.object(round).strict(),
  round_contribute: z.object({ ...round, text: body.refine(text => text.trim().length > 0, 'Contribution required') }).strict(),
  round_next: z.object({ ...round, title: label, goal: label, format: label.optional() }).strict(),
} as const;
export const roundDescriptions = {
  round_create: 'Create a facilitator-owned planned sensemaking round with goal, format, guidance and shared document. Defaults to all current people and the First position interview. Agents need round.create; generated library items and conversation are part of this operation.',
  round_list: 'List sensemaking round summaries in a journey. Requires read; private interview notes never appear.',
  round_read: 'Read a round goal, guidance, document, related artifacts, participants, shared flags and conversation. Requires read. The PoC server can read all text.',
  round_status: 'Move your facilitated round planned -> open -> synthesising -> closed, or reopen synthesising to open. Agents need round.run. Closed rounds cannot reopen.',
  round_participants: 'Add or remove live person participants in your facilitated round at any time, including after closure. Agents need round.run.',
  interview_read: 'Read your own private interview, or an explicitly shared interview using personId. Requires read. Notes are readable by the PoC server, not by other members or guides until shared.',
  interview_write: 'Replace your own interview notes privately (256 KiB maximum). Agents need round.contribute. After you share, later edits are shared too. This never modifies an assigned source artifact.',
  interview_assign: 'Seed an untouched participant interview from an existing readable server library item as facilitator with round.run. Source must also be readable by the participant. Notes are copied privately and labelled with their person.',
  interview_share: 'Explicitly share your own interview with the journey round as a participant with round.contribute. Sharing is permanent, including future edits.',
  round_contribute: 'Append an attributed section to the shared sensemaking document as a new version, only as a participant while open or synthesising. Agents need round.contribute; attribution is always to the person.',
  round_next: 'Start a new planned round from your closed round with title, goal and optional format. Requires round.create and facilitator round.run; defaults to all current people.',
} as const;
