import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MemoryBackend } from '../src/backend.ts';
import { Journey } from '../src/objects.ts';
import { app, bridge, keyPair, RESOURCE, token, testPasskeys, setAgentCard } from './helpers.ts';

const signer = await keyPair('library');
type Data = Record<string, unknown>;
const rows = (data: Data) => data.items as Data[];
async function fixture(t: TestContext) {
  const backend = new MemoryBackend({ async get(s) { return { name: s, email: `${s}@example.test` }; } }, Date.now, testPasskeys);
  async function connect(sub: string, clientId = 'test-client', legacy = false) {
    const client = new Client({ name: 'library-test', version: '1' }, { versionNegotiation: { mode: legacy ? 'legacy' : 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: bridge(app(signer, backend)), requestInit: { headers: { authorization: `Bearer ${await token(signer, { sub, client_id: clientId })}` } } }));
    t.after(() => client.close()); return client;
  }
  async function call(c: Client, name: string, input: Data = {}) {
    const r = await c.callTool({ name, arguments: input }); assert.notEqual(r.isError, true, JSON.stringify(r)); return r.structuredContent as Data;
  }
  async function refused(c: Client, name: string, input: Data) {
    const before = backend.snapshot();
    const writes = [backend.accountStorage.writes, ...[...backend.journeyStores.values()].map(s => s.writes), backend.blobs.writes];
    const r = await c.callTool({ name, arguments: input }); assert.equal(r.isError, true, JSON.stringify(r));
    assert.equal(backend.snapshot(), before);
    assert.deepEqual([backend.accountStorage.writes, ...[...backend.journeyStores.values()].map(s => s.writes), backend.blobs.writes], writes);
  }
  const alice = await connect('alice'), bob = await connect('bob', 'test-client', true), eve = await connect('eve');
  const a = (await call(alice, 'account_read')).personId, b = (await call(bob, 'account_read')).personId;
  await call(eve, 'account_read');
  const journeyId = (await call(alice, 'journey_create', { name: 'Library', policy: 'open', defaultRole: 'write' })).journeyId as string;
  await call(bob, 'journey_join', { journeyId });
  return { backend, alice, bob, eve, a, b, journeyId, call, refused, connect };
}

test('library: every kind is registered, created, described, labelled and filtered', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  const tools = (await f.alice.listTools()).tools.map(t => t.name);
  for (const name of ['library_add', 'library_version', 'library_update', 'library_delete', 'library_get', 'library_search']) assert.ok(tools.includes(name), name);
  for (const kind of ['markdown', 'html', 'pdf', 'code', 'image', 'video', 'audio', 'data', 'link', 'skill', 'prompt', 'agent', 'applet', 'other']) {
    const content = kind === 'link' ? { url: 'https://example.test/reference', summary: 'A reference' } : { text: `body ${kind}` };
    const added = await f.call(f.alice, 'library_add', { journeyId, name: `Example ${kind}`, kind, description: 'Useful material', labels: ['Research', 'free label'], ...content });
    const found = rows(await f.call(f.bob, 'library_search', { journeyId, kind, label: 'Research', query: 'useful material' }));
    assert.equal(found.length, 1); assert.equal(found[0]!.itemId, added.itemId); assert.equal(found[0]!.kind, kind);
    assert.deepEqual(found[0]!.labels, ['Research', 'free label']); assert.equal(found[0]!.description, 'Useful material');
  }
  assert.equal(rows(await f.call(f.alice, 'library_search', { journeyId })).length, 14);
  await f.refused(f.eve, 'library_search', { journeyId });
});

