import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgeIdentity, createSigningIdentity, importSigningKey, newPrivateId, privateHash, privateBytesHash, signPrivateHeader, verifyPrivateHeader, sealPrivateFrame, PRIVATE_SLOT_BYTES } from '@ai-wayfinding/core';
import type { VaultOptions, VaultCacheRecord } from '@ai-wayfinding/core';
import { NodePrivateStore, rememberNodePrivateVault } from '../src/private-store.js';
import { forgetRemembered } from '../src/storage.js';

async function fixture() {
  const age = await createAgeIdentity(), signing = await createSigningIdentity(), vault = newPrivateId(), author = { kind: 'person' as const, signingKey: signing.publicKey, recipient: age.recipient };
  const options: VaultOptions = { identity: age.identity, signingKey: await importSigningKey(signing.privateKey), trust: { vault, author }, transport: { read: async () => { throw Error('unexpected network'); }, commit: async () => { throw Error('unexpected network'); } } };
  const ciphertext = Buffer.alloc(PRIVATE_SLOT_BYTES).toString('base64'), hash = await privateBytesHash(new Uint8Array(PRIVATE_SLOT_BYTES)), slots = Array<string>(64).fill(ciphertext), root = Buffer.alloc(32, 7).toString('base64'), directory = { initialized: [], branches: [] };
  const build = async (version: number, prev: string | null): Promise<VaultCacheRecord> => {
    const header = await signPrivateHeader({ format: 'private-v1', v: 1, vault, author, version, prev, slots: Array<string>(64).fill(hash), contentsHash: await privateHash({ slots: Array<string>(64).fill(hash), root, directory }) }, options.signingKey);
    const checkpoint = (await verifyPrivateHeader(header, options.trust, { contentsHash: header.contentsHash })).checkpoint;
    return { token: '0'.repeat(64), frame: await sealPrivateFrame({ header, root, directory }, age.recipient), slots, checkpoint };
  };
  return { vault, options, build, age, signing };
}

describe('Node private encrypted checkpoint cache', () => {
  it('reopens existing keys, atomically advances and refuses races, rollback, extras, foreign keys; preserves live files', async () => {
    const scratch = resolve('../..', '.scratch', 'stage3-node'); await mkdir(scratch, { recursive: true }); const folder = await mkdtemp(join(scratch, 'vault-'));
    try {
      const f = await fixture(), store = new NodePrivateStore(folder, f.vault, f.options), first = await f.build(1, null);
      expect(await store.read()).toBeNull(); await store.commit(null, first);
      const second = await f.build(2, first.checkpoint.head); await store.commit(first.checkpoint.head, second);
      expect((await new NodePrivateStore(folder, f.vault, f.options).read())!.checkpoint.head).toBe(second.checkpoint.head);
      await expect(store.commit(first.checkpoint.head, second)).rejects.toThrow('concurrent');
      await expect(store.commit(second.checkpoint.head, first)).rejects.toThrow('rollback');
      await expect(store.commit(second.checkpoint.head, { ...second, plaintext: 'PRIVATE CACHE CANARY' } as VaultCacheRecord)).rejects.toThrow();
      const other = await createAgeIdentity(); await expect(new NodePrivateStore(folder, f.vault, { ...f.options, identity: other.identity }).read()).rejects.toThrow();
      const dir = join(folder, f.vault), files = await readdir(dir); expect(files.filter(n => n.endsWith('.vault'))).toHaveLength(1);
      for (const file of files) { const bytes = await readFile(join(dir, file), 'utf8'); for (const secret of [f.age.identity, f.signing.privateKey, f.vault, 'PRIVATE CACHE CANARY', 'directory', 'branches']) expect(bytes).not.toContain(secret); expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600); }
      // An interrupted pre-pointer write is never selected on restart and is
      // collected only after a later atomic commit under the same lock.
      const orphan = 'a'.repeat(64) + '.vault'; await writeFile(join(dir, orphan), 'interrupted', { mode: 0o600 }); expect((await store.read())!.checkpoint.head).toBe(second.checkpoint.head);
      const third = await f.build(3, second.checkpoint.head); await store.commit(second.checkpoint.head, third); expect(await readdir(dir)).not.toContain(orphan);
      let closed = false; rememberNodePrivateVault({ close: () => { closed = true; } }); await forgetRemembered({ folder }); expect(closed).toBe(true);
    } finally { await rm(folder, { recursive: true, force: true }); }
  }, 60000);
});
