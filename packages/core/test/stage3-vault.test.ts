import { describe, expect, it } from 'vitest';
import { PrivateVault, PRIVATE_SLOT_BYTES, PRIVATE_HEADER_BYTES, privateDecode, privateHash, privateAuthorityHistory, privateRandomBytes, selectPrivateSlots, verifyVaultCacheAdvance, validateVaultCache, openPrivateFrame, sealPrivateFrame, signPrivateHeader, encodeVaultPatch, newId, newPrivateId, privatePersonSession, privateAgentSession, privateIdentity, privateSnapshotHash, memberVaultId, privateCopies } from '../src/index.js';
import type { PrivateBundle, PrivateRecord, PrivatePayload, VaultOptions, VaultCacheRecord, VaultPatch, VaultWire } from '../src/index.js';
import { encode } from '../src/codec.js';
import { privateFixture, created, record, content, artifactFixture, artifactAppend, contextFor, marker, agent, now } from './stage0-fixture.js';

async function fixture() {
  const f = await privateFixture(), c = await created(f);
  const bundle: PrivateBundle = { format: 'private-v1', version: 1, vault: f.vault, author: f.identity, scope: 'author-backup', authorityHistories: [privateAuthorityHistory(f.context)], records: c.records, payloads: c.payloads, copyKeys: [{ copy: f.copy, key: encode(privateRandomBytes(32)) }], blobs: [], unavailableDeletedBlobs: [] };
  let time = 0, token = 0, frame: string | null = null, fail = false;
  const slots = Array<string>(64).fill(encode(new Uint8Array(PRIVATE_SLOT_BYTES))), trace: { at: number; method: string; size: number }[] = [];
  let cache: VaultCacheRecord | null = null;
  const options: VaultOptions = { trust: { vault: f.vault, author: f.identity }, identity: f.author.identity, signingKey: f.author.key, contexts: [f.context], sessions: [f.session], now: () => time, randomOrder: () => Array.from({ length: 64 }, (_, i) => i), transport: {
    read: async indices => { const wanted = indices === 'all' ? Array.from({ length: 64 }, (_, i) => i) : indices; trace.push({ at: time, method: 'GET', size: 65 + PRIVATE_HEADER_BYTES + wanted.length * (1 + PRIVATE_SLOT_BYTES) }); return { token: token.toString(16).padStart(64, '0'), frame, slots: wanted.map(index => ({ index, ciphertext: slots[index]! })) }; },
    commit: async patch => { trace.push({ at: time, method: 'PUT', size: encodeVaultPatch(patch).length }); if (fail || patch.token !== token.toString(16).padStart(64, '0')) throw Error('conflict'); frame = patch.frame; for (const s of patch.slots) slots[s.index] = s.ciphertext; token++; return { token: token.toString(16).padStart(64, '0') }; },
  }, cache: { read: async () => cache, commit: async (expected, next) => { if ((cache?.checkpoint.head ?? null) !== expected) throw Error('cache race'); if (cache) await verifyVaultCacheAdvance(cache, next, options); cache = structuredClone(next); } } };
  return { f, bundle, options, trace, slots, time: (n: number) => { time = n; }, fail: (v: boolean) => { fail = v; }, snapshot: () => structuredClone(cache!), head: () => frame, replace: (value: string | null) => { frame = value; }, controller: new PrivateVault(options) };
}

