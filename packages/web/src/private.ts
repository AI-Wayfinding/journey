import { artifactTypeHash, canonical, newId, newPrivateId, privateIdentity, memberVaultId, privateAuthority, privateAuthorityHistory, privateHash, privateSnapshotHash, privateBytesHash, privateDerivedKey, privateBlobAAD, privateCopies, privateAccess, privatePersonSession, verifyPrivateContext, signPrivateRecord, verifyPrivateBundle, selectPrivateCopies, openPrivateBlob, exportPrivateBundle, importPrivateBundle, MAX_BLOB_BYTES, createPrivateChallenge, authenticatePrivateAgent } from '@ai-wayfinding/core';
import type { ArtifactContent, PrivateBlob, PrivateBundle, PrivateContext, PrivateSession, PrivateCopyState, PrivateRecord, PrivateView, JsonObject, ProtocolRecord, PrivateVault, PrivateCheckpoint, PrivateChallenge, VaultCacheRecord, PrivateIdentity } from '@ai-wayfinding/core';
import type { JourneyContext } from './journey.js';
import { api, currentKey, verifiedJourney } from './journey.js';
import { openJourneyVault, rememberPrivateVault } from './private-store.js';

export interface PrivateAttachment { blob: PrivateBlob; name: string; mime: string; path?: string }
export interface PrivateContent { title: string; tags: string[]; content: ArtifactContent; attachments: PrivateAttachment[] }
const encode = (bytes: Uint8Array): string => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); };
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const jsonIdentity = (identity: PrivateSession['identity']): JsonObject => ({ kind: identity.kind, signingKey: identity.signingKey, recipient: identity.recipient });
const marker = (): ProtocolRecord => ({ type: 'artifact.tombstone', typeVersion: 1, body: {} });

const workflows = new Map<string, BrowserPrivateArtifacts>();
/** Person-only browser proposals. Signed authority and lifecycle decisions stay in core/Bend.
 * A save stages encrypted chunks; only the vault's fixed timer writes them. */
