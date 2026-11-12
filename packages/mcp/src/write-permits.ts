import * as z from 'zod';
import { actorSchema, type Actor } from './agents.ts';
import { Refused, type ToolData } from './commands.ts';
import type { KeyValueStorage, StorageTurn } from './storage.ts';
import type { BlobStore } from './relay.ts';

export const WRITE_TTL_MS = 30_000;
const id = z.string().min(1).max(200);
export const writePermitSchema = z.object({ id, personId: id, target: id, digest: id, epoch: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(), audienceEpochs: z.array(z.object({personId:id,epoch:z.number().int().nonnegative()}).strict()).max(128).optional() }).strict();
export type WritePermit = z.infer<typeof writePermitSchema>;
export const writeRequestSchema = z.object({ target: id, digest: id, actor: actorSchema, deviceIds:z.array(id).max(128).optional(), audiencePersonIds:z.array(id).max(128).optional() }).strict();
export type WriteRequest = z.infer<typeof writeRequestSchema>;
export const writeReceiptSchema = z.object({ permit: writePermitSchema, outcome: z.enum(['committed', 'cancelled']) }).strict();
export type WriteReceipt = z.infer<typeof writeReceiptSchema>;
export interface WritePort {
  issueWrite(request: WriteRequest): Promise<WritePermit>;
  redeemWrite(permit: WritePermit): Promise<void>;
  settleWrite(receipt: WriteReceipt): Promise<void>;
}
export interface WriteDrain { state: 'pending' | 'complete'; permits: WritePermit[]; retryAt?: number }
interface Scope { personId: string; fingerprint: string; epoch: number }
interface AuthorityPermit { permit: WritePermit; phase: 'issued' | 'redeemed' | 'committed' | 'cancelled' }
interface AuthorityState { scopes: Scope[]; permits: AuthorityPermit[] }
interface AuthorityAccount { personId: string; live: boolean; bindings: unknown; group?:unknown; agents: { id: string; live: boolean; card: unknown }[] }
function fingerprint(a: AuthorityAccount): string { return JSON.stringify([a.live, a.bindings, a.group, a.agents.map(g => [g.id, g.live, g.card])]); }
function samePermit(a: WritePermit, b: WritePermit): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** Called only within Accounts' serial turn. Authority and epoch changes share one transaction. */
export class WriteAuthority {
  private readonly storage: KeyValueStorage;
  private readonly now: () => number;
  constructor(storage: KeyValueStorage, now: () => number) { this.storage = storage; this.now = now; }
  private async load(): Promise<AuthorityState> {
    const raw = await this.storage.get('write:authority');
    try { return typeof raw === 'string' ? JSON.parse(raw) as AuthorityState : { scopes: [], permits: [] }; }
    catch { throw new Refused('Invalid stored write authority'); }
  }
  private expire(state: AuthorityState): void {
    for (const p of state.permits) if (p.phase === 'issued' && p.permit.expiresAt <= this.now()) p.phase = 'cancelled';
    // A redeemed permit is NEVER expired without a receiver receipt, even after its TTL.
    // Terminal receipts live under individual keys; only unresolved rows stay in the index.
  }
  async saveAccounts(value: string, accounts: AuthorityAccount[]): Promise<void> {
    const state = await this.load();
    for (const scope of state.scopes) {
      const account = accounts.find(a => a.personId === scope.personId), next = account ? fingerprint(account) : 'removed';
      if (next === scope.fingerprint) continue;
      scope.fingerprint = next; scope.epoch++;
      for (const p of state.permits) if ((p.permit.personId === scope.personId || p.permit.audienceEpochs?.some(e=>e.personId===scope.personId)) && p.phase === 'issued') p.phase = 'cancelled';
    }
    await this.save(state, value);
  }
  private async save(state: AuthorityState, accounts?: string): Promise<void> {
    this.expire(state);
    const terminal = state.permits.filter(p => p.phase === 'committed' || p.phase === 'cancelled');
    state.permits = state.permits.filter(p => p.phase === 'issued' || p.phase === 'redeemed');
    await this.storage.transaction(async tx => {
      if (accounts !== undefined) await tx.put('accounts', accounts);
      for (const row of terminal) await tx.put(`write:terminal:${row.permit.id}`, JSON.stringify({ permit: row.permit, outcome: row.phase }));
      if (state.scopes.length) await tx.put('write:authority', JSON.stringify(state));
    });
  }
  async issue(supplied: WriteRequest, accounts: AuthorityAccount[], current: Actor): Promise<WritePermit> {
    const request = writeRequestSchema.parse(supplied), expected = request.actor;
    if (current.personId !== expected.personId || current.agent?.id !== expected.agent?.id || JSON.stringify(current.agent?.card) !== JSON.stringify(expected.agent?.card)) throw new Refused('Write authority changed; reload before retrying');
    const account = accounts.find(a => a.personId === current.personId && a.live);
    if (!account) throw new Refused('Live account required');
    const state = await this.load(); this.expire(state);
    let scope = state.scopes.find(s => s.personId === account.personId);
    if (!scope) { scope = { personId: account.personId, fingerprint: fingerprint(account), epoch: 0 }; state.scopes.push(scope); }
    if (state.permits.some(p => p.permit.personId === account.personId && p.phase === 'redeemed' && p.permit.epoch !== scope.epoch)) throw new Refused('Revocation pending: write receipts must be recovered');
    if (state.permits.filter(p => p.permit.personId === account.personId && (p.phase === 'issued' || p.phase === 'redeemed')).length >= 128) throw new Refused('Write permit capacity reached');
    const audienceEpochs = [...new Set(request.audiencePersonIds ?? [])].map(personId=>{
      const a=accounts.find(a=>a.personId===personId&&a.live); if(!a)throw new Refused('Audience account is not live');
      let s=state.scopes.find(s=>s.personId===personId);if(!s){s={personId,fingerprint:fingerprint(a),epoch:0};state.scopes.push(s);}
      if(state.permits.some(p=>p.phase==='redeemed'&&p.permit.audienceEpochs?.some(e=>e.personId===personId&&e.epoch!==s!.epoch)))throw new Refused('Audience revocation pending');
      return {personId,epoch:s.epoch};
    });
    const permit: WritePermit = { id: crypto.randomUUID(), personId: account.personId, target: request.target, digest: request.digest, epoch: scope.epoch, expiresAt: this.now() + WRITE_TTL_MS, ...(audienceEpochs.length?{audienceEpochs}:{}) };
    state.permits.push({ permit, phase: 'issued' });
    await this.save(state);
    return permit;
  }
  async redeem(supplied: WritePermit): Promise<void> {
    const permit = writePermitSchema.parse(supplied), state = await this.load(); this.expire(state);
    const found = state.permits.find(p => p.permit.id === permit.id), scope = state.scopes.find(s => s.personId === permit.personId);
    if (!found || !samePermit(found.permit, permit) || found.phase !== 'issued' || scope?.epoch !== permit.epoch || permit.audienceEpochs?.some(e=>state.scopes.find(s=>s.personId===e.personId)?.epoch!==e.epoch) || permit.expiresAt <= this.now()) throw new Refused('Write permit revoked, expired or already redeemed');
    found.phase = 'redeemed';
    await this.save(state);
  }
  async settle(supplied: WriteReceipt): Promise<void> {
    const receipt = writeReceiptSchema.parse(supplied), state = await this.load(), found = state.permits.find(p => p.permit.id === receipt.permit.id);
    if (!found) {
      const raw = await this.storage.get(`write:terminal:${receipt.permit.id}`);
      let previous: WriteReceipt | undefined;
      try { previous = typeof raw === 'string' ? writeReceiptSchema.parse(JSON.parse(raw)) : undefined; }
      catch { throw new Refused('Invalid stored terminal write receipt'); }
      if (!previous || !samePermit(previous.permit, receipt.permit)) throw new Refused('Write receipt mismatch');
      if (previous.outcome !== receipt.outcome) throw new Refused('Conflicting terminal write receipt');
      return;
    }
    if (!samePermit(found.permit, receipt.permit)) throw new Refused('Write receipt mismatch');
    if (found.phase === receipt.outcome) return;
    if (found.phase === 'committed' || found.phase === 'cancelled') throw new Refused('Conflicting terminal write receipt');
    found.phase = receipt.outcome;
    await this.save(state);
  }
  async drain(personId?: string, expired = false): Promise<WriteDrain> {
    const state = await this.load(); this.expire(state);
    const permits = state.permits.filter(p => p.phase === 'redeemed' && (!personId || p.permit.personId === personId || p.permit.audienceEpochs?.some(e=>e.personId===personId)) && (p.permit.epoch !== state.scopes.find(s => s.personId === p.permit.personId)?.epoch || p.permit.audienceEpochs?.some(e=>state.scopes.find(s=>s.personId===e.personId)?.epoch!==e.epoch) || expired && p.permit.expiresAt <= this.now())).map(p => p.permit);
    return { state: permits.length ? 'pending' : 'complete', permits, ...(permits.length ? { retryAt: Math.max(this.now(), Math.min(...permits.map(p => p.expiresAt))) } : {}) };
  }
}

