import { decodeVaultWire, encodeVaultPatch, PrivateVault, memberVaultId, privateIdentity, privatePersonSession, verifyPrivateContext, canonical, openIdentity, sealIdentity, validateVaultCache, verifyVaultCacheAdvance, validPrivateId } from '@ai-wayfinding/core';
import type { VaultCache, VaultCacheRecord, VaultOptions, VaultTransport, PrivateCheckpoint, Member } from '@ai-wayfinding/core';

/** Ciphertext and checkpoint are separate rows in one atomic IndexedDB commit.
 * Checkpoints are independently age-encrypted; no directory, key, count or body
 * is ever passed to IndexedDB. Databases are isolated by random member vault ID. */
export class BrowserPrivateStore implements VaultCache {
  constructor(readonly vault: string, private options: VaultOptions, private name = 'wayfinding-private-' + vault) { if (!validPrivateId(vault)) throw new Error('Invalid private cache binding'); }
  private database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => { const request = indexedDB.open(this.name, 1); request.onupgradeneeded = () => request.result.createObjectStore('encrypted'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }
  private async rows(): Promise<{ record: string | null; checkpoint: string | null }> {
    const db = await this.database();
    try { return await new Promise((resolve, reject) => { const tx = db.transaction('encrypted', 'readonly'), store = tx.objectStore('encrypted'), record = store.get('vault'), checkpoint = store.get('checkpoint'); tx.oncomplete = () => resolve({ record: record.result ?? null, checkpoint: checkpoint.result ?? null }); tx.onerror = () => reject(tx.error); }); }
    finally { db.close(); }
  }
  async read(): Promise<VaultCacheRecord | null> {
    const rows = await this.rows(); if (!rows.record && !rows.checkpoint) return null;
    if (!rows.record || !rows.checkpoint) throw new Error('Interrupted private cache commit');
    const record = JSON.parse(rows.record) as { token: string; frame: string; slots: string[] };
    if (!record || Object.keys(record).sort().join(',') !== 'frame,slots,token') throw new Error('Invalid private cache fields');
    const checkpoint = JSON.parse(await openIdentity(rows.checkpoint, [this.options.identity]));
    return validateVaultCache({ token: record.token, frame: record.frame, slots: record.slots, checkpoint }, this.options);
  }
  async commit(expected: string | null, input: VaultCacheRecord): Promise<void> {
    const value = await validateVaultCache(input, this.options), previous = await this.rows();
    const retained = previous.checkpoint ? JSON.parse(await openIdentity(previous.checkpoint, [this.options.identity])) as { head: string } : null;
    if ((retained?.head ?? null) !== expected) throw new Error('Private cache concurrent checkpoint');
    const prior = await this.read();
    if (prior) await verifyVaultCacheAdvance(prior, value, this.options);
    const checkpoint = await sealIdentity(canonical(value.checkpoint), [this.options.trust.author.recipient]);
    const record = canonical({ token: value.token, frame: value.frame, slots: value.slots });
    const db = await this.database();
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('encrypted', 'readwrite'), store = tx.objectStore('encrypted'), read = store.get('checkpoint');
      read.onsuccess = () => { if ((read.result ?? null) !== previous.checkpoint) { tx.abort(); return; } store.put(record, 'vault'); store.put(checkpoint, 'checkpoint'); };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(new Error('Private cache concurrent commit')); tx.onerror = () => reject(tx.error);
    }); } finally { db.close(); }
  }
}
const syncErrors = new WeakMap<PrivateVault, string>();
export function privateSyncError(vault: PrivateVault): string | undefined { return syncErrors.get(vault); }
const controllers = new Set<{ close(): void }>();
export function rememberPrivateVault(controller: { close(): void }): void { controllers.add(controller); }
export function closePrivateVaults(): void { for (const controller of controllers) controller.close(); controllers.clear(); activeJourneys.clear(); }

import type { JourneyContext } from './journey.js';
import { api } from './journey.js';
import { sealVaultAgentWrap, privateAgentAudience } from '@ai-wayfinding/core';

