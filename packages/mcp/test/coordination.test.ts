import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod';
import { app, bridge, keyPair, RESOURCE, token, addAgent, setAgentCard, testPasskeys } from './helpers.ts';
import { MemoryBackend } from '../src/backend.ts';
import type { JourneyState } from '../src/journey.ts';
import { RULES } from '../src/rules.ts';
import lock from '../../rules/rules.lock.json' with { type: 'json' };
import { AccountsHost } from '../src/accounts.ts';
import { Backend } from '../src/backend.ts';
import { Journey } from '../src/objects.ts';
import { MemoryStorage } from '../src/storage.ts';

const signer = await keyPair('coordination');
type Data = Record<string, unknown>;
type Member = { memberId: string; kind: string; role: string; guide: boolean; owner?: string };
type Project = { projectId: string; purpose: string; status: string; members: string[] };
type Agent = { agentId: string; signed: boolean; write: boolean };
type Grant = { grantId: string; status: string; usesLeft: number };
type Artifact = { artifactId: string; name: string; size: number; version: number; deleted: boolean };
type Task = { taskId: string; status: string; roundsUsed: number };
const list = <T>(data: Data, key: string): T[] => data[key] as T[];

async function fixture(t: TestContext) {
  let now = 1000;
  let lookups = 0;
  const backend = new MemoryBackend({ async get(subject) { lookups++; return { name: subject.toUpperCase(), email: `${subject}@example.test` }; } }, () => now, testPasskeys);
  const wire: { method: string; result?: Data; error?: Data }[] = [];
  const target = bridge(app(signer, backend));
  const send: typeof target = async (url, init) => {
    const response = await target(url, init);
    const request = typeof init?.body === 'string' ? JSON.parse(init.body) as { method: string } : undefined;
    if (request?.method.startsWith('tasks/')) {
      const text = await response.clone().text();
      const json = text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find((line) => line.startsWith('data:'))!.slice(5) : text;
      const body = JSON.parse(json) as { result?: Data; error?: Data };
      wire.push({ method: request.method, result: body.result, error: body.error });
    }
    return response;
  };
  async function connect(sub: string, mode: 'auto' | 'legacy' = 'auto') {
    const client = new Client({ name: 'coordination-test', version: '1.0.0' }, { versionNegotiation: { mode }, capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } } });
    await client.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: send, requestInit: { headers: { authorization: `Bearer ${await token(signer, { sub })}` } } }));
    t.after(() => client.close());
    return client;
  }
  async function call(client: Client, name: string, args: Data = {}): Promise<Data> {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.structuredContent, `${name} must return structured data`);
    return result.structuredContent as Data;
  }
  async function refused(client: Client, name: string, args: Data) {
    const before = backend.snapshot();
    const writes = [backend.accountStorage.writes, ...[...backend.journeyStores.values()].map((s) => s.writes)];
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result.content), /refused|Only|not|Invalid|required|rules|Unrecognized|Unknown|live/i);
    assert.equal(backend.snapshot(), before, `${name} must preserve all persisted bytes`);
    assert.deepEqual([backend.accountStorage.writes, ...[...backend.journeyStores.values()].map((s) => s.writes)], writes, `${name} must not write`);
  }
  const alice = await connect('alice'), bob = await connect('bob', 'legacy'), eve = await connect('eve');
  const a = await call(alice, 'account_read'), b = await call(bob, 'account_read'), e = await call(eve, 'account_read');
  return { wire, backend, alice, bob, eve, a: a.personId as string, b: b.personId as string, e: e.personId as string, call, refused, connect, advance: (time: number) => { now = time; }, lookups: () => lookups };
}

