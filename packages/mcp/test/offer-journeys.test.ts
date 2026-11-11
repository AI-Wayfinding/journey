import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend } from '../src/backend.ts';
import { AccountsHost } from '../src/accounts.ts';
import { parseCommand } from '../src/commands.ts';
import { setAgentCard, testPasskeys } from './helpers.ts';

// Public backend/DO boundaries: an enabled journey and a permit are both required.
async function fixture() {
  let now = 1_800_000_000_000;
  const backend = new MemoryBackend({ get: async subject => ({ name: subject, email: `${subject}@example.test` }) }, () => now, testPasskeys);
  const call = (tool: string, input: Record<string, unknown> = {}) => backend.execute('alice', parseCommand(tool, input));
  await call('account_read');
  const journeyId = String((await call('journey_create', { name: 'Synthetic', policy: 'open', defaultRole: 'write' })).journeyId);
  const agentId = String((await call('agent_create', { name: 'Synthetic agent' })).agentId);
  await setAgentCard(backend, 'alice', agentId, ['read', 'task.manage', 'offer.manage', 'offer.decide']);
  await call('agent_add', { journeyId, agentId });
  const define = (id = 'review', preset = 'Open') => call('offer_set', { agentId, offer: { id, name: 'Review', description: '', inputSchema: { type: 'object' }, preset } });
  const list = () => call('offer_list', { agentId });
  const row = async (journey = journeyId, changes: Record<string, unknown> = {}, offerId = 'review') => {
    const offers = (await list()).offers as { id: string; version: number }[];
    return call('offer_journey_set', { agentId, offerId, journeyId: journey, expectedVersion: offers.find(o => o.id === offerId)!.version, enabled: true, ...changes });
  };
  const request = (journey = journeyId, offerId = 'review') => call('task_create', { journeyId: journey, name: 'Synthetic request', agentId, offerId, input: {}, maxRounds: 1, deadline: now + 604_800_000 });
  const tasks = async (journey = journeyId) => (await call('journey_read', { journeyId: journey })).tasks as { taskId: string; status: string }[];
  const approve = (taskId: string, journey = journeyId) => call('task_step', { journeyId: journey, taskId, action: 'approve' });
  const publish = (offerId = 'review') => call('offer_publish', { agentId, offerId });
  return { backend, call, journeyId, agentId, define, list, row, request, tasks, approve, publish, advance: (ms: number) => { now += ms; } };
}

test('offer journeys: default off includes later-joined journeys', async () => {
  const f = await fixture();
  await f.define(); await f.publish();
  assert.deepEqual((await f.call('offer_search', { journeyId: f.journeyId })).offers, []);
  await assert.rejects(f.request(), /not available/);
  const second = String((await f.call('journey_create', { name: 'Later' })).journeyId);
  await f.call('agent_add', { journeyId: second, agentId: f.agentId });
  await assert.rejects(f.request(second), /not available/);
  await f.row(); await f.request();
  assert.equal((await f.tasks())[0]!.status, 'claimed');
  await assert.rejects(f.request(second), /not available/);
});

test('offer journeys: agent cannot enable or raise limits through either edit command', async () => {
  const f = await fixture(); await f.define(); await f.publish();
  const before = f.backend.snapshot();
  await assert.rejects(f.row(f.journeyId, { actingAgent: f.agentId }), /may only narrow/);
  assert.equal(f.backend.snapshot(), before);
  await f.row(f.journeyId, { maxRequestsPerDay: 2 });
  await assert.rejects(f.row(f.journeyId, { actingAgent: f.agentId, maxRequestsPerDay: 3 }), /may only narrow/);
  await assert.rejects(f.row(f.journeyId, { actingAgent: f.agentId, clearLimit: true }), /may only narrow/);
  await assert.rejects(f.call('offer_set', { agentId: f.agentId, actingAgent: f.agentId, offer: { id: 'other', name: 'Bypass', description: '', inputSchema: { type: 'object' }, journeySettings: { [f.journeyId]: { enabled: true } } } }), /may only narrow/);
  await f.row(f.journeyId, { actingAgent: f.agentId, enabled: false, maxRequestsPerDay: 1 });
  await assert.rejects(f.request(), /not available/);
});

