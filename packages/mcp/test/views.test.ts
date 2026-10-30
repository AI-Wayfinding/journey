import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MemoryBackend } from '../src/backend.ts';
import { app, bridge, keyPair, RESOURCE, token, testPasskeys, setAgentCard } from './helpers.ts';
import { AppsHost } from './apps-host.ts';
import { releasedViews } from '@ai-wayfinding/apps/views';

const signer = await keyPair('views');
type Data = Record<string, unknown>;
const rows = (d: Data, key: string) => d[key] as Data[];
async function fixture(t: TestContext) {
  const backend = new MemoryBackend({ async get(s) { return { name: s, email: `${s}@example.test` }; } }, Date.now, testPasskeys);
  async function connect(sub: string) {
    const c = new Client({ name: 'views-test', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: bridge(app(signer, backend)), requestInit: { headers: { authorization: `Bearer ${await token(signer, { sub })}` } } }));
    t.after(() => c.close()); return c;
  }
  async function call(c: Client, name: string, input: Data = {}) {
    const r = await c.callTool({ name, arguments: input }); assert.notEqual(r.isError, true, JSON.stringify(r)); return r.structuredContent as Data;
  }
  const alice = await connect('alice'), bob = await connect('bob'), eve = await connect('eve');
  const a = (await call(alice, 'account_read')).personId, b = (await call(bob, 'account_read')).personId;
  const journeyId = (await call(alice, 'journey_create', { name: 'Views journey', policy: 'open', defaultRole: 'write' })).journeyId;
  await call(bob, 'journey_join', { journeyId });
  async function host(kind: string, tool: string, args: Data) {
    const resource = (await alice.readResource({ uri: `ui://wayfinding/${kind === 'forum' ? 'v3' : 'v2'}/${kind}.html` })).contents[0]!;
    assert.ok('text' in resource);
    assert.match(resource.text, /Your conversation goes to your AI provider/); assert.match(resource.text, /synthetic data only/i);
    const h = new AppsHost(resource.text, alice); t.after(() => h.dispose());
    await h.until(() => h.nodes.get('status')!.textContent === 'Connected.');
    h.notify('ui/notifications/tool-input', { arguments: { ...args, subject: 'bob', url: 'https://evil.test' } });
    h.notify('ui/notifications/tool-result', await alice.callTool({ name: tool, arguments: args }));
    await h.until(() => h.nodes.get('status')!.textContent === 'Up to date.'); return h;
  }
  return { backend, alice, bob, eve, a, b, journeyId, call, host };
}

test('views: released URI bytes stay identical while new resources and app-only tools register', async t => {
  const expected = [
    ['ui://wayfinding/v1/journey.html', '5c1d8599f4f5ea0fc161a452b7a49258d346fd0d38da6752b5bc35a3b66a700e'],
    ['ui://wayfinding/v1/project.html', '7e182e64d5b5e60d3d72417e65d5791b116d6ba0ac4bc45bad149efd32ddc0e7'],
    ['ui://wayfinding/v1/artifacts.html', '3781a3ece862f60510e88f83a2aef6949d886f09852c03457fe814e022cde6b0'],
    ['ui://wayfinding/v2/forum.html', '524ae7b42d7bfeaa3e7c8df1704c542c6f116d16681c7770c9646459058dfbc6'],
  ];
  for (const [uri, hash] of expected) assert.equal(createHash('sha256').update(releasedViews.find(v => v.uri === uri)!.html).digest('hex'), hash);
  const f = await fixture(t), resources = (await f.alice.listResources()).resources.map(r => r.uri);
  for (const uri of ['ui://wayfinding/v2/library.html', 'ui://wayfinding/v2/round.html', 'ui://wayfinding/v2/agents.html', 'ui://wayfinding/v3/forum.html']) assert.ok(resources.includes(uri), uri);
  const tools = (await f.alice.listTools()).tools;
  for (const name of ['apps_v2_library', 'apps_v2_round', 'apps_v2_interview_read', 'apps_v2_interview_write', 'apps_v2_interview_share', 'apps_v2_contribute', 'apps_v2_forum', 'apps_v2_reply', 'apps_v2_agents']) assert.deepEqual((tools.find(tool => tool.name === name)!._meta!.ui as { visibility: string[] }).visibility, ['app']);
});

