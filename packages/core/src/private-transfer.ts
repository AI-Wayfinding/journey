import { openIdentity, sealIdentity, deriveRecipient } from './keys.js';
import type { AgeIdentity } from './keys.js';
import { decode, encode, asBuffer, utf8 } from './codec.js';
import { canonical } from './log.js';
import rules from './rules/rules.mjs';
import type { PrivateBundleScope } from './rules/rules.mjs';
import {
  PRIVATE_FORMAT, privateObject, privateShape, validPrivateId, validatePrivateIdentity, copyPrivateIdentity,
  copyPrivateRecord, validatePrivateBlob, copyPrivateBlob, privateBytesHash, verifyPrivateContext,
  verifyPrivateRecords, privateCopies, privateAccess, privateAuthorityHistory, privateVaultOwner, memberVaultId,
} from './private.js';
import type { PrivateIdentity, PrivateRecord, PrivatePayload, PrivateBlob, PrivateContext, PrivateSession, PrivateView, PrivateAuthorityHistory } from './private.js';

/** Complete signed provenance chains, without source keys or ciphertext. */
export interface PrivateSourceHistory { vault: string; records: PrivateRecord[]; payloads: PrivatePayload[] }
export interface PrivateBundle {
  format: 'private-v1'; version: 1; vault: string; author: PrivateIdentity;
  scope: 'author-backup' | 'agent-handoff' | 'agent-return'; authorityHistories: PrivateAuthorityHistory[];
  records: PrivateRecord[]; payloads: PrivatePayload[]; copyKeys: { copy: string; key: string }[];
  sourceHistories?: PrivateSourceHistory[];
  blobs: { descriptor: PrivateBlob; ciphertext: string }[]; unavailableDeletedBlobs: string[];
}
export interface PrivateBundleOptions {
  trust: { vault: string; author: PrivateIdentity }; contexts?: readonly PrivateContext[];
  sessions?: readonly PrivateSession[]; source?: PrivateView;
  /** Backup recovery verifies historical signed authority, never commits proposals. */
  historical?: boolean;
}
const bundleScopes: Record<PrivateBundle['scope'], PrivateBundleScope> = { 'author-backup': { $: 'PrivateBackup' }, 'agent-handoff': { $: 'PrivateHandoff' }, 'agent-return': { $: 'PrivateReturn' } };
function bundleRecipient(bundle: PrivateBundle, recipient: PrivateIdentity): boolean {
  return rules.private_bundle_recipient(bundleScopes[bundle.scope], { $: recipient.kind === 'agent' ? 'Agent' : 'Person' }, canonical(recipient) === canonical(bundle.author));
}
/** HKDF domain contract shared with the later vault adapter; no journey keys. */
export async function privateDerivedKey(key: Uint8Array, vault: string, copy: string, purpose: 'history' | 'blob'): Promise<CryptoKey> {
  if (key.length !== 32 || !validPrivateId(vault) || !validPrivateId(copy)) throw new Error('Invalid private copy key');
  const root = await crypto.subtle.importKey('raw', asBuffer(key), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: asBuffer(utf8('wayfinding/private/v1')), info: asBuffer(utf8(canonical({ purpose, vault, copy }))) }, root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export function privateBlobAAD(blob: PrivateBlob): Uint8Array {
  return utf8(canonical({ format: PRIVATE_FORMAT, v: 1, vault: blob.vault, copy: blob.copy, id: blob.id, generation: blob.generation, size: blob.size }));
}
export async function openPrivateBlob(blob: PrivateBlob, ciphertext: string, key: Uint8Array): Promise<Uint8Array> {
  if (!validatePrivateBlob(blob)) throw new Error('Invalid private blob');
  const bytes = decode(ciphertext);
  if (encode(bytes) !== ciphertext || bytes.length !== blob.ciphertextSize || await privateBytesHash(bytes) !== blob.digest) throw new Error('Private blob digest or size mismatch');
  const derived = await privateDerivedKey(key, blob.vault, blob.copy, 'blob');
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(decode(blob.nonce)), additionalData: asBuffer(privateBlobAAD(blob)) }, derived, asBuffer(bytes)));
  if (plain.length !== blob.size || await privateBytesHash(plain) !== blob.contentHash) throw new Error('Private blob raw content mismatch'); return plain;
}
export async function verifyPrivateBundle(value: unknown, options: PrivateBundleOptions): Promise<{ bundle: PrivateBundle; view: PrivateView }> {
  if (!privateObject(value) || !privateShape(value, ['format', 'version', 'vault', 'author', 'scope', 'authorityHistories', 'records', 'payloads', 'copyKeys', 'blobs', 'unavailableDeletedBlobs', ...(value.sourceHistories === undefined ? [] : ['sourceHistories'])]) || value.format !== PRIVATE_FORMAT || value.version !== 1 || !validPrivateId(value.vault) || value.vault !== options.trust.vault || !validatePrivateIdentity(value.author) || canonical(value.author) !== canonical(options.trust.author) || !['author-backup', 'agent-handoff', 'agent-return'].includes(value.scope as string) || !Array.isArray(value.authorityHistories) || !Array.isArray(value.records) || !Array.isArray(value.payloads) || !Array.isArray(value.copyKeys) || !Array.isArray(value.blobs) || !Array.isArray(value.unavailableDeletedBlobs)) throw new Error('Invalid private bundle');
  if (options.historical && value.scope !== 'author-backup') throw new Error('Historical recovery is author-backup only');
  const contexts: PrivateContext[] = [];
  for (const history of value.authorityHistories) {
    if (!privateObject(history) || !privateShape(history, ['journey', 'creator', 'controls'])) throw new Error('Invalid private bundle authority');
    // SAFETY: outer fields were checked here; verifyPrivateContext validates the
    // independently signed nested public history before constructing authority.
    const verified = await verifyPrivateContext(history as unknown as PrivateAuthorityHistory, { now: Date.now() });
    contexts.push(verified);
  }
  // Supplied live contexts must match the exact snapshot; otherwise no proposals.
  for (const live of options.contexts ?? []) {
    const ids = [...new Set([live.journey, live.head, ...contexts.flatMap(c => [c.journey, c.head])])];
    const id = (value: string) => BigInt(ids.indexOf(value));
    const index = contexts.findIndex(c => rules.private_authority_snapshot(id(c.journey), id(c.head), id(live.journey), id(live.head)));
    if (index >= 0) contexts[index] = live;
  }
  if (value.sourceHistories !== undefined && !Array.isArray(value.sourceHistories)) throw new Error('Invalid private source histories');
  const provenance: PrivateView[] = [], sourceHistories: PrivateSourceHistory[] = [];
  for (const history of value.sourceHistories ?? []) {
    if (!privateObject(history) || !privateShape(history, ['vault', 'records', 'payloads']) || !validPrivateId(history.vault) || history.vault === options.trust.vault || !Array.isArray(history.records) || !history.records.length || !Array.isArray(history.payloads)) throw new Error('Invalid private source history');
    const sourceRecords = history.records.map(r => copyPrivateRecord(r as PrivateRecord));
    const view = await verifyPrivateRecords(sourceRecords, history.payloads as PrivatePayload[], contexts, { vault: history.vault, author: options.trust.author }, { sessions: options.sessions, provenance, historical: true });
    const copies = privateCopies(view);
    for (const copy of copies) {
      const context = contexts.find(c => c.journey === copy.journey);
      if (!context || history.vault !== await memberVaultId(copy.journey, privateVaultOwner(context, copy.author).id, options.trust.author.signingKey, options.trust.author.recipient)) throw new Error('Private source vault mismatch');
    }
    provenance.push(view); sourceHistories.push({ vault: history.vault, records: copies.flatMap(c => c.records), payloads: copies.flatMap(c => c.payloads) });
  }
  const records = value.records.map(r => copyPrivateRecord(r as PrivateRecord));
  const view = await verifyPrivateRecords(records, value.payloads as PrivatePayload[], contexts, options.trust, { sessions: options.sessions, source: options.source, provenance, historical: options.historical });
  const copies = privateCopies(view), keys = new Map<string, Uint8Array>(), copyKeys: PrivateBundle['copyKeys'] = [];
  for (const row of value.copyKeys) {
    if (!privateObject(row) || !privateShape(row, ['copy', 'key']) || !validPrivateId(row.copy) || typeof row.key !== 'string' || keys.has(row.copy) || !copies.some(c => c.copy === row.copy)) throw new Error('Invalid private bundle copy key');
    const key = decode(row.key); if (key.length !== 32 || encode(key) !== row.key) throw new Error('Invalid private bundle key size');
    keys.set(row.copy, key); copyKeys.push({ copy: row.copy, key: row.key });
  }
  if (keys.size !== copies.length) throw new Error('Missing private copy key');
  const live = copies.filter(c => !c.deleted).flatMap(c => c.records.flatMap(r => (r.body.blobs as PrivateBlob[] | undefined) ?? []));
  const descriptors = new Map(live.map(b => [b.id, b]));
  const all = copies.flatMap(c => c.records.flatMap(r => (r.body.blobs as PrivateBlob[] | undefined) ?? []));
  const deleted = [...new Set(all.filter(b => !descriptors.has(b.id)).map(b => b.id))].sort();
  if (canonical(value.unavailableDeletedBlobs) !== canonical(deleted)) throw new Error('Invalid private deleted blob availability');
  const seen = new Set<string>(), blobs: PrivateBundle['blobs'] = [];
  for (const row of value.blobs) {
    if (!privateObject(row) || !privateShape(row, ['descriptor', 'ciphertext']) || !validatePrivateBlob(row.descriptor) || typeof row.ciphertext !== 'string' || seen.has(row.descriptor.id) || canonical(descriptors.get(row.descriptor.id)) !== canonical(row.descriptor)) throw new Error('Invalid private bundle blob reference');
    await openPrivateBlob(row.descriptor, row.ciphertext, keys.get(row.descriptor.copy)!);
    seen.add(row.descriptor.id); blobs.push({ descriptor: copyPrivateBlob(row.descriptor), ciphertext: row.ciphertext });
  }
  if (seen.size !== descriptors.size) throw new Error('Missing live private blob');
  const bundle: PrivateBundle = { format: PRIVATE_FORMAT, version: 1, vault: value.vault, author: copyPrivateIdentity(value.author), scope: value.scope as PrivateBundle['scope'], authorityHistories: contexts.map(privateAuthorityHistory), records: copies.flatMap(c => c.records), payloads: copies.flatMap(c => c.payloads), copyKeys, blobs, unavailableDeletedBlobs: deleted, ...(sourceHistories.length ? { sourceHistories } : {}) };
  return { bundle, view };
}
/** There is one derived recipient, not a recipients/grants parameter. */
export async function exportPrivateBundle(bundle: PrivateBundle, options: PrivateBundleOptions & { recipient: PrivateSession; contexts: readonly PrivateContext[] }): Promise<string> {
  const verified = await verifyPrivateBundle(bundle, options);
  if (!bundleRecipient(verified.bundle, options.recipient.identity)) throw new Error('Invalid private bundle recipient');
  for (const copy of privateCopies(verified.view)) {
    const context = options.contexts.find(c => c.journey === copy.journey);
    if (!context || !privateAccess(context, copy.author, options.recipient)) throw new Error('Private bundle recipient outside audience');
  }
  return sealIdentity(canonical(verified.bundle), [options.recipient.identity.recipient]);
}
export async function importPrivateBundle(ciphertext: string, identity: AgeIdentity, options: PrivateBundleOptions & { recipient: PrivateIdentity }): Promise<{ bundle: PrivateBundle; view: PrivateView }> {
  if (!validatePrivateIdentity(options.recipient) || await deriveRecipient(identity) !== options.recipient.recipient) throw new Error('Private bundle recipient key mismatch');
  const parsed: unknown = JSON.parse(await openIdentity(ciphertext, [identity]));
  const verified = await verifyPrivateBundle(parsed, options);
  if (!bundleRecipient(verified.bundle, options.recipient)) throw new Error('Invalid private bundle recipient');
  if (!options.historical) {
    for (const copy of privateCopies(verified.view)) {
      const context = options.contexts?.find(c => c.journey === copy.journey), actor = options.sessions?.find(s => s.binding.journey === copy.journey && canonical(s.identity) === canonical(options.recipient));
      if (!context || !actor || !privateAccess(context, copy.author, actor)) throw new Error('Private import recipient outside audience');
    }
  }
  return verified;
}