test('library: extension and MIME detection, links and search across server text', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  for (const [name, mimeType, kind] of [['notes.md', undefined, 'markdown'], ['page.HTML', undefined, 'html'], ['unknown', 'application/pdf', 'pdf'], ['plot.svg', undefined, 'image'], ['main.ts', undefined, 'code'], ['movie.mp4', undefined, 'video'], ['sound.mp3', undefined, 'audio'], ['table.csv', undefined, 'data'], ['helper.skill', undefined, 'skill'], ['system.prompt', undefined, 'prompt'], ['worker.agent', undefined, 'agent'], ['demo.applet', undefined, 'applet'], ['unknown', undefined, 'other']] as const) {
    const item = await f.call(f.alice, 'library_add', { journeyId, name, ...(mimeType ? { mimeType } : {}), text: 'Needle in haystack' });
    assert.equal(item.kind, kind);
  }
  assert.equal(rows(await f.call(f.bob, 'library_search', { journeyId, query: 'needle haystack' })).length, 13);
  assert.equal(rows(await f.call(f.bob, 'library_search', { journeyId, query: 'absent' })).length, 0);
  const link = await f.call(f.alice, 'library_add', { journeyId, name: 'Reference', kind: 'link', url: 'https://example.test/path', summary: 'Linked summary' });
  const read = await f.call(f.bob, 'library_get', { itemId: link.itemId });
  assert.equal(read.url, 'https://example.test/path'); assert.equal(read.summary, 'Linked summary');
  await f.call(f.alice, 'library_version', { itemId: link.itemId, baseVersion: 1, text: 'Revised linked summary' });
  const revised = await f.call(f.bob, 'library_get', { itemId: link.itemId });
  assert.equal(revised.version, 2); assert.equal(revised.url, 'https://example.test/path'); assert.equal(revised.summary, 'Revised linked summary');
  for (const input of [{ kind: 'link', url: 'javascript:alert(1)', summary: 'Bad' }, { kind: 'link', url: 'https://example.test' }, { kind: 'markdown', text: 'A', url: 'https://example.test', summary: 'Mixed' }]) await f.refused(f.alice, 'library_add', { journeyId, name: 'Invalid', ...input });
});

test('library: project artifacts are hidden by default, explicitly included and movable', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  const projectId = ((await f.call(f.alice, 'project_create', { journeyId, name: 'Alpha', purpose: 'Work' })).projects as Data[])[0]!.projectId;
  const item = await f.call(f.alice, 'library_add', { journeyId, name: 'Project note', kind: 'markdown', projectId, text: 'Project text' });
  assert.deepEqual(rows(await f.call(f.bob, 'library_search', { journeyId })), []);
  assert.equal(rows(await f.call(f.bob, 'library_search', { journeyId, includeProjects: true }))[0]!.itemId, item.itemId);
  assert.equal(rows(await f.call(f.bob, 'library_search', { journeyId, projectId }))[0]!.itemId, item.itemId);
  await f.call(f.alice, 'library_update', { itemId: item.itemId, projectId: null, name: 'Journey note', labels: ['moved'] });
  assert.equal(rows(await f.call(f.bob, 'library_search', { journeyId }))[0]!.name, 'Journey note');
  await f.refused(f.alice, 'library_update', { itemId: item.itemId, projectId: 'missing' });
  await f.refused(f.alice, 'library_add', { journeyId, name: 'Missing project', projectId: 'missing', text: '' });
});