test('offer journeys: approve over cap stays held and repeated approval uses one permit', async () => {
  const f = await fixture();
  await f.call('offer_settings', { agentId: f.agentId, maxRequestsPerDay: 1 });
  await f.call('offer_set', { agentId: f.agentId, offer: { id: 'review', name: 'Held', description: '', inputSchema: { type: 'object' }, admission: { rules: [], default: 'hold' } } });
  await f.publish(); await f.row(); await f.request(); await f.request();
  const [first, second] = await f.tasks();
  await f.approve(first!.taskId); await f.approve(first!.taskId);
  await f.approve(second!.taskId);
  assert.deepEqual((await f.tasks()).map(t => t.status), ['claimed', 'requested']);
  const state = JSON.parse(String(await f.backend.accountStorage.get('accounts'))) as { permits: { taskId: string }[] };
  assert.deepEqual(state.permits.map(p => p.taskId), [first!.taskId]);
  await f.call('task_step', { journeyId: f.journeyId, taskId: first!.taskId, action: 'cancel' });
  await f.approve(second!.taskId);
  assert.equal((await f.tasks())[1]!.status, 'requested', 'cancellation must not refund permits');
  f.advance(86_400_000); await f.approve(second!.taskId);
  assert.equal((await f.tasks())[1]!.status, 'claimed', 'exactly 24 hours is outside the rolling window');
});

test('offer journeys: journey limit above agent cap refused; lowering clamps without resetting usage', async () => {
  const f = await fixture(); await f.define(); await f.publish();
  await f.call('offer_settings', { agentId: f.agentId, maxRequestsPerDay: 3 });
  await assert.rejects(f.row(f.journeyId, { maxRequestsPerDay: 4 }), /agent ceiling/);
  await assert.rejects(f.row(f.journeyId, { maxRequestsPerDay: 0 }), /greater|>=|Too small/);
  await f.row(f.journeyId, { maxRequestsPerDay: 3 }); await f.request();
  await f.call('offer_settings', { agentId: f.agentId, maxRequestsPerDay: 1 });
  const offer = ((await f.list()).offers as { journeySettings: Record<string, { maxRequestsPerDay: number }> }[])[0]!;
  assert.equal(offer.journeySettings[f.journeyId]!.maxRequestsPerDay, 1);
  await f.request(); assert.deepEqual((await f.tasks()).map(t => t.status), ['claimed', 'requested']);
  await f.row(f.journeyId, { clearLimit: true });
  const cleared = ((await f.list()).offers as { journeySettings: Record<string, object> }[])[0]!;
  assert.deepEqual(cleared.journeySettings[f.journeyId], { enabled: true });
});

test('offer journeys: disable blocks new requests and approval but admitted work continues', async () => {
  const f = await fixture(); await f.define(); await f.publish(); await f.row();
  await f.request();
  await f.call('offer_set', { agentId: f.agentId, offer: { id: 'review', name: 'Held', description: '', inputSchema: { type: 'object' }, admission: { rules: [], default: 'hold' } } });
  await f.request(); const [admitted, held] = await f.tasks();
  await f.row(f.journeyId, { enabled: false });
  assert.deepEqual((await f.call('offer_search', { journeyId: f.journeyId })).offers, []);
  await assert.rejects(f.request(), /not available/);
  await assert.rejects(f.approve(held!.taskId), /not available|disabled/);
  await f.call('task_step', { journeyId: f.journeyId, taskId: admitted!.taskId, action: 'finish', actingAgent: f.agentId });
  assert.deepEqual((await f.tasks()).map(t => t.status), ['done', 'requested']);
});

test('offer journeys: simultaneous journeys and offers share one hard ceiling', async () => {
  const f = await fixture();
  const second = String((await f.call('journey_create', { name: 'Second' })).journeyId);
  await f.call('agent_add', { journeyId: second, agentId: f.agentId });
  await f.call('offer_settings', { agentId: f.agentId, maxRequestsPerDay: 1 });
  await f.define(); await f.publish(); await f.row();
  await f.define('other'); await f.publish('other'); await f.row(second, {}, 'other');
  await Promise.all([f.request(), f.request(second, 'other')]);
  assert.deepEqual([...(await f.tasks()), ...(await f.tasks(second))].map(t => t.status).sort(), ['claimed', 'requested']);
  const state = JSON.parse(String(await f.backend.accountStorage.get('accounts'))) as { permits: unknown[] };
  assert.equal(state.permits.length, 1);
});