test('coordination: SDK tools provision stable accounts from verified token subjects', async (t) => {
  const f = await fixture(t);
  const tools = (await f.alice.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(tools.slice(0, 5), ['whoami', 'account_read', 'journey_create', 'journey_list', 'journey_read']);
  const first = await f.call(f.alice, 'account_read');
  const again = await f.call(await f.connect('alice'), 'account_read');
  assert.deepEqual(again, first);
  assert.notEqual(first.personId, f.b);
  assert.equal(f.lookups(), 3);
  await f.refused(f.alice, 'account_read', { subject: 'bob', name: 'forged', email: 'fake@example.test' });
});

test('coordination: create, invite, join, roles, guides, removal and leave preserve authority', async (t) => {
  const f = await fixture(t);
  const created = await f.call(f.alice, 'journey_create', { name: 'Invite journey', policy: 'invite' });
  const journeyId = created.journeyId as string;
  assert.deepEqual(list<Member>(created, 'members').map(({ memberId, role, guide }) => ({ memberId, role, guide })), [{ memberId: f.a, role: 'write', guide: true }]);
  assert.equal((created.rulesHash as Data).journey, lock.files['generated/journey.js']);
  const store = f.backend.journeyStores.get(journeyId)!;
  assert.deepEqual((JSON.parse(store.data.get('journey')!) as JourneyState).rulesHash, RULES);
  assert.deepEqual((await f.call(f.alice, 'journey_list')).journeys, [{ journeyId, name: 'Invite journey' }]);
  assert.deepEqual((await f.call(f.bob, 'journey_list')).journeys, []);
  await f.refused(f.bob, 'journey_read', { journeyId });
  await f.refused(f.bob, 'journey_join', { journeyId });
  await f.refused(f.bob, 'journey_invite', { journeyId, personId: f.e });
  await f.refused(f.alice, 'journey_leave', { journeyId });
  await f.refused(f.alice, 'journey_remove', { journeyId, memberId: f.a });
  await f.refused(f.alice, 'journey_unguide', { journeyId, personId: f.a });
  await f.call(f.alice, 'journey_invite', { journeyId, personId: f.b });
  const joined = await f.call(f.bob, 'journey_join', { journeyId });
  assert.deepEqual(list<Member>(joined, 'members').map((m) => m.role), ['write', 'read']);
  assert.deepEqual(joined.pending, []);
  await f.refused(f.bob, 'journey_role', { journeyId, personId: f.b, role: 'write' });
  await f.refused(f.bob, 'journey_guide', { journeyId, personId: f.b });
  await f.refused(f.bob, 'journey_remove', { journeyId, memberId: f.a });
  await f.call(f.alice, 'journey_role', { journeyId, personId: f.b, role: 'write' });
  const guides = await f.call(f.alice, 'journey_guide', { journeyId, personId: f.b });
  assert.deepEqual(list<Member>(guides, 'members').map((m) => m.guide), [true, true]);
  await f.call(f.bob, 'journey_unguide', { journeyId, personId: f.a });
  const left = await f.call(f.alice, 'journey_leave', { journeyId });
  assert.deepEqual(left, { journeyId, accepted: true });
  assert.deepEqual((await f.call(f.alice, 'journey_list')).journeys, []);
  await f.refused(f.alice, 'journey_read', { journeyId });
  assert.deepEqual(list<Member>(await f.call(f.bob, 'journey_read', { journeyId }), 'members').map((m) => m.memberId), [f.b]);
});

test('coordination: request/admit/refuse and open joining use the stored default role', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Requests' })).journeyId as string;
  await f.refused(f.bob, 'journey_join', { journeyId });
  await f.call(f.bob, 'journey_request', { journeyId });
  await f.refused(f.bob, 'journey_request', { journeyId });
  await f.call(f.alice, 'journey_refuse', { journeyId, personId: f.b });
  await f.call(f.bob, 'journey_request', { journeyId });
  await f.call(f.alice, 'journey_admit', { journeyId, personId: f.b });
  await f.call(f.alice, 'journey_policy', { journeyId, policy: 'open', defaultRole: 'write' });
  const joined = await f.call(f.eve, 'journey_join', { journeyId });
  assert.equal(list<Member>(joined, 'members').find((m) => m.memberId === f.e)?.role, 'write');
  await f.call(f.alice, 'journey_remove', { journeyId, memberId: f.e });
  await f.refused(f.eve, 'journey_read', { journeyId });
});

test('coordination: projects require live project membership, preserve atomic updates and reopen archives', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Projects', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  const project = list<Project>(await f.call(f.alice, 'project_create', { journeyId, name: 'Alpha', purpose: 'First purpose' }), 'projects')[0]!;
  const projectId = project.projectId;
  assert.deepEqual(project.members, [f.a]);
  await f.refused(f.bob, 'project_update', { journeyId, projectId, purpose: 'Hijacked' });
  await f.refused(f.bob, 'project_update', { journeyId, projectId, status: 'active' });
  await f.refused(f.alice, 'project_leave', { journeyId, projectId });
  await f.call(f.bob, 'project_join', { journeyId, projectId });
  const changed = list<Project>(await f.call(f.bob, 'project_update', { journeyId, projectId, purpose: 'Shared purpose', status: 'active' }), 'projects')[0]!;
  assert.equal(changed.purpose, 'Shared purpose'); assert.equal(changed.status, 'active');
  await f.call(f.alice, 'project_leave', { journeyId, projectId });
  await f.call(f.bob, 'project_update', { journeyId, projectId, status: 'archived' });
  await f.refused(f.alice, 'project_join', { journeyId, projectId });
  await f.refused(f.bob, 'project_update', { journeyId, projectId, purpose: 'Cannot edit archive', status: 'active' });
  await f.call(f.bob, 'project_update', { journeyId, projectId, status: 'active' });
  await f.call(f.alice, 'project_join', { journeyId, projectId });
  await f.call(f.alice, 'journey_remove', { journeyId, memberId: f.b });
  await f.refused(f.bob, 'project_update', { journeyId, projectId, purpose: 'Former member' });
});

