import { expect, it } from 'vitest';
import { canonical, createAgeIdentity, createSigningIdentity, hashEntry, importSigningKey, newId, signEntry, verifyLog, type LogEntry, type Member } from '../src/index.js';

async function person() {
  const keys = await createSigningIdentity();
  const age = await createAgeIdentity();
  return { member: { id: newId(), kind: 'person', recipient: age.recipient, signingKey: keys.publicKey } as Member, key: await importSigningKey(keys.privateKey) };
}
async function agent(owner: string) {
  const keys = await createSigningIdentity();
  const age = await createAgeIdentity();
  return { member: { id: newId(), kind: 'agent', recipient: age.recipient, signingKey: keys.publicKey, addedBy: owner, scope: 'readwrite' } as Member, key: await importSigningKey(keys.privateKey) };
}
async function genesis(creator: Awaited<ReturnType<typeof person>>) {
  const entry = await signEntry({ v: 1, seq: 0, prev: null, at: '2026-01-01T00:00:00Z', actor: creator.member.id, type: 'genesis', body: { journey: newId(), name: 'Journey', creator: creator.member, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: '0.1.0' } }, creator.key);
  return [entry];
}
async function append(entries: LogEntry[], actor: { member: Member; key: CryptoKey }, type: string, body: LogEntry['body']) {
  const entry = await signEntry({ v: 1, seq: entries.length, prev: await hashEntry(entries.at(-1)!), at: '2026-01-02T00:00:00Z', actor: actor.member.id, type, body }, actor.key);
  return [...entries, entry];
}
async function error(entries: LogEntry[]) { const result = await verifyLog(entries); expect(result.ok).toBe(false); return result.ok ? '' : result.error.code; }

it('verifies genesis and a holder adding a person', async () => {
  const creator = await person(); const next = await person();
  const first = await genesis(creator);
  const valid = await verifyLog(first);
  expect(valid.ok).toBe(true);
  const added = await append(first, creator, 'member.add', { member: next.member, grants: [], kind: 'person' });
  const state = await verifyLog(added);
  expect(state.ok && state.state.members[next.member.id]?.member.id).toBe(next.member.id);
});

it('stores an optional private description and journey kind in the signed genesis', async () => {
  const creator = await person();
  const [initial] = await genesis(creator);
  const entry = await signEntry({ ...initial!, body: { ...initial!.body, description: 'A place to find our way', journeyKind: 'team' } }, creator.key);
  expect(entry.body.description).toBe('A place to find our way');
  expect(entry.body.journeyKind).toBe('team');
  expect((await verifyLog([entry])).ok).toBe(true);
  expect(await error([{ ...entry, body: { ...entry.body, description: 'Changed' } }])).toBe('invalid-signature');
});

it('rejects a non-holder adding people and agents signing membership changes', async () => {
  const creator = await person(); const next = await person(); const third = await person();
  const withMember = await append(await genesis(creator), creator, 'member.add', { member: next.member, grants: [], kind: 'person' });
  expect(await error(await append(withMember, next, 'member.add', { member: third.member, grants: [], kind: 'person' }))).toBe('unauthorized');
  const bot = await agent(next.member.id);
  const withBot = await append(withMember, next, 'member.add', { member: bot.member, grants: [], kind: 'agent' });
  expect((await verifyLog(withBot)).ok).toBe(true);
  expect(await error(await append(withBot, bot, 'member.remove', { member: creator.member.id }))).toBe('unauthorized');
  expect(await error(await append(withBot, creator, 'grant.add', { member: bot.member.id, grant: 'members.manage' }))).toBe('unauthorized');
});

it('marks support members read-only with a required expiry and no management grants', async () => {
  const creator = await person(); const support = await person();
  const member = { ...support.member, scope: 'read', support: true, expiresAt: '2026-09-01T00:00:00.000Z' };
  const first = await genesis(creator);
  const added = await append(first, creator, 'member.add', { member, grants: [], kind: 'person' });
  expect((await verifyLog(added)).ok).toBe(true);
  expect(await error(await append(first, creator, 'member.add', { member, grants: ['members.manage'], kind: 'person' }))).toBe('unauthorized');
  expect(await error(await append(added, creator, 'grant.add', { member: member.id, grant: 'members.manage' }))).toBe('unauthorized');
  await expect(append(first, creator, 'member.add', { member: { ...member, expiresAt: undefined }, grants: [], kind: 'person' })).rejects.toThrow('Invalid member.add');
});

it('signs agent names and lets only a manager or the person who added the agent rename it', async () => {
  const creator = await person(), owner = await person(), outsider = await person(), bot = await agent(owner.member.id);
  let entries = await genesis(creator);
  for (const member of [owner.member, outsider.member]) entries = await append(entries, creator, 'member.add', { member, grants: [], kind: 'person' });
  entries = await append(entries, owner, 'member.add', { member: { ...bot.member, name: 'Helper' }, grants: [], kind: 'agent' });
  const added = await verifyLog(entries);
  expect(added.ok && added.state.members[bot.member.id]?.member.name).toBe('Helper');
  expect(entries.at(-1)?.body.member).toMatchObject({ name: 'Helper' });
  expect(await error(await append(entries, outsider, 'member.rename', { id: bot.member.id, name: 'Hijacked' }))).toBe('unauthorized');
  expect(await error(await append(entries, bot, 'member.rename', { id: bot.member.id, name: 'Hijacked' }))).toBe('unauthorized');
  entries = await append(entries, owner, 'member.rename', { id: bot.member.id, name: 'Guide' });
  entries = await append(entries, creator, 'member.rename', { id: bot.member.id, name: 'Trusted guide' });
  const renamed = await verifyLog(entries);
  expect(renamed.ok && renamed.state.members[bot.member.id]?.member.name).toBe('Trusted guide');
  expect(await error(await append(entries, creator, 'member.rename', { id: owner.member.id, name: 'Person' }))).toBe('invalid-entry');
  for (const name of [' ', ' padded', 'A'.repeat(61), 'Bad\nname']) await expect(append(entries, owner, 'member.rename', { id: bot.member.id, name })).rejects.toThrow('Invalid member.rename');
  await expect(append(entries, owner, 'member.add', { member: { ...(await agent(owner.member.id)).member, name: 'Bad\u007fname' }, grants: [], kind: 'agent' })).rejects.toThrow('Invalid member.add');
});

