import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend } from '../src/backend.ts';
import { parseCommand } from '../src/commands.ts';
import { setAgentCard, testPasskeys } from './helpers.ts';

async function fixture() {
  let now = 1_800_000_000_000;
  const backend = new MemoryBackend({ get: async subject => ({ name: subject, email: `${subject}@example.test` }) }, () => now, testPasskeys);
  const call = (subject: string, tool: string, input: Record<string, unknown> = {}) => backend.execute(subject, parseCommand(tool, input));
  for (const subject of ['alice', 'bob', 'eve']) await call(subject, 'account_read');
  const alice = String((await call('alice', 'account_read')).personId), bob = String((await call('bob', 'account_read')).personId);
  const journeyId = String((await call('alice', 'journey_create', { name: 'Offers', policy: 'open', defaultRole: 'write' })).journeyId);
  await call('bob', 'journey_join', { journeyId }); await call('eve', 'journey_join', { journeyId });
  const agentId = String((await call('alice', 'agent_create', { name: 'Reviewer' })).agentId);
  await setAgentCard(backend, 'alice', agentId, ['read', 'task.manage', 'offer.manage']);
  await call('alice', 'agent_add', { journeyId, agentId });
  const requesterId = String((await call('bob', 'agent_create', { name: 'Requester' })).agentId);
  await setAgentCard(backend, 'bob', requesterId, ['read', 'task.manage']);
  await call('bob', 'agent_add', { journeyId, agentId: requesterId });
  const definition = { id: 'review', name: 'Review', description: 'Synthetic work', inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false } };
  const define = (extra: Record<string, unknown> = {}, actingAgent?: string) => call('alice', 'offer_set', { agentId, actingAgent, offer: { ...definition, ...extra } });
  const publish = async () => {
    await call('alice', 'offer_publish', { agentId, offerId: 'review' });
    const offer = ((await call('alice', 'offer_list', { agentId })).offers as { version: number }[])[0]!;
    await call('alice', 'offer_journey_set', { agentId, offerId: 'review', journeyId, expectedVersion: offer.version, enabled: true });
  };
  const request = (input: unknown = { question: 'Hello' }, actingAgent?: string) => call('bob', 'task_create', { journeyId, name: 'Review this', agentId, offerId: 'review', input, maxRounds: 2, deadline: now + 3_600_000, actingAgent });
  const tasks = async () => (await call('alice', 'journey_read', { journeyId })).tasks as Record<string, unknown>[];
  return { backend, call, alice, bob, journeyId, agentId, requesterId, define, publish, request, tasks, advance: (ms: number) => { now += ms; } };
}

test('offers: schema rejection leaves persisted state unchanged', async () => {
  const f = await fixture();
  await f.define(); await f.publish();
  const before = f.backend.snapshot();
  await assert.rejects(f.request({ question: 42 }), /schema/);
  assert.equal(f.backend.snapshot(), before);
  assert.deepEqual(await f.tasks(), []);
  await f.request();
  const task = (await f.tasks())[0]!;
  assert.equal(task.status, 'claimed');
  assert.equal(task.claimant, f.agentId);
  assert.equal(task.offerId, 'review');
  assert.equal(task.offerVersion, 3);
});