test('offer journeys: one row cap covers all requesters without capping another row', async () => {
  const f = await fixture(); await f.define(); await f.publish(); await f.row(f.journeyId, { maxRequestsPerDay: 1 });
  await f.request();
  await f.backend.execute('bob', parseCommand('journey_join', { journeyId: f.journeyId }));
  await f.backend.execute('bob', parseCommand('task_create', { journeyId: f.journeyId, name: 'Bob request', agentId: f.agentId, offerId: 'review', input: {}, maxRounds: 1, deadline: 1_800_604_800_000 }));
  assert.deepEqual((await f.tasks()).map(t => t.status), ['claimed', 'requested']);
  const second = String((await f.call('journey_create', { name: 'Independent row' })).journeyId);
  await f.call('agent_add', { journeyId: second, agentId: f.agentId }); await f.row(second);
  await f.request(second);
  assert.equal((await f.tasks(second))[0]!.status, 'claimed');
  assert.deepEqual((await f.list()).usage, { admitted24h: 2, journeys: [
    { offerId: 'review', journeyId: f.journeyId, admitted24h: 1 },
    { offerId: 'review', journeyId: second, admitted24h: 1 },
  ] });
});

test('offer journeys: stale writes, unknown row fields and more than 128 rows are refused', async () => {
  const f = await fixture(); await f.define(); await f.publish();
  const original = ((await f.list()).offers as { version: number; contentRevision: number }[])[0]!;
  await f.row(f.journeyId, { maxRequestsPerDay: 2 }); await f.row(f.journeyId, { enabled: false });
  const offer = ((await f.list()).offers as { version: number; contentRevision: number; journeySettings: Record<string, unknown> }[])[0]!;
  assert.equal(offer.contentRevision, original.contentRevision, 'policy edits do not revise content');
  assert.deepEqual(offer.journeySettings[f.journeyId], { enabled: false, maxRequestsPerDay: 2 }, 'omission preserves the existing limit');
  const before = f.backend.snapshot();
  await assert.rejects(f.call('offer_journey_set', { agentId: f.agentId, offerId: 'review', journeyId: f.journeyId, expectedVersion: original.version, enabled: true }), /reload/);
  await assert.rejects(async () => f.call('offer_set', { agentId: f.agentId, offer: { id: 'review', name: 'Bad row', description: '', inputSchema: { type: 'object' }, journeySettings: { [f.journeyId]: { enabled: true, name: 'leak' } } } }), /Unrecognized/);
  await assert.rejects(async () => f.call('offer_set', { agentId: f.agentId, offer: { id: 'review', name: 'Too many', description: '', inputSchema: { type: 'object' }, journeySettings: Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`journey_${i}`, { enabled: false }])) } }), /128/);
  assert.equal(f.backend.snapshot(), before);
  await f.define();
  assert.equal(((await f.list()).offers as { contentRevision: number }[])[0]!.contentRevision, original.contentRevision);
  await f.call('offer_set', { agentId: f.agentId, offer: { id: 'review', name: 'New definition', description: '', inputSchema: { type: 'object' } } });
  assert.equal(((await f.list()).offers as { contentRevision: number }[])[0]!.contentRevision, original.contentRevision + 1);
});

test('offer journeys: definite failed approval commit releases only its permit', async () => {
  const f = await fixture();
  await f.call('offer_settings', { agentId: f.agentId, maxRequestsPerDay: 1 });
  await f.call('offer_set', { agentId: f.agentId, offer: { id: 'review', name: 'Held', description: '', inputSchema: { type: 'object' }, admission: { rules: [], default: 'hold' } } });
  await f.publish(); await f.row(); await f.request();
  const taskId = (await f.tasks())[0]!.taskId, before = f.backend.snapshot();
  const storage = f.backend.journeyStores.get(f.journeyId)!, setAlarm = storage.setAlarm;
  storage.setAlarm = async () => { throw new Error('synthetic approval commit abort'); };
  await assert.rejects(f.approve(taskId), /synthetic approval commit abort/);
  storage.setAlarm = setAlarm;
  assert.equal(f.backend.snapshot(), before, 'the created-request receipt survives unchanged');
  await f.approve(taskId);
  assert.equal((await f.tasks())[0]!.status, 'claimed');
  assert.equal(((await f.list()).usage as { admitted24h: number }).admitted24h, 1);
});

