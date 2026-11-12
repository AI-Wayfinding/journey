import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { MemoryBackend } from '../src/backend.ts';
import { parseCommand } from '../src/commands.ts';
import { testPasskeys, setAgentCard } from './helpers.ts';
import { Refused } from '../src/errors.ts';
const refused = (message: string) => (error: unknown) => { assert.ok(error instanceof Refused); assert.equal(error.message, message); return true; };

const storageKey = (...parts: (string | number)[]) => JSON.stringify(['sealed-v1', ...parts]);
async function fixture() {
  const backend = new MemoryBackend({ async get(s) { return { name: s, email: `${s}@example.test` }; } }, Date.now, testPasskeys, true);
  const personId = String((await backend.execute('alice', parseCommand('account_read', {}))).personId);
  const journeyId = String((await backend.sealedExecute('alice', 'journey_create', { policy: 'open', defaultRole: 'write' })).journeyId);
  const call = (tool: string, input: Record<string, unknown>, clientId?: string, subject = 'alice') => backend.sealedExecute(subject, tool, { journeyId, ...input }, clientId);
  const register = async (deviceId: string, clientId?: string, subject = 'alice') => { await backend.sealedExecute(subject, 'sealed_device_register', { deviceId, verificationKey: Buffer.alloc(32, 7).toString('base64'), data: 'e30=' }, clientId); };
  const commit = async (deviceId: string, action: string, targetDeviceId?: string, clientId?: string, subject = 'alice') => {
    const view = await call('sealed_group', { groupId: journeyId }, clientId, subject);
    return call('sealed_group_commit', { groupId: journeyId, deviceId, action, targetDeviceId, expectedEpoch: view.epoch, expectedSequence: view.sequence, data: 'e30=' }, clientId, subject);
  };
  const agent = async (clientId: string) => {
    const agentId = String((await backend.sealedExecute('alice', 'agent_create', {})).agentId);
    await backend.execute('alice', parseCommand('agent_add', { journeyId, agentId }));
    await setAgentCard(backend, 'alice', agentId, ['read', 'device.keys', 'artifact.write']);
    const identity = { subject: 'alice', clientId: 'test-console' }, change = { kind: 'bind' as const, clientId, agentId };
    const { challenge } = await backend.beginAuthorization(identity, change);
    await backend.completeAuthorization(identity, change, { id: 'synthetic', rawId: 'synthetic', type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: challenge, authenticatorData: '', signature: 'test-valid' } });
    return agentId;
  };
  const publish = async (deviceId: string, clientId?: string) => {
    const prepared = await call('content_prepare', { action: 'library_add', routing: { visibility: 'members' } }, clientId);
    const slots = z.array(z.object({ key: z.string(), context: z.object({ groupId: z.string(), epoch: z.number() }) })).parse(prepared.slots);
    const envelopes = Object.fromEntries(slots.map(s => [s.key, { groupId: s.context.groupId, epoch: s.context.epoch, ciphertext: 'e30=', contentType: 'application/vnd.wayfinding.sealed+json;v=1', size: 2 }]));
    return call('library_add', { ticketId: prepared.ticketId, devices: { [journeyId]: deviceId }, envelopes }, clientId);
  };
  await register('owner'); await commit('owner', 'bootstrap');
  return { backend, personId, journeyId, call, register, commit, agent, publish, store: backend.journeyStores.get(journeyId)! };
}

test('sealed policy: agent device may remove only itself, never owner or peer devices', async () => {
  const f = await fixture();
  await f.register('owner-second'); await f.commit('owner', 'add', 'owner-second');
  await f.agent('agent-one'); await f.register('agent-device', 'agent-one'); await f.commit('owner', 'add', 'agent-device');
  await f.register('same-agent-second', 'agent-one'); await f.commit('owner', 'add', 'same-agent-second');
  await f.agent('agent-two'); await f.register('peer-agent', 'agent-two'); await f.commit('owner', 'add', 'peer-agent');
  for (const target of ['owner', 'owner-second', 'same-agent-second', 'peer-agent']) {
    await assert.rejects(f.commit('agent-device', 'remove', target, 'agent-one'), refused('Only own devices or server-ineligible devices may be removed'));
  }
  await f.commit('agent-device', 'remove', 'agent-device', 'agent-one');
  await f.commit('owner-second', 'remove', 'peer-agent');
  const view = await f.call('sealed_group', { groupId: f.journeyId });
  assert.deepEqual(z.array(z.object({ deviceId: z.string() })).parse(view.devices).map(d => d.deviceId).sort(), ['owner', 'owner-second', 'same-agent-second']);
});