test('views: library filters, metadata detail and attached conversation run through the bundled host', async t => {
  const f = await fixture(t);
  const item = await f.call(f.alice, 'library_add', { journeyId: f.journeyId, name: '<b>Heading</b>', kind: 'prompt', labels: ['heading'], text: 'ARTIFACT-SECRET' });
  const project = await f.call(f.alice, 'project_create', { journeyId: f.journeyId, name: 'Hidden project', purpose: 'Test' });
  await f.call(f.alice, 'library_add', { journeyId: f.journeyId, name: 'Project-only', projectId: rows(project, 'projects')[0]!.projectId, text: 'x' });
  const h = await f.host('library', 'library_view', { journeyId: f.journeyId });
  assert.match(h.text, /<b>Heading<\/b>/); assert.doesNotMatch(h.text, /Project-only|ARTIFACT-SECRET/);
  h.submit('filters', { query: 'heading', kind: 'prompt', label: 'heading', projectId: '', includeProjects: 'false' });
  await h.until(() => h.messages.some(m => m.method === 'tools/call') && h.nodes.get('status')!.textContent === 'Up to date.');
  h.submit('item', { itemId: String(item.itemId) }); await h.until(() => h.text.includes('Conversation'));
  assert.doesNotMatch(h.text, /ARTIFACT-SECRET/);
  h.submit('reply', { body: 'An attached comment', replyTo: '' }); await h.until(() => h.text.includes('An attached comment'));
  const conversation = await f.call(f.alice, 'conversation_read', { journeyId: f.journeyId, target: { itemId: item.itemId } });
  assert.equal(rows(conversation, 'posts')[0]!.body, 'An attached comment');
  const args = h.messages.filter(m => m.method === 'tools/call')[0]!.params!.arguments as Data;
  assert.equal(args.subject, undefined); assert.equal(args.url, undefined); assert.equal(args.kind, 'prompt');
});

test('views: round host shows lifecycle, own interview, sharing, contribution attribution and tool navigation', async t => {
  const f = await fixture(t), round = await f.call(f.alice, 'round_create', { journeyId: f.journeyId, title: 'First position', goal: 'Listen carefully' });
  await f.call(f.alice, 'round_status', { roundId: round.roundId, to: 'open' });
  await f.call(f.bob, 'interview_write', { roundId: round.roundId, text: 'BOB-PRIVATE' });
  const h = await f.host('round', 'round_view', { journeyId: f.journeyId, roundId: round.roundId });
  assert.match(h.text, /Listen carefully.*planned.*open.*synthesising.*closed/s); assert.doesNotMatch(h.text, /BOB-PRIVATE/);
  h.click('my-interview'); await h.until(() => h.text.includes('My interview'));
  h.submit('interview', { text: 'My private words' }); await h.until(() => h.text.includes('My private words'));
  assert.equal((await f.call(f.alice, 'interview_read', { roundId: round.roundId })).text, 'My private words');
  h.click('share'); await h.until(() => h.text.includes('Shared with the round'));
  h.submit('contribute', { text: 'A considered contribution' }); await h.until(() => h.text.includes('1 contribution'));
  assert.match(h.text, new RegExp(String(f.a)));
  h.click('document'); await h.until(() => h.text.includes('sensemaking') && h.text.includes('Library artifact'));
  assert.doesNotMatch(h.text, /My private words|BOB-PRIVATE/);
  h.click('nav-forum'); await h.until(() => h.text.includes('General'));
});

