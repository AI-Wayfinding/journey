import { describe, expect, it } from 'vitest';
import { exportPrivateBundle, importPrivateBundle, verifyPrivateBundle, privateAuthorityHistory, privateIdentity, privateAgentSession, createPrivateChallenge, answerPrivateChallenge, authenticatePrivateAgent, privateCopies, privateHash, newPrivateId, privateDerivedKey, privateBlobAAD, privateBytesHash, openPrivateBlob, exportArtifactJourney, importArtifactJourney, wrapJourneyKey, canonical } from '../src/index.js';
import type { PrivateBundle, PrivateBlob } from '../src/index.js';
import { privateFixture, created, record, content, marker } from './stage0-fixture.js';
import { encode, asBuffer } from '../src/codec.js';

async function fixture() {
  const f = await privateFixture(), c = await created(f), key = crypto.getRandomValues(new Uint8Array(32));
  const bundle: PrivateBundle = { format: 'private-v1', version: 1, vault: f.vault, author: f.identity, scope: 'author-backup', authorityHistories: [privateAuthorityHistory(f.context)], records: c.records, payloads: c.payloads, copyKeys: [{ copy: f.copy, key: encode(key) }], blobs: [], unavailableDeletedBlobs: [] };
  return { f, c, key, bundle, options: { trust: { vault: f.vault, author: f.identity }, contexts: [f.context], sessions: [f.session] } };
}
async function attachment(f: Awaited<ReturnType<typeof fixture>>) {
  const raw = new TextEncoder().encode('private attachment bytes'), nonce = crypto.getRandomValues(new Uint8Array(12));
  const b: PrivateBlob = { v: 1, vault: f.f.vault, copy: f.f.copy, id: newPrivateId(), generation: 1, size: raw.length, ciphertextSize: raw.length + 16, nonce: encode(nonce), digest: await privateHash('pending'), contentHash: await privateBytesHash(raw) };
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(nonce), additionalData: asBuffer(privateBlobAAD(b)) }, await privateDerivedKey(f.key, b.vault, b.copy, 'blob'), asBuffer(raw)));
  b.digest = await privateBytesHash(encrypted);
  const payload = content(); payload.body.attachments = [{ blob: b, name: 'Private.md', mime: 'text/markdown' }];
  const r = await record(f.f.context, f.f.author, f.f.vault, f.f.copy, f.f.artifact, f.f.identity, 'private.create', [], payload, { blobs: [b] });
  return { raw, b, encrypted, r, bundle: { ...f.bundle, records: [r.record], payloads: [r.payload], blobs: [{ descriptor: b, ciphertext: encode(encrypted) }] } };
}

