import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountsHost } from '../src/accounts.ts';
import { Backend } from '../src/backend.ts';
import { JourneyHost } from '../src/journey.ts';
import { parseCommand } from '../src/commands.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryBlobs } from '../src/relay.ts';
import { WRITE_TTL_MS, type WriteHooks, type WritePermit } from '../src/write-permits.ts';
import { setAgentCard, testPasskeys } from './helpers.ts';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const profiles = { async get(subject: string) { return { name: subject, email: `${subject}@example.test` }; } };
async function fixture() {
  let time = 1_800_000_000_000;
  const now = () => time;
  const accountStore = new MemoryStorage(), journeyStore = new MemoryStorage(), blobs = new MemoryBlobs(), hooks: WriteHooks = {};
  let accounts = new AccountsHost(accountStore, profiles, blobs, testPasskeys, now);
  let journey = new JourneyHost(journeyStore, now, blobs, undefined, accounts, hooks);
  const backend = new Backend(accounts, () => journey);
  const personId = String((await backend.execute('alice', parseCommand('account_read', {}))).personId);
  const journeyId = String((await backend.execute('alice', parseCommand('journey_create', { name: 'Fence', policy: 'open', defaultRole: 'write' }))).journeyId);
  const agentId = String((await backend.execute('alice', parseCommand('agent_create', { name: 'Writer' }))).agentId);
  await setAgentCard(backend, 'alice', agentId, ['read', 'artifact.write', 'device.keys']);
  await backend.execute('alice', parseCommand('agent_add', { journeyId, agentId }));
  const actor = await accounts.resolveActor(personId, 'trusted-host', agentId);
  const message = parseCommand('mls_message_post', { groupId: journeyId, actingAgent: agentId, epoch: 1, kind: 'application', data: 'AQI=' });
  const artifact = parseCommand('artifact_create', { journeyId, actingAgent: agentId, name: 'Must not publish', type: 'note', size: 2 });
  const revoke = () => accounts.agentCommand(personId, 'trusted-host', parseCommand('agent_card', { agentId, action: 'withdraw' }));
  return { backend, personId, journeyId, agentId, actor, message, artifact, hooks, blobs, accountStore, journeyStore, now,
    get accounts() { return accounts; }, get journey() { return journey; }, revoke,
    advance(ms: number) { time += ms; },
    evict() { accounts = new AccountsHost(accountStore, profiles, blobs, testPasskeys, now); journey = new JourneyHost(journeyStore, now, blobs, undefined, accounts, hooks); },
    async messages() { return journey.execute(personId, parseCommand('mls_message_fetch', { groupId: journeyId })); },
    async artifacts() { return (await journey.execute(personId, parseCommand('journey_read', { journeyId }))).artifacts; },
  };
}

test('write permits: unresolved permit caps are per account',async()=>{
 const host=new AccountsHost(new MemoryStorage(),profiles,undefined,undefined,()=>1_800_000_000_000);
 const alice=await host.provision('alice'),bob=await host.provision('bob');
 const a=await host.resolveActor(alice.personId,'trusted-host'),b=await host.resolveActor(bob.personId,'trusted-host');
 for(let n=0;n<128;n++) await host.issueWrite({actor:a,target:'journey_test',digest:`test-${n}`});
 await assert.rejects(host.issueWrite({actor:a,target:'journey_test',digest:'excess'}),/capacity/);
 assert.equal((await host.issueWrite({actor:b,target:'journey_test',digest:'other-account'})).personId,bob.personId);
});

// These tests force the check/use window at the actual host boundary, not a copied permit model.
for (const kind of ['relay', 'artifact'] as const) test(`write permits: revoke between check and commit refuses ${kind}`, async () => {
  const f = await fixture(), issued = latch(), resume = latch();
  f.hooks.issued = async () => { issued.release(); await resume.promise; };
  const write = f.journey.execute(f.personId, kind === 'relay' ? f.message : f.artifact, undefined, f.actor);
  const refused = assert.rejects(write, /revoked|expired/);
  await issued.promise;
  await f.revoke();
  assert.equal((await f.accounts.drainWrites(f.personId)).state, 'complete', 'unredeemed permits are cancelled by the freeze');
  resume.release(); await refused;
  assert.deepEqual(await f.messages(), { messages: [], cursor: 0 });
  assert.deepEqual(await f.artifacts(), []);
  assert.equal(f.blobs.writes, 0, 'no R2 bytes may publish before redemption');
});