test('coordination: agent cards intersect current person authority and only owners control them', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Agents', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  let added = await addAgent(f.backend, 'bob', journeyId, 'Bob agent', ["read","task.manage","artifact.write","project.create","journey.policy","member.invite","member.admit","agent.remove"]);
  const agentId = list<Agent>(added, 'agents')[0]!.agentId;
  await f.refused(f.bob, 'artifact_create', { journeyId, actingAgent: agentId, name: 'Forbidden', type: 'note', size: 1 });
  await f.refused(f.alice, 'artifact_create', { journeyId, actingAgent: agentId, name: 'Stolen agent', type: 'note', size: 1 });
  await f.refused(f.alice, 'agent_narrow', { agentId, remove: ['artifact.write'] });
  await f.call(f.alice, 'journey_role', { journeyId, personId: f.b, role: 'write' });
  await f.call(f.bob, 'artifact_create', { journeyId, actingAgent: agentId, name: 'Allowed', type: 'note', size: 1 });
  await f.call(f.bob, 'agent_narrow', { agentId, remove: ['artifact.write'] });
  await f.refused(f.bob, 'artifact_create', { journeyId, actingAgent: agentId, name: 'Card limited', type: 'note', size: 1 });
  await f.refused(f.bob, 'journey_role', { journeyId, actingAgent: agentId, personId: f.b, role: 'write' });
  await f.call(f.bob, 'agent_card', { agentId, action: 'withdraw' });
  await f.refused(f.bob, 'journey_read', { journeyId, actingAgent: agentId });
  await setAgentCard(f.backend, 'bob', agentId, ['read']);
  added = await f.call(f.bob, 'journey_read', { journeyId });
  assert.equal((await f.call(f.bob, 'agent_capabilities', { agentId })).signed, true);
  await f.call(f.bob, 'journey_remove', { journeyId, memberId: agentId });
  await f.refused(f.bob, 'journey_read', { journeyId, actingAgent: agentId });
});

test('coordination: removing a person ends their grants and agents in the same single write', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Cleanup', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  await f.call(f.eve, 'journey_join', { journeyId });
  await f.call(f.alice, 'journey_role', { journeyId, personId: f.b, role: 'write' });
  const agentId = list<Agent>(await addAgent(f.backend, 'bob', journeyId, 'Bob agent', ["read","task.manage","artifact.write","project.create","journey.policy","member.invite","member.admit","agent.remove"]), 'agents')[0]!.agentId;
  await f.call(f.bob, 'grant_issue', { journeyId, grantee: f.e, need: 'write', resource: journeyId, uses: 3, expiresAt: 5000 });
  await f.call(f.alice, 'grant_issue', { journeyId, grantee: agentId, need: 'read', resource: journeyId, uses: 2, expiresAt: 5000 });
  const store = f.backend.journeyStores.get(journeyId)!;
  const before = store.writes;
  const removed = await f.call(f.alice, 'journey_remove', { journeyId, memberId: f.b });
  assert.equal(store.writes, before + 1);
  assert.deepEqual(list<Member>(removed, 'members').map((m) => m.memberId), [f.a, f.e]);
  assert.deepEqual(list<Grant>(removed, 'grants').map(({ status, usesLeft }) => ({ status, usesLeft })), [{ status: 'ended', usesLeft: 0 }, { status: 'ended', usesLeft: 0 }]);
  assert.equal(list<Member>(removed, 'members').some(m => m.memberId === agentId), false);
  await f.call(f.bob, 'journey_join', { journeyId });
  await f.refused(f.bob, 'journey_read', { journeyId, actingAgent: agentId });
});