test('offers: a deny leaves no record, while the first matching rule takes precedence', async () => {
  const f = await fixture();
  await f.define({ admission: { rules: [{ who: { person: f.bob }, decision: 'deny' }, { who: 'members', decision: 'allow' }], default: 'hold' } }); await f.publish();
  const before = f.backend.snapshot();
  await assert.rejects(f.request(), /^Error: Not accepted$/);
  assert.equal(f.backend.snapshot(), before);
  assert.deepEqual(await f.tasks(), []);
});
test('offers: an allowance holds the excess request and observes its rolling period', async () => {
  const f = await fixture();
  await f.define({ admission: { rules: [{ who: 'members', decision: 'allow', limit: { count: 1, per: 'hour' } }], default: 'deny' } }); await f.publish();
  await f.request(); await f.request();
  const tasks = await f.tasks();
  assert.deepEqual(tasks.map(t => t.status), ['claimed', 'requested']);
  assert.equal(tasks[1]!.roundsUsed, 0);
  assert.equal((await f.backend.task('bob', 'get', String(tasks[1]!.taskId))).statusMessage, 'awaiting approval');
  f.advance(3_600_000);
  await f.request();
  assert.equal((await f.tasks())[2]!.status, 'claimed');
});
test('offers: drafts cannot be requested, agents cannot publish, and missing offer.manage refuses edits', async () => {
  const f = await fixture();
  await f.define({ preset: 'Open' }, f.agentId);
  assert.deepEqual((await f.call('bob', 'offer_search', { journeyId: f.journeyId })).offers, []);
  const before = f.backend.snapshot();
  await assert.rejects(f.request(), /not available/);
  assert.equal(f.backend.snapshot(), before);
  await assert.rejects(f.call('alice', 'offer_publish', { agentId: f.agentId, offerId: 'review', actingAgent: f.agentId }), /Only the owner/);
  await f.publish();
  await f.request();
  assert.equal((await f.tasks())[0]!.status, 'requested', 'agent-defined Open is clamped by the owner ceiling');
  await setAgentCard(f.backend, 'alice', f.agentId, ['read', 'task.manage']);
  await assert.rejects(f.define({}, f.agentId), /offer.manage/);
});
test('offers: a non-decider cannot approve or see held requests through journey, inbox or task get', async () => {
  const f = await fixture();
  await f.define({ preset: 'Ask me' }); await f.publish(); await f.request();
  const taskId = String((await f.tasks())[0]!.taskId);
  const before = f.backend.snapshot();
  await assert.rejects(f.call('eve', 'task_step', { journeyId: f.journeyId, taskId, action: 'approve' }), /refused/);
  assert.equal(f.backend.snapshot(), before);
  assert.deepEqual((await f.call('eve', 'journey_read', { journeyId: f.journeyId })).tasks, []);
  assert.deepEqual((await f.backend.inbox('eve', f.journeyId)).tasks, []);
  await assert.rejects(f.backend.task('eve', 'get', taskId), /refused/);
  await f.call('alice', 'task_step', { journeyId: f.journeyId, taskId, action: 'approve' });
  assert.equal((await f.tasks())[0]!.status, 'claimed');
  assert.equal((await f.tasks())[0]!.claimant, f.agentId);
});
test('offers: the offering agent needs live offer.decide, not just task.manage or owner identity', async () => {
  const f = await fixture();
  await f.define(); await f.publish(); await f.request({ question: 'An agent asks' }, f.requesterId);
  const taskId = String((await f.tasks())[0]!.taskId);
  const before = f.backend.snapshot();
  await assert.rejects(f.call('alice', 'task_step', { journeyId: f.journeyId, taskId, action: 'approve', actingAgent: f.agentId }), /offer.decide/);
  assert.equal(f.backend.snapshot(), before);
  await setAgentCard(f.backend, 'alice', f.agentId, ['read', 'task.manage', 'offer.decide']);
  await f.call('alice', 'task_step', { journeyId: f.journeyId, taskId, action: 'approve', actingAgent: f.agentId });
  assert.equal((await f.tasks())[0]!.status, 'claimed');
  await f.call('alice', 'agent_narrow', { agentId: f.agentId, remove: ['offer.decide'] });
  await f.request({ question: 'Another' }, f.requesterId);
  const second = String((await f.tasks())[1]!.taskId);
  await assert.rejects(f.call('alice', 'task_step', { journeyId: f.journeyId, taskId: second, action: 'decline', actingAgent: f.agentId }), /offer.decide/);
});
test('offers: standing agent decisions go first, decline is final, and requested tasks expire', async () => {
  const f = await fixture();
  await f.define(); await f.publish();
  await f.request({ question: 'One' }, f.requesterId);
  const taskId = String((await f.tasks())[0]!.taskId);
  await f.call('alice', 'task_step', { journeyId: f.journeyId, taskId, action: 'decline', standing: 'always_deny', reason: 'No' });
  const declined = await f.backend.task('bob', 'get', taskId);
  assert.equal(declined.status, 'failed');
  assert.equal((await f.tasks())[0]!.reason, 'No');
  await assert.rejects(f.call('alice', 'task_step', { journeyId: f.journeyId, taskId, action: 'approve' }), /refused/);
  const before = f.backend.snapshot();
  await assert.rejects(f.request({ question: 'Two' }, f.requesterId), /Not accepted/);
  assert.equal(f.backend.snapshot(), before);
  await f.define({ preset: 'Ask me' });
  await f.request();
  const pending = String((await f.tasks())[1]!.taskId);
  assert.equal((await f.backend.task('bob', 'get', pending)).status, 'working');
  f.advance(3_600_000);
  const { JourneyHost } = await import('../src/journey.ts');
  await new JourneyHost(f.backend.journeyStores.get(f.journeyId)!, () => 1_800_003_600_000).alarm();
  assert.equal((await f.backend.task('bob', 'get', pending)).status, 'failed');
  assert.equal((await f.tasks())[1]!.status, 'expired');
});
test('offers: output checks use the recorded version and invalid output cannot change state', async () => {
  const f = await fixture();
  await f.define({ outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } }); await f.publish(); await f.request();
  const taskId = String((await f.tasks())[0]!.taskId);
  await f.define({ outputSchema: { type: 'object', required: ['different'] } });
  const before = f.backend.snapshot();
  await assert.rejects(f.call('alice', 'task_step', { journeyId: f.journeyId, taskId, action: 'finish', output: { answer: 2 }, actingAgent: f.agentId }), /schema/);
  assert.equal(f.backend.snapshot(), before);
  await f.call('alice', 'task_step', { journeyId: f.journeyId, taskId, action: 'finish', output: { answer: 'Synthetic result' }, actingAgent: f.agentId });
  const result = (await f.tasks())[0]!;
  assert.equal(result.status, 'done'); assert.equal(result.offerVersion, 3);
  assert.deepEqual(result.output, { answer: 'Synthetic result' });
});
test('offers: search follows live membership and card authority and supports tags and journey scope', async () => {
  const f = await fixture();
  await f.define({ tags: ['review'], journeySettings: { [f.journeyId]: { enabled: false } } }); await f.publish();
  const search = (tags = ['review']) => f.call('bob', 'offer_search', { journeyId: f.journeyId, tags, query: 'REVIEW' });
  assert.equal((await search()).offers instanceof Array, true);
  assert.equal(((await search()).offers as unknown[]).length, 1);
  assert.deepEqual((await search(['unknown'])).offers, []);
  await f.call('alice', 'agent_narrow', { agentId: f.agentId, remove: ['task.manage'] });
  assert.deepEqual((await search()).offers, []);
  await assert.rejects(f.request(), /not available/);
  await setAgentCard(f.backend, 'alice', f.agentId, ['read', 'task.manage']);
  await f.call('alice', 'journey_remove', { journeyId: f.journeyId, memberId: f.agentId });
  assert.deepEqual((await search()).offers, []);
  await assert.rejects(f.request(), /not available/);
});


