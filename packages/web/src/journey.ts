import { canWriteContent, canReadContent, isPersonGuide, createAgeIdentity, generateJourneyKey, newId, open, parseRecord, recipientsHash, seal, sealIdentity, sealControlLabels, signControlProof, unwrapJourneyKey, verifyControlProofs, wrapJourneyKey, meetsMinClientVersion, logDefinitions, readControlProof } from '@ai-wayfinding/core';
import { plainError, UPDATE_REQUIRED } from './messages.js';
import type { ControlProof, Envelope, JourneyKey, KeyWrap, LogEntry, LogState, Member, ProtocolRecord } from '@ai-wayfinding/core';
import { getPersonKeys, rememberJourneyKey } from './keys.js';
import type { PersonKeys } from './keys.js';

export const INTERFACE_VERSION = '0.1.5';
export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export type JourneyListing = { id: string; name: string; principal: string };
export type SignedControl = { proof: ControlProof; envelope: Envelope };
export type EntryRow = SignedControl & { seq: number };
export type JourneyContext = { id: string; principal: string; keys: PersonKeys; state: LogState; epochs: Map<number, JourneyKey>; log: LogEntry[]; controls: SignedControl[] };
const historyError = 'Journey history could not be verified. Stop and ask a member for help.';
export async function api<T>(path: string, method = 'GET', data?: unknown, principal?: string): Promise<T> {
  const response = await fetch('/v1' + path, { method, credentials: 'same-origin', cache: 'no-store', headers: { 'X-Client-Version': INTERFACE_VERSION, 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'X-Wayfinding': '1' }), ...(principal ? { 'X-Principal': principal } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: { code?: string } } | null;
    throw new ApiError(plainError(error?.error?.code, response.status), response.status);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
export async function listings(): Promise<JourneyListing[]> {
  const rows = (await api<{ journeys: JourneyListing[] }>('/journeys')).journeys;
  const keys = getPersonKeys();
  if (!keys) return rows;
  return Promise.all(rows.map(async row => ({ id: row.id, principal: row.principal, name: (await verifiedJourney(row.id, row.principal, keys)).state.settings!.name })));
}
export async function allLogRows(id: string, principal: string): Promise<EntryRow[]> {
  const rows: EntryRow[] = [];
  for (;;) {
    const page = (await api<{ log: EntryRow[] }>(`/journeys/${id}/log${rows.length ? '?after=' + rows.at(-1)!.seq : ''}`, 'GET', undefined, principal)).log;
    if (!Array.isArray(page)) throw new Error(historyError);
    rows.push(...page);
    if (rows.length > 100_000) throw new Error('Journey history is too large');
    if (page.length < 1000) return rows;
  }
}
export function assertSupported(minimum: string, format = 'control-proof-v1'): void {
  if (format !== 'control-proof-v1' || !meetsMinClientVersion(INTERFACE_VERSION, minimum)) throw new Error(UPDATE_REQUIRED);
}
export async function verifiedJourney(id: string, principal: string, keys: PersonKeys): Promise<JourneyContext> {
  const protocol = await api<{ minClientVersion: string; controlFormat: string }>(`/journeys/${id}/protocol`, 'GET', undefined, principal);
  assertSupported(protocol.minClientVersion, protocol.controlFormat);
  const rows = await allLogRows(id, principal);
  if (!rows.length || rows.some(row => !row.proof || !row.envelope || row.seq !== row.proof.seq)) throw new Error(historyError);
  if (rows.some(row => row.proof.v !== 1 || !logDefinitions.some(definition => definition.name === row.proof.type))) throw new Error(UPDATE_REQUIRED);
  const wraps = (await api<{ wraps: { epoch: number; wrap: string }[] }>(`/journeys/${id}/wraps/me`, 'GET', undefined, principal)).wraps;
  const epochs = new Map<number, JourneyKey>();
  for (const wrap of wraps) {
    const key = await unwrapJourneyKey({ epoch: wrap.epoch, recipient: principal, ciphertext: wrap.wrap }, keys.identity);
    if (getPersonKeys() !== keys) { key.key.fill(0); throw new Error('Your keys are locked. Sign in again.'); }
    rememberJourneyKey(key); epochs.set(wrap.epoch, key);
  }
  const result = await verifyControlProofs(rows.map(row => row.proof), rows.map(row => row.envelope), { journey: id, creator: rows[0]!.proof.body.creator as Member }, [...epochs.values()]);
  if (!result.ok || result.state.journey !== id) throw new Error(historyError);
  assertSupported(result.state.minClientVersion);
  const mine = result.state.members[principal]?.member;
  if (!mine || mine.kind !== 'person' || mine.recipient !== keys.recipient || mine.signingKey !== keys.signingKey) throw new Error('You are not a member of this journey.');
  if (!canReadContent(result.state, principal)) throw new Error('Your journey access has expired.');
  if (!epochs.has(result.state.currentEpoch)) throw new Error('Key update pending. A guide needs to finish it.');
  const log = await Promise.all(rows.map(async row => (await readControlProof(row.proof, row.envelope, epochs.get(row.envelope.outside.epoch))).entry));
  return { id, principal, keys, state: result.state, epochs, log, controls: rows.map(row => ({ proof: row.proof, envelope: row.envelope })) };
}
export function currentKey(ctx: JourneyContext): JourneyKey {
  if (getPersonKeys() !== ctx.keys) throw new Error('Your keys are locked. Sign in again.');
  if (!canReadContent(ctx.state, ctx.principal)) throw new Error('Your journey access has expired.');
  assertSupported(ctx.state.minClientVersion);
  const key = ctx.epochs.get(ctx.state.currentEpoch);
  if (!key) throw new Error('Key update pending');
  return key;
}
export async function makeControl(ctx: JourneyContext, type: string, body: LogEntry['body'], key = currentKey(ctx)): Promise<SignedControl> {
  const entry = { v: 1 as const, seq: ctx.state.lastSeq + 1, prev: ctx.state.lastHash, at: new Date().toISOString(), actor: ctx.principal, type, body };
  const envelope = await sealControlLabels(entry, { id: newId(), journey: ctx.id, seq: entry.seq, epoch: key.epoch, createdAt: entry.at }, key);
  const proof = await signControlProof(entry, envelope, ctx.id, ctx.keys.signingPrivateKey);
  const controls = [...ctx.controls, { proof, envelope }];
  const checked = await verifyControlProofs(controls.map(c => c.proof), controls.map(c => c.envelope), { journey: ctx.id, creator: controls[0]!.proof.body.creator as Member }, [...ctx.epochs.values(), key]);
  if (!checked.ok) throw new Error(checked.error.message);
  return { proof, envelope };
}
export async function appendEntry(ctx: JourneyContext, type: string, body: LogEntry['body'], wraps?: { principal: string; epoch: number; wrap: string }[]): Promise<void> {
  const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys);
  const control = await makeControl(latest, type, body);
  await api(`/journeys/${ctx.id}/log`, 'POST', { control, ...(wraps ? { wraps } : {}) }, ctx.principal);
}
export async function createJourney(name: string, description: string, keys: PersonKeys): Promise<{ listing: JourneyListing; recoveryIdentity: string; recoveryRecipient: string; recoveryWrap: string }> {
  const id = newId(), principal = newId(), recovery = await createAgeIdentity(), key = generateJourneyKey();
  const creator: Member = { id: principal, kind: 'person', recipient: keys.recipient, signingKey: keys.signingKey };
  const entry = { v: 1 as const, seq: 0, prev: null, at: new Date().toISOString(), actor: principal, type: 'genesis', body: { journey: id, name, creator, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: INTERFACE_VERSION, description } };
  const envelope = await sealControlLabels(entry, { id: newId(), journey: id, seq: 0, epoch: 1, createdAt: entry.at }, key);
  const control = { proof: await signControlProof(entry, envelope, id, keys.signingPrivateKey), envelope };
  const [own] = await wrapJourneyKey(key, [creator]);
  const [recoveryWrap] = await wrapJourneyKey(key, [{ id: 'recovery', recipient: recovery.recipient }]);
  await api('/journeys', 'POST', { id, creator: { id: principal, recipient: keys.recipient, signingKey: keys.signingKey }, control, wraps: [{ principal, epoch: 1, wrap: own!.ciphertext }], recoveryWrap: recoveryWrap!.ciphertext });
  return { listing: { id, name, principal }, recoveryIdentity: recovery.identity, recoveryRecipient: recovery.recipient, recoveryWrap: recoveryWrap!.ciphertext };
}
export async function saveRecord(ctx: JourneyContext, record: ProtocolRecord): Promise<void> {
  const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys);
  if (!canWriteContent(latest.state, ctx.principal)) throw new Error('This journey is read-only for you.');
  if (parseRecord(record).kind !== 'known') throw new Error('Unsupported record type');
  const { seq, epoch } = await api<{ seq: number; epoch: number }>(`/journeys/${ctx.id}/seq`, 'POST', {}, ctx.principal);
  if (epoch !== latest.state.currentEpoch) throw new Error('Journey key changed. Reload before writing.');
  const envelope = await seal(record, { id: newId(), journey: ctx.id, seq, epoch, createdAt: new Date().toISOString() }, currentKey(latest));
  await api(`/journeys/${ctx.id}/records`, 'POST', { envelope }, ctx.principal);
}
export async function allRecords(ctx: JourneyContext): Promise<ProtocolRecord[]> {
  currentKey(ctx);
  const records: ProtocolRecord[] = []; let after = 0;
  for (;;) {
    const page = (await api<{ records: Envelope[] }>(`/journeys/${ctx.id}/records?after=${after}&limit=100`, 'GET', undefined, ctx.principal)).records;
    for (const envelope of page) {
      if (envelope.outside.journey !== ctx.id || envelope.outside.epoch > ctx.state.currentEpoch || !ctx.epochs.has(envelope.outside.epoch)) throw new Error('Unverified journey record');
      const record = await open(envelope, ctx.epochs.get(envelope.outside.epoch)!); parseRecord(record); records.push(record); after = envelope.outside.seq ?? after;
    }
    if (page.length < 100) return records;
  }
}
export async function letIn(ctx: JourneyContext, pending: { principal: string; recipient: string; signingKey: string; support: number; expires: number | null }): Promise<void> {
  if (pending.support === 1 && (!pending.expires || pending.expires <= Date.now())) throw new Error('This support invitation has expired. Send a new one.');
  const member: Member = { id: pending.principal, kind: 'person', recipient: pending.recipient, signingKey: pending.signingKey, ...(pending.support === 1 ? { support: true as const, scope: 'read' as const, expiresAt: new Date(pending.expires!).toISOString() } : {}) };
  const wraps = (await Promise.all([...ctx.epochs.values()].map(key => wrapJourneyKey(key, [member])))).flat();
  await appendEntry(ctx, 'member.add', { member, grants: [], kind: 'person' }, wraps.map(w => ({ principal: w.recipient, epoch: w.epoch, wrap: w.ciphertext })));
}
export async function rotatePending(ctx: JourneyContext): Promise<boolean> {
  if (!ctx.state.pendingRotation || !isPersonGuide(ctx.state, ctx.principal)) return false;
  const key = generateJourneyKey(ctx.state.currentEpoch + 1);
  const wraps = await wrapJourneyKey(key, Object.values(ctx.state.members).map(({ member }) => ({ id: member.id, recipient: member.recipient })));
  const control = await makeControl(ctx, 'key.rotate', { epoch: key.epoch, recipientsHash: await recipientsHash(ctx.state.members) }, key);
  await api(`/journeys/${ctx.id}/log`, 'POST', { control, wraps: wraps.map(w => ({ principal: w.recipient, epoch: w.epoch, wrap: w.ciphertext })) }, ctx.principal);
  return true;
}
export async function removeMember(ctx: JourneyContext, target: string): Promise<void> {
  await appendEntry(ctx, 'member.remove', { member: target });
  const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys);
  await rotatePending(latest);
}
export async function exportEncrypted(ctx: JourneyContext, recipients: string[]): Promise<string> {
  const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys);
  const raw = await api<{ log: EntryRow[]; envelopes: Envelope[] }>(`/journeys/${ctx.id}/export`, 'GET', undefined, ctx.principal);
  if (raw.log.length !== latest.controls.length) throw new Error('Journey history changed. Reload before exporting.');
  const checked = await verifyControlProofs(raw.log.map(row => row.proof), raw.log.map(row => row.envelope), { journey: ctx.id, creator: latest.controls[0]!.proof.body.creator as Member });
  if (!checked.ok || checked.state.lastHash !== latest.state.lastHash) throw new Error(historyError);
  const wraps: KeyWrap[] = (await Promise.all([...latest.epochs.values()].map(key => wrapJourneyKey(key, recipients.map((recipient, i) => ({ id: `export-${i}`, recipient })))))).flat();
  return sealIdentity(JSON.stringify({ format: 'control-proof-v1', journey: ctx.id, creator: latest.controls[0]!.proof.body.creator, log: raw.log, envelopes: raw.envelopes, wraps }), recipients);
}
export { itemVersions } from '@ai-wayfinding/core';
