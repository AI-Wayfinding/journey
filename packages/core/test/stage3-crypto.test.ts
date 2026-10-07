import { describe, expect, it } from 'vitest';
import { PRIVATE_CHUNK_BYTES, PRIVATE_SLOT_BYTES, PRIVATE_HEADER_BYTES, newPrivateId, sealPrivateSlot, openPrivateSlot, sealPrivateFrame, openPrivateFrame, privateRandomBytes, createAgeIdentity, deriveRecipient, privateDecode } from '../src/index.js';
import { encode } from '../src/codec.js';
import { privateFixture } from './stage0-fixture.js';

describe('fixed private ciphertext and independent key domains', () => {
  it('accepts a sibling agent wrap signer only with verified same-person authority', async () => {
    const { sealVaultAgentWrap, openVaultAgentWrap, privateIdentity } = await import('../src/index.js');
    const f = await privateFixture(), content = await createAgeIdentity(), writer = privateIdentity(f.reader.member), recipient = privateIdentity(f.writer.member);
    const binding = { journey: f.context.journey, person: f.author.member.id, agent: f.writer.member.id, vault: f.vault, author: f.identity, recipient };
    const wrap = await sealVaultAgentWrap(binding, content.identity, f.reader.key, { writer, context: f.context });
    expect(await openVaultAgentWrap(wrap, binding, f.writer.identity, f.context)).toBe(content.identity);
    await expect(openVaultAgentWrap(wrap, binding, f.writer.identity)).rejects.toThrow('signer denied');
    await expect(sealVaultAgentWrap(binding, content.identity, f.foreign.key, { writer: privateIdentity(f.foreign.member), context: f.context })).rejects.toThrow('signer denied');
    const forged = await sealVaultAgentWrap(binding, content.identity, f.foreign.key, { writer, context: f.context });
    await expect(openVaultAgentWrap(forged, binding, f.writer.identity, f.context)).rejects.toThrow('signature');
  });
  it('pads zero and populated slots alike, changes nonces, binds vault/index/key and refuses overflow', async () => {
    const root = privateRandomBytes(32), vault = newPrivateId(), bytes = new TextEncoder().encode('PRIVATE SLOT CANARY');
    const empty = await sealPrivateSlot(root, vault, 0, new Uint8Array()), filled = await sealPrivateSlot(root, vault, 0, bytes), again = await sealPrivateSlot(root, vault, 0, bytes);
    expect(privateDecode(empty)).toHaveLength(PRIVATE_SLOT_BYTES); expect(privateDecode(filled)).toHaveLength(PRIVATE_SLOT_BYTES); expect(filled).not.toBe(again);
    expect(await openPrivateSlot(root, vault, 0, empty)).toHaveLength(0); expect(await openPrivateSlot(root, vault, 0, filled)).toEqual(bytes);
    for (const [key, id, index] of [[privateRandomBytes(32), vault, 0], [root, newPrivateId(), 0], [root, vault, 1]] as const) await expect(openPrivateSlot(key, id, index, filled)).rejects.toThrow();
    for (const offset of [0, 12, PRIVATE_SLOT_BYTES - 1]) { const bad = privateDecode(filled); bad[offset] = bad[offset]! ^ 1; await expect(openPrivateSlot(root, vault, 0, encode(bad))).rejects.toThrow(); }
    await expect(sealPrivateSlot(root, vault, 0, new Uint8Array(PRIVATE_CHUNK_BYTES + 1))).rejects.toThrow('capacity');
    await expect(openPrivateSlot(root, vault, 0, encode(new Uint8Array(10)))).rejects.toThrow('framing');
    await expect(sealPrivateSlot(root, vault, 64, bytes)).rejects.toThrow('binding');
  });
  it('pads encrypted header content before age framing; no recovery or journey identity unlocks it', async () => {
    const { identity, recipient } = await createAgeIdentity(), other = (await createAgeIdentity()).identity;
    const a = await sealPrivateFrame({ empty: true }, recipient), b = await sealPrivateFrame({ text: 'PRIVATE HEADER CANARY', slots: Array(64).fill('digest') }, recipient);
    expect(privateDecode(a)).toHaveLength(PRIVATE_HEADER_BYTES); expect(privateDecode(b)).toHaveLength(PRIVATE_HEADER_BYTES);
    expect(new DataView(privateDecode(a).buffer).getUint32(0)).toBe(new DataView(privateDecode(b).buffer).getUint32(0));
    expect(await openPrivateFrame(b, identity, recipient)).toEqual({ text: 'PRIVATE HEADER CANARY', slots: Array(64).fill('digest') });
    await expect(openPrivateFrame(b, other, recipient)).rejects.toThrow('binding');
    await expect(openPrivateFrame(b, other, await deriveRecipient(other))).rejects.toThrow();
    const corrupt = privateDecode(b); corrupt[100] = corrupt[100]! ^ 1; await expect(openPrivateFrame(encode(corrupt), identity, recipient)).rejects.toThrow();
    await expect(sealPrivateFrame({ text: 'x'.repeat(20000) }, recipient)).rejects.toThrow('capacity');
  });
  it('wraps only the vault content identity, bound to the person, agent and journey', async () => {
    const { sealVaultAgentWrap, openVaultAgentWrap, createSigningIdentity, importSigningKey } = await import('../src/index.js');
    const person = await createAgeIdentity(), agent = await createAgeIdentity(), foreign = await createAgeIdentity(), signing = await createSigningIdentity();
    const author = { kind: 'person' as const, recipient: person.recipient, signingKey: signing.publicKey };
    const target = { kind: 'agent' as const, recipient: agent.recipient, signingKey: (await createSigningIdentity()).publicKey };
    const binding = { journey: 'journey', person: 'person', agent: 'agent', vault: newPrivateId(), author, recipient: target };
    const content = await createAgeIdentity();
    const wrap = await sealVaultAgentWrap(binding, content.identity, await importSigningKey(signing.privateKey));
    expect(wrap).not.toContain(content.identity); expect(wrap).not.toContain(person.identity);
    expect(await openVaultAgentWrap(wrap, binding, agent.identity)).toBe(content.identity);
    await expect(openVaultAgentWrap(wrap, binding, foreign.identity)).rejects.toThrow();
    for (const key of ['journey', 'person', 'agent', 'vault'] as const) await expect(openVaultAgentWrap(wrap, { ...binding, [key]: 'foreign' }, agent.identity)).rejects.toThrow();
    await expect(openVaultAgentWrap(wrap, { ...binding, recipient: { ...target, signingKey: signing.publicKey } }, agent.identity)).rejects.toThrow();
  });
});
