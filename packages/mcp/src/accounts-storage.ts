import { Refused } from './commands.ts';
import type { KeyValueStorage, StorageTurn } from './storage.ts';
import type { Account } from './accounts.ts';
import type { StoredToken } from './oauth-contract.ts';
import type { RulesStamp } from './rules.ts';

type Row = Record<string, unknown>;
function parse<T>(raw: unknown): T | undefined {
  try { return typeof raw === 'string' ? JSON.parse(raw) as T : undefined; }
  catch { throw new Refused('Invalid stored account partition'); }
}
async function changed(tx: StorageTurn, key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  if (await tx.get(key) !== json) await tx.put(key, json);
}
async function rows(tx: StorageTurn, table: string): Promise<Row[]> {
  const ids = (parse(await tx.get(`${table}:index`)) ?? []) as string[];
  const values = await Promise.all(ids.map(id => tx.get(`${table}:${id}`).then(parse)));
  if (values.some(v => !v || typeof v !== 'object')) throw new Refused('Partitioned account row missing');
  return values as Row[];
}
async function saveRows(tx: StorageTurn, table: string, values: Row[], idOf: (row: Row) => string): Promise<void> {
  const before = (parse(await tx.get(`${table}:index`)) ?? []) as string[];
  const ids = values.map(idOf);
  if (new Set(ids).size !== ids.length) throw new Refused('Duplicate account storage key');
  for (let n = 0; n < values.length; n++) await changed(tx, `${table}:${ids[n]}`, values[n]);
  for (const id of before) if (!ids.includes(id)) await tx.delete(`${table}:${id}`);
  await changed(tx, `${table}:index`, ids);
}
const accountId = (row: Row) => String(row.personId);
const tokenId = (row: Row) => String(row.hash);

/** Virtual legacy keys let account/authority updates keep one atomic transaction while storing rows separately. */
class PartitionedTurn implements StorageTurn {
  readonly base: StorageTurn;
  constructor(base: StorageTurn) { this.base = base; }
  async get(key: string): Promise<unknown> {
    if (key === 'accounts') {
      const meta = parse(await this.base.get('accounts:meta')) as Row | undefined;
      if (!meta) return undefined;
      const accounts = await rows(this.base, 'accounts:account');
      const oauth: Row = {};
      oauth.clients = []; oauth.requests = [];
      for (const table of ['codes', 'access', 'refresh']) oauth[table] = await rows(this.base, `accounts:${table}`);
      return JSON.stringify({ ...meta, accounts, oauth, allowances: await rows(this.base, 'accounts:allowances'), permits: await rows(this.base, 'accounts:permits') });
    }
    if (key === 'write:authority') return JSON.stringify({ scopes: await rows(this.base, 'authority:scopes'), permits: await rows(this.base, 'authority:permits') });
    return this.base.get(key);
  }
  async put(key: string, value: string): Promise<void> {
    if (key === 'accounts') {
      const state = parse<Row>(value)!;
      const { accounts, oauth, allowances, permits, ...meta } = state;
      await saveRows(this.base, 'accounts:account', accounts as Row[], accountId);
      const db = (oauth ?? {}) as Record<string, Row[]>;
      for (const table of ['codes', 'access', 'refresh']) {
        await saveRows(this.base, `accounts:${table}`, db[table] ?? [], tokenId);
      }
      await saveRows(this.base, 'accounts:allowances', (allowances ?? []) as Row[], row => String(row.taskId));
      await saveRows(this.base, 'accounts:permits', (permits ?? []) as Row[], row => String(row.taskId));
      await changed(this.base, 'accounts:meta', meta);
      return;
    }
    if (key === 'write:authority') {
      const state = parse<{ scopes: Row[]; permits: Row[] }>(value)!;
      await saveRows(this.base, 'authority:scopes', state.scopes, accountId);
      await saveRows(this.base, 'authority:permits', state.permits, row => String((row.permit as Row).id));
      return;
    }
    await this.base.put(key, value);
  }
  delete(key: string): Promise<unknown> { return this.base.delete(key); }
  setAlarm(time: number): Promise<void> { return this.base.setAlarm(time); }
  deleteAlarm(): Promise<void> { return this.base.deleteAlarm(); }
}
export class PartitionedAccountsStorage extends PartitionedTurn implements KeyValueStorage {
  readonly store: KeyValueStorage;
  constructor(store: KeyValueStorage) { super(store); this.store = store; }
  transaction<T>(operation: (storage: StorageTurn) => Promise<T>): Promise<T> {
    return this.store.transaction(tx => operation(new PartitionedTurn(tx)));
  }
  override put(key: string, value: string): Promise<void> {
    return this.transaction(tx => tx.put(key, value));
  }
  /** No directory or token-table scan on the bearer-authentication hot path. */
  async access(hash: string): Promise<{ token?: StoredToken; account?: Account; rulesHash?: RulesStamp }> {
    const token = parse(await this.store.get(`accounts:access:${hash}`)) as StoredToken | null | undefined;
    if (!token) return {};
    const account = parse(await this.store.get(`accounts:account:${token.personId}`)) as Account | undefined;
    const meta = parse(await this.store.get('accounts:meta')) as { rulesHash: RulesStamp } | undefined;
    return { token, account, rulesHash: meta?.rulesHash };
  }
  async markAgentUsed(personId: string, agentId: string, now: number): Promise<void> {
    await this.store.transaction(async tx => {
      const key = `accounts:account:${personId}`, account = parse<Account>(await tx.get(key));
      const agent = account?.live && !account.suspended ? account.agents.find(a => a.id === agentId && a.live && !a.authorizationPending) : undefined;
      if (agent && (agent.lastUsedAt === undefined || now - agent.lastUsedAt >= 3_600_000)) {
        agent.lastUsedAt = now;
        await changed(tx, key, account);
      }
    });
  }
}