test('offers: another owner cannot delegate authority over someone else’s pending requests', async () => {
  const f = await fixture();
  await f.define({ preset: 'Ask me' }); await f.publish(); await f.request();
  const taskId = String((await f.tasks())[0]!.taskId);
  await setAgentCard(f.backend, 'bob', f.requesterId, ['read', 'task.manage', 'offer.decide']);
  const before = f.backend.snapshot();
  await assert.rejects(f.call('bob', 'task_step', { journeyId: f.journeyId, taskId, action: 'approve', actingAgent: f.requesterId }), /refused/);
  assert.equal(f.backend.snapshot(), before);
  assert.deepEqual((await f.call('bob', 'journey_read', { journeyId: f.journeyId, actingAgent: f.requesterId })).tasks, []);
});

test('offers: concurrent admission consumes the last allowance only once', async () => {
  const f = await fixture();
  await f.define({ admission: { rules: [{ who: 'members', decision: 'allow', limit: { count: 1, per: 'hour' } }], default: 'hold' } }); await f.publish();
  await Promise.all([f.request(), f.request(), f.request()]);
  assert.deepEqual((await f.tasks()).map(t => t.status), ['claimed', 'requested', 'requested']);
});

test('offers: declining or expiring a held request does not reveal its content to bystanders', async () => {
  const f = await fixture();
  await f.define({ preset: 'Ask me' }); await f.publish(); await f.request();
  const first = String((await f.tasks())[0]!.taskId);
  await f.call('alice', 'task_step', { journeyId: f.journeyId, taskId: first, action: 'decline' });
  await f.request();
  const second = String((await f.tasks())[1]!.taskId);
  f.advance(3_600_000);
  await f.call('bob', 'task_step', { journeyId: f.journeyId, taskId: second, action: 'expire' });
  assert.deepEqual((await f.call('eve', 'journey_read', { journeyId: f.journeyId })).tasks, []);
  await assert.rejects(f.backend.task('eve', 'get', first), /refused/);
  await assert.rejects(f.backend.task('eve', 'get', second), /refused/);
});


