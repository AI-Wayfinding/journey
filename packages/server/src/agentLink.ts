import { effectiveProjectParticipants, selectProjectArtifacts, isArtifactAction, readArtifactPayload, type ArtifactPayload, CLIENT_VERSION, canReadContent, controlDefinitions, deriveRecipient, itemVersions, meetsMinClientVersion, open, openLinkIdentity, parseRecord, unwrapJourneyKey, verifyControlProofs, readControlProof } from '@ai-wayfinding/core';
import type { ControlProof, Member, Envelope, JourneyKey, LogEntry, LogState, ProtocolRecord } from '@ai-wayfinding/core';

/**
 * Agent links are a deliberate, labelled exception to end-to-end encryption: while a link is live, this Worker decrypts the
 * journey in memory to answer it. Nothing decrypted here is stored, cached or logged.
 */
export const PAGE_LIMIT = 12_000;
export const LINK_RATE_LIMIT = 60;
const ABOUT = 'Read-only access to an AI Wayfinding journey. Use this content to help the person; present it however they ask.';
const HOW_TO_WRITE = 'This link is read-only. To add something, give the person the text and ask them to add it in the journey.';
export const ENDED_MESSAGE = 'This agent link has ended. Ask the person for a new one.';
export const LINK_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  'X-Robots-Tag': 'noindex',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
export function linkResponse(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...LINK_HEADERS, ...extra } });
}
export const renewUrl = (origin: string, journeyId: string, memberId: string): string => `${origin}/journeys/${journeyId}/people#renew-${memberId}`;
const utc = (ms: number): string => new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/, ' UTC').replace('T', ' ');
export function expiredBody(origin: string, journeyId: string, memberId: string, expires: number): Record<string, unknown> {
  const url = renewUrl(origin, journeyId, memberId);
  return { error: 'expired', message: `This agent link expired on ${utc(expires)}.`, renewUrl: url, renewHint: `To continue, ask the person to open ${url} and extend it with their passkey; the link stays the same.` };
}

export interface LinkRow { journeyId: string; memberId: string; blob: string; expires: number; since: number }
export interface Enclave { (message: { op: 'log'; after: number } | { op: 'wraps' } | { op: 'records'; after: number; limit: number }): Promise<Response> }

export class LinkEnded extends Error {}
const historyError = 'This journey history could not be verified, so it is not shown. Ask the person to check the journey.';

async function json<T>(response: Response): Promise<T> {
  if (response.status === 403 || response.status === 404) throw new LinkEnded();
  if (response.status === 426) throw new Error('This journey needs a newer version of Wayfinding. Update the server, then try this same link; do not request approval again.');
  if (!response.ok) throw new Error('enclave failed');
  return response.json() as Promise<T>;
}