test('write permits: crash after issuance expires safely across authority and Journey eviction', async () => {
  const f = await fixture(); let permit!: WritePermit;
  f.hooks.issued = async value => { permit = value; throw new Error('crash after issue'); };
  await assert.rejects(f.journey.execute(f.personId, f.message, undefined, f.actor), /crash after issue/);
  assert.equal(permit.expiresAt - f.now(), 30_000);
  delete f.hooks.issued; f.evict(); f.advance(WRITE_TTL_MS);
  await assert.rejects(f.accounts.redeemWrite(permit), /expired/);
  const receipt = await f.journey.cancelWrite(permit);
  assert.equal(receipt.outcome, 'cancelled');
  await f.accounts.settleWrite(receipt);
  await f.revoke();
  assert.equal((await f.accounts.drainWrites(f.personId)).state, 'complete');
  await assert.rejects(f.journey.execute(f.personId, f.message, undefined, f.actor, permit.id), /did not commit/);
  assert.deepEqual(await f.messages(), { messages: [], cursor: 0 });
  assert.equal(f.blobs.writes, 0);
});

test('write permits: redeemed crash blocks revocation even after TTL until durable cancellation', async () => {
  const f = await fixture(); let permit!: WritePermit;
  f.hooks.redeemed = async value => { permit = value; throw new Error('crash after redeem'); };
  await assert.rejects(f.journey.execute(f.personId, f.message, undefined, f.actor), /crash after redeem/);
  await f.revoke();
  assert.equal((await f.accounts.drainWrites(f.personId)).state, 'pending');
  f.advance(WRITE_TTL_MS + 1); delete f.hooks.redeemed; f.evict();
  assert.equal((await f.accounts.drainWrites(f.personId)).state, 'pending', 'time is not a remote cancellation receipt');
  const receipt = await f.journey.cancelWrite(permit);
  assert.equal(receipt.outcome, 'cancelled');
  await f.accounts.settleWrite(receipt);
  assert.equal((await f.accounts.drainWrites(f.personId)).state, 'complete');
  assert.deepEqual(await f.messages(), { messages: [], cursor: 0 });
});

test('write permits: crash after commit before receipt recovers committed and duplicate commit is idempotent', async () => {
  const f = await fixture(); let permit!: WritePermit;
  f.hooks.committed = async value => { permit = value; throw new Error('lost commit reply'); };
  await assert.rejects(f.journey.execute(f.personId, f.message, undefined, f.actor), /lost commit reply/);
  delete f.hooks.committed; f.evict();
  assert.deepEqual(await f.journey.execute(f.personId, f.message, undefined, f.actor, permit.id), { sequence: 1 });
  assert.deepEqual(await f.journey.execute(f.personId, f.message, undefined, f.actor, permit.id), { sequence: 1 });
  assert.equal(f.blobs.writes, 1);
  assert.equal((await f.messages()).cursor, 1);
  await f.revoke();
  assert.equal((await f.accounts.drainWrites(f.personId)).state, 'pending');
  const receipt = await f.journey.cancelWrite(permit);
  assert.equal(receipt.outcome, 'committed');
  await f.accounts.settleWrite(receipt); await f.accounts.settleWrite(receipt);
  assert.equal((await f.accounts.drainWrites(f.personId)).state, 'complete');
  await assert.rejects(f.accounts.settleWrite({ permit, outcome: 'cancelled' }), /Conflicting/);
  await assert.rejects(f.journey.execute(f.personId, f.artifact, undefined, f.actor, permit.id), /mismatched/);
});

