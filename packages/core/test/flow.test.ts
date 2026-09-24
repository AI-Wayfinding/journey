import { expect, it } from 'vitest';
import { createAgeIdentity, createSigningIdentity, exportJourney, generateJourneyKey, hashEntry, importJourney, importSigningKey, newId, open, removeAndRotate, seal, signEntry, unwrapJourneyKey, verifyLog, wrapJourneyKey, type LogEntry, type Member } from '../src/index.js';

async function fixture() {
  const people = await Promise.all(Array.from({ length: 3 }, async () => ({ age: await createAgeIdentity(), sign: await createSigningIdentity(), id: newId() })));
  const [owner, next, bot] = people as typeof people & { 0: typeof people[number]; 1: typeof people[number]; 2: typeof people[number] };
  const members: Member[] = [
    { id: owner.id, kind: 'person', recipient: owner.age.recipient, signingKey: owner.sign.publicKey },
    { id: next.id, kind: 'person', recipient: next.age.recipient, signingKey: next.sign.publicKey },
    { id: bot.id, kind: 'agent', recipient: bot.age.recipient, signingKey: bot.sign.publicKey, scope: 'read', addedBy: owner.id },
  ];
  const key = await importSigningKey(owner.sign.privateKey);
  const journey = newId();
  let entries: LogEntry[] = [await signEntry({ v: 1, seq: 0, prev: null, at: '2026-01-01', actor: owner.id, type: 'genesis', body: { journey, name: 'Example', creator: members[0], grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: '0.1.0' } }, key)];
  for (const member of members.slice(1)) entries = [...entries, await signEntry({ v: 1, seq: entries.length, prev: await hashEntry(entries.at(-1)!), at: '2026-01-02', actor: owner.id, type: 'member.add', body: { member, kind: member.kind, grants: [] } }, key)];
  return { people, members, key, journey, entries };
}

it('removes a person and rotates to the remaining person and agent only', async () => {
  const { people, members, key, entries } = await fixture();
  const verified = await verifyLog(entries);
  if (!verified.ok) throw new Error(verified.error.message);
  const flow = await removeAndRotate(verified.state, members[1]!.id, members[0]!.id, key);
  const updated = await verifyLog([...entries, ...flow.entries]);
  expect(updated.ok && updated.state.currentEpoch).toBe(2);
  expect(flow.wraps.map(w => w.recipient).sort()).toEqual([members[0]!.id, members[2]!.id].sort());
  for (const i of [0, 2]) expect((await unwrapJourneyKey(flow.wraps.find(w => w.recipient === members[i]!.id)!, people[i]!.age.identity)).key).toEqual(flow.key.key);
  await expect(unwrapJourneyKey(flow.wraps[0]!, people[1]!.age.identity)).rejects.toThrow();
});

it('does not sign a rotation with a holder who removed themselves', async () => {
  const { members, key, entries } = await fixture();
  const grant = await signEntry({ v: 1, seq: entries.length, prev: await hashEntry(entries.at(-1)!), at: '2026-01-04', actor: members[0]!.id, type: 'grant.add', body: { member: members[1]!.id, grant: 'members.manage' } }, key);
  const state = await verifyLog([...entries, grant]);
  if (!state.ok) throw new Error(state.error.message);
  await expect(removeAndRotate(state.state, members[0]!.id, members[0]!.id, key)).rejects.toThrow(/acting holder/);
});

it('exports an encrypted journey and imports with log and ciphertext verified', async () => {
  const { people, members, journey, entries } = await fixture();
  const key = generateJourneyKey();
  const wraps = await wrapJourneyKey(key, members.map(member => ({ id: member.id, recipient: member.recipient })));
  const envelope = await seal({ type: 'unknown-new', typeVersion: 8, body: { preserve: true } }, { id: newId(), journey, epoch: 1, seq: 1, createdAt: '2026-01-03' }, key);
  const encrypted = await exportJourney(entries, [envelope], wraps, [people[0]!.age.recipient]);
  expect(encrypted).not.toContain('unknown-new');
  const imported = await importJourney(encrypted, [people[0]!.age.identity]);
  expect(imported.archive.log).toEqual(entries);
  expect(await open(imported.archive.envelopes[0]!, key)).toEqual({ type: 'unknown-new', typeVersion: 8, body: { preserve: true } });
  const tampered = [{ ...entries[0]!, body: { ...entries[0]!.body, name: 'forged' } }, ...entries.slice(1)];
  const forged = await exportJourney(tampered, [envelope], wraps, [people[0]!.age.recipient]);
  await expect(importJourney(forged, [people[0]!.age.identity])).rejects.toThrow(/invalid-signature/);
});