test('library: private artifacts never leak through search, legacy views, mutations, conversations or blob routes', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  const privateItem = await f.call(f.alice, 'library_add', { journeyId, name: 'SECRET-NAME', kind: 'markdown', visibility: 'private', text: 'SECRET-TEXT' });
  await f.refused(f.bob, 'library_get', { itemId: privateItem.itemId });
  await f.refused(f.bob, 'library_version', { itemId: privateItem.itemId, baseVersion: 1, text: 'Stolen' });
  await f.refused(f.bob, 'library_update', { itemId: privateItem.itemId, name: 'Stolen' });
  await f.refused(f.bob, 'artifact_rename', { journeyId, artifactId: privateItem.itemId, name: 'Stolen' });
  await f.refused(f.bob, 'conversation_post', { journeyId, target: { itemId: privateItem.itemId }, body: 'Leak' });
  for (const name of ['journey_read', 'library_search', 'artifact_list_view', 'apps_artifacts_refresh']) {
    const response = JSON.stringify(await f.call(f.bob, name, { journeyId }));
    assert.doesNotMatch(response, /SECRET/); assert.equal(response.includes(String(privateItem.itemId)), false);
  }
  const mutation = await f.call(f.bob, 'project_create', { journeyId, name: 'No leak', purpose: 'Check response' });
  assert.doesNotMatch(JSON.stringify(mutation), /SECRET/);
  const agentId = (await f.call(f.bob, 'agent_create', { name: 'Bob agent' })).agentId as string;
  await f.call(f.bob, 'agent_add', { journeyId, agentId }); await setAgentCard(f.backend, 'bob', agentId, ['read', 'artifact.write', 'artifact.delete']);
  await f.refused(f.bob, 'library_get', { itemId: privateItem.itemId, actingAgent: agentId });
  assert.deepEqual(rows(await f.call(f.bob, 'library_search', { journeyId, actingAgent: agentId })), []);
  await f.call(f.alice, 'library_update', { itemId: privateItem.itemId, visibility: 'members' });
  assert.equal((await f.call(f.bob, 'library_get', { itemId: privateItem.itemId })).text, 'SECRET-TEXT');
  await f.refused(f.bob, 'library_update', { itemId: privateItem.itemId, visibility: 'private', name: 'Atomic failure' });
  assert.equal((await f.call(f.alice, 'library_get', { itemId: privateItem.itemId })).name, 'SECRET-NAME');
});

test('library: versions preserve owner and kind, enforce exact base and serialize racing writers', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  const item = await f.call(f.alice, 'library_add', { journeyId, name: 'Versioned', kind: 'markdown', text: 'First' });
  const updated = await f.call(f.bob, 'library_version', { itemId: item.itemId, baseVersion: 1, text: 'Second' });
  assert.equal(updated.version, 2); assert.equal(updated.owner, f.a); assert.equal(updated.kind, 'markdown');
  await f.refused(f.alice, 'library_version', { itemId: item.itemId, baseVersion: 1, text: 'Stale' });
  const results = await Promise.all([f.alice, f.bob].map(c => c.callTool({ name: 'library_version', arguments: { itemId: item.itemId, baseVersion: 2, text: 'Race' } })));
  assert.equal(results.filter(r => r.isError === true).length, 1);
  const read = await f.call(f.alice, 'library_get', { itemId: item.itemId });
  assert.equal(read.version, 3); assert.equal(read.text, 'Race');
  await f.call(f.alice, 'journey_role', { journeyId, personId: f.b, role: 'read' });
  await f.refused(f.bob, 'library_version', { itemId: item.itemId, baseVersion: 3, text: 'Reader' });
});

test('library: owner or guide deletes, never an unrelated writer, including legacy aliases', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  const item = await f.call(f.bob, 'library_add', { journeyId, name: 'Owned by Bob', kind: 'markdown', text: 'Destroy me' });
  await f.refused(f.alice, 'library_update', { itemId: item.itemId, visibility: 'private' });
  const own = await f.call(f.alice, 'library_add', { journeyId, name: 'Owned by Alice', text: 'Keep' });
  await f.refused(f.bob, 'library_delete', { itemId: own.itemId });
  await f.refused(f.bob, 'artifact_delete', { journeyId, artifactId: own.itemId });
  await f.call(f.alice, 'library_delete', { itemId: item.itemId });
  await f.refused(f.bob, 'library_get', { itemId: item.itemId });
  await f.refused(f.bob, 'library_version', { itemId: item.itemId, baseVersion: 1, text: 'Resurrect' });
  await f.refused(f.bob, 'library_delete', { itemId: item.itemId });
  const second = await f.call(f.bob, 'library_add', { journeyId, name: 'Reader owner', text: 'Delete' });
  await f.call(f.alice, 'journey_role', { journeyId, personId: f.b, role: 'read' });
  await f.call(f.bob, 'library_delete', { itemId: second.itemId });
  assert.doesNotMatch(f.backend.snapshot(), /Destroy me/);
});

