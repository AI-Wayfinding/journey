import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLocalJWKSet } from 'jose';
import { MemoryBackend } from '../src/backend.ts';
import { createVerifier } from '../src/auth.ts';
import { app, bridge, ISSUER, keyPair, RESOURCE, token } from './helpers.ts';
import type { CardChange, PasskeyVerifier } from '../src/agents.ts';

const signer = await keyPair('agents');
type Data = Record<string, unknown>;
const verifier: PasskeyVerifier = { async verify(assertion, challenge) {
  if (assertion.response.clientDataJSON !== challenge || assertion.response.signature !== 'valid') throw new Error('Bad assertion');
  return { credentialId: 'test-passkey', counter: 0 };
} };
async function fixture(t: TestContext) {
  const backend = new MemoryBackend({ async get(s) { return { name: s, email: `${s}@example.test` }; } }, () => Date.now(), verifier);
  async function connect(sub: string, clientId: string) {
    const client = new Client({ name: 'agents-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: bridge(app(signer, backend)), requestInit: { headers: { authorization: `Bearer ${await token(signer, { sub, client_id: clientId })}` } } }));
    t.after(() => client.close()); return client;
  }
  async function call(c: Client, name: string, input: Data = {}) {
    const r = await c.callTool({ name, arguments: input }); assert.notEqual(r.isError, true, JSON.stringify(r)); return r.structuredContent as Data;
  }
  async function refused(c: Client, name: string, input: Data = {}) {
    const before = backend.snapshot(); const r = await c.callTool({ name, arguments: input }); assert.equal(r.isError, true, JSON.stringify(r)); assert.equal(backend.snapshot(), before);
  }
  const person = await connect('alice', 'console'), bound = await connect('alice', 'assistant');
  await call(person, 'account_read');
  const agentId = (await call(person, 'agent_create', { name: 'Scout' })).agentId as string;
  const journeyId = (await call(person, 'journey_create', { name: 'Agents', policy: 'open' })).journeyId as string;
  await call(person, 'agent_add', { journeyId, agentId });
  const identity = { subject: 'alice', clientId: 'console' };
  const assertion = (challenge: string) => ({ id: 'test-passkey', rawId: 'test-passkey', type: 'public-key' as const, clientExtensionResults: {}, response: { clientDataJSON: challenge, authenticatorData: '', signature: 'valid' } });
  async function authorize(change: CardChange) {
    const { challenge } = await backend.beginAuthorization(identity, change);
    return backend.completeAuthorization(identity, change, assertion(challenge));
  }
  await authorize({ kind: 'bind', clientId: 'assistant', agentId });
  return { backend, person, bound, agentId, journeyId, call, refused, identity, assertion, authorize, connect };
}

test('agents: token client_id is distinct from the authenticated subject and required', async () => {
  const v = createVerifier({ issuer: ISSUER, resource: RESOURCE, getKey: createLocalJWKSet(signer.jwks) });
  const auth = await v.verifyAccessToken(await token(signer, { sub: 'alice', client_id: 'app-a' }));
  assert.equal(auth.clientId, 'app-a'); assert.equal(auth.extra?.sub, 'alice');
  for (const client_id of [undefined, '', 42]) await assert.rejects(v.verifyAccessToken(await token(signer, { client_id })));
});

test('agents: empty card refuses journey and account capabilities and bound clients cannot escape', async t => {
  const f = await fixture(t);
  for (const [name, args] of [
    ['journey_read', { journeyId: f.journeyId }], ['journey_create', { name: 'No' }], ['account_update', { nickname: 'No' }],
    ['journey_policy', { journeyId: f.journeyId, policy: 'open', defaultRole: 'write' }],
    ['artifact_create', { journeyId: f.journeyId, name: 'No', type: 'note', size: 1 }],
    ['agent_create', { name: 'Escape' }], ['agent_remove', { agentId: f.agentId }],
    ['journey_read', { journeyId: f.journeyId, actingAgent: 'another-agent' }],
  ] as const) await f.refused(f.bound, name, args);
  assert.deepEqual((await f.call(f.bound, 'client_list')).clientId, 'assistant');
  assert.equal((await f.call(f.bound, 'client_list')).actingAgent, f.agentId);
  await assert.rejects(f.backend.beginAuthorization({ subject: 'alice', clientId: 'assistant' }, { kind: 'card', agentId: f.agentId, capabilities: ['read'] }));
});

test('agents: verified post-only card posts with agent attribution and grants nothing else', async t => {
  const f = await fixture(t);
  const project = (await f.call(f.person, 'project_create', { journeyId: f.journeyId, name: 'Discussion', purpose: 'Test' })).projects as Data[];
  const input = { journeyId: f.journeyId, target: { projectId: project[0]!.projectId }, body: 'From Scout' };
  await f.refused(f.bound, 'conversation_post', input);
  await f.authorize({ kind: 'card', agentId: f.agentId, capabilities: ['post'] });
  const result = await f.call(f.bound, 'conversation_post', input);
  assert.equal(result.author, f.agentId); assert.equal(result.authorKind, 'agent'); assert.equal(result.body, 'From Scout');
  await f.refused(f.bound, 'journey_read', { journeyId: f.journeyId });
  await f.refused(f.bound, 'journey_create', { name: 'No' });
  await f.refused(f.bound, 'account_update', { nickname: 'No' });
  await f.call(f.person, 'agent_narrow', { agentId: f.agentId, remove: ['post', 'journey.create'] });
  await f.refused(f.bound, 'conversation_post', input);
});

test('agents: widening requires fresh assertion over the exact card and is absent from MCP', async t => {
  const f = await fixture(t);
  const change: CardChange = { kind: 'card', agentId: f.agentId, capabilities: ['post'] };
  await assert.rejects(f.backend.completeAuthorization(f.identity, change, undefined));
  const { challenge } = await f.backend.beginAuthorization(f.identity, change);
  await assert.rejects(f.backend.completeAuthorization(f.identity, { ...change, capabilities: ['read'] }, f.assertion(challenge)));
  await f.backend.completeAuthorization(f.identity, change, f.assertion(challenge));
  await assert.rejects(f.backend.completeAuthorization(f.identity, change, f.assertion(challenge)));
  const tools = (await f.person.listTools()).tools.map(x => x.name);
  for (const name of ['agent_create', 'agent_list', 'agent_capabilities', 'agent_narrow', 'agent_remove', 'client_list']) assert.ok(tools.includes(name));
  for (const name of ['agent_widen', 'client_bind', 'client_unbind']) assert.equal(tools.includes(name), false);
  await assert.rejects(f.person.callTool({ name: 'agent_widen', arguments: { agentId: f.agentId, capabilities: ['read'] } }));
  await assert.rejects(f.person.callTool({ name: 'client_bind', arguments: { clientId: 'assistant', agentId: f.agentId } }));
  await f.refused(f.person, 'agent_card', { agentId: f.agentId, action: 'sign', capabilities: ['read'] });
  await f.refused(f.person, 'agent_narrow', { agentId: f.agentId, remove: [], capabilities: ['read'] });
  await assert.rejects(f.backend.beginAuthorization(f.identity, { kind: 'card', agentId: f.agentId, capabilities: ['grant.issue'] }));
});

test('agents: removing an agent tombstones bound clients without person fallback', async t => {
  const f = await fixture(t);
  await f.authorize({ kind: 'card', agentId: f.agentId, capabilities: ['journey.create', 'account.nickname', 'read'] });
  await f.call(f.bound, 'account_update', { nickname: 'Delegated' });
  const nicknameResult = await f.call(f.bound, 'account_update', { nickname: 'Delegated again' });
  assert.equal(nicknameResult.email, undefined); assert.equal(nicknameResult.subject, undefined);
  const created = await f.call(f.bound, 'journey_create', { name: 'Delegated' });
  const members = created.members as Data[];
  assert.equal(members.find(m => m.memberId === f.agentId)!.kind, 'agent');
  assert.equal(members.find(m => m.memberId === f.agentId)!.guide, false);
  await f.call(f.person, 'agent_remove', { agentId: f.agentId });
  await f.refused(f.bound, 'account_update', { nickname: 'Escape' });
  await f.refused(f.bound, 'journey_create', { name: 'Escape' });
  await f.refused(f.bound, 'journey_read', { journeyId: f.journeyId });
  await f.refused(f.bound, 'client_list');
});

test('agents: removing a person from a journey stops their bound agent immediately', async t => {
  const f = await fixture(t), guide = await f.connect('bob', 'bob-app');
  const bob = (await f.call(guide, 'account_read')).personId;
  await f.call(guide, 'journey_join', { journeyId: f.journeyId });
  await f.call(f.person, 'journey_guide', { journeyId: f.journeyId, personId: bob });
  await f.authorize({ kind: 'card', agentId: f.agentId, capabilities: ['read'] });
  await f.call(f.bound, 'journey_read', { journeyId: f.journeyId });
  const alice = (await f.call(f.person, 'account_read')).personId;
  await f.call(guide, 'journey_remove', { journeyId: f.journeyId, memberId: alice });
  await f.refused(f.bound, 'journey_read', { journeyId: f.journeyId });
  await f.refused(f.bound, 'apps_journey_refresh', { journeyId: f.journeyId });
  await assert.rejects(f.bound.readResource({ uri: `wayfinding://journey/${f.journeyId}/inbox` }));
});

test('agents: asserted bindings and cards survive recreated Durable Object adapters', async t => {
  const { Accounts, Journey, durableBackend } = await import('../src/objects.ts');
  const { AccountsHost } = await import('../src/accounts.ts');
  const { MemoryStorage } = await import('../src/storage.ts');
  const { MemoryBlobs } = await import('../src/relay.ts');
  const { parseCommand } = await import('../src/commands.ts');
  const storage = new MemoryStorage(), blobs = new MemoryBlobs(), journeys = new Map<string, InstanceType<typeof MemoryStorage>>();
  await new AccountsHost(storage, { async get() { return { name: 'Alice', email: 'alice@example.test' }; } }).provision('alice');
  const backend = durableBackend({ WORKOS_API_KEY: 'unused', BLOBS: blobs,
    ACCOUNTS: { getByName() { return { fetch: request => new Accounts({ storage }, { WORKOS_API_KEY: 'unused', BLOBS: blobs }, verifier).fetch(request) }; } },
    JOURNEYS: { getByName(id) { let store = journeys.get(id); if (!store) { store = new MemoryStorage(); journeys.set(id, store); } const saved = store;
      return { fetch: request => new Journey({ storage: saved }, { BLOBS: blobs }).fetch(request) }; } },
  });
  const agentId = (await backend.execute('alice', parseCommand('agent_create', { name: 'Persistent' }), 'console')).agentId as string;
  const identity = { subject: 'alice', clientId: 'console' };
  for (const change of [{ kind: 'card', agentId, capabilities: ['account.nickname'] }, { kind: 'bind', agentId, clientId: 'assistant' }] as CardChange[]) {
    const { challenge } = await backend.beginAuthorization(identity, change);
    await backend.completeAuthorization(identity, change, { id: 'test-passkey', rawId: 'test-passkey', type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: challenge, authenticatorData: '', signature: 'valid' } });
  }
  const client = new Client({ name: 'durable-agents', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: bridge(app(signer, backend)), requestInit: { headers: { authorization: `Bearer ${await token(signer, { sub: 'alice', client_id: 'assistant' })}` } } }));
  t.after(() => client.close());
  const result = await client.callTool({ name: 'account_update', arguments: { nickname: 'Persistent nickname' } });
  assert.deepEqual(result.structuredContent, { nickname: 'Persistent nickname', actingAgent: agentId });
  const refused = await client.callTool({ name: 'journey_create', arguments: { name: 'No card' } });
  assert.equal(refused.isError, true);
  await backend.execute('alice', parseCommand('agent_remove', { agentId }), 'console');
  assert.equal((await client.callTool({ name: 'account_update', arguments: { nickname: 'Escape' } })).isError, true);
});