export class BrowserPrivateArtifacts {
  private pending: PrivateBundle | undefined;
  private active = true;
  private baseVersion = 0;
  private mergePending = false;
  private challenges = new Set<import('@ai-wayfinding/core').PrivateChallenge>();
  private contexts: PrivateContext[];
  private constructor(readonly ctx: JourneyContext, readonly vault: PrivateVault, readonly context: PrivateContext, readonly session: PrivateSession, readonly vaultId: string) { this.contexts = [context]; rememberPrivateVault(this); workflows.set(ctx.id, this); }
  static async open(ctx: JourneyContext, paired?: PrivateCheckpoint): Promise<BrowserPrivateArtifacts> {
    const existing = workflows.get(ctx.id);
    if (!paired && existing?.active && existing.ctx.principal === ctx.principal && existing.ctx.state.lastHash === ctx.state.lastHash) return existing;
    existing?.close();
    const context = await verifyPrivateContext({ journey: ctx.id, creator: ctx.controls[0]!.proof.body.creator as import('@ai-wayfinding/core').Member, controls: ctx.controls }, { now: Date.now(), currentHead: ctx.state.lastHash! });
    const identity = privateIdentity(ctx.state.members[ctx.principal]!.member);
    const session = await privatePersonSession(context, identity, ctx.keys.signingPrivateKey, ctx.keys.identity);
    return new BrowserPrivateArtifacts(ctx, await openJourneyVault(ctx, paired), context, session, await memberVaultId(ctx.id, ctx.principal, identity.signingKey, identity.recipient));
  }
  close(): void { this.active = false; this.pending = undefined; this.contexts = []; this.challenges.clear(); workflows.delete(this.ctx.id); }
  private assertOpen(): void { if (!this.active) throw new Error('Private artifacts are locked'); currentKey(this.ctx); }
  get saveStatus(): 'pending' | 'committed' {
    this.assertOpen();
    if (this.pending && this.vault.branches.some(b => canonical(b.bundle.records) === canonical(this.pending!.records))) this.pending = undefined;
    if (this.mergePending && (this.vault.retainedCheckpoint?.version ?? 0) > this.baseVersion) this.mergePending = false;
    return this.pending || this.mergePending ? 'pending' : 'committed';
  }
  private bundle(): PrivateBundle {
    this.assertOpen(); void this.saveStatus;
    if (this.pending) return structuredClone(this.pending);
    const branches = this.vault.branches;
    if (branches.length > 1) throw new Error('Private versions conflict. Keep both branches and merge verified histories before editing.');
    return branches[0] ? structuredClone(branches[0].bundle) : { format: 'private-v1', version: 1, vault: this.vaultId, author: this.session.identity, scope: 'author-backup', authorityHistories: [], records: [], payloads: [], copyKeys: [], blobs: [], unavailableDeletedBlobs: [] };
  }
  private async verified(bundle = this.bundle()): Promise<{ bundle: PrivateBundle; view: PrivateView }> { return verifyPrivateBundle(bundle, { trust: { vault: this.vaultId, author: this.session.identity }, historical: true }); }
  async copies(selector = 'main'): Promise<PrivateCopyState[]> { this.assertOpen(); const checked = await this.verified(); this.assertOpen(); return selectPrivateCopies(checked.view, this.context, this.session, selector); }
  async allBranches(): Promise<PrivateCopyState[][]> { this.assertOpen(); return this.vault.branches.map(b => selectPrivateCopies(b.view, this.context, this.session, 'all')); }
  async content(copy: PrivateCopyState, version = copy.head): Promise<PrivateContent> {
    const current = (await this.copies('all')).find(c => c.copy === copy.copy); if (!current) throw new Error('Private copy unavailable');
    const record = current.records.find(r => r.body.version === version); if (!record) throw new Error('Private version unavailable');
    // SAFETY: core validated and projected this artifact.content body and private attachment descriptors.
    return structuredClone(current.payloads.find(p => p.record === record.id)!.payload.body) as unknown as PrivateContent;
  }
  private async writer(): Promise<void> {
    this.assertOpen(); const latest = await verifiedJourney(this.ctx.id, this.ctx.principal, this.ctx.keys); this.assertOpen();
    if (latest.state.lastHash !== this.ctx.state.lastHash) throw new Error('Journey authority changed. Reload before saving.');
    const fresh = await verifyPrivateContext(privateAuthorityHistory(this.context), { now: Date.now(), currentHead: latest.state.lastHash! });
    const session = await privatePersonSession(fresh, this.session.identity, this.ctx.keys.signingPrivateKey, this.ctx.keys.identity);
    if (!privateAccess(fresh, this.session.identity, session, true)) throw new Error('Private write authority denied');
  }
  private async stage(bundle: PrivateBundle): Promise<void> { const checked = await this.verified(bundle); this.assertOpen(); await this.vault.stage(checked.bundle); this.assertOpen(); this.baseVersion = this.vault.retainedCheckpoint?.version ?? 0; this.pending = checked.bundle; }
  private async append(bundle: PrivateBundle, type: PrivateRecord['type'], copy: string, artifact: string, payload: ProtocolRecord, fields: JsonObject): Promise<void> {
    await this.writer(); const old = bundle.records.filter(r => r.copy === copy);
    const record = await signPrivateRecord({ format: 'private-v1', v: 1, id: newId(), vault: this.vaultId, copy, seq: old.length, prev: old.length ? await privateHash(old.at(-1)!) : null, at: new Date().toISOString(), actor: this.session.identity, authority: privateAuthority(this.context, this.session.identity), type, body: { artifact, author: jsonIdentity(this.session.identity), actor: jsonIdentity(this.session.identity), ...fields }, payloadHash: await privateHash(payload) }, this.ctx.keys.signingPrivateKey);
    bundle.authorityHistories.push(privateAuthorityHistory(this.context));
    bundle.authorityHistories = bundle.authorityHistories.filter((h, i, all) => all.findIndex(x => canonical(x) === canonical(h)) === i);
    bundle.records.push(record); bundle.payloads.push({ record: record.id, payload }); await this.stage(bundle);
  }
  async save(content: PrivateContent, previous?: PrivateCopyState): Promise<string> {
    const bundle = this.bundle(), copy = previous?.copy ?? newPrivateId(), artifact = previous?.artifact ?? newPrivateId();
    if (!previous) bundle.copyKeys.push({ copy, key: encode(crypto.getRandomValues(new Uint8Array(32))) });
    await this.append(bundle, previous ? 'private.version' : 'private.create', copy, artifact, { type: 'artifact.content', typeVersion: 1, body: { title: content.title, tags: content.tags, content: content.content, attachments: content.attachments.map(a => ({ blob: a.blob, name: a.name, mime: a.mime, ...(a.path === undefined ? {} : { path: a.path }) })) } }, { version: newId(), typeHash: await artifactTypeHash(content.content.kind), blobs: content.attachments.map(a => a.blob), predecessor: previous?.head ?? null }); return copy;
  }
  async comment(copy: PrivateCopyState, text: string): Promise<void> { await this.append(this.bundle(), 'private.comment', copy.copy, copy.artifact, { type: 'artifact.comment-content', typeVersion: 1, body: { text } }, { comment: newId(), onVersion: copy.head }); }
  async place(copy: PrivateCopyState, project: string | null): Promise<void> { await this.append(this.bundle(), 'private.project', copy.copy, copy.artifact, marker(), { project, predecessor: copy.placement }); }
  async delete(copy: PrivateCopyState): Promise<void> {
    const bundle = this.bundle(), ids = copy.records.flatMap(r => (r.body.blobs as PrivateBlob[] | undefined) ?? []).map(b => b.id);
    bundle.blobs = bundle.blobs.filter(b => !ids.includes(b.descriptor.id)); bundle.unavailableDeletedBlobs = [...new Set([...bundle.unavailableDeletedBlobs, ...ids])].sort();
    await this.append(bundle, 'private.delete', copy.copy, copy.artifact, marker(), { predecessor: copy.head });
  }
  async attachment(copy: PrivateCopyState, attachment: PrivateAttachment): Promise<Uint8Array> {
    const checked = await this.verified(), current = privateCopies(checked.view).find(c => c.copy === copy.copy && !c.deleted);
    if (!current || !privateAccess(this.context, current.author, this.session)) throw new Error('Private attachment unavailable');
    const row = checked.bundle.blobs.find(b => b.descriptor.id === attachment.blob.id);
    if (!row || canonical(row.descriptor) !== canonical(attachment.blob)) throw new Error('Private attachment mismatch');
    const bytes = await openPrivateBlob(row.descriptor, row.ciphertext, decode(checked.bundle.copyKeys.find(k => k.copy === copy.copy)!.key)); this.assertOpen(); return bytes;
  }
  private async encryptFile(bundle: PrivateBundle, copy: string, file: File, path?: string): Promise<PrivateAttachment> {
    if (file.size > MAX_BLOB_BYTES) throw new Error('Files can be at most 25,000,000 bytes (25 MB).');
    const bytes = new Uint8Array(await file.arrayBuffer()), key = decode(bundle.copyKeys.find(k => k.copy === copy)!.key), nonce = crypto.getRandomValues(new Uint8Array(12));
    try {
      const blob: PrivateBlob = { v: 1, vault: this.vaultId, copy, id: newPrivateId(), generation: bundle.records.filter(r => r.copy === copy).length + 1, size: bytes.length, ciphertextSize: bytes.length + 16, nonce: encode(nonce), digest: '', contentHash: await privateBytesHash(bytes) };
      const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(nonce), additionalData: new Uint8Array(privateBlobAAD(blob)) }, await privateDerivedKey(key, this.vaultId, copy, 'blob'), new Uint8Array(bytes)));
      this.assertOpen(); blob.digest = await privateBytesHash(cipher); bundle.blobs.push({ descriptor: blob, ciphertext: encode(cipher) });
      return { blob, name: file.name, mime: file.type || 'application/octet-stream', ...(path === undefined ? {} : { path }) };
    } finally { bytes.fill(0); key.fill(0); }
  }
  async saveWithFiles(content: PrivateContent, files: { file: File; path?: string }[], previous?: PrivateCopyState): Promise<string> {
    await this.writer();
    const bundle = this.bundle(), copy = previous?.copy ?? newPrivateId(), artifact = previous?.artifact ?? newPrivateId();
    if (!previous) bundle.copyKeys.push({ copy, key: encode(crypto.getRandomValues(new Uint8Array(32))) });
    const attachments = content.attachments.map(a => ({ blob: a.blob, name: a.name, mime: a.mime, ...(a.path === undefined ? {} : { path: a.path }) }));
    for (const row of files) attachments.push(await this.encryptFile(bundle, copy, row.file, row.path));
    const c = content.content;
    const adjusted = 'primary' in c ? { ...c, primary: attachments[0]?.blob.id ?? c.primary } : c;
    await this.append(bundle, previous ? 'private.version' : 'private.create', copy, artifact, { type: 'artifact.content', typeVersion: 1, body: { title: content.title, tags: content.tags, content: adjusted, attachments } }, { version: newId(), typeHash: await artifactTypeHash(c.kind), blobs: attachments.map(a => a.blob), predecessor: previous?.head ?? null }); return copy;
  }
  async saveFile(title: string, file: File, previous?: PrivateCopyState): Promise<string> {
    return this.saveWithFiles({ title, tags: [], content: { kind: 'file', primary: newPrivateId() }, attachments: [] }, [{ file }], previous);
  }
  /** A new destination copy carries a complete independently signed source history.
   * No journey keys, source ciphertext, placement or mutable source handle is reused. */
  async copyTo(copy: PrivateCopyState, destination: BrowserPrivateArtifacts): Promise<string> {
    await this.writer(); await destination.writer();
    if (canonical(this.session.identity) !== canonical(destination.session.identity)) throw new Error('Private copy author keys differ');
    const source = await this.verified(), selected = privateCopies(source.view).find(c => c.copy === copy.copy && !c.deleted);
    if (!selected || canonical(selected.records) !== canonical(copy.records)) throw new Error('Private copy source snapshot changed');
    const content = await this.content(selected);
    const bundle = destination.bundle(), id = newPrivateId();
    bundle.copyKeys.push({ copy: id, key: encode(crypto.getRandomValues(new Uint8Array(32))) });
    bundle.sourceHistories = [...(bundle.sourceHistories ?? []), ...(source.bundle.sourceHistories ?? []), { vault: this.vaultId, records: selected.records, payloads: selected.payloads }];
    bundle.authorityHistories.push(...source.bundle.authorityHistories);
    destination.contexts = [...destination.contexts, this.context];
    const attachments: PrivateAttachment[] = [];
    for (const a of content.attachments) {
      const bytes = await this.attachment(selected, a);
      try { attachments.push(await destination.encryptFile(bundle, id, new File([new Uint8Array(bytes)], a.name, { type: a.mime }), a.path)); } finally { bytes.fill(0); }
    }
    const c = content.content;
    const adjusted = 'primary' in c ? { ...c, primary: attachments[content.attachments.findIndex(a => a.blob.id === c.primary)]!.blob.id } : c;
    await destination.append(bundle, 'private.copy', id, selected.artifact, { type: 'artifact.content', typeVersion: 1, body: { title: content.title, tags: content.tags, content: adjusted, attachments: attachments.map(a => ({ blob: a.blob, name: a.name, mime: a.mime, ...(a.path === undefined ? {} : { path: a.path }) })) } }, { version: newId(), typeHash: selected.typeHash, blobs: attachments.map(a => a.blob), predecessor: null, destination: { journey: destination.ctx.id, copy: id }, origin: { journey: selected.journey, copy: selected.copy, artifact: selected.artifact, version: selected.head, recordHash: await privateHash(selected.records.find(r => r.body.version === selected.head)!) }, snapshotHash: await privateSnapshotHash(selected.payloads.find(p => p.record === selected.records.find(r => r.body.version === selected.head)!.id)!.payload) }); return id;
  }
  async merge(other: VaultCacheRecord): Promise<void> {
    await this.writer(); this.baseVersion = this.vault.retainedCheckpoint?.version ?? 0;
    await this.vault.merge(other); this.pending = undefined; this.mergePending = true;
  }
  async challenge(principal: string): Promise<PrivateChallenge> {
    await this.writer();
    const eligible = await api<{ agents: { principal: string }[] }>(`/journeys/${this.ctx.id}/private-agents`, 'GET', undefined, this.ctx.principal);
    const member = this.ctx.state.members[principal]?.member;
    if (!member || member.kind !== 'agent' || !eligible.agents.some(a => a.principal === principal)) throw new Error('Authenticated own agent required');
    const challenge = await createPrivateChallenge(this.context, this.session, privateIdentity(member)); this.assertOpen(); this.challenges.add(challenge); return challenge;
  }
  async handoff(challenge: PrivateChallenge, response: { sig: string; opened: string }): Promise<string> {
    await this.writer();
    if (!this.challenges.delete(challenge)) throw new Error('Unknown or consumed private challenge');
    const agent = await authenticatePrivateAgent(challenge, response, 'authenticated');
    const bundle = this.bundle(); bundle.scope = 'agent-handoff';
    const ciphertext = await exportPrivateBundle(bundle, { trust: { vault: this.vaultId, author: this.session.identity }, contexts: [this.context], sessions: [this.session, agent], recipient: agent });
    this.assertOpen(); return ciphertext;
  }
  /** The agent reads scoped content; the person reviews and signs the returned result. */
  async recordResult(content: PrivateContent, previous?: PrivateCopyState): Promise<string> { return this.save(content, previous); }
  async backup(): Promise<string> { await this.writer(); const ciphertext = await exportPrivateBundle(this.bundle(), { trust: { vault: this.vaultId, author: this.session.identity }, contexts: this.contexts, recipient: this.session, historical: true }); this.assertOpen(); return ciphertext; }
  async restore(ciphertext: string): Promise<void> {
    await this.writer(); const checked = await importPrivateBundle(ciphertext, this.ctx.keys.identity, { trust: { vault: this.vaultId, author: this.session.identity }, recipient: this.session.identity, historical: true });
    const current = privateCopies((await this.verified()).view), incoming = privateCopies(checked.view);
    for (const old of current) { const next = incoming.find(c => c.copy === old.copy); if (!next || canonical(next.records.slice(0, old.records.length)) !== canonical(old.records)) throw new Error('Stale private backup replacement'); }
    await this.stage(checked.bundle);
  }
}
