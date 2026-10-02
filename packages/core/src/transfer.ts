import type { AgeIdentity, AgeRecipient } from './keys.js';
import { openIdentity, sealIdentity } from './keys.js';
import { open } from './envelope.js';
import type { Envelope } from './envelope.js';
import { verifyLog } from './log.js';
import type { LogEntry, LogState } from './log.js';
import { unwrapJourneyKey } from './teamKey.js';
import type { KeyWrap } from './teamKey.js';
import { parseRecord } from './items.js';
export interface JourneyArchive { log: LogEntry[]; envelopes: Envelope[]; wraps: KeyWrap[] }
export async function exportJourney(log: LogEntry[], envelopes: Envelope[], wraps: KeyWrap[], recipients: AgeRecipient[]): Promise<string> {
  return sealIdentity(JSON.stringify({ log, envelopes, wraps }), recipients);
}
export async function importJourney(ciphertext: string, identities: AgeIdentity[]): Promise<{ archive: JourneyArchive; state: LogState }> {
  const parsed: unknown = JSON.parse(await openIdentity(ciphertext, identities));
  if (!parsed || typeof parsed !== 'object' || !('log' in parsed) || !Array.isArray(parsed.log) || !('envelopes' in parsed) || !Array.isArray(parsed.envelopes) || !('wraps' in parsed) || !Array.isArray(parsed.wraps)) throw new Error('Invalid journey archive');
  // Untrusted archive: verify its signed history before using its wraps or contents.
  const archive = { log: parsed.log as LogEntry[], envelopes: parsed.envelopes as Envelope[], wraps: parsed.wraps as KeyWrap[] };
  const verified = await verifyLog(archive.log);
  if (!verified.ok) throw new Error(verified.error.code + ': ' + verified.error.message);
  for (const envelope of archive.envelopes) {
    if (!envelope?.outside || envelope.outside.journey !== verified.state.journey || envelope.outside.epoch > verified.state.currentEpoch || !Number.isSafeInteger(envelope.outside.epoch)) throw new Error('Invalid archive envelope metadata');
    let opened = false;
    for (const wrap of archive.wraps.filter(w => w.epoch === envelope.outside.epoch)) {
      for (const identity of identities) {
        try {
          const key = await unwrapJourneyKey(wrap, identity);
          parseRecord(await open(envelope, key));
          opened = true;
          break;
        } catch { /* try another permitted identity / wrap */ }
      }
      if (opened) break;
    }
    if (!opened) throw new Error('No valid key or ciphertext for archive envelope');
  }
  return { archive, state: verified.state };
}

// Stage 1 archives keep the public chain, not reconstructed legacy signatures.
import { verifyControlProofs } from './controlProof.js';
import type { ControlProof } from './controlProof.js';
import type { Member } from './log.js';
import type { JourneyKey } from './teamKey.js';
import { canonical, controlDefinitions } from './log.js';
import type { JsonObject } from './types.js';
import { asBuffer, decode, encode, utf8 } from './codec.js';
import { validateBlobDescriptor, copyBlobDescriptor, copyArtifactPublic, isArtifactAction, validDigest, MAX_ARTIFACT_PAYLOAD_BYTES } from './artifacts.js';
import type { BlobDescriptor } from './artifacts.js';
import { liveArtifactBlobIds } from './rules.js';
import { isProjectAction, copyProjectPublic } from './projects.js';
import { isId } from './ids.js';

