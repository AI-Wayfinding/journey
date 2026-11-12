import { Refused } from './commands.ts';
import type { KeyValueStorage, StorageTurn } from './storage.ts';
import type { OAuthClient, AuthorizationRequest } from './oauth-contract.ts';
import { tokenHash } from './oauth-store.ts';

export const ANONYMOUS_TTL = 600_000;
export const ANONYMOUS_CAPACITY = 8192;
const SHARDS = 128, PAGE_SIZE = 128;
type Table = 'clients' | 'requests';
interface Entry { key: string; expiresAt: number }
interface Counter { count: number; cursor: number }
async function read<T>(tx: StorageTurn, key: string, fallback: T): Promise<T> {
  const raw = await tx.get(key);
  try { return typeof raw === 'string' ? JSON.parse(raw) as T : fallback; }
  catch { throw new Refused('Invalid anonymous OAuth storage'); }
}

/** Anonymous rows are keyed, never part of Accounts snapshots. Each GC index is bounded. */
export class OAuthAnonymous {
  private readonly storage: KeyValueStorage;
  private readonly now: () => number;
  constructor(storage: KeyValueStorage, now: () => number) { this.storage = storage; this.now = now; }
  private prefix(table: Table): string { return `oauth-anonymous:${table}`; }
  private shard(key: string): number {
    // The digest is base64url; use seven bits, uniformly distributed over 128 pages.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    return alphabet.indexOf(key[0]!) * 2 + (alphabet.indexOf(key[1]!) & 1);
  }
  private async get<T>(table: Table, id: string): Promise<T | undefined> {
    const row = await read<{ value: T; expiresAt: number } | undefined>(this.storage, `${this.prefix(table)}:row:${await tokenHash(id)}`, undefined);
    return row && row.expiresAt > this.now() ? row.value : undefined;
  }
  client(id: string): Promise<OAuthClient | undefined> { return this.get('clients', id); }
  request(id: string): Promise<AuthorizationRequest | undefined> { return this.get('requests', id); }
  private async put(table: Table, id: string, value: OAuthClient | AuthorizationRequest, expiresAt: number): Promise<void> {
    const prefix = this.prefix(table), key = await tokenHash(id), shard = this.shard(key);
    await this.storage.transaction(async tx => {
      const counter = await read<Counter>(tx, `${prefix}:counter`, { count: 0, cursor: 0 });
      const pages = new Map<number, Entry[]>();
      const sweep = async (page: number) => {
        if (pages.has(page)) return;
        const before = await read<Entry[]>(tx, `${prefix}:page:${page}`, []), live = [];
        for (const entry of before) {
          if (entry.expiresAt <= this.now()) { await tx.delete(`${prefix}:row:${entry.key}`); counter.count--; }
          else live.push(entry);
        }
        pages.set(page, live);
      };
      await sweep(shard); await sweep(counter.cursor);
      counter.cursor = (counter.cursor + 1) % SHARDS;
      const page = pages.get(shard)!, previous = page.find(e => e.key === key);
      // Only new registration/authorization can hit capacity; reads and token operations never sweep.
      if (!previous && counter.count >= ANONYMOUS_CAPACITY) {
        for (let n = 0; n < SHARDS; n++) await sweep(n);
      }
      if (!previous && (counter.count >= ANONYMOUS_CAPACITY || page.length >= PAGE_SIZE)) throw new Refused('Anonymous OAuth capacity reached');
      if (previous) previous.expiresAt = expiresAt;
      else { page.push({ key, expiresAt }); counter.count++; }
      await tx.put(`${prefix}:row:${key}`, JSON.stringify({ value, expiresAt }));
      for (const [n, entries] of pages) await tx.put(`${prefix}:page:${n}`, JSON.stringify(entries));
      await tx.put(`${prefix}:counter`, JSON.stringify(counter));
    });
  }
  saveClient(client: OAuthClient, authorized = false): Promise<void> {
    return this.put('clients', client.client_id, client, authorized ? Number.MAX_SAFE_INTEGER : this.now() + ANONYMOUS_TTL);
  }
  saveRequest(id: string, request: AuthorizationRequest): Promise<void> {
    return this.put('requests', id, request, Math.min(request.expiresAt, this.now() + ANONYMOUS_TTL));
  }
  async removeRequest(id: string): Promise<void> {
    const prefix = this.prefix('requests'), key = await tokenHash(id), shard = this.shard(key);
    await this.storage.transaction(async tx => {
      const page = await read<Entry[]>(tx, `${prefix}:page:${shard}`, []);
      if (!page.some(e => e.key === key)) return;
      const counter = await read<Counter>(tx, `${prefix}:counter`, { count: 0, cursor: 0 });
      counter.count--;
      await tx.delete(`${prefix}:row:${key}`);
      await tx.put(`${prefix}:page:${shard}`, JSON.stringify(page.filter(e => e.key !== key)));
      await tx.put(`${prefix}:counter`, JSON.stringify(counter));
    });
  }
}
