import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MemoryBackend } from '../src/backend.ts';
import { Journey } from '../src/objects.ts';
import { journeyPage } from '../src/console/pages.ts';
import { app, bridge, keyPair, RESOURCE, token, testPasskeys, setAgentCard } from './helpers.ts';

const signer = await keyPair('sensemaking');
type Data = Record<string, unknown>;
const rows = (data: Data, key: string) => data[key] as Data[];
async function fixture(t: TestContext) {
  const backend = new MemoryBackend({ async get(s) { return { name: s, email: `${s}@example.test` }; } }, Date.now, testPasskeys);
  async function connect(sub: string, clientId = 'test-client') {
    const client = new Client({ name: 'sensemaking-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: bridge(app(signer, backend)), requestInit: { headers: { authorization: `Bearer ${await token(signer, { sub, client_id: clientId })}` } } }));
    t.after(() => client.close()); return client;
  }
  async function call(client: Client, name: string, input: Data = {}) {
    const result = await client.callTool({ name, arguments: input });
    assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent as Data;
  }
  async function refused(client: Client, name: string, input: Data) {
    const before = backend.snapshot(), writes = [...backend.journeyStores.values()].map(s => s.writes);
    const result = await client.callTool({ name, arguments: input }); assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(backend.snapshot(), before); assert.deepEqual([...backend.journeyStores.values()].map(s => s.writes), writes);
  }
  const alice = await connect('alice'), bob = await connect('bob'), eve = await connect('eve');
  const a = (await call(alice, 'account_read')).personId as string, b = (await call(bob, 'account_read')).personId as string;
  const e = (await call(eve, 'account_read')).personId as string;
  const journeyId = (await call(alice, 'journey_create', { name: 'Sensemaking', policy: 'open', defaultRole: 'read' })).journeyId as string;
  await call(bob, 'journey_join', { journeyId });
  const create = (input: Data = {}) => call(alice, 'round_create', { journeyId, title: 'First position', goal: 'Find where we stand', ...input });
  const open = async (roundId: unknown) => { await call(alice, 'round_status', { roundId, to: 'open' }); };
  return { backend, alice, bob, eve, a, b, e, journeyId, call, refused, connect, create, open };
}

test('sensemaking: registers round tools, defaults all people, guidance, document and attached conversation', async t => {
  const f = await fixture(t), round = await f.create();
  const names = (await f.alice.listTools()).tools.map(tool => tool.name);
  for (const name of ['round_create', 'round_list', 'round_read', 'round_status', 'round_participants', 'interview_read', 'interview_write', 'interview_assign', 'interview_share', 'round_contribute', 'round_next']) assert.ok(names.includes(name), name);
  const read = await f.call(f.bob, 'round_read', { roundId: round.roundId });
  assert.equal(read.facilitator, f.a); assert.equal(read.status, 'planned');
  assert.deepEqual(rows(read, 'participants').map(p => p.personId).sort(), [f.a, f.b].sort());
  const guidance = read.guidance as Data, doc = read.document as Data;
  assert.equal(guidance.kind, 'prompt'); assert.equal(guidance.name, 'First position interview');
  assert.match(String(guidance.text), /15\. /); assert.match(String(guidance.text), /one question/i); assert.match(String(guidance.text), /server/i);
  assert.equal(doc.name, 'First position - sensemaking'); assert.equal(doc.owner, f.a); assert.match(String(doc.text), /contribut/i);
  const conversation = await f.call(f.bob, 'conversation_read', { journeyId: f.journeyId, target: { roundId: round.roundId } });
  assert.ok((conversation.topic as Data).topicId);
  const post = await f.call(f.bob, 'conversation_post', { journeyId: f.journeyId, target: { roundId: round.roundId }, body: 'What are we learning?' });
  assert.equal(post.topicId, (conversation.topic as Data).topicId);
  assert.equal(rows(await f.call(f.alice, 'topic_list', { journeyId: f.journeyId, attachedTo: { roundId: round.roundId } }), 'topics').length, 1);
});

test('sensemaking: facilitator-only lifecycle, reopen synthesis, closed successor and participants at any time', async t => {
  const f = await fixture(t), roundId = (await f.create({ participants: [f.b] })).roundId;
  await f.refused(f.bob, 'round_status', { roundId, to: 'open' });
  await f.refused(f.alice, 'round_status', { roundId, to: 'closed' });
  await f.refused(f.alice, 'round_next', { roundId, title: 'Too soon', goal: 'No' });
  await f.open(roundId);
  await f.call(f.alice, 'round_status', { roundId, to: 'synthesising' });
  await f.call(f.alice, 'round_status', { roundId, to: 'open' });
  await f.call(f.alice, 'round_status', { roundId, to: 'synthesising' });
  await f.call(f.alice, 'round_status', { roundId, to: 'closed' });
  await f.refused(f.alice, 'round_status', { roundId, to: 'open' });
  await f.call(f.eve, 'journey_join', { journeyId: f.journeyId });
  await f.refused(f.bob, 'round_participants', { roundId, add: [f.e] });
  await f.call(f.alice, 'round_participants', { roundId, add: [f.e], remove: [f.b] });
  const read = await f.call(f.alice, 'round_read', { roundId }); assert.deepEqual(rows(read, 'participants').map(p => p.personId), [f.e]);
  await f.refused(f.bob, 'round_next', { roundId, title: 'Not facilitator', goal: 'No' });
  const next = await f.call(f.alice, 'round_next', { roundId, title: 'Heading', goal: 'Choose where next', format: 'heading' });
  assert.notEqual(next.roundId, roundId); assert.equal(next.status, 'planned'); assert.equal(next.previousRoundId, roundId);
  assert.equal(rows(await f.call(f.alice, 'round_list', { journeyId: f.journeyId }), 'rounds').length, 2);
});

test('sensemaking: interview notes are own-only including against guides and share only by their person', async t => {
  const f = await fixture(t), roundId = (await f.create()).roundId;
  await f.call(f.bob, 'interview_write', { roundId, text: 'Bob private exact words' });
  const own = await f.call(f.bob, 'interview_read', { roundId }); assert.equal(own.personId, f.b); assert.equal(own.text, 'Bob private exact words'); assert.equal(own.shared, false);
  await f.refused(f.alice, 'interview_read', { roundId, personId: f.b });
  await f.refused(f.alice, 'interview_share', { roundId, personId: f.b });
  const read = await f.call(f.alice, 'round_read', { roundId }); assert.ok(!JSON.stringify(read).includes('Bob private exact words'));
  assert.ok(!JSON.stringify(await f.call(f.alice, 'library_search', { journeyId: f.journeyId, query: 'Bob private' })).includes('Bob private exact words'));
  await f.call(f.bob, 'interview_share', { roundId });
  assert.equal((await f.call(f.alice, 'interview_read', { roundId, personId: f.b })).text, 'Bob private exact words');
  assert.equal(rows(await f.call(f.alice, 'round_read', { roundId }), 'participants').find(p => p.personId === f.b)!.interviewShared, true);
  await f.refused(f.eve, 'interview_read', { roundId, personId: f.b });
});

test('sensemaking: assignment seeds a labelled private copy without exposing later edits through library', async t => {
  const f = await fixture(t), roundId = (await f.create()).roundId;
  const item = await f.call(f.alice, 'library_add', { journeyId: f.journeyId, name: 'Interview starter', text: 'Starting point' });
  await f.refused(f.bob, 'interview_assign', { roundId, personId: f.b, itemId: item.itemId });
  await f.call(f.alice, 'interview_assign', { roundId, personId: f.b, itemId: item.itemId });
  let interview = await f.call(f.bob, 'interview_read', { roundId }); assert.equal(interview.itemId, item.itemId); assert.equal(interview.text, 'Starting point'); assert.equal(interview.personId, f.b);
  await f.call(f.bob, 'interview_write', { roundId, text: 'Confidential draft' });
  assert.equal((await f.call(f.alice, 'library_get', { itemId: item.itemId })).text, 'Starting point');
  await f.refused(f.alice, 'interview_read', { roundId, personId: f.b });
  await f.call(f.bob, 'interview_share', { roundId });
  await f.refused(f.alice, 'interview_assign', { roundId, personId: f.b, itemId: item.itemId });
  interview = await f.call(f.alice, 'interview_read', { roundId, personId: f.b }); assert.equal(interview.text, 'Confidential draft');
  const secret = await f.call(f.alice, 'library_add', { journeyId: f.journeyId, name: 'Alice only', visibility: 'private', text: 'Alice secret' });
  await f.refused(f.alice, 'interview_assign', { roundId, personId: f.b, itemId: secret.itemId });
});

test('sensemaking: only participants contribute while open or synthesising, append exact person-attributed versions', async t => {
  const f = await fixture(t), roundId = (await f.create({ participants: [f.b] })).roundId;
  await f.refused(f.bob, 'round_contribute', { roundId, text: 'Too early' });
  await f.open(roundId);
  await f.refused(f.alice, 'round_contribute', { roundId, text: 'Facilitator not participant' });
  await f.call(f.bob, 'round_contribute', { roundId, text: 'First view' });
  await f.call(f.alice, 'round_status', { roundId, to: 'synthesising' });
  await Promise.all(['Second view', 'Third view'].map(text => f.call(f.bob, 'round_contribute', { roundId, text })));
  const read = await f.call(f.bob, 'round_read', { roundId }), doc = read.document as Data;
  assert.equal(doc.version, 4); assert.equal(read.contributions, 3);
  for (const text of ['First view', 'Second view', 'Third view', f.b]) assert.ok(String(doc.text).includes(text), text);
  assert.equal(rows(read, 'contributionSummary').find(p => p.personId === f.b)!.count, 3);
  await f.call(f.alice, 'round_status', { roundId, to: 'closed' });
  await f.refused(f.bob, 'round_contribute', { roundId, text: 'Too late' });
});

test('sensemaking: bound agents intersect cards and person authority and attribute to person, never agent', async t => {
  const f = await fixture(t), roundId = (await f.create()).roundId;
  await f.open(roundId);
  const agentId = (await f.call(f.bob, 'agent_create', { name: 'Listener' })).agentId as string;
  await f.call(f.bob, 'agent_add', { journeyId: f.journeyId, agentId });
  const identity = { subject: 'bob', clientId: 'test-client' }, change = { kind: 'bind' as const, clientId: 'assistant', agentId };
  const { challenge } = await f.backend.beginAuthorization(identity, change);
  await f.backend.completeAuthorization(identity, change, { id: 'synthetic', rawId: 'synthetic', type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: challenge, authenticatorData: '', signature: 'test-valid' } });
  const bound = await f.connect('bob', 'assistant');
  await f.refused(bound, 'round_contribute', { roundId, text: 'Empty card' });
  await f.refused(bound, 'interview_read', { roundId });
  await setAgentCard(f.backend, 'bob', agentId, ['round.contribute']);
  const receipt = await f.call(bound, 'round_contribute', { roundId, text: 'My person says this' });
  assert.equal(receipt.document, undefined); assert.equal(receipt.personId, f.b);
  await f.call(bound, 'interview_write', { roundId, text: 'Own agent notes' });
  await f.refused(bound, 'round_read', { roundId });
  await setAgentCard(f.backend, 'bob', agentId, ['round.contribute', 'read', 'round.create', 'round.run']);
  assert.equal((await f.call(bound, 'interview_read', { roundId })).text, 'Own agent notes');
  await f.refused(bound, 'round_create', { journeyId: f.journeyId, title: 'Read role', goal: 'Cannot create' });
  await f.refused(bound, 'round_status', { roundId, to: 'synthesising' });
  const doc = (await f.call(f.alice, 'round_read', { roundId })).document as Data;
  assert.ok(String(doc.text).includes(f.b)); assert.ok(!String(doc.text).includes(agentId));
  await f.call(f.bob, 'agent_narrow', { agentId, remove: ['round.contribute'] });
  await f.refused(bound, 'round_contribute', { roundId, text: 'Withdrawn' });
  await f.call(f.alice, 'journey_remove', { journeyId: f.journeyId, memberId: f.b });
  await f.refused(bound, 'interview_read', { roundId });
});

test('sensemaking: validates references, private artifacts, participants, oversized and forged inputs without writes', async t => {
  const f = await fixture(t);
  await f.refused(f.bob, 'round_create', { journeyId: f.journeyId, title: 'Read role', goal: 'No' });
  for (const input of [{ participants: [f.e] }, { participants: ['agent_fake'] }, { guidanceItemId: 'missing' }, { documentItemId: 'missing' }, { relatedItemIds: ['missing'] }]) await f.refused(f.alice, 'round_create', { journeyId: f.journeyId, title: 'Bad', goal: 'No', ...input });
  const secret = await f.call(f.alice, 'library_add', { journeyId: f.journeyId, name: 'Secret', visibility: 'private', text: 'No' });
  await f.refused(f.alice, 'round_create', { journeyId: f.journeyId, title: 'Bad', goal: 'No', relatedItemIds: [secret.itemId] });
  const roundId = (await f.create()).roundId; await f.open(roundId);
  for (const extra of [{ actor: f.a }, { personId: f.a }, { canContribute: true }, { text: '😀'.repeat(65537) }]) await f.refused(f.bob, 'round_contribute', { roundId, text: 'No', ...extra });
  await f.refused(f.bob, 'interview_write', { roundId, text: 'x'.repeat(262145) });
  await f.refused(f.eve, 'round_list', { journeyId: f.journeyId });
  await f.refused(f.eve, 'round_read', { roundId });
});

test('sensemaking: supplied artifacts, subset participants and deleted or newly private references stay safe', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  const guidance = await f.call(f.alice, 'library_add', { journeyId, name: 'Heading script', kind: 'prompt', text: 'Where next?' });
  const doc = await f.call(f.alice, 'library_add', { journeyId, name: 'Heading doc', kind: 'markdown', text: 'Contribution instructions: append your heading.' });
  const related = await f.call(f.alice, 'library_add', { journeyId, name: 'Source', text: 'Reference' });
  const roundId = (await f.create({ guidanceItemId: guidance.itemId, documentItemId: doc.itemId, relatedItemIds: [related.itemId], participants: [f.b] })).roundId;
  let read = await f.call(f.bob, 'round_read', { roundId }); assert.equal((read.guidance as Data).itemId, guidance.itemId); assert.equal((read.document as Data).itemId, doc.itemId); assert.equal(rows(read, 'related')[0]!.itemId, related.itemId);
  await f.call(f.alice, 'library_update', { itemId: related.itemId, visibility: 'private' });
  read = await f.call(f.bob, 'round_read', { roundId }); assert.deepEqual(read.related, []); assert.ok(!JSON.stringify(read).includes(related.itemId as string));
  await f.call(f.alice, 'library_delete', { itemId: doc.itemId }); await f.open(roundId);
  await f.refused(f.bob, 'round_contribute', { roundId, text: 'Deleted doc' });
});

