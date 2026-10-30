import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { app, bridge, keyPair, RESOURCE, token, addAgent, setAgentCard, testPasskeys } from './helpers.ts';
import { Accounts, Journey, durableBackend } from '../src/objects.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryBlobs } from '../src/relay.ts';
import { TOOL_NAMES } from '../src/commands.ts';

const signer = await keyPair('names');
type Data = Record<string, unknown>;
type Member = { memberId: string; name: string; kind: string };
type Pending = { personId: string; name: string; status: string };

// Exercise the public MCP tools through the real, recreated Durable Object adapters.
async function fixture(t: TestContext) {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const subject = String(input).split('/').at(-1)!;
    return Response.json({ id: subject, email: `${subject}@example.test`, first_name: subject === 'nameless' ? '' : subject.toUpperCase() });
  });
  const storage = new MemoryStorage(), stores = new Map<string, MemoryStorage>();
  const blobs = new MemoryBlobs();
  let emailLookups = 0;
  const backend = durableBackend({ WORKOS_API_KEY: 'synthetic', BLOBS: blobs,
    ACCOUNTS: { getByName() { return { async fetch(request) {
      const body = await request.clone().json() as Data;
      if (body.action === 'personIdByEmail') emailLookups++;
      return new Accounts({ storage }, { WORKOS_API_KEY: 'synthetic', BLOBS: blobs }, testPasskeys).fetch(request);
    } }; } },
    JOURNEYS: { getByName(id) { let store = stores.get(id); if (!store) { store = new MemoryStorage(); stores.set(id, store); }
      return { fetch: (request) => new Journey({ storage: store }, { BLOBS: blobs }).fetch(request) };
    } },
  });
  const snapshot = () => JSON.stringify({ accounts: [...storage.data], journeys: [...stores].map(([id, s]) => [id, [...s.data]]), writes: [storage.writes, ...[...stores.values()].map(s => s.writes)] });
  async function connect(sub: string, mode: 'auto' | 'legacy' = 'auto') {
    const client = new Client({ name: 'names-test', version: '1.0.0' }, { versionNegotiation: { mode } });
    await client.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: bridge(app(signer, backend)), requestInit: { headers: { authorization: `Bearer ${await token(signer, { sub })}` } } }));
    t.after(() => client.close());
    return client;
  }
  async function call(client: Client, name: string, args: Data = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent as Data;
  }
  async function refused(client: Client, name: string, args: Data, message?: string) {
    const before = snapshot();
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, JSON.stringify(result));
    if (message !== undefined) assert.deepEqual(result.content, [{ type: 'text', text: message }]);
    assert.equal(snapshot(), before, 'Refusals must not write any state');
  }
  const alice = await connect('alice'), bob = await connect('bob', 'legacy'), eve = await connect('eve');
  const a = (await call(alice, 'account_read')).personId as string;
  const b = (await call(bob, 'account_read')).personId as string;
  await call(eve, 'account_read');
  return { backend, alice, bob, eve, a, b, call, refused, connect, storage, stores, emailLookups: () => emailLookups };
}

test('names: nickname is strict, trimmed, persistent after eviction and returned on account_read', async t => {
  const f = await fixture(t);
  const old = await f.call(f.alice, 'account_read');
  assert.equal(old.name, 'ALICE');
  assert.equal(old.nickname, undefined);
  const changed = await f.call(f.alice, 'account_update', { nickname: '  Ally  ' });
  assert.equal(changed.nickname, 'Ally');
  assert.equal((await f.call(await f.connect('alice'), 'account_read')).nickname, 'Ally');
  assert.equal((await f.call(f.alice, 'account_read')).name, 'ALICE');
  for (const args of [{ nickname: '' }, { nickname: '   ' }, { nickname: 'a'.repeat(81) }, { nickname: 'Ally', personId: f.b }]) {
    await f.refused(f.alice, 'account_update', args);
  }
  await f.call(f.alice, 'account_update', { nickname: 'a'.repeat(80) });
  assert.equal((await f.call(f.alice, 'account_read')).nickname, 'a'.repeat(80));
  assert.equal((await f.call(f.bob, 'account_read')).nickname, undefined);
});

test('names: every journey state response resolves current people names, preserves agents and hides emails', async t => {
  const f = await fixture(t);
  const created = await f.call(f.alice, 'journey_create', { name: 'Names', policy: 'request' });
  const journeyId = created.journeyId as string;
  assert.equal((created.members as Member[])[0]!.name, 'ALICE');
  await f.call(f.bob, 'journey_request', { journeyId });
  const pending = await f.call(f.alice, 'journey_read', { journeyId });
  assert.deepEqual(pending.pending, [{ personId: f.b, name: 'BOB', status: 'requested' }]);
  await f.call(f.bob, 'account_update', { nickname: 'Bobby' });
  assert.equal(((await f.call(f.alice, 'journey_read', { journeyId })).pending as Pending[])[0]!.name, 'Bobby');
  const admitted = await f.call(f.alice, 'journey_admit', { journeyId, personId: f.b });
  assert.equal((admitted.members as Member[]).find(m => m.memberId === f.b)!.name, 'Bobby');
  const added = await addAgent(f.backend, 'bob', journeyId, 'Scout', ["read","task.manage"]);
  assert.equal((added.members as Member[]).find(m => m.kind === 'agent')!.name, 'Scout');
  const before = f.stores.get(journeyId)!.data.get('journey');
  await f.call(f.bob, 'account_update', { nickname: 'Robert' });
  assert.equal(f.stores.get(journeyId)!.data.get('journey'), before);
  const read = await f.call(f.alice, 'journey_read', { journeyId });
  assert.equal((read.members as Member[]).find(m => m.memberId === f.b)!.name, 'Robert');
  assert.doesNotMatch(JSON.stringify(read), /alice@example.test|bob@example.test|"email"/);
  const nameless = await f.connect('nameless');
  const personId = (await f.call(nameless, 'account_read')).personId as string;
  const invited = await f.call(f.alice, 'journey_invite', { journeyId, personId });
  assert.doesNotMatch(JSON.stringify(invited), /nameless@example.test/);
  assert.equal((invited.pending as Pending[])[0]!.name, 'Wayfinding member');
});

