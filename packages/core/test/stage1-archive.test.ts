import { expect, it } from 'vitest';
import { artifactTypeHash, canonical, exportArtifactJourney, importArtifactJourney, verifyArtifactArchive, wrapJourneyKey, newId, sealIdentity, seal, hashControlProof, signControlProof } from '../src/index.js';
import type { ArtifactArchive, BlobDescriptor } from '../src/index.js';
import { artifactFixture, artifactAppend, artifactBody, documentPayload, person } from './stage0-fixture.js';

async function fixture() {
  const f = await artifactFixture(), id = newId(), bytes = new TextEncoder().encode('Original attachment bytes');
  const nonce = crypto.getRandomValues(new Uint8Array(12)), rawKey = await crypto.subtle.importKey('raw', Uint8Array.from(f.key.key).buffer, 'AES-GCM', false, ['encrypt']);
  const associated = { v: 1, journey: f.journey, id, epoch: 1, size: bytes.length };
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(canonical(associated)) }, rawKey, bytes));
  const descriptor: BlobDescriptor = { ...associated, v: 1, ciphertextSize: ciphertext.length, nonce: Buffer.from(nonce).toString('base64'), digest: Buffer.from(await crypto.subtle.digest('SHA-256', ciphertext)).toString('base64') };
  const body = await artifactBody(f.guide.member.id, { blobs: [descriptor] });
  await artifactAppend(f, f.guide, 'artifact.create', body, { ...documentPayload(), attachments: [{ blob: descriptor, name: 'secret.bin', mime: 'application/octet-stream' }] });
  await artifactAppend(f, f.guide, 'artifact.version', { ...body, version: newId(), predecessor: body.version, blobs: [] });
  const archive: ArtifactArchive = { format: 'artifact-v1', version: 1, journey: f.journey, creator: f.guide.member, controls: f.controls, envelopes: [], wraps: await wrapJourneyKey(f.key, [{ id: f.guide.member.id, recipient: f.guide.member.recipient }]), blobs: [{ descriptor, ciphertext: Buffer.from(ciphertext).toString('base64') }], unavailableDeletedBlobs: [] };
  return { f, archive, body, descriptor };
}
it('round-trips a versioned encrypted archive with proofs, payloads, wraps and surviving historic blobs', async () => {
  const { f, archive, body, descriptor } = await fixture();
  const ciphertext = await exportArtifactJourney(archive, [f.guide.member.recipient], [f.guide.identity], f.trust);
  expect(ciphertext).not.toContain('secret.bin'); expect(ciphertext).not.toContain('Original attachment bytes');
  const result = await importArtifactJourney(ciphertext, [f.guide.identity], f.trust);
  expect(result.archive).toEqual(archive);
  expect(result.state.artifacts!.items[body.artifact as string]!.versions).toHaveLength(2);
  expect(result.archive.blobs[0]!.descriptor).toEqual(descriptor);
  archive.controls[1]!.proof.body.blobs = []; expect(result.archive.controls[1]!.proof.body.blobs).toEqual([descriptor]);
  await expect(importArtifactJourney(ciphertext, [(await person()).identity], f.trust)).rejects.toThrow();
  await expect(importArtifactJourney(ciphertext, [f.guide.identity], { journey: newId(), creator: f.guide.member })).rejects.toThrow();
  await expect(importArtifactJourney(ciphertext, [f.guide.identity], { journey: f.journey, creator: (await person()).member })).rejects.toThrow();
});
it('rejects archive tampering, unsupported formats, missing live bytes and unexpected fields', async () => {
  const { f, archive } = await fixture();
  const mutations: ((a: ArtifactArchive) => void)[] = [
    a => { a.version = 2 as 1; }, a => { a.format = 'legacy' as 'artifact-v1'; }, a => { a.journey = newId(); },
    a => { Object.assign(a, { secret: 'never-preserve' }); },
    a => { Object.assign(a.controls[1]!, { grants: [] }); },
    a => { Object.assign(a.controls[1]!.proof.body, { secret: 'never-preserve' }); },
    a => { a.controls[1]!.proof.actor = newId(); }, a => { a.controls[1]!.proof.sig = 'AAAA'; },
    a => { a.controls[1]!.proof.prev = null; }, a => { a.controls.reverse(); }, a => { a.controls.pop(); },
    a => { a.controls[1]!.envelope.ciphertext = a.controls[0]!.envelope.ciphertext; },
    a => { Object.assign(a.controls[1]!.envelope, { secret: 'never-preserve' }); },
    a => { a.wraps = []; }, a => { Object.assign(a.wraps[0]!, { secret: 'never-preserve' }); },
    a => { a.blobs = []; }, a => { a.blobs.push(a.blobs[0]!); },
    a => { a.blobs[0]!.ciphertext = a.blobs[0]!.ciphertext.slice(4); },
    a => { a.blobs[0]!.descriptor.digest = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; },
    a => { a.blobs[0]!.descriptor.journey = newId(); }, a => { a.blobs[0]!.descriptor.id = newId(); },
    a => { Object.assign(a.blobs[0]!, { secret: 'never-preserve' }); },
    a => { a.unavailableDeletedBlobs = [newId()]; },
  ];
  // Omission of a complete valid tail is a rollback, not detectably tampered history.
  mutations.splice(10, 1);
  for (const mutate of mutations) {
    const copy = structuredClone(archive); mutate(copy);
    const encrypted = await sealIdentity(JSON.stringify(copy), [f.guide.member.recipient]);
    await expect(importArtifactJourney(encrypted, [f.guide.identity], f.trust)).rejects.toThrow();
  }
  const invalidEnvelope = await seal({ type: 'recovery', typeVersion: 1, body: { private: 'internal' } }, { id: newId(), journey: f.journey, epoch: 1, createdAt: '2026-01-02T00:00:00.000Z' }, f.key);
  const copied = structuredClone(archive); copied.envelopes.push({ ...invalidEnvelope, secret: 'never-store' } as typeof invalidEnvelope);
  await expect(verifyArtifactArchive(copied, [f.guide.identity], f.trust)).rejects.toThrow('shape');
});
it('retains tombstoned metadata history, explains unavailable deleted bytes and refuses resurrected or unreferenced bytes', async () => {
  const { f, archive, body, descriptor } = await fixture();
  await artifactAppend(f, f.guide, 'artifact.delete', { format: 'artifact-v1', artifact: body.artifact, author: f.guide.member.id, actor: f.guide.member.id }, {});
  const deleted = { ...archive, blobs: [], unavailableDeletedBlobs: [descriptor.id] };
  const exported = await exportArtifactJourney(deleted, [f.guide.member.recipient], [f.guide.identity], f.trust);
  const result = await importArtifactJourney(exported, [f.guide.identity], f.trust);
  expect(result.state.artifacts!.items[body.artifact as string]!.deleted).toBe(true); expect(result.archive.controls).toHaveLength(4);
  expect(result.archive.unavailableDeletedBlobs).toEqual([descriptor.id]); expect(result.archive.blobs).toEqual([]);
  await expect(verifyArtifactArchive({ ...deleted, unavailableDeletedBlobs: [] }, [f.guide.identity], f.trust)).rejects.toThrow('availability');
  await expect(verifyArtifactArchive(archive, [f.guide.identity], f.trust)).rejects.toThrow('Unreferenced');
});
it('verifies authenticated blob metadata and private payload projection, not merely a re-signed hash', async () => {
  const { f, archive, body } = await fixture();
  const altered = structuredClone(archive), descriptor = altered.blobs[0]!.descriptor;
  descriptor.nonce = Buffer.from(new Uint8Array(12).fill(9)).toString('base64');
  const entry = { v: 1 as const, seq: 1, prev: await hashControlProof(altered.controls[0]!.proof), at: '2026-01-02T00:00:00.000Z', actor: f.guide.member.id, type: 'artifact.create', body: { ...body, blobs: [descriptor] } };
  const envelope = await seal({ type: 'artifact.content', typeVersion: 1, body: { ...documentPayload(), attachments: [{ blob: descriptor, name: 'secret.bin', mime: 'application/octet-stream' }] } }, { id: newId(), journey: f.journey, seq: 1, epoch: 1, createdAt: entry.at }, f.key);
  altered.controls = [altered.controls[0]!, { proof: await signControlProof(entry, envelope, f.journey, f.guide.key), envelope }];
  await expect(verifyArtifactArchive(altered, [f.guide.identity], f.trust)).rejects.toThrow();
  const wrongDigest = structuredClone(archive), badDescriptor = wrongDigest.blobs[0]!.descriptor;
  badDescriptor.digest = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const digestBody = { ...body, blobs: [badDescriptor] };
  const digestPayload = await seal({ type: 'artifact.content', typeVersion: 1, body: { ...documentPayload(), attachments: [{ blob: badDescriptor, name: 'secret.bin', mime: 'application/octet-stream' }] } }, { id: newId(), journey: f.journey, seq: 1, epoch: 1, createdAt: entry.at }, f.key);
  wrongDigest.controls = [wrongDigest.controls[0]!, { proof: await signControlProof({ ...entry, body: digestBody }, digestPayload, f.journey, f.guide.key), envelope: digestPayload }];
  await expect(verifyArtifactArchive(wrongDigest, [f.guide.identity], f.trust)).rejects.toThrow('digest');
  const wrongPayload = await seal({ type: 'artifact.content', typeVersion: 1, body: { ...documentPayload(), content: { kind: 'prompt', text: 'Wrong type' }, attachments: [] } }, { id: newId(), journey: f.journey, seq: 1, epoch: 1, createdAt: entry.at }, f.key);
  altered.blobs = []; altered.controls[1] = { proof: await signControlProof({ ...entry, body: { ...entry.body, blobs: [], typeHash: await artifactTypeHash('document') } }, wrongPayload, f.journey, f.guide.key), envelope: wrongPayload };
  await expect(verifyArtifactArchive(altered, [f.guide.identity], f.trust)).rejects.toThrow('payload');
});