test('coordination: grants enforce identity, command, resource, expiry, use count and revocation', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Grants', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  await f.call(f.eve, 'journey_join', { journeyId });
  await f.refused(f.bob, 'grant_issue', { journeyId, grantee: f.e, need: 'write', resource: journeyId, uses: 1, expiresAt: 5000 });
  const issued = await f.call(f.alice, 'grant_issue', { journeyId, grantee: f.b, need: 'write', resource: journeyId, uses: 1, expiresAt: 5000 });
  const grantId = list<Grant>(issued, 'grants')[0]!.grantId;
  await f.refused(f.eve, 'grant_use', { journeyId, grantId, need: 'write', resource: journeyId });
  await f.refused(f.bob, 'grant_use', { journeyId, grantId, need: 'read', resource: journeyId });
  await f.refused(f.bob, 'grant_use', { journeyId, grantId, need: 'write', resource: 'another-resource' });
  await f.refused(f.bob, 'grant_revoke', { journeyId, grantId });
  assert.equal(list<Grant>(await f.call(f.bob, 'grant_use', { journeyId, grantId, need: 'write', resource: journeyId }), 'grants')[0]!.usesLeft, 0);
  await f.refused(f.bob, 'grant_use', { journeyId, grantId, need: 'write', resource: journeyId });
  const second = list<Grant>(await f.call(f.alice, 'grant_issue', { journeyId, grantee: f.b, need: 'read', resource: journeyId, uses: 2, expiresAt: 2000 }), 'grants')[1]!.grantId;
  f.advance(2000);
  await f.refused(f.bob, 'grant_use', { journeyId, grantId: second, need: 'read', resource: journeyId });
  const revoked = await f.call(f.alice, 'grant_revoke', { journeyId, grantId: second });
  assert.equal(list<Grant>(revoked, 'grants')[1]!.status, 'revoked');
  await f.refused(f.bob, 'grant_use', { journeyId, grantId: second, need: 'read', resource: journeyId });
});

test('coordination: artifacts store metadata only and reject stale versions and forged authority', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Metadata', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  await f.refused(f.bob, 'artifact_create', { journeyId, name: 'Reader', type: 'note', size: 1 });
  await f.refused(f.alice, 'artifact_create', { journeyId, name: 'Content', type: 'note', size: 1, content: 'SECRET-CONTENT' });
  await f.refused(f.bob, 'artifact_create', { journeyId, name: 'Forged', type: 'note', size: 1, actorHasWrite: true });
  await f.refused(f.alice, 'artifact_create', { journeyId, name: 'Oversize', type: 'note', size: 2 ** 53 });
  const artifactId = list<Artifact>(await f.call(f.alice, 'artifact_create', { journeyId, name: 'Note', type: 'note', size: 10 }), 'artifacts')[0]!.artifactId;
  await f.call(f.alice, 'artifact_version', { journeyId, artifactId, size: 20, baseVersion: 1 });
  await f.refused(f.alice, 'artifact_version', { journeyId, artifactId, size: 99, baseVersion: 1 });
  const renamed = list<Artifact>(await f.call(f.alice, 'artifact_rename', { journeyId, artifactId, name: 'Renamed' }), 'artifacts')[0]!;
  assert.deepEqual({ name: renamed.name, size: renamed.size, version: renamed.version }, { name: 'Renamed', size: 20, version: 2 });
  const deleted = list<Artifact>(await f.call(f.alice, 'artifact_delete', { journeyId, artifactId }), 'artifacts')[0]!;
  assert.equal(deleted.deleted, true);
  await f.refused(f.alice, 'artifact_version', { journeyId, artifactId, size: 30, baseVersion: 2 });
  assert.equal(f.backend.snapshot().includes('SECRET-CONTENT'), false);
});

test('coordination: task rounds, claimant and deadline are checked from stored state', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Tasks', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  const taskId = list<Task>(await f.call(f.alice, 'task_create', { journeyId, name: 'Work', maxRounds: 1, deadline: 2000 }), 'tasks')[0]!.taskId;
  await f.call(f.bob, 'task_step', { journeyId, taskId, action: 'claim' });
  await f.refused(f.alice, 'task_step', { journeyId, taskId, action: 'startRound' });
  const started = list<Task>(await f.call(f.bob, 'task_step', { journeyId, taskId, action: 'startRound' }), 'tasks')[0]!;
  assert.equal(started.status, 'inRound'); assert.equal(started.roundsUsed, 1);
  assert.equal(list<Task>(await f.call(f.bob, 'task_step', { journeyId, taskId, action: 'endRound' }), 'tasks')[0]!.status, 'expired');
  await f.refused(f.bob, 'task_step', { journeyId, taskId, action: 'startRound' });
  f.advance(2000);
  await f.refused(f.bob, 'task_step', { journeyId, taskId, action: 'finish' });
  await f.refused(f.alice, 'task_step', { journeyId, taskId, action: 'expire' });
  await f.refused(f.alice, 'task_step', { journeyId, taskId, action: 'cancel' });
});

test('coordination: personal group keeps its owner and excludes caller-supplied ownership', async (t) => {
  const f = await fixture(t);
  const first = await f.call(f.alice, 'personal_group_read');
  assert.deepEqual(first.members, [{ id: f.a, kind: 'person' }]);
  await f.refused(f.alice, 'personal_group_remove', { memberId: f.a });
  await f.refused(f.alice, 'personal_group_add', { name: 'Someone else', kind: 'device', belongsTo: f.b });
  const added = await f.call(f.alice, 'personal_group_add', { name: 'Laptop', kind: 'device' });
  const memberId = list<{ id: string }>(added, 'members')[1]!.id;
  await f.refused(f.bob, 'personal_group_remove', { memberId });
  const removed = await f.call(f.alice, 'personal_group_remove', { memberId });
  assert.deepEqual(removed.members, [{ id: f.a, kind: 'person' }]);
});

