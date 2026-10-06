import rules from '@ai-wayfinding/rules';
import type { Maybe, Role } from '@ai-wayfinding/rules';
import { isProjectAction, replayProject, copyBlobDescriptor, isArtifactAction, liveArtifactBlobIds, MAX_BLOB_BYTES, newId, normalizedArtifacts, replayArtifact, verifyBlob, type ArtifactArchive, type BlobDescriptor, canonical, contentRole, isPersonGuide, readControlProof, replayControl, normalizedMembers, ruleVersion, verifyControlProofs, type LogState, type Member } from '@ai-wayfinding/core';
import type { Env } from './index.js';
import { failure } from './types.js';
import type { Admission, ControlInput, EnclaveMessage, Subject } from './types.js';

type Row = Record<string, string | number | null>;
export class EnclaveObject {
  private sql: SqlStorage;
  // Crypto verification yields. Serialize complete operations, not just their SQL effects.
  private queue: Promise<void> = Promise.resolve();
  private uploading = new Set<string>();
  constructor(private state: DurableObjectState, private env: Env) {
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    this.sql.exec('INSERT INTO schema_version(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, currentEpoch INTEGER NOT NULL, nextSeq INTEGER NOT NULL, nextLog INTEGER NOT NULL, pendingRotation INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, epoch INTEGER NOT NULL, size INTEGER NOT NULL, createdAt TEXT NOT NULL, envelope BLOB NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY, entry BLOB NOT NULL, at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, expiresAt INTEGER, accountHash TEXT, addedBy TEXT, removedAt INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS wraps (principal TEXT NOT NULL, epoch INTEGER NOT NULL, wrap BLOB NOT NULL, PRIMARY KEY(principal,epoch))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS recovery_wraps (epoch INTEGER PRIMARY KEY, wrap BLOB NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS reservations (seq INTEGER PRIMARY KEY, principal TEXT NOT NULL, expires INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, epoch INTEGER NOT NULL, size INTEGER NOT NULL, expires INTEGER NOT NULL, complete INTEGER NOT NULL, artifact TEXT, descriptor TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS authority (id TEXT PRIMARY KEY, creator TEXT NOT NULL, state TEXT NOT NULL)');
    if (Number(this.one('SELECT version FROM schema_version')?.version) < 2) this.state.storage.transactionSync(() => {
      // Operator-approved destruction of test journeys. Account storage lives in Registry.
      for (const table of ['meta', 'records', 'log', 'principals', 'wraps', 'recovery_wraps', 'reservations', 'authority']) this.sql.exec(`DELETE FROM ${table}`);
      this.sql.exec('UPDATE schema_version SET version=2');
    });
  }
  private one(sql: string, ...args: (string | number)[]): Row | null { return (this.sql.exec(sql, ...args).toArray()[0] as Row | undefined) ?? null; }
  private identity(state: LogState, subject: Subject): boolean {
    const member = state.members[subject.principal]?.member;
    const row = this.one('SELECT accountHash FROM principals WHERE id=?', subject.principal);
    return !!member && (subject.agent ? member.kind === 'agent' && subject.agentJourney === state.journey : member.kind === 'person' && !!subject.accountHash && row?.accountHash === subject.accountHash);
  }
  private version(state: LogState, subject: Subject): boolean {
    try { return rules.private_ready(ruleVersion(state.minClientVersion)) ? rules.private_client(ruleVersion(subject.clientVersion ?? ''), ruleVersion(state.minClientVersion), subject.controlFormat === 'control-proof-v1', subject.artifactFormat === 'artifact-v1', subject.projectFormat === 'project-v1', subject.privateFormat === 'private-v1') : rules.project_ready(ruleVersion(state.minClientVersion)) ? rules.project_client(ruleVersion(subject.clientVersion ?? ''), ruleVersion(state.minClientVersion), subject.controlFormat === 'control-proof-v1', subject.artifactFormat === 'artifact-v1', subject.projectFormat === 'project-v1') : rules.artifact_ready(ruleVersion(state.minClientVersion)) ? rules.artifact_client(ruleVersion(subject.clientVersion ?? ''), ruleVersion(state.minClientVersion), subject.controlFormat === 'control-proof-v1', subject.artifactFormat === 'artifact-v1') : rules.server_version(ruleVersion(subject.clientVersion ?? ''), ruleVersion(state.minClientVersion), subject.controlFormat === 'control-proof-v1'); } catch { return false; }
  }
  private access(state: LogState, subject: Subject, write = false, checkVersion = true): boolean {
    const model = normalizedMembers(state, [subject.principal], Date.now());
    const access = rules.member_access(rules.find(model.members, model.id(subject.principal)), model.members);
    return write ? rules.server_content(access, this.identity(state, subject), this.version(state, subject), state.pendingRotation === true)
      : rules.server_read(access, this.identity(state, subject), !checkVersion || this.version(state, subject));
  }
  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method === 'PUT' && new URL(request.url).pathname === '/blob') return await this.upload(request);
      if (new URL(request.url).pathname === '/private-vault') {
        const input = JSON.parse(request.headers.get('X-Private-Message') ?? '') as Extract<EnclaveMessage, { op: 'privateAccess' }>;
        return await this.serialized(() => this.handle(input, request));
      }
      const input = await request.json() as EnclaveMessage;
      return await this.serialized(() => this.handle(input));
    } catch { return failure('invalid-request', 400); }
  }
  private current(): LogState { return JSON.parse(String(this.one('SELECT state FROM authority LIMIT 1')!.state)); }
  private artifactVersion(state: LogState, subject: Subject): boolean {
    try { return rules.artifact_client(ruleVersion(subject.clientVersion ?? ''), ruleVersion(state.minClientVersion), subject.controlFormat === 'control-proof-v1', subject.artifactFormat === 'artifact-v1'); } catch { return false; }
  }
  private stageAccess(state: LogState, subject: Subject, epoch: number): boolean {
    const model = normalizedMembers(state, [subject.principal], Date.now());
    return rules.blob_stage(rules.member_access(rules.find(model.members, model.id(subject.principal)), model.members), this.identity(state, subject), this.artifactVersion(state, subject) && this.version(state, subject), state.pendingRotation === true, BigInt(epoch), BigInt(state.currentEpoch));
  }
  private uploadAccess(state: LogState, input: Extract<EnclaveMessage, { op: 'blobUpload' }>, completing = false): boolean {
    const row = this.one('SELECT * FROM blobs WHERE id=?', input.descriptor.id);
    const model = normalizedMembers(state, [input.subject.principal, String(row?.owner ?? '')]);
    return rules.blob_upload(this.stageAccess(state, input.subject, input.descriptor.epoch), !!row && row.epoch === input.descriptor.epoch && row.size === input.descriptor.size, model.id(String(row?.owner ?? '')), model.id(input.subject.principal), Number(row?.expires) > Date.now(), row?.complete === 0 && row.artifact === null && (completing || !this.uploading.has(input.descriptor.id)));
  }
  private key(journey: string, id: string): string { return `journeys/${journey}/blobs/${id}`; }
  private async schedule(): Promise<void> { await this.state.storage.setAlarm(Date.now() + 60_000); }
  private async upload(request: Request): Promise<Response> {
    const input = JSON.parse(request.headers.get('x-blob-message') ?? '') as Extract<EnclaveMessage, { op: 'blobUpload' }>;
    const admitted = await this.serialized(async () => {
      const meta = this.one('SELECT id FROM meta LIMIT 1');
      if (!meta || meta.id !== input.journeyId) return failure('not-found', 404);
      const state = this.current();
      if (!this.access(state, input.subject, false, false)) return failure('forbidden', 403);
      if (!this.artifactVersion(state, input.subject) || !this.version(state, input.subject)) return this.upgrade(state);
      if (!this.uploadAccess(state, input)) return failure('forbidden', 403);
      this.uploading.add(input.descriptor.id); return null;
    });
    if (admitted) { await request.body?.cancel().catch(() => {}); return admitted; }
    const reader = request.body?.getReader();
    try {
      // Bound allocation and every streamed byte; never trust Content-Length.
      const bytes = new Uint8Array(input.descriptor.ciphertextSize); let count = 0;
      if (reader) for (;;) {
        const part = await reader.read(); if (part.done) break;
        count += part.value.byteLength;
        if (count > MAX_BLOB_BYTES + 16 || count > bytes.length) return failure('too-large', 413);
        bytes.set(part.value, count - part.value.byteLength);
      }
      if (count !== bytes.length) return failure('invalid-request', 400);
      const descriptor = await verifyBlob(bytes, input.descriptor);
      await this.env.ARTIFACT_BLOBS.put(this.key(input.journeyId, descriptor.id), bytes);
      return await this.serialized(async () => {
        const state = this.current();
        if (!this.uploadAccess(state, input, true)) { await this.schedule(); return failure('forbidden', 403); }
        this.sql.exec('UPDATE blobs SET complete=1,descriptor=? WHERE id=?', JSON.stringify(copyBlobDescriptor(descriptor)), descriptor.id);
        await this.schedule(); return Response.json({ descriptor }, { status: 201 });
      });
    } catch { return failure('invalid-request', 400); }
    finally { await reader?.cancel().catch(() => {}); await this.serialized(async () => { this.uploading.delete(input.descriptor.id); }); }
  }
  async alarm(): Promise<void> {
    await this.serialized(async () => {
      const meta = this.one('SELECT id FROM meta LIMIT 1'); if (!meta) return;
      const live = liveArtifactBlobIds(this.current());
      for (const row of this.sql.exec('SELECT * FROM blobs').toArray()) {
        const id = String(row.id);
        if (this.uploading.has(id) || !rules.blob_collect(live.includes(id), Number(row.expires) <= Date.now(), row.artifact !== null)) continue;
        try { await this.env.ARTIFACT_BLOBS.delete(this.key(String(meta.id), id)); this.sql.exec('DELETE FROM blobs WHERE id=?', id); } catch { /* Next alarm retries the same unreferenced object. */ }
      }
      if (this.one('SELECT id FROM blobs WHERE artifact IS NULL LIMIT 1') || this.sql.exec('SELECT id FROM blobs').toArray().some(row => !live.includes(String(row.id)))) await this.schedule();
    });
  }
  private async download(state: LogState, subject: Subject, id: string): Promise<Response> {
    const row = this.one('SELECT * FROM blobs WHERE id=?', id);
    if (!rules.blob_read(this.access(state, subject), liveArtifactBlobIds(state).includes(id), row?.complete === 1)) return failure('not-found', 404);
    const stored = await this.env.ARTIFACT_BLOBS.get(this.key(state.journey, id));
    if (!stored) return failure('not-found', 404);
    return new Response(stored.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${id}.encrypted"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'X-Blob-Descriptor': String(row!.descriptor) } });
  }
  private async provision(journey: string, principal: string): Promise<void> {
    const stub = this.env.PRIVATE_VAULTS.get(this.env.PRIVATE_VAULTS.idFromName(JSON.stringify([journey, principal])));
    const result = await stub.fetch('https://internal/allocate', { method: 'POST' });
    if (!result.ok) throw new Error('Member allocation failed');
  }
  private async handle(input: EnclaveMessage, vaultRequest?: Request): Promise<Response> {
    const now = Date.now();
    if (input.op === 'create') {
      const data = input.data;
      if (this.one('SELECT id FROM meta LIMIT 1')) return failure('conflict', 409);
      const creator = (await readControlProof(data.control.proof, data.control.envelope)).entry.body.creator as Member;
      const result = await verifyControlProofs([data.control.proof], [data.control.envelope], { journey: data.id, creator });
      if (!result.ok || creator.kind !== 'person' || creator.id !== data.creator.id || !data.creatorHash) return failure('invalid-request', 400);
      const state = result.state;
      if (data.control.envelope.outside.epoch !== 1 || data.wraps.length !== 1 || data.wraps[0]?.principal !== creator.id || data.wraps[0]?.epoch !== 1) return failure('invalid-request', 400);
      const s: Subject = { principal: creator.id, accountHash: data.creatorHash, clientVersion: data.clientVersion, controlFormat: data.controlFormat, artifactFormat: data.artifactFormat, projectFormat: data.projectFormat, privateFormat: data.privateFormat };
      if (!this.version(state, s)) return this.upgrade(state);
      await this.provision(data.id, creator.id);
      this.state.storage.transactionSync(() => {
        this.sql.exec('INSERT INTO meta VALUES(?,?,?,?,?)', data.id, 1, 1, 1, 0);
        this.sql.exec('INSERT INTO authority VALUES(?,?,?)', data.id, canonical(creator), JSON.stringify(state));
        this.sql.exec('INSERT INTO log VALUES(0,?,?)', JSON.stringify(data.control), now);
        this.sql.exec('INSERT INTO principals(id,kind,scope,accountHash) VALUES(?,?,?,?)', creator.id, 'person', 'readwrite', data.creatorHash);
        for (const wrap of data.wraps) this.sql.exec('INSERT INTO wraps VALUES(?,?,?)', wrap.principal, 1, wrap.wrap);
        this.sql.exec('INSERT INTO recovery_wraps VALUES(1,?)', data.recoveryWrap);
      });
      return Response.json({ ok: true, minClientVersion: state.minClientVersion });
    }
    const meta = this.one('SELECT * FROM meta LIMIT 1');
    const authority = this.one('SELECT creator,state FROM authority LIMIT 1');
    if (!meta || meta.id !== input.journeyId || !authority) return failure('not-found', 404);
    const state: LogState = JSON.parse(String(authority.state));
    const subject = input.subject;
    if (!subject || !this.access(state, subject, false, false)) return failure('forbidden', 403);
    if (input.op === 'protocol') return Response.json(this.protocol(state));
    if (!this.version(state, subject)) return this.upgrade(state);
    if (!this.access(state, subject)) return failure('forbidden', 403);
    switch (input.op) {
      case 'blobBegin': {
        if (!this.artifactVersion(state, subject)) return this.upgrade(state);
        if (!this.stageAccess(state, subject, state.currentEpoch)) return failure('forbidden', 403);
        const id = newId(), expiresAt = now + 3_600_000;
        this.sql.exec('INSERT INTO blobs VALUES(?,?,?,?,?,0,NULL,NULL)', id, subject.principal, state.currentEpoch, input.size, expiresAt);
        await this.schedule();
        return Response.json({ id, journey: state.journey, epoch: state.currentEpoch, size: input.size, expiresAt }, { status: 201 });
      }
      case 'blobRead': return this.download(state, subject, input.id);
      case 'privateAccess': {
        const member = state.members[subject.principal]!.member;
        const principal = member.kind === 'agent' ? member.addedBy : member.id;
        if (!principal || state.members[principal]?.member.kind !== 'person') return failure('forbidden', 403);
        const model = normalizedMembers(state, [subject.principal, principal], now);
        const credential = { $: subject.agent ? subject.privateCredential === 'authenticated' ? 'PrivateAuthenticatedAgent' as const : 'PrivateUnknownCredential' as const : 'PrivatePersonCredential' as const };
        const allowed = input.write && subject.agent ? rules.private_write(model.members, model.id(principal), model.id(subject.principal), credential, ruleVersion(state.minClientVersion), state.pendingRotation === true, true) : rules.private_audience(model.members, model.id(principal), model.id(subject.principal), credential);
        if (!allowed) return failure('forbidden', 403);
        if (vaultRequest) {
          const stub = this.env.PRIVATE_VAULTS.get(this.env.PRIVATE_VAULTS.idFromName(JSON.stringify([state.journey, principal])));
          return stub.fetch('https://internal/' + new URL(vaultRequest.url).search, { method: vaultRequest.method, headers: { 'X-Private-Agent': subject.agent ? '1' : '0' }, ...(input.write ? { body: vaultRequest.body } : {}) });
        }
        return Response.json({ allowed: true, principal });
      }
      case 'privateWrapEligible':
      case 'privateWrapAccess': {
        const member = state.members[subject.principal]!.member, agent = state.members[input.agent]?.member;
        const person = member.kind === 'agent' ? member.addedBy : member.id;
        if (!person || !agent || agent.kind !== 'agent') return failure('forbidden', 403);
        const model = normalizedMembers(state, [person, subject.principal, input.agent], now);
        const credential = { $: subject.agent ? subject.privateCredential === 'authenticated' ? 'PrivateAuthenticatedAgent' as const : 'PrivateUnknownCredential' as const : 'PrivatePersonCredential' as const };
        if (!rules.private_wrap_access(model.members, model.id(person), model.id(subject.principal), model.id(input.agent), credential, input.op === 'privateWrapEligible' || input.ciphertext !== undefined)) return failure('forbidden', 403);
        if (input.op === 'privateWrapEligible') return Response.json({ allowed: true });
        const stub = this.env.PRIVATE_VAULTS.get(this.env.PRIVATE_VAULTS.idFromName(JSON.stringify([state.journey, person])));
        return stub.fetch('https://internal/agent-wrap?agent=' + encodeURIComponent(input.agent), input.ciphertext ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ciphertext: input.ciphertext, expires: Date.parse(agent.expiresAt!) }) } : {});
      }
      case 'access': return Response.json({ allowed: true, epoch: state.currentEpoch });
      case 'inviteAccess': return isPersonGuide(state, subject.principal) && !subject.agent ? Response.json({ allowed: true }) : failure('forbidden', 403);
      case 'linkAccess': return replayControl(state, subject.principal, 'Renew', input.member, undefined, false, undefined, now).transition.$ === 'Accepted' && !subject.agent ? Response.json({ allowed: true }) : failure('forbidden', 403);
      case 'reserve': {
        if (!this.access(state, subject, true)) return failure(state.pendingRotation ? 'old-epoch' : 'forbidden', state.pendingRotation ? 409 : 403);
        const seq = Number(meta.nextSeq);
        this.state.storage.transactionSync(() => {
          this.sql.exec('UPDATE meta SET nextSeq=?', seq + 1);
          this.sql.exec('INSERT INTO reservations VALUES(?,?,?)', seq, subject.principal, now + 300_000);
        });
        return Response.json({ seq, epoch: state.currentEpoch });
      }
      case 'recordWrite': {
        if (!this.access(state, subject, true)) return failure(state.pendingRotation ? 'old-epoch' : 'forbidden', state.pendingRotation ? 409 : 403);
        const envelope = input.envelope;
        if (envelope.outside.journey !== state.journey || envelope.outside.epoch !== state.currentEpoch) return failure('old-epoch', 409);
        const reservation = this.one('SELECT principal,expires FROM reservations WHERE seq=?', envelope.outside.seq!);
        if (!reservation || reservation.principal !== subject.principal || Number(reservation.expires) <= now) return failure('conflict', 409);
        this.state.storage.transactionSync(() => {
          this.sql.exec('INSERT INTO records VALUES(?,?,?,?,?,?)', envelope.outside.seq!, envelope.outside.id, envelope.outside.epoch, envelope.outside.size, envelope.outside.createdAt, JSON.stringify(envelope));
          this.sql.exec('DELETE FROM reservations WHERE seq=?', envelope.outside.seq!);
        });
        return Response.json({ seq: envelope.outside.seq }, { status: 201 });
      }
      case 'controlWrite': return isProjectAction(input.control.proof.type) ? this.project(state, JSON.parse(String(authority.creator)) as Member, subject, input) : isArtifactAction(input.control.proof.type) ? this.artifact(state, JSON.parse(String(authority.creator)) as Member, subject, input) : this.control(state, JSON.parse(String(authority.creator)) as Member, subject, input, now);
      case 'records': return Response.json({ records: this.sql.exec('SELECT envelope FROM records WHERE seq>? ORDER BY seq LIMIT ?', input.after, input.limit).toArray().map(row => JSON.parse(String(row.envelope))) });
      case 'log': return Response.json({ log: this.sql.exec('SELECT seq,entry FROM log WHERE seq>? ORDER BY seq LIMIT 1000', input.after).toArray().map(row => ({ seq: row.seq, ...JSON.parse(String(row.entry)) as ControlInput })) });
      case 'wraps': return Response.json({ wraps: this.sql.exec('SELECT epoch,wrap FROM wraps WHERE principal=? ORDER BY epoch', subject.principal).toArray() });
      case 'export': if (rules.artifact_ready(ruleVersion(state.minClientVersion))) return this.exportArtifacts(state, subject, JSON.parse(String(authority.creator)) as Member); return Response.json({ log: this.sql.exec('SELECT seq,entry FROM log ORDER BY seq').toArray().map(row => ({ seq: row.seq, ...JSON.parse(String(row.entry)) as ControlInput })), envelopes: this.sql.exec('SELECT envelope FROM records ORDER BY seq').toArray().map(row => JSON.parse(String(row.envelope))), wraps: this.sql.exec('SELECT epoch,wrap FROM wraps WHERE principal=? ORDER BY epoch', subject.principal).toArray() }, { headers: { 'Cache-Control': 'no-store' } });
      default: return failure('invalid-request', 400); // No opaque legacy writes or remove/re-add renewal.
    }
  }
  private protocol(state: LogState) { return { minClientVersion: state.minClientVersion, controlFormat: 'control-proof-v1', ...(rules.artifact_ready(ruleVersion(state.minClientVersion)) ? { artifactFormat: 'artifact-v1' } : {}), ...(rules.project_ready(ruleVersion(state.minClientVersion)) ? { projectFormat: 'project-v1' } : {}), ...(rules.private_ready(ruleVersion(state.minClientVersion)) ? { privateFormat: 'private-v1' } : {}) }; }
  private upgrade(state: LogState): Response { return Response.json({ error: { code: 'client-too-old' }, ...this.protocol(state) }, { status: 426 }); }
  private async project(state: LogState, creator: Member, subject: Subject, input: Extract<EnclaveMessage, { op: 'controlWrite' }>): Promise<Response> {
    const control = input.control, proof = control.proof;
    if (!isProjectAction(proof.type)) return failure('invalid-request', 400);
    if (!rules.project_client(ruleVersion(subject.clientVersion ?? ''), ruleVersion(state.minClientVersion), subject.controlFormat === 'control-proof-v1', subject.artifactFormat === 'artifact-v1', subject.projectFormat === 'project-v1')) return this.upgrade(state);
    if (proof.actor !== subject.principal || input.wraps !== undefined || input.admission !== undefined) return failure('forbidden', 403);
    const prior = this.one('SELECT entry FROM log WHERE seq=?', proof.seq);
    if (prior) return canonical(JSON.parse(String(prior.entry))) === canonical(control) ? Response.json({ seq: proof.seq, memberDelta: 0, removed: [], minClientVersion: state.minClientVersion, retry: true }) : failure('conflict', 409);
    if (proof.seq !== state.lastSeq + 1 || proof.prev !== state.lastHash) return failure('conflict', 409);
    if (Math.abs(Date.parse(proof.at) - Date.now()) > 60_000) return failure('invalid-request', 400);
    if (control.envelope.outside.epoch !== state.currentEpoch) return failure('old-epoch', 409);
    const live = replayProject(state, proof.type, proof.body, subject.principal, Date.now());
    if (live.transition.$ !== 'ProjectAccepted') return failure(live.transition.$ === 'ProjectDenied' ? 'forbidden' : 'conflict', live.transition.$ === 'ProjectDenied' ? 403 : 409);
    const controls = this.sql.exec('SELECT entry FROM log ORDER BY seq').toArray().map(row => JSON.parse(String(row.entry)) as ControlInput);
    const verified = await verifyControlProofs([...controls.map(c => c.proof), proof], [...controls.map(c => c.envelope), control.envelope], { journey: state.journey, creator });
    if (!verified.ok) return failure('invalid-request', 400);
    // Verification yields; live expiry, identity, capabilities and participation still apply at commit.
    if (!this.access(state, subject) || replayProject(state, proof.type, proof.body, subject.principal, Date.now()).transition.$ !== 'ProjectAccepted') return failure('forbidden', 403);
    this.state.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO log VALUES(?,?,?)', proof.seq, JSON.stringify(control), Date.now());
      this.sql.exec('UPDATE authority SET state=?', JSON.stringify(verified.state));
      this.sql.exec('UPDATE meta SET nextLog=?', proof.seq + 1);
    });
    return Response.json({ seq: proof.seq, memberDelta: 0, removed: [], minClientVersion: verified.state.minClientVersion }, { status: 201 });
  }
  private async exportArtifacts(state: LogState, subject: Subject, creator: Member): Promise<Response> {
    const live = liveArtifactBlobIds(state), blobs: ArtifactArchive['blobs'] = [];
    for (const id of live) {
      const row = this.one('SELECT descriptor FROM blobs WHERE id=?', id);
      const stored = await this.env.ARTIFACT_BLOBS.get(this.key(state.journey, id)); if (!row || !stored) return failure('internal', 500);
      const bytes = new Uint8Array(await stored.arrayBuffer());
      // Archive encodes binary once for JSON export; bucket storage remains raw bytes.
      let encoded = ''; for (let offset = 0; offset < bytes.length; offset += 24_576) encoded += btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24_576)));
      blobs.push({ descriptor: JSON.parse(String(row.descriptor)), ciphertext: encoded });
    }
    const history = Object.values(state.artifacts?.items ?? {}).flatMap(a => a.versions.flatMap(v => v.blobs.map(b => b.id)));
    const archive: ArtifactArchive = { format: 'artifact-v1', version: 1, journey: state.journey, creator,
      controls: this.sql.exec('SELECT entry FROM log ORDER BY seq').toArray().map(row => JSON.parse(String(row.entry))),
      envelopes: this.sql.exec('SELECT envelope FROM records ORDER BY seq').toArray().map(row => JSON.parse(String(row.envelope))),
      wraps: this.sql.exec('SELECT epoch,wrap FROM wraps WHERE principal=? ORDER BY epoch', subject.principal).toArray().map(row => ({ epoch: Number(row.epoch), recipient: subject.principal, ciphertext: String(row.wrap) })),
      blobs, unavailableDeletedBlobs: [...new Set(history.filter(id => !live.includes(id)))].sort() };
    return Response.json(archive, { headers: { 'Cache-Control': 'no-store' } });
  }
  private async artifact(state: LogState, creator: Member, subject: Subject, input: Extract<EnclaveMessage, { op: 'controlWrite' }>): Promise<Response> {
    const control = input.control, proof = control.proof;
    if (!isArtifactAction(proof.type)) return failure('invalid-request', 400);
    if (!this.artifactVersion(state, subject)) return this.upgrade(state);
    if (!this.stageAccess(state, subject, control.envelope.outside.epoch)) return failure('forbidden', 403);
    if (proof.actor !== subject.principal || input.wraps !== undefined || input.admission !== undefined) return failure('forbidden', 403);
    const prior = this.one('SELECT entry FROM log WHERE seq=?', proof.seq);
    if (prior) return canonical(JSON.parse(String(prior.entry))) === canonical(control) ? Response.json({ seq: proof.seq, memberDelta: 0, removed: [], minClientVersion: state.minClientVersion, retry: true }) : failure('conflict', 409);
    if (proof.seq !== state.lastSeq + 1 || proof.prev !== state.lastHash) return failure('conflict', 409);
    if (Math.abs(Date.parse(proof.at) - Date.now()) > 60_000) return failure('invalid-request', 400);
    const live = replayArtifact(state, proof.type, proof.body, subject.principal, Date.now());
    if (live.transition.$ !== 'ArtifactAccepted') return failure(live.transition.$ === 'ArtifactDenied' ? 'forbidden' : 'conflict', live.transition.$ === 'ArtifactDenied' ? 403 : 409);
    const controls = this.sql.exec('SELECT entry FROM log ORDER BY seq').toArray().map(row => JSON.parse(String(row.entry)) as ControlInput);
    const verified = await verifyControlProofs([...controls.map(c => c.proof), proof], [...controls.map(c => c.envelope), control.envelope], { journey: state.journey, creator });
    if (!verified.ok) return failure('invalid-request', 400);
    const descriptors = (proof.body.blobs ?? []) as BlobDescriptor[];
    for (const descriptor of descriptors) {
      const row = this.one('SELECT * FROM blobs WHERE id=?', descriptor.id);
      const model = normalizedMembers(state, [subject.principal, String(row?.owner ?? '')]);
      const normalized = normalizedArtifacts(state, proof.body, subject.principal);
      const sameArtifact = rules.blob_reuse(rules.artifact_find(normalized.index.items, normalized.model.id(String(proof.body.artifact))), normalized.model.id(descriptor.id));
      if (!rules.blob_reference(!!row && descriptor.journey === state.journey, !!row?.descriptor && canonical(JSON.parse(String(row.descriptor))) === canonical(descriptor), row?.complete === 1, row?.artifact !== null && row?.artifact !== undefined, model.id(String(row?.owner ?? '')), model.id(subject.principal), Number(row?.expires) > Date.now(), BigInt(descriptor.epoch), BigInt(state.currentEpoch), sameArtifact)) return failure('conflict', 409);
    }
    if (!this.stageAccess(state, subject, control.envelope.outside.epoch) || replayArtifact(state, proof.type, proof.body, subject.principal, Date.now()).transition.$ !== 'ArtifactAccepted') return failure('forbidden', 403);
    this.state.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO log VALUES(?,?,?)', proof.seq, JSON.stringify(control), Date.now());
      this.sql.exec('UPDATE authority SET state=?', JSON.stringify(verified.state));
      this.sql.exec('UPDATE meta SET nextLog=?', proof.seq + 1);
      for (const b of descriptors) this.sql.exec('UPDATE blobs SET artifact=? WHERE id=?', String(proof.body.artifact), b.id);
    });
    await this.schedule();
    return Response.json({ seq: proof.seq, memberDelta: 0, removed: [], minClientVersion: verified.state.minClientVersion }, { status: 201 });
  }
  private async control(state: LogState, creator: Member, subject: Subject, input: Extract<EnclaveMessage, { op: 'controlWrite' }>, now: number): Promise<Response> {
    const proof = input.control.proof;
    if (proof.actor !== subject.principal) return failure('forbidden', 403);
    if (proof.seq !== state.lastSeq + 1 || proof.prev !== state.lastHash) return failure('conflict', 409);
    // Entry time drives replay, but cannot be used to revive expired authority at the live boundary.
    if (Math.abs(Date.parse(proof.at) - now) > 60_000) return failure('invalid-request', 400);
    const operations = { 'member.add': 'Add', 'member.remove': 'Remove', 'member.role': 'RoleChange', 'grant.add': 'Guide', 'grant.remove': 'Guide', 'journey.settings': 'Settings', 'client.minVersion': 'Settings', 'key.rotate': 'Rotate', 'member.profile': 'Profile', 'member.rename': 'Rename', 'member.renew': 'Renew' } as const;
    const operation = operations[proof.type as keyof typeof operations];
    if (!operation) return failure('invalid-request', 400);
    const controls = this.sql.exec('SELECT entry FROM log ORDER BY seq').toArray().map(row => JSON.parse(String(row.entry)) as ControlInput);
    const result = await verifyControlProofs([...controls.map(c => c.proof), proof], [...controls.map(c => c.envelope), input.control.envelope], { journey: state.journey, creator });
    if (!result.ok) return failure(result.error.code === 'unauthorized' || result.error.code === 'last-holder' ? 'forbidden' : 'invalid-request', result.error.code === 'unauthorized' || result.error.code === 'last-holder' ? 403 : 400);
    const next = result.state;
    if (!this.version(next, subject)) return this.upgrade(next);
    const target = typeof proof.body.member === 'string' ? proof.body.member : typeof proof.body.id === 'string' ? proof.body.id : undefined;
    const live = replayControl(state, subject.principal, operation, target, operation === 'Add' ? next.members[(proof.body.member as Member).id]?.member : undefined, proof.type === 'grant.add' || operation === 'Add' && (proof.body.grants as string[]).includes('members.manage'), { $: proof.body.role === 'read-only' ? 'ReadOnly' : 'ReadWrite' }, now);
    if (live.transition.$ !== 'Accepted') return failure('forbidden', 403);
    const admission = input.admission;
    if (proof.type === 'member.add' && !this.admission(proof.body.member as Member, admission, subject, live.model, now)) return failure('forbidden', 403);
    if (proof.type !== 'member.add' && admission) return failure('invalid-request', 400);
    if (input.control.envelope.outside.epoch !== (proof.type === 'key.rotate' ? next.currentEpoch : state.currentEpoch)) return failure('old-epoch', 409);
    const supplied = input.wraps ?? [];
    const expected = proof.type === 'key.rotate' ? Object.keys(next.members) : proof.type === 'member.add' ? [String(proof.body.member && (proof.body.member as Member).id)] : [];
    const historical = proof.type === 'member.add' && (proof.body.member as Member).kind === 'person';
    const wrapCount = historical ? state.currentEpoch : expected.length;
    if (supplied.length !== wrapCount || new Set(supplied.map(w => JSON.stringify([w.principal, w.epoch]))).size !== wrapCount || supplied.some(w => !expected.includes(w.principal) || !Number.isSafeInteger(w.epoch) || (historical ? w.epoch < 1 || w.epoch > state.currentEpoch : w.epoch !== next.currentEpoch))) return failure('invalid-request', 400);
    const removed = Object.keys(state.members).filter(id => !next.members[id]);
    if (admission?.kind === 'person') await this.provision(state.journey, admission.id);
    this.state.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO log VALUES(?,?,?)', proof.seq, JSON.stringify(input.control), now);
      this.sql.exec('UPDATE authority SET state=?', JSON.stringify(next));
      this.sql.exec('UPDATE meta SET currentEpoch=?,nextLog=?,pendingRotation=?', next.currentEpoch, proof.seq + 1, next.pendingRotation ? 1 : 0);
      for (const id of removed) { this.sql.exec('DELETE FROM principals WHERE id=?', id); this.sql.exec('DELETE FROM reservations WHERE principal=?', id); }
      if (admission) this.sql.exec('INSERT INTO principals(id,kind,scope,accountHash,addedBy) VALUES(?,?,?,?,?)', admission.id, admission.kind, admission.scope ?? 'readwrite', admission.accountHash ?? null, admission.kind === 'agent' ? subject.principal : null);
      for (const w of supplied) this.sql.exec('INSERT INTO wraps VALUES(?,?,?)', w.principal, w.epoch, w.wrap);
    });
    // Serialized with wrap delivery: no late PUT can resurrect a removed wrap.
    for (const id of removed) {
      const agent = state.members[id]!.member;
      if (agent.kind === 'agent' && agent.addedBy) {
        const stub = this.env.PRIVATE_VAULTS.get(this.env.PRIVATE_VAULTS.idFromName(JSON.stringify([state.journey, agent.addedBy])));
        await stub.fetch('https://internal/agent-wrap?agent=' + encodeURIComponent(id), { method: 'DELETE' });
      }
    }
    return Response.json({ seq: proof.seq, memberDelta: Object.keys(next.members).length - Object.keys(state.members).length, removed, minClientVersion: next.minClientVersion }, { status: 201 });
  }
  private admission(member: Member, admission: Admission | undefined, subject: Subject, model: ReturnType<typeof normalizedMembers>, now: number): boolean {
    if (!admission || member.id !== admission.id || member.kind !== admission.kind || member.recipient !== admission.recipient || member.signingKey !== admission.signingKey) return false;
    if (admission.scope !== undefined && !['read', 'readwrite'].includes(admission.scope)) return false;
    const scope = (value: Member['scope']): Maybe<Role> => value === undefined ? { $: 'None' } : { $: 'Some', value: contentRole(value) };
    if (!rules.server_admission({ $: member.kind === 'person' ? 'Person' : 'Agent' }, scope(member.scope), scope(admission.scope), model.id(member.addedBy), model.id(subject.principal), Boolean(admission.support))) return false;
    if (member.kind === 'person') return !!admission.accountHash && (admission.support ? member.support === true && Date.parse(member.expiresAt ?? '') === admission.expiresAt && admission.expiresAt! > now : member.support === undefined && member.expiresAt === undefined);
    return Date.parse(member.expiresAt ?? '') === admission.expiresAt && admission.expiresAt! > now;
  }
}