describe('scheduled fixed member vault controller', () => {
  it('an agent with legacy read scope initialises its person vault with its own signature', async () => {
    const f = await fixture(), actor = privateIdentity(f.f.reader.member);
    const session = await privateAgentSession(f.f.context, actor, f.f.reader.key, f.f.reader.identity, 'authenticated');
    const delegated = new PrivateVault({ ...f.options, cache: undefined, actor, identity: f.f.reader.identity, signingKey: f.f.reader.key, sessions: [session] });
    try {
      await delegated.open();
      expect(delegated.retainedCheckpoint!.version).toBe(1);
      const raw = await openPrivateFrame(f.head()!, f.f.author.identity, f.f.identity.recipient) as { header: import('../src/index.js').PrivateHeader };
      expect(raw.header.writer).toEqual(actor); expect(raw.header.author).toEqual(f.f.identity);
      expect(delegated.agentContentIdentity).toMatch(/^AGE-SECRET-KEY-/);
    } finally { delegated.close(); }
  }, 60000);
  it('persists an agent author and a distinct sibling signer in the person vault', async () => {
    const f = await fixture(), author = privateIdentity(f.f.writer.member), actor = privateIdentity(f.f.reader.member);
    const writer = await privateAgentSession(f.f.context, author, f.f.writer.key, f.f.writer.identity, 'authenticated');
    const sibling = await privateAgentSession(f.f.context, actor, f.f.reader.key, f.f.reader.identity, 'authenticated');
    const first = await record(f.f.context, f.f.writer, f.f.vault, f.f.copy, f.f.artifact, author);
    const edit = await record(f.f.context, f.f.reader, f.f.vault, f.f.copy, f.f.artifact, author, 'private.version', [first.record], content('Sibling version'));
    const bundle = { ...f.bundle, records: [first.record, edit.record], payloads: [first.payload, edit.payload] };
    f.options.sessions = [f.f.session, writer, sibling];
    await f.controller.open(); await f.controller.stage(bundle); f.time(300000); await f.controller.tick();
    f.controller.close();
    const reopened = new PrivateVault({ ...f.options, cache: undefined });
    await reopened.open();
    expect(reopened.branches[0]!.bundle.author).toEqual(f.f.identity);
    expect(reopened.branches[0]!.bundle.records[0]!.body.author).toEqual(author);
    expect(reopened.branches[0]!.bundle.records[1]!.actor).toEqual(actor);
    expect(reopened.branches[0]!.bundle.records[1]!.sig).toBe(edit.record.sig);
    reopened.close();
  }, 60000);
  it.each(['expiry', 'removal'] as const)('person reopens agent-signed head on a fresh device after signer %s', async reason => {
    const f = await fixture(), writer = await agent(f.f.author.member.id);
    writer.member.expiresAt = new Date(Date.now() + 60000).toISOString();
    await artifactAppend(f.f.f, f.f.author, 'member.add', { member: writer.member, kind: 'agent', grants: [] });
    const live = await contextFor(f.f.f);
    f.options.contexts = [live];
    f.options.sessions = [await privatePersonSession(live, f.f.identity, f.f.author.key, f.f.author.identity)];
    await f.controller.open(); await f.controller.stage(f.bundle); f.time(300000); await f.controller.tick();
    const contentIdentity = f.controller.agentContentIdentity;
    const actor = privateIdentity(writer.member), session = await privateAgentSession(live, actor, writer.key, writer.identity, 'authenticated');
    f.controller.close();
    const delegated = new PrivateVault({ ...f.options, cache: undefined, identity: writer.identity, signingKey: writer.key, contentIdentity, actor, sessions: [session] });
    await delegated.open();
    const agentHead = delegated.retainedCheckpoint!;
    const frame = await openPrivateFrame(f.head()!, f.f.author.identity, f.f.identity.recipient) as { header: import('../src/index.js').PrivateHeader };
    expect(frame.header.writer).toEqual(actor);
    delegated.close();
    if (reason === 'removal') await artifactAppend(f.f.f, f.f.author, 'member.remove', { member: writer.member.id });
    const current = await contextFor(f.f.f, { now: reason === 'expiry' ? Date.parse(writer.member.expiresAt!) + 1 : now });
    const personSession = await privatePersonSession(current, f.f.identity, f.f.author.key, f.f.author.identity);
    const reopened = new PrivateVault({ ...f.options, cache: undefined, contexts: [current], sessions: [personSession] });
    try {
      await expect(reopened.open()).resolves.toBeUndefined();
      expect(reopened.branches[0]!.bundle).toEqual(f.bundle);
      // Removal leaves rotation pending for both person and agents. Reads remain
      // possible, but neither may issue the scheduled dummy write until rotation.
      expect(reopened.retainedCheckpoint!.version).toBe(reason === 'removal' ? agentHead.version : agentHead.version + 1);
      const next = await openPrivateFrame(f.head()!, f.f.author.identity, f.f.identity.recipient) as { header: import('../src/index.js').PrivateHeader };
      expect(next.header.writer).toEqual(reason === 'removal' ? actor : undefined);
      expect(reason === 'removal' ? reopened.retainedCheckpoint!.head : next.header.prev).toBe(agentHead.head);
    } finally { reopened.close(); }
  }, 60000);
  it('uses Bend dirty-first unique in-range two-slot selection', () => {
    expect(selectPrivateSlots([70, 4, 4, 7, 8], [2, 2, 63, 64])).toEqual([4, 7]);
    expect(selectPrivateSlots([], [63, 63, 64, 2])).toEqual([63, 2]);
    expect(() => selectPrivateSlots([1.5], [1, 2])).toThrow();
  });
  it('matches empty/populated traffic including delayed save, dummy commits, fixed retries and cache-only reopen', async () => {
    const empty = await fixture(), populated = await fixture();
    for (const f of [empty, populated]) await f.controller.open();
    const writes = populated.trace.length;
    populated.time(1000); await populated.controller.stage(populated.bundle);
    expect(populated.trace).toHaveLength(writes); expect(await populated.controller.tick()).toBe(false);
    for (const f of [empty, populated]) { f.time(300000); expect(await f.controller.tick()).toBe(true); }
    expect(populated.controller.branches[0]!.bundle).toEqual(populated.bundle); expect(empty.controller.branches).toEqual([]);
    expect(empty.trace).toEqual(populated.trace);
    const snapshot = populated.snapshot(); expect(snapshot.frame).not.toContain('Private title'); expect(snapshot).not.toHaveProperty('directory'); expect(snapshot).not.toHaveProperty('copyKeys');
    for (const f of [empty, populated]) {
      f.fail(true); f.time(600000); await expect(f.controller.tick()).rejects.toThrow('conflict'); const n = f.trace.length; expect(await f.controller.tick()).toBe(false); expect(f.trace).toHaveLength(n);
      f.fail(false); f.time(900000); await f.controller.tick();
    }
    expect(empty.trace).toEqual(populated.trace);
    populated.controller.close(); const resumed = new PrivateVault(populated.options); const n = populated.trace.length; await resumed.open();
    expect(populated.trace.slice(n).map(t => t.method)).toEqual(['GET', 'PUT']); expect(populated.trace[n]!.size).toBe(65 + PRIVATE_HEADER_BYTES + 2 * (1 + PRIVATE_SLOT_BYTES)); expect(resumed.branches[0]!.bundle).toEqual(populated.bundle);
    resumed.close(); empty.controller.close(); expect(() => resumed.branches).toThrow('locked'); await expect(resumed.tick()).rejects.toThrow('locked');
  }, 60000);
  it('publishes multi-slot copy-on-write history only after all dirty chunks arrive, and refuses over-capacity without mutation', async () => {
    const f = await fixture(); await f.controller.open();
    const records: PrivateRecord[] = [], payloads: PrivatePayload[] = [];
    for (let i = 0; i < 3; i++) {
      const payload = content(); (payload.body.content as { markdown: string }).markdown = 'x'.repeat(800000);
      const next = await record(f.f.context, f.f.author, f.f.vault, f.f.copy, f.f.artifact, f.f.identity, i ? 'private.version' : 'private.create', records, payload);
      records.push(next.record); payloads.push(next.payload);
    }
    const bundle = { ...f.bundle, records, payloads }; await f.controller.stage(bundle);
    f.time(300000); await f.controller.tick(); expect(f.controller.branches).toEqual([]);
    f.time(600000); await f.controller.tick(); expect(f.controller.branches[0]!.bundle.records).toHaveLength(3);
    const before = f.controller.retainedCheckpoint!.head, trace = f.trace.length;
    // Signed valid content exceeds the fixed container; no staged state or
    // server/cache bytes may change on refusal.
    for (let i = 3; i < 85; i++) {
      const payload = content(); (payload.body.content as { markdown: string }).markdown = 'x'.repeat(800000);
      const next = await record(f.f.context, f.f.author, f.f.vault, f.f.copy, f.f.artifact, f.f.identity, 'private.version', records, payload);
      records.push(next.record); payloads.push(next.payload);
    }
    await expect(f.controller.stage({ ...bundle, records, payloads })).rejects.toThrow('full');
    expect(f.controller.retainedCheckpoint!.head).toBe(before); expect(f.trace).toHaveLength(trace); expect(f.controller.branches[0]!.bundle.records).toHaveLength(3); f.controller.close();
  }, 120000);
  it('retains rollback checkpoint on failed commits and verifies signed skipped heads without ancestry chains', async () => {
    const f = await fixture(); await f.controller.open(); const old = f.head()!, oldSlots = f.slots.slice();
    f.time(300000); await f.controller.tick(); const current = f.snapshot();
    f.replace(old); f.slots.splice(0, 64, ...oldSlots); f.time(600000); await expect(f.controller.tick()).rejects.toThrow('rollback'); expect(f.controller.retainedCheckpoint!.head).toBe(current.checkpoint.head);
    const unpaired = new PrivateVault({ ...f.options, cache: undefined }); await unpaired.open(); expect(unpaired.freshness).toBe('unverified'); unpaired.close(); f.replace(old); f.slots.splice(0, 64, ...oldSlots);
    const trusted = { ...current.checkpoint, freshness: 'paired' as const };
    const paired = new PrivateVault({ ...f.options, cache: undefined, paired: trusted }); await expect(paired.open()).rejects.toThrow('rollback'); paired.close();
    f.controller.close();
  }, 60000);
  it('refuses unsigned/corrupt cache, foreign key, smuggled fields and stale backup before any persistence', async () => {
    const f = await fixture(); await f.controller.open(); await f.controller.stage(f.bundle); f.time(300000); await f.controller.tick(); const snapshot = f.snapshot();
    await expect(validateVaultCache({ ...snapshot, plaintext: 'CANARY' } as VaultCacheRecord, f.options)).rejects.toThrow();
    const raw = await openPrivateFrame(snapshot.frame, f.f.author.identity, f.f.identity.recipient) as { header: Parameters<typeof signPrivateHeader>[0] & { sig: string }; root: string; directory: unknown };
    raw.header.sig = encode(new Uint8Array(64)); const corrupt = await sealPrivateFrame(raw, f.f.identity.recipient);
    await expect(validateVaultCache({ ...snapshot, frame: corrupt }, f.options)).rejects.toThrow('signature');
    await expect(validateVaultCache(snapshot, { ...f.options, identity: f.f.foreign.identity })).rejects.toThrow();
    const edit = await record(f.f.context, f.f.author, f.f.vault, f.f.copy, f.f.artifact, f.f.identity, 'private.version', f.bundle.records, content('new'));
    await f.controller.stage({ ...f.bundle, records: [...f.bundle.records, edit.record], payloads: [...f.bundle.payloads, edit.payload] }); f.time(600000); await f.controller.tick();
    await expect(f.controller.stage(f.bundle)).rejects.toThrow('Stale'); expect(f.controller.retainedCheckpoint!.version).toBe(3);
    f.controller.close();
  }, 60000);
  it('replays a complete copied snapshot after its source was independently deleted', async () => {
    const f = await fixture(), destination = await artifactFixture('0.1.7'), principal = newId();
    await artifactAppend(destination, destination.guide, 'member.add', { member: { id: principal, kind: 'person', signingKey: f.f.identity.signingKey, recipient: f.f.identity.recipient }, kind: 'person', grants: [] });
    await artifactAppend(destination, destination.guide, 'member.role', { member: principal, role: 'read-write' });
    const context = await contextFor(destination), session = await privatePersonSession(context, f.f.identity, f.f.author.key, f.f.author.identity), copy = newPrivateId();
    const vault = await memberVaultId(context.journey, principal, f.f.identity.signingKey, f.f.identity.recipient);
    expect(vault).not.toBe(f.f.vault);
    const original = f.bundle.records[0]!, payload = f.bundle.payloads[0]!.payload;
    const copied = await record(context, f.f.author, vault, copy, f.f.artifact, f.f.identity, 'private.copy', [], content(), { origin: { journey: f.f.context.journey, copy: f.f.copy, artifact: f.f.artifact, version: original.body.version, recordHash: await privateHash(original) }, destination: { journey: context.journey, copy }, snapshotHash: await privateSnapshotHash(payload) });
    const deletion = await record(f.f.context, f.f.author, f.f.vault, f.f.copy, f.f.artifact, f.f.identity, 'private.delete', f.bundle.records, marker());
    f.options.contexts = [f.f.context, context]; f.options.sessions = [f.f.session, session];
    f.options.trust = { vault, author: f.f.identity };
    const bundle: PrivateBundle = { ...f.bundle, vault, authorityHistories: [...f.bundle.authorityHistories, privateAuthorityHistory(context)], records: [copied.record], payloads: [copied.payload], copyKeys: [{ copy, key: encode(privateRandomBytes(32)) }], sourceHistories: [{ vault: f.f.vault, records: [...f.bundle.records, deletion.record], payloads: [...f.bundle.payloads, deletion.payload] }] };
    await f.controller.open();
    await f.controller.stage(bundle);
    expect(f.controller.branches).toEqual([]);
    f.time(300000); expect(await f.controller.tick()).toBe(true);
    expect(f.controller.branches[0]!.bundle.records).toEqual([copied.record]);
    f.controller.close();
    const reopened = new PrivateVault({ ...f.options, cache: undefined, source: undefined, sessions: [session] }); await reopened.open();
    expect(reopened.branches[0]!.bundle.records).toEqual([copied.record]);
    expect(reopened.branches[0]!.bundle.sourceHistories![0]!.records).toEqual([...f.bundle.records, deletion.record]);
    expect(privateCopies(reopened.branches[0]!.view)).toHaveLength(1);
    reopened.close();
  }, 60000);
  it('reopens historical signed records without live sessions but refuses offline writes and wrong signing keys before upload', async () => {
    const f = await fixture(); await f.controller.open(); await f.controller.stage(f.bundle); f.time(300000); await f.controller.tick();
    f.controller.close();
    const offline = new PrivateVault({ ...f.options, sessions: [], historical: true }); await offline.open();
    expect(offline.branches[0]!.bundle).toEqual(f.bundle);
    await expect(offline.stage(f.bundle)).rejects.toThrow('read-only'); offline.close();
    const bad = new PrivateVault({ ...f.options, cache: undefined, signingKey: f.f.foreign.key }); const n = f.trace.length;
    await expect(bad.open()).rejects.toThrow('signature');
    expect(f.trace.slice(n).map(t => t.method)).toEqual(['GET', 'GET']); bad.close();
  }, 60000);
  it('retains a newer signed checkpoint and hides stale views after failed sync; concurrent saves keep the same scheduled dummy traffic', async () => {
    const f = await fixture(); await f.controller.open(); await f.controller.stage(f.bundle); f.time(300000); await f.controller.tick(); const base = f.snapshot();
    const follower = new PrivateVault({ ...f.options, cache: { read: async () => base, commit: async () => {} } });
    await follower.open();
    // Adopt follower's higher scheduled head on the original device while its
    // new save is still pending. It must report conflict, not overwrite it.
    await f.controller.stage(f.bundle); f.time(600000); const n = f.trace.length;
    await expect(f.controller.tick()).rejects.toThrow('concurrent staging conflict');
    expect(f.trace.slice(n).map(t => t.method)).toEqual(['GET', 'PUT']);
    const newer = f.controller.retainedCheckpoint!.version;
    f.time(900000); await follower.tick(); f.fail(true); f.time(1200000);
    await expect(f.controller.tick()).rejects.toThrow('conflict');
    expect(f.controller.retainedCheckpoint!.version).toBeGreaterThan(newer);
    expect(() => f.controller.branches).toThrow('synchronizing');
    f.fail(false); f.time(1500000); await f.controller.tick(); expect(f.controller.branches[0]!.bundle).toEqual(f.bundle);
    f.controller.close(); follower.close();
  }, 60000);
  it('cancels an in-flight open on lock without restoring plaintext or uploading', async () => {
    const f = await fixture(); let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const controller = new PrivateVault({ ...f.options, transport: { ...f.options.transport, read: async indices => { const wire = await f.options.transport.read(indices); await barrier; return wire; } } });
    const opening = controller.open(); await new Promise(resolve => setTimeout(resolve, 0)); controller.close(); release();
    await expect(opening).rejects.toThrow('locked'); expect(controller.retainedCheckpoint).toBeUndefined(); expect(() => controller.branches).toThrow('locked'); expect(f.trace.map(t => t.method)).toEqual(['GET']);
  }, 60000);
  it('verifies both complete equal-version fork histories and retains ties under a higher signed vault head', async () => {
    const f = await fixture(); await f.controller.open(); await f.controller.stage(f.bundle); f.time(300000); await f.controller.tick(); const base = f.snapshot();
    const left = await record(f.f.context, f.f.author, f.f.vault, f.f.copy, f.f.artifact, f.f.identity, 'private.version', f.bundle.records, content('left'));
    await f.controller.stage({ ...f.bundle, records: [...f.bundle.records, left.record], payloads: [...f.bundle.payloads, left.payload] }); f.time(600000); await f.controller.tick(); const a = f.snapshot();
    // A second device starts at the identical checkpoint, with isolated storage.
    f.replace(base.frame); f.slots.splice(0, 64, ...base.slots); let other: VaultCacheRecord = base;
    const b = new PrivateVault({ ...f.options, cache: { read: async () => other, commit: async (_expected, value) => { other = value; } } }); await b.open();
    const right = await record(f.f.context, f.f.author, f.f.vault, f.f.copy, f.f.artifact, f.f.identity, 'private.version', f.bundle.records, content('right'));
    await b.stage({ ...f.bundle, records: [...f.bundle.records, right.record], payloads: [...f.bundle.payloads, right.payload] }); f.time(900000); await b.tick();
    // Match version by signing the same complete bytes at a's version; skipped
    // versions are authorized by the pinned member, not fabricated ancestry.
    const frame = await openPrivateFrame(other.frame, f.f.author.identity, f.f.identity.recipient) as { header: import('../src/index.js').PrivateHeader; root: string; directory: unknown };
    const { sig: _sig, ...unsigned } = frame.header; frame.header = await signPrivateHeader({ ...unsigned, version: a.checkpoint.version, prev: a.checkpoint.prev }, f.f.author.key);
    const signedFrame = await sealPrivateFrame(frame, f.f.identity.recipient); other = { ...other, frame: signedFrame, checkpoint: { ...a.checkpoint, head: await privateHash(frame.header) } }; f.replace(signedFrame);
    expect((await f.controller.merge(other))[0]!.branches).toHaveLength(2);
    f.time(1200000); await f.controller.tick(); expect(f.controller.branches).toHaveLength(2); expect(f.controller.retainedCheckpoint!.version).toBe(a.checkpoint.version + 1);
    f.controller.close(); b.close();
  }, 60000);
});
