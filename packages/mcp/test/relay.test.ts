import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MemoryBackend } from '../src/backend.ts';
import { app, bridge, keyPair, RESOURCE, token } from './helpers.ts';
import { AccountsHost } from '../src/accounts.ts';
import { Accounts, Journey, durableBackend, type ObjectNamespace } from '../src/objects.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryBlobs } from '../src/relay.ts';
import { parseCommand } from '../src/commands.ts';

const signer = await keyPair('relay');
type Data = Record<string, unknown>;
async function fixture(t: TestContext) {
  const backend = new MemoryBackend({ async get(subject) { return { name: subject, email: `${subject}@example.test` }; } });
  async function connect(sub: string) {
    const client = new Client({ name: 'relay-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: bridge(app(signer, backend)), requestInit: { headers: { authorization: `Bearer ${await token(signer, { sub })}` } } }));
    t.after(() => client.close());
    return client;
  }
  async function call(client: Client, name: string, args: Data = {}): Promise<Data> {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.structuredContent);
    return result.structuredContent as Data;
  }
  async function refused(client: Client, name: string, args: Data) {
    const before = backend.snapshot();
    const writes = [backend.accountStorage.writes, ...[...backend.journeyStores.values()].map(s => s.writes), backend.blobs.writes];
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(backend.snapshot(), before, 'refusal preserves persisted bytes');
    assert.deepEqual([backend.accountStorage.writes, ...[...backend.journeyStores.values()].map(s => s.writes), backend.blobs.writes], writes, 'refusal performs no writes');
  }
  const alice = await connect('alice'), bob = await connect('bob'), eve = await connect('eve');
  const a = (await call(alice, 'account_read')).personId as string;
  const b = (await call(bob, 'account_read')).personId as string;
  await call(eve, 'account_read');
  const journeyId = (await call(alice, 'journey_create', { name: 'Relay', policy: 'open' })).journeyId as string;
  await call(bob, 'journey_join', { journeyId });
  return { backend, alice, bob, eve, a, b, groupId: journeyId, call, refused, connect };
}

test('relay: tools register and messages have monotone epochs, sequences and since cursors', async t => {
  const f = await fixture(t), groupId = f.groupId;
  const names = (await f.alice.listTools()).tools.map(t => t.name);
  for (const name of ['mls_key_package_publish', 'mls_key_package_fetch', 'mls_message_post', 'mls_message_fetch', 'artifact_blob_put', 'artifact_blob_get']) assert.ok(names.includes(name), name);
  assert.deepEqual(await f.call(f.alice, 'mls_message_post', { groupId, epoch: 1, kind: 'handshake', data: 'AAH/' }), { sequence: 1 });
  assert.deepEqual(await f.call(f.bob, 'mls_message_post', { groupId, epoch: 1, kind: 'application', data: 'AgM=' }), { sequence: 2 });
  await f.refused(f.alice, 'mls_message_post', { groupId, epoch: 0, kind: 'handshake', data: 'BA==' });
  assert.deepEqual(await f.call(f.alice, 'mls_message_fetch', { groupId, since: 1 }), { messages: [{ sequence: 2, epoch: 1, kind: 'application', sender: f.b, data: 'AgM=' }], cursor: 2 });
  assert.deepEqual(await f.call(f.alice, 'mls_message_fetch', { groupId, since: 2 }), { messages: [], cursor: 2 });
});

test('relay: outsiders, removed members and restricted agents cannot read or write group bytes', async t => {
  const f = await fixture(t), groupId = f.groupId;
  await f.call(f.alice, 'mls_message_post', { groupId, epoch: 0, kind: 'handshake', data: 'AA==' });
  await f.refused(f.eve, 'mls_message_fetch', { groupId });
  await f.refused(f.eve, 'mls_message_post', { groupId, epoch: 0, kind: 'application', data: 'AA==' });
  const agent = ((await f.call(f.bob, 'agent_add', { journeyId: groupId, name: 'limited', read: false, write: false, grant: false })).agents as Data[])[0]!.agentId;
  await f.refused(f.bob, 'mls_message_fetch', { groupId, actingAgent: agent });
  await f.refused(f.eve, 'mls_message_fetch', { groupId, actingAgent: agent });
  await f.call(f.alice, 'journey_remove', { journeyId: groupId, memberId: f.b });
  await f.refused(f.bob, 'mls_message_fetch', { groupId });
  await f.refused(f.bob, 'mls_message_post', { groupId, epoch: 1, kind: 'handshake', data: 'AA==' });
  await f.refused(await f.connect('unprovisioned'), 'mls_message_fetch', { groupId });
});

test('relay: personal groups accept only the owner and their live registered devices or agents', async t => {
  const f = await fixture(t), groupId = `personal_${f.a}`;
  const memberId = ((await f.call(f.alice, 'personal_group_add', { name: 'laptop', kind: 'device' })).members as Data[])[1]!.id;
  await f.call(f.alice, 'mls_message_post', { groupId, memberId, epoch: 0, kind: 'handshake', data: 'AA==' });
  await f.refused(f.bob, 'mls_message_fetch', { groupId, memberId });
  await f.refused(f.alice, 'mls_message_fetch', { groupId, memberId: f.b });
  await f.call(f.alice, 'personal_group_remove', { memberId });
  await f.refused(f.alice, 'mls_message_fetch', { groupId, memberId });
  assert.equal((await f.call(f.alice, 'mls_message_fetch', { groupId })).cursor, 1);
});

test('relay: key packages belong to live person-device registrations and are consumed once', async t => {
  const f = await fixture(t);
  const deviceId = ((await f.call(f.alice, 'personal_group_add', { name: 'laptop', kind: 'device' })).members as Data[])[1]!.id;
  await f.refused(f.bob, 'mls_key_package_publish', { deviceId, data: 'AAE=' });
  await f.call(f.alice, 'mls_key_package_publish', { deviceId, data: 'AAE=' });
  const fetched = await Promise.all([f.call(f.bob, 'mls_key_package_fetch', { personId: f.a, deviceId }), f.call(f.bob, 'mls_key_package_fetch', { personId: f.a, deviceId })]);
  assert.deepEqual(fetched.map(p => p.data).sort(), ['AAE=', null].sort());
  await f.call(f.alice, 'mls_key_package_publish', { deviceId, data: 'Ag==' });
  await f.call(f.alice, 'personal_group_remove', { memberId: deviceId });
  await f.refused(f.alice, 'mls_key_package_publish', { deviceId, data: 'Aw==' });
  await f.refused(f.bob, 'mls_key_package_fetch', { personId: f.a, deviceId });
});

test('relay: ciphertext blobs are isolated by group, artifact and immutable version', async t => {
  const f = await fixture(t), groupId = f.groupId;
  const artifactId = ((await f.call(f.alice, 'artifact_create', { journeyId: groupId, name: 'File', type: 'text', size: 3 })).artifacts as Data[])[0]!.artifactId;
  await f.call(f.alice, 'artifact_blob_put', { groupId, artifactId, version: 1, data: 'AP8B' });
  assert.deepEqual(await f.call(f.bob, 'artifact_blob_get', { groupId, artifactId, version: 1 }), { data: 'AP8B' });
  await f.refused(f.bob, 'artifact_blob_put', { groupId, artifactId, version: 1, data: 'AA==' });
  await f.refused(f.alice, 'artifact_blob_put', { groupId, artifactId, version: 1, data: 'AQ==' });
  await f.refused(f.eve, 'artifact_blob_get', { groupId, artifactId, version: 1 });
  await f.refused(f.alice, 'artifact_blob_get', { groupId: `personal_${f.a}`, artifactId, version: 1 });
  await f.refused(f.alice, 'artifact_blob_put', { groupId, artifactId: 'missing', version: 1, data: 'AA==' });
  await f.call(f.alice, 'artifact_delete', { journeyId: groupId, artifactId });
  await f.refused(f.alice, 'artifact_blob_get', { groupId, artifactId, version: 1 });
});

test('relay: personal ciphertext supports local artifact ids and rejects malformed or oversized input without writes', async t => {
  const f = await fixture(t), groupId = `personal_${f.a}`, artifactId = 'local-artifact';
  await f.call(f.alice, 'artifact_blob_put', { groupId, artifactId, version: 1, data: 'AA==' });
  assert.deepEqual(await f.call(f.alice, 'artifact_blob_get', { groupId, artifactId, version: 1 }), { data: 'AA==' });
  await f.refused(f.bob, 'artifact_blob_get', { groupId, artifactId, version: 1 });
  await f.refused(f.alice, 'mls_message_post', { groupId, epoch: 0, kind: 'application', data: '!bad!' });
  await f.refused(f.alice, 'mls_message_post', { groupId, epoch: 2 ** 53, kind: 'application', data: 'AA==' });
  await f.refused(f.alice, 'mls_message_fetch', { groupId, since: -1 });
  await f.refused(f.alice, 'mls_message_fetch', { groupId, personId: f.b });
  await f.refused(f.alice, 'mls_message_post', { groupId, epoch: 0, kind: 'application', data: Buffer.alloc(1048577).toString('base64') });
  await f.refused(f.alice, 'artifact_blob_put', { groupId, artifactId, version: 2, data: Buffer.alloc(10485761).toString('base64') });
});

test('relay: concurrent message posts preserve sequence and cursor pagination across epochs', async t => {
  const f = await fixture(t), groupId = f.groupId;
  await Promise.all(Array.from({ length: 12 }, () => f.call(f.alice, 'mls_message_post', { groupId, epoch: 0, kind: 'application', data: 'AA==' })));
  await f.call(f.alice, 'mls_message_post', { groupId, epoch: 1, kind: 'handshake', data: 'AQ==' });
  const first = await f.call(f.bob, 'mls_message_fetch', { groupId, limit: 5 });
  assert.deepEqual((first.messages as Data[]).map(m => m.sequence), [1, 2, 3, 4, 5]);
  assert.equal(first.cursor, 5);
  const rest = await f.call(f.bob, 'mls_message_fetch', { groupId, since: 5 });
  assert.deepEqual((rest.messages as Data[]).map(m => [m.sequence, m.epoch]), [[6, 0], [7, 0], [8, 0], [9, 0], [10, 0], [11, 0], [12, 0], [13, 1]]);
  assert.equal(rest.cursor, 13);
});

test('relay: exact message and blob byte limits round trip with bounded message pages', async t => {
  const f = await fixture(t), groupId = `personal_${f.a}`;
  const message = Buffer.alloc(1048576, 255).toString('base64');
  await Promise.all(Array.from({ length: 5 }, () => f.call(f.alice, 'mls_message_post', { groupId, epoch: 0, kind: 'application', data: message })));
  const page = await f.call(f.alice, 'mls_message_fetch', { groupId });
  assert.equal((page.messages as Data[]).length, 4);
  assert.equal(page.cursor, 4);
  const last = await f.call(f.alice, 'mls_message_fetch', { groupId, since: 4 });
  assert.equal((last.messages as Data[])[0]!.data, message);
  assert.equal(last.cursor, 5);
  const data = Buffer.alloc(10485760, 254).toString('base64');
  await f.call(f.alice, 'artifact_blob_put', { groupId, artifactId: 'large', version: 1, data });
  assert.deepEqual(await f.call(f.alice, 'artifact_blob_get', { groupId, artifactId: 'large', version: 1 }), { data });
  await f.refused(f.alice, 'mls_message_post', { groupId, epoch: 0, kind: 'application', data: 'AB==' });
  await f.refused(f.alice, 'mls_message_post', { groupId, epoch: 0, kind: 'application', data: 'AAAAA' });
});

test('relay: actual Durable Object adapters reload messages, key packages and R2 ciphertext after eviction', async () => {
  const blobs = new MemoryBlobs(), accountsStore = new MemoryStorage(), stores = new Map<string, MemoryStorage>();
  const accountsHost = new AccountsHost(accountsStore, { async get() { return { name: 'Owner', email: 'owner@example.test' }; } });
  const account = await accountsHost.provision('owner');
  const accountNamespace: ObjectNamespace = { getByName() { return { fetch: request => new Accounts({ storage: accountsStore }, { WORKOS_API_KEY: 'unused', BLOBS: blobs }).fetch(request) }; } };
  const journeys: ObjectNamespace = { getByName(id) {
    let store = stores.get(id);
    if (!store) { store = new MemoryStorage(); stores.set(id, store); }
    const storage = store;
    return { fetch: request => new Journey({ storage }, { BLOBS: blobs }).fetch(request) };
  } };
  const backend = durableBackend({ ACCOUNTS: accountNamespace, JOURNEYS: journeys, WORKOS_API_KEY: 'unused', BLOBS: blobs });
  const call = (tool: string, input: Data = {}) => backend.execute('owner', parseCommand(tool, input));
  const groupId = (await call('journey_create', { name: 'Persistent relay' })).journeyId as string;
  await call('mls_message_post', { groupId, epoch: 1, kind: 'handshake', data: 'AAH/' });
  assert.deepEqual(await call('mls_message_fetch', { groupId }), { messages: [{ sequence: 1, epoch: 1, kind: 'handshake', sender: account.personId, data: 'AAH/' }], cursor: 1 });
  const personal = `personal_${account.personId}`;
  const deviceId = ((await call('personal_group_add', { name: 'Laptop', kind: 'device' })).members as Data[])[1]!.id;
  await call('mls_key_package_publish', { deviceId, data: 'AA==' });
  assert.equal((await call('mls_key_package_fetch', { personId: account.personId, deviceId })).data, 'AA==');
  assert.equal((await call('mls_key_package_fetch', { personId: account.personId, deviceId })).data, null);
  await call('artifact_blob_put', { groupId: personal, artifactId: 'local', version: 1, data: 'AP8B' });
  assert.deepEqual(await call('artifact_blob_get', { groupId: personal, artifactId: 'local', version: 1 }), { data: 'AP8B' });
  assert.deepEqual([...blobs.data.values()].map(value => [...value]), [[0, 1, 255], [0, 255, 1]]);
});

test('relay: removed members cannot fetch ciphertext and writable agents intersect their current card', async t => {
  const f = await fixture(t), groupId = f.groupId;
  const artifactId = ((await f.call(f.alice, 'artifact_create', { journeyId: groupId, name: 'Restricted', type: 'text', size: 1 })).artifacts as Data[])[0]!.artifactId;
  await f.call(f.alice, 'artifact_blob_put', { groupId, artifactId, version: 1, data: 'AA==' });
  await f.call(f.alice, 'journey_remove', { journeyId: groupId, memberId: f.b });
  await f.refused(f.bob, 'artifact_blob_get', { groupId, artifactId, version: 1 });
  await f.refused(f.bob, 'artifact_blob_put', { groupId, artifactId, version: 1, data: 'AQ==' });
  const agentId = ((await f.call(f.alice, 'agent_add', { journeyId: groupId, name: 'Reader', read: true, write: false, grant: false })).agents as Data[])[0]!.agentId;
  await f.call(f.alice, 'mls_message_post', { groupId, actingAgent: agentId, epoch: 0, kind: 'application', data: 'AA==' });
  const messages = (await f.call(f.alice, 'mls_message_fetch', { groupId })).messages as Data[];
  assert.equal(messages[0]!.sender, agentId);
  await f.call(f.alice, 'artifact_version', { journeyId: groupId, artifactId, baseVersion: 1, size: 1 });
  await f.refused(f.alice, 'artifact_blob_put', { groupId, actingAgent: agentId, artifactId, version: 2, data: 'AQ==' });
  await f.call(f.alice, 'agent_card', { journeyId: groupId, agentId, action: 'withdraw', read: true, write: false, grant: false });
  await f.refused(f.alice, 'mls_message_fetch', { groupId, actingAgent: agentId });
});

test('relay: unconsumed key packages cannot be overwritten, and the key-package decoded limit is enforced', async t => {
  const f = await fixture(t);
  const deviceId = ((await f.call(f.alice, 'personal_group_add', { name: 'Agent', kind: 'agent' })).members as Data[])[1]!.id;
  await f.refused(f.alice, 'mls_key_package_publish', { deviceId, data: Buffer.alloc(65537).toString('base64') });
  await f.call(f.alice, 'mls_key_package_publish', { deviceId, data: 'AQ==' });
  await f.refused(f.alice, 'mls_key_package_publish', { deviceId, data: 'Ag==' });
  assert.equal((await f.call(f.bob, 'mls_key_package_fetch', { personId: f.a, deviceId })).data, 'AQ==');
});

test('relay: a full PoC log refuses before writing and stays under the DO value limit', async t => {
  const f = await fixture(t), groupId = f.groupId;
  await Promise.all(Array.from({ length: 128 }, () => f.call(f.alice, 'mls_message_post', { groupId, epoch: 0, kind: 'application', data: 'AA==' })));
  await f.refused(f.alice, 'mls_message_post', { groupId, epoch: 0, kind: 'handshake', data: 'AA==' });
  const first = await f.call(f.bob, 'mls_message_fetch', { groupId });
  assert.equal((first.messages as Data[]).length, 100);
  assert.equal(first.cursor, 100);
  const last = await f.call(f.bob, 'mls_message_fetch', { groupId, since: 100 });
  assert.equal((last.messages as Data[]).length, 28);
  assert.equal(last.cursor, 128);
  const largest = Math.max(...[...f.backend.journeyStores.get(groupId)!.data.values()].map(value => new TextEncoder().encode(value).length));
  assert.ok(largest < 131072);
});
