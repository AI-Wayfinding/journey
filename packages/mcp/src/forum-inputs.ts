import * as z from 'zod';
const id = z.string().min(1).max(200);
const text = z.string().trim().min(1).max(4096);
const acting = { actingAgent: id.optional() };
const journey = { journeyId: id, ...acting };
const board = { boardId: id, ...acting };
const topic = { topicId: id, ...acting };
const post = { postId: id, ...acting };
export const forumTarget = z.union([z.object({ projectId: id }).strict(), z.object({ itemId: id }).strict()]);
export type ForumTarget = z.infer<typeof forumTarget>;
export const forumInputs = {
  forum_boards: z.object(journey).strict(),
  board_create: z.object({ ...journey, name: text, description: z.string().max(4096).optional() }).strict(),
  board_update: z.object({ ...board, name: text.optional(), description: z.string().max(4096).optional(), archived: z.boolean().optional() }).strict().refine(v => v.name !== undefined || v.description !== undefined || v.archived !== undefined, 'Supply a board change'),
  topic_create: z.object({ ...board, title: text, body: text }).strict(),
  topic_list: z.object({ journeyId: id.optional(), ...acting, boardId: id.optional(), attachedTo: forumTarget.optional() }).strict().refine(v => (v.journeyId !== undefined || v.boardId !== undefined) && !(v.boardId !== undefined && v.attachedTo !== undefined), 'Supply journeyId or boardId, with one filter'),
  topic_read: z.object(topic).strict(),
  post_create: z.object({ ...topic, body: text, replyTo: id.optional() }).strict(),
  post_edit: z.object({ ...post, body: text }).strict(),
  post_hide: z.object(post).strict(),
  post_unhide: z.object(post).strict(),
  topic_lock: z.object(topic).strict(),
  topic_unlock: z.object(topic).strict(),
  conversation_read: z.object({ ...journey, target: forumTarget }).strict(),
  conversation_post: z.object({ ...journey, target: forumTarget, body: text, replyTo: id.optional() }).strict(),
} as const;
export const forumDescriptions = {
  forum_boards: 'List journey forum boards, including the default General board and archive state. Requires read.',
  board_create: 'Create a forum board with a name and optional description. Requires live guide authority and board.manage for agents.',
  board_update: 'Rename, describe, archive or reopen a board by boardId as a guide with board.manage.',
  topic_create: 'Create a topic and opening post in an open board. Agents need both topic.create and post.',
  topic_list: 'Poll topic summaries with reply counts and last activity. Supply boardId, or journeyId with optional attachedTo projectId or itemId. Requires read.',
  topic_read: 'Poll a thread by topicId with attributed posts, quoted reply ids and edit/hidden markers. Hidden bodies are omitted. Requires read.',
  post_create: 'Post in an unlocked topic with an optional replyTo post id from that thread. Requires post. The PoC server can read bodies.',
  post_edit: 'Edit only your own post, without changing author, kind or replyTo. Requires post; existing words remain editable in locked topics.',
  post_hide: 'Hide a post body as a live guide with board.manage. Attribution remains visible.',
  post_unhide: 'Restore a hidden post as a live guide with board.manage.',
  topic_lock: 'Lock a topic as its author (topic.create for agents) or a live guide with board.manage.',
  topic_unlock: 'Unlock a topic as its author (topic.create for agents) or a live guide with board.manage.',
  conversation_read: 'Poll the single conversation attached to a project or library item; returns topic null before its first post. Item privacy is checked live.',
  conversation_post: 'Post in the single attached project or artifact conversation, creating it on first post with post alone. Compatible with the original conversation_post tool; returns the attributed post.',
} as const;