/** Writes are evaluated in memory, then published with their terminal receipt in one transaction. */
export class WriteStorage implements KeyValueStorage {
  staged: Map<string, string | undefined> | undefined;
  private alarm: number | null | undefined;
  readonly base: KeyValueStorage;
  constructor(base: KeyValueStorage) { this.base = base; }
  begin(): void { this.staged = new Map(); this.alarm = undefined; }
  end(): void { this.staged = undefined; this.alarm = undefined; }
  get(key: string): Promise<unknown> { return this.staged?.has(key) ? Promise.resolve(this.staged.get(key)) : this.base.get(key); }
  async put(key: string, value: string): Promise<void> { if (this.staged) this.staged.set(key, value); else await this.base.put(key, value); }
  async delete(key: string): Promise<void> { if (this.staged) this.staged.set(key, undefined); else await this.base.delete(key); }
  async setAlarm(time: number): Promise<void> { if (this.staged) this.alarm = time; else await this.base.setAlarm(time); }
  async deleteAlarm(): Promise<void> { if (this.staged) this.alarm = null; else await this.base.deleteAlarm(); }
  async transaction<T>(operation: (tx: StorageTurn) => Promise<T>): Promise<T> {
    if (!this.staged) return this.base.transaction(operation);
    const before = new Map(this.staged), alarm = this.alarm;
    try { return await operation(this); } catch (error) { this.staged = before; this.alarm = alarm; throw error; }
  }
  async flush(tx: StorageTurn): Promise<void> {
    for (const [key, value] of this.staged ?? []) { if (value === undefined) await tx.delete(key); else await tx.put(key, value); }
    if (typeof this.alarm === 'number') await tx.setAlarm(this.alarm);
    else if (this.alarm === null) await tx.deleteAlarm();
  }
}