test('names: email invites match exactly ignoring case and non-guides cannot trigger account lookup', async t => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Invites', policy: 'invite' })).journeyId as string;
  const missing = 'No Wayfinding account uses that email yet; ask them to sign in once, then invite again';
  await f.refused(f.eve, 'journey_invite', { journeyId, email: 'bob@example.test' }, 'Only guides may invite');
  await f.refused(f.eve, 'journey_invite', { journeyId, email: 'missing@example.test' }, 'Only guides may invite');
  assert.equal(f.emailLookups(), 0);
  await f.refused(await f.connect('new-user'), 'journey_invite', { journeyId, email: 'bob@example.test' }, 'Only guides may invite');
  assert.equal(f.emailLookups(), 0);
  await f.refused(f.alice, 'journey_invite', { journeyId, email: 'bob@example.test', personId: f.a });
  await f.refused(f.alice, 'journey_invite', { journeyId });
  await f.refused(f.alice, 'journey_invite', { journeyId, email: 'not-an-email' });
  assert.equal(f.emailLookups(), 0);
  await f.refused(f.alice, 'journey_invite', { journeyId, email: 'ob@example.test' }, missing);
  await f.refused(f.alice, 'journey_invite', { journeyId, email: 'missing@example.test' }, missing);
  const invited = await f.call(f.alice, 'journey_invite', { journeyId, email: 'BOB@EXAMPLE.TEST' });
  assert.deepEqual(invited.pending, [{ personId: f.b, name: 'BOB', status: 'invited' }]);
  assert.equal(f.emailLookups(), 3, 'The lookup counter must observe successful and unsuccessful guide lookups');
  await f.refused(f.alice, 'journey_invite', { journeyId, email: 'bob@example.test' });
  const joined = await f.call(f.bob, 'journey_join', { journeyId });
  assert.deepEqual((joined.members as Member[]).map(m => m.memberId), [f.a, f.b]);
  const lookups = f.emailLookups();
  await f.refused(f.bob, 'journey_invite', { journeyId, email: 'eve@example.test' }, 'Only guides may invite');
  assert.equal(f.emailLookups(), lookups);
  for (const tool of ['journey_admit', 'journey_refuse', 'journey_role', 'journey_guide', 'journey_unguide']) {
    await f.refused(f.alice, tool, { journeyId, email: 'eve@example.test', ...(tool === 'journey_role' ? { role: 'read' } : {}) });
  }
  const agentState = await addAgent(f.backend, 'alice', journeyId, 'Limited', ["read","task.manage"]);
  const agentId = (agentState.members as Member[]).find(m => m.kind === 'agent')!.memberId;
  await f.refused(f.alice, 'journey_invite', { journeyId, actingAgent: agentId, email: 'eve@example.test' }, 'Only guides may invite');
  assert.equal(f.emailLookups(), lookups);
  await f.refused(f.alice, 'journey_invite', { journeyId, actingAgent: 'agent_unknown', email: 'eve@example.test' }, 'Only guides may invite');
  assert.equal(f.emailLookups(), lookups);
  await setAgentCard(f.backend, 'alice', agentId, ['member.invite']);
  assert.deepEqual(await f.call(f.alice, 'journey_invite', { journeyId, actingAgent: agentId, email: 'eve@example.test' }), { journeyId, accepted: true });
});

test('names: every advertised coordination tool has a meaningful description', async t => {
  const f = await fixture(t);
  const tools = (await f.alice.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === 'account_update'));
  assert.equal(tools.filter(tool => TOOL_NAMES.includes(tool.name as typeof TOOL_NAMES[number])).length, TOOL_NAMES.length);
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 25, tool.name);
    assert.doesNotMatch(tool.description, /undefined/, tool.name);
    assert.doesNotMatch(tool.description, /^Wayfinding:/, tool.name);
    assert.notEqual(tool.description.split('. ')[0], tool.name.replaceAll('_', ' '), tool.name);
  }
  const relayTools = tools.filter(tool => TOOL_NAMES.includes(tool.name as typeof TOOL_NAMES[number]) && /^(artifact_|mls_|personal_group_)/.test(tool.name));
  assert.ok(relayTools.some(tool => tool.name === 'artifact_blob_get'));
  for (const tool of relayTools) assert.match(tool.description!, /Relay data is opaque base64/);
});