it('lets a person set a name and reveal then hide email without allowing another member to change their profile', async () => {
  const creator = await person(), guest = await person();
  const oldLog = await append(await genesis(creator), creator, 'member.add', { member: guest.member, grants: [], kind: 'person' });
  const old = await verifyLog(oldLog);
  expect(old.ok && old.state.members[creator.member.id]?.profile).toBeUndefined();
  expect(await error(await append(oldLog, creator, 'member.profile', { id: guest.member.id, name: 'Impersonated', email: 'stolen@example.org' }))).toBe('unauthorized');
  let entries = await append(oldLog, creator, 'member.profile', { id: creator.member.id, name: 'Avery' });
  let state = await verifyLog(entries);
  expect(state.ok && state.state.members[creator.member.id]?.profile).toEqual({ name: 'Avery' });
  entries = await append(entries, creator, 'member.profile', { id: creator.member.id, name: 'Avery', email: 'avery@example.org' });
  state = await verifyLog(entries);
  expect(state.ok && state.state.members[creator.member.id]?.profile).toEqual({ name: 'Avery', email: 'avery@example.org' });
  entries = await append(entries, creator, 'member.profile', { id: creator.member.id, name: 'Avery' });
  state = await verifyLog(entries);
  expect(state.ok && state.state.members[creator.member.id]?.profile).toEqual({ name: 'Avery' });
  expect(await error(await append(entries, guest, 'member.profile', { id: creator.member.id, name: 'Hijacked' }))).toBe('unauthorized');
  for (const invalid of [' bad', 'Bad\nname', 'A'.repeat(61)]) await expect(append(entries, creator, 'member.profile', { id: creator.member.id, name: invalid })).rejects.toThrow('Invalid member.profile');
  await expect(append(entries, creator, 'member.profile', { id: creator.member.id, name: 'Avery', email: 'not-an-email' })).rejects.toThrow('Invalid member.profile');
});

it('keeps old agent logs without names valid', async () => {
  const creator = await person(), bot = await agent(creator.member.id);
  const entries = await append(await genesis(creator), creator, 'member.add', { member: bot.member, grants: [], kind: 'agent' });
  const result = await verifyLog(entries);
  expect(result.ok && result.state.members[bot.member.id]?.member.name).toBeUndefined();
});

it('keeps at least one person holding members.manage after every entry', async () => {
  const creator = await person(); const first = await genesis(creator);
  expect(await error(await append(first, creator, 'grant.remove', { member: creator.member.id, grant: 'members.manage' }))).toBe('last-holder');
  expect(await error(await append(first, creator, 'member.remove', { member: creator.member.id }))).toBe('last-holder');
});

it('allows an owner to remove their own agent and cascades a removed person’s agents', async () => {
  const creator = await person(); const next = await person(); const bot = await agent(next.member.id);
  let entries = await append(await genesis(creator), creator, 'member.add', { member: next.member, grants: [], kind: 'person' });
  entries = await append(entries, next, 'member.add', { member: bot.member, grants: [], kind: 'agent' });
  expect((await verifyLog(await append(entries, next, 'member.remove', { member: bot.member.id }))).ok).toBe(true);
  const removed = await verifyLog(await append(entries, creator, 'member.remove', { member: next.member.id }));
  expect(removed.ok && removed.state.members[bot.member.id]).toBeUndefined();
});

it('copies only named membership fields when signing an entry', async () => {
  const creator = await person();
  const signed = await signEntry({ v: 1, seq: 0, prev: null, at: '2026-01-01', actor: creator.member.id, type: 'genesis', body: { journey: newId(), name: 'Safe', creator: { ...creator.member, email: 'do-not-store' }, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: '0.1.0', secret: 'do-not-store' } }, creator.key);
  expect(JSON.stringify(signed)).not.toContain('do-not-store');
  expect((await verifyLog([signed])).ok).toBe(true);
});

it('rejects tampered signatures, broken hashes, reordered entries and future membership types', async () => {
  const creator = await person(); const next = await person();
  const entries = await append(await genesis(creator), creator, 'member.add', { member: next.member, grants: [], kind: 'person' });
  expect(await error([entries[0]!, { ...entries[1]!, body: { member: creator.member, grants: [], kind: 'person' } }])).toBe('invalid-signature');
  expect(await error([entries[0]!, { ...entries[1]!, prev: 'broken' }])).toBe('broken-chain');
  expect(await error([entries[1]!, entries[0]!])).toBe('broken-chain');
  const future = { v: 1 as const, seq: entries.length, prev: await hashEntry(entries.at(-1)!), at: '2026-01-02', actor: creator.member.id, type: 'visibility.set', body: { visibility: 'public' } };
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', creator.key, new TextEncoder().encode(canonical(future))));
  expect(await error([...entries, { ...future, sig: btoa(Array.from(signature, byte => String.fromCharCode(byte)).join('')) }])).toBe('client-too-old');
});