describe('Node encrypted private transfer contracts', () => {
  it('round-trips signed author backup with historical/offline recovery and no foreign keys', async () => {
    const f = await fixture();
    const encrypted = await exportPrivateBundle(f.bundle, { ...f.options, recipient: f.f.session });
    expect(encrypted).not.toContain(f.f.artifact); expect(encrypted).not.toContain('Private title');
    const imported = await importPrivateBundle(encrypted, f.f.author.identity, { ...f.options, recipient: f.f.identity });
    expect(privateCopies(imported.view)[0]!.author).toEqual(f.f.identity); expect(imported.bundle).toEqual(f.bundle);
    const offline = await importPrivateBundle(encrypted, f.f.author.identity, { trust: f.options.trust, recipient: f.f.identity, historical: true });
    expect(privateCopies(offline.view)).toHaveLength(1);
    await expect(importPrivateBundle(encrypted, f.f.foreign.identity, { ...f.options, recipient: privateIdentity(f.f.foreign.member) })).rejects.toThrow();
    await expect(importPrivateBundle(encrypted, f.f.author.identity, { ...f.options, recipient: { ...f.f.identity, recipient: f.f.foreign.member.recipient } })).rejects.toThrow('key mismatch');
  });
  it('hands off only to authenticated eligible agents; returns are signed and scoped to the pinned author', async () => {
    const f = await fixture(), challenge = await createPrivateChallenge(f.f.context, f.f.session, privateIdentity(f.f.reader.member)), reader = await authenticatePrivateAgent(challenge, await answerPrivateChallenge(challenge, f.f.reader.key, f.f.reader.identity), 'authenticated');
    const handoff = { ...f.bundle, scope: 'agent-handoff' as const }, options = { ...f.options, sessions: [f.f.session, reader] };
    const encrypted = await exportPrivateBundle(handoff, { ...options, recipient: reader });
    const imported = await importPrivateBundle(encrypted, f.f.reader.identity, { ...options, recipient: reader.identity }); expect(privateCopies(imported.view)).toHaveLength(1);
    await expect(importPrivateBundle(encrypted, f.f.reader.identity, { trust: f.options.trust, recipient: reader.identity, historical: true })).rejects.toThrow('author-backup');
    const foreign = await privateAgentSession(f.f.context, privateIdentity(f.f.foreign.member), f.f.foreign.key, f.f.foreign.identity, 'authenticated');
    await expect(exportPrivateBundle(handoff, { ...options, recipient: foreign })).rejects.toThrow('audience');
    await expect(exportPrivateBundle(handoff, { ...options, recipient: f.f.session })).rejects.toThrow('recipient');
    await expect(exportPrivateBundle(handoff, { ...options, recipient: { identity: reader.identity, binding: reader.binding } })).rejects.toThrow('audience');
    const writer = await privateAgentSession(f.f.context, privateIdentity(f.f.writer.member), f.f.writer.key, f.f.writer.identity, 'authenticated');
    const edit = await record(f.f.context, f.f.writer, f.f.vault, f.f.copy, f.f.artifact, f.f.identity, 'private.version', f.c.records, content('Agent proposal'));
    const returned = { ...f.bundle, scope: 'agent-return' as const, records: [...f.c.records, edit.record], payloads: [...f.c.payloads, edit.payload] }, writeOptions = { ...f.options, sessions: [f.f.session, writer] };
    const response = await exportPrivateBundle(returned, { ...writeOptions, recipient: f.f.session });
    const checked = await importPrivateBundle(response, f.f.author.identity, { ...writeOptions, recipient: f.f.identity });
    expect(privateCopies(checked.view)[0]!.records[1]!.actor).toEqual(writer.identity);
    await expect(exportPrivateBundle(returned, { ...writeOptions, recipient: writer })).rejects.toThrow('recipient');
    const readEdit = await record(f.f.context, f.f.reader, f.f.vault, f.f.copy, f.f.artifact, f.f.identity, 'private.version', f.c.records);
    await expect(verifyPrivateBundle({ ...returned, records: [...f.c.records, readEdit.record], payloads: [...f.c.payloads, readEdit.payload] }, options)).rejects.toThrow('denied');
  });
  it('validates exact fields, actual ciphertext/raw digests, domains, complete blobs and deleted availability atomically', async () => {
    const f = await fixture(), a = await attachment(f);
    expect(await openPrivateBlob(a.b, encode(a.encrypted), f.key)).toEqual(a.raw);
    expect((await verifyPrivateBundle(a.bundle, f.options)).bundle.blobs).toHaveLength(1);
    for (const mutate of [
      (b: PrivateBundle) => { (b as unknown as Record<string, unknown>).recipients = [f.f.foreign.member.recipient]; },
      (b: PrivateBundle) => { b.records[0]!.body.author = { ...f.f.identity, signingKey: f.f.foreign.member.signingKey }; },
      (b: PrivateBundle) => { b.payloads[0]!.payload.body.title = 'forged'; },
      (b: PrivateBundle) => { b.copyKeys[0]!.key = encode(new Uint8Array(32)); },
      (b: PrivateBundle) => { b.blobs = []; },
      (b: PrivateBundle) => { b.blobs.push(b.blobs[0]!); },
      (b: PrivateBundle) => { b.blobs[0]!.ciphertext = encode(new Uint8Array(a.encrypted.length)); },
      (b: PrivateBundle) => { b.unavailableDeletedBlobs = [a.b.id]; },
      (b: PrivateBundle) => { b.authorityHistories[0]!.controls.at(-1)!.proof.body.role = 'read-only'; },
    ]) { const bad = structuredClone(a.bundle); mutate(bad); await expect(verifyPrivateBundle(bad, f.options)).rejects.toThrow(); }
    for (const descriptor of [{ ...a.b, vault: newPrivateId() }, { ...a.b, copy: newPrivateId() }, { ...a.b, generation: 2 }, { ...a.b, contentHash: await privateHash('forged') }]) await expect(openPrivateBlob(descriptor, encode(a.encrypted), f.key)).rejects.toThrow();
    const del = await record(f.f.context, f.f.author, f.f.vault, f.f.copy, f.f.artifact, f.f.identity, 'private.delete', [a.r.record], marker());
    const deleted = { ...a.bundle, records: [a.r.record, del.record], payloads: [a.r.payload, del.payload], blobs: [], unavailableDeletedBlobs: [a.b.id] };
    expect((await verifyPrivateBundle(deleted, f.options)).bundle.unavailableDeletedBlobs).toEqual([a.b.id]);
    await expect(verifyPrivateBundle({ ...deleted, unavailableDeletedBlobs: [] }, f.options)).rejects.toThrow('availability');
    expect(a.bundle.records).toHaveLength(1);
  });
  it('keeps all private identifiers and material outside ordinary journey exports', async () => {
    const f = await fixture(), wraps = await wrapJourneyKey(f.f.f.key, [{ id: f.f.f.guide.member.id, recipient: f.f.f.guide.member.recipient }]);
    const shared = { format: 'artifact-v1' as const, version: 1 as const, journey: f.f.f.journey, creator: f.f.f.guide.member, controls: f.f.f.controls, wraps, envelopes: [], blobs: [], unavailableDeletedBlobs: [] };
    const encrypted = await exportArtifactJourney(shared, [f.f.f.guide.member.recipient], [f.f.f.guide.identity], f.f.f.trust);
    const imported = await importArtifactJourney(encrypted, [f.f.f.guide.identity], f.f.f.trust);
    for (const privateValue of [f.f.vault, f.f.copy, f.f.artifact, 'Private title', f.bundle.copyKeys[0]!.key]) expect(canonical(imported)).not.toContain(privateValue);
    await expect(exportArtifactJourney({ ...shared, private: f.bundle } as typeof shared, [f.f.f.guide.member.recipient], [f.f.f.guide.identity], f.f.f.trust)).rejects.toThrow();
  });
});