test('offers: durable adapters retry an ambiguous standing decision once after eviction', async () => {
  const f = await fixture();
  await f.define({ preset: 'Ask me' }); await f.publish();
  const { Accounts, Journey, durableBackend } = await import('../src/objects.ts');
  let loseReceipt = true;
  const env: import('../src/objects.ts').ObjectBindings = { WORKOS_API_KEY: 'synthetic-unused', BLOBS: f.backend.blobs,
    ACCOUNTS: { getByName() { return { async fetch(request) {
      const body = await request.clone().json() as { action?: string };
      const response = await new Accounts({ storage: f.backend.accountStorage }, env).fetch(request);
      if (body.action === 'standingDecision' && loseReceipt) { loseReceipt = false; throw new Error('synthetic lost standing receipt'); }
      return response;
    } }; } },
    JOURNEYS: { getByName(id) { return { fetch: request => new Journey({ storage: f.backend.journeyStores.get(id)! }, env, () => 1_800_000_000_000).fetch(request) }; } },
  };
  const backend = durableBackend(env);
  await backend.execute('bob', parseCommand('task_create', { journeyId: f.journeyId, name: 'Durable request', agentId: f.agentId, offerId: 'review', input: { question: 'Synthetic' }, maxRounds: 1, deadline: 1_800_003_600_000 }));
  const taskId = String((await f.tasks())[0]!.taskId);
  await backend.execute('alice', parseCommand('task_step', { journeyId: f.journeyId, taskId, action: 'approve', standing: 'always_allow' }));
  const storage = f.backend.journeyStores.get(f.journeyId)!;
  assert.equal(storage.alarmAt, 1_800_000_060_000, 'undelivered receipt must schedule a retry before the task deadline');
  await new Journey({ storage }, env, () => 1_800_000_060_000).alarm();
  assert.equal((await f.tasks())[0]!.status, 'claimed');
  const offers = (await backend.execute('alice', parseCommand('offer_list', { agentId: f.agentId }))).offers as { version: number; admission: { rules: unknown[] } }[];
  assert.equal(offers[0]!.version, 4, 'ambiguous retry must not advance the policy version twice');
  assert.equal(offers[0]!.admission.rules.length, 2);
  assert.equal(storage.alarmAt, 1_800_003_600_000);
  await f.request();
  assert.equal((await f.tasks())[1]!.status, 'claimed');
});


test('offers: a failed journey transaction cannot publish its standing decision', async () => {
  const f = await fixture();
  await f.define({ preset: 'Ask me' }); await f.publish(); await f.request();
  const taskId = String((await f.tasks())[0]!.taskId), storage = f.backend.journeyStores.get(f.journeyId)!;
  const before = f.backend.snapshot(), setAlarm = storage.setAlarm;
  storage.setAlarm = async () => { throw new Error('synthetic alarm write failed'); };
  await assert.rejects(f.call('alice', 'task_step', { journeyId: f.journeyId, taskId, action: 'approve', standing: 'always_allow' }), /synthetic alarm write failed/);
  storage.setAlarm = setAlarm;
  assert.equal(f.backend.snapshot(), before, 'both journey and Accounts must remain unchanged');
  assert.equal((await f.tasks())[0]!.status, 'requested');
  await f.call('alice', 'task_step', { journeyId: f.journeyId, taskId, action: 'approve', standing: 'always_allow' });
  await f.request();
  assert.deepEqual((await f.tasks()).map(t => t.status), ['claimed', 'claimed']);
});

test('offers: schema bounds and forged authority flags leave all persisted records unchanged', async () => {
  const f = await fixture();
  await f.define(); await f.publish();
  const before = f.backend.snapshot();
  await assert.rejects(f.request({ question: 'x'.repeat(16 * 1024) }), /16 KiB/);
  let nested: unknown = {};
  for (let i = 0; i < 9; i++) nested = { child: nested };
  await assert.rejects(f.request(nested), /nesting/);
  assert.throws(() => parseCommand('task_create', { journeyId: f.journeyId, name: 'Forged', agentId: f.agentId, offerId: 'review', input: { question: 'Hi' }, deadline: 1_800_003_600_000, maxRounds: 1, isDecider: true }), /Unrecognized key/);
  assert.equal(f.backend.snapshot(), before);
});