test('agents: newer challenge invalidates older assertions for the same card', async t => {
  const f = await fixture(t);
  const change: CardChange = { kind: 'card', agentId: f.agentId, capabilities: ['read'] };
  const older = await f.backend.beginAuthorization(f.identity, change);
  const newer = await f.backend.beginAuthorization(f.identity, change);
  await assert.rejects(f.backend.completeAuthorization(f.identity, change, f.assertion(older.challenge)));
  await f.backend.completeAuthorization(f.identity, change, f.assertion(newer.challenge));
  assert.deepEqual((await f.call(f.person, 'agent_capabilities', { agentId: f.agentId })).capabilities, ['read']);
});

test('agents: bound identity cannot be replaced by another live owned agent with a more powerful card', async t => {
  const f = await fixture(t);
  const other = (await f.call(f.person, 'agent_create', { name: 'Powerful sibling' })).agentId as string;
  await f.call(f.person, 'agent_add', { journeyId: f.journeyId, agentId: other });
  await f.authorize({ kind: 'card', agentId: other, capabilities: ['read'] });
  await f.authorize({ kind: 'card', agentId: f.agentId, capabilities: ['read'] });
  await f.call(f.bound, 'journey_read', { journeyId: f.journeyId });
  await f.refused(f.bound, 'journey_read', { journeyId: f.journeyId, actingAgent: other });
});

