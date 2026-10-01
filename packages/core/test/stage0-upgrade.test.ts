import { expect, it } from 'vitest';
import { generateJourneyKey, newId, seal, open, signControlProof, sealControlLabels, readControlProof, verifyControlProofs, hashControlProof, hashEntry, verifyLog, canWriteContent } from '../src/index.js';
import type { ControlProof, Envelope, LogEntry } from '../src/index.js';
import { person, agent, genesis, append, state, rejected, settings } from './stage0-fixture.js';
it('requires a monotone legacy minimum barrier and preserves historic roles, limits, expiry and ciphertext', async () => {
  const guide = await person(), normal = await person(), support = await person(), bot = await agent(normal.member.id, 'read');
  let log = await genesis(guide, '0.1.0');
  log = await append(log, guide, 'member.add', { member: normal.member, grants: [], kind: 'person' });
  log = await append(log, guide, 'member.add', { member: { ...support.member, support: true, scope: 'read', expiresAt: '2027-01-01T00:00:00.000Z' }, grants: [], kind: 'person' });
  log = await append(log, normal, 'member.add', { member: bot.member, grants: [], kind: 'agent' });
  const old = JSON.stringify(log), key = generateJourneyKey();
  const record = { type: 'item', typeVersion: 1, body: { title: 'Original encrypted text' } };
  const ciphertext = await seal(record, { id: newId(), journey: log[0]!.body.journey as string, epoch: 1, createdAt: '2026-01-01' }, key);
  const before = await state(log); expect(before.settings).toMatchObject({ name: 'Journey', visibility: 'private', joiningPolicy: 'invitation-only', defaultRole: 'read-write' });
  await rejected(await append(log, guide, 'journey.settings', settings));
  await rejected(await append(log, guide, 'member.role', { member: normal.member.id, role: 'read-only' }));
  const insufficient = await append(log, guide, 'client.minVersion', { version: '0.1.3' });
  await rejected(await append(insufficient, guide, 'journey.settings', settings));
  await rejected(await append(log, normal, 'client.minVersion', { version: '0.1.4' }));
  log = await append(log, guide, 'client.minVersion', { version: '0.1.4' });
  expect(JSON.stringify(log.slice(0, -1))).toBe(old);
  await rejected(await append(log, guide, 'client.minVersion', { version: '0.1.3' }));
  const journey = log[0]!.body.journey as string;
  const entry = { v: 1 as const, seq: log.length, prev: await hashEntry(log.at(-1)!), at: '2026-01-02T00:00:00.000Z', actor: guide.member.id, type: 'journey.settings', body: settings };
  const envelope = await sealControlLabels(entry, { id: newId(), journey, seq: entry.seq, epoch: 1, createdAt: entry.at }, key);
  const proof = await signControlProof(entry, envelope, journey, guide.key);
  const verified = await verifyControlProofs([proof], [envelope], { journey, creator: guide.member }, [key], log);
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error(verified.error.message);
  const upgraded = verified.state;
  expect(upgraded.settings).toEqual(settings);
  expect(canWriteContent(upgraded, normal.member.id)).toBe(true);
  expect(upgraded.members[support.member.id]!.member).toMatchObject({ scope: 'read', support: true, expiresAt: '2027-01-01T00:00:00.000Z' });
  expect(upgraded.members[bot.member.id]!.member.scope).toBe('read');
  expect(upgraded.members[guide.member.id]!.grants).toEqual(['members.manage']);
  expect(JSON.stringify(log.slice(0, -1))).toBe(old);
  expect(await open(ciphertext, key)).toEqual(record);
  const forgedLegacy = log.map(e => ({ ...e })); forgedLegacy[1] = { ...forgedLegacy[1]!, body: { ...forgedLegacy[1]!.body, grants: ['members.manage'] } };
  expect((await verifyControlProofs([proof], [envelope], { journey, creator: guide.member }, [key], forgedLegacy)).ok).toBe(false);
});
it('binds the sole public control to pinned creation, ciphertext, journey, actor and proof chain without private labels', async () => {
  const guide = await person(); let log = await genesis(guide);
  log = await append(log, guide, 'journey.settings', { ...settings, name: 'Secret journey name' });
  log = await append(log, guide, 'member.profile', { id: guide.member.id, name: 'Private person', email: 'private@example.org' });
  const key = generateJourneyKey(), journey = log[0]!.body.journey as string;
  const envelopes: Envelope[] = [], proofs: ControlProof[] = [];
  for (const original of log) {
    const entry = { ...original, prev: proofs.length ? await hashControlProof(proofs.at(-1)!) : null };
    const envelope = await sealControlLabels(entry, { id: newId(), journey, seq: entry.seq, epoch: 1, createdAt: entry.at }, key);
    envelopes.push(envelope); proofs.push(await signControlProof(entry, envelope, journey, guide.key));
  }
  const trust = { journey, creator: guide.member };
  expect(JSON.stringify(proofs)).not.toContain('Secret journey name'); expect(JSON.stringify(proofs)).not.toContain('private@example.org');
  const publicState = await verifyControlProofs(proofs, envelopes, trust), keyedState = await verifyControlProofs(proofs, envelopes, trust, [key]);
  expect(publicState.ok).toBe(true); expect(keyedState.ok).toBe(true);
  if (!keyedState.ok || !publicState.ok) throw Error('Invalid proof chain');
  expect(keyedState.state.settings).toEqual({ ...settings, name: 'Secret journey name' });
  expect(keyedState.state.members[guide.member.id]!.profile).toEqual({ name: 'Private person', email: 'private@example.org' });
  expect(publicState.state.settings!.name).toBe('[unavailable]');
  expect(publicState.state.members[guide.member.id]!.profile).toEqual({ name: '[unavailable]', email: '[unavailable]' });
  for (let i = 0; i < log.length; i++) {
    const read = await readControlProof(proofs[i]!, envelopes[i]!, key);
    expect(read.unavailableLabels).toEqual([]); expect(read.entry.body).toEqual(log[i]!.body);
  }
  for (const field of ['actor', 'journey', 'prev', 'envelopeHash', 'type']) {
    const forged = proofs.map(p => ({ ...p })); forged[1] = { ...forged[1]!, [field]: 'forged' };
    expect((await verifyControlProofs(forged, envelopes, trust)).ok).toBe(false);
  }
  const extra = proofs.map(p => ({ ...p })); Object.assign(extra[1]!, { accessChanges: [{ scope: 'readwrite' }] });
  expect((await verifyControlProofs(extra, envelopes, trust)).ok).toBe(false);
  const swapped = [...envelopes]; swapped[1] = { ...swapped[1]!, ciphertext: swapped[0]!.ciphertext };
  expect((await verifyControlProofs(proofs, swapped, trust)).ok).toBe(false);
  expect((await verifyControlProofs(proofs, envelopes, { journey, creator: (await person()).member })).ok).toBe(false);
  const forgedLog = [...log]; forgedLog[1] = { ...log[1]!, body: { ...log[1]!.body, defaultRole: 'read-write' } };
  expect((await verifyLog(forgedLog)).ok).toBe(false);
});
it('cannot encode a second action and rejects malicious labels without changing authority (mismatched ciphertext regression)', async () => {
  const guide = await person(), other = await person(), key = generateJourneyKey();
  let legacy = await genesis(guide); legacy = await append(legacy, guide, 'member.add', { member: other.member, grants: [], kind: 'person' });
  const journey = legacy[0]!.body.journey as string, trust = { journey, creator: guide.member };
  const entry: Omit<LogEntry, 'sig'> = { v: 1, seq: legacy.length, prev: await hashEntry(legacy.at(-1)!), at: '2026-01-02T00:00:00.000Z', actor: guide.member.id, type: 'member.role', body: { member: other.member.id, role: 'read-only' } };
  const outside = { id: newId(), journey, seq: entry.seq, epoch: 1, createdAt: entry.at };
  // The encoder copies labels only. Even action-shaped caller fields cannot survive.
  const encoded = await sealControlLabels({ body: { ...entry.body, type: 'grant.add', actor: other.member.id, grants: ['members.manage'], secret: 'do-not-store' } }, outside, key);
  expect(await open(encoded, key)).toEqual({ type: 'control.labels', typeVersion: 1, body: {} });
  const mismatched = await seal({ type: 'log', typeVersion: 1, body: { entry: { ...entry, type: 'grant.add', body: { member: other.member.id, grant: 'members.manage' } } } }, outside, key);
  const proof = await signControlProof(entry, mismatched, journey, guide.key);
  const publicResult = await verifyControlProofs([proof], [mismatched], trust, [], legacy);
  const readerResult = await verifyControlProofs([proof], [mismatched], trust, [key], legacy);
  expect(publicResult).toEqual(readerResult);
  expect(readerResult.ok).toBe(true);
  if (!readerResult.ok) throw Error(readerResult.error.message);
  expect(readerResult.state.members[other.member.id]!.grants).toEqual([]);
  expect(canWriteContent(readerResult.state, other.member.id)).toBe(false);
  const next = { ...entry, seq: entry.seq + 1, prev: await hashControlProof(proof), type: 'journey.settings', body: settings };
  // A signer can deliberately encrypt a wrong label and sign its ciphertext, but
  // the independent public label commitment rejects it. The role stays read-only.
  const wrongLabel = await seal({ type: 'control.labels', typeVersion: 1, body: { name: 'Tampered name', description: settings.description } }, { ...outside, id: newId(), seq: next.seq }, key);
  const nextProof = await signControlProof(next, wrongLabel, journey, guide.key);
  const read = await readControlProof(nextProof, wrongLabel, key);
  expect(read.unavailableLabels).toEqual(['name']); expect(read.entry.body.name).toBe('[unavailable]');
  expect(read.entry.body.description).toBe(settings.description);
  const result = await verifyControlProofs([proof, nextProof], [mismatched, wrongLabel], trust, [key], legacy);
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.error.message);
  expect(result.state.settings).toEqual({ ...settings, name: '[unavailable]' });
  expect(canWriteContent(result.state, other.member.id)).toBe(false);
  expect(result.state.members[other.member.id]!.grants).toEqual([]);
  // No action fields are accepted even in a labels-shaped malicious payload.
  const actionLabels = await seal({ type: 'control.labels', typeVersion: 1, body: { name: settings.name, description: settings.description, role: 'read-write' } }, { ...outside, seq: next.seq }, key);
  const actionProof = await signControlProof(next, actionLabels, journey, guide.key);
  expect((await readControlProof(actionProof, actionLabels, key)).unavailableLabels).toEqual(['name', 'description']);
});