test('coordination: concurrent creates keep both projects and refuse mismatched stored rules', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Concurrency' })).journeyId as string;
  await Promise.all([
    f.call(f.alice, 'project_create', { journeyId, name: 'A', purpose: 'A' }),
    f.call(f.alice, 'project_create', { journeyId, name: 'B', purpose: 'B' }),
  ]);
  assert.deepEqual(list<Project>(await f.call(f.alice, 'journey_read', { journeyId }), 'projects').map((p) => p.purpose).sort(), ['A', 'B']);
  const store = f.backend.journeyStores.get(journeyId)!;
  const state = JSON.parse(store.data.get('journey')!) as JourneyState;
  state.rulesHash.journey = 'different-build';
  store.data.set('journey', JSON.stringify(state));
  await f.refused(f.alice, 'project_create', { journeyId, name: 'C', purpose: 'C' });
});

test('coordination: a revoked grant cannot be revoked twice or rewritten', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Revoke', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  const grantId = list<Grant>(await f.call(f.alice, 'grant_issue', { journeyId, grantee: f.b, need: 'read', resource: journeyId, uses: 2, expiresAt: 5000 }), 'grants')[0]!.grantId;
  await f.call(f.alice, 'grant_revoke', { journeyId, grantId });
  await f.refused(f.alice, 'grant_revoke', { journeyId, grantId });
});

test('coordination: an agent may leave without guide authority and loses access', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Agent leave', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  const agentId = list<Agent>(await addAgent(f.backend, 'bob', journeyId, 'Agent', ["read","task.manage"]), 'agents')[0]!.agentId;
  const sibling = list<Agent>(await addAgent(f.backend, 'bob', journeyId, 'Sibling', ["read","task.manage"]), 'agents')[1]!.agentId;
  await f.refused(f.bob, 'journey_remove', { journeyId, actingAgent: agentId, memberId: f.a });
  await setAgentCard(f.backend, 'bob', agentId, ['read', 'agent.remove']);
  await f.call(f.bob, 'journey_remove', { journeyId, actingAgent: agentId, memberId: sibling });
  assert.equal(list<Member>(await f.call(f.bob, 'journey_read', { journeyId }), 'members').some((m) => m.memberId === sibling), false);
  await f.call(f.bob, 'journey_leave', { journeyId, actingAgent: agentId });
  assert.equal(list<Member>(await f.call(f.bob, 'journey_read', { journeyId }), 'members').some((m) => m.memberId === agentId), false);
  await f.refused(f.bob, 'journey_read', { journeyId, actingAgent: agentId });
});


test('tasks: member inbox resources isolate assignments and support offline polling', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Inbox', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  const agentId = list<Agent>(await addAgent(f.backend, 'bob', journeyId, 'Worker', ["read","task.manage","artifact.write","project.create"]), 'agents')[0]!.agentId;
  const addressed = list<Task>(await f.call(f.alice, 'task_create', { journeyId, name: 'For worker', assignee: agentId, maxRounds: 2, deadline: 5000 }), 'tasks')[0]!.taskId;
  await f.call(f.alice, 'task_create', { journeyId, name: 'Private assignment', assignee: f.a, maxRounds: 2, deadline: 5000 });
  const uri = `wayfinding://journey/${journeyId}/inbox`;
  const content = (await f.bob.readResource({ uri })).contents[0]!;
  assert.ok('text' in content);
  const inbox = JSON.parse(content.text) as { tasks: Task[] };
  assert.deepEqual(inbox.tasks.map((task) => task.taskId), [addressed]);
  await assert.rejects(f.eve.readResource({ uri }));
  await f.call(f.alice, 'journey_remove', { journeyId, memberId: f.b });
  await assert.rejects(f.bob.readResource({ uri }));
});

