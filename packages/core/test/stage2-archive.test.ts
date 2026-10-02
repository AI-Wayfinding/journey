import { expect, it } from 'vitest';
import { exportArtifactJourney, importArtifactJourney, verifyArtifactArchive, wrapJourneyKey, newId, sealIdentity, canonical, projectPurposeHash, selectProjectArtifacts, effectiveProjectParticipants, seal, signControlProof } from '../src/index.js';
import { encode } from '../src/codec.js';
import type { ArtifactArchive, BlobDescriptor } from '../src/index.js';
import { artifactFixture, artifactAppend, artifactBody, documentPayload } from './stage0-fixture.js';

async function fixture() {
  const f = await artifactFixture('0.1.6'), project = newId(), id = newId();
  await artifactAppend(f, f.guide, 'project.create', { format: 'project-v1', project, purposeHash: await projectPurposeHash('Encrypted project 🌿'), state: 'getting-started' }, { purpose: 'Encrypted project 🌿' });
  await artifactAppend(f, f.guide, 'project.join', { format: 'project-v1', project, member: f.guide.member.id, predecessor: null }, {});
  await artifactAppend(f, f.guide, 'project.state', { format: 'project-v1', project, state: 'archived', predecessor: 1 }, {});
  const bytes = new TextEncoder().encode('Live secret blob bytes'), nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(f.key.key).buffer, 'AES-GCM', false, ['encrypt']);
  const associated = { v: 1 as const, journey: f.journey, id, epoch: 1, size: bytes.length };
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(canonical(associated)) }, key, bytes));
  const descriptor: BlobDescriptor = { ...associated, ciphertextSize: ciphertext.length, nonce: encode(nonce), digest: encode(new Uint8Array(await crypto.subtle.digest('SHA-256', ciphertext))) };
  const body = await artifactBody(f.guide.member.id, { blobs: [descriptor] });
  await artifactAppend(f, f.guide, 'artifact.create', body, { ...documentPayload(), attachments: [{ blob: descriptor, name: 'private.bin', mime: 'application/octet-stream' }] });
  await artifactAppend(f, f.guide, 'artifact.project', { format: 'project-v1', project, artifact: body.artifact, author: f.guide.member.id, actor: f.guide.member.id, predecessor: null }, {});
  await artifactAppend(f, f.guide, 'project.purpose', { format: 'project-v1', project, purposeHash: await projectPurposeHash('Revised purpose'), predecessor: 3 }, { purpose: 'Revised purpose' });
  await artifactAppend(f, f.guide, 'project.state', { format: 'project-v1', project, state: 'looking-for-others', predecessor: 6 }, {});
  await artifactAppend(f, f.guide, 'project.leave', { format: 'project-v1', project, member: f.guide.member.id, predecessor: 2 }, {});
  const archive: ArtifactArchive = { format: 'artifact-v1', version: 1, journey: f.journey, creator: f.guide.member, controls: f.controls, envelopes: [], wraps: await wrapJourneyKey(f.key, [{ id: f.guide.member.id, recipient: f.guide.member.recipient }]), blobs: [{ descriptor, ciphertext: encode(ciphertext) }], unavailableDeletedBlobs: [] };
  return { f, project, body, archive };
}

it('round-trips the actual encrypted archive retaining every project control and live blob, rebuilding revisions and placement', async () => {
  const { f, project, body, archive } = await fixture();
  const encrypted = await exportArtifactJourney(archive, [f.guide.member.recipient], [f.guide.identity], f.trust);
  expect(encrypted).not.toContain('Revised purpose'); expect(encrypted).not.toContain('private.bin'); expect(encrypted).not.toContain('Live secret blob bytes');
  const result = await importArtifactJourney(encrypted, [f.guide.identity], f.trust);
  expect(result.archive).toEqual(archive);
  expect(result.state.projects!.items[project]).toMatchObject({ purpose: 'Revised purpose', state: 'looking-for-others', revision: 7 });
  expect(result.state.projects!.items[project]!.history).toHaveLength(4);
  expect(result.state.projects!.participation).toEqual([{ project, member: f.guide.member.id, active: false, revision: 8 }]);
  expect(effectiveProjectParticipants(result.state, project)).toEqual([]);
  expect(result.state.projects!.placements[body.artifact as string]).toMatchObject({ project, revision: 5 });
  expect(selectProjectArtifacts(result.state, project)).toEqual([body.artifact]);
  expect(result.archive.blobs[0]!.ciphertext).toEqual(archive.blobs[0]!.ciphertext);
  archive.controls[1]!.proof.body.purposeHash = 'changed';
  expect(result.archive.controls[1]!.proof.body.purposeHash).not.toBe('changed');
});

it('rejects forged indexes, extra fields, foreign references, commitments, ciphertext authority and missing blob bytes without a partial archive', async () => {
  const { f, archive } = await fixture();
  const mutations: ((a: ArtifactArchive) => void)[] = [
    a => { Object.assign(a, { projects: { items: { forged: { purpose: 'Never output' } } } }); },
    a => { Object.assign(a.controls[1]!.proof.body, { purpose: 'Never output' }); },
    a => { a.controls[1]!.proof.body.purposeHash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; },
    a => { a.controls[5]!.proof.body.project = newId(); },
    a => { a.controls[5]!.proof.body.predecessor = 0; },
    a => { a.controls[2]!.proof.body.member = newId(); },
    a => { a.controls[3]!.proof.sig = 'AAAA'; },
    a => { a.controls[3]!.envelope.ciphertext = a.controls[1]!.envelope.ciphertext; },
    a => { a.blobs = []; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(archive); mutate(copy);
    const encrypted = await sealIdentity(JSON.stringify(copy), [f.guide.member.recipient]);
    await expect(importArtifactJourney(encrypted, [f.guide.identity], f.trust)).rejects.toThrow();
  }
  // A genuinely re-signed ciphertext still cannot introduce a second action or grants.
  const copy = structuredClone(archive), proof = copy.controls[1]!.proof;
  const envelope = await seal({ type: 'project.content', typeVersion: 1, body: { purpose: 'Encrypted project 🌿', member: f.guide.member.id, grants: ['members.manage'] } }, copy.controls[1]!.envelope.outside, f.key);
  copy.controls = [copy.controls[0]!, { proof: await signControlProof(proof, envelope, f.journey, f.guide.key), envelope }];
  copy.blobs = [];
  await expect(verifyArtifactArchive(copy, [f.guide.identity], f.trust)).rejects.toThrow('payload');
});