test('write permits: a revoked in-flight redemption drains before revocation completes', async () => {
  const f = await fixture(), redeemed = latch(), resume = latch(); let permit!: WritePermit;
  f.hooks.redeemed = async value => { permit = value; redeemed.release(); await resume.promise; };
  const write = f.journey.execute(f.personId, f.message, undefined, f.actor);
  await redeemed.promise; await f.revoke();
  assert.equal((await f.accounts.drainWrites(f.personId)).state, 'pending');
  resume.release(); assert.deepEqual(await write, { sequence: 1 });
  assert.equal((await f.accounts.drainWrites(f.personId)).state, 'complete');
  assert.equal((await f.journey.cancelWrite(permit)).outcome, 'committed');
  assert.equal((await f.messages()).cursor, 1);
});

test('write permits: expiry during R2 upload cannot publish orphan bytes', async () => {
  const f = await fixture(); let permit!: WritePermit;
  f.hooks.redeemed = async value => { permit = value; };
  const put = f.blobs.put.bind(f.blobs);
  f.blobs.put = async (key, value) => { await put(key, value); f.advance(WRITE_TTL_MS); };
  await assert.rejects(f.journey.execute(f.personId, f.message, undefined, f.actor), /expired before publication/);
  assert.deepEqual(await f.messages(), { messages: [], cursor: 0 });
  assert.equal(f.blobs.data.size, 1, 'an orphan is retained, not exposed or described as erased');
  f.evict(); await f.accounts.settleWrite(await f.journey.cancelWrite(permit));
  assert.equal((await f.accounts.drainWrites(f.personId)).state, 'complete');
});

test('write permits: member removed after actor resolution cannot publish through a stale actor', async () => {
  const f = await fixture();
  const bob = String((await f.backend.execute('bob', parseCommand('account_read', {}))).personId);
  await f.backend.execute('bob', parseCommand('journey_join', { journeyId: f.journeyId }));
  const stale = await f.accounts.resolveActor(bob, 'trusted-host');
  await f.backend.execute('alice', parseCommand('journey_remove', { journeyId: f.journeyId, memberId: bob }));
  await assert.rejects(f.journey.execute(bob, parseCommand('mls_message_post', { groupId: f.journeyId, epoch: 1, kind: 'application', data: 'AA==' }), undefined, stale), /readable member/);
  assert.deepEqual(await f.messages(), { messages: [], cursor: 0 });
});

test('write permits: membership removal waits for its local serial write before reporting complete', async () => {
  const f = await fixture(), uploading = latch(), resume = latch();
  const bob = String((await f.backend.execute('bob', parseCommand('account_read', {}))).personId);
  await f.backend.execute('bob', parseCommand('journey_join', { journeyId: f.journeyId }));
  const actor = await f.accounts.resolveActor(bob, 'trusted-host'), put = f.blobs.put.bind(f.blobs);
  f.blobs.put = async (key, value) => { uploading.release(); await resume.promise; await put(key, value); };
  const write = f.journey.execute(bob, parseCommand('mls_message_post', { groupId: f.journeyId, epoch: 1, kind: 'application', data: 'AA==' }), undefined, actor);
  await uploading.promise;
  let removed = false;
  const remove = f.journey.execute(f.personId, parseCommand('journey_remove', { journeyId: f.journeyId, memberId: bob })).then(value => { removed = true; return value; });
  await Promise.resolve(); assert.equal(removed, false);
  resume.release(); assert.deepEqual(await write, { sequence: 1 }); await remove;
  await assert.rejects(f.journey.execute(bob, parseCommand('mls_message_post', { groupId: f.journeyId, epoch: 2, kind: 'application', data: 'Ag==' }), undefined, actor), /readable member/);
  assert.equal((await f.messages()).cursor, 1);
});

test('write permits: personal relay re-resolves a stale agent card at its local authority', async () => {
  const f = await fixture(); await f.revoke();
  await assert.rejects(f.accounts.group(f.personId, parseCommand('mls_message_post', { groupId: `personal_${f.personId}`, epoch: 0, kind: 'handshake', data: 'AA==' }), f.actor), /device.keys/);
  assert.equal(f.blobs.writes, 0);
});