test('sensemaking: private chunk storage and contribution transaction roll back and survive DO reload', async t => {
  const f = await fixture(t), roundId = (await f.create()).roundId; await f.open(roundId);
  const notes = 'Private words '.repeat(10000);
  await f.call(f.bob, 'interview_write', { roundId, text: notes });
  const store = f.backend.journeyStores.get(f.journeyId)!, original = store.put.bind(store);
  assert.ok(!store.data.get('journey')!.includes(notes));
  assert.ok([...store.data.values()].every(value => new TextEncoder().encode(value).length < 128 * 1024));
  store.put = async (key, value) => { await original(key, value); if (key.includes('libraryText')) throw new Error('Injected contribution write failure'); };
  await f.refused(f.bob, 'round_contribute', { roundId, text: 'Must roll back' }); store.put = original;
  const response = await new Journey({ storage: store }).fetch(new Request('https://internal/', { method: 'POST', body: JSON.stringify({ personId: f.b, tool: 'interview_read', input: { roundId } }) }));
  assert.equal(response.status, 200); assert.equal((await response.json() as { value: Data }).value.text, notes);
  const read = await f.call(f.alice, 'round_read', { roundId }); assert.equal(read.contributions, 0); assert.equal((read.document as Data).version, 1);
});

test('sensemaking: console renders escaped read-only round summaries without private interview notes', async t => {
  const f = await fixture(t), roundId = (await f.create({ title: '<script>round</script>', goal: '<b>goal</b>' })).roundId;
  await f.call(f.bob, 'interview_write', { roundId, text: 'Never render private notes' });
  const html = await journeyPage(f.backend, { subject: 'alice', clientId: 'console-test' }, f.journeyId, 'csrf');
  assert.match(html, /&lt;script&gt;round&lt;\/script&gt;/); assert.match(html, /&lt;b&gt;goal&lt;\/b&gt;/); assert.match(html, /planned/);
  assert.ok(!html.includes('Never render private notes')); assert.ok(!html.includes('action="/console/round'));
});