test('agents: client binding and unbinding need exact fresh assertions and cannot be retargeted', async t => {
  const f = await fixture(t);
  const unbind: CardChange = { kind: 'unbind', clientId: 'assistant', agentId: f.agentId };
  await assert.rejects(f.backend.completeAuthorization(f.identity, unbind, undefined));
  const { challenge } = await f.backend.beginAuthorization(f.identity, unbind);
  await assert.rejects(f.backend.completeAuthorization(f.identity, { kind: 'unbind', clientId: 'console', agentId: f.agentId }, f.assertion(challenge)));
  await assert.rejects(f.backend.completeAuthorization(f.identity, unbind, { ...f.assertion(challenge), response: { ...f.assertion(challenge).response, signature: 'bad' } }));
  await f.backend.completeAuthorization(f.identity, unbind, f.assertion(challenge));
  await f.call(f.bound, 'account_update', { nickname: 'Person again' });
  assert.equal((await f.call(f.person, 'account_read')).nickname, 'Person again');
  await assert.rejects(f.backend.completeAuthorization(f.identity, unbind, f.assertion(challenge)));
  const foreign = await f.connect('eve', 'eve-console');
  await f.call(foreign, 'account_read');
  await assert.rejects(f.backend.beginAuthorization({ subject: 'eve', clientId: 'eve-console' }, { kind: 'bind', clientId: 'assistant', agentId: f.agentId }));
});