test('library: UTF-8 cap accepts 256 KiB, refuses one byte over and survives DO eviction', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  const text = 'é'.repeat(131072);
  const item = await f.call(f.alice, 'library_add', { journeyId, name: 'Boundary', text });
  assert.equal(item.size, 262144);
  await f.refused(f.alice, 'library_add', { journeyId, name: 'Too big', text: text + 'x' });
  await f.refused(f.alice, 'library_version', { itemId: item.itemId, baseVersion: 1, text: text + 'x' });
  const store = f.backend.journeyStores.get(journeyId)!;
  const object = new Journey({ storage: store }, { BLOBS: f.backend.blobs });
  const response = await object.fetch(new Request('https://internal/', { method: 'POST', body: JSON.stringify({ personId: f.a, tool: 'library_get', input: { itemId: item.itemId } }) }));
  assert.equal(response.status, 200); assert.equal((await response.json() as { value: Data }).value.text, text);
  assert.ok(Math.max(...[...store.data.values()].map(s => Buffer.byteLength(s))) < 131072, 'No Durable Object value may exceed 128 KiB');
});

test('library: sealed storage uses existing immutable blob path and denies private ciphertext to peers', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  const item = await f.call(f.alice, 'library_add', { journeyId, name: 'Sealed.pdf', storage: 'sealed', size: 3, visibility: 'private' });
  assert.equal(item.kind, 'pdf'); assert.equal(item.storage, 'sealed');
  await f.call(f.alice, 'artifact_blob_put', { groupId: journeyId, artifactId: item.itemId, version: 1, data: 'AQID' });
  for (const name of ['artifact_blob_get', 'artifact_blob_put', 'artifact_blob_delete']) await f.refused(f.bob, name, { groupId: journeyId, artifactId: item.itemId, ...(name === 'artifact_blob_delete' ? {} : { version: 1 }), ...(name === 'artifact_blob_put' ? { data: 'BA==' } : {}) });
  await f.call(f.alice, 'library_version', { itemId: item.itemId, baseVersion: 1, size: 1 });
  await f.call(f.alice, 'artifact_blob_put', { groupId: journeyId, artifactId: item.itemId, version: 2, data: 'BA==' });
  assert.equal((await f.call(f.alice, 'library_get', { itemId: item.itemId })).text, undefined);
  await f.call(f.alice, 'library_delete', { itemId: item.itemId });
  const memberItem = await f.call(f.alice, 'library_add', { journeyId, name: 'Members sealed', storage: 'sealed', size: 1 });
  await f.call(f.alice, 'artifact_blob_put', { groupId: journeyId, artifactId: memberItem.itemId, version: 1, data: 'AQ==' });
  await f.refused(f.bob, 'artifact_blob_delete', { groupId: journeyId, artifactId: memberItem.itemId });
  await f.call(f.alice, 'library_delete', { itemId: memberItem.itemId });
  assert.equal(f.backend.blobs.data.size, 0);
});


