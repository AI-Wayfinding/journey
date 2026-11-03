import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MemoryBackend } from '../src/backend.ts';
import { Journey } from '../src/objects.ts';
import { app, bridge, keyPair, RESOURCE, token, testPasskeys, setAgentCard } from './helpers.ts';

const signer = await keyPair('forum');
type Data = Record<string, unknown>;
const rows = (d: Data, key: string) => d[key] as Data[];
async function fixture(t: TestContext) {
  const backend = new MemoryBackend({ async get(s) { return { name: s, email: `${s}@example.test` }; } }, Date.now, testPasskeys);
  async function connect(sub: string, clientId = 'test-client') {
    const c = new Client({ name: 'forum-test', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: bridge(app(signer, backend)), requestInit: { headers: { authorization: `Bearer ${await token(signer, { sub, client_id: clientId })}` } } }));
    t.after(() => c.close()); return c;
  }
  async function call(c: Client, name: string, input: Data = {}) {
    const r = await c.callTool({ name, arguments: input }); assert.notEqual(r.isError, true, JSON.stringify(r)); return r.structuredContent as Data;
  }
  async function refused(c: Client, name: string, input: Data) {
    const before = backend.snapshot(), writes = [...backend.journeyStores.values()].map(s => s.writes);
    const r = await c.callTool({ name, arguments: input }); assert.equal(r.isError, true, JSON.stringify(r));
    assert.equal(backend.snapshot(), before); assert.deepEqual([...backend.journeyStores.values()].map(s => s.writes), writes);
  }
  const alice = await connect('alice'), bob = await connect('bob'), eve = await connect('eve');
  const a = (await call(alice, 'account_read')).personId, b = (await call(bob, 'account_read')).personId;
  await call(eve, 'account_read');
  const journeyId = (await call(alice, 'journey_create', { name: 'Forum', policy: 'open', defaultRole: 'read' })).journeyId as string;
  await call(bob, 'journey_join', { journeyId });
  const boardId = rows(await call(alice, 'forum_boards', { journeyId }), 'boards')[0]!.boardId;
  const topic = () => call(bob, 'topic_create', { boardId, title: 'Welcome', body: 'Opening post' });
  return { backend, alice, bob, eve, a, b, journeyId, boardId, call, refused, connect, topic };
}

test('forum: default General, guide board management, archived boards and tool registration', async t => {
  const f = await fixture(t);
  assert.equal(rows(await f.call(f.alice, 'forum_boards', { journeyId: f.journeyId }), 'boards')[0]!.name, 'General');
  const names = (await f.alice.listTools()).tools.map(t => t.name);
  for (const n of ['forum_boards','board_create','board_update','topic_create','topic_list','topic_read','post_create','post_edit','post_hide','post_unhide','topic_lock','topic_unlock','conversation_read','conversation_post']) assert.ok(names.includes(n), n);
  await f.refused(f.bob, 'board_create', { journeyId: f.journeyId, name: 'Not guide' });
  const board = await f.call(f.alice, 'board_create', { journeyId: f.journeyId, name: 'Research', description: 'Questions' });
  await f.call(f.alice, 'board_update', { boardId: board.boardId, name: 'Ideas', description: 'Discuss', archived: true });
  await f.refused(f.bob, 'topic_create', { boardId: board.boardId, title: 'No', body: 'No' });
  await f.call(f.alice, 'board_update', { boardId: board.boardId, archived: false });
  assert.equal((await f.call(f.bob, 'topic_create', { boardId: board.boardId, title: 'Yes', body: 'Now open' })).title, 'Yes');
  await f.refused(f.eve, 'forum_boards', { journeyId: f.journeyId });
});

test('forum: replies, immutable attribution, own edits, guide hiding and author locks', async t => {
  const f = await fixture(t), topic = await f.topic(), topicId = topic.topicId;
  const first = rows(topic, 'posts')[0]!;
  assert.equal(first.author, f.b); assert.equal(first.authorKind, 'person'); assert.equal(first.authorName, 'bob');
  const reply = await f.call(f.alice, 'post_create', { topicId, body: 'A reply', replyTo: first.postId });
  assert.equal(reply.replyTo, first.postId);
  await f.refused(f.alice, 'post_edit', { postId: first.postId, body: 'Guide cannot edit another author' });
  await f.call(f.bob, 'post_edit', { postId: first.postId, body: 'Edited opening' });
  await f.refused(f.bob, 'post_hide', { postId: reply.postId });
  await f.call(f.alice, 'post_hide', { postId: reply.postId });
  let thread = rows(await f.call(f.bob, 'topic_read', { topicId }), 'posts');
  assert.equal(thread[0]!.edited, true); assert.equal(thread[0]!.body, 'Edited opening');
  assert.equal(thread[1]!.hidden, true); assert.equal(thread[1]!.body, undefined);
  await f.call(f.alice, 'post_unhide', { postId: reply.postId });
  await f.call(f.bob, 'topic_lock', { topicId });
  await f.refused(f.alice, 'post_create', { topicId, body: 'Locked even for guide' });
  // The post model allows authors to edit existing words while a topic is locked.
  await f.call(f.bob, 'post_edit', { postId: first.postId, body: 'Still mine' });
  await f.call(f.alice, 'topic_unlock', { topicId });
  const other = await f.call(f.alice, 'topic_create', { boardId: f.boardId, title: 'Other', body: 'Elsewhere' });
  await f.refused(f.bob, 'topic_lock', { topicId: other.topicId });
  await f.refused(f.bob, 'post_create', { topicId: other.topicId, body: 'Cross topic quote', replyTo: first.postId });
  thread = rows(await f.call(f.bob, 'topic_read', { topicId }), 'posts'); assert.equal(thread[1]!.body, 'A reply');
});

