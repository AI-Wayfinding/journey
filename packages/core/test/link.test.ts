import { describe, expect, it } from 'vitest';
import { LINK_SECRET_PATTERN, createAgeIdentity, createSigningIdentity, hashEntry, importSigningKey, linkLookupHash, logDefinitions, newId, newLinkSecret, openLinkIdentity, renewAgentEntries, sealLinkIdentity, signEntry, verifyLog, type LogEntry, type Member } from '../src/index.js';

async function person() {
  const keys = await createSigningIdentity(); const age = await createAgeIdentity();
  return { member: { id: newId(), kind: 'person', recipient: age.recipient, signingKey: keys.publicKey } as Member, key: await importSigningKey(keys.privateKey) };
}
async function chain() {
  const owner = await person(); const other = await person(); const agentAge = await createAgeIdentity(); const agentKeys = await createSigningIdentity();
  const agent: Member = { id: newId(), kind: 'agent', recipient: agentAge.recipient, signingKey: agentKeys.publicKey, addedBy: owner.member.id, name: 'Cowork', scope: 'read', expiresAt: '2026-01-08T00:00:00.000Z' };
  const genesis = await signEntry({ v: 1, seq: 0, prev: null, at: '2026-01-01T00:00:00Z', actor: owner.member.id, type: 'genesis', body: { journey: newId(), name: 'Journey', creator: owner.member, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: '0.1.0' } }, owner.key);
  const entries: LogEntry[] = [genesis];
  const add = async (actor: typeof owner, type: string, body: LogEntry['body']) => { entries.push(await signEntry({ v: 1, seq: entries.length, prev: await hashEntry(entries.at(-1)!), at: '2026-01-02T00:00:00Z', actor: actor.member.id, type, body }, actor.key)); };
  await add(owner, 'member.add', { member: other.member, grants: [], kind: 'person' });
  await add(owner, 'member.add', { member: agent, grants: [], kind: 'agent' });
  return { owner, other, agent, entries };
}

describe('agent link secret', () => {
  it('is 256 bits of URL-safe text, and the lookup hash does not reveal it', async () => {
    const secret = newLinkSecret();
    expect(secret).toMatch(LINK_SECRET_PATTERN);
    expect(newLinkSecret()).not.toBe(secret);
    const hash = await linkLookupHash(secret);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).not.toContain(secret);
    expect(await linkLookupHash(secret)).toBe(hash);
  });
  it('seals an identity that only the same secret and link can open', async () => {
    const secret = newLinkSecret(); const { identity } = await createAgeIdentity();
    const blob = await sealLinkIdentity(secret, identity, 'journey', 'member');
    expect(blob).not.toContain(identity);
    expect(await openLinkIdentity(secret, blob, 'journey', 'member')).toBe(identity);
    await expect(openLinkIdentity(newLinkSecret(), blob, 'journey', 'member')).rejects.toThrow();
    await expect(openLinkIdentity(secret, blob, 'journey', 'other-member')).rejects.toThrow();
    await expect(openLinkIdentity(secret, blob.slice(0, -4), 'journey', 'member')).rejects.toThrow();
    await expect(sealLinkIdentity('short', identity, 'journey', 'member')).rejects.toThrow('Invalid agent link secret');
  });
});

describe('renewing an agent link', () => {
  it('extends expiry with existing entry types, so 0.1.2 clients still verify the log', async () => {
    const { owner, agent, entries } = await chain();
    const before = await verifyLog(entries); expect(before.ok).toBe(true);
    if (!before.ok) return;
    const renewed = await renewAgentEntries(before.state, agent.id, owner.member.id, owner.key, '2026-02-01T00:00:00.000Z');
    expect(renewed.map(entry => entry.type)).toEqual(['member.remove', 'member.add']);
    const names = logDefinitions.map(definition => definition.name);
    expect(names).toEqual(['genesis', 'journey.settings', 'member.renew', 'member.role', 'member.add', 'member.rename', 'member.profile', 'member.remove', 'grant.add', 'grant.remove', 'key.rotate', 'client.minVersion']);
    const after = await verifyLog([...entries, ...renewed]);
    expect(after.ok && after.state.members[agent.id]!.member).toMatchObject({ id: agent.id, recipient: agent.recipient, expiresAt: '2026-02-01T00:00:00.000Z', scope: 'read', name: 'Cowork', addedBy: owner.member.id });
    expect(after.ok && after.state.currentEpoch).toBe(1);
  });
  it('lets only the person who added the agent renew it', async () => {
    const { other, agent, entries } = await chain();
    const state = await verifyLog(entries); if (!state.ok) throw new Error('setup');
    await expect(renewAgentEntries(state.state, agent.id, other.member.id, other.key, '2026-02-01T00:00:00.000Z')).rejects.toThrow('Only the person who added');
    await expect(renewAgentEntries(state.state, other.member.id, other.member.id, other.key, '2026-02-01T00:00:00.000Z')).rejects.toThrow('Agent not found');
  });
  it('does not let a renewal change who the agent is', async () => {
    const { owner, agent, entries } = await chain();
    const state = await verifyLog(entries); if (!state.ok) throw new Error('setup');
    const [remove] = await renewAgentEntries(state.state, agent.id, owner.member.id, owner.key, '2026-02-01T00:00:00.000Z');
    const swapped = await signEntry({ v: 1, seq: remove.seq + 1, prev: await hashEntry(remove), at: '2026-01-03T00:00:00Z', actor: owner.member.id, type: 'member.add', body: { member: { ...agent, scope: 'readwrite', recipient: (await createAgeIdentity()).recipient }, grants: [], kind: 'agent' } }, owner.key);
    const result = await verifyLog([...entries, remove, swapped]);
    expect(result.ok && result.state.members[agent.id]!.member.recipient).not.toBe(agent.recipient); // The log alone cannot stop this…
    // …which is why the server pins the link to its stored recipient: see the server link test.
  });
});
