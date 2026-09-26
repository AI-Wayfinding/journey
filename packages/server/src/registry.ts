import { equalSecret, randomToken } from './crypto.js';
import { failure } from './types.js';
import type { RegistryMessage } from './types.js';

type Row = Record<string, string | number | null>;
export class Registry {
  private sql: SqlStorage;
  constructor(private state: DurableObjectState) {
    this.sql = state.storage.sql;
    // SQLite class migration v1 creates the database; schema version is explicit for later migrations.
    this.sql.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    this.sql.exec('INSERT INTO schema_version(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS accounts (hash TEXT PRIMARY KEY, id TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, accountHash TEXT NOT NULL, expires INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, accountHash TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, lastUsed INTEGER NOT NULL, verifiedAt INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS challenges (sessionHash TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, accountHash TEXT NOT NULL, publicKey TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sealed_keys (accountHash TEXT PRIMARY KEY, identity TEXT NOT NULL, signing TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS journeys (id TEXT PRIMARY KEY, name TEXT NOT NULL, creatorEmail TEXT NOT NULL, creatorHash TEXT NOT NULL, created INTEGER NOT NULL, lastActive INTEGER NOT NULL, memberCount INTEGER NOT NULL, storageBytes INTEGER NOT NULL, visibility TEXT NOT NULL, mode TEXT NOT NULL, minClientVersion TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS account_principals (accountHash TEXT NOT NULL, journeyId TEXT NOT NULL, principal TEXT NOT NULL, PRIMARY KEY(accountHash,journeyId,principal))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, journeyId TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, accountHash TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS pending_principals (journeyId TEXT NOT NULL, principal TEXT PRIMARY KEY, recipient TEXT NOT NULL, signingKey TEXT NOT NULL, accountHash TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, journeyId TEXT NOT NULL, principal TEXT NOT NULL, recipient TEXT NOT NULL, signingKey TEXT NOT NULL, requestedScope TEXT NOT NULL, scope TEXT, expires INTEGER, status TEXT NOT NULL, code TEXT NOT NULL, remembered INTEGER NOT NULL)');
    if (Number(this.sql.exec('SELECT version FROM schema_version').toArray()[0]?.version) < 2) {
      this.state.storage.transactionSync(() => {
        this.sql.exec('ALTER TABLE agent_sessions ADD COLUMN createdAt INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('ALTER TABLE agent_sessions ADD COLUMN failedAttempts INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('UPDATE schema_version SET version=2');
      });
    }
    if (Number(this.sql.exec('SELECT version FROM schema_version').toArray()[0]?.version) < 3) {
      this.state.storage.transactionSync(() => {
        this.sql.exec('ALTER TABLE invites ADD COLUMN support INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('ALTER TABLE pending_principals ADD COLUMN support INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('ALTER TABLE pending_principals ADD COLUMN expires INTEGER');
        this.sql.exec('UPDATE schema_version SET version=3');
      });
    }
    if (Number(this.sql.exec('SELECT version FROM schema_version').toArray()[0]?.version) < 4) {
      this.state.storage.transactionSync(() => {
        this.sql.exec('ALTER TABLE accounts ADD COLUMN prfSalt TEXT');
        this.sql.exec('ALTER TABLE sealed_keys ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
        // The old two-credential format cannot open with the new single-credential key.
        this.sql.exec('DELETE FROM sealed_keys');
        this.sql.exec('DELETE FROM credentials');
        this.sql.exec('UPDATE sessions SET verifiedAt=NULL');
        this.sql.exec('UPDATE schema_version SET version=4');
      });
    }
    if (Number(this.sql.exec('SELECT version FROM schema_version').toArray()[0]?.version) < 5) {
      this.state.storage.transactionSync(() => {
        // The verified address travels with the sign-in token and session so journey creation needs no retyping.
        this.sql.exec('ALTER TABLE tokens ADD COLUMN email TEXT');
        this.sql.exec('ALTER TABLE sessions ADD COLUMN email TEXT');
        this.sql.exec('UPDATE schema_version SET version=5');
      });
    }
    if (Number(this.sql.exec('SELECT version FROM schema_version').toArray()[0]?.version) < 6) {
      this.state.storage.transactionSync(() => {
        // Plain account email so a returning person can continue with a passkey alone.
        this.sql.exec('ALTER TABLE accounts ADD COLUMN email TEXT');
        this.sql.exec('UPDATE schema_version SET version=6');
      });
    }
    if (Number(this.sql.exec('SELECT version FROM schema_version').toArray()[0]?.version) < 7) {
      this.state.storage.transactionSync(() => {
        this.sql.exec('ALTER TABLE sessions ADD COLUMN migrationAllowed INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('UPDATE schema_version SET version=7');
      });
    }
    this.sql.exec('CREATE TABLE IF NOT EXISTS nonces (sessionId TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(sessionId,nonce))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS rates (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL)');
  }
  private one(query: string, ...args: (string | number)[]): Row | null { return (this.sql.exec(query, ...args).toArray()[0] as Row | undefined) ?? null; }
  async fetch(request: Request): Promise<Response> {
    try {
      const input = await request.json() as RegistryMessage;
      const now = Date.now();
      const result = await this.state.storage.transaction(async () => {
        switch (input.op) {
          case 'emailStart': {
            this.sql.exec('DELETE FROM rates WHERE start<?', now - 60_000);
            this.sql.exec('DELETE FROM tokens WHERE expires<=?', now);
            // Identical lookup and token issuance for existing and new addresses; no account lookup here.
            const allowed = (key: string, limit: number) => {
              const row = this.one('SELECT start,count FROM rates WHERE key=?', key);
              const start = row && Number(row.start) + 60_000 > now ? Number(row.start) : now;
              const count = row && start === Number(row.start) ? Number(row.count) + 1 : 1;
              this.sql.exec('INSERT INTO rates(key,start,count) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET start=excluded.start,count=excluded.count', key, start, count);
              return count <= limit;
            };
            const ipAllowed = allowed('ip:' + input.ipHash, 10);
            const emailAllowed = allowed('email:' + input.emailHash, 5);
            if (!ipAllowed || !emailAllowed) return { allowed: false };
            this.sql.exec('INSERT INTO tokens(hash,accountHash,expires,email) VALUES(?,?,?,?)', input.tokenHash, input.emailHash, now + 900_000, input.email);
            return { allowed: true };
          }
          case 'emailVerify': {
            const row = this.one('SELECT accountHash,expires,email FROM tokens WHERE hash=?', input.tokenHash);
            if (!row || Number(row.expires) <= now) return null;
            this.sql.exec('DELETE FROM tokens WHERE hash=?', input.tokenHash);
            const hash = String(row.accountHash);
            let account = this.one('SELECT id FROM accounts WHERE hash=?', hash);
            const needsRegistration = !account || !this.one('SELECT id FROM credentials WHERE accountHash=? LIMIT 1', hash);
            if (!account) { this.sql.exec('INSERT INTO accounts(hash,id) VALUES(?,?)', hash, randomToken(16)); account = this.one('SELECT id FROM accounts WHERE hash=?', hash); }
            if (row.email) this.sql.exec('UPDATE accounts SET email=? WHERE hash=?', row.email, hash);
            this.sql.exec('INSERT INTO sessions(hash,accountHash,created,expires,lastUsed,verifiedAt,email) VALUES(?,?,?,?,?,NULL,?)', input.sessionHash, hash, now, now + 43_200_000, now, row.email ?? null);
            return { accountHash: hash, accountId: account!.id, newAccount: needsRegistration };
          }
          case 'session': {
            const row = this.one('SELECT accountHash,expires,verifiedAt,email FROM sessions WHERE hash=?', input.hash);
            if (!row || Number(row.expires) <= now) return null;
            this.sql.exec('UPDATE sessions SET lastUsed=? WHERE hash=?', now, input.hash);
            return { accountHash: row.accountHash, verifiedAt: row.verifiedAt, email: row.email ?? null };
          }
          case 'logout': this.sql.exec('DELETE FROM sessions WHERE hash=?', input.hash); return { ok: true };
          case 'credentials': return this.sql.exec('SELECT id,publicKey,counter,transports FROM credentials WHERE accountHash=?', input.accountHash).toArray();
          case 'legacySalt': return this.one('SELECT prfSalt FROM accounts WHERE hash=?', input.accountHash);
          case 'keysGet': return this.one('SELECT version,identity,signing FROM sealed_keys WHERE accountHash=? AND version=1', input.accountHash);
          case 'keysPut': {
            if (input.migrate && (!input.sessionHash || !this.one('SELECT hash FROM sessions WHERE hash=? AND accountHash=? AND migrationAllowed=1', input.sessionHash, input.accountHash))) return null;
            this.sql.exec('INSERT INTO sealed_keys(accountHash,version,identity,signing) VALUES(?,?,?,?) ON CONFLICT(accountHash) DO UPDATE SET version=excluded.version,identity=excluded.identity,signing=excluded.signing', input.accountHash, input.version, input.identity, input.signing);
            if (input.migrate) this.sql.exec('UPDATE accounts SET prfSalt=NULL WHERE hash=?', input.accountHash);
            return { ok: true };
          }
          case 'credential': return this.one('SELECT id,accountHash,publicKey,counter,transports FROM credentials WHERE id=? AND accountHash=?', input.id, input.accountHash);
          case 'credentialById': return this.one('SELECT c.id,c.accountHash,c.publicKey,c.counter,c.transports,a.email,a.prfSalt FROM credentials c JOIN accounts a ON a.hash=c.accountHash WHERE c.id=?', input.id);
          case 'challengeSet': this.sql.exec('INSERT INTO challenges(sessionHash,challenge,kind,expires) VALUES(?,?,?,?) ON CONFLICT(sessionHash) DO UPDATE SET challenge=excluded.challenge,kind=excluded.kind,expires=excluded.expires', input.sessionHash, input.challenge, input.kind, now + 300_000); return { ok: true };
          case 'challengeTake': {
            const row = this.one('SELECT challenge,kind,expires FROM challenges WHERE sessionHash=?', input.sessionHash);
            this.sql.exec('DELETE FROM challenges WHERE sessionHash=?', input.sessionHash);
            return row && row.kind === input.kind && Number(row.expires) > now ? row : null;
          }
          case 'credentialAdd': {
            if (this.one('SELECT id FROM credentials WHERE accountHash=? LIMIT 1', input.accountHash)) return null;
            this.sql.exec('INSERT INTO sealed_keys(accountHash,version,identity,signing) VALUES(?,?,?,?)', input.accountHash, 1, input.identity, input.signing);
            this.sql.exec('INSERT INTO credentials(id,accountHash,publicKey,counter,transports) VALUES(?,?,?,?,?)', input.id, input.accountHash, input.publicKey, input.counter, input.transports);
            this.sql.exec('UPDATE sessions SET verifiedAt=? WHERE hash=?', now, input.sessionHash);
            return { ok: true };
          }
          case 'credentialUse': {
            const updated = this.sql.exec('UPDATE credentials SET counter=? WHERE id=? AND accountHash=? AND (counter<? OR counter=0 AND ?=0)', input.counter, input.id, input.accountHash, input.counter, input.counter);
            if (updated.rowsWritten !== 1) return null;
            this.sql.exec('UPDATE sessions SET verifiedAt=?,migrationAllowed=(SELECT prfSalt IS NOT NULL FROM accounts WHERE hash=?) WHERE hash=?', now, input.accountHash, input.sessionHash); return { ok: true };
          }
          case 'passkeySession': {
            const updated = this.sql.exec('UPDATE credentials SET counter=? WHERE id=? AND accountHash=? AND (counter<? OR counter=0 AND ?=0)', input.counter, input.id, input.accountHash, input.counter, input.counter);
            if (updated.rowsWritten !== 1) return null;
            const account = this.one('SELECT email,prfSalt FROM accounts WHERE hash=?', input.accountHash);
            if (!account?.email || account.prfSalt) return null;
            this.sql.exec('INSERT INTO sessions(hash,accountHash,created,expires,lastUsed,verifiedAt,email) VALUES(?,?,?,?,?,?,?)', input.sessionHash, input.accountHash, now, now + 43_200_000, now, now, account.email);
            return { ok: true };
          }
          case 'journeyCreate': {
            const data = input.data;
            this.sql.exec('INSERT INTO journeys(id,name,creatorEmail,creatorHash,created,lastActive,memberCount,storageBytes,visibility,mode,minClientVersion) VALUES(?,?,?,?,?,?,?,?,?,?,?)', data.id, data.name, data.creatorEmail, data.creatorHash, now, now, 1, 0, 'private', 'sealed', data.minClientVersion);
            this.sql.exec('INSERT INTO account_principals(accountHash,journeyId,principal) VALUES(?,?,?)', data.creatorHash, data.id, data.creator.id); return { ok: true };
          }
          case 'journeyDelete': this.sql.exec('DELETE FROM journeys WHERE id=?', input.id); this.sql.exec('DELETE FROM account_principals WHERE journeyId=?', input.id); return { ok: true };
          case 'journeys': return this.sql.exec('SELECT j.id,j.name,j.created,j.lastActive,j.memberCount,j.storageBytes,j.visibility,j.mode,j.minClientVersion,p.principal FROM journeys j JOIN account_principals p ON p.journeyId=j.id WHERE p.accountHash=?', input.accountHash).toArray();
          case 'registry': return this.sql.exec('SELECT id,name,creatorEmail,created,lastActive,memberCount,storageBytes,visibility,mode,minClientVersion FROM journeys').toArray();
          case 'link': this.sql.exec('INSERT OR IGNORE INTO account_principals(accountHash,journeyId,principal) VALUES(?,?,?)', input.accountHash, input.journeyId, input.principal); return { ok: true };
          case 'activity': this.sql.exec('UPDATE journeys SET lastActive=?,memberCount=MAX(0,memberCount+?),storageBytes=MAX(0,storageBytes+?) WHERE id=?', now, input.memberDelta, input.bytes, input.id); return { ok: true };
          case 'inviteCreate': this.sql.exec('INSERT INTO invites(hash,journeyId,expires,support) VALUES(?,?,?,?)', input.hash, input.journeyId, input.expires, input.support ? 1 : 0); return { ok: true };
          case 'inviteRate': {
            const key = `invite:${input.journeyId}:${input.accountHash}`;
            const row = this.one('SELECT start,count FROM rates WHERE key=?', key);
            const start = row && Number(row.start) + 60_000 > now ? Number(row.start) : now;
            const count = row && start === Number(row.start) ? Number(row.count) + 1 : 1;
            this.sql.exec('INSERT INTO rates(key,start,count) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET start=excluded.start,count=excluded.count', key, start, count);
            return { allowed: count <= 5 };
          }
          case 'inviteTake': {
            const row = this.one('SELECT journeyId,expires,support FROM invites WHERE hash=? AND expires>? AND used=0', input.hash, now);
            if (!row) return null;
            this.sql.exec('UPDATE invites SET used=1,accountHash=? WHERE hash=? AND used=0', input.accountHash, input.hash);
            this.sql.exec('INSERT INTO pending_principals(journeyId,principal,recipient,signingKey,accountHash,support,expires) VALUES(?,?,?,?,?,?,?)', row.journeyId!, input.principal, input.recipient, input.signingKey, input.accountHash, row.support!, row.support ? row.expires! : null);
            return { journeyId: row.journeyId };
          }
          case 'invitePending': return this.sql.exec('SELECT principal,recipient,signingKey,support,expires FROM pending_principals WHERE journeyId=?', input.journeyId).toArray();
          case 'pendingGet': return this.one('SELECT accountHash,support,expires FROM pending_principals WHERE journeyId=? AND principal=?', input.journeyId, input.principal);
          case 'pendingDelete': this.sql.exec('DELETE FROM pending_principals WHERE journeyId=? AND principal=?', input.journeyId, input.principal); return { ok: true };
          case 'agentCreate': {
            this.sql.exec('INSERT INTO agent_sessions(id,journeyId,principal,recipient,signingKey,requestedScope,status,code,remembered,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)', input.id, input.journeyId, input.principal, input.recipient, input.signingKey, input.requestedScope, 'pending', input.code, input.remembered ? 1 : 0, now);
            return { ok: true };
          }
          case 'agentGet': return this.one('SELECT id,journeyId,principal,recipient,signingKey,requestedScope,scope,expires,status,remembered,createdAt FROM agent_sessions WHERE id=?', input.id);
          case 'agentAttempt': {
            const row = this.one('SELECT code,status,createdAt,failedAttempts FROM agent_sessions WHERE id=?', input.id);
            if (!row || row.status !== 'pending' || Number(row.createdAt) + 600_000 <= now) return { matched: false, available: false };
            if (equalSecret(input.code, String(row.code))) return { matched: true, available: true };
            const attempts = Number(row.failedAttempts) + 1;
            this.sql.exec('UPDATE agent_sessions SET failedAttempts=?,status=? WHERE id=?', attempts, attempts >= 5 ? 'locked' : 'pending', input.id);
            return { matched: false, available: true };
          }
          case 'agentApprove': {
            const row = this.one('SELECT status,createdAt FROM agent_sessions WHERE id=?', input.id);
            if (!row || row.status !== 'pending' || Number(row.createdAt) + 600_000 <= now) return null;
            this.sql.exec('UPDATE agent_sessions SET scope=?,expires=?,status=? WHERE id=?', input.scope, input.expires, 'approved', input.id); return { ok: true };
          }
          case 'nonce': {
            this.sql.exec('DELETE FROM nonces WHERE expires<=?', now);
            if (this.one('SELECT nonce FROM nonces WHERE sessionId=? AND nonce=?', input.id, input.nonce)) return null;
            this.sql.exec('INSERT INTO nonces(sessionId,nonce,expires) VALUES(?,?,?)', input.id, input.nonce, now + 60_000); return { ok: true };
          }
          default: return null;
        }
      });
      return Response.json(result);
    } catch { return failure('conflict', 409); }
  }
}
