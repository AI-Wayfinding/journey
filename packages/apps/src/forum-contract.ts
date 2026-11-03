import * as z from 'zod';
const id = z.string().min(1).max(200), text = z.string().max(4096), nat = z.number().int().nonnegative().safe();
const author = { author: id, authorName: text, authorKind: z.enum(['person', 'agent']) };
const target = z.union([z.object({ projectId: id }), z.object({ itemId: id }), z.object({ roundId: id })]);
const topic = z.object({ topicId: id, title: text, boardId: id.optional(), attachedTo: target.optional(), ...author, locked: z.boolean(), postCount: nat, replyCount: nat, createdAt: nat, lastActivity: nat });
const post = z.object({ postId: id, topicId: id, ...author, replyTo: id.optional(), body: text.optional(), edited: z.boolean(), hidden: z.boolean(), createdAt: nat, updatedAt: nat }).transform(p => p.hidden ? { ...p, body: undefined } : p);
// Only forum text crosses this boundary. Artifact content and access URLs never do.
export const forumView = z.object({ view: z.literal('forum'), journeyId: id,
  boards: z.array(z.object({ boardId: id, name: text, description: text, archived: z.boolean() })).optional(),
  topics: z.array(topic).optional(), topic: topic.extend({ posts: z.array(post) }).optional() });
export type ForumView = z.output<typeof forumView>;