/** Every open backfills only verified own agents with authenticated credentials. */
export async function deliverJourneyVaultWraps(ctx: JourneyContext, controller: PrivateVault): Promise<void> {
  const context = await verifyPrivateContext({ journey: ctx.id, creator: ctx.controls[0]!.proof.body.creator as Member, controls: ctx.controls }, { now: Date.now(), currentHead: ctx.state.lastHash! });
  const author = privateIdentity(ctx.state.members[ctx.principal]!.member);
  const vault = await memberVaultId(ctx.id, ctx.principal, author.signingKey, author.recipient);
  const agents = await api<{ agents: { principal: string }[] }>(`/journeys/${ctx.id}/private-agents`, 'GET', undefined, ctx.principal);
  for (const row of agents.agents) {
    const member = ctx.state.members[row.principal]?.member;
    if (!member || member.kind !== 'agent' || !privateAgentAudience(context, author, privateIdentity(member))) continue;
    // The server also checks audience and excludes link credentials at delivery.
    const ciphertext = await sealVaultAgentWrap({ journey: ctx.id, person: ctx.principal, agent: member.id, vault, author, recipient: privateIdentity(member) }, controller.agentContentIdentity, ctx.keys.signingPrivateKey);
    await api(`/journeys/${ctx.id}/private-agent-wrap/${member.id}`, 'PUT', { ciphertext }, ctx.principal);
  }
}
const activeJourneys = new Map<string, { principal: string; controlHash: string; controller: PrivateVault }>();
export function browserVaultTransport(journey: string, principal: string, fetcher: typeof fetch = fetch): VaultTransport {
  const request = async (query: string, body?: Uint8Array): Promise<Response> => {
    const response = await fetcher(`/v1/journeys/${journey}/private-vault${query}`, { method: body ? 'PUT' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Principal': principal, 'X-Client-Version': '0.1.7', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Project-Format': 'project-v1', 'X-Private-Format': 'private-v1', ...(body ? { 'X-Wayfinding': '1', 'Content-Type': 'application/octet-stream' } : {}) }, ...(body ? { body: new Uint8Array(body) } : {}) });
    if (!response.ok) throw new Error('Private vault request failed (' + response.status + ')'); return response;
  };
  return { read: async indices => decodeVaultWire(new Uint8Array(await (await request('?slots=' + (indices === 'all' ? 'all' : indices.map(i => String(i).padStart(2, '0')).join(',')))).arrayBuffer()), indices), commit: async patch => (await request('', encodeVaultPatch(patch))).json() };
}
/** Called for every open journey, whether or not any private copies exist. */
export async function openJourneyVault(ctx: JourneyContext, paired?: PrivateCheckpoint): Promise<PrivateVault> {
  const active = activeJourneys.get(ctx.id);
  if (!paired && active?.principal === ctx.principal && active.controlHash === ctx.state.lastHash) return active.controller;
  if (active) { active.controller.close(); activeJourneys.delete(ctx.id); }
  const member = ctx.state.members[ctx.principal]!.member, author = privateIdentity(member);
  const context = await verifyPrivateContext({ journey: ctx.id, creator: ctx.controls[0]!.proof.body.creator as Member, controls: ctx.controls }, { now: Date.now(), currentHead: ctx.state.lastHash! });
  const session = await privatePersonSession(context, author, ctx.keys.signingPrivateKey, ctx.keys.identity);
  const vault = await memberVaultId(ctx.id, ctx.principal, author.signingKey, author.recipient);
  const options: VaultOptions = { identity: ctx.keys.identity, signingKey: ctx.keys.signingPrivateKey, trust: { vault, author }, contexts: [context], sessions: [session], paired, transport: browserVaultTransport(ctx.id, ctx.principal) };
  options.cache = new BrowserPrivateStore(vault, options);
  const controller = new PrivateVault(options); rememberPrivateVault(controller);
  activeJourneys.set(ctx.id, { principal: ctx.principal, controlHash: ctx.state.lastHash!, controller });
  try {
    await controller.open(); await deliverJourneyVaultWraps(ctx, controller);
    // Exactly the portable fixed schedule; errors remain local to the authorized UI.
    const timer = setInterval(() => { void controller.tick().then(() => syncErrors.delete(controller), cause => syncErrors.set(controller, cause instanceof Error ? cause.message : 'Private sync failed')); }, 300000);
    rememberPrivateVault({ close: () => clearInterval(timer) });
    return controller;
  } catch (error) { closePrivateVaults(); throw error; }
}