test('library: bound agents need live catalogue capabilities and cannot read a peer private item', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  const owner = await f.call(f.alice, 'library_add', { journeyId, name: 'Private', visibility: 'private', text: 'Owner secret' });
  const peer = await f.call(f.bob, 'library_add', { journeyId, name: 'Peer private', visibility: 'private', text: 'Peer secret' });
  const agentId = (await f.call(f.alice, 'agent_create', { name: 'Library agent' })).agentId as string;
  await f.call(f.alice, 'agent_add', { journeyId, agentId });
  const identity = { subject: 'alice', clientId: 'test-client' }, change = { kind: 'bind' as const, clientId: 'library-agent', agentId };
  const { challenge } = await f.backend.beginAuthorization(identity, change);
  await f.backend.completeAuthorization(identity, change, { id: 'synthetic', rawId: 'synthetic', type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: challenge, authenticatorData: '', signature: 'test-valid' } });
  const bound = await f.connect('alice', 'library-agent');
  await f.refused(bound, 'library_search', { journeyId });
  await f.refused(bound, 'library_add', { journeyId, name: 'No card', text: 'No' });
  await setAgentCard(f.backend, 'alice', agentId, ['read']);
  assert.equal((await f.call(bound, 'library_get', { itemId: owner.itemId })).text, 'Owner secret');
  await f.refused(bound, 'library_get', { itemId: peer.itemId });
  await f.refused(bound, 'library_version', { itemId: owner.itemId, baseVersion: 1, text: 'No write' });
  await f.refused(bound, 'library_delete', { itemId: owner.itemId });
  await setAgentCard(f.backend, 'alice', agentId, ['read', 'artifact.write', 'artifact.delete']);
  const version = await f.call(bound, 'library_version', { itemId: owner.itemId, baseVersion: 1, text: 'Agent version' });
  assert.equal(version.owner, f.a); assert.equal(version.version, 2);
  await f.call(bound, 'library_update', { itemId: owner.itemId, visibility: 'members', labels: ['agent'] });
  assert.equal((await f.call(f.bob, 'library_get', { itemId: owner.itemId })).text, 'Agent version');
  await f.refused(f.bob, 'journey_guide', { journeyId, personId: f.b });
  await f.call(f.alice, 'journey_role', { journeyId, personId: f.a, role: 'read' });
  await f.refused(bound, 'library_version', { itemId: owner.itemId, baseVersion: 2, text: 'Lost person write' });
  await f.call(bound, 'library_delete', { itemId: owner.itemId });
  await f.call(f.alice, 'agent_remove', { agentId });
  await f.refused(bound, 'library_search', { journeyId });
});

test('library: strict inputs reject forged ownership, kind changes, numeric overflow and storage mixing without writes', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  const item = await f.call(f.alice, 'library_add', { journeyId, name: 'Safe', text: 'Original' });
  for (const extra of [{ owner: f.b }, { rule: { owner: 2 } }, { actor: f.b }, { size: 9007199254740992, storage: 'sealed', text: undefined }, { storage: 'sealed', size: 1, text: 'leak' }, { kind: 'fake' }]) await f.refused(f.alice, 'library_add', { journeyId, name: 'Injected', text: 'x', ...extra });
  for (const extra of [{ owner: f.b }, { kind: 'pdf' }, { storage: 'sealed' }]) await f.refused(f.alice, 'library_update', { itemId: item.itemId, name: 'No', ...extra });
  await f.refused(f.alice, 'library_version', { itemId: item.itemId, baseVersion: 9007199254740992, text: 'No' });
  await f.refused(f.alice, 'library_version', { itemId: item.itemId, baseVersion: 1, size: 5 });
  assert.equal((await f.call(f.alice, 'library_get', { itemId: item.itemId })).text, 'Original');
});

test('library: content and metadata roll back together when the storage transaction fails', async t => {
  const f = await fixture(t), journeyId = f.journeyId;
  const item = await f.call(f.alice, 'library_add', { journeyId, name: 'Atomic', text: 'First' });
  const store = f.backend.journeyStores.get(journeyId)!;
  const originalPut = store.put.bind(store);
  store.put = async (key, value) => { await originalPut(key, value); if (key.includes('libraryText')) throw new Error('Injected storage failure'); };
  await f.refused(f.alice, 'library_version', { itemId: item.itemId, baseVersion: 1, text: 'Not committed' });
  store.put = originalPut;
  const read = await f.call(f.alice, 'library_get', { itemId: item.itemId });
  assert.equal(read.version, 1); assert.equal(read.text, 'First');
});
