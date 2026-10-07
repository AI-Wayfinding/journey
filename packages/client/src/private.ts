import { canonical, artifactTypeHash, newId, newPrivateId, privateHash, privateAuthority, privateAuthorityHistory, privateCopies, privateAccess, privateAgentAudience, privateAgentSession, importSigningKey, selectPrivateCopies, signPrivateRecord, verifyPrivateBundle, exportPrivateBundle, importPrivateBundle, openPrivateBlob, privateSnapshotHash, privateDerivedKey, privateBlobAAD, privateBytesHash } from '@ai-wayfinding/core';
import type { PrivateBundle, PrivateCheckpoint, PrivateCopyState, PrivateIdentity, PrivateBlob, PrivateRecord, ProtocolRecord, JsonObject, VaultCacheRecord } from '@ai-wayfinding/core';
import { samePrivateContext } from './journey.js';
import type { JourneyClient } from './journey.js';
import { attachmentName, artifactPayload, localBytes, saveDownload, validateLocalAttachment } from './artifacts.js';
import type { ArtifactInput, LocalAttachment } from './artifacts.js';
import { NodePrivatePending } from './private-store.js';

export interface PrivateContent { title: string; tags: string[]; content: import('@ai-wayfinding/core').ArtifactContent; attachments: { blob: PrivateBlob; name: string; mime: string; path?: string }[] }
const identityJSON = (id: PrivateIdentity): JsonObject => ({ kind: id.kind, signingKey: id.signingKey, recipient: id.recipient });
const marker = (): ProtocolRecord => ({ type: 'artifact.tombstone', typeVersion: 1, body: {} });
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const decode = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