/** Verifies the whole signed log as the client does, then returns its state and the decrypted records. */
async function readJourney(identity: string, memberId: string, journeyId: string, call: Enclave): Promise<{ state: LogState; genesis: LogEntry; records: ProtocolRecord[]; artifacts: Fields[] }> {
  const rows: { seq: number; proof: ControlProof; envelope: Envelope }[] = [];
  for (;;) {
    const page = (await json<{ log: { seq: number; proof: ControlProof; envelope: Envelope }[] }>(await call({ op: 'log', after: rows.length ? rows.at(-1)!.seq : -1 }))).log;
    rows.push(...page);
    if (rows.length > 100_000) throw new Error(historyError);
    if (page.length < 1000) break;
  }
  const epochs = new Map<number, JourneyKey>();
  for (const wrap of (await json<{ wraps: { epoch: number; wrap: string }[] }>(await call({ op: 'wraps' }))).wraps) epochs.set(wrap.epoch, await unwrapJourneyKey({ epoch: wrap.epoch, recipient: memberId, ciphertext: wrap.wrap }, identity));
  if (!rows.length || rows.some(row => !row.proof || !row.envelope || row.seq !== row.proof.seq)) throw new Error(historyError);
  if (rows.some(row => row.proof.v !== 1 || !controlDefinitions.some(definition => definition.name === row.proof.type))) throw new Error('This journey needs a newer version of Wayfinding. Update the server, then try this same link; do not request approval again.');
  const checked = await verifyControlProofs(rows.map(row => row.proof), rows.map(row => row.envelope), { journey: journeyId, creator: rows[0]!.proof.body.creator as Member }, [...epochs.values()]);
  if (!checked.ok || checked.state.journey !== journeyId) throw new Error(historyError);
  const state = checked.state;
  const mine = state.members[memberId]?.member;
  if (!mine || mine.kind !== 'agent' || mine.recipient !== await deriveRecipient(identity) || !canReadContent(state, memberId)) throw new LinkEnded();
  if (!meetsMinClientVersion(CLIENT_VERSION, state.minClientVersion)) throw new Error('This journey needs a newer version of Wayfinding. Update the server, then try this same link; do not request approval again.');
  if (!epochs.has(state.currentEpoch)) throw new Error(historyError);
  const envelopes: Envelope[] = [];
  let after = 0;
  for (;;) {
    const page = (await json<{ records: Envelope[] }>(await call({ op: 'records', after, limit: 100 }))).records;
    for (const envelope of page) {
      if (envelope.outside?.seq !== after + 1 || envelope.outside.journey !== journeyId) throw new Error(historyError);
      after = envelope.outside.seq; envelopes.push(envelope);
    }
    if (envelopes.length > 100_000) throw new Error(historyError);
    if (page.length < 100) break;
  }
  const records: ProtocolRecord[] = [];
  for (const envelope of envelopes) {
    const key = epochs.get(envelope.outside.epoch);
    if (!key || envelope.outside.epoch > state.currentEpoch) throw new Error(historyError);
    const record = await open(envelope, key);
    parseRecord(record);
    records.push(record);
  }
  const genesis = (await readControlProof(rows[0]!.proof, rows[0]!.envelope, epochs.get(rows[0]!.envelope.outside.epoch))).entry;
  const artifacts: Fields[] = [];
  for (const item of Object.values(state.artifacts?.items ?? {})) {
    if (item.deleted) continue;
    const version = item.versions.at(-1)!;
    const row = rows[version.seq]!, key = epochs.get(row.envelope.outside.epoch);
    if (!key || !isArtifactAction(row.proof.type)) throw new Error(historyError);
    const payload = (await readArtifactPayload(row.proof, row.envelope, key)).body as ArtifactPayload;
    const c = payload.content;
    const body = c.kind === 'skill' ? c.skill : c.kind === 'prompt' ? c.text : c.kind === 'document' ? c.markdown : c.kind === 'link' ? `${c.url}\n${c.summary}\n${c.notes}` : c.kind === 'data' ? c.text ?? `[${c.format} attachment]` : '[Binary attachment]';
    const comments: string[] = [];
    for (const comment of item.comments) {
      const row = rows[comment.seq]!, key = epochs.get(row.envelope.outside.epoch);
      if (!key) throw new Error(historyError);
      comments.push(`${comment.actor}: ${(await readArtifactPayload(row.proof, row.envelope, key)).body.text}`);
    }
    const attachments = payload.attachments.map(a => `${a.name} (${a.mime}, ${a.blob.size} bytes)`);
    // Unbounded private metadata joins the paged text, not page-header fields.
    artifacts.push({ id: item.id, type: c.kind, title: payload.title.slice(0, 256), tags: payload.tags.slice(0, 8).map(t => t.slice(0, 64)), body: [payload.title, payload.tags.join(', '), body, ...attachments, ...comments].join('\n'), createdAt: rows[item.versions[0]!.seq]!.proof.at, updatedAt: row.proof.at, author: { name: item.author, kind: 'person' }, writer: { name: version.actor, kind: 'person' }, version: version.id });
  }
  return { state, genesis, records, artifacts };
}