test('forum: exactly one lazy conversation per project and artifact under concurrent first posts', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  const p = rows(await f.call(f.alice, 'project_create', { journeyId, name: 'Project', purpose: 'Discuss' }), 'projects')[0]!;
  const item = await f.call(f.alice, 'library_add', { journeyId, name: 'Notes', text: 'Source' });
  for (const target of [{ projectId: p.projectId }, { itemId: item.itemId }]) {
    assert.equal((await f.call(f.bob, 'conversation_read', { journeyId, target })).topic, null);
    const posts = await Promise.all(Array.from({ length: 4 }, (_, i) => f.call(f.bob, 'conversation_post', { journeyId, target, body: `Post ${i}` })));
    assert.equal(new Set(posts.map(p => p.topicId)).size, 1);
    const read = await f.call(f.bob, 'conversation_read', { journeyId, target }); assert.equal(rows(read, 'posts').length, 4);
    assert.equal(rows(await f.call(f.bob, 'topic_list', { journeyId, attachedTo: target }), 'topics').length, 1);
  }
  assert.equal(rows(await f.call(f.bob, 'topic_list', { journeyId }), 'topics').length, 2);
  await f.refused(f.bob, 'conversation_post', { journeyId, target: { projectId: item.itemId }, body: 'Wrong kind' });
  await f.refused(f.bob, 'conversation_post', { journeyId, target: { itemId: 'missing' }, body: 'Missing' });
});

test('forum: private and deleted artifact conversations are hidden through every identifier path', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  const item = await f.call(f.alice, 'library_add', { journeyId, name: 'Private', visibility: 'private', text: 'Secret source' });
  const target = { itemId: item.itemId }, post = await f.call(f.alice, 'conversation_post', { journeyId, target, body: 'Secret discussion' });
  for (const [name, input] of [['conversation_read', { journeyId, target }], ['conversation_post', { journeyId, target, body: 'No' }], ['topic_read', { topicId: post.topicId }], ['post_create', { topicId: post.topicId, body: 'No' }], ['post_edit', { postId: post.postId, body: 'No' }], ['post_hide', { postId: post.postId }], ['topic_lock', { topicId: post.topicId }], ['topic_list', { journeyId, attachedTo: target }]] as const) await f.refused(f.bob, name, input);
  assert.deepEqual(rows(await f.call(f.bob, 'topic_list', { journeyId }), 'topics'), []);
  await f.call(f.alice, 'library_update', { itemId: item.itemId, visibility: 'members' });
  assert.equal(rows(await f.call(f.bob, 'topic_read', { topicId: post.topicId }), 'posts')[0]!.body, 'Secret discussion');
  await f.call(f.alice, 'library_delete', { itemId: item.itemId });
  await f.refused(f.alice, 'topic_read', { topicId: post.topicId });
  assert.deepEqual(rows(await f.call(f.alice, 'topic_list', { journeyId }), 'topics'), []);
});

test('forum: bound agents use post, topic.create and board.manage independently with live authority', async t => {
  const f = await fixture(t), topic = await f.topic(), journeyId = f.journeyId;
  const agentId = (await f.call(f.alice, 'agent_create', { name: 'Scout' })).agentId as string;
  await f.call(f.alice, 'agent_add', { journeyId, agentId });
  const identity = { subject: 'alice', clientId: 'test-client' }, change = { kind: 'bind' as const, clientId: 'assistant', agentId };
  const { challenge } = await f.backend.beginAuthorization(identity, change);
  await f.backend.completeAuthorization(identity, change, { id: 'synthetic', rawId: 'synthetic', type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: challenge, authenticatorData: '', signature: 'test-valid' } });
  const bound = await f.connect('alice', 'assistant');
  await f.refused(bound, 'post_create', { topicId: topic.topicId, body: 'Empty card' });
  await setAgentCard(f.backend, 'alice', agentId, ['post']);
  const post = await f.call(bound, 'post_create', { topicId: topic.topicId, body: 'From Scout' });
  assert.equal(post.author, agentId); assert.equal(post.authorKind, 'agent'); assert.equal(post.authorName, 'Scout');
  await f.refused(bound, 'topic_read', { topicId: topic.topicId });
  await f.refused(bound, 'topic_create', { boardId: f.boardId, title: 'No topic cap', body: 'No' });
  await f.refused(bound, 'board_create', { journeyId, name: 'No board cap' });
  await f.refused(f.alice, 'post_edit', { postId: post.postId, body: 'Owner is not author' });
  await f.call(bound, 'post_edit', { postId: post.postId, body: 'My edit' });
  await setAgentCard(f.backend, 'alice', agentId, ['post', 'topic.create', 'board.manage', 'read']);
  await f.call(bound, 'topic_create', { boardId: f.boardId, title: 'Agent topic', body: 'Opening' });
  await f.call(bound, 'board_create', { journeyId, name: 'Agent managed' });
  await f.call(bound, 'post_hide', { postId: post.postId });
  await f.call(f.alice, 'journey_guide', { journeyId, personId: f.b });
  await f.call(f.alice, 'journey_unguide', { journeyId, personId: f.a });
  await f.refused(bound, 'board_create', { journeyId, name: 'Person lost guide' });
  await f.call(f.alice, 'agent_narrow', { agentId, remove: ['post'] });
  await f.refused(bound, 'post_create', { topicId: topic.topicId, body: 'Revoked post' });
  await f.call(f.bob, 'journey_remove', { journeyId, memberId: f.a });
  await f.refused(bound, 'topic_read', { topicId: topic.topicId });
});

