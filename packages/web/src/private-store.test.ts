import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createAgeIdentity, createSigningIdentity, importSigningKey, newPrivateId, privateHash, privateBytesHash, signPrivateHeader, verifyPrivateHeader, sealPrivateFrame, PRIVATE_SLOT_BYTES, newId, generateJourneyKey, hashControlProof, sealControlLabels, signControlProof, verifyControlProofs, privateIdentity, memberVaultId, openVaultAgentWrap } from '@ai-wayfinding/core';
import type { VaultOptions, VaultCacheRecord, PrivateVault, Member, ControlProof, Envelope, JsonObject } from '@ai-wayfinding/core';
import { BrowserPrivateStore, rememberPrivateVault, deliverJourneyVaultWraps } from './private-store.js';
import { lockPersonKeys } from './keys.js';
import type { JourneyContext } from './journey.js';
const base64 = (bytes: Uint8Array) => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); };

it('delivers only verified own agents at approval and backfill without delegating owner keys', async () => {
  const owner = await createAgeIdentity(), signing = await createSigningIdentity(), ownerKey = await importSigningKey(signing.privateKey), journey = newId(), person = newId(), content = await createAgeIdentity(), key = generateJourneyKey();
  const creator: Member = { id: person, kind: 'person', signingKey: signing.publicKey, recipient: owner.recipient }, controls: { proof: ControlProof; envelope: Envelope }[] = [];
  const append = async (type: string, body: JsonObject) => {
    const entry = { v: 1 as const, seq: controls.length, prev: controls.length ? await hashControlProof(controls.at(-1)!.proof) : null, at: new Date().toISOString(), actor: person, type, body };
    const envelope = await sealControlLabels(entry, { id: newId(), journey, seq: entry.seq, epoch: 1, createdAt: entry.at }, key);
    controls.push({ proof: await signControlProof(entry, envelope, journey, ownerKey), envelope });
  };
  await append('genesis', { journey, name: 'Private', creator, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: '0.1.7' });
  const makeAgent = async (addedBy: string) => { const age = await createAgeIdentity(), sig = await createSigningIdentity(); return { age, member: { id: newId(), kind: 'agent' as const, recipient: age.recipient, signingKey: sig.publicKey, scope: 'readwrite' as const, addedBy, expiresAt: new Date(Date.now() + 3600000).toISOString() } }; };
  const own = await makeAgent(person), otherAge = await createAgeIdentity(), otherSig = await createSigningIdentity(), other: Member = { id: newId(), kind: 'person', recipient: otherAge.recipient, signingKey: otherSig.publicKey };
  await append('member.add', { member: own.member, grants: [], kind: 'agent' });
  await append('member.add', { member: other, grants: [], kind: 'person' });
  const foreign = await makeAgent(other.id); // A hostile candidate list must not change verified audience.
  const foreignEntry = { v: 1 as const, seq: controls.length, prev: await hashControlProof(controls.at(-1)!.proof), at: new Date().toISOString(), actor: other.id, type: 'member.add', body: { member: foreign.member, grants: [], kind: 'agent' } };
  const envelope = await sealControlLabels(foreignEntry, { id: newId(), journey, seq: foreignEntry.seq, epoch: 1, createdAt: foreignEntry.at }, key);
  controls.push({ proof: await signControlProof(foreignEntry, envelope, journey, await importSigningKey(otherSig.privateKey)), envelope });
  const checked = await verifyControlProofs(controls.map(c => c.proof), controls.map(c => c.envelope), { journey, creator });
  if (!checked.ok) throw Error(checked.error.message);
  const ctx: JourneyContext = { id: journey, principal: person, keys: { identity: owner.identity, recipient: owner.recipient, signingKey: signing.publicKey, signingPrivateKey: ownerKey }, state: checked.state, epochs: new Map([[1, key]]), log: [], controls };
  const deliveries: string[] = [], fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'GET') return Response.json({ agents: [{ principal: own.member.id }, { principal: foreign.member.id }, { principal: other.id }, { principal: newId() }] });
    expect(JSON.stringify(init)).not.toContain(owner.identity); expect(JSON.stringify(init)).not.toContain(signing.privateKey);
    deliveries.push(JSON.parse(init!.body as string).ciphertext); return Response.json({ ok: true });
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    const controller = { retainedCheckpoint: { version: 1 }, agentContentIdentity: content.identity } as PrivateVault;
    await deliverJourneyVaultWraps(ctx, controller); await deliverJourneyVaultWraps(ctx, controller);
    expect(deliveries).toHaveLength(2);
    const author = privateIdentity(creator), vault = await memberVaultId(journey, person, author.signingKey, author.recipient);
    for (const ciphertext of deliveries) expect(await openVaultAgentWrap(ciphertext, { journey, person, agent: own.member.id, vault, author, recipient: privateIdentity(own.member) }, own.age.identity)).toBe(content.identity);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([url]) => String(url))).toEqual(Array(2).fill(`/v1/journeys/${journey}/private-agent-wrap/${own.member.id}`));
  } finally { vi.unstubAllGlobals(); }
});
it('does not demand a key wrap from an uninitialized read-only vault during agent approval', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  try {
    const controller = { retainedCheckpoint: undefined, get agentContentIdentity(): string { throw Error('No initialized content key'); } } as PrivateVault;
    await deliverJourneyVaultWraps({} as JourneyContext, controller);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
describe('browser encrypted member cache', () => {
  it('reopens independently encrypted checkpoints and refuses rollback, extra fields, races and wrong keys without persisting plaintext', async () => {
    const age = await createAgeIdentity(), signing = await createSigningIdentity(), vault = newPrivateId(), author = { kind: 'person' as const, signingKey: signing.publicKey, recipient: age.recipient };
    const options: VaultOptions = { identity: age.identity, signingKey: await importSigningKey(signing.privateKey), trust: { vault, author }, transport: { read: async () => { throw Error('network'); }, commit: async () => { throw Error('network'); } } };
    const slots = Array<string>(64).fill(base64(new Uint8Array(PRIVATE_SLOT_BYTES))), hashes = Array<string>(64).fill(await privateBytesHash(new Uint8Array(PRIVATE_SLOT_BYTES))), root = base64(new Uint8Array(32).fill(3)), directory = { initialized: [], branches: [] };
    const build = async (version: number, prev: string | null): Promise<VaultCacheRecord> => { const header = await signPrivateHeader({ format: 'private-v1', v: 1, vault, author, version, prev, slots: hashes, contentsHash: await privateHash({ slots: hashes, root, directory }) }, options.signingKey); return { token: '0'.repeat(64), frame: await sealPrivateFrame({ header, root, directory }, age.recipient), slots, checkpoint: (await verifyPrivateHeader(header, options.trust, { contentsHash: header.contentsHash })).checkpoint }; };
    const name = 'test-private-' + vault, store = new BrowserPrivateStore(vault, options, name), first = await build(1, null);
    expect(await store.read()).toBeNull(); await store.commit(null, first);
    const next = await build(2, first.checkpoint.head); await store.commit(first.checkpoint.head, next);
    expect((await new BrowserPrivateStore(vault, options, name).read())!.checkpoint.head).toBe(next.checkpoint.head);
    await expect(store.commit(first.checkpoint.head, next)).rejects.toThrow('concurrent');
    await expect(store.commit(next.checkpoint.head, first)).rejects.toThrow('rollback');
    await expect(store.commit(next.checkpoint.head, { ...next, plaintext: 'PRIVATE CACHE CANARY' } as VaultCacheRecord)).rejects.toThrow();
    const other = await createAgeIdentity(); await expect(new BrowserPrivateStore(vault, { ...options, identity: other.identity }, name).read()).rejects.toThrow();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const saved = await new Promise<unknown[]>((resolve, reject) => { const r = db.transaction('encrypted').objectStore('encrypted').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close();
    for (const secret of [age.identity, signing.privateKey, vault, 'PRIVATE CACHE CANARY', 'directory', 'branches']) expect(JSON.stringify(saved)).not.toContain(secret);
    let closed = false; rememberPrivateVault({ close: () => { closed = true; } }); lockPersonKeys(); expect(closed).toBe(true);
    await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
  }, 60000);
});
