import { Refused, type Command, type ToolData } from './commands.ts';
import { forumInputs, type ForumTarget } from './forum-inputs.ts';
import { boardRule, topicRule, postRule, scalar, cell, sameState, type Snapshot } from './rules.ts';
import { isLibraryArtifact, requireItem, type LibraryArtifact } from './library.ts';
import type { KeyValueStorage } from './storage.ts';

export type ForumCommand = Extract<Command, { tool: keyof typeof forumInputs }>;
export function isForumCommand(command: Command): command is ForumCommand { return Object.hasOwn(forumInputs, command.tool); }
export interface Board { id: string; name: string; description: string; rule: Snapshot }
export interface Topic { id: string; slot: number; title: string; boardId?: string; target?: ForumTarget; createdAt: number; updatedAt: number }
export interface Post { id: string; topic: number; rule: Snapshot; createdAt: number; updatedAt: number }
export interface ForumState {
  id: string; identities: { id: string; name: string }[]; boards: Board[]; topics: Snapshot; topicRecords: Topic[]; posts: Post[];
  targets: ForumTarget[]; projects: { id: string; name: string }[];
  artifacts: ({ id: string; name: string; type: string; size: number; rule: Snapshot; storage?: never } | LibraryArtifact)[];
}
export interface ForumAccess { actor: number; person: number; agent: boolean; read: boolean; post: boolean; topic: boolean; manage: boolean }
export interface ForumResult { data: ToolData; changed: boolean; writes: [string, string][] }
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function forumJourney(id: string, kind: 'board' | 'topic' | 'post'): string {
  const m = new RegExp(`^${kind}_(${uuid})_${uuid}$`).exec(id);
  if (!m) throw new Refused(`Invalid forum ${kind} id`);
  return `journey_${m[1]}`;
}
export function forumCommandJourney(command: ForumCommand): string {
  const i = command.input;
  const routed = 'boardId' in i && i.boardId !== undefined ? forumJourney(i.boardId, 'board')
    : 'topicId' in i ? forumJourney(i.topicId, 'topic') : 'postId' in i ? forumJourney(i.postId, 'post') : undefined;
  if ('journeyId' in i && i.journeyId !== undefined) {
    if (routed !== undefined && routed !== i.journeyId) throw new Refused('Forum journey mismatch');
    return i.journeyId;
  }
  if (!routed) throw new Refused('Forum journey required');
  return routed;
}
function id(state: ForumState, kind: 'board' | 'topic' | 'post'): string { return `${kind}_${state.id.slice('journey_'.length)}_${crypto.randomUUID()}`; }
function capacity(value: number): void { if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new Refused('Forum counter capacity reached'); }
function changed(before: Snapshot, after: Snapshot): Snapshot {
  if (sameState(before, after, ['selected'])) throw new Refused('Forum change refused by coordination rules');
  return after;
}
function requireCap(ok: boolean, name: string): void { if (!ok) throw new Refused(`Forum ${name} capability refused`); }
export function defaultBoard(state: ForumState, guide: number): void {
  const rule = boardRule.step(boardRule.init(), { op: 0, actor: guide, guide: 1, newArchived: 0 });
  if (scalar(rule, 'exists') !== 1) throw new Refused('Default board creation refused');
  state.boards.push({ id: id(state, 'board'), name: 'General', description: '', rule });
}
function targetKey(target: ForumTarget): string { return 'projectId' in target ? `project:${target.projectId}` : `item:${target.itemId}`; }
function targetName(state: ForumState, target: ForumTarget, access: ForumAccess): string {
  if ('projectId' in target) {
    const project = state.projects.find(p => p.id === target.projectId);
    if (!project) throw new Refused('Forum project not found');
    return project.name;
  }
  const item = state.artifacts.find(a => a.id === target.itemId);
  if (!item) throw new Refused('Forum artifact not found');
  if (isLibraryArtifact(item)) requireItem(item, access.person, access.read || access.post || access.manage || access.topic);
  else if (scalar(item.rule, 'at') !== 1) throw new Refused('Forum artifact not found');
  return item.name;
}
function visible(state: ForumState, topic: Topic, access: ForumAccess): boolean {
  if (!topic.target) return true;
  try { targetName(state, topic.target, access); return true; } catch (e) { if (e instanceof Refused) return false; throw e; }
}
function requireTopic(state: ForumState, topicId: string, access: ForumAccess): Topic {
  const topic = state.topicRecords.find(t => t.id === topicId);
  if (!topic || !visible(state, topic, access)) throw new Refused('Forum topic not found or not readable');
  return topic;
}
function requireBoard(state: ForumState, boardId: string): Board {
  const board = state.boards.find(b => b.id === boardId);
  if (!board) throw new Refused('Forum board not found');
  return board;
}
function author(state: ForumState, slot: number, kind?: number): ToolData {
  const identity = state.identities[slot - 1];
  return { author: identity?.id, authorName: identity?.name ?? 'Wayfinding member', authorKind: kind === 1 ? 'agent' : 'person' };
}
function topicView(state: ForumState, topic: Topic): ToolData {
  const posts = state.posts.filter(p => p.topic === topic.slot);
  return { journeyId: state.id, topicId: topic.id, title: topic.title, boardId: topic.boardId, attachedTo: topic.target,
    ...author(state, cell(state.topics, 'Authors', topic.slot), posts[0] ? scalar(posts[0].rule, 'authorKind') : 0), locked: cell(state.topics, 'Locked', topic.slot) === 1,
    postCount: posts.length, replyCount: Math.max(0, posts.length - 1), createdAt: topic.createdAt, lastActivity: topic.updatedAt };
}
function bodyKey(postId: string): string { return JSON.stringify(['forumBody', postId]); }
async function postView(state: ForumState, post: Post, storage: KeyValueStorage, ownBody?: string, includeBody = true): Promise<ToolData> {
  const hidden = scalar(post.rule, 'hidden') === 1, reply = scalar(post.rule, 'replyTo');
  const data: ToolData = { journeyId: state.id, postId: post.id, topicId: state.topicRecords.find(t => t.slot === post.topic)!.id,
    ...author(state, scalar(post.rule, 'author'), scalar(post.rule, 'authorKind')), replyTo: reply ? state.posts[reply - 1]?.id : undefined,
    edited: scalar(post.rule, 'edits') > 0, hidden, createdAt: post.createdAt, updatedAt: post.updatedAt };
  if (!hidden && includeBody) {
    const raw = ownBody === undefined ? await storage.get(bodyKey(post.id)) : undefined;
    const body: unknown = ownBody ?? (typeof raw === 'string' ? JSON.parse(raw) : undefined);
    if (typeof body !== 'string') throw new Refused('Forum post body unavailable');
    data.body = body;
  }
  return data;
}
async function thread(state: ForumState, topic: Topic, storage: KeyValueStorage): Promise<ToolData> {
  return { ...topicView(state, topic), posts: await Promise.all(state.posts.filter(p => p.topic === topic.slot).map(p => postView(state, p, storage))) };
}
function postStep(rule: Snapshot, op: number, topic: Topic, state: ForumState, access: ForumAccess, reply = 0, hide = false): Snapshot {
  return postRule.step(rule, { op, actor: access.actor, actorKind: +access.agent, canPost: +access.post,
    topicOpen: +(cell(state.topics, 'Topics', topic.slot) === 1 && cell(state.topics, 'Locked', topic.slot) === 0),
    guide: +access.manage, newHidden: +hide, newReplyTo: reply });
}
function appendPost(state: ForumState, topic: Topic, access: ForumAccess, now: number, replyTo?: string): Post {
  requireCap(access.post, 'post'); capacity(state.posts.length + 1);
  let reply = 0;
  if (replyTo !== undefined) {
    const index = state.posts.findIndex(p => p.id === replyTo && p.topic === topic.slot);
    if (index < 0) throw new Refused('Reply must quote a post in this topic');
    reply = index + 1;
  }
  const rule = postStep(postRule.init(), 0, topic, state, access, reply);
  if (scalar(rule, 'exists') !== 1) throw new Refused('Forum posting refused by coordination rules');
  const post: Post = { id: id(state, 'post'), topic: topic.slot, rule, createdAt: now, updatedAt: now };
  state.posts.push(post); topic.updatedAt = now; return post;
}
function makeTopic(state: ForumState, access: ForumAccess, now: number, title: string, board?: Board, target?: ForumTarget): Topic {
  const slot = state.topicRecords.length; capacity(slot + 1);
  let targetSlot = 0;
  if (target) {
    targetSlot = state.targets.findIndex(t => targetKey(t) === targetKey(target));
    if (targetSlot < 0) { capacity(state.targets.length + 1); state.targets.push(target); targetSlot = state.targets.length - 1; }
  }
  state.topics = changed(state.topics, topicRule.step(state.topics, { op: target ? 1 : 0, slot, target: targetSlot, actor: access.actor,
    canTopic: +(target ? access.post : access.topic), boardOpen: +(board === undefined || scalar(board.rule, 'archived') === 0), guide: +access.manage, locked: 0 }));
  const topic: Topic = { id: id(state, 'topic'), slot, title, createdAt: now, updatedAt: now };
  if (board) topic.boardId = board.id;
  if (target) topic.target = target;
  state.topicRecords.push(topic); return topic;
}

