import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgeIdentity, createSigningIdentity, generateJourneyKey, hashControlProof, importSigningKey, newId, newPrivateId, privateHash, privateBytesHash, signPrivateHeader, verifyPrivateHeader, sealPrivateFrame, sealControlLabels, signControlProof, wrapJourneyKey, PRIVATE_SLOT_BYTES } from '@ai-wayfinding/core';
import type { ControlProof, Envelope, JsonObject, VaultOptions, VaultCacheRecord } from '@ai-wayfinding/core';
import { JourneyClient } from '../src/journey.js';
import type { RememberedAgent } from '../src/storage.js';
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
  it('refuses an agent vault open before private transport or cache mutation instead of initialising under agent keys', async () => {
    const scratch = resolve('../..', '.scratch', 'stage3-node'); await mkdir(scratch, { recursive: true }); const folder = await mkdtemp(join(scratch, 'agent-'));
    try {
      const f = await fixture(), journeyId = newId(), principal = newId(), ownerId = newId(), owner = await fixture(), key = generateJourneyKey();
      const controls: { seq: number; proof: ControlProof; envelope: Envelope }[] = [];
      const append = async (type: string, body: JsonObject) => {
        const entry = { v: 1 as const, seq: controls.length, prev: controls.length ? await hashControlProof(controls.at(-1)!.proof) : null, at: new Date().toISOString(), actor: ownerId, type, body };
        const envelope = await sealControlLabels(entry, { id: newId(), journey: journeyId, seq: entry.seq, epoch: 1, createdAt: entry.at }, key);
        controls.push({ seq: entry.seq, envelope, proof: await signControlProof(entry, envelope, journeyId, owner.options.signingKey) });
      };
      await append('genesis', { journey: journeyId, name: 'Test journey', creator: { id: ownerId, kind: 'person', recipient: owner.age.recipient, signingKey: owner.signing.publicKey }, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: '0.1.7' });
      await append('member.add', { member: { id: principal, kind: 'agent', recipient: f.age.recipient, signingKey: f.signing.publicKey, scope: 'readwrite', addedBy: ownerId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, grants: [], kind: 'agent' });
      const wrap = (await wrapJourneyKey(key, [{ id: principal, recipient: f.age.recipient }]))[0]!;
      const session: RememberedAgent = { server: 'https://app.wayfinding.support', journeyId, sessionId: newId(), principal, identity: f.age.identity, recipient: f.age.recipient, signingPrivateKey: f.signing.privateKey, signingKey: f.signing.publicKey, scope: 'readwrite', expiresAt: Date.now() + 3_600_000 };
      const fetcher = vi.fn(async (url: string | URL | Request): Promise<Response> => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/protocol')) return Response.json({ minClientVersion: '0.1.7', controlFormat: 'control-proof-v1', artifactFormat: 'artifact-v1', projectFormat: 'project-v1', privateFormat: 'private-v1' });
        if (path.endsWith('/log')) return Response.json({ log: controls });
        if (path.endsWith('/wraps/me')) return Response.json({ wraps: [{ epoch: 1, wrap: wrap.ciphertext }] });
        throw Error('unexpected private transport');
      });
      const cacheRead = vi.spyOn(NodePrivateStore.prototype, 'read'), cacheCommit = vi.spyOn(NodePrivateStore.prototype, 'commit');
      const client = new JourneyClient(session, { fetch: fetcher, cacheRoot: folder });
      try {
        for (let attempt = 0; attempt < 2; attempt++) await expect(client.openPrivateVault()).rejects.toThrow('Person vault not available to this agent yet.');
        expect(fetcher.mock.calls.some(([url]) => String(url).includes('/private-vault'))).toBe(false);
        expect(cacheRead).not.toHaveBeenCalled(); expect(cacheCommit).not.toHaveBeenCalled();
        expect((await readdir(folder)).every(name => !/^[a-f0-9]{64}$/.test(name))).toBe(true);
      } finally { client.close(); cacheRead.mockRestore(); cacheCommit.mockRestore(); }
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
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
