import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgeIdentity, createSigningIdentity, generateJourneyKey, hashControlProof, importSigningKey, newId, newPrivateId, privateHash, privateBytesHash, signPrivateHeader, verifyPrivateHeader, sealPrivateFrame, sealControlLabels, signControlProof, wrapJourneyKey, PRIVATE_SLOT_BYTES, PrivateVault, verifyPrivateContext, memberVaultId, privateIdentity, privatePersonSession, privateAuthorityHistory, privateAuthority, signPrivateRecord, artifactTypeHash, privateRandomBytes,  decodeVaultPatch, openVaultAgentWrap } from '@ai-wayfinding/core';
import type { ControlProof, Envelope, JsonObject, VaultOptions, VaultCacheRecord } from '@ai-wayfinding/core';
import { JourneyClient } from '../src/journey.js';
import type { RememberedAgent } from '../src/storage.js';
import { NodePrivateStore, rememberNodePrivateVault, openPersonPrivateVault } from '../src/private-store.js';
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
  it('delivers a person key at approval/backfill; the agent reads and writes the same vault with its own keys, then fails after removal', async () => {
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
      const agent = { id: principal, kind: 'agent' as const, recipient: f.age.recipient, signingKey: f.signing.publicKey, scope: 'readwrite' as const, addedBy: ownerId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
      await append('member.add', { member: agent, grants: [], kind: 'agent' });
      const wrap = (await wrapJourneyKey(key, [{ id: principal, recipient: f.age.recipient }]))[0]!;
      const session: RememberedAgent = { server: 'https://app.wayfinding.support', journeyId, sessionId: newId(), principal, identity: f.age.identity, recipient: f.age.recipient, signingPrivateKey: f.signing.privateKey, signingKey: f.signing.publicKey, scope: 'readwrite', expiresAt: Date.now() + 3_600_000 };
      const context = await verifyPrivateContext({ journey: journeyId, creator: controls[0]!.proof.body.creator as import('@ai-wayfinding/core').Member, controls }, { now: Date.now(), currentHead: await hashControlProof(controls.at(-1)!.proof) });
      const author = owner.options.trust.author, vault = await memberVaultId(journeyId, ownerId, author.signingKey, author.recipient), personSession = await privatePersonSession(context, author, owner.options.signingKey, owner.age.identity);
      let time = 0, token = 0, frame: string | null = null, removed = false;
      const slots = Array<string>(64).fill(Buffer.alloc(PRIVATE_SLOT_BYTES).toString('base64'));
      const transport: VaultOptions['transport'] = {
        read: async indices => ({ token: token.toString(16).padStart(64, '0'), frame, slots: (indices === 'all' ? Array.from({ length: 64 }, (_, i) => i) : indices).map(index => ({ index, ciphertext: slots[index]! })) }),
        commit: async patch => { expect(patch.token).toBe(token.toString(16).padStart(64, '0')); frame = patch.frame; for (const slot of patch.slots) slots[slot.index] = slot.ciphertext; return { token: (++token).toString(16).padStart(64, '0') }; },
      };
      const options: VaultOptions = { identity: owner.age.identity, signingKey: owner.options.signingKey, trust: { vault, author }, contexts: [context], sessions: [personSession], transport, now: () => time, randomOrder: () => Array.from({ length: 64 }, (_, i) => i) };
      let delivered = '';
      const delivery = { agents: async () => [agent], put: async (id: string, ciphertext: string) => { expect(id).toBe(principal); delivered = ciphertext; } };
      const person = await openPersonPrivateVault(options, context, delivery); expect(delivered).toBeTruthy();
      const contentIdentity = await openVaultAgentWrap(delivered, { journey: journeyId, person: ownerId, agent: principal, vault, author, recipient: privateIdentity(agent) }, f.age.identity);
      expect(contentIdentity).not.toBe(owner.age.identity); expect(contentIdentity).not.toBe(owner.signing.privateKey);
      const copy = newPrivateId(), artifact = newPrivateId(), payload = { type: 'artifact.content', typeVersion: 1, body: { title: 'From person', tags: [], content: { kind: 'document', markdown: 'Private text' }, attachments: [] } };
      const first = await signPrivateRecord({ format: 'private-v1', v: 1, id: newId(), vault, copy, seq: 0, prev: null, at: new Date().toISOString(), actor: author, authority: privateAuthority(context, author), type: 'private.create', body: { artifact, author: { ...author }, actor: { ...author }, version: newId(), typeHash: await artifactTypeHash('document'), blobs: [], predecessor: null }, payloadHash: await privateHash(payload) }, owner.options.signingKey);
      const bundle: import('@ai-wayfinding/core').PrivateBundle = { format: 'private-v1', version: 1, vault, author, scope: 'author-backup', authorityHistories: [privateAuthorityHistory(context)], records: [first], payloads: [{ record: first.id, payload }], copyKeys: [{ copy, key: Buffer.from(privateRandomBytes(32)).toString('base64') }], blobs: [], unavailableDeletedBlobs: [] };
      await person.stage(bundle); time = 300000; await person.tick(); person.close();
      const backfilled = await openPersonPrivateVault(options, context, delivery); expect(delivered).toBeTruthy(); backfilled.close();
      const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const path = new URL(String(url)).pathname;
        if (removed) return Response.json({ error: { code: 'forbidden' } }, { status: 403 });
        if (path.endsWith('/private-agent-wrap/' + principal)) return Response.json({ ciphertext: delivered });
        if (path.endsWith('/private-vault')) {
          if (init?.method === 'PUT') return Response.json(await transport.commit(decodeVaultPatch(new Uint8Array(init.body as Uint8Array))));
          const query = new URL(String(url)).searchParams.get('slots')!;
          const indices = query === 'all' ? 'all' : query.split(',').map(Number);
          const wire = await transport.read(indices), frameBytes = 32768;
          const bytes = new Uint8Array(65 + frameBytes + wire.slots.length * (1 + PRIVATE_SLOT_BYTES));
          bytes.set(new TextEncoder().encode(wire.token)); bytes[64] = wire.frame ? 1 : 0;
          if (wire.frame) bytes.set(Buffer.from(wire.frame, 'base64'), 65);
          let offset = 65 + frameBytes; for (const row of wire.slots) { bytes[offset++] = row.index; bytes.set(Buffer.from(row.ciphertext, 'base64'), offset); offset += PRIVATE_SLOT_BYTES; }
          return new Response(bytes);
        }
        if (path.endsWith('/protocol')) return Response.json({ minClientVersion: '0.1.7', controlFormat: 'control-proof-v1', artifactFormat: 'artifact-v1', projectFormat: 'project-v1', privateFormat: 'private-v1' });
        if (path.endsWith('/log')) return Response.json({ log: controls });
        if (path.endsWith('/wraps/me')) return Response.json({ wraps: [{ epoch: 1, wrap: wrap.ciphertext }] });
        throw Error('unexpected private transport');
      });
      const cacheRead = vi.spyOn(NodePrivateStore.prototype, 'read'), cacheCommit = vi.spyOn(NodePrivateStore.prototype, 'commit');
      const client = new JourneyClient(session, { fetch: fetcher, cacheRoot: folder });
      try {
        const controller = await client.openPrivateVault();
        expect(controller.branches[0]!.bundle.records).toEqual([first]);
        const actor = privateIdentity(agent), changedPayload = { ...payload, body: { ...payload.body, title: 'From agent' } };
        const edit = await signPrivateRecord({ format: 'private-v1', v: 1, id: newId(), vault, copy, seq: 1, prev: await privateHash(first), at: new Date().toISOString(), actor, authority: privateAuthority(context, actor), type: 'private.version', body: { artifact, author: { ...author }, actor: { ...actor }, version: newId(), typeHash: await artifactTypeHash('document'), blobs: [], predecessor: first.body.version }, payloadHash: await privateHash(changedPayload) }, f.options.signingKey);
        await controller.stage({ ...bundle, records: [first, edit], payloads: [...bundle.payloads, { record: edit.id, payload: changedPayload }] });
        await controller.sync(true);
        expect(cacheRead).toHaveBeenCalled(); expect(cacheCommit).toHaveBeenCalled();
        const writtenHeader = (await import('@ai-wayfinding/core')).openPrivateFrame;
        const raw = await writtenHeader(frame!, owner.age.identity, author.recipient) as { header: { writer: unknown; version: number } };
        expect(raw.header.writer).toEqual(actor);
        const reopened = new PrivateVault({ ...options, cache: undefined }); await reopened.open();
        expect(reopened.branches[0]!.bundle.payloads.at(-1)!.payload.body.title).toBe('From agent');
        expect(reopened.branches[0]!.bundle.records.at(-1)!.actor).toEqual(actor); reopened.close();
        // A held controller cannot reach the server after removal either.
        removed = true;
        await expect(controller.sync(true)).rejects.toThrow('ended');
        await expect(client.openPrivateVault()).rejects.toThrow('ended');
      } finally { client.close(); cacheRead.mockRestore(); cacheCommit.mockRestore(); }
    } finally { await rm(folder, { recursive: true, force: true }); }
  }, 60000);
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