test('offers: a guide allowance does not turn a guide’s agent into a guide', async () => {
  const f = await fixture();
  await f.define({ admission: { rules: [{ who: 'guide', decision: 'allow' }], default: 'hold' } }); await f.publish();
  const input = { journeyId: f.journeyId, name: 'Guide check', agentId: f.agentId, offerId: 'review', input: { question: 'Synthetic' }, maxRounds: 1, deadline: 1_800_003_600_000 };
  await f.call('alice', 'task_create', input);
  await f.call('alice', 'task_create', { ...input, actingAgent: f.agentId });
  assert.deepEqual((await f.tasks()).map(t => t.status), ['claimed', 'requested']);
});


test('offers: reservation retries survive eviction and reject conflicting or stale claims', async () => {
  const f = await fixture();
  await f.call('alice', 'offer_settings', { agentId: f.agentId, maxRequestsPerDay: 1 });
  await f.define({ preset: 'Open' }); await f.publish();
  const { Accounts } = await import('../src/objects.ts');
  let accounts = new Accounts({ storage: f.backend.accountStorage }, { WORKOS_API_KEY: 'synthetic-unused' });
  const send = (body: Record<string, unknown>) => accounts.fetch(new Request('https://accounts.internal', { method: 'POST', body: JSON.stringify(body) }));
  const request = { taskId: 'task_synthetic', agentId: f.agentId, offerId: 'review', version: 3, journeyId: f.journeyId, requesterId: f.bob, requesterPersonId: f.bob, isAgent: false, isGuide: false };
  const reserve = (r = request) => send({ action: 'reserveAllowance', request: r });
  assert.deepEqual(await (await reserve()).json(), { value: 'allow' });
  const reserved = f.backend.snapshot();
  accounts = new Accounts({ storage: f.backend.accountStorage }, { WORKOS_API_KEY: 'synthetic-unused' });
  assert.deepEqual(await (await reserve()).json(), { value: 'allow' });
  assert.equal((await reserve({ ...request, requesterId: f.alice })).status, 409);
  assert.equal(f.backend.snapshot(), reserved, 'replays must not add usage or change the bound identity');
  await f.define({ preset: 'Open' });
  const edited = f.backend.snapshot();
  assert.equal((await reserve({ ...request, taskId: 'task_stale' })).status, 409);
  assert.equal((await send({ action: 'reserveAllowance', request: { ...request, taskId: 'task_forged', decision: 'allow' } })).status, 500);
  assert.equal(f.backend.snapshot(), edited, 'stale and malformed reservations must not consume allowance');
  assert.equal((await send({ action: 'releaseAllowance', taskId: request.taskId })).status, 200);
  assert.equal((await send({ action: 'releaseAllowance', taskId: request.taskId })).status, 200);
  assert.deepEqual(await (await reserve({ ...request, taskId: 'task_new', version: 4 })).json(), { value: 'allow' });
});

test('offers: an aborted journey commit releases the shared allowance', async () => {
  const f = await fixture();
  await f.call('alice', 'offer_settings', { agentId: f.agentId, maxRequestsPerDay: 1 });
  await f.define({ admission: { rules: [{ who: 'members', decision: 'allow', limit: { count: 1, per: 'hour' } }], default: 'hold' } }); await f.publish();
  const before = f.backend.snapshot(), storage = f.backend.journeyStores.get(f.journeyId)!, setAlarm = storage.setAlarm;
  storage.setAlarm = async () => { throw new Error('synthetic allowance transaction abort'); };
  await assert.rejects(f.request(), /synthetic allowance transaction abort/);
  storage.setAlarm = setAlarm;
  assert.equal(f.backend.snapshot(), before, 'neither the task nor its reservation may survive a definite abort');
  await f.request(); await f.request();
  assert.deepEqual((await f.tasks()).map(t => t.status), ['claimed', 'requested']);
});

