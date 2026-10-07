import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { artifactTypeHash, canonical, deriveRecipient, importSigningKey, newId, openPrivateFrame, privateAuthority, privateBytesHash, privateDecode, privateHash, privatePlainBytes, sealPrivateFrame, sealPrivateSlot, signPrivateHeader, signPrivateRecord, verifyPrivateContext } from '@ai-wayfinding/core';
import type { PrivateBundle, PrivateHeader, ProtocolRecord, VaultCacheRecord } from '@ai-wayfinding/core';
import type { privateFixture } from './stage3-fixtures.js';
import { scratch } from './local-server.js';

type Fixture = Awaited<ReturnType<typeof privateFixture>>;
type Frame = { header: PrivateHeader; root: string; contentIdentity: string; directory: { branches: number[][]; initialized: number[] } };
/** Independently signed offline history. Only fixture construction uses core
 * crypto; the merge under test is the shipped CLI/MCP against live workerd. */
export async function forkRecord(f: Fixture, bundle: PrivateBundle, title: string, type: 'private.version' | 'private.delete' = 'private.version') {
  const context = await verifyPrivateContext({ journey: f.trip.id, creator: f.trip.entries[0]!.proof.body.creator as import('@ai-wayfinding/core').Member, controls: f.trip.entries }, { now: Date.now(), currentHead: await privateHash(f.trip.entries.at(-1)!.proof) });
  const prior = bundle.records.filter(r => r.copy === f.copy), first = prior[0]!;
  const payload: ProtocolRecord = type === 'private.delete' ? { type: 'artifact.tombstone', typeVersion: 1, body: {} } : { type: 'artifact.content', typeVersion: 1, body: { title, tags: [], content: { kind: 'document', markdown: title }, attachments: [] } };
  const record = await signPrivateRecord({ format: 'private-v1', v: 1, id: newId(), vault: f.vaultId, copy: f.copy, seq: prior.length, prev: await privateHash(prior.at(-1)!), at: new Date().toISOString(), actor: f.bundle.author, authority: privateAuthority(context, f.bundle.author), type, body: { artifact: first.body.artifact!, author: first.body.author!, actor: first.body.actor!, predecessor: prior.filter(r => r.type === 'private.create' || r.type === 'private.version').at(-1)!.body.version!, ...(type === 'private.version' ? { version: newId(), typeHash: await artifactTypeHash('document'), blobs: [] } : {}) }, payloadHash: await privateHash(payload) }, await importSigningKey(f.owner.signing.privateKey));
  bundle.records.push(record); bundle.payloads.push({ record: record.id, payload });
}
export async function forkCache(f: Fixture, base: VaultCacheRecord, bundle: PrivateBundle, alter?: (frame: Frame) => Promise<void>) {
  const raw = await openPrivateFrame(base.frame, f.owner.age.identity, f.bundle.author.recipient) as Frame;
  const bytes = privatePlainBytes(bundle), root = privateDecode(raw.root, 32), slots = base.slots.slice();
  try {
    const index = raw.directory.branches[0]![0]!;
    slots[index] = await sealPrivateSlot(root, f.vaultId, index, bytes);
    raw.directory.branches = [[index]];
    const hashes = await Promise.all(slots.map(s => privateBytesHash(privateDecode(s))));
    const { sig: _sig, writer: _writer, authority: _authority, ...header } = raw.header;
    raw.header = await signPrivateHeader({ ...header, slots: hashes, contentsHash: await privateHash({ slots: hashes, root: raw.root, directory: raw.directory, contentIdentity: raw.contentIdentity }) }, await importSigningKey(f.owner.signing.privateKey));
    if (alter) await alter(raw);
    const frame = await sealPrivateFrame(raw, f.bundle.author.recipient, await deriveRecipient(raw.contentIdentity));
    return { token: base.token, frame, slots, checkpoint: { ...base.checkpoint, head: await privateHash(raw.header), version: raw.header.version, prev: raw.header.prev } };
  } finally { bytes.fill(0); root.fill(0); }
}
export async function forkFile(value: unknown) { const path = join(scratch, 'fork-' + newId() + '.json'); await writeFile(path, canonical(value), { mode: 0o600 }); return path; }
