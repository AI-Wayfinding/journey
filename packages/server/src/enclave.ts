import rules from '@ai-wayfinding/rules';
import { canonical, isPersonGuide, readControlProof, replayControl, normalizedMembers, ruleVersion, verifyControlProofs, type LogState, type Member } from '@ai-wayfinding/core';
import { failure } from './types.js';
import type { Admission, ControlInput, EnclaveMessage, Subject } from './types.js';

type Row = Record<string, string | number | null>;
export class EnclaveObject {
  private sql: SqlStorage;
  // Crypto verification yields. Serialize complete operations, not just their SQL effects.
  private queue: Promise<void> = Promise.resolve();
  constructor(private state: DurableObjectState) {
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
    return !!member && (subject.agent ? member.kind === 'agent' : member.kind === 'person' && !!subject.accountHash && row?.accountHash === subject.accountHash);
  }
  private version(state: LogState, subject: Subject): boolean {
    try { return rules.server_version(ruleVersion(subject.clientVersion ?? ''), ruleVersion(state.minClientVersion), subject.controlFormat === 'control-proof-v1'); } catch { return false; }
  }
  private access(state: LogState, subject: Subject, write = false, checkVersion = true): boolean {
    const model = normalizedMembers(state, [subject.principal], Date.now());
    const access = rules.member_access(rules.find(model.members, model.id(subject.principal)), model.members);
    return write ? rules.server_content(access, this.identity(state, subject), this.version(state, subject), state.pendingRotation === true)
      : rules.server_read(access, this.identity(state, subject), !checkVersion || this.version(state, subject));
  }
  async fetch(request: Request): Promise<Response> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await this.handle(await request.json() as EnclaveMessage); }
    catch { return failure('invalid-request', 400); }
    finally { release(); }
  }
  private async handle(input: EnclaveMessage): Promise<Response> {
    const now = Date.now();
    if (input.op === 'create') {
      const data = input.data;
      if (this.one('SELECT id FROM meta LIMIT 1')) return failure('conflict', 409);
      const creator = (await readControlProof(data.control.proof, data.control.envelope)).entry.body.creator as Member;
      const result = await verifyControlProofs([data.control.proof], [data.control.envelope], { journey: data.id, creator });
      if (!result.ok || creator.kind !== 'person' || creator.id !== data.creator.id || !data.creatorHash) return failure('invalid-request', 400);
      const state = result.state;
      if (data.control.envelope.outside.epoch !== 1 || data.wraps.length !== 1 || data.wraps[0]?.principal !== creator.id || data.wraps[0]?.epoch !== 1) return failure('invalid-request', 400);
      const s: Subject = { principal: creator.id, accountHash: data.creatorHash, clientVersion: data.clientVersion, controlFormat: data.controlFormat };
      if (!this.version(state, s)) return this.upgrade(state);
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
    if (input.op === 'protocol') return Response.json({ minClientVersion: state.minClientVersion, controlFormat: 'control-proof-v1' });
    if (!this.version(state, subject)) return this.upgrade(state);
    if (!this.access(state, subject)) return failure('forbidden', 403);
    switch (input.op) {
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
      case 'controlWrite': return this.control(state, JSON.parse(String(authority.creator)) as Member, subject, input, now);
      case 'records': return Response.json({ records: this.sql.exec('SELECT envelope FROM records WHERE seq>? ORDER BY seq LIMIT ?', input.after, input.limit).toArray().map(row => JSON.parse(String(row.envelope))) });
      case 'log': return Response.json({ log: this.sql.exec('SELECT seq,entry FROM log WHERE seq>? ORDER BY seq LIMIT 1000', input.after).toArray().map(row => ({ seq: row.seq, ...JSON.parse(String(row.entry)) as ControlInput })) });
      case 'wraps': return Response.json({ wraps: this.sql.exec('SELECT epoch,wrap FROM wraps WHERE principal=? ORDER BY epoch', subject.principal).toArray() });
      case 'export': return Response.json({ log: this.sql.exec('SELECT seq,entry FROM log ORDER BY seq').toArray().map(row => ({ seq: row.seq, ...JSON.parse(String(row.entry)) as ControlInput })), envelopes: this.sql.exec('SELECT envelope FROM records ORDER BY seq').toArray().map(row => JSON.parse(String(row.envelope))), wraps: this.sql.exec('SELECT epoch,wrap FROM wraps WHERE principal=? ORDER BY epoch', subject.principal).toArray() }, { headers: { 'Cache-Control': 'no-store' } });
      default: return failure('invalid-request', 400); // No opaque legacy writes or remove/re-add renewal.
    }
  }
  private upgrade(state: LogState): Response { return Response.json({ error: { code: 'client-too-old' }, minClientVersion: state.minClientVersion, controlFormat: 'control-proof-v1' }, { status: 426 }); }
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
    const target = typeof proof.body.member === 'string' ? proof.body.member : typeof proof.body.id === 'string' ? proof.body.id : undefined;
    const live = replayControl(state, subject.principal, operation, target, operation === 'Add' ? next.members[(proof.body.member as Member).id]?.member : undefined, proof.type === 'grant.add' || operation === 'Add' && (proof.body.grants as string[]).includes('members.manage'), { $: proof.body.role === 'read-only' ? 'ReadOnly' : 'ReadWrite' }, now);
    if (live.transition.$ !== 'Accepted') return failure('forbidden', 403);
    const admission = input.admission;
    if (proof.type === 'member.add' && !this.admission(proof.body.member as Member, admission, subject, now)) return failure('forbidden', 403);
    if (proof.type !== 'member.add' && admission) return failure('invalid-request', 400);
    if (input.control.envelope.outside.epoch !== (proof.type === 'key.rotate' ? next.currentEpoch : state.currentEpoch)) return failure('old-epoch', 409);
    const supplied = input.wraps ?? [];
    const expected = proof.type === 'key.rotate' ? Object.keys(next.members) : proof.type === 'member.add' ? [String(proof.body.member && (proof.body.member as Member).id)] : [];
    if (supplied.length !== expected.length || new Set(supplied.map(w => w.principal)).size !== expected.length || supplied.some(w => !expected.includes(w.principal) || w.epoch !== next.currentEpoch)) return failure('invalid-request', 400);
    const removed = Object.keys(state.members).filter(id => !next.members[id]);
    this.state.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO log VALUES(?,?,?)', proof.seq, JSON.stringify(input.control), now);
      this.sql.exec('UPDATE authority SET state=?', JSON.stringify(next));
      this.sql.exec('UPDATE meta SET currentEpoch=?,nextLog=?,pendingRotation=?', next.currentEpoch, proof.seq + 1, next.pendingRotation ? 1 : 0);
      for (const id of removed) { this.sql.exec('DELETE FROM principals WHERE id=?', id); this.sql.exec('DELETE FROM reservations WHERE principal=?', id); }
      if (admission) this.sql.exec('INSERT INTO principals(id,kind,scope,accountHash,addedBy) VALUES(?,?,?,?,?)', admission.id, admission.kind, admission.scope ?? 'readwrite', admission.accountHash ?? null, admission.kind === 'agent' ? subject.principal : null);
      for (const w of supplied) this.sql.exec('INSERT INTO wraps VALUES(?,?,?)', w.principal, w.epoch, w.wrap);
    });
    return Response.json({ seq: proof.seq, memberDelta: Object.keys(next.members).length - Object.keys(state.members).length, removed, minClientVersion: next.minClientVersion }, { status: 201 });
  }
  private admission(member: Member, admission: Admission | undefined, subject: Subject, now: number): boolean {
    if (!admission || member.id !== admission.id || member.kind !== admission.kind || member.recipient !== admission.recipient || member.signingKey !== admission.signingKey) return false;
    if (member.kind === 'person') return !!admission.accountHash && (admission.support ? member.support === true && member.scope === 'read' && Date.parse(member.expiresAt ?? '') === admission.expiresAt && admission.expiresAt! > now : member.support === undefined && member.expiresAt === undefined);
    return member.addedBy === subject.principal && member.scope === admission.scope && Date.parse(member.expiresAt ?? '') === admission.expiresAt && admission.expiresAt! > now;
  }
}
