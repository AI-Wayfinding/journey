import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createAgeIdentity, createSigningIdentity, importSigningKey, newPrivateId, privateHash, privateBytesHash, signPrivateHeader, verifyPrivateHeader, sealPrivateFrame, PRIVATE_SLOT_BYTES } from '@ai-wayfinding/core';
import type { VaultOptions, VaultCacheRecord } from '@ai-wayfinding/core';
import { BrowserPrivateStore, rememberPrivateVault } from './private-store.js';
import { lockPersonKeys } from './keys.js';
const base64 = (bytes: Uint8Array) => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); };

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