test('views: private interviews and library items cannot be selected by another member or their agent', async t => {
  const f = await fixture(t), round = await f.call(f.alice, 'round_create', { journeyId: f.journeyId, title: 'Private', goal: 'No leakage' });
  const item = await f.call(f.bob, 'library_add', { journeyId: f.journeyId, name: 'Private item', visibility: 'private', text: 'BOB-PRIVATE' });
  await f.call(f.bob, 'interview_write', { roundId: round.roundId, text: 'BOB-PRIVATE' });
  const agentId = (await f.call(f.alice, 'agent_create', { name: 'Scout' })).agentId as string;
  await f.call(f.alice, 'agent_add', { journeyId: f.journeyId, agentId }); await setAgentCard(f.backend, 'alice', agentId, ['read', 'round.contribute']);
  for (const acting of [{}, { actingAgent: agentId }]) {
    for (const [name, input] of [['apps_v2_interview_read', { journeyId: f.journeyId, roundId: round.roundId, personId: f.b }], ['apps_v2_library', { journeyId: f.journeyId, itemId: item.itemId }], ['apps_v2_interview_write', { journeyId: f.journeyId, roundId: round.roundId, personId: f.b, text: 'overwrite' }]] as const) {
      assert.equal((await f.alice.callTool({ name, arguments: { ...input, ...acting } })).isError, true);
    }
    const data = await f.call(f.alice, 'apps_v2_round', { journeyId: f.journeyId, roundId: round.roundId, ...acting });
    assert.doesNotMatch(JSON.stringify(data), /BOB-PRIVATE/);
  }
  await f.call(f.bob, 'interview_share', { roundId: round.roundId });
  assert.equal((await f.alice.callTool({ name: 'apps_v2_interview_read', arguments: { journeyId: f.journeyId, roundId: round.roundId, personId: f.b } })).isError, true);
  assert.equal((await f.eve.callTool({ name: 'apps_v2_round', arguments: { journeyId: f.journeyId, roundId: round.roundId } })).isError, true);
});

test('views: forum successor browses boards, topics, attributed thread and reply counts through app-only tools', async t => {
  const f = await fixture(t), h = await f.host('forum', 'forum_view_v3', { journeyId: f.journeyId });
  const boardId = rows(await f.call(f.alice, 'forum_boards', { journeyId: f.journeyId }), 'boards')[0]!.boardId;
  h.submit('board', { boardId: String(boardId) }); await h.until(() => h.text.includes('Topics'));
  h.submit('newtopic', { title: 'A question', body: 'Opening words' }); await h.until(() => h.text.includes('Opening words'));
  assert.match(h.text, /alice \[person\]/);
  h.submit('reply', { body: 'An answer', replyTo: '' }); await h.until(() => h.text.includes('An answer'));
  h.submit('board', { boardId: String(boardId) }); await h.until(() => h.text.includes('1 replies'));
  assert.ok(h.messages.filter(m => m.method === 'tools/call').every(m => String(m.params!.name).startsWith('apps_v2_')));
});

test('views: read-only capability card groups scopes and opens a fixed console link', async t => {
  const f = await fixture(t), agentId = (await f.call(f.alice, 'agent_create', { name: 'Scout' })).agentId as string;
  await setAgentCard(f.backend, 'alice', agentId, ['journey.create', 'post']);
  const h = await f.host('agents', 'agent_capabilities_view', { agentId });
  assert.match(h.text, /Account capabilities.*journey.create.*Journey capabilities.*post/s);
  const before = f.backend.snapshot(); h.click('signin'); await h.until(() => h.opened.length === 1);
  assert.deepEqual(h.opened, ['https://poc.wayfinding.support/console']); assert.equal(f.backend.snapshot(), before);
  assert.equal((await f.bob.callTool({ name: 'apps_v2_agents', arguments: { agentId } })).isError, true);
});