export class WriteBlobs implements BlobStore {
  private puts = new Map<string, Uint8Array>();
  private deletes = new Set<string>();
  active = false;
  private readonly base: BlobStore;
  constructor(base: BlobStore) { this.base = base; }
  begin(): void { this.active = true; this.puts.clear(); this.deletes.clear(); }
  end(): void { this.active = false; this.puts.clear(); this.deletes.clear(); }
  get changed(): boolean { return this.puts.size + this.deletes.size > 0; }
  async put(key: string, value: Uint8Array): Promise<void> { if (this.active) this.puts.set(key, value.slice()); else await this.base.put(key, value); }
  async delete(key: string): Promise<void> { if (this.active) this.deletes.add(key); else await this.base.delete(key); }
  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    if (this.active && this.deletes.has(key)) return null;
    const value = this.active ? this.puts.get(key) : undefined;
    return value ? { async arrayBuffer() { return new Uint8Array(value).buffer; } } : this.base.get(key);
  }
  async upload(): Promise<void> { for (const [key, value] of this.puts) await this.base.put(key, value); }
  async cleanup(): Promise<void> { for (const key of this.deletes) await this.base.delete(key); }
}
interface ReceiverRecord { permit: WritePermit; outcome: 'prepared' | 'committed' | 'cancelled'; result?: ToolData }
export interface WriteHooks { issued?(permit: WritePermit): Promise<void>; redeemed?(permit: WritePermit): Promise<void>; committed?(permit: WritePermit): Promise<void> }
export class WriteReceiver {
  private readonly storage: WriteStorage;
  private readonly blobs: WriteBlobs | undefined;
  private readonly now: () => number;
  private readonly authority: WritePort | undefined;
  private readonly hooks: WriteHooks | undefined;
  constructor(storage: WriteStorage, blobs: WriteBlobs | undefined, now: () => number, authority?: WritePort, hooks?: WriteHooks) { this.storage = storage; this.blobs = blobs; this.now = now; this.authority = authority; this.hooks = hooks; }
  private key(id: string): string { return `write:receipt:${id}`; }
  private async record(id: string): Promise<ReceiverRecord | undefined> {
    const raw = await this.storage.base.get(this.key(id));
    try { return typeof raw === 'string' ? JSON.parse(raw) as ReceiverRecord : undefined; }
    catch { throw new Refused('Invalid stored write receipt'); }
  }
  async cancel(supplied: WritePermit): Promise<WriteReceipt> {
    const permit = writePermitSchema.parse(supplied), previous = await this.record(permit.id);
    if (previous && !samePermit(previous.permit, permit)) throw new Refused('Write cancellation mismatch');
    if (previous?.outcome === 'committed') return { permit, outcome: 'committed' };
    await this.storage.base.put(this.key(permit.id), JSON.stringify({ permit, outcome: 'cancelled' }));
    return { permit, outcome: 'cancelled' };
  }
  async run(actor: Actor, target: string, digest: string, operation: () => Promise<ToolData>, retryId?: string, aborted?: () => Promise<void>, deviceIds?:()=>string[], retainResult = true): Promise<{ value: ToolData; changed: boolean }> {
    if (retryId) {
      const previous = await this.record(retryId);
      if (!previous || previous.permit.personId !== actor.personId || previous.permit.target !== target || previous.permit.digest !== digest) throw new Refused('Unknown or mismatched write receipt');
      if (previous.outcome !== 'committed' || previous.result === undefined) throw new Refused('Write did not commit; recover cancellation before retrying');
      return { value: previous.result, changed: false };
    }
    this.storage.begin(); this.blobs?.begin();
    try {
      const value = await operation();
      if (!this.storage.staged?.size && !this.blobs?.changed) return { value, changed: false };
      // Membership and publication live in the same object: the serial turn is the local permit.
      // No cross-object prepare is necessary for a person, and refusals retain the atomic no-write contract.
      if (!actor.agent && !deviceIds) {
        await this.blobs?.upload();
        try { await this.storage.base.transaction(tx => this.storage.flush(tx)); }
        catch (error) { await aborted?.(); throw error; }
        await this.blobs?.cleanup();
        return { value, changed: true };
      }
      if (!this.authority) throw new Refused('Agent write authority unavailable');
      // Local membership authority is held by the Journey serial turn throughout preparation and commit.
      const permit = await this.authority.issueWrite({ actor, target, digest, ...(deviceIds?{deviceIds:deviceIds()}: {}) });
      if ((await this.record(permit.id))?.outcome === 'cancelled') throw new Refused('Write cancelled');
      await this.storage.base.put(this.key(permit.id), JSON.stringify({ permit, outcome: 'prepared' }));
      await this.hooks?.issued?.(permit);
      await this.authority?.redeemWrite(permit);
      await this.hooks?.redeemed?.(permit);
      if (permit.expiresAt <= this.now()) throw new Refused('Write permit expired before publication');
      await this.blobs?.upload();
      await this.storage.base.transaction(async tx => {
        if (permit.expiresAt <= this.now()) throw new Refused('Write permit expired before publication');
        await this.storage.flush(tx);
        // Sealed responses use ticket status/CAS recovery and can exceed the DO value limit.
        await tx.put(this.key(permit.id), JSON.stringify({ permit, outcome: 'committed', ...(retainResult ? { result: value } : {}) }));
        if (permit.expiresAt <= this.now()) throw new Refused('Write permit expired before publication');
      });
      await this.hooks?.committed?.(permit);
      // A lost acknowledgment retains the permit; recovery reads the receiver's durable receipt.
      try { await this.authority?.settleWrite({ permit, outcome: 'committed' }); } catch { /* No inferred cancellation. */ }
      await this.blobs?.cleanup();
      return { value, changed: true };
    } finally { this.storage.end(); this.blobs?.end(); }
  }
}
