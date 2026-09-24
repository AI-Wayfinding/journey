import { CLIENT_VERSION, meetsMinClientVersion, newId, open, parseRecord, seal, unwrapJourneyKey, verifyLog } from '@ai-wayfinding/core';
import type { CommentBody, Envelope, ItemBody, JourneyKey, LogEntry, LogState, ProtocolRecord } from '@ai-wayfinding/core';
import { readCache, writeCache } from './cache.js';
import type { CipherCache, CipherRow } from './cache.js';
import { signedHeaders } from './signing.js';
import type { RememberedAgent } from './storage.js';

export interface AddInput { type: string; title: string; body: string; tags: string[]; created?: string; resourceKind?: string; sharedFrom?: string }
export interface JourneyOptions { fetch?: typeof fetch; cacheRoot?: string }
export interface ItemView { item: ItemBody; comments: CommentBody[] }
interface Verified { state: LogState; epochs: Map<number, JourneyKey>; log: CipherRow[] }
const historyError = 'This journey history could not be verified. Stop and ask a member for help.';
function decode(value: string): Envelope { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Envelope; }

export class JourneyClient {
  private readonly fetcher: typeof fetch;
  private readonly keys = new Map<number, JourneyKey>();
  constructor(readonly session: RememberedAgent, private readonly options: JourneyOptions = {}) { this.fetcher = options.fetch ?? fetch; }
  private async request<T>(path: string, method = 'GET', data?: object): Promise<T> {
    if (this.session.expiresAt <= Date.now()) throw new Error('Your journey agent access has expired. Connect again.');
    const body = data === undefined ? '' : JSON.stringify(data);
    const route = '/v1' + path;
    const headers = await signedHeaders(this.session.signingPrivateKey, method, route, body);
    const result = await this.fetcher(this.session.server + route, { method, headers: { ...headers, 'X-Agent-Session': this.session.sessionId, ...(data === undefined ? {} : { 'Content-Type': 'application/json', Origin: new URL(this.session.server).origin, 'X-Wayfinding': '1' }) }, ...(data === undefined ? {} : { body }) });
    if (!result.ok) {
      if (result.status === 403 || result.status === 401) throw new Error('Access to this journey has ended');
      const error: unknown = await result.json().catch(() => null);
      const code = error && typeof error === 'object' && 'error' in error && error.error && typeof error.error === 'object' && 'code' in error.error ? String(error.error.code) : String(result.status);
      throw new Error('Journey request failed (' + code + ').');
    }
    return result.json() as Promise<T>;
  }
  private async verified(): Promise<Verified> {
    // Never trust a cache head without decrypting and verifying the entire signed chain.
    const cached = this.options.cacheRoot ? await readCache(this.options.cacheRoot, this.session.journeyId).catch(() => null) : null;
    const log: CipherRow[] = cached?.log ? [...cached.log] : [];
    for (;;) {
      const after = log.length ? '?after=' + (log.at(-1)!.seq) : '';
      const page = (await this.request<{ log: CipherRow[] }>(`/journeys/${this.session.journeyId}/log${after}`)).log;
      if (!Array.isArray(page)) throw new Error(historyError);
      log.push(...page);
      if (log.length > 100_000) throw new Error('Journey history is too large.');
      if (page.length < 1000) break;
    }
    const response = await this.request<{ wraps: { epoch: number; wrap: string }[] }>(`/journeys/${this.session.journeyId}/wraps/me`);
    const epochs = new Map<number, JourneyKey>();
    for (const wrap of response.wraps) {
      if (!Number.isSafeInteger(wrap.epoch) || wrap.epoch < 1) throw new Error(historyError);
      const key = this.keys.get(wrap.epoch) ?? await unwrapJourneyKey({ epoch: wrap.epoch, recipient: this.session.principal, ciphertext: wrap.wrap }, this.session.identity);
      this.keys.set(wrap.epoch, key); epochs.set(wrap.epoch, key);
    }
    const entries: LogEntry[] = [];
    for (const row of log) {
      const envelope = decode(row.entry);
      if (row.seq !== entries.length || envelope.outside?.journey !== this.session.journeyId) throw new Error(historyError);
      const key = epochs.get(envelope.outside.epoch);
      if (!key) throw new Error('Missing a key for the journey history. Ask a member to approve access again.');
      const record = await open(envelope, key).catch(() => { throw new Error(historyError); });
      if (record.type !== 'membership' || record.typeVersion !== 1) throw new Error(historyError);
      const wrapped = record.body.entry;
      const entry = typeof wrapped === 'string' ? JSON.parse(wrapped) as LogEntry : record.body as unknown as LogEntry;
      entries.push(entry);
    }
    const checked = await verifyLog(entries);
    if (!checked.ok || checked.state.journey !== this.session.journeyId) throw new Error(historyError);
    const mine = checked.state.members[this.session.principal]?.member;
    if (!mine || mine.kind !== 'agent' || mine.signingKey !== this.session.signingKey || mine.recipient !== this.session.recipient || mine.expiresAt && Date.parse(mine.expiresAt) <= Date.now()) throw new Error('Access to this journey has ended');
    if (!meetsMinClientVersion(CLIENT_VERSION, checked.state.minClientVersion)) throw new Error('This journey needs a newer client version. Update wayfinding before writing.');
    if (!epochs.has(checked.state.currentEpoch)) throw new Error('The journey key changed. Ask a member to reconnect this agent.');
    if (this.options.cacheRoot && (!cached || cached.seq !== checked.state.lastSeq || cached.hash !== checked.state.lastHash)) await writeCache(this.options.cacheRoot, this.session.journeyId, { seq: checked.state.lastSeq, hash: checked.state.lastHash!, log, records: cached?.records ?? [] });
    return { state: checked.state, epochs, log };
  }
  private async records(verified: Verified): Promise<ProtocolRecord[]> {
    const cached = this.options.cacheRoot ? await readCache(this.options.cacheRoot, this.session.journeyId).catch(() => null) : null;
    const envelopes: Envelope[] = cached?.records ? [...cached.records] : [];
    let after = envelopes.at(-1)?.outside.seq ?? 0;
    for (;;) {
      const page = (await this.request<{ records: Envelope[] }>(`/journeys/${this.session.journeyId}/records?after=${after}&limit=100`)).records;
      if (!Array.isArray(page)) throw new Error('Invalid journey records.');
      for (const envelope of page) {
        if (envelope.outside?.seq !== after + 1 || envelope.outside.journey !== this.session.journeyId) throw new Error('Invalid journey records.');
        after = envelope.outside.seq;
        envelopes.push(envelope);
      }
      if (envelopes.length > 100_000) throw new Error('Too many journey records.');
      if (page.length < 100) break;
    }
    const records: ProtocolRecord[] = [];
    for (const envelope of envelopes) {
      const key = verified.epochs.get(envelope.outside.epoch);
      if (!key || envelope.outside.epoch > verified.state.currentEpoch) throw new Error('Missing a key for the journey records.');
      const record = await open(envelope, key);
      parseRecord(record);
      records.push(record);
    }
    if (this.options.cacheRoot) await writeCache(this.options.cacheRoot, this.session.journeyId, { seq: verified.state.lastSeq, hash: verified.state.lastHash!, log: verified.log, records: envelopes });
    return records;
  }
  private async writable(): Promise<Verified> {
    const verified = await this.verified();
    if (verified.state.members[this.session.principal]?.member.scope !== 'readwrite') throw new Error('This journey is read-only for this agent. Ask a person to approve write access.');
    return verified;
  }
  private async write(record: ProtocolRecord, verified: Verified): Promise<void> {
    if (parseRecord(record).kind !== 'known') throw new Error('Unknown journey record type.');
    const { seq, epoch } = await this.request<{ seq: number; epoch: number }>(`/journeys/${this.session.journeyId}/seq`, 'POST', {});
    if (epoch !== verified.state.currentEpoch) throw new Error('The journey key changed. Reload before writing.');
    const key = verified.epochs.get(epoch)!;
    const envelope = await seal(record, { id: newId(), journey: this.session.journeyId, seq, epoch, createdAt: new Date().toISOString() }, key);
    await this.request(`/journeys/${this.session.journeyId}/records`, 'POST', { envelope });
  }
  async add(input: AddInput): Promise<ItemBody> {
    const verified = await this.writable();
    const item: ItemBody = { id: newId(), itemType: input.type, title: input.title, body: input.body, tags: [...input.tags], author: this.session.principal, authoredBy: 'agent', created: input.created ?? new Date().toISOString(), ...(input.resourceKind ? { resourceKind: input.resourceKind } : {}), ...(input.sharedFrom ? { sharedFrom: input.sharedFrom } : {}) };
    await this.write({ type: 'item', typeVersion: 1, body: item }, verified);
    return item;
  }
  async list(type?: string): Promise<ItemBody[]> {
    const records = await this.records(await this.verified());
    const roots = new Map<string, string>(), items = new Map<string, ItemBody>(), deleted = new Set<string>();
    for (const record of records) {
      if (record.type === 'item') {
        const item = record.body as ItemBody;
        const root = item.replaces ? roots.get(item.replaces) : item.id;
        if (root) { roots.set(item.id, root); items.set(root, item); }
      } else if (record.type === 'delete') deleted.add(String(record.body.target));
    }
    return [...items.entries()].filter(([id, item]) => !deleted.has(id) && (!type || type === item.itemType)).map(([, item]) => item);
  }
  async search(text: string): Promise<ItemBody[]> { const needle = text.toLocaleLowerCase(); return (await this.list()).filter(item => [item.title, item.body, item.itemType, ...item.tags].some(value => value.toLocaleLowerCase().includes(needle))); }
  async show(id: string): Promise<ItemView> {
    const records = await this.records(await this.verified());
    const roots = new Map<string, string>(), items = new Map<string, ItemBody>(), comments: CommentBody[] = [], deleted = new Set<string>();
    for (const record of records) {
      if (record.type === 'item') { const item = record.body as ItemBody, root = item.replaces ? roots.get(item.replaces) : item.id; if (root) { roots.set(item.id, root); items.set(root, item); } }
      if (record.type === 'comment') comments.push(record.body as CommentBody);
      if (record.type === 'delete') deleted.add(String(record.body.target));
    }
    const root = roots.get(id), item = root && !deleted.has(root) ? items.get(root) : undefined;
    if (!item) throw new Error('No journey item has that ID.');
    return { item, comments: comments.filter(comment => roots.get(comment.item) === root) };
  }
  async comments(id: string): Promise<CommentBody[]> { return (await this.show(id)).comments; }
  async comment(id: string, text: string): Promise<CommentBody> {
    const verified = await this.writable();
    const records = await this.records(verified);
    const root = records.find(record => record.type === 'item' && record.body.id === id);
    if (!root) throw new Error('No journey item has that ID.');
    const comment: CommentBody = { id: newId(), item: id, onVersion: id, author: this.session.principal, authoredBy: 'agent', at: new Date().toISOString(), body: text };
    await this.write({ type: 'comment', typeVersion: 1, body: comment }, verified);
    return comment;
  }
  async status(): Promise<{ journeyId: string; principal: string; scope: 'read' | 'readwrite'; expiresAt: number; seq: number }> {
    const { state } = await this.verified();
    return { journeyId: this.session.journeyId, principal: this.session.principal, scope: state.members[this.session.principal]!.member.scope as 'read' | 'readwrite', expiresAt: this.session.expiresAt, seq: state.lastSeq };
  }
  close(): void { for (const value of this.keys.values()) value.key.fill(0); this.keys.clear(); }
}
