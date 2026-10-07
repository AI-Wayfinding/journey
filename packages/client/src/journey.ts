import { canWriteContent, canReadContent, effectiveScope } from '@ai-wayfinding/core';
import { PrivateVault, decodeVaultWire, encodeVaultPatch, memberVaultId, privateIdentity, privateAgentSession, verifyPrivateContext, openVaultAgentWrap, privateAccess, privateAgentAudience, sealVaultAgentWrap, privateVaultOwner, privateBinding, stage0Rules } from '@ai-wayfinding/core';
import { PROJECT_FORMAT, projectPurposeHash, replayProject, sealProjectPayload, effectiveProjectParticipants, selectProjectArtifacts, projectSelector } from '@ai-wayfinding/core';
import type { ProjectActionType } from '@ai-wayfinding/core';
import { projectId, observedRevision, purposeText, stateValue } from './projects.js';
import type { ProjectView } from './projects.js';
import { CLIENT_VERSION, meetsMinClientVersion, createAgeIdentity, newId, unwrapJourneyKey, verifyControlProofs, controlDefinitions, ARTIFACT_FORMAT, artifactTypeHash, canonical, readArtifactPayload, sealArtifactPayload, sealBlob, openBlob, signControlProof, importSigningKey, replayArtifact } from '@ai-wayfinding/core';
import type { VaultOptions, VaultTransport, PrivateCheckpoint, PrivateContext, ControlProof, Member, Envelope, JourneyKey, LogState, ArtifactActionType, ArtifactAttachment, ArtifactPayload, JsonObject } from '@ai-wayfinding/core';
import { artifactPayload, artifactText, attachmentName, localBytes, saveDownload, skillPackage, validateLocalAttachment } from './artifacts.js';
import type { ArtifactInput, ArtifactItem, ArtifactView, ArtifactComment, LocalAttachment } from './artifacts.js';
import { readCache, writeCache } from './cache.js';
import type { CipherRow } from './cache.js';
import { signedHeaders } from './signing.js';
import { networkFetch } from './network.js';
import type { RememberedAgent } from './storage.js';
import { NodePrivateStore, rememberNodePrivateVault } from './private-store.js';

/** ID-only adapter to the production snapshot rule, not host authority logic. */
export function samePrivateContext(left: PrivateContext, right: PrivateContext): boolean {
  const ids = [...new Set([left.journey, left.head, right.journey, right.head])];
  const id = (value: string) => BigInt(ids.indexOf(value));
  return stage0Rules.private_authority_snapshot(id(left.journey), id(left.head), id(right.journey), id(right.head));
}
export type AddInput = ArtifactInput;
export interface JourneyOptions { fetch?: typeof fetch; cacheRoot?: string; privateNow?: () => number; privateRandomOrder?: () => number[]; privateManualSchedule?: boolean; privateSchedule?: (tick: () => Promise<boolean>) => () => void }
export interface ItemView { item: ArtifactItem; comments: ArtifactComment[]; versions: ArtifactView['versions'] }
interface Verified { state: LogState; epochs: Map<number, JourneyKey>; log: CipherRow[] }
const historyError = 'This journey history could not be verified. Stop and ask a member for help.';
const updateError = () => `This journey uses a newer format than this Wayfinding client (${CLIENT_VERSION}) understands. Nothing is wrong with the journey or your access. Update the client, then try again:\n  npm install -g @ai-wayfinding/client@latest\n(If you installed it with --prefix "$HOME/.npm-global", add that same --prefix.) Your connection stays valid, so you do not need to connect or be approved again.\nIf you cannot install software here, stop and tell your operator (the person you work for) that the Wayfinding client needs updating, show them the command above, and ask them to run it or allow the update.`;