test('tasks: modern inbox subscriptions receive committed updates and stop after removal', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Watch', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  const bob = await f.connect('bob');
  const uri = `wayfinding://journey/${journeyId}/inbox`;
  const updates: string[] = [];
  let arrived!: () => void;
  const next = new Promise<void>((resolve) => { arrived = resolve; });
  bob.setNotificationHandler('notifications/resources/updated', (notification) => { updates.push(notification.params.uri); arrived(); });
  const subscription = await bob.listen({ resourceSubscriptions: [uri] });
  t.after(() => subscription.close());
  await f.call(f.alice, 'task_create', { journeyId, name: 'New work', assignee: f.b, maxRounds: 2, deadline: 5000 });
  await Promise.race([next, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Missing inbox update')), 1500); timer.unref(); })]);
  assert.deepEqual(updates, [uri]);
  await f.call(f.alice, 'journey_remove', { journeyId, memberId: f.b });
  assert.equal(await Promise.race([subscription.closed, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Subscription remained open after removal')), 1500); timer.unref(); })]), 'graceful');
  await f.call(f.alice, 'task_create', { journeyId, name: 'No leak', maxRounds: 2, deadline: 5000 });
  assert.deepEqual(updates, [uri]);
  await assert.rejects(f.eve.listen({ resourceSubscriptions: [uri] }));
  await assert.rejects(f.bob.listen({ resourceSubscriptions: [uri] }));
});

test('coordination: a guide agent without read permission never receives private state from a mutation', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Private guide' })).journeyId as string;
  const agentId = list<Agent>(await addAgent(f.backend, 'alice', journeyId, 'Guide agent', ["journey.policy","member.invite","member.admit","agent.remove"]), 'agents')[0]!.agentId;
  await f.refused(f.alice, 'journey_read', { journeyId, actingAgent: agentId });
  const changed = await f.call(f.alice, 'journey_policy', { journeyId, actingAgent: agentId, policy: 'open', defaultRole: 'read' });
  assert.deepEqual(changed, { journeyId, accepted: true });
  assert.equal((await f.call(f.alice, 'journey_read', { journeyId })).policy, 'open');
});

test('coordination: Durable Object adapter reloads stored rules and members after eviction', async (t) => {
  const stores = new Map<string, MemoryStorage>();
  const accounts = new AccountsHost(new MemoryStorage(), { async get() { return { name: 'Person', email: 'person@example.test' }; } });
  const backend = new Backend(accounts, (id) => {
    let store = stores.get(id);
    if (!store) { store = new MemoryStorage(); stores.set(id, store); }
    // Recreate the actual DO adapter on every call, as if it had been evicted.
    const object = new Journey({ storage: store });
    return {
      async requireGuide(personId, command) {
        const response = await object.fetch(new Request('https://internal/', { method: 'POST', body: JSON.stringify({ action: 'requireGuide', personId, tool: command.tool, input: command.input }) }));
        assert.equal(response.status, 200);
      },
      async execute(personId, command, journeyId) {
        const response = await object.fetch(new Request('https://internal/', { method: 'POST', body: JSON.stringify({ personId, journeyId, tool: command.tool, input: command.input }) }));
        assert.equal(response.status, 200);
        return (await response.json() as { value: Data }).value;
      },
      async summary(personId) {
        const response = await object.fetch(new Request('https://internal/', { method: 'POST', body: JSON.stringify({ action: 'summary', personId }) }));
        assert.equal(response.status, 200);
        return (await response.json() as { value?: Data }).value;
      },
      async inbox(personId) {
        const response = await object.fetch(new Request('https://internal/', { method: 'POST', body: JSON.stringify({ action: 'inbox', personId }) }));
        assert.equal(response.status, 200);
        return (await response.json() as { value: Data }).value;
      },
      async watchInbox(personId) {
        const response = await object.fetch(new Request('https://internal/', { method: 'POST', body: JSON.stringify({ action: 'watchInbox', personId }) }));
        assert.equal(response.status, 200);
        return response.body!;
      },
      async task(personId, method, taskId) {
        const response = await object.fetch(new Request('https://internal/', { method: 'POST', body: JSON.stringify({ action: 'task', personId, method, taskId }) }));
        assert.equal(response.status, 200);
        return (await response.json() as { value: Data }).value;
      },
    };
  });
  const client = new Client({ name: 'eviction-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: bridge(app(signer, backend)), requestInit: { headers: { authorization: `Bearer ${await token(signer, { sub: 'eviction-user' })}` } } }));
  t.after(() => client.close());
  const created = await client.callTool({ name: 'journey_create', arguments: { name: 'Persistent' } });
  assert.notEqual(created.isError, true);
  const journeyId = (created.structuredContent as Data).journeyId as string;
  const read = await client.callTool({ name: 'journey_read', arguments: { journeyId } });
  assert.deepEqual(read.structuredContent, created.structuredContent);
  const listed = await client.callTool({ name: 'journey_list', arguments: {} });
  assert.deepEqual(listed.structuredContent, { journeys: [{ journeyId, name: 'Persistent' }] });
});


test('tasks: assigned agents claim rounds and expire automatically at the cap', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Assigned tasks', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  const agentId = list<Agent>(await addAgent(f.backend, 'bob', journeyId, 'Worker', ["read","task.manage"]), 'agents')[0]!.agentId;
  const taskId = list<Task>(await f.call(f.alice, 'task_create', { journeyId, assignee: agentId, name: 'Assigned', maxRounds: 1, deadline: 3000 }), 'tasks')[0]!.taskId;
  await f.refused(f.alice, 'task_step', { journeyId, taskId, action: 'claim' });
  await f.refused(f.bob, 'task_step', { journeyId, taskId, action: 'claim' });
  await f.refused(f.alice, 'task_step', { journeyId, taskId, actingAgent: agentId, action: 'claim' });
  await f.call(f.bob, 'task_step', { journeyId, taskId, actingAgent: agentId, action: 'claim' });
  await f.call(f.bob, 'task_step', { journeyId, taskId, actingAgent: agentId, action: 'startRound' });
  const ended = list<Task>(await f.call(f.bob, 'task_step', { journeyId, taskId, actingAgent: agentId, action: 'endRound' }), 'tasks')[0]!;
  assert.equal(ended.status, 'expired');
  assert.equal(ended.roundsUsed, 1);
  await f.refused(f.bob, 'task_step', { journeyId, taskId, actingAgent: agentId, action: 'finish' });
});


test('tasks: atomic task creation rolls back when alarm persistence fails', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Atomic deadline' })).journeyId as string;
  const store = f.backend.journeyStores.get(journeyId)!;
  const before = f.backend.snapshot(), writes = store.writes;
  const setAlarm = store.setAlarm.bind(store);
  store.setAlarm = async () => { throw new Error('Storage unavailable'); };
  const refused = await f.alice.callTool({ name: 'task_create', arguments: { journeyId, name: 'Not committed', maxRounds: 2, deadline: 4000 } });
  assert.equal(refused.isError, true);
  assert.equal(f.backend.snapshot(), before);
  assert.equal(store.writes, writes);
  assert.equal(store.alarmAt, undefined);
  store.setAlarm = setAlarm;
  const tasks = list<Task>(await f.call(f.alice, 'task_create', { journeyId, name: 'Committed', maxRounds: 2, deadline: 4000 }), 'tasks');
  assert.deepEqual(tasks.map((task) => task.status), ['open']);
  assert.equal(store.alarmAt, 4000);
});

test('tasks: Durable Object alarm expires an in-round task after eviction using the server clock', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Deadline', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  const agentId = list<Agent>(await addAgent(f.backend, 'bob', journeyId, 'Worker', ["read","task.manage"]), 'agents')[0]!.agentId;
  const taskId = list<Task>(await f.call(f.alice, 'task_create', { journeyId, assignee: agentId, name: 'Timed', maxRounds: 3, deadline: 2000 }), 'tasks')[0]!.taskId;
  const later = list<Task>(await f.call(f.alice, 'task_create', { journeyId, name: 'Later', maxRounds: 2, deadline: 4000 }), 'tasks')[1]!.taskId;
  const store = f.backend.journeyStores.get(journeyId)!;
  assert.equal(store.alarmAt, 2000);
  await f.call(f.bob, 'task_step', { journeyId, taskId, actingAgent: agentId, action: 'claim' });
  await f.call(f.bob, 'task_step', { journeyId, taskId, actingAgent: agentId, action: 'startRound' });
  f.advance(2000);
  await f.refused(f.bob, 'task_step', { journeyId, taskId, actingAgent: agentId, action: 'endRound' });
  await new Journey({ storage: store }, undefined, () => 2000).alarm();
  assert.equal(store.alarmAt, 4000);
  const tasks = list<Task>(await f.call(f.alice, 'journey_read', { journeyId }), 'tasks');
  assert.equal(tasks.find((task) => task.taskId === taskId)!.status, 'expired');
  assert.equal(tasks.find((task) => task.taskId === later)!.status, 'open');
  const writes = store.writes;
  await new Journey({ storage: store }, undefined, () => 2000).alarm();
  assert.equal(store.writes, writes);
  await new Journey({ storage: store }, undefined, () => 4000).alarm();
  assert.equal(store.alarmAt, undefined);
  const expired = await f.alice.request({ method: 'tasks/get', params: { taskId } }, z.record(z.string(), z.unknown()));
  assert.equal(expired.status, 'completed'); assert.equal((expired.result as Data).isError, true);
});

test('tasks: capabilities reflect live person and card limits without allowing agent grants', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Capabilities', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  const agentId = list<Agent>(await addAgent(f.backend, 'bob', journeyId, 'Agent', ["read","task.manage","artifact.write","project.create","journey.policy","member.invite","member.admit","agent.remove"]), 'agents')[0]!.agentId;
  const caps = () => f.call(f.bob, 'agent_capabilities', { journeyId, agentId });
  assert.deepEqual((await caps()).capabilities, ['read']);
  await f.call(f.alice, 'journey_role', { journeyId, personId: f.b, role: 'write' });
  assert.equal(((await caps()).capabilities as string[]).includes('artifact.write'), true);
  await f.call(f.alice, 'journey_guide', { journeyId, personId: f.b });
  assert.equal(((await caps()).capabilities as string[]).includes('journey.policy'), true);
  await f.refused(f.bob, 'grant_issue', { journeyId, actingAgent: agentId, grantee: f.a, need: 'read', resource: journeyId, uses: 1, expiresAt: 5000 });
  await f.call(f.alice, 'journey_role', { journeyId, personId: f.b, role: 'read' });
  assert.equal(((await caps()).capabilities as string[]).includes('artifact.write'), false);
  await f.call(f.bob, 'agent_narrow', { agentId, remove: ['read', 'artifact.write', 'project.create', 'task.manage', 'journey.policy', 'member.invite', 'member.admit', 'agent.remove'] });
  assert.deepEqual((await caps()).capabilities, []);
  await f.refused(f.alice, 'agent_capabilities', { journeyId, agentId });
  await f.refused(f.bob, 'task_create', { journeyId, actingAgent: agentId, name: 'Denied', deadline: 5000, maxRounds: 1 });
  await f.call(f.bob, 'journey_remove', { journeyId, memberId: agentId });
  await f.refused(f.bob, 'agent_capabilities', { journeyId, agentId });
});


test('tasks: SEP methods require the extension on every request in both eras', async (t) => {
  const f = await fixture(t);
  const journeyId = (await f.call(f.alice, 'journey_create', { name: 'Protocol', policy: 'open' })).journeyId as string;
  await f.call(f.bob, 'journey_join', { journeyId });
  const taskId = list<Task>(await f.call(f.alice, 'task_create', { journeyId, name: 'Handle', maxRounds: 3, deadline: 5000 }), 'tasks')[0]!.taskId;
  const meta = { 'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } } };
  const request = (client: Client, method: string, params: Data) => client.request({ method, params }, z.record(z.string(), z.unknown()));
  assert.ok(f.alice.getServerCapabilities()?.extensions?.['io.modelcontextprotocol/tasks']);
  for (const client of [f.alice, f.bob]) {
    const get = await request(client, 'tasks/get', { taskId, _meta: meta });
    assert.equal(f.wire.at(-1)!.result?.resultType, 'complete'); assert.equal(get.taskId, taskId); assert.equal(get.status, 'working');
    assert.equal(get.createdAt, new Date(1000).toISOString()); assert.equal(get.ttlMs, null);
    const before = f.backend.snapshot();
    await assert.rejects(request(client, 'tasks/update', { taskId, _meta: meta }), (error: unknown) => error instanceof Error && 'code' in error && error.code === -32602);
    await request(client, 'tasks/update', { taskId, inputResponses: { unknown: { ignored: true } }, _meta: meta });
    assert.equal(f.wire.at(-1)!.result?.resultType, 'complete');
    assert.equal(f.backend.snapshot(), before);
    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
      await assert.rejects(request(client, method, { taskId, ...(method === 'tasks/update' ? { inputResponses: {} } : {}), _meta: { 'io.modelcontextprotocol/clientCapabilities': {} } }), (error: unknown) => error instanceof Error && 'code' in error && error.code === -32021);
      assert.equal(f.backend.snapshot(), before);
    }
  }
  const before = f.backend.snapshot();
  await assert.rejects(request(f.eve, 'tasks/get', { taskId, _meta: meta }));
  await assert.rejects(request(f.bob, 'tasks/cancel', { taskId, _meta: meta }));
  assert.equal(f.backend.snapshot(), before);
  await request(f.alice, 'tasks/cancel', { taskId, _meta: meta });
  assert.equal(f.wire.at(-1)!.result?.resultType, 'complete');
  assert.equal(list<Task>(await f.call(f.alice, 'journey_read', { journeyId }), 'tasks')[0]!.status, 'cancelled');
  assert.equal((await request(f.bob, 'tasks/get', { taskId, _meta: meta })).status, 'cancelled');
  const completed = list<Task>(await f.call(f.alice, 'task_create', { journeyId, name: 'Finished', maxRounds: 2, deadline: 5000 }), 'tasks')[1]!.taskId;
  await f.call(f.bob, 'task_step', { journeyId, taskId: completed, action: 'claim' });
  await f.call(f.bob, 'task_step', { journeyId, taskId: completed, action: 'startRound' });
  await f.call(f.bob, 'task_step', { journeyId, taskId: completed, action: 'endRound' });
  await f.call(f.bob, 'task_step', { journeyId, taskId: completed, action: 'finish' });
  const done = await request(f.alice, 'tasks/get', { taskId: completed, _meta: meta });
  assert.equal(done.status, 'completed'); assert.equal((done.result as Data).isError, false);
});