test('offers: a lost reservation reply fails closed after Accounts eviction', async () => {
  const f = await fixture();
  await f.call('alice', 'offer_settings', { agentId: f.agentId, maxRequestsPerDay: 1 });
  await f.define({ preset: 'Open' }); await f.publish();
  const { Accounts, Journey, durableBackend } = await import('../src/objects.ts');
  let accounts = new Accounts({ storage: f.backend.accountStorage }, { WORKOS_API_KEY: 'synthetic-unused' });
  let loseReply = true;
  const env: import('../src/objects.ts').ObjectBindings = { WORKOS_API_KEY: 'synthetic-unused', BLOBS: f.backend.blobs,
    ACCOUNTS: { getByName() { return { async fetch(request) {
      const body = await request.clone().json() as { action?: string };
      const response = await accounts.fetch(request);
      if (body.action === 'reserveAllowance' && loseReply) { loseReply = false; throw new Error('synthetic lost allowance reply'); }
      return response;
    } }; } },
    JOURNEYS: { getByName(id) { return { fetch: request => new Journey({ storage: f.backend.journeyStores.get(id)! }, env, () => 1_800_000_000_000).fetch(request) }; } },
  };
  const backend = durableBackend(env);
  const request = () => backend.execute('bob', parseCommand('task_create', { journeyId: f.journeyId, name: 'Durable request', agentId: f.agentId, offerId: 'review', input: { question: 'Synthetic' }, maxRounds: 1, deadline: 1_800_003_600_000 }));
  await assert.rejects(request(), /Coordination storage operation failed/);
  assert.deepEqual(await f.tasks(), []);
  accounts = new Accounts({ storage: f.backend.accountStorage }, { WORKOS_API_KEY: 'synthetic-unused' });
  await request();
  assert.deepEqual((await f.tasks()).map(t => t.status), ['requested'], 'an uncertain reservation must not free a second automatic admission');
});

for (const allowance of ['agent', 'requester', 'requester-agent'] as const) for (const concurrent of [false, true]) {
  test(`offers: ${allowance} allowance spans two journeys (${concurrent ? 'concurrent' : 'sequential'})`, async () => {
    const f = await fixture();
    const second = String((await f.call('alice', 'journey_create', { name: 'Second journey', policy: 'open', defaultRole: 'write' })).journeyId);
    // Deliberately give Bob a different journey-local identity slot.
    await f.call('eve', 'journey_join', { journeyId: second });
    await f.call('bob', 'journey_join', { journeyId: second });
    await f.call('alice', 'agent_add', { journeyId: second, agentId: f.agentId });
    if (allowance === 'requester-agent') await f.call('bob', 'agent_add', { journeyId: second, agentId: f.requesterId });
    if (allowance === 'agent') await f.call('alice', 'offer_settings', { agentId: f.agentId, maxRequestsPerDay: 1 });
    await f.define({ preset: 'Open', ...(allowance !== 'agent' ? { admission: { rules: [{ who: 'members', decision: 'allow', limit: { count: 1, per: 'hour' } }], default: 'hold' } } : {}) });
    await f.publish();
    // The owner ceiling also spans offers and requesters, not just journeys.
    if (allowance === 'agent') {
      await f.define({ id: 'other', preset: 'Open' });
      await f.call('alice', 'offer_publish', { agentId: f.agentId, offerId: 'other' });
    }
    const secondOfferId = allowance === 'agent' ? 'other' : 'review';
    const secondOffer = ((await f.call('alice', 'offer_list', { agentId: f.agentId })).offers as { id: string; version: number }[]).find(o => o.id === secondOfferId)!;
    await f.call('alice', 'offer_journey_set', { agentId: f.agentId, offerId: secondOfferId, journeyId: second, expectedVersion: secondOffer.version, enabled: true });
    const requestSecond = () => f.call(allowance === 'agent' ? 'eve' : 'bob', 'task_create', {
      journeyId: second, name: 'Second request', agentId: f.agentId, offerId: allowance === 'agent' ? 'other' : 'review',
      actingAgent: allowance === 'requester-agent' ? f.requesterId : undefined, input: { question: 'Synthetic' }, maxRounds: 1, deadline: 1_800_100_000_000,
    });
    const requestFirst = () => f.request({ question: 'Synthetic' }, allowance === 'requester-agent' ? f.requesterId : undefined);
    if (concurrent) await Promise.all([requestFirst(), requestSecond()]);
    else { await requestFirst(); await requestSecond(); }
    const otherTasks = (await f.call('alice', 'journey_read', { journeyId: second })).tasks as { status: string }[];
    assert.deepEqual([...(await f.tasks()), ...otherTasks].map(t => t.status).sort(), ['claimed', 'requested']);
    f.advance(allowance === 'agent' ? 86_400_000 : 3_600_000);
    await requestSecond();
    const later = (await f.call('alice', 'journey_read', { journeyId: second })).tasks as { status: string }[];
    assert.equal(later[1]!.status, 'claimed', 'the shared rolling allowance resets at its period boundary');
  });
}