test('offer journeys: legacy wildcard and list migrate Off and old receipts reserve capacity conservatively', async () => {
  const f = await fixture(); await f.define(); await f.publish(); await f.row(); await f.request();
  await f.define('listed');
  const raw = JSON.parse(String(await f.backend.accountStorage.get('accounts')));
  const agent = raw.accounts[0].agents.find((a: { id: string }) => a.id === f.agentId);
  agent.journeys = [f.journeyId];
  agent.offers[0].journeys = 'all'; agent.offers[1].journeys = [f.journeyId];
  for (const offer of agent.offers) { delete offer.journeySettings; delete offer.contentRevision; }
  delete raw.permits;
  await f.backend.accountStorage.put('accounts', JSON.stringify(raw));
  const object = new AccountsHost(f.backend.accountStorage, { get: async subject => ({ name: subject, email: `${subject}@example.test` }) }, undefined, testPasskeys, () => 1_800_000_000_000);
  await object.offerDirectory();
  const offers = (await f.list()).offers as { journeySettings: Record<string, unknown>; journeys?: unknown }[];
  assert.deepEqual(offers.map(o => o.journeySettings), [{ [f.journeyId]: { enabled: false } }, { [f.journeyId]: { enabled: false } }]);
  assert.deepEqual(offers.map(o => o.journeys), [undefined, undefined]);
  assert.equal(((await f.list()).usage as { admitted24h: number }).admitted24h, 1);
  await assert.rejects(f.request(), /not available/);
});

test('offer journeys: approval receipts and permits survive eviction and reject mismatched replay', async () => {
  const f = await fixture(); await f.call('offer_settings', { agentId: f.agentId, maxRequestsPerDay: 1 });
  await f.call('offer_set', { agentId: f.agentId, offer: { id: 'review', name: 'Held', description: '', inputSchema: { type: 'object' }, admission: { rules: [], default: 'hold' } } });
  await f.publish(); await f.row(); await f.request();
  const taskId = (await f.tasks())[0]!.taskId;
  let accounts = new AccountsHost(f.backend.accountStorage, { get: async subject => ({ name: subject, email: `${subject}@example.test` }) }, undefined, testPasskeys, () => 1_800_000_000_000);
  const permit = { taskId, agentId: f.agentId, offerId: 'review', journeyId: f.journeyId };
  const approve = (request = permit) => accounts.approveAllowance(request);
  assert.equal(await approve(), 'allow');
  accounts = new AccountsHost(f.backend.accountStorage, { get: async subject => ({ name: subject, email: `${subject}@example.test` }) }, undefined, testPasskeys, () => 1_800_000_000_000);
  assert.equal(await approve(), 'allow');
  await assert.rejects(approve({ ...permit, journeyId: 'journey_forged' }), /receipt missing|mismatch/);
  assert.equal(((await f.list()).usage as { admitted24h: number }).admitted24h, 1);
  await f.approve(taskId);
  assert.equal((await f.tasks())[0]!.status, 'claimed');
  assert.equal(((await f.list()).usage as { admitted24h: number }).admitted24h, 1);
});


test('offer journeys: receipts and permits prune at one week without refunding earlier', async () => {
  const f = await fixture(); await f.define(); await f.publish(); await f.row(); await f.request();
  f.advance(6 * 86_400_000); await f.request();
  let raw = JSON.parse(String(await f.backend.accountStorage.get('accounts'))) as { permits: { taskId: string }[]; allowances: { taskId: string }[] };
  const first = raw.permits[0]!.taskId;
  assert.equal(raw.permits.length, 2, 'permits outlive the daily window');
  assert.equal(raw.allowances.length, 2);
  f.advance(86_400_000); await f.request();
  raw = JSON.parse(String(await f.backend.accountStorage.get('accounts')));
  assert.equal(raw.permits.length, 2);
  assert.equal(raw.allowances.length, 2);
  assert.equal(raw.permits.some(p => p.taskId === first), false);
  assert.equal(raw.allowances.some(r => r.taskId === first), false);
});
