import { equalSecret, randomToken } from './crypto.js';
import { failure } from './types.js';
import type { RegistryMessage } from './types.js';

type Row = Record<string, string | number | null>;
export class Registry {
  private sql: SqlStorage;
  constructor(private state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS accounts (hash TEXT PRIMARY KEY, id TEXT NOT NULL, email TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, accountHash TEXT NOT NULL, expires INTEGER NOT NULL, email TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, accountHash TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, lastUsed INTEGER NOT NULL, verifiedAt INTEGER, email TEXT, recovery INTEGER NOT NULL DEFAULT 0, credentialId TEXT, recoveryIdentity TEXT, recoverySigning TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS challenges (sessionHash TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, accountHash TEXT NOT NULL, publicKey TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, lastUsed INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sealed_keys (credentialId TEXT PRIMARY KEY, identity TEXT NOT NULL, signing TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS backup_codes (verifierHash TEXT PRIMARY KEY, accountHash TEXT NOT NULL, identity TEXT NOT NULL, signing TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS journeys (id TEXT PRIMARY KEY, name TEXT NOT NULL, creatorEmail TEXT NOT NULL, creatorHash TEXT NOT NULL, created INTEGER NOT NULL, lastActive INTEGER NOT NULL, memberCount INTEGER NOT NULL, storageBytes INTEGER NOT NULL, visibility TEXT NOT NULL, mode TEXT NOT NULL, minClientVersion TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS account_principals (accountHash TEXT NOT NULL, journeyId TEXT NOT NULL, principal TEXT NOT NULL, PRIMARY KEY(accountHash,journeyId,principal))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, journeyId TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, accountHash TEXT, support INTEGER NOT NULL DEFAULT 0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS pending_principals (journeyId TEXT NOT NULL, principal TEXT PRIMARY KEY, recipient TEXT NOT NULL, signingKey TEXT NOT NULL, accountHash TEXT NOT NULL, support INTEGER NOT NULL DEFAULT 0, expires INTEGER)');
    this.sql.exec("CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, journeyId TEXT NOT NULL, principal TEXT NOT NULL, recipient TEXT NOT NULL, signingKey TEXT NOT NULL, requestedScope TEXT NOT NULL, scope TEXT, expires INTEGER, status TEXT NOT NULL, code TEXT NOT NULL, remembered INTEGER NOT NULL, createdAt INTEGER NOT NULL DEFAULT 0, failedAttempts INTEGER NOT NULL DEFAULT 0, name TEXT, keyStorage TEXT NOT NULL DEFAULT 'memory')");
    if (!this.sql.exec('PRAGMA table_info(agent_sessions)').toArray().some(column => column.name === 'name')) this.sql.exec('ALTER TABLE agent_sessions ADD COLUMN name TEXT');
    if (!this.sql.exec('PRAGMA table_info(agent_sessions)').toArray().some(column => column.name === 'keyStorage')) this.sql.exec("ALTER TABLE agent_sessions ADD COLUMN keyStorage TEXT NOT NULL DEFAULT 'memory'");
    // An agent link keeps only the sealed identity and a hash of the secret; the secret itself lives only in the link.
    this.sql.exec('CREATE TABLE IF NOT EXISTS agent_links (hash TEXT PRIMARY KEY, journeyId TEXT NOT NULL, memberId TEXT NOT NULL UNIQUE, addedBy TEXT NOT NULL, blob TEXT NOT NULL, expires INTEGER NOT NULL, since INTEGER NOT NULL, created INTEGER NOT NULL, rateStart INTEGER NOT NULL DEFAULT 0, rateCount INTEGER NOT NULL DEFAULT 0)');
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
            this.sql.exec('INSERT INTO sessions(hash,accountHash,created,expires,lastUsed,verifiedAt,email) VALUES(?,?,?,?,?,NULL,?)', input.sessionHash, hash, now, now + 2_592_000_000, now, row.email ?? null);
            return { accountHash: hash, accountId: account!.id, newAccount: needsRegistration };
          }
          case 'session': {
            const row = this.one('SELECT accountHash,expires,verifiedAt,email,recovery,credentialId,recoveryIdentity,recoverySigning FROM sessions WHERE hash=?', input.hash);
            if (!row || Number(row.expires) <= now) return null;
            this.sql.exec('UPDATE sessions SET lastUsed=? WHERE hash=?', now, input.hash);
            return { accountHash: row.accountHash, verifiedAt: row.verifiedAt, email: row.email ?? null, recovery: row.recovery === 1, credentialId: row.credentialId ?? null, recoveryIdentity: row.recoveryIdentity ?? null, recoverySigning: row.recoverySigning ?? null };
          }
          case 'logout': this.sql.exec('DELETE FROM sessions WHERE hash=?', input.hash); return { ok: true };
          case 'credentials': return this.sql.exec('SELECT id,publicKey,counter,transports,name,created,lastUsed FROM credentials WHERE accountHash=? ORDER BY created', input.accountHash).toArray();
          case 'keysGet': return input.recovery ? this.one('SELECT 1 AS version,recoveryIdentity AS identity,recoverySigning AS signing FROM sessions WHERE hash=? AND accountHash=? AND recovery=1', input.sessionHash, input.accountHash) : this.one('SELECT 1 AS version,k.identity,k.signing FROM sealed_keys k JOIN credentials c ON c.id=k.credentialId WHERE k.credentialId=? AND c.accountHash=?', input.credentialId, input.accountHash);
          case 'credential': return this.one('SELECT id,accountHash,publicKey,counter,transports FROM credentials WHERE id=? AND accountHash=?', input.id, input.accountHash);
          case 'credentialById': return this.one('SELECT c.id,c.accountHash,c.publicKey,c.counter,c.transports,a.email FROM credentials c JOIN accounts a ON a.hash=c.accountHash WHERE c.id=?', input.id);
          case 'credentialRemove': {
            if (!this.one('SELECT id FROM credentials WHERE id=? AND accountHash=?', input.id, input.accountHash) || Number(this.one('SELECT COUNT(*) AS count FROM credentials WHERE accountHash=?', input.accountHash)?.count) <= 1) return null;
            this.sql.exec('DELETE FROM sealed_keys WHERE credentialId=?', input.id);
            this.sql.exec('DELETE FROM credentials WHERE id=? AND accountHash=?', input.id, input.accountHash);
            this.sql.exec('UPDATE sessions SET verifiedAt=NULL,credentialId=NULL WHERE accountHash=? AND credentialId=?', input.accountHash, input.id);
            return { ok: true };
          }
          case 'backupCount': return Number(this.one('SELECT COUNT(*) AS count FROM backup_codes WHERE accountHash=?', input.accountHash)?.count);
          case 'backupReplace': {
            this.sql.exec('DELETE FROM backup_codes WHERE accountHash=?', input.accountHash);
            for (const code of input.codes) this.sql.exec('INSERT INTO backup_codes(verifierHash,accountHash,identity,signing) VALUES(?,?,?,?)', code.verifierHash, input.accountHash, code.identity, code.signing);
            return { ok: true };
          }
          case 'backupRedeem': {
            this.sql.exec('DELETE FROM rates WHERE start<?', now - 60_000);
            const allowed = (key: string, limit: number) => {
              const row = this.one('SELECT start,count FROM rates WHERE key=?', key);
              const start = row && Number(row.start) + 60_000 > now ? Number(row.start) : now;
              const count = row && start === Number(row.start) ? Number(row.count) + 1 : 1;
              this.sql.exec('INSERT INTO rates(key,start,count) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET start=excluded.start,count=excluded.count', key, start, count);
              return count <= limit;
            };
            const ipAllowed = allowed('backup-ip:' + input.ipHash, 10);
            const lookupAllowed = allowed('backup-code:' + input.verifierHash, 5);
            if (!ipAllowed || !lookupAllowed) return { status: 'rate-limited' };
            const code = this.one('SELECT accountHash,identity,signing FROM backup_codes WHERE verifierHash=?', input.verifierHash);
            if (!code) return null;
            this.sql.exec('DELETE FROM backup_codes WHERE verifierHash=?', input.verifierHash);
            this.sql.exec('INSERT INTO sessions(hash,accountHash,created,expires,lastUsed,verifiedAt,email,recovery,recoveryIdentity,recoverySigning) VALUES(?,?,?,?,?,NULL,NULL,1,?,?)', input.sessionHash, code.accountHash!, now, now + 600_000, now, code.identity!, code.signing!);
            return { ok: true };
          }
          case 'challengeSet': this.sql.exec('INSERT INTO challenges(sessionHash,challenge,kind,expires) VALUES(?,?,?,?) ON CONFLICT(sessionHash) DO UPDATE SET challenge=excluded.challenge,kind=excluded.kind,expires=excluded.expires', input.sessionHash, input.challenge, input.kind, now + 300_000); return { ok: true };
          case 'challengeTake': {
            const row = this.one('SELECT challenge,kind,expires FROM challenges WHERE sessionHash=?', input.sessionHash);
            this.sql.exec('DELETE FROM challenges WHERE sessionHash=?', input.sessionHash);
            return row && row.kind === input.kind && Number(row.expires) > now ? row : null;
          }
          case 'credentialAdd': {
            const current = this.one('SELECT recovery,verifiedAt FROM sessions WHERE hash=? AND accountHash=?', input.sessionHash, input.accountHash);
            if (!current || !current.recovery && this.one('SELECT id FROM credentials WHERE accountHash=? LIMIT 1', input.accountHash) && (current.verifiedAt === null || Number(current.verifiedAt) < now - 300_000)) return null;
            this.sql.exec('INSERT INTO sealed_keys(credentialId,identity,signing) VALUES(?,?,?)', input.id, input.identity, input.signing);
            this.sql.exec('INSERT INTO credentials(id,accountHash,publicKey,counter,transports,name,created) VALUES(?,?,?,?,?,?,?)', input.id, input.accountHash, input.publicKey, input.counter, input.transports, 'Passkey added ' + new Date(now).toLocaleDateString('en-GB', { timeZone: 'UTC' }), now);
            this.sql.exec('UPDATE sessions SET verifiedAt=?,credentialId=?,recovery=0,recoveryIdentity=NULL,recoverySigning=NULL,expires=?,email=(SELECT email FROM accounts WHERE hash=?) WHERE hash=?', now, input.id, now + 2_592_000_000, input.accountHash, input.sessionHash);
            return { ok: true };
          }
          case 'credentialUse': {
            const updated = this.sql.exec('UPDATE credentials SET counter=?,lastUsed=? WHERE id=? AND accountHash=? AND (counter<? OR counter=0 AND ?=0)', input.counter, now, input.id, input.accountHash, input.counter, input.counter);
            if (updated.rowsWritten !== 1) return null;
            this.sql.exec('UPDATE sessions SET verifiedAt=?,credentialId=? WHERE hash=? AND accountHash=? AND recovery=0', now, input.id, input.sessionHash, input.accountHash); return { ok: true };
          }
          case 'passkeySession': {
            const updated = this.sql.exec('UPDATE credentials SET counter=?,lastUsed=? WHERE id=? AND accountHash=? AND (counter<? OR counter=0 AND ?=0)', input.counter, now, input.id, input.accountHash, input.counter, input.counter);
            if (updated.rowsWritten !== 1) return null;
            const account = this.one('SELECT email FROM accounts WHERE hash=?', input.accountHash);
            if (!account?.email) return null;
            this.sql.exec('INSERT INTO sessions(hash,accountHash,created,expires,lastUsed,verifiedAt,email,credentialId) VALUES(?,?,?,?,?,?,?,?)', input.sessionHash, input.accountHash, now, now + 2_592_000_000, now, now, account.email, input.id);
            return { ok: true };
          }
          case 'journeyCreate': {
            const data = input.data;
            this.sql.exec('INSERT INTO journeys(id,name,creatorEmail,creatorHash,created,lastActive,memberCount,storageBytes,visibility,mode,minClientVersion) VALUES(?,?,?,?,?,?,?,?,?,?,?)', data.id, data.name, data.creatorEmail, data.creatorHash, now, now, 1, 0, 'private', 'sealed', data.minClientVersion);
            this.sql.exec('INSERT INTO account_principals(accountHash,journeyId,principal) VALUES(?,?,?)', data.creatorHash, data.id, data.creator.id); return { ok: true };
          }
          case 'journeyDelete': this.sql.exec('DELETE FROM journeys WHERE id=?', input.id); this.sql.exec('DELETE FROM account_principals WHERE journeyId=?', input.id); this.sql.exec('DELETE FROM agent_links WHERE journeyId=?', input.id); return { ok: true };
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
            this.sql.exec('INSERT INTO agent_sessions(id,journeyId,principal,recipient,signingKey,requestedScope,status,code,remembered,createdAt,name,keyStorage) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', input.id, input.journeyId, input.principal, input.recipient, input.signingKey, input.requestedScope, 'pending', input.code, input.remembered ? 1 : 0, now, input.name, input.keyStorage);
            return { ok: true };
          }
          case 'agentGet': return this.one('SELECT id,journeyId,principal,recipient,signingKey,requestedScope,scope,expires,status,remembered,createdAt,name,keyStorage FROM agent_sessions WHERE id=?', input.id);
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
          case 'linkCreate': {
            if (this.one('SELECT hash FROM agent_links WHERE memberId=? OR hash=?', input.memberId, input.hash)) return null;
            this.sql.exec('INSERT INTO agent_links(hash,journeyId,memberId,addedBy,blob,expires,since,created) VALUES(?,?,?,?,?,?,?,?)', input.hash, input.journeyId, input.memberId, input.addedBy, input.blob, input.expires, now, now);
            return { ok: true };
          }
          case 'linkGet': {
            const row = this.one('SELECT hash,journeyId,memberId,addedBy,blob,expires,since,rateStart,rateCount FROM agent_links WHERE hash=?', input.hash);
            if (!row) return null;
            const windowMs = 3_600_000;
            const start = Number(row.rateStart) + windowMs > now ? Number(row.rateStart) : now;
            const count = start === Number(row.rateStart) ? Number(row.rateCount) + 1 : 1;
            this.sql.exec('UPDATE agent_links SET rateStart=?,rateCount=? WHERE hash=?', start, count, input.hash);
            if (count > input.limit) return { limited: true, retryAfter: Math.max(1, Math.ceil((start + windowMs - now) / 1000)), journeyId: row.journeyId, memberId: row.memberId };
            return { limited: false, journeyId: row.journeyId, memberId: row.memberId, blob: row.blob, expires: row.expires, since: row.since };
          }
          case 'linkList': return this.sql.exec('SELECT memberId,addedBy,expires,created FROM agent_links WHERE journeyId=? ORDER BY created', input.journeyId).toArray();
          case 'linkRenew': {
            const changed = this.sql.exec('UPDATE agent_links SET expires=?,since=? WHERE journeyId=? AND memberId=?', input.expires, now, input.journeyId, input.memberId).rowsWritten;
            this.sql.exec('UPDATE agent_sessions SET expires=? WHERE journeyId=? AND principal=?', input.expires, input.journeyId, input.memberId);
            return changed ? { ok: true } : null;
          }
          case 'linkRevoke': {
            for (const principal of input.principals) this.sql.exec('DELETE FROM agent_links WHERE journeyId=? AND (memberId=? OR addedBy=?)', input.journeyId, principal, principal);
            return { ok: true };
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