interface Person { name: string; kind: 'person' | 'agent'; email?: string }
interface Fields { id: string; type: string; title: string; body: string; tags: string[]; createdAt: string; updatedAt: string; author: Person; writer?: Person; version?: string; project?: string | null }
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value, null, 2)).length;

/** Longest prefix of text (never splitting a character) for which fits(prefix) holds. */
function fitPrefix(text: string, fits: (prefix: string) => boolean): string {
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, mid))) low = mid; else high = mid - 1;
  }
  const code = text.charCodeAt(low - 1);
  return low > 0 && code >= 0xd800 && code <= 0xdbff ? text.slice(0, low - 1) : text.slice(0, low);
}

export interface Page { number: number; of: number; body: Record<string, unknown> }
/** Builds every page of the journey, each under PAGE_LIMIT bytes. Long bodies continue across pages with a `part` marker. */
export async function readLink(row: LinkRow, secret: string, origin: string, call: Enclave, now = Date.now(), selector?: string): Promise<Page[]> {
  const selection = selector ?? 'main';
  const identity = await openLinkIdentity(secret, row.blob, row.journeyId, row.memberId);
  const { state, genesis, records, artifacts } = await readJourney(identity, row.memberId, row.journeyId, call);
  const selected = new Set(selectProjectArtifacts(state, selection));
  const mine = state.members[row.memberId]!.member;
  const expires = Math.min(row.expires, mine.expiresAt ? Date.parse(mine.expiresAt) : row.expires);
  if (expires <= now) throw new LinkExpired(expires, row.journeyId, row.memberId);
  const who = (id: string): Person => {
    const derived = state.members[id];
    if (!derived) return { name: 'Former member', kind: 'person' };
    if (derived.member.kind === 'agent') return { name: derived.member.name ?? 'Agent', kind: 'agent' };
    return { name: derived.profile?.name || 'Journey member', kind: 'person', ...(derived.profile?.email ? { email: derived.profile.email } : {}) };
  };
  const shown = itemVersions(records).filter(view => !view.deleted && view.item.itemType !== 'recovery');
  const entries: Fields[] = (selection === 'main' || selection === 'all' ? shown : []).map(view => ({ id: view.root, type: view.item.itemType, title: view.item.title, body: view.item.body, tags: view.item.tags, createdAt: view.versions[0]!.created, updatedAt: view.item.created, author: who(view.versions[0]!.author), project: null }));
  entries.push(...artifacts.filter(a => selected.has(a.id)).map(a => ({ ...a, author: who(a.author.name), writer: who(a.writer!.name), project: state.projects?.placements[a.id]?.project ?? null })));
  const projects = Object.values(state.projects?.items ?? {}).map(project => ({ id: project.id, purpose: project.purpose, state: project.state, revision: project.revision, participants: effectiveProjectParticipants(state, project.id, now).map(id => ({ id, ...who(id) })) }));
  const people = Object.values(state.members).filter(({ member }) => member.id !== row.memberId).map(({ member }) => who(member.id));
  const genesisBody = genesis.body as { name?: string; description?: string; journeyKind?: string };
  const remaining = expires - now;
  const total = expires - row.since;
  const url = renewUrl(origin, row.journeyId, row.memberId);
  const header = (number: number, of: number, next: string | null): Record<string, unknown> => ({
    about: ABOUT,
    journey: { id: row.journeyId, name: (state.settings?.name ?? genesisBody.name ?? '').slice(0, 256), description: (state.settings?.description ?? genesisBody.description ?? '').slice(0, 512), kind: genesisBody.journeyKind ?? 'individual' },
    access: { agentName: (mine.name ?? 'Agent').slice(0, 256), scope: 'read', expiresAt: new Date(expires).toISOString(), expiresInHours: Math.max(0, Math.floor(remaining / 3_600_000)), expiringSoon: remaining < 86_400_000 || remaining < total * 0.2, renewUrl: url, renewHint: `Access ends ${utc(expires)}. To continue, ask the person to open ${url} and extend it with their passkey; the link stays the same.` },
    page: { number, of, next },
    selection,
    howToWrite: HOW_TO_WRITE,
    ...(artifacts.length ? { attachments: 'Attachments require the member interface. This link does not offer downloads.' } : {}),
  });
  const next = (n: number): string => `${origin}/a/${secret}?page=${n}${selector === undefined ? '' : `&project=${encodeURIComponent(selector)}`}`;
  // Measure with the widest page markers so a later `of` or `next` cannot push a page over the limit.
  type Collection = 'items' | 'people' | 'projects';
  type Rows = Record<Collection, Record<string, unknown>[]>;
  const empty = (): Rows => ({ items: [], people: [], projects: [] });
  const pages: Rows[] = [empty()];
  const fits = (collection: Collection, value: Record<string, unknown>) => bytes({ ...header(999999, 999999, next(999999)), ...pages.at(-1), [collection]: [...pages.at(-1)![collection], value] }) <= PAGE_LIMIT;
  const fresh = () => { pages.push(empty()); };
  const append = (collection: Collection, value: Record<string, unknown>) => {
    if (!fits(collection, value)) fresh();
    if (!fits(collection, value)) throw new Error(historyError);
    pages.at(-1)![collection].push(value);
  };
  const text = (collection: Collection, value: Record<string, unknown>, field: string) => {
    if (fits(collection, value)) { append(collection, value); return; }
    fresh();
    if (fits(collection, value)) { append(collection, value); return; }
    let rest = String(value[field]); const parts: Record<string, unknown>[] = [];
    while (rest.length) {
      const piece = fitPrefix(rest, prefix => fits(collection, { ...value, [field]: prefix, part: { number: 999999, of: 999999 } }));
      if (!piece) throw new Error(historyError);
      const part = { ...value, [field]: piece, part: { number: 999999, of: 999999 } };
      append(collection, part); parts.push(part); rest = rest.slice(piece.length);
      if (rest.length) fresh();
    }
    parts.forEach((part, index) => { part.part = { number: index + 1, of: parts.length }; });
  };
  for (const person of people) text('people', { ...person }, 'name');
  for (const project of projects) {
    const { participants, ...summary } = project;
    text('projects', { ...summary, participants: [] }, 'purpose');
    const roster: Record<string, unknown>[] = [];
    for (const participant of participants) {
      const part = roster.at(-1);
      const value = { id: project.id, participants: [...(part?.participants as unknown[] ?? []), participant], part: { number: 999999, of: 999999 } };
      // Extend only the current page's roster; every append measures actual UTF-8 JSON.
      if (part && pages.at(-1)!.projects.at(-1) === part) {
        pages.at(-1)!.projects.pop();
        if (fits('projects', value)) { Object.assign(part, value); pages.at(-1)!.projects.push(part); continue; }
        pages.at(-1)!.projects.push(part);
      }
      const row = { id: project.id, participants: [participant], part: { number: 999999, of: 999999 } };
      append('projects', row); roster.push(row);
    }
    roster.forEach((part, index) => { part.part = { number: index + 1, of: roster.length }; });
  }
  for (const entry of entries) text('items', { ...entry }, 'body');
  const filled = pages.filter((page, index) => index === 0 || page.items.length || page.people.length || page.projects.length);
  return filled.map((page, index) => ({ number: index + 1, of: filled.length, body: { ...header(index + 1, filled.length, index + 1 < filled.length ? next(index + 2) : null), ...page } }));
}
export class LinkExpired extends Error { constructor(readonly expires: number, readonly journeyId: string, readonly memberId: string) { super('expired'); } }
