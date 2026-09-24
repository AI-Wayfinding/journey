import { createAgeIdentity, exportJourney, generateJourneyKey, hashEntry, newId, open, parseRecord, recipientsHash, removeAndRotate, seal, signEntry, unwrapJourneyKey, verifyLog, wrapJourneyKey } from '@ai-wayfinding/core';
import type { Envelope, ItemBody, JourneyKey, KeyWrap, LogEntry, LogState, Member, ProtocolRecord } from '@ai-wayfinding/core';
import { getPersonKeys, rememberJourneyKey } from './keys.js';
import type { PersonKeys } from './keys.js';

export type JourneyListing = { id: string; name: string; principal: string };
export type EntryRow = { seq: number; entry: string };
export type JourneyContext = { id: string; principal: string; keys: PersonKeys; state: LogState; epochs: Map<number, JourneyKey>; log: LogEntry[] };

const encoder = new TextEncoder();
export function encodeEntry(value: unknown): string { return btoa(String.fromCharCode(...encoder.encode(JSON.stringify(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export function decodeEntry(value: string): unknown { const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/')); return JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, c => c.charCodeAt(0)))); }

export async function api<T>(path: string, method = 'GET', data?: unknown, principal?: string): Promise<T> {
  const response = await fetch('/v1' + path, { method, credentials: 'same-origin', cache: 'no-store', headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'X-Wayfinding': '1' }), ...(principal ? { 'X-Principal': principal } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: { code?: string } } | null;
    throw new Error(error?.error?.code ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
export async function listings(): Promise<JourneyListing[]> { return (await api<{ journeys: JourneyListing[] }>('/journeys')).journeys; }
export async function allLogRows(id: string, principal: string): Promise<EntryRow[]> {
  const rows: EntryRow[] = [];
  for (;;) {
    const page = (await api<{ log: EntryRow[] }>(`/journeys/${id}/log${rows.length ? '?after=' + rows.at(-1)!.seq : ''}`, 'GET', undefined, principal)).log;
    if (!page.length) return rows;
    rows.push(...page);
    if (rows.length > 100_000) throw new Error('Journey history is too large');
    if (page.length < 1000) return rows;
  }
}

/** No membership or wrap is trusted until the complete chain verifies. */
export async function verifiedJourney(id: string, principal: string, keys: PersonKeys): Promise<JourneyContext> {
  const rows = await allLogRows(id, principal);
  const wraps = (await api<{ wraps: { epoch: number; wrap: string }[] }>(`/journeys/${id}/wraps/me`, 'GET', undefined, principal)).wraps;
  const epochs = new Map<number, JourneyKey>();
  for (const wrap of wraps) {
    const key = await unwrapJourneyKey({ epoch: wrap.epoch, recipient: principal, ciphertext: wrap.wrap }, keys.identity);
    if (getPersonKeys() !== keys) { key.key.fill(0); throw new Error('Your keys are locked. Sign in again.'); }
    rememberJourneyKey(key);
    epochs.set(wrap.epoch, key);
  }
  const entries: LogEntry[] = [];
  for (const row of rows) {
    const encrypted = decodeEntry(row.entry) as Envelope;
    if (row.seq !== entries.length || encrypted?.outside?.journey !== id || encrypted.outside.epoch > Math.max(1, ...epochs.keys())) throw new Error('Journey history could not be verified. Stop and ask a member for help.');
    const key = epochs.get(encrypted.outside.epoch);
    if (!key) throw new Error('Missing a key for the journey history. Stop and ask a member for help.');
    const record = await open(encrypted, key);
    if (record.type !== 'membership' || record.typeVersion !== 1) throw new Error('Invalid journey history');
    entries.push(record.body as unknown as LogEntry);
  }
  const result = await verifyLog(entries);
  if (!result.ok || result.state.journey !== id) throw new Error('Journey history could not be verified. Stop and ask a member for help.');
  const mine = result.state.members[principal]?.member;
  if (!mine || mine.kind !== 'person' || mine.recipient !== keys.recipient || mine.signingKey !== keys.signingKey) throw new Error('You are not a member of this journey.');
  if (mine.expiresAt && Date.parse(mine.expiresAt) <= Date.now()) throw new Error('Your journey access has expired.');
  if (!epochs.has(result.state.currentEpoch)) throw new Error('Key update pending. A member who manages people needs to finish it.');
  if (getPersonKeys() !== keys) throw new Error('Your keys are locked. Sign in again.');
  return { id, principal, keys, state: result.state, epochs, log: entries };
}

export function currentKey(ctx: JourneyContext): JourneyKey {
  if (getPersonKeys() !== ctx.keys) throw new Error('Your keys are locked. Sign in again.');
  const mine = ctx.state.members[ctx.principal]?.member;
  if (!mine || mine.expiresAt && Date.parse(mine.expiresAt) <= Date.now()) throw new Error('Your journey access has expired.');
  const key = ctx.epochs.get(ctx.state.currentEpoch);
  if (!key) throw new Error('Key update pending');
  return key;
}
export async function encryptedEntry(ctx: JourneyContext, entry: LogEntry, key = currentKey(ctx)): Promise<string> {
  return encodeEntry(await seal({ type: 'membership', typeVersion: 1, body: entry as unknown as ProtocolRecord['body'] }, { id: newId(), journey: ctx.id, epoch: key.epoch, createdAt: entry.at }, key));
}
export async function appendEntry(ctx: JourneyContext, type: string, body: LogEntry['body'], extra: Record<string, unknown> = {}): Promise<void> {
  const entry = await signEntry({ v: 1, seq: ctx.state.lastSeq + 1, prev: ctx.state.lastHash, at: new Date().toISOString(), actor: ctx.principal, type, body }, ctx.keys.signingPrivateKey);
  const verified = await verifyLog([...ctx.log, entry]);
  if (!verified.ok) throw new Error(verified.error.message);
  await api(`/journeys/${ctx.id}/log`, 'POST', { entry: await encryptedEntry(ctx, entry), ...extra }, ctx.principal);
}
export async function createJourney(name: string, email: string, description: string, kind: 'individual' | 'team', keys: PersonKeys): Promise<{ listing: JourneyListing; recoveryIdentity: string; recoveryRecipient: string; recoveryWrap: string }> {
  const id = newId(), principal = newId(), recovery = await createAgeIdentity();
  const creator: Member = { id: principal, kind: 'person', recipient: keys.recipient, signingKey: keys.signingKey };
  const first = await signEntry({ v: 1, seq: 0, prev: null, at: new Date().toISOString(), actor: principal, type: 'genesis', body: { journey: id, name, creator, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: '0.1.0', description, journeyKind: kind } }, keys.signingPrivateKey);
  const checked = await verifyLog([first]);
  if (!checked.ok) throw new Error(checked.error.message);
  const key = generateJourneyKey();
  const genesis = encodeEntry(await seal({ type: 'membership', typeVersion: 1, body: first as unknown as ProtocolRecord['body'] }, { id: newId(), journey: id, epoch: 1, createdAt: first.at }, key));
  const [own] = await wrapJourneyKey(key, [{ id: principal, recipient: keys.recipient }]);
  const [recoveryWrap] = await wrapJourneyKey(key, [{ id: 'recovery', recipient: recovery.recipient }]);
  await api('/journeys', 'POST', { id, name, creatorEmail: email, creator: { id: principal, recipient: keys.recipient, signingKey: keys.signingKey }, genesis, wraps: [{ principal, epoch: 1, wrap: own!.ciphertext }], recoveryWrap: recoveryWrap!.ciphertext, minClientVersion: '0.1.0' });
  const listing = { id, name, principal };
  return { listing, recoveryIdentity: recovery.identity, recoveryRecipient: recovery.recipient, recoveryWrap: recoveryWrap!.ciphertext };
}
export async function saveRecord(ctx: JourneyContext, record: ProtocolRecord): Promise<void> {
  currentKey(ctx);
  if (ctx.state.members[ctx.principal]?.member.scope === 'read') throw new Error('This journey is read-only for you.');
  if (parseRecord(record).kind !== 'known') throw new Error('Unsupported record type');
  const { seq, epoch } = await api<{ seq: number; epoch: number }>(`/journeys/${ctx.id}/seq`, 'POST', {}, ctx.principal);
  if (epoch !== ctx.state.currentEpoch) throw new Error('Journey key changed. Reload before writing.');
  const envelope = await seal(record, { id: newId(), journey: ctx.id, seq, epoch, createdAt: new Date().toISOString() }, currentKey(ctx));
  await api(`/journeys/${ctx.id}/records`, 'POST', { envelope }, ctx.principal);
}
export async function allRecords(ctx: JourneyContext): Promise<ProtocolRecord[]> {
  currentKey(ctx);
  const records: ProtocolRecord[] = [];
  let after = 0;
  for (;;) {
    const page = (await api<{ records: Envelope[] }>(`/journeys/${ctx.id}/records?after=${after}&limit=100`, 'GET', undefined, ctx.principal)).records;
    for (const envelope of page) {
      if (envelope.outside.journey !== ctx.id || envelope.outside.epoch > ctx.state.currentEpoch || !ctx.epochs.has(envelope.outside.epoch)) throw new Error('Unverified journey record');
      const record = await open(envelope, ctx.epochs.get(envelope.outside.epoch)!);
      parseRecord(record);
      records.push(record);
      after = envelope.outside.seq ?? after;
    }
    if (page.length < 100) return records;
  }
}
export async function letIn(ctx: JourneyContext, pending: { principal: string; recipient: string; signingKey: string; support: number; expires: number | null }): Promise<void> {
  if (!ctx.state.grants[ctx.principal]?.includes('members.manage')) throw new Error('Only a member who manages people can let someone in.');
  if (pending.support === 1 && (!pending.expires || pending.expires <= Date.now())) throw new Error('This support invitation has expired. Send a new one.');
  const member: Member = { id: pending.principal, kind: 'person', recipient: pending.recipient, signingKey: pending.signingKey, ...(pending.support === 1 ? { support: true as const, scope: 'read' as const, expiresAt: new Date(pending.expires!).toISOString() } : {}) };
  const wraps = (await Promise.all([...ctx.epochs.values()].map(key => wrapJourneyKey(key, [{ id: member.id, recipient: member.recipient }])))).flat();
  await appendEntry(ctx, 'member.add', { member, grants: [], kind: 'person' }, { accessChanges: [{ principal: member.id, action: 'add', kind: 'person', scope: member.support ? 'read' : 'readwrite', ...(member.support ? { expiresAt: pending.expires! } : {}) }], memberWraps: wraps.map(wrap => ({ principal: member.id, epoch: wrap.epoch, wrap: wrap.ciphertext })) });
}
export async function rotatePending(ctx: JourneyContext): Promise<boolean> {
  const current = currentKey(ctx);
  if (!ctx.state.grants[ctx.principal]?.includes('members.manage')) return false;
  // A removed principal must lose access immediately. The next holder visit finishes an interrupted rotation.
  const last = ctx.log.at(-1);
  if (last?.type !== 'member.remove') return false;
  const key = generateJourneyKey(ctx.state.currentEpoch + 1);
  const wraps = await wrapJourneyKey(key, Object.values(ctx.state.members).map(({ member }) => ({ id: member.id, recipient: member.recipient })));
  const entry = await signEntry({ v: 1, seq: ctx.state.lastSeq + 1, prev: ctx.state.lastHash, at: new Date().toISOString(), actor: ctx.principal, type: 'key.rotate', body: { epoch: key.epoch, recipientsHash: await recipientsHash(ctx.state.members) } }, ctx.keys.signingPrivateKey);
  const checked = await verifyLog([...ctx.log, entry]);
  if (!checked.ok) throw new Error(checked.error.message);
  await api(`/journeys/${ctx.id}/log`, 'POST', { entry: await encryptedEntry(ctx, entry, current), epoch: key.epoch, wraps: wraps.map(w => ({ principal: w.recipient, epoch: w.epoch, wrap: w.ciphertext })) }, ctx.principal);
  return true;
}
export async function removeMember(ctx: JourneyContext, target: string): Promise<void> {
  const operation = await removeAndRotate(ctx.state, target, ctx.principal, ctx.keys.signingPrivateKey);
  const both = await verifyLog([...ctx.log, ...operation.entries]);
  if (!both.ok) throw new Error(both.error.message);
  const [remove, rotate] = operation.entries;
  await api(`/journeys/${ctx.id}/log`, 'POST', { entry: await encryptedEntry(ctx, remove), accessChanges: [{ principal: target, action: 'remove', kind: ctx.state.members[target]!.member.kind, scope: 'readwrite' }] }, ctx.principal);
  await api(`/journeys/${ctx.id}/log`, 'POST', { entry: await encryptedEntry(ctx, rotate), epoch: operation.key.epoch, wraps: operation.wraps.map(w => ({ principal: w.recipient, epoch: w.epoch, wrap: w.ciphertext })) }, ctx.principal);
}
export async function exportEncrypted(ctx: JourneyContext, recipients: string[]): Promise<string> {
  currentKey(ctx);
  const raw = await api<{ log: EntryRow[]; envelopes: Envelope[]; wraps: { epoch: number; wrap: string }[] }>(`/journeys/${ctx.id}/export`, 'GET', undefined, ctx.principal);
  if (raw.log.length !== ctx.log.length || raw.log.some((row, i) => row.seq !== i)) throw new Error('Journey history changed. Reload before exporting.');
  for (const [index, row] of raw.log.entries()) {
    const envelope = decodeEntry(row.entry) as Envelope;
    const key = ctx.epochs.get(envelope.outside.epoch);
    if (!key || await hashEntry((await open(envelope, key)).body as unknown as LogEntry) !== await hashEntry(ctx.log[index]!)) throw new Error('Journey history changed. Reload before exporting.');
  }
  const wraps: KeyWrap[] = (await Promise.all([...ctx.epochs.values()].map(key => wrapJourneyKey(key, recipients.map((recipient, i) => ({ id: `export-${i}`, recipient })))))).flat();
  return exportJourney(ctx.log, raw.envelopes, wraps, recipients);
}
export function itemVersions(records: ProtocolRecord[]): { root: string; item: ItemBody; versions: ItemBody[]; comments: ProtocolRecord[]; deleted: boolean }[] {
  const items = new Map<string, ItemBody[]>(), roots = new Map<string, string>(), comments: ProtocolRecord[] = [], deleted = new Set<string>();
  for (const record of records) {
    if (record.type === 'item') {
      const body = record.body as ItemBody, root = body.replaces ? roots.get(body.replaces) : body.id;
      if (!root) continue; // An orphan version is not a trustworthy item.
      roots.set(body.id, root);
      const versions = items.get(root) ?? []; versions.push(body); items.set(root, versions);
    }
    if (record.type === 'comment') comments.push(record);
    if (record.type === 'delete') deleted.add(String(record.body.target));
  }
  return [...items.entries()].map(([root, versions]) => ({ root, item: versions.at(-1)!, versions, comments: comments.filter(c => roots.get(String(c.body.item)) === root), deleted: deleted.has(root) }));
}