test('forum: malformed and forged input refuses without writes; reload and transaction rollback preserve threads', async t => {
  const f = await fixture(t), topic = await f.topic(), topicId = topic.topicId;
  for (const extra of [{ author: f.a }, { actorKind: 'agent' }, { canPost: true }, { body: 'x'.repeat(4097) }, { replyTo: 9007199254740992 }]) await f.refused(f.bob, 'post_create', { topicId, body: 'No', ...extra });
  const store = f.backend.journeyStores.get(f.journeyId)!, before = [...store.data], original = store.put.bind(store);
  store.put = async (key, value) => { await original(key, value); if (key.includes('forumBody')) throw new Error('Injected failure'); };
  await f.refused(f.bob, 'post_create', { topicId, body: 'Must roll back' }); store.put = original;
  assert.deepEqual([...store.data], before);
  const response = await new Journey({ storage: store }).fetch(new Request('https://internal/', { method: 'POST', body: JSON.stringify({ personId: f.b, tool: 'topic_read', input: { topicId } }) }));
  assert.equal(response.status, 200);
  const value = (await response.json() as { value: Data }).value;
  assert.equal(rows(value, 'posts')[0]!.body, 'Opening post');
});


test('forum: moderation-only agents do not receive bodies and private targets remain owner-only', async t => {
  const f = await fixture(t), topic = await f.topic(), first = rows(topic, 'posts')[0]!;
  const agentId = (await f.call(f.alice, 'agent_create', { name: 'Moderator' })).agentId as string;
  await f.call(f.alice, 'agent_add', { journeyId: f.journeyId, agentId });
  await setAgentCard(f.backend, 'alice', agentId, ['board.manage']);
  const hidden = await f.call(f.alice, 'post_hide', { postId: first.postId, actingAgent: agentId });
  assert.equal(hidden.body, undefined); assert.equal(hidden.hidden, true);
  const unhidden = await f.call(f.alice, 'post_unhide', { postId: first.postId, actingAgent: agentId });
  assert.equal(unhidden.body, undefined); assert.equal(unhidden.hidden, false);
  await f.refused(f.alice, 'post_create', { topicId: topic.topicId, actingAgent: agentId, body: 'No post' });
  await setAgentCard(f.backend, 'alice', agentId, ['post', 'read']);
  await f.call(f.alice, 'journey_role', { journeyId: f.journeyId, personId: f.b, role: 'write' });
  const privateItem = await f.call(f.bob, 'library_add', { journeyId: f.journeyId, name: 'Private notes', visibility: 'private', text: 'Source' });
  const target = { itemId: privateItem.itemId };
  const privatePost = await f.call(f.bob, 'conversation_post', { journeyId: f.journeyId, target, body: 'Private thread' });
  await f.refused(f.alice, 'conversation_post', { journeyId: f.journeyId, target, actingAgent: agentId, body: 'Not owner' });
  await f.refused(f.alice, 'topic_read', { topicId: privatePost.topicId, actingAgent: agentId });
  const own = await f.call(f.alice, 'library_add', { journeyId: f.journeyId, name: 'Own notes', visibility: 'private', text: 'Own source' });
  const posted = await f.call(f.alice, 'conversation_post', { journeyId: f.journeyId, target: { itemId: own.itemId }, actingAgent: agentId, body: 'Own thread' });
  assert.equal(posted.authorKind, 'agent');
  const topics = rows(await f.call(f.alice, 'topic_list', { journeyId: f.journeyId, actingAgent: agentId }), 'topics');
  assert.equal(topics.find(t => t.topicId === posted.topicId)!.authorKind, 'agent');
  assert.equal(topics.some(t => t.topicId === privatePost.topicId), false);
});