/** Explicit local workflows. Core alone verifies histories, audience and sync. */
export class PrivateArtifacts {
  private pending?: PrivateBundle;
  private store?: NodePrivatePending;
  private revision: string | null = null;
  private constructor(readonly client: JourneyClient, readonly vault: import('@ai-wayfinding/core').PrivateVault, readonly authority: Awaited<ReturnType<JourneyClient['privateAuthority']>>) {}
  static async open(client: JourneyClient, paired?: PrivateCheckpoint): Promise<PrivateArtifacts> {
    const authority = await client.privateAuthority();
    const value = new PrivateArtifacts(client, await client.openPrivateVault(paired), authority);
    if (client.privateCacheRoot) {
      value.store = new NodePrivatePending(client.privateCacheRoot, authority.vault, client.session.identity, authority.session.identity.recipient);
      const saved = await value.store.read(); value.revision = saved?.token ?? null;
      if (saved) {
        const checked = await value.verify(saved.bundle);
        const current = value.vault.branches;
        if (!current.some(b => canonical(b.bundle.records) === canonical(checked.bundle.records))) {
          await value.writer(); await value.vault.stage(checked.bundle); value.pending = checked.bundle;
        } else await value.clearPending();
      }
    }
    return value;
  }
  private trust() { return { vault: this.authority.vault, author: this.authority.author }; }
  private async verify(bundle: unknown) { return verifyPrivateBundle(bundle, { trust: this.trust(), historical: true }); }
  private bundle(): PrivateBundle {
    if (this.pending && this.vault.branches.some(b => canonical(b.bundle.records) === canonical(this.pending!.records))) this.pending = undefined;
    if (this.pending) return structuredClone(this.pending);
    if (this.vault.branches.length > 1) throw new Error('Private versions conflict; preserve both branches before editing');
    return this.vault.branches[0] ? structuredClone(this.vault.branches[0].bundle) : { format: 'private-v1', version: 1, vault: this.authority.vault, author: this.authority.author, scope: 'author-backup', authorityHistories: [], records: [], payloads: [], copyKeys: [], blobs: [], unavailableDeletedBlobs: [] };
  }
  async status() {
    this.bundle(); if (!this.pending) await this.clearPending();
    return { status: this.pending ? 'staged' : 'committed', freshness: this.vault.freshness, version: this.vault.retainedCheckpoint?.version ?? 0, warning: 'Server-backed encrypted vault. Saves wait for the next five-minute sync. Downloaded copies cannot be recalled. A server-only head has unverified freshness.' };
  }
  private async clearPending() { if (this.store && this.revision) { await this.store.clear(this.revision); this.revision = null; } }
  private async writer() {
    const live = await this.client.privateAuthority();
    if (!samePrivateContext(live.context, this.authority.context) || !privateAccess(live.context, this.authority.author, live.session, true)) throw new Error('Private write authority changed or denied; reopen');
  }
  private async stage(bundle: PrivateBundle) {
    await this.writer(); const checked = await this.verify(bundle);
    await this.vault.stage(checked.bundle);
    if (this.store) this.revision = await this.store.write(this.revision, checked.bundle);
    this.pending = checked.bundle;
  }
  async list(selector = 'main') {
    const live = await this.client.privateAuthority();
    const checked = await this.verify(this.bundle());
    return selectPrivateCopies(checked.view, live.context, live.session, selector);
  }
  private async copy(id: string): Promise<PrivateCopyState> { const copy = (await this.list('all')).find(c => c.copy === id); if (!copy) throw new Error('Private copy unavailable'); return copy; }
  async show(id: string) {
    const copy = await this.copy(id), content = this.content(copy);
    return { copy, content, ...(await this.status()) };
  }
  private content(copy: PrivateCopyState): PrivateContent {
    const record = copy.records.find(r => r.body.version === copy.head)!;
    // SAFETY: core projected the exact artifact.content and private descriptors.
    return structuredClone(copy.payloads.find(p => p.record === record.id)!.payload.body) as unknown as PrivateContent;
  }
  private async append(bundle: PrivateBundle, type: PrivateRecord['type'], copy: string, artifact: string, author: PrivateIdentity, payload: ProtocolRecord, fields: JsonObject) {
    await this.writer(); const old = bundle.records.filter(r => r.copy === copy), actor = this.authority.session.identity;
    const record = await signPrivateRecord({ format: 'private-v1', v: 1, id: newId(), vault: this.authority.vault, copy, seq: old.length, prev: old.length ? await privateHash(old.at(-1)!) : null, at: new Date().toISOString(), actor, authority: privateAuthority(this.authority.context, actor), type, body: { artifact, author: identityJSON(author), actor: identityJSON(actor), ...fields }, payloadHash: await privateHash(payload) }, this.authority.signingKey);
    bundle.authorityHistories.push(privateAuthorityHistory(this.authority.context));
    bundle.authorityHistories = bundle.authorityHistories.filter((h, i, all) => all.findIndex(x => canonical(x) === canonical(h)) === i);
    bundle.records.push(record); bundle.payloads.push({ record: record.id, payload }); await this.stage(bundle);
  }
  private async file(bundle: PrivateBundle, copy: string, file: LocalAttachment) {
    validateLocalAttachment(file); const bytes = await localBytes(file.path);
    try { return await this.encryptFile(bundle, copy, bytes, attachmentName(file), file.mime ?? 'application/octet-stream', file.packagePath); }
    finally { bytes.fill(0); }
  }
  private async encryptFile(bundle: PrivateBundle, copy: string, bytes: Uint8Array, name: string, mime: string, path?: string) {
    const key = decode(bundle.copyKeys.find(k => k.copy === copy)!.key), nonce = crypto.getRandomValues(new Uint8Array(12));
    try {
      const blob: PrivateBlob = { v: 1, vault: this.authority.vault, copy, id: newPrivateId(), generation: bundle.records.filter(r => r.copy === copy).length + 1, size: bytes.length, ciphertextSize: bytes.length + 16, nonce: encode(nonce), digest: '', contentHash: await privateBytesHash(bytes) };
      const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(nonce), additionalData: new Uint8Array(privateBlobAAD(blob)) }, await privateDerivedKey(key, blob.vault, copy, 'blob'), new Uint8Array(bytes)));
      blob.digest = await privateBytesHash(cipher); bundle.blobs.push({ descriptor: blob, ciphertext: encode(cipher) });
      return { blob, name, mime, ...(path === undefined ? {} : { path }) };
    } finally { key.fill(0); }
  }
  async save(input: ArtifactInput, id?: string, predecessor?: string) {
    await this.writer(); const previous = id ? await this.copy(id) : undefined;
    const bundle = this.bundle(), copy = previous?.copy ?? newPrivateId(), artifact = previous?.artifact ?? newPrivateId();
    if (!previous) bundle.copyKeys.push({ copy, key: encode(crypto.getRandomValues(new Uint8Array(32))) });
    const attachments = input.files === undefined && previous ? this.content(previous).attachments : [];
    for (const file of input.files ?? []) attachments.push(await this.file(bundle, copy, file));
    // Existing artifact payload validation owns content/type/limit checks. Private
    // descriptors have a different wire schema and are validated by core below.
    const sharedShape = attachments.map(a => ({ blob: { v: 1 as const, journey: this.authority.context.journey, id: newId(), epoch: 1, size: a.blob.size, ciphertextSize: a.blob.ciphertextSize, nonce: a.blob.nonce, digest: a.blob.digest }, name: a.name, mime: a.mime, ...(a.path === undefined ? {} : { path: a.path }) }));
    const ordinary = artifactPayload(input, sharedShape), content = ordinary.content;
    if ('primary' in content) content.primary = attachments[0]!.blob.id;
    const payload: ProtocolRecord = { type: 'artifact.content', typeVersion: 1, body: { title: ordinary.title, tags: ordinary.tags, content, attachments } };
    await this.append(bundle, previous ? 'private.version' : 'private.create', copy, artifact, previous?.author ?? this.authority.session.identity, payload, { version: newId(), typeHash: await artifactTypeHash(content.kind), blobs: attachments.map(a => a.blob), predecessor: previous ? predecessor! : null });
    return { id: copy, ...(await this.status()) };
  }
  async comment(id: string, text: string, onVersion?: string) { const c = await this.copy(id); await this.append(this.bundle(), 'private.comment', id, c.artifact, c.author, { type: 'artifact.comment-content', typeVersion: 1, body: { text } }, { comment: newId(), ...(onVersion ? { onVersion } : {}) }); return this.status(); }
  async project(id: string, project: string | null, predecessor: string | null) { const c = await this.copy(id); await this.append(this.bundle(), 'private.project', id, c.artifact, c.author, marker(), { project, predecessor }); return this.status(); }
  async delete(id: string, predecessor: string) {
    const c = await this.copy(id), bundle = this.bundle(), blobs = new Set(c.records.flatMap(r => (r.body.blobs as PrivateBlob[] | undefined) ?? []).map(b => b.id));
    bundle.blobs = bundle.blobs.filter(b => !blobs.has(b.descriptor.id)); bundle.unavailableDeletedBlobs = [...new Set([...bundle.unavailableDeletedBlobs, ...blobs])].sort();
    await this.append(bundle, 'private.delete', id, c.artifact, c.author, marker(), { predecessor }); return this.status();
  }
  async download(id: string, blob: string, path: string) {
    await this.copy(id); const bundle = this.bundle(), row = bundle.blobs.find(b => b.descriptor.copy === id && b.descriptor.id === blob);
    if (!row) throw new Error('Private attachment unavailable');
    const bytes = await openPrivateBlob(row.descriptor, row.ciphertext, decode(bundle.copyKeys.find(k => k.copy === id)!.key));
    try { await saveDownload(path, bytes); return { path, bytes: bytes.length }; } finally { bytes.fill(0); }
  }
  async backup(path: string, scope: PrivateBundle['scope'] = 'author-backup', target?: JourneyClient) {
    await this.writer(); const bundle = this.bundle(); bundle.scope = scope;
    let recipient = this.authority.session;
    if (target) {
      const admitted = await target.privateAuthority();
      if (!samePrivateContext(admitted.context, this.authority.context) || !privateAgentAudience(this.authority.context, this.authority.author, admitted.session.identity)) throw new Error('Private recipient outside person audience');
      recipient = await privateAgentSession(this.authority.context, admitted.session.identity, await importSigningKey(target.session.signingPrivateKey), target.session.identity, 'authenticated');
    }
    if (scope === 'agent-handoff' && !target) throw new Error('Handoff requires separately approved local state');
    const ciphertext = await exportPrivateBundle(bundle, { trust: this.trust(), contexts: [this.authority.context], sessions: [this.authority.session], recipient });
    await saveDownload(path, new TextEncoder().encode(ciphertext)); return { path, ...(await this.status()) };
  }
  async import(path: string) {
    await this.writer(); const bytes = await localBytes(path);
    try {
      const checked = await importPrivateBundle(new TextDecoder('utf-8', { fatal: true }).decode(bytes), this.client.session.identity, { trust: this.trust(), recipient: this.authority.session.identity, contexts: [this.authority.context], sessions: [this.authority.session] });
      await this.stage(checked.bundle); return this.status();
    } finally { bytes.fill(0); }
  }
  async copyTo(id: string, predecessor: string, destination: PrivateArtifacts) {
    await this.writer(); await destination.writer(); const selected = await this.copy(id);
    if (canonical(selected.head) !== canonical(predecessor) || canonical(this.authority.author) !== canonical(destination.authority.author) || canonical(this.authority.session.identity) !== canonical(destination.authority.session.identity)) throw new Error('Private copy binding or predecessor conflict');
    const source = this.bundle(), bundle = destination.bundle(), copy = newPrivateId(), content = this.content(selected);
    bundle.copyKeys.push({ copy, key: encode(crypto.getRandomValues(new Uint8Array(32))) });
    bundle.sourceHistories = [...(bundle.sourceHistories ?? []), ...(source.sourceHistories ?? []), { vault: this.authority.vault, records: selected.records, payloads: selected.payloads }];
    bundle.authorityHistories.push(...source.authorityHistories);
    const attachments: PrivateContent['attachments'] = [];
    for (const a of content.attachments) {
      const row = source.blobs.find(b => b.descriptor.id === a.blob.id)!;
      const bytes = await openPrivateBlob(row.descriptor, row.ciphertext, decode(source.copyKeys.find(k => k.copy === id)!.key));
      try { attachments.push(await destination.encryptFile(bundle, copy, bytes, a.name, a.mime, a.path)); } finally { bytes.fill(0); }
    }
    if ('primary' in content.content) content.content.primary = attachments[content.attachments.findIndex(a => a.blob.id === (content.content as { primary: string }).primary)]!.blob.id;
    const sourceRecord = selected.records.find(r => r.body.version === selected.head)!;
    await destination.append(bundle, 'private.copy', copy, selected.artifact, selected.author, { type: 'artifact.content', typeVersion: 1, body: { title: content.title, tags: content.tags, content: content.content, attachments } }, { version: newId(), typeHash: selected.typeHash, blobs: attachments.map(a => a.blob), predecessor: null, destination: { journey: destination.authority.context.journey, copy }, origin: { journey: selected.journey, copy: selected.copy, artifact: selected.artifact, version: selected.head, recordHash: await privateHash(sourceRecord) }, snapshotHash: await privateSnapshotHash(selected.payloads.find(p => p.record === sourceRecord.id)!.payload) });
    return { id: copy, ...(await destination.status()) };
  }
  async checkpoint(path: string) { const checkpoint = this.vault.retainedCheckpoint; if (!checkpoint) throw new Error('Private checkpoint unavailable'); await saveDownload(path, new TextEncoder().encode(canonical(checkpoint))); return { path }; }
  async merge(value: VaultCacheRecord) { await this.writer(); const result = await this.vault.merge(value); return { conflicts: result.filter(c => c.branches.length > 1).map(c => c.copy), status: 'staged' }; }
}