export class JourneyClient {
  private readonly fetcher: typeof fetch;
  private readonly keys = new Map<number, JourneyKey>();
  constructor(readonly session: RememberedAgent, private readonly options: JourneyOptions = {}) { this.fetcher = options.fetch ?? networkFetch; }
  private async response(path: string, method = 'GET', data?: Record<string, unknown> | Uint8Array, extra: Record<string, string> = {}, allowMissing = false): Promise<Response> {
    if (this.session.expiresAt <= Date.now()) throw new Error('Your journey agent access has expired. Connect again.');
    const binary = data instanceof Uint8Array;
    const body = binary ? new Uint8Array(data) : data === undefined ? '' : JSON.stringify(data);
    const route = '/v1' + path;
    const headers = await signedHeaders(this.session.signingPrivateKey, method, route, body);
    const result = await this.fetcher(this.session.server + route, { method, headers: { ...headers, 'X-Client-Version': CLIENT_VERSION, 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': ARTIFACT_FORMAT, 'X-Project-Format': 'project-v1', 'X-Private-Format': 'private-v1', 'X-Agent-Session': this.session.sessionId, ...(data === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json', Origin: new URL(this.session.server).origin, 'X-Wayfinding': '1' }), ...extra }, ...(data === undefined ? {} : { body }) });
    if (allowMissing && result.status === 404) return result;
    if (!result.ok) {
      const error = await result.json().catch(() => null) as { error?: { code?: string } } | null;
      const code = error?.error?.code ?? String(result.status);
      if (code === 'client-too-old') throw new Error(updateError());
      if (result.status === 403 || result.status === 401) throw new Error('Access to this journey has ended');
      if (result.status === 409) throw new Error('Journey conflict: something changed. Reload and try again.');
      throw new Error('Journey request failed (' + code + ').');
    }
    return result;
  }
  private async request<T>(path: string, method = 'GET', data?: Record<string, unknown>): Promise<T> { return (await this.response(path, method, data)).json() as Promise<T>; }
  private async verified(): Promise<Verified> {
    const protocol = await this.request<{ minClientVersion: string; controlFormat: string; artifactFormat?: string; projectFormat?: string; privateFormat?: string }>(`/journeys/${this.session.journeyId}/protocol`);
    if ((protocol.privateFormat !== undefined && protocol.privateFormat !== 'private-v1') || (protocol.projectFormat !== undefined && protocol.projectFormat !== 'project-v1') || protocol.controlFormat !== 'control-proof-v1' || (protocol.artifactFormat !== undefined && protocol.artifactFormat !== ARTIFACT_FORMAT) || !meetsMinClientVersion(CLIENT_VERSION, protocol.minClientVersion)) throw new Error(updateError());
    const cached = this.options.cacheRoot ? await readCache(this.options.cacheRoot, this.session.journeyId).catch(() => null) : null;
    // Fetch all public proofs. A legacy cache is never a Stage 0 trust anchor.
    const rows: { seq: number; proof: ControlProof; envelope: Envelope }[] = [];
    for (;;) {
      const after = rows.length ? '?after=' + rows.at(-1)!.seq : '';
      const page = (await this.request<{ log: typeof rows }>(`/journeys/${this.session.journeyId}/log${after}`)).log;
      if (!Array.isArray(page)) throw new Error(historyError);
      rows.push(...page);
      if (rows.length > 100_000) throw new Error('Journey history is too large.');
      if (page.length < 1000) break;
    }
    if (!rows.length || rows.some(row => !row.proof || !row.envelope || row.seq !== row.proof.seq)) throw new Error(historyError);
    if (rows.some(row => row.proof.v !== 1 || !controlDefinitions.some(d => d.name === row.proof.type))) throw new Error(updateError());
    const log: CipherRow[] = rows.map(row => ({ seq: row.seq, entry: Buffer.from(JSON.stringify({ proof: row.proof, envelope: row.envelope })).toString('base64url') }));
    const response = await this.request<{ wraps: { epoch: number; wrap: string }[] }>(`/journeys/${this.session.journeyId}/wraps/me`);
    const epochs = new Map<number, JourneyKey>();
    for (const wrap of response.wraps) {
      if (!Number.isSafeInteger(wrap.epoch) || wrap.epoch < 1) throw new Error(historyError);
      const key = this.keys.get(wrap.epoch) ?? await unwrapJourneyKey({ epoch: wrap.epoch, recipient: this.session.principal, ciphertext: wrap.wrap }, this.session.identity);
      this.keys.set(wrap.epoch, key); epochs.set(wrap.epoch, key);
    }
    const checked = await verifyControlProofs(rows.map(row => row.proof), rows.map(row => row.envelope), { journey: this.session.journeyId, creator: rows[0]!.proof.body.creator as Member }, [...epochs.values()]);
    if (!checked.ok || checked.state.journey !== this.session.journeyId) throw new Error(historyError);
    const mine = checked.state.members[this.session.principal]?.member;
    if (!mine || mine.kind !== 'agent' || mine.signingKey !== this.session.signingKey || mine.recipient !== this.session.recipient) throw new Error('Access to this journey has ended');
    if (!canReadContent(checked.state, this.session.principal)) throw new Error('Access to this journey has ended');
    if (!meetsMinClientVersion(CLIENT_VERSION, checked.state.minClientVersion)) throw new Error(updateError());
    if (!epochs.has(checked.state.currentEpoch)) throw new Error('The journey key changed. Ask a member to reconnect this agent.');
    if (this.options.cacheRoot && (!cached || cached.seq !== checked.state.lastSeq || cached.hash !== checked.state.lastHash)) await writeCache(this.options.cacheRoot, this.session.journeyId, { seq: checked.state.lastSeq, hash: checked.state.lastHash!, log, records: cached?.records ?? [] });
    return { state: checked.state, epochs, log };
  }
  private privateController?: PrivateVault;
  private privateHead?: string;
  private stopPrivateSchedule?: () => void;
  /** Independently verified live authority for private workflows. */
  async privateAuthority() {
    const verified = await this.verified();
    const controls = verified.log.map(row => JSON.parse(Buffer.from(row.entry, 'base64url').toString()) as { proof: ControlProof; envelope: Envelope });
    const context = await verifyPrivateContext({ journey: this.session.journeyId, creator: controls[0]!.proof.body.creator as Member, controls }, { now: Date.now(), currentHead: verified.state.lastHash! });
    const member = verified.state.members[this.session.principal]!.member;
    const owner = privateVaultOwner(context, privateIdentity(member));
    const actor = privateIdentity(member), author = privateIdentity(owner), signingKey = await importSigningKey(this.session.signingPrivateKey);
    const session = await privateAgentSession(context, actor, signingKey, this.session.identity, 'authenticated');
    return { context, session, signingKey, author, vault: await memberVaultId(context.journey, owner.id, author.signingKey, author.recipient), members: verified.state.members };
  }
  get privateCacheRoot(): string | undefined { return this.options.cacheRoot; }
  /** Open the adding person's vault using only this agent's delivered content key. */
  async openPrivateVault(paired?: PrivateCheckpoint, fork?: import('@ai-wayfinding/core').VaultCacheRecord): Promise<PrivateVault> {
    const verified = await this.verified();
    if (!paired && this.privateController && this.privateHead === verified.state.lastHash) {
      if (fork) await this.privateController.merge(fork);
      return this.privateController;
    }
    this.stopPrivateSchedule?.(); this.stopPrivateSchedule = undefined;
    this.privateController?.close(); this.privateController = undefined;
    const controls = verified.log.map(row => JSON.parse(Buffer.from(row.entry, 'base64url').toString()) as { proof: ControlProof; envelope: Envelope });
    const context = await verifyPrivateContext({ journey: this.session.journeyId, creator: controls[0]!.proof.body.creator as Member, controls }, { now: Date.now(), currentHead: verified.state.lastHash! });
    const actor = privateIdentity(verified.state.members[this.session.principal]!.member);
    const owner = privateVaultOwner(context, actor), person = privateBinding(context, privateIdentity(owner)).principal;
    const author = privateIdentity(owner), signingKey = await importSigningKey(this.session.signingPrivateKey);
    const session = await privateAgentSession(context, actor, signingKey, this.session.identity, 'authenticated');
    if (!privateAccess(context, author, session)) throw new Error('Private vault access denied');
    const vault = await memberVaultId(this.session.journeyId, person, author.signingKey, author.recipient);
    const wrap = await this.response(`/journeys/${this.session.journeyId}/private-agent-wrap/${this.session.principal}`, 'GET', undefined, {}, true);
    // A fresh dedicated key can initialize only an empty server container.
    // Existing ciphertext must decrypt with a delivered key; never fall back to
    // the person's key or overwrite a header whose wrap is missing.
    const contentIdentity = wrap.status === 404 ? (await createAgeIdentity()).identity : await openVaultAgentWrap((await wrap.json() as { ciphertext: string }).ciphertext, { journey: this.session.journeyId, person, agent: this.session.principal, vault, author, recipient: actor }, this.session.identity, context);
    const transport: VaultTransport = { read: async indices => decodeVaultWire(new Uint8Array(await (await this.response(`/journeys/${this.session.journeyId}/private-vault?slots=${indices === 'all' ? 'all' : indices.map(i => String(i).padStart(2, '0')).join(',')}`)).arrayBuffer()), indices), commit: async patch => {
      const live = await this.privateAuthority();
      if (!samePrivateContext(live.context, context) || !privateAccess(live.context, author, live.session, true)) throw new Error('Private authority changed; reopen before saving');
      return (await this.response(`/journeys/${this.session.journeyId}/private-vault`, 'PUT', encodeVaultPatch(patch))).json();
    } };
    const options: VaultOptions = { actor, contentIdentity, trust: { vault, author }, identity: this.session.identity, signingKey, contexts: [context], sessions: [session], paired, transport, now: this.options.privateNow, randomOrder: this.options.privateRandomOrder };
    if (this.options.cacheRoot) options.cache = new NodePrivateStore(this.options.cacheRoot, vault, options);
    const controller = new PrivateVault(options); rememberNodePrivateVault(controller);
    try {
      await controller.open(fork);
      if (controller.retainedCheckpoint && privateAccess(context, author, session, true)) {
        const audience = await this.request<{ agents: { principal: string }[] }>(`/journeys/${this.session.journeyId}/private-agents`);
        for (const candidate of audience.agents) {
          const target = verified.state.members[candidate.principal]?.member;
          if (!target || target.kind !== 'agent' || !privateAgentAudience(context, author, privateIdentity(target))) continue;
          const ciphertext = await sealVaultAgentWrap({ journey: this.session.journeyId, person, agent: target.id, vault, author, recipient: privateIdentity(target) }, controller.agentContentIdentity, signingKey, { writer: actor, context });
          await this.request(`/journeys/${this.session.journeyId}/private-agent-wrap/${target.id}`, 'PUT', { ciphertext });
        }
      }
      if (!this.options.privateManualSchedule) {
        if (this.options.privateSchedule) this.stopPrivateSchedule = this.options.privateSchedule(() => controller.tick());
        else controller.start();
      }
      this.privateController = controller; this.privateHead = verified.state.lastHash!; return controller; }
    catch (error) { controller.close(); throw error; }
  }
  private async writable(): Promise<Verified> {
    const verified = await this.verified();
    if (!canWriteContent(verified.state, this.session.principal)) throw new Error('This journey is read-only for this agent, or a key update is pending. Its access follows the adding person’s current role.');
    return verified;
  }
  private async views(verified: Verified): Promise<ArtifactView[]> {
    const views: ArtifactView[] = [];
    for (const state of Object.values(verified.state.artifacts?.items ?? {})) {
      if (state.deleted) continue;
      const versions: ArtifactView['versions'] = [], comments: ArtifactComment[] = [];
      for (const row of verified.log) {
        const { proof, envelope } = JSON.parse(Buffer.from(row.entry, 'base64url').toString()) as { proof: ControlProof; envelope: Envelope };
        if (proof.body.artifact !== state.id || proof.type === 'artifact.delete' || proof.type === 'artifact.project') continue;
        const key = verified.epochs.get(envelope.outside.epoch);
        if (!key) throw new Error('An earlier artifact key is unavailable.');
        const record = await readArtifactPayload(proof, envelope, key);
        const authoredBy = verified.state.members[proof.actor]?.member.kind === 'agent' ? 'agent' as const : 'human' as const;
        if (proof.type === 'artifact.comment') comments.push({ id: String(proof.body.comment), item: state.id, actor: proof.actor, author: proof.actor, authoredBy, at: proof.at, body: String(record.body.text), text: String(record.body.text), ...(proof.body.onVersion === undefined ? {} : { onVersion: String(proof.body.onVersion) }) });
        else versions.push({ id: String(proof.body.version), actor: proof.actor, authoredBy, at: proof.at, payload: record.body as ArtifactPayload });
      }
      views.push({ state, versions, comments });
    }
    return views;
  }
  private item(view: ArtifactView, state: LogState): ArtifactItem {
    const first = view.versions[0]!, head = view.versions.at(-1)!;
    const placement = state.projects?.placements[view.state.id];
    return { project: placement?.project ?? null, placementRevision: placement?.revision ?? null, placementHistory: placement?.history ?? [], id: view.state.id, version: head.id, itemType: head.payload.content.kind, title: head.payload.title, body: artifactText(head.payload), tags: head.payload.tags, author: view.state.author, authoredBy: first.authoredBy, writer: head.actor, created: first.at, payload: head.payload };
  }
  private async view(id: string, verified: Verified): Promise<ArtifactView> {
    const view = (await this.views(verified)).find(v => v.state.id === id);
    if (!view) throw new Error('No journey artifact has that ID.');
    return view;
  }
  private async commit(type: ArtifactActionType, body: JsonObject, payload: JsonObject): Promise<void> {
    const latest = await this.writable();
    const transition = replayArtifact(latest.state, type, body, this.session.principal, Date.now()).transition;
    if (transition.$ !== 'ArtifactAccepted') throw new Error(transition.$ === 'ArtifactDenied' ? 'Artifact action requires current write access and Stage 1 minimum.' : 'Artifact conflict: predecessor, attribution or reference changed. Reload and try again.');
    const key = latest.epochs.get(latest.state.currentEpoch)!;
    const at = new Date().toISOString(), seq = latest.state.lastSeq + 1;
    const envelope = await sealArtifactPayload(type, body, payload, { id: newId(), journey: this.session.journeyId, seq, epoch: key.epoch, createdAt: at }, key);
    const proof = await signControlProof({ v: 1, seq, prev: latest.state.lastHash, at, actor: this.session.principal, type, body }, envelope, this.session.journeyId, await importSigningKey(this.session.signingPrivateKey));
    await this.request(`/journeys/${this.session.journeyId}/log`, 'POST', { control: { proof, envelope } });
  }
  async upload(file: LocalAttachment): Promise<ArtifactAttachment> {
    validateLocalAttachment(file);
    const bytes = await localBytes(file.path), latest = await this.writable();
    const stage = await this.request<{ id: string; journey: string; epoch: number; size: number }>(`/journeys/${this.session.journeyId}/blobs`, 'POST', { size: bytes.length });
    if (stage.journey !== this.session.journeyId || stage.epoch !== latest.state.currentEpoch || stage.size !== bytes.length) throw new Error('Journey key changed. Reload before uploading.');
    const encrypted = await sealBlob(bytes, { journey: stage.journey, id: stage.id, epoch: stage.epoch }, latest.epochs.get(stage.epoch)!);
    await this.response(`/journeys/${this.session.journeyId}/blobs/${stage.id}`, 'PUT', encrypted.ciphertext, { 'X-Blob-Descriptor': JSON.stringify(encrypted.descriptor) });
    return { blob: encrypted.descriptor, name: attachmentName(file), mime: file.mime ?? 'application/octet-stream', ...(file.packagePath === undefined ? {} : { path: file.packagePath }) };
  }
  private async payload(input: ArtifactInput, attachments: ArtifactAttachment[] = []): Promise<ArtifactPayload> {
    if ((input.files?.length ?? 0) + attachments.length > 8) throw new Error('A version can have at most eight attachments.');
    const uploaded = [...attachments];
    for (const file of input.files ?? []) uploaded.push(await this.upload({ path: file.path, ...(file.packagePath === undefined ? {} : { packagePath: file.packagePath }), ...(file.mime === undefined ? {} : { mime: file.mime }) }));
    return artifactPayload(input, uploaded);
  }
  async add(input: AddInput): Promise<ArtifactItem> {
    await this.writable();
    const payload = await this.payload(input), id = newId();
    await this.commit('artifact.create', { format: ARTIFACT_FORMAT, artifact: id, author: this.session.principal, actor: this.session.principal, version: newId(), typeHash: await artifactTypeHash(payload.content.kind), blobs: payload.attachments.map(a => a.blob) }, payload);
    return (await this.show(id)).item;
  }
  async importSkill(path: string, title: string, tags: string[] = []): Promise<ArtifactItem> { const pkg = await skillPackage(path); return this.add({ type: 'skill', title, body: pkg.body, files: pkg.files, tags }); }
  async list(type?: string, tag?: string, project?: string): Promise<ArtifactItem[]> {
    const selection = projectSelector(project), verified = await this.verified();
    const selected = new Set(selectProjectArtifacts(verified.state, selection));
    return (await this.views(verified)).filter(view => selected.has(view.state.id)).map(view => this.item(view, verified.state)).filter(item => (!type || item.itemType === type) && (!tag || item.tags.includes(tag)));
  }
  async search(text: string, project?: string, type?: string, tag?: string): Promise<ArtifactItem[]> { const needle = text.toLocaleLowerCase(); return (await this.list(type, tag, project)).filter(item => [item.title, item.body, item.itemType, ...item.tags].some(value => value.toLocaleLowerCase().includes(needle))); }
  async show(id: string): Promise<ItemView> { const verified = await this.verified(), view = await this.view(id, verified); return { item: this.item(view, verified.state), comments: view.comments, versions: view.versions }; }
  async versions(id: string): Promise<ArtifactView['versions']> { return (await this.show(id)).versions; }
  async comments(id: string): Promise<ArtifactComment[]> { return (await this.show(id)).comments; }
  async comment(id: string, text: string, onVersion?: string): Promise<ArtifactComment> {
    const view = await this.view(id, await this.writable()), comment = newId();
    await this.commit('artifact.comment', { format: ARTIFACT_FORMAT, artifact: id, author: view.state.author, actor: this.session.principal, comment, ...(onVersion === undefined ? {} : { onVersion }) }, { text });
    return (await this.comments(id)).find(c => c.id === comment)!;
  }
  async edit(id: string, predecessor: string, input: ArtifactInput): Promise<ArtifactItem> {
    const view = await this.view(id, await this.writable());
    // No author comparisons here: production Bend decides edit authority and stale predecessors.
    const payload = await this.payload(input, input.files === undefined ? view.versions.at(-1)!.payload.attachments : []);
    await this.commit('artifact.version', { format: ARTIFACT_FORMAT, artifact: id, author: view.state.author, actor: this.session.principal, version: newId(), predecessor, typeHash: await artifactTypeHash(payload.content.kind), blobs: payload.attachments.map(a => a.blob) }, payload);
    return (await this.show(id)).item;
  }
  async delete(id: string): Promise<{ id: string; warning: string }> {
    const view = await this.view(id, await this.writable());
    await this.commit('artifact.delete', { format: ARTIFACT_FORMAT, artifact: id, author: view.state.author, actor: this.session.principal }, {});
    return { id, warning: 'Deleted from ordinary views. Signed and encrypted metadata history is retained, not securely erased. Previously downloaded copies cannot be recalled.' };
  }
  async download(id: string, blob: string, path: string, version?: string): Promise<{ path: string; bytes: number }> {
    const verified = await this.verified(), view = await this.view(id, verified);
    const selected = version ? view.versions.find(v => v.id === version) : view.versions.at(-1);
    const attachment = selected?.payload.attachments.find(a => a.blob.id === blob);
    if (!attachment || attachment.blob.journey !== this.session.journeyId) throw new Error('No attachment has that ID in this artifact version.');
    const response = await this.response(`/journeys/${this.session.journeyId}/blobs/${blob}`);
    if (canonical(JSON.parse(response.headers.get('X-Blob-Descriptor') ?? 'null')) !== canonical(attachment.blob)) throw new Error('Attachment descriptor mismatch.');
    const key = verified.epochs.get(attachment.blob.epoch); if (!key) throw new Error('Attachment key unavailable.');
    const bytes = await openBlob(new Uint8Array(await response.arrayBuffer()), attachment.blob, key);
    await saveDownload(path, bytes);
    return { path, bytes: bytes.length };
  }
  private projectView(id: string, verified: Verified): ProjectView {
    const project = verified.state.projects?.items[id];
    if (!project) throw new Error('No journey project has that ID.');
    return { id: project.id, purpose: project.purpose, purposeHash: project.purposeHash, state: project.state, revision: project.revision, creator: project.creator, at: project.at, history: project.history, participants: effectiveProjectParticipants(verified.state, id), participation: (verified.state.projects?.participation ?? []).filter(pair => pair.project === id).map(pair => ({ project: pair.project, member: pair.member, revision: pair.revision, active: pair.active })) };
  }
  async projectList(): Promise<ProjectView[]> {
    const verified = await this.verified();
    return Object.keys(verified.state.projects?.items ?? {}).map(id => this.projectView(id, verified));
  }
  async projectShow(id: string): Promise<ProjectView> { return this.projectView(projectId(id), await this.verified()); }
  private async commitProject(type: ProjectActionType, body: JsonObject, payload: JsonObject): Promise<void> {
    // D17 is not writable(): Bend distinguishes participant metadata from content authority.
    const latest = await this.verified();
    const transition = replayProject(latest.state, type, body, this.session.principal, Date.now()).transition;
    if (transition.$ !== 'ProjectAccepted') throw new Error(transition.$ === 'ProjectDenied' ? 'Project action denied: current participation or content-write authority and Stage 2 minimum are required.' : 'Project conflict: predecessor, state or reference changed. Reload and try again.');
    const key = latest.epochs.get(latest.state.currentEpoch)!;
    const at = new Date().toISOString(), seq = latest.state.lastSeq + 1;
    const envelope = await sealProjectPayload(type, body, payload, { id: newId(), journey: this.session.journeyId, seq, epoch: key.epoch, createdAt: at }, key);
    const proof = await signControlProof({ v: 1, seq, prev: latest.state.lastHash, at, actor: this.session.principal, type, body }, envelope, this.session.journeyId, await importSigningKey(this.session.signingPrivateKey));
    await this.request(`/journeys/${this.session.journeyId}/log`, 'POST', { control: { proof, envelope } });
  }
  async projectCreate(purpose: string): Promise<ProjectView> {
    const text = purposeText(purpose), id = newId();
    await this.commitProject('project.create', { format: PROJECT_FORMAT, project: id, purposeHash: await projectPurposeHash(text), state: 'getting-started' }, { purpose: text });
    return this.projectShow(id);
  }
  async projectPurpose(id: string, purpose: string, predecessor: number | null): Promise<ProjectView> {
    const project = projectId(id), text = purposeText(purpose), revision = observedRevision(predecessor);
    await this.commitProject('project.purpose', { format: PROJECT_FORMAT, project, purposeHash: await projectPurposeHash(text), predecessor: revision }, { purpose: text });
    return this.projectShow(project);
  }
  async projectState(id: string, state: string, predecessor: number | null): Promise<ProjectView> {
    const project = projectId(id);
    await this.commitProject('project.state', { format: PROJECT_FORMAT, project, state: stateValue(state), predecessor: observedRevision(predecessor) }, {});
    return this.projectShow(project);
  }
  async projectParticipation(id: string, action: 'join' | 'leave'): Promise<ProjectView> {
    const verified = await this.verified(), project = this.projectView(projectId(id), verified);
    const member = verified.state.members[this.session.principal]!.member.addedBy!;
    const pair = project.participation.find(row => row.member === member);
    await this.commitProject(action === 'join' ? 'project.join' : 'project.leave', { format: PROJECT_FORMAT, project: project.id, member, predecessor: pair?.revision ?? null }, {});
    return this.projectShow(project.id);
  }
  async artifactProject(id: string, project: string | null, predecessor: number | null): Promise<ArtifactItem> {
    const target = project === null ? null : projectId(project), revision = observedRevision(predecessor);
    const view = await this.view(id, await this.verified());
    await this.commitProject('artifact.project', { format: PROJECT_FORMAT, artifact: id, author: view.state.author, actor: this.session.principal, project: target, predecessor: revision }, {});
    return (await this.show(id)).item;
  }
  async status(): Promise<{ journeyId: string; principal: string; scope: 'read' | 'readwrite'; expiresAt: number; seq: number }> {
    const { state } = await this.verified();
    const scope = effectiveScope(state, this.session.principal);
    if (!scope) throw new Error('This agent is no longer a member of the journey.');
    return { journeyId: this.session.journeyId, principal: this.session.principal, scope, expiresAt: this.session.expiresAt, seq: state.lastSeq };
  }
  close(): void { this.stopPrivateSchedule?.(); this.stopPrivateSchedule = undefined; this.privateController?.close(); this.privateController = undefined; for (const value of this.keys.values()) value.key.fill(0); this.keys.clear(); }
}
