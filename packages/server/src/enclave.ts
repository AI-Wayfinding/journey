import { failure } from './types.js';
import type { EnclaveMessage, Subject } from './types.js';

type Row = Record<string, string | number | null>;
export class EnclaveObject {
  private sql: SqlStorage;
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
  }
  private one(sql: string, ...args: (string | number)[]): Row | null { return (this.sql.exec(sql, ...args).toArray()[0] as Row | undefined) ?? null; }
  private access(subject: Subject, write = false): Row | null {
    const row = this.one('SELECT id,kind,scope,expiresAt,accountHash,removedAt FROM principals WHERE id=?', subject.principal);
    if (!row || row.removedAt !== null || row.expiresAt !== null && Number(row.expiresAt) <= Date.now() || write && row.scope !== 'readwrite') return null;
    if (subject.agent ? row.kind !== 'agent' : row.kind !== 'person' || row.accountHash !== subject.accountHash) return null;
    return row;
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const input = await request.json() as EnclaveMessage;
      const now = Date.now();
      if (input.op === 'create') {
        const data = input.data;
        if (this.one('SELECT id FROM meta LIMIT 1')) return failure('conflict', 409);
        this.state.storage.transactionSync(() => {
          this.sql.exec('INSERT INTO meta(id,currentEpoch,nextSeq,nextLog,pendingRotation) VALUES(?,?,?,?,?)', data.id, 1, 1, 1, 0);
          this.sql.exec('INSERT INTO log(seq,entry,at) VALUES(0,?,?)', data.genesis, now);
          this.sql.exec('INSERT INTO principals(id,kind,scope,expiresAt,accountHash,addedBy,removedAt) VALUES(?,?,?,?,?,NULL,NULL)', data.creator.id, 'person', 'readwrite', null, data.creatorHash);
          for (const wrap of data.wraps) this.sql.exec('INSERT INTO wraps(principal,epoch,wrap) VALUES(?,?,?)', wrap.principal, wrap.epoch, wrap.wrap);
          this.sql.exec('INSERT INTO recovery_wraps(epoch,wrap) VALUES(1,?)', data.recoveryWrap);
        });
        return Response.json({ ok: true });
      }
      const meta = this.one('SELECT id,currentEpoch,nextSeq,nextLog,pendingRotation FROM meta LIMIT 1');
      if (!meta || meta.id !== input.journeyId) return failure('not-found', 404);
      const subject = input.subject as Subject;
      const write = ['reserve','recordWrite','logWrite','inviteAccess'].includes(input.op);
      if (!subject || !this.access(subject, write)) return failure('forbidden', 403);
      switch (input.op) {
        case 'access': return Response.json({ allowed: true, epoch: meta.currentEpoch });
        case 'inviteAccess': return Response.json({ allowed: true });
        case 'reserve': {
          if (Number(meta.pendingRotation)) return failure('old-epoch', 409);
          const seq = Number(meta.nextSeq);
          this.state.storage.transactionSync(() => {
            this.sql.exec('UPDATE meta SET nextSeq=?', seq + 1);
            this.sql.exec('INSERT INTO reservations(seq,principal,expires) VALUES(?,?,?)', seq, subject.principal, now + 300_000);
          });
          return Response.json({ seq, epoch: meta.currentEpoch });
        }
        case 'recordWrite': {
          const envelope = input.envelope;
          if (Number(meta.pendingRotation) || envelope.outside.epoch !== meta.currentEpoch) return failure('old-epoch', 409);
          const reservation = this.one('SELECT principal,expires FROM reservations WHERE seq=?', envelope.outside.seq!);
          if (!reservation || reservation.principal !== subject.principal || Number(reservation.expires) <= now) return failure('conflict', 409);
          this.state.storage.transactionSync(() => {
            this.sql.exec('INSERT INTO records(seq,id,epoch,size,createdAt,envelope) VALUES(?,?,?,?,?,?)', envelope.outside.seq!, envelope.outside.id, envelope.outside.epoch, envelope.outside.size, envelope.outside.createdAt, JSON.stringify(envelope));
            this.sql.exec('DELETE FROM reservations WHERE seq=?', envelope.outside.seq!);
          });
          return Response.json({ seq: envelope.outside.seq }, { status: 201 });
        }
        case 'records': {
          const after = input.after, limit = input.limit;
          const rows = this.sql.exec('SELECT envelope FROM records WHERE seq>? ORDER BY seq LIMIT ?', after, limit).toArray() as { envelope: string }[];
          return Response.json({ records: rows.map(row => JSON.parse(row.envelope)) });
        }
        case 'logWrite': {
          const changes = input.changes;
          const wraps = input.wraps;
          if (wraps && input.epoch !== Number(meta.currentEpoch) + 1) return failure('old-epoch', 409);
          const memberWraps = input.memberWraps;
          if (memberWraps?.some(w => w.epoch !== meta.currentEpoch)) return failure('old-epoch', 409);
          if (!wraps && input.epoch !== undefined) return failure('invalid-request', 400);
          let memberDelta = 0;
          this.state.storage.transactionSync(() => {
            this.sql.exec('INSERT INTO log(seq,entry,at) VALUES(?,?,?)', meta.nextLog!, input.entry, now);
            this.sql.exec('UPDATE meta SET nextLog=nextLog+1');
            for (const change of changes) {
              if (change.action === 'remove') {
                const target = this.one('SELECT kind FROM principals WHERE id=? AND removedAt IS NULL', change.principal);
                const removed = this.sql.exec('UPDATE principals SET removedAt=? WHERE id=? AND removedAt IS NULL', now, change.principal);
                memberDelta -= removed.rowsWritten;
                if (target?.kind === 'person') memberDelta -= this.sql.exec('UPDATE principals SET removedAt=? WHERE kind=? AND addedBy=? AND removedAt IS NULL', now, 'agent', change.principal).rowsWritten;
                this.sql.exec('UPDATE meta SET pendingRotation=1');
              } else {
                if (!this.one('SELECT id FROM principals WHERE id=? AND removedAt IS NULL', change.principal)) memberDelta++;
                this.sql.exec('INSERT INTO principals(id,kind,scope,expiresAt,accountHash,addedBy,removedAt) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,scope=excluded.scope,expiresAt=excluded.expiresAt,accountHash=excluded.accountHash,addedBy=excluded.addedBy,removedAt=NULL', change.principal, change.kind, change.scope, change.expiresAt ?? null, change.accountHash ?? null, change.addedBy ?? null);
              }
            }
            if (memberWraps) for (const wrap of memberWraps) {
              if (!this.one('SELECT id FROM principals WHERE id=? AND removedAt IS NULL', wrap.principal)) throw new Error('removed recipient');
              this.sql.exec('INSERT INTO wraps(principal,epoch,wrap) VALUES(?,?,?)', wrap.principal, meta.currentEpoch!, wrap.wrap);
            }
            if (wraps) {
              for (const wrap of wraps) {
                if (!this.one('SELECT id FROM principals WHERE id=? AND removedAt IS NULL', wrap.principal)) throw new Error('removed recipient');
                this.sql.exec('INSERT INTO wraps(principal,epoch,wrap) VALUES(?,?,?)', wrap.principal, input.epoch, wrap.wrap);
              }
              this.sql.exec('UPDATE meta SET currentEpoch=?,pendingRotation=0', input.epoch);
            }
          });
          return Response.json({ seq: meta.nextLog, memberDelta }, { status: 201 });
        }
        case 'log': return Response.json({ log: this.sql.exec('SELECT seq,entry FROM log WHERE seq>? ORDER BY seq LIMIT 1000', input.after).toArray() });
        case 'wraps': return Response.json({ wraps: this.sql.exec('SELECT epoch,wrap FROM wraps WHERE principal=? ORDER BY epoch', subject.principal).toArray() });
        case 'export': {
          // Emit each row independently, without materializing all ciphertext in memory.
          const sql = this.sql;
          const stream = new ReadableStream<Uint8Array>({ start(controller) {
            const encoder = new TextEncoder();
            const emit = (value: string) => controller.enqueue(encoder.encode(value));
            emit('{"log":[');
            let first = true;
            for (const row of sql.exec('SELECT seq,entry FROM log ORDER BY seq')) { emit((first ? '' : ',') + JSON.stringify(row)); first = false; }
            emit('],"envelopes":['); first = true;
            for (const row of sql.exec('SELECT envelope FROM records ORDER BY seq') as SqlStorageCursor<{ envelope: string }>) { emit((first ? '' : ',') + row.envelope); first = false; }
            emit('],"wraps":['); first = true;
            for (const row of sql.exec('SELECT epoch,wrap FROM wraps WHERE principal=? ORDER BY epoch', subject.principal)) { emit((first ? '' : ',') + JSON.stringify(row)); first = false; }
            emit(']}'); controller.close();
          } });
          return new Response(stream, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        }
        default: return failure('not-found', 404);
      }
    } catch { return failure('invalid-request', 400); }
  }
}