test('write permits: unavailable authority and injected permit metadata fail closed', async () => {
  const f = await fixture();
  const offline = new JourneyHost(f.journeyStore, f.now, f.blobs);
  await assert.rejects(offline.execute(f.personId, f.message, undefined, f.actor), /authority unavailable/);
  await assert.rejects(f.accounts.issueWrite({ target: f.journeyId, digest: 'x', actor: f.actor, phase: 'redeemed' } as unknown as Parameters<AccountsHost['issueWrite']>[0]));
  assert.deepEqual(await f.messages(), { messages: [], cursor: 0 });
  assert.equal(f.blobs.writes, 0);
});


test('write permits: revocation API returns pending while the receiver is stalled, then completes after drain', { timeout: 5_000 }, async () => {
  const f = await fixture(), redeemed = latch(), resume = latch();
  f.hooks.redeemed = async () => { redeemed.release(); await resume.promise; };
  const write = f.journey.execute(f.personId, f.message, undefined, f.actor);
  await redeemed.promise;
  const response = await f.backend.execute('alice', parseCommand('agent_card', { agentId: f.agentId, action: 'withdraw' }));
  assert.deepEqual(response.revocation, { state: 'pending', retryAt: f.now() + WRITE_TTL_MS });
  assert.equal((await f.accounts.drainWrites(f.personId)).state, 'pending');
  resume.release(); await write;
  assert.equal((await f.backend.recoverWrites(f.personId)).state, 'complete');
  await assert.rejects(f.backend.execute('alice', f.message), /refused|changed/);
});

test('write permits: cancellation before prepare leaves a durable tombstone and cannot be redeemed', async () => {
  const f = await fixture();
  const permit = await f.accounts.issueWrite({ actor: f.actor, target: f.journeyId, digest: 'cancel-before-prepare' });
  const receipt = await f.journey.cancelWrite(permit);
  await f.accounts.settleWrite(receipt); f.evict();
  assert.deepEqual(await f.journey.cancelWrite(permit), receipt);
  await f.accounts.settleWrite(receipt);
  await assert.rejects(f.accounts.redeemWrite(permit), /revoked|expired|redeemed/);
  assert.deepEqual(await f.messages(), { messages: [], cursor: 0 });
});

test('write permits: receiver transaction rolls metadata back when the committed receipt cannot persist', async () => {
  const f = await fixture(); let permit!: WritePermit;
  f.hooks.redeemed = async value => { permit = value; };
  const put = f.journeyStore.put.bind(f.journeyStore);
  f.journeyStore.put = async (key, value) => {
    if (key.startsWith('write:receipt:') && JSON.parse(value).outcome === 'committed') throw new Error('receipt disk failure');
    await put(key, value);
  };
  await assert.rejects(f.journey.execute(f.personId, f.message, undefined, f.actor), /receipt disk failure/);
  assert.deepEqual(await f.messages(), { messages: [], cursor: 0 });
  assert.equal(f.blobs.data.size, 1, 'upload may orphan bytes but must not expose them');
  await f.revoke(); assert.equal((await f.accounts.drainWrites(f.personId)).state, 'pending');
  f.evict(); const receipt = await f.journey.cancelWrite(permit);
  assert.equal(receipt.outcome, 'cancelled'); await f.accounts.settleWrite(receipt);
  assert.equal((await f.accounts.drainWrites(f.personId)).state, 'complete');
});

test('write permits: terminal receipts do not accumulate in the bounded authority index', async () => {
  const f = await fixture();
  const initial = [...f.accountStore.data.keys()].filter(key => key.startsWith('write:terminal:')).length;
  for (let i = 0; i < 140; i++) {
    const permit = await f.accounts.issueWrite({ actor: f.actor, target: f.journeyId, digest: `index-${i}` });
    await f.accounts.redeemWrite(permit);
    await f.accounts.settleWrite(await f.journey.cancelWrite(permit));
  }
  const raw = String(await f.accountStore.get('write:authority'));
  assert.deepEqual(JSON.parse(raw).permits, []);
  assert.ok(raw.length < 4_096);
  assert.equal([...f.accountStore.data.keys()].filter(key => key.startsWith('write:terminal:')).length - initial, 140);
  assert.equal((await f.messages()).cursor, 0);
});
