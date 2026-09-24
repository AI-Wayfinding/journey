import { describe, expect, it } from 'vitest';
import { createAgentIdentity, createAgeIdentity, createSigningIdentity, deriveRecipient, generateJourneyKey, isId, newId, open, openIdentity, rotateJourneyKey, seal, sealIdentity, unwrapJourneyKey, wrapJourneyKey } from '../src/index.js';

describe('portable crypto', () => {
  it('makes sortable, valid IDs', () => {
    const first = newId();
    expect(isId(first)).toBe(true);
    expect(isId('x')).toBe(false);
    expect(newId() > first).toBe(true);
  });

  it('seals a private identity for any age recipient and opens it with the corresponding identity', async () => {
    const { identity, recipient } = await createAgeIdentity();
    expect(await deriveRecipient(identity)).toBe(recipient);
    const sealed = await sealIdentity('private material', [recipient]);
    expect(await openIdentity(sealed, [identity])).toBe('private material');
    const agent = await createAgentIdentity();
    expect(agent.privateKey.extractable).toBe(false);
    expect(await deriveRecipient(agent.privateKey)).toBe(agent.recipient);
    const signed = await createSigningIdentity();
    expect(signed.publicKey.length).toBeGreaterThan(30);
  });

  it('wraps a key for three recipients; removal cuts off only future epochs', async () => {
    const people = await Promise.all(Array.from({ length: 3 }, () => createAgeIdentity()));
    const first = generateJourneyKey();
    const wraps = await wrapJourneyKey(first, people.map((p, i) => ({ id: String(i), recipient: p.recipient })));
    expect(wraps).toHaveLength(3);
    for (let i = 0; i < 3; i++) expect((await unwrapJourneyKey(wraps[i]!, people[i]!.identity)).key).toEqual(first.key);
    const next = await rotateJourneyKey(first, people.slice(0, 2).map((p, i) => ({ id: String(i), recipient: p.recipient })));
    expect(next.key.epoch).toBe(2);
    for (let i = 0; i < 2; i++) expect((await unwrapJourneyKey(next.wraps[i]!, people[i]!.identity)).key).toEqual(next.key.key);
    await expect(unwrapJourneyKey(next.wraps[0]!, people[2]!.identity)).rejects.toThrow();
  });

  it('authenticates every outside field, including a preassigned sequence', async () => {
    const key = generateJourneyKey();
    const inside = { type: 'item', typeVersion: 1, body: { title: 'Secret' } };
    const envelope = await seal(inside, { id: newId(), journey: newId(), seq: 1, epoch: 1, createdAt: new Date().toISOString() }, key);
    expect(Object.keys(envelope.outside).sort()).toEqual(['createdAt', 'epoch', 'id', 'journey', 'seq', 'size', 'v']);
    expect(JSON.stringify(envelope.outside)).not.toContain('item');
    expect(await open(envelope, key)).toEqual(inside);
    for (const field of ['id', 'journey', 'epoch', 'size', 'createdAt', 'seq'] as const) {
      const changed = { ...envelope, outside: { ...envelope.outside, [field]: field === 'epoch' || field === 'size' || field === 'seq' ? 99 : 'tampered' } };
      await expect(open(changed, key)).rejects.toThrow();
    }
    await expect(open({ ...envelope, ciphertext: envelope.ciphertext.slice(0, -2) + 'xx' }, key)).rejects.toThrow();
    await expect(open(envelope, generateJourneyKey())).rejects.toThrow();
  });
});