test('views: boundary strips content, locations and hidden posts; refused refresh clears private DOM text', async t => {
  const f = await fixture(t), item = await f.call(f.alice, 'library_add', { journeyId: f.journeyId, name: 'Source', text: 'SECRET-ARTIFACT' });
  const projected = await f.call(f.alice, 'apps_v2_library', { journeyId: f.journeyId, itemId: item.itemId });
  assert.doesNotMatch(JSON.stringify(projected), /SECRET-ARTIFACT/);
  const h = await f.host('library', 'library_view', { journeyId: f.journeyId });
  h.notify('ui/notifications/tool-result', { structuredContent: { ...projected, text: 'SECRET', url: 'https://evil.test', item: { ...(projected.item as Data), text: 'SECRET', url: 'https://evil.test' }, conversation: { topic: { topicId: 't', title: 'Hidden', author: 'p', authorName: 'Person', authorKind: 'person', locked: false, postCount: 1, replyCount: 0, createdAt: 1, lastActivity: 1, posts: [{ postId: 'p', topicId: 't', author: 'p', authorName: 'Person', authorKind: 'person', hidden: true, edited: false, createdAt: 1, updatedAt: 1, body: 'HIDDEN-SECRET' }] } } } });
  await h.until(() => h.text.includes('[Hidden by a guide]'));
  assert.doesNotMatch(h.text, /SECRET|evil.test/);
  const roundId = (await f.call(f.alice, 'round_create', { journeyId: f.journeyId, title: 'Own notes', goal: 'Protect' })).roundId;
  await f.call(f.alice, 'interview_write', { roundId, text: 'MY-PRIVATE-NOTES' });
  h.notify('ui/notifications/tool-result', await f.alice.callTool({ name: 'apps_v2_interview_read', arguments: { journeyId: f.journeyId, roundId } }));
  await h.until(() => h.text.includes('MY-PRIVATE-NOTES'));
  h.notify('ui/notifications/tool-result', { isError: true, content: [{ type: 'text', text: 'unsafe error' }] });
  await h.until(() => h.nodes.get('status')!.textContent.includes('refused'));
  assert.doesNotMatch(h.text, /MY-PRIVATE-NOTES|unsafe error/); assert.equal(h.fields.get('interview:text')!.value, '');
});

test('views: own agents retain actor attribution; revoked cards and mismatched journeys cannot mutate', async t => {
  const f = await fixture(t), agentId = (await f.call(f.alice, 'agent_create', { name: 'Interviewer' })).agentId as string;
  await f.call(f.alice, 'agent_add', { journeyId: f.journeyId, agentId }); await setAgentCard(f.backend, 'alice', agentId, ['read', 'round.contribute', 'post']);
  const roundId = (await f.call(f.alice, 'round_create', { journeyId: f.journeyId, title: 'Interview', goal: 'Listen' })).roundId;
  await f.call(f.alice, 'round_status', { roundId, to: 'open' });
  const h = await f.host('round', 'round_view', { journeyId: f.journeyId, roundId, actingAgent: agentId });
  h.submit('contribute', { text: 'Agent helped me' }); await h.until(() => h.text.includes('1 contributions'));
  assert.match(h.text, new RegExp(String(f.a)));
  assert.equal((h.messages.find(m => m.method === 'tools/call')!.params!.arguments as Data).actingAgent, agentId);
  const own = await f.call(f.alice, 'apps_v2_interview_write', { journeyId: f.journeyId, roundId, text: 'Owner private', actingAgent: agentId });
  assert.equal((own.interview as Data).personId, f.a); assert.equal((own.interview as Data).text, 'Owner private');
  const other = (await f.call(f.alice, 'journey_create', { name: 'Other' })).journeyId;
  const before = f.backend.snapshot();
  assert.equal((await f.alice.callTool({ name: 'apps_v2_contribute', arguments: { journeyId: other, roundId, text: 'Wrong journey' } })).isError, true);
  assert.equal(f.backend.snapshot(), before);
  await f.call(f.alice, 'agent_narrow', { agentId, remove: ['round.contribute'] });
  const revoked = f.backend.snapshot();
  h.submit('contribute', { text: 'No longer allowed' }); await h.until(() => h.nodes.get('status')!.textContent.includes('refused'));
  assert.equal(f.backend.snapshot(), revoked);
});