test('agents: account removal is a tombstone and stops every bound account and journey operation', async t => {
  const f = await fixture(t);
  await f.authorize({ kind: 'card', agentId: f.agentId, capabilities: ['read', 'journey.create', 'account.nickname'] });
  await f.call(f.bound, 'journey_read', { journeyId: f.journeyId });
  await f.backend.accountsHost.removePerson('alice');
  await f.refused(f.bound, 'journey_read', { journeyId: f.journeyId });
  await f.refused(f.bound, 'account_update', { nickname: 'No resurrection' });
  await f.refused(f.bound, 'journey_create', { name: 'No resurrection' });
  await f.refused(f.person, 'account_read');
  await assert.rejects(f.backend.beginAuthorization(f.identity, { kind: 'card', agentId: f.agentId, capabilities: ['read'] }));
});

test('agents: every catalogue capability is denied by an empty card and narrowing cannot add any', async t => {
  const f = await fixture(t);
  const { capabilities } = await import('../../rules/src/capabilities.ts');
  const { allows } = await import('../src/agents.ts');
  const person = (await f.backend.accountsHost.lookup('alice'))!;
  const actor = await f.backend.accountsHost.resolveActor(person.personId, 'assistant');
  for (const cap of capabilities) assert.equal(allows(actor, cap.name, true), false, cap.name);
  await f.call(f.person, 'agent_narrow', { agentId: f.agentId, remove: [] });
  assert.deepEqual((await f.call(f.person, 'agent_capabilities', { agentId: f.agentId })).capabilities, []);
  assert.equal(((await f.call(f.person, 'agent_list')).agents as Data[])[0]!.agentId, f.agentId);
  await f.refused(f.person, 'agent_create', { name: 'Not assignable', capabilities: ['read'] });
  await f.refused(f.person, 'agent_narrow', { agentId: f.agentId, remove: ['passkey.manage'] });
});

test('agents: a bound client cannot use Apps, inbox or SEP tasks with its person permissions', async t => {
  const f = await fixture(t);
  const created = await f.call(f.person, 'task_create', { journeyId: f.journeyId, name: 'Private task', maxRounds: 2, deadline: Date.now() + 60_000 });
  const taskId = (created.tasks as Data[])[0]!.taskId;
  await f.refused(f.bound, 'apps_journey_refresh', { journeyId: f.journeyId });
  await assert.rejects(f.bound.readResource({ uri: `wayfinding://journey/${f.journeyId}/inbox` }));
  const { default: z } = await import('zod');
  const _meta = { 'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } } };
  await assert.rejects(f.bound.request({ method: 'tasks/get', params: { taskId, _meta } }, z.record(z.string(), z.unknown())));
  await f.authorize({ kind: 'card', agentId: f.agentId, capabilities: ['read'] });
  assert.equal((await f.call(f.bound, 'journey_read', { journeyId: f.journeyId, actingAgent: f.agentId })).journeyId, f.journeyId);
  await f.call(f.person, 'agent_narrow', { agentId: f.agentId, remove: ['read'] });
  await f.refused(f.bound, 'apps_journey_refresh', { journeyId: f.journeyId });
});

test('agents: expired assertions cannot widen a card and real WebAuthn refuses unknown credentials', async t => {
  const f = await fixture(t);
  const change: CardChange = { kind: 'card', agentId: f.agentId, capabilities: ['read'] };
  const { challenge } = await f.backend.beginAuthorization(f.identity, change);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 300_001);
  await assert.rejects(f.backend.completeAuthorization(f.identity, change, f.assertion(challenge)));
  const { WebAuthnVerifier } = await import('../src/agents.ts');
  await assert.rejects(new WebAuthnVerifier().verify(f.assertion(challenge), challenge, []), /Unknown passkey/);
});