export interface ArchiveBlob { descriptor: BlobDescriptor; ciphertext: string }
export interface ArtifactArchive {
  format: 'artifact-v1'; version: 1; journey: string; creator: Member;
  controls: { proof: ControlProof; envelope: Envelope }[];
  envelopes: Envelope[]; wraps: KeyWrap[]; blobs: ArchiveBlob[];
  unavailableDeletedBlobs: string[];
}
const archiveObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const archiveShape = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join(',') === keys.sort().join(',');
function archiveEnvelope(value: unknown): Envelope {
  if (!archiveObject(value) || !archiveShape(value, ['outside', 'nonce', 'ciphertext']) || !archiveObject(value.outside)) throw new Error('Invalid archive envelope shape');
  const o = value.outside;
  const fields = ['v', 'id', 'journey', 'epoch', 'size', 'createdAt'];
  if (Object.hasOwn(o, 'seq')) fields.push('seq');
  if (!archiveShape(o, fields) || o.v !== 1 || !isId(o.id) || !isId(o.journey) || !Number.isSafeInteger(o.epoch) || (o.epoch as number) < 1 || !Number.isSafeInteger(o.size) || (o.size as number) < 0 || (o.size as number) > MAX_ARTIFACT_PAYLOAD_BYTES || typeof o.createdAt !== 'string' || !Number.isFinite(Date.parse(o.createdAt)) || (Object.hasOwn(o, 'seq') && (!Number.isSafeInteger(o.seq) || (o.seq as number) < 0)) || typeof value.nonce !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(value.nonce) || typeof value.ciphertext !== 'string') throw new Error('Invalid archive envelope metadata');
  const bytes = decode(value.ciphertext);
  if (encode(bytes) !== value.ciphertext || bytes.length !== (o.size as number) + 16) throw new Error('Invalid archive envelope ciphertext');
  return { outside: { v: 1, id: o.id, journey: o.journey, epoch: o.epoch as number, size: o.size as number, createdAt: o.createdAt, ...(o.seq === undefined ? {} : { seq: o.seq as number }) }, nonce: value.nonce, ciphertext: value.ciphertext };
}
function archiveMember(member: Member): Member {
  const copy: Member = { id: member.id, kind: member.kind, recipient: member.recipient, signingKey: member.signingKey };
  for (const field of ['name', 'scope', 'addedBy', 'expiresAt', 'support'] as const) if (Object.hasOwn(member, field)) Object.assign(copy, { [field]: member[field] });
  return copy;
}
function archiveProof(proof: ControlProof): ControlProof {
  const body: JsonObject = isProjectAction(proof.type) ? copyProjectPublic(proof.type, proof.body) : isArtifactAction(proof.type) ? copyArtifactPublic(proof.type, proof.body) : {};
  if (!isArtifactAction(proof.type) && !isProjectAction(proof.type)) for (const field of controlDefinitions.find(d => d.name === proof.type)!.fields) if (Object.hasOwn(proof.body, field)) {
    const value = proof.body[field];
    body[field] = (field === 'creator' || field === 'member') && archiveObject(value) ? archiveMember(value as Member) : Array.isArray(value) ? value.slice() : value;
  }
  return { v: 1, journey: proof.journey, seq: proof.seq, prev: proof.prev, at: proof.at, actor: proof.actor, type: proof.type, body, envelopeHash: proof.envelopeHash, sig: proof.sig };
}
/** Verify before export too. A caller cannot preserve untrusted fields as an archive. */
export async function verifyArtifactArchive(value: unknown, identities: AgeIdentity[], trust: { journey: string; creator: Member }): Promise<{ archive: ArtifactArchive; state: LogState }> {
  if (!archiveObject(value) || !archiveShape(value, ['format', 'version', 'journey', 'creator', 'controls', 'envelopes', 'wraps', 'blobs', 'unavailableDeletedBlobs']) || value.format !== 'artifact-v1' || value.version !== 1 || value.journey !== trust.journey || canonical(value.creator) !== canonical(trust.creator) || !Array.isArray(value.controls) || !Array.isArray(value.envelopes) || !Array.isArray(value.wraps) || !Array.isArray(value.blobs) || !Array.isArray(value.unavailableDeletedBlobs)) throw new Error('Invalid Stage 1 archive');
  const controls: ArtifactArchive['controls'] = [];
  for (const row of value.controls) {
    if (!archiveObject(row) || !archiveShape(row, ['proof', 'envelope'])) throw new Error('Invalid archive control');
    controls.push({ proof: row.proof as ControlProof, envelope: archiveEnvelope(row.envelope) });
  }
  const wraps: KeyWrap[] = [];
  const keys = new Map<number, JourneyKey>();
  for (const row of value.wraps) {
    if (!archiveObject(row) || !archiveShape(row, ['epoch', 'recipient', 'ciphertext']) || !Number.isSafeInteger(row.epoch) || (row.epoch as number) < 1 || typeof row.recipient !== 'string' || typeof row.ciphertext !== 'string') throw new Error('Invalid archive key wrap');
    const wrap: KeyWrap = { epoch: row.epoch as number, recipient: row.recipient, ciphertext: row.ciphertext }; wraps.push(wrap);
    for (const identity of identities) try { keys.set(wrap.epoch, await unwrapJourneyKey(wrap, identity)); break; } catch { /* Try another authorized export recipient. */ }
  }
  const publicState = await verifyControlProofs(controls.map(c => c.proof), controls.map(c => c.envelope), trust);
  if (!publicState.ok) throw new Error('Invalid archive proof: ' + publicState.error.message);
  for (const row of controls) if (!keys.has(row.envelope.outside.epoch)) throw new Error('Missing archive key');
  const checked = await verifyControlProofs(controls.map(c => c.proof), controls.map(c => c.envelope), trust, [...keys.values()]);
  if (!checked.ok) throw new Error('Invalid archive payload: ' + checked.error.message);
  const state = checked.state;
  const envelopes: Envelope[] = [];
  const ids = new Set<string>();
  for (const row of value.envelopes) {
    const envelope = archiveEnvelope(row);
    if (!envelope?.outside || !isId(envelope.outside.id) || ids.has(envelope.outside.id) || envelope.outside.journey !== trust.journey || envelope.outside.epoch > state.currentEpoch || !keys.has(envelope.outside.epoch) || envelope.outside.size > MAX_ARTIFACT_PAYLOAD_BYTES) throw new Error('Invalid archive envelope');
    ids.add(envelope.outside.id);
    parseRecord(await open(envelope, keys.get(envelope.outside.epoch)!)); envelopes.push(envelope);
  }
  const live = liveArtifactBlobIds(state).sort();
  const versions = Object.values(state.artifacts?.items ?? {}).flatMap(a => a.versions.flatMap(v => v.blobs));
  const blobs: ArchiveBlob[] = [];
  const blobIds = new Set<string>();
  for (const row of value.blobs) {
    if (!archiveObject(row) || !archiveShape(row, ['descriptor', 'ciphertext']) || !validateBlobDescriptor(row.descriptor) || typeof row.ciphertext !== 'string') throw new Error('Invalid archive blob');
    const descriptor = copyBlobDescriptor(row.descriptor);
    if (blobIds.has(descriptor.id) || descriptor.journey !== trust.journey || !live.includes(descriptor.id) || !versions.some(b => canonical(b) === canonical(descriptor))) throw new Error('Unreferenced archive blob');
    blobIds.add(descriptor.id);
    const bytes = decode(row.ciphertext);
    if (encode(bytes) !== row.ciphertext || bytes.length !== descriptor.ciphertextSize || !validDigest(descriptor.digest) || encode(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(bytes)))) !== descriptor.digest) throw new Error('Archive blob digest or size mismatch');
    const epochKey = keys.get(descriptor.epoch);
    if (!epochKey) throw new Error('Missing archive blob key');
    const key = await crypto.subtle.importKey('raw', asBuffer(epochKey.key), 'AES-GCM', false, ['decrypt']);
    const aad = utf8(canonical({ v: 1, journey: descriptor.journey, id: descriptor.id, epoch: descriptor.epoch, size: descriptor.size }));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(decode(descriptor.nonce)), additionalData: asBuffer(aad) }, key, asBuffer(bytes));
    if (plain.byteLength !== descriptor.size) throw new Error('Archive blob plaintext size mismatch');
    blobs.push({ descriptor, ciphertext: row.ciphertext });
  }
  if (canonical([...blobIds].sort()) !== canonical(live)) throw new Error('Missing surviving archive blob');
  const deleted = [...new Set(versions.map(b => b.id).filter(id => !live.includes(id)))].sort();
  if (!value.unavailableDeletedBlobs.every(isId) || canonical([...value.unavailableDeletedBlobs].sort()) !== canonical(deleted)) throw new Error('Invalid deleted blob availability');
  const archive: ArtifactArchive = { format: 'artifact-v1', version: 1, journey: trust.journey, creator: archiveMember(trust.creator), controls: controls.map(c => ({ proof: archiveProof(c.proof), envelope: c.envelope })), envelopes, wraps, blobs, unavailableDeletedBlobs: deleted };
  return { archive, state };
}
export async function exportArtifactJourney(archive: ArtifactArchive, recipients: AgeRecipient[], identities: AgeIdentity[], trust: { journey: string; creator: Member }): Promise<string> {
  const verified = await verifyArtifactArchive(archive, identities, trust);
  return sealIdentity(JSON.stringify(verified.archive), recipients);
}
export async function importArtifactJourney(ciphertext: string, identities: AgeIdentity[], trust: { journey: string; creator: Member }): Promise<{ archive: ArtifactArchive; state: LogState }> {
  return verifyArtifactArchive(JSON.parse(await openIdentity(ciphertext, identities)), identities, trust);
}