test('sealed policy: person devices and agents share one update budget below the group cap', async () => {
  const f = await fixture(); await f.register('second'); await f.commit('owner', 'add', 'second');
  await f.agent('agent'); await f.register('agent-device', 'agent'); await f.commit('owner', 'add', 'agent-device');
  for (let i = 0; i < 128; i++) await f.commit('owner', 'update');
  for (const [device, client] of [['second', undefined], ['agent-device', 'agent']] as const)
    await assert.rejects(f.commit(device, 'update', undefined, client), refused('Sealed person retention quota exhausted'));
  const group = JSON.parse(String(await f.store.get(storageKey('group', f.journeyId))));
  assert.equal(group.handshakeMessages, 128); assert.ok(group.handshakeMessages < 4096);
});

test('sealed policy: automatic admission and history do not consume update or content budgets', async () => {
  const f = await fixture(), handshake = storageKey('quota', f.journeyId, f.personId, 'handshake'), content = storageKey('quota', f.journeyId, f.personId, 'content');
  await f.publish('owner');
  await f.store.put(handshake, JSON.stringify({ bytes: 4 * 1024 * 1024, messages: 128 }));
  await f.store.put(content, JSON.stringify({ bytes: 16 * 1024 * 1024, messages: 2048 }));
  // More admissions than the 128-update allowance; register distinct one-use packages.
  for (let i = 0; i < 130; i++) { await f.register(`new-${i}`); await f.commit('owner', 'add', `new-${i}`); await f.commit('owner', 'remove', `new-${i}`); }
  const contexts = z.array(z.object({ content: z.array(z.object({ context: z.record(z.string(), z.unknown()) })) })).parse((await f.call('sealed_catalog', {})).records).flatMap(r => r.content.map(c => c.context));
  const view = await f.call('sealed_group', { groupId: f.journeyId });
  await f.call('sealed_history_post', { groupId: f.journeyId, deviceId: 'owner', contexts, envelope: { groupId: f.journeyId, epoch: view.epoch, ciphertext: 'e30=', contentType: 'application/vnd.wayfinding.sealed+json;v=1', size: 2 } });
  assert.deepEqual(JSON.parse(String(await f.store.get(handshake))), { bytes: 4 * 1024 * 1024, messages: 128 });
  assert.deepEqual(JSON.parse(String(await f.store.get(content))), { bytes: 16 * 1024 * 1024, messages: 2048 });
  const admission = JSON.parse(String(await f.store.get(storageKey('quota', f.journeyId, f.personId, 'admission'))));
  assert.equal(admission.messages, 262); // bootstrap + 130 add/remove pairs + history
});

test('sealed policy: content and uploads share the person budget across devices and agents', async () => {
  const f = await fixture(); await f.register('second'); await f.commit('owner', 'add', 'second');
  await f.agent('agent'); await f.register('agent-device', 'agent'); await f.commit('owner', 'add', 'agent-device');
  await f.store.put(storageKey('quota', f.journeyId, f.personId, 'content'), JSON.stringify({ bytes: 0, messages: 2047 }));
  await f.publish('owner');
  for (const [device, client] of [['second', undefined], ['agent-device', 'agent']] as const)
    await assert.rejects(f.publish(device, client), refused('Sealed person retention quota exhausted'));
  await f.store.put(storageKey('upload-quota', f.personId), JSON.stringify(16 * 1024 * 1024 - 1));
  const upload = async (deviceId: string, client?: string) => {
    const prepared = await f.call('content_prepare', { action: 'library_add', routing: { visibility: 'members' } }, client);
    return f.call('sealed_blob_put', { ticketId: prepared.ticketId, slot: 'content', deviceId, data: 'eA==' }, client);
  };
  await upload('owner');
  for (const [device, client] of [['second', undefined], ['agent-device', 'agent']] as const)
    await assert.rejects(upload(device, client), refused('Sealed person upload quota exhausted'));
});