/** Runs inside the journey's serial turn; body writes commit atomically with rule state. */
export async function forum(state: ForumState, command: ForumCommand, access: ForumAccess, storage: KeyValueStorage, now: number): Promise<ForumResult> {
  const writes: [string, string][] = [];
  if (command.tool === 'forum_boards') {
    requireCap(access.read, 'read');
    return { data: { journeyId: state.id, boards: state.boards.map(b => ({ boardId: b.id, name: b.name, description: b.description, archived: scalar(b.rule, 'archived') === 1 })) }, changed: false, writes };
  }
  if (command.tool === 'board_create') {
    requireCap(access.manage, 'board.manage');
    const rule = boardRule.step(boardRule.init(), { op: 0, actor: access.actor, guide: +access.manage, newArchived: 0 });
    if (scalar(rule, 'exists') !== 1) throw new Refused('Board creation refused');
    const board: Board = { id: id(state, 'board'), name: command.input.name, description: command.input.description ?? '', rule };
    state.boards.push(board); return { data: { journeyId: state.id, boardId: board.id, name: board.name, description: board.description, archived: false }, changed: true, writes };
  }
  if (command.tool === 'board_update') {
    requireCap(access.manage, 'board.manage');
    const i = command.input, board = requireBoard(state, i.boardId);
    if (i.name !== undefined || i.description !== undefined) {
      capacity(scalar(board.rule, 'edits'));
      board.rule = changed(board.rule, boardRule.step(board.rule, { op: 1, actor: access.actor, guide: +access.manage, newArchived: 0 }));
      if (i.name !== undefined) board.name = i.name;
      if (i.description !== undefined) board.description = i.description;
    }
    if (i.archived !== undefined) board.rule = boardRule.step(board.rule, { op: 2, actor: access.actor, guide: +access.manage, newArchived: +i.archived });
    return { data: { journeyId: state.id, boardId: board.id, name: board.name, description: board.description, archived: scalar(board.rule, 'archived') === 1 }, changed: true, writes };
  }
  if (command.tool === 'topic_list') {
    requireCap(access.read, 'read'); const i = command.input;
    if (i.boardId !== undefined) requireBoard(state, i.boardId);
    if (i.attachedTo !== undefined) targetName(state, i.attachedTo, access);
    const topics = state.topicRecords.filter(t => visible(state, t, access) && (i.boardId === undefined || t.boardId === i.boardId) && (i.attachedTo === undefined || (t.target && targetKey(t.target) === targetKey(i.attachedTo))));
    return { data: { journeyId: state.id, topics: topics.map(t => topicView(state, t)).sort((a, b) => Number(b.lastActivity) - Number(a.lastActivity)) }, changed: false, writes };
  }
  if (command.tool === 'topic_read') { requireCap(access.read, 'read'); return { data: await thread(state, requireTopic(state, command.input.topicId, access), storage), changed: false, writes }; }
  if (command.tool === 'conversation_read' || command.tool === 'conversation_post') {
    const i = command.input; requireCap(command.tool === 'conversation_read' ? access.read : access.post, command.tool === 'conversation_read' ? 'read' : 'post');
    const title = targetName(state, i.target, access), target = state.targets.findIndex(t => targetKey(t) === targetKey(i.target));
    const selected = target < 0 ? 0 : cell(state.topics, 'TargetTopics', target);
    let topic = selected ? state.topicRecords.find(t => t.slot === selected - 1) : undefined;
    if (command.tool === 'conversation_read') return { data: topic ? { ...await thread(state, topic, storage), topic: topicView(state, topic) } : { journeyId: state.id, topic: null, posts: [] }, changed: false, writes };
    topic ??= makeTopic(state, access, now, title, undefined, i.target);
    const post = appendPost(state, topic, access, now, command.input.replyTo);
    writes.push([bodyKey(post.id), JSON.stringify(command.input.body)]);
    return { data: await postView(state, post, storage, command.input.body), changed: true, writes };
  }
  if (command.tool === 'topic_create') {
    requireCap(access.topic, 'topic.create'); requireCap(access.post, 'post');
    const i = command.input, topic = makeTopic(state, access, now, i.title, requireBoard(state, i.boardId));
    const post = appendPost(state, topic, access, now); writes.push([bodyKey(post.id), JSON.stringify(i.body)]);
    return { data: { ...topicView(state, topic), posts: [await postView(state, post, storage, i.body)] }, changed: true, writes };
  }
  if (command.tool === 'post_create') {
    const i = command.input, topic = requireTopic(state, i.topicId, access), post = appendPost(state, topic, access, now, i.replyTo);
    writes.push([bodyKey(post.id), JSON.stringify(i.body)]);
    return { data: await postView(state, post, storage, i.body), changed: true, writes };
  }
  if (command.tool === 'topic_lock' || command.tool === 'topic_unlock') {
    const topic = requireTopic(state, command.input.topicId, access);
    const author = cell(state.topics, 'Authors', topic.slot) === access.actor;
    requireCap(access.manage || (author && access.topic), 'topic.create or board.manage');
    state.topics = topicRule.step(state.topics, { op: 2, slot: topic.slot, target: 0, actor: access.actor, canTopic: +access.topic, boardOpen: 1, guide: +access.manage, locked: +(command.tool === 'topic_lock') });
    topic.updatedAt = now; return { data: topicView(state, topic), changed: true, writes };
  }
  const post = state.posts.find(p => p.id === command.input.postId);
  if (!post) throw new Refused('Forum post not found');
  const topic = state.topicRecords.find(t => t.slot === post.topic)!;
  requireTopic(state, topic.id, access);
  if (command.tool === 'post_edit') {
    requireCap(access.post, 'post'); capacity(scalar(post.rule, 'edits'));
    post.rule = changed(post.rule, postStep(post.rule, 1, topic, state, access));
    writes.push([bodyKey(post.id), JSON.stringify(command.input.body)]);
  } else {
    requireCap(access.manage, 'board.manage');
    post.rule = postStep(post.rule, 2, topic, state, access, 0, command.tool === 'post_hide');
  }
  post.updatedAt = now; topic.updatedAt = now;
  // A post-only caller never receives another post's body as a mutation receipt.
  return { data: await postView(state, post, storage, command.tool === 'post_edit' ? command.input.body : undefined, command.tool === 'post_edit' || access.read), changed: true, writes };
}
