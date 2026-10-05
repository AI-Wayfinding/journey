import { describe, expect, it } from 'vitest';
import rules from '@ai-wayfinding/rules';
import {
  PRIVATE_FORMAT, PRIVATE_SLOT_COUNT, PRIVATE_SLOT_BYTES, PRIVATE_PATCH_SLOTS, PRIVATE_SYNC_MS,
  CLIENT_VERSION, CLIENT_CAPABILITIES, supportsPrivate, newId, newPrivateId, privateIdentity,
  privateAuthority, privatePersonSession, privateAgentSession, verifyPrivateContext, privateAccess,
  createPrivateChallenge, answerPrivateChallenge, authenticatePrivateAgent, privateHash,
  signPrivateRecord, verifyPrivateRecords, privateCopies, selectPrivateCopies, privateCapacity,
  privateSyncDue, signPrivateHeader, verifyPrivateHeader, copyPrivatePatch, privateBytesHash,
  mergePrivateViews, validatePrivateRecord, canonical, seal, signControlProof, verifyControlProofs,
  artifactTypeHash,
} from '../src/index.js';
import type { PrivateRecord, PrivatePayload, PrivateIdentity, PrivateContext, PrivateHeader, JsonObject, ProtocolRecord } from '../src/index.js';
import { artifactFixture, artifactAppend, agent, person } from './stage0-fixture.js';
import { encode } from '../src/codec.js';

import { now, privateFixture, record, created, header, content, marker, contextFor, jsonIdentity } from './stage0-fixture.js';

// A caller must not mint authority from an index, credential hint, guide status or
// project participation. Every positive fixture uses real pinned signing/age keys.
describe('private-v1 verified audience and records', () => {
  it('uses 0.1.7 and all four capabilities without changing earlier minimums', async () => {
    expect(CLIENT_VERSION).toBe('0.1.7'); expect(CLIENT_CAPABILITIES).toEqual(['control-proof-v1', 'artifact-v1', 'project-v1', 'private-v1']);
    expect(supportsPrivate('0.1.7', '0.1.7', CLIENT_CAPABILITIES)).toBe(true);
    for (const cap of CLIENT_CAPABILITIES) expect(supportsPrivate('0.1.7', '0.1.7', CLIENT_CAPABILITIES.filter(c => c !== cap))).toBe(false);
    for (const version of ['0.1.6', '0.1.3', 'bad', '0.1.8']) expect(supportsPrivate('0.1.7', version === '0.1.8' ? version : '0.1.7', version === '0.1.8' ? CLIENT_CAPABILITIES : ['control-proof-v1', 'artifact-v1', 'project-v1'])).toBe(false);
    for (const minimum of ['0.1.4', '0.1.5', '0.1.6']) {
      const f = await artifactFixture(minimum), ctx = await contextFor(f), identity = privateIdentity(f.guide.member), session = await privatePersonSession(ctx, identity, f.guide.key, f.guide.identity);
      expect(privateAccess(ctx, identity, session, true)).toBe(false); expect(privateAccess(ctx, identity, session)).toBe(true);
    }
  });
  it('derives person and authenticated-agent audience; links, missing class, foreign agents and guides gain nothing', async () => {
    const f = await privateFixture();
    expect(privateAccess(f.context, f.identity, f.session, true)).toBe(true);
    const guide = await privatePersonSession(f.context, privateIdentity(f.f.guide.member), f.f.guide.key, f.f.guide.identity);
    expect(privateAccess(f.context, f.identity, guide)).toBe(false);
    for (const [actor, write] of [[f.reader, false], [f.writer, true]] as const) {
      const challenge = await createPrivateChallenge(f.context, f.session, privateIdentity(actor.member));
      const answer = await answerPrivateChallenge(challenge, actor.key, actor.identity);
      const session = await authenticatePrivateAgent(challenge, answer, 'authenticated');
      expect(privateAccess(f.context, f.identity, session)).toBe(true); expect(privateAccess(f.context, f.identity, session, true)).toBe(write);
      await expect(authenticatePrivateAgent(challenge, answer, 'authenticated')).rejects.toThrow('consumed');
    }
    for (const cls of ['link', 'unknown'] as const) {
      const challenge = await createPrivateChallenge(f.context, f.session, privateIdentity(f.writer.member));
      await expect(authenticatePrivateAgent(challenge, await answerPrivateChallenge(challenge, f.writer.key, f.writer.identity), cls)).rejects.toThrow();
      await expect(privateAgentSession(f.context, privateIdentity(f.writer.member), f.writer.key, f.writer.identity, cls)).rejects.toThrow();
    }
    const foreign = await createPrivateChallenge(f.context, f.session, privateIdentity(f.foreign.member));
    await expect(authenticatePrivateAgent(foreign, await answerPrivateChallenge(foreign, f.foreign.key, f.foreign.identity), 'authenticated')).rejects.toThrow('audience');
    const bad = await createPrivateChallenge(f.context, f.session, privateIdentity(f.writer.member));
    await expect(authenticatePrivateAgent(bad, await answerPrivateChallenge(bad, f.foreign.key, f.writer.identity), 'authenticated')).rejects.toThrow('signature');
    const wrongAge = await createPrivateChallenge(f.context, f.session, privateIdentity(f.writer.member));
    await expect(answerPrivateChallenge(wrongAge, f.writer.key, f.foreign.identity)).rejects.toThrow();
    expect(privateAccess(f.context, f.identity, { identity: f.identity, binding: f.session.binding })).toBe(false);
    await expect(privatePersonSession(f.context, { ...f.identity, recipient: f.foreign.member.recipient }, f.author.key, f.foreign.identity)).rejects.toThrow('admission');
  });
  it('keeps an agent as its own author without granting its adding person access', async () => {
    const f = await privateFixture(), identity = privateIdentity(f.writer.member), session = await privateAgentSession(f.context, identity, f.writer.key, f.writer.identity, 'authenticated');
    const r = await record(f.context, f.writer, f.vault, f.copy, f.artifact, identity);
    const view = await verifyPrivateRecords([r.record], [r.payload], [f.context], { vault: f.vault, author: identity }, { sessions: [session] });
    expect(privateCopies(view)[0]!.author).toEqual(identity); expect(privateAccess(f.context, identity, f.session)).toBe(false);
  });
  it('attributes actual writers and refuses stale, immutable-author, type, signature, index and payload attacks atomically', async () => {
    const f = await privateFixture(), c = await created(f), writer = await privateAgentSession(f.context, privateIdentity(f.writer.member), f.writer.key, f.writer.identity, 'authenticated');
    const edited = await record(f.context, f.writer, f.vault, f.copy, f.artifact, f.identity, 'private.version', c.records, content('New version'));
    const view = await verifyPrivateRecords([...c.records, edited.record], [...c.payloads, edited.payload], [f.context], { vault: f.vault, author: f.identity }, { sessions: [f.session, writer] });
    expect(privateCopies(view)[0]!.records[1]!.actor).toEqual(privateIdentity(f.writer.member)); expect(privateCopies(view)[0]!.author).toEqual(f.identity);
    for (const mutate of [(r: PrivateRecord) => { r.sig = c.record.sig; }, (r: PrivateRecord) => { r.authority.admissionHash = r.payloadHash; }, (r: PrivateRecord) => { r.body.grants = []; }, (r: PrivateRecord) => { r.body.author = jsonIdentity(privateIdentity(f.foreign.member)); }, (r: PrivateRecord) => { r.seq++; }, (r: PrivateRecord) => { r.prev = null; }, (r: PrivateRecord) => { r.body.typeHash = r.payloadHash; }]) {
      const bad = structuredClone(edited.record); mutate(bad);
      await expect(verifyPrivateRecords([...c.records, bad], [...c.payloads, edited.payload], [f.context], { vault: f.vault, author: f.identity }, { sessions: [f.session, writer] })).rejects.toThrow();
    }
    const stale = await record(f.context, f.author, f.vault, f.copy, f.artifact, f.identity, 'private.version', c.records, content(), { predecessor: newId() });
    await expect(verifyPrivateRecords([...c.records, stale.record], [...c.payloads, stale.payload], [f.context], { vault: f.vault, author: f.identity }, { sessions: [f.session] })).rejects.toThrow('conflict');
    await expect(verifyPrivateRecords(c.records, [{ record: c.record.id, payload: content('forged') }], [f.context], { vault: f.vault, author: f.identity }, { sessions: [f.session] })).rejects.toThrow('payload');
    await expect(verifyPrivateRecords(c.records, c.payloads, [{ ...f.context }], { vault: f.vault, author: f.identity })).rejects.toThrow('Unverified');
    expect(() => privateCopies({ vault: f.vault })).toThrow('Unverified');
    expect(validatePrivateRecord({ ...c.record, recipients: [] })).toBe(false);
    expect(privateCopies(c.view)[0]!.records).toHaveLength(1);
    expect(privateCopies(await verifyPrivateRecords([c.record, c.record], c.payloads, [f.context], { vault: f.vault, author: f.identity }, { sessions: [f.session] }))[0]!.records).toHaveLength(1);
  });
  it('has read-only offline recovery, pending-rotation denial and live removal/expiry limits', async () => {
    const f = await privateFixture(), c = await created(f), offline = await contextFor(f.f, { current: false }), session = await privatePersonSession(offline, f.identity, f.author.key, f.author.identity);
    expect(privateAccess(offline, f.identity, session)).toBe(true); expect(privateAccess(offline, f.identity, session, true)).toBe(false);
    await expect(verifyPrivateRecords(c.records, c.payloads, [offline], { vault: f.vault, author: f.identity }, { sessions: [session] })).rejects.toThrow('denied');
    expect(privateCopies(await verifyPrivateRecords(c.records, c.payloads, [offline], { vault: f.vault, author: f.identity }, { historical: true }))).toHaveLength(1);
    await artifactAppend(f.f, f.f.guide, 'member.remove', { member: f.foreign.member.id });
    const rotating = await contextFor(f.f), rotated = await privatePersonSession(rotating, f.identity, f.author.key, f.author.identity);
    expect(privateAccess(rotating, f.identity, rotated, true)).toBe(false);
    await artifactAppend(f.f, f.f.guide, 'member.role', { member: f.author.member.id, role: 'read-only' });
    const downgraded = await contextFor(f.f), readonly = await privateAgentSession(downgraded, privateIdentity(f.writer.member), f.writer.key, f.writer.identity, 'authenticated');
    expect(privateAccess(downgraded, f.identity, readonly)).toBe(true); expect(privateAccess(downgraded, f.identity, readonly, true)).toBe(false);
    await artifactAppend(f.f, f.f.guide, 'member.remove', { member: f.author.member.id });
    const removed = await contextFor(f.f);
    await expect(privateAgentSession(removed, privateIdentity(f.writer.member), f.writer.key, f.writer.identity, 'authenticated')).rejects.toThrow('admission');
    expect(privateAccess(removed, f.identity, readonly)).toBe(false);
  });
  it('uses Stage 2 projects without project elevation, and tombstones never resurrect versions or placement', async () => {
    const f = await privateFixture(), project = newId();
    await artifactAppend(f.f, f.f.guide, 'project.create', { format: 'project-v1', project, purposeHash: await (await import('../src/index.js')).projectPurposeHash('Purpose'), state: 'getting-started' }, { purpose: 'Purpose' });
    f.context = await contextFor(f.f); f.session = await privatePersonSession(f.context, f.identity, f.author.key, f.author.identity);
    const c = await created(f), placed = await record(f.context, f.author, f.vault, f.copy, f.artifact, f.identity, 'private.project', c.records, marker(), { project });
    const records = [...c.records, placed.record], payloads = [...c.payloads, placed.payload];
    const options = { sessions: [f.session] }, trust = { vault: f.vault, author: f.identity };
    const view = await verifyPrivateRecords(records, payloads, [f.context], trust, options);
    expect(selectPrivateCopies(view, f.context, f.session, 'main')).toEqual([]); expect(selectPrivateCopies(view, f.context, f.session, project)).toHaveLength(1); expect(selectPrivateCopies(view, f.context, f.session, 'all')).toHaveLength(1);
    for (const body of [{ project: newId() }, { project: [project] }, { project, predecessor: await privateHash(placed.record) }]) {
      const base = Array.isArray(body.project) ? c.records : records;
      if (Array.isArray(body.project)) { await expect(record(f.context, f.author, f.vault, f.copy, f.artifact, f.identity, 'private.project', base, marker(), body)).rejects.toThrow(); continue; }
      const bad = await record(f.context, f.author, f.vault, f.copy, f.artifact, f.identity, 'private.project', base, marker(), body);
      await expect(verifyPrivateRecords([...base, bad.record], [...(base === c.records ? c.payloads : payloads), bad.payload], [f.context], trust, options)).rejects.toThrow('conflict');
    }
    const deleted = await record(f.context, f.author, f.vault, f.copy, f.artifact, f.identity, 'private.delete', records, marker());
    const tombstone = await verifyPrivateRecords([...records, deleted.record], [...payloads, deleted.payload], [f.context], trust, options);
    expect(selectPrivateCopies(tombstone, f.context, f.session, 'all')).toEqual([]);
    for (const type of ['private.version', 'private.project', 'private.comment'] as const) {
      const r = await record(f.context, f.author, f.vault, f.copy, f.artifact, f.identity, type, [...records, deleted.record], type === 'private.version' ? content() : type === 'private.comment' ? { type: 'artifact.comment-content', typeVersion: 1, body: { text: 'revive' } } : marker());
      await expect(verifyPrivateRecords([...records, deleted.record, r.record], [...payloads, deleted.payload, r.payload], [f.context], trust, options)).rejects.toThrow('conflict');
    }
  });
  it('fails closed on public private actions and shared export fields', async () => {
    const f = await privateFixture(), c = await created(f), envelope = await seal({ type: 'artifact.tombstone', typeVersion: 1, body: {} }, { id: newId(), journey: f.f.journey, seq: f.f.controls.length, epoch: 1, createdAt: new Date(now).toISOString() }, f.f.key);
    await expect(signControlProof({ v: 1, seq: f.f.controls.length, prev: await (await import('../src/index.js')).hashControlProof(f.f.controls.at(-1)!.proof), at: new Date(now).toISOString(), actor: f.author.member.id, type: 'private.create', body: c.record.body }, envelope, f.f.journey, f.author.key)).rejects.toThrow();
    const checked = await verifyControlProofs([...f.f.controls.map(c => c.proof), { ...f.f.controls.at(-1)!.proof, type: 'private.future' }], [...f.f.controls.map(c => c.envelope), envelope], f.f.trust, [f.f.key]);
    expect(checked.ok).toBe(false); expect(checked).not.toHaveProperty('state');
    expect(canonical(f.f.controls)).not.toContain(f.vault); expect(canonical(f.f.controls)).not.toContain(f.artifact);
  });
});

describe('fixed private header, schedule and fork contracts', () => {
  it('accepts own write-agent headers under one owner/version chain, never foreign, read-only, removed or expired signers', async () => {
    const f = await privateFixture(), trust = { vault: f.vault, author: f.identity }, first = await header(f);
    const checkpoint = (await verifyPrivateHeader(first, trust, { contentsHash: first.contentsHash })).checkpoint;
    const signed = async (actor: typeof f.writer, context = f.context, version = 2) => signPrivateHeader({ format: first.format, v: 1, vault: f.vault, author: f.identity, version, prev: checkpoint.head, contentsHash: first.contentsHash, slots: first.slots, writer: privateIdentity(actor.member), authority: privateAuthority(context, privateIdentity(actor.member)) }, actor.key);
    const own = await signed(f.writer);
    const checked = await verifyPrivateHeader(own, trust, { checkpoint, contentsHash: own.contentsHash, contexts: [f.context] });
    expect(checked.header.author).toEqual(f.identity); expect(checked.header.writer).toEqual(privateIdentity(f.writer.member)); expect(checked.checkpoint.version).toBe(2);
    const next = await header(f, 3, checked.checkpoint.head);
    expect((await verifyPrivateHeader(next, trust, { checkpoint: checked.checkpoint, contentsHash: next.contentsHash })).checkpoint.version).toBe(3);
    for (const actor of [f.foreign, f.reader]) await expect(verifyPrivateHeader(await signed(actor), trust, { contentsHash: own.contentsHash, contexts: [f.context] })).rejects.toThrow('authority');
    await expect(verifyPrivateHeader(await signed(f.writer, f.context, 1), trust, { contentsHash: own.contentsHash, contexts: [f.context] })).rejects.toThrow('authority');
    await expect(verifyPrivateHeader({ ...own, vault: newPrivateId() }, trust, { contentsHash: own.contentsHash, contexts: [f.context] })).rejects.toThrow('binding');
    await expect(verifyPrivateHeader({ ...own, sig: first.sig }, trust, { contentsHash: own.contentsHash, contexts: [f.context] })).rejects.toThrow('signature');
    await expect(verifyPrivateHeader(own, trust, { contentsHash: own.contentsHash })).rejects.toThrow('authority');
    const expired = await agent(f.author.member.id); expired.member.expiresAt = new Date(now + 1000).toISOString();
    await artifactAppend(f.f, f.author, 'member.add', { member: expired.member, kind: 'agent', grants: [] });
    const live = await contextFor(f.f), expiryHeader = await signed(expired, live);
    await expect(verifyPrivateHeader(expiryHeader, trust, { contentsHash: own.contentsHash, contexts: [await contextFor(f.f, { now: now + 2000 })] })).rejects.toThrow('authority');
    await artifactAppend(f.f, f.author, 'member.remove', { member: f.writer.member.id });
    await expect(verifyPrivateHeader(own, trust, { contentsHash: own.contentsHash, contexts: [await contextFor(f.f)] })).rejects.toThrow();
  });
  it('validates exact fixed-slot atomic patches and capacity without growth', async () => {
    const f = await privateFixture(), h = await header(f), ciphertext = encode(new Uint8Array(PRIVATE_SLOT_BYTES)), digest = await privateBytesHash(new Uint8Array(PRIVATE_SLOT_BYTES));
    h.slots[0] = digest; h.slots[1] = digest;
    const signed = await signPrivateHeader({ format: h.format, v: h.v, vault: h.vault, author: h.author, version: h.version, prev: h.prev, contentsHash: h.contentsHash, slots: h.slots }, f.author.key);
    const patch = { format: PRIVATE_FORMAT, v: 1 as const, vault: f.vault, token: newPrivateId(), header: signed, slots: [{ index: 0, ciphertext }, { index: 1, ciphertext }] };
    expect((await copyPrivatePatch(patch)).slots).toHaveLength(2);
    for (const invalid of [{ ...patch, slots: patch.slots.slice(0, 1) }, { ...patch, slots: [...patch.slots, { index: 2, ciphertext }] }, { ...patch, slots: [patch.slots[0]!, patch.slots[0]!] }, { ...patch, count: 0 }, { ...patch, slots: [{ index: 64, ciphertext }, patch.slots[1]!] }, { ...patch, slots: [{ index: 0, ciphertext: encode(new Uint8Array(16)) }, patch.slots[1]!] }]) await expect(copyPrivatePatch(invalid)).rejects.toThrow();
    expect(PRIVATE_SLOT_COUNT).toBe(64); expect(PRIVATE_SLOT_BYTES).toBe(1_048_576); expect(PRIVATE_PATCH_SLOTS).toBe(2);
    for (const n of [0, PRIVATE_SLOT_COUNT * PRIVATE_SLOT_BYTES]) expect(privateCapacity(n)).toBe(true);
    for (const n of [-1, 1.5, 67_108_865, 2 ** 32, Number.MAX_SAFE_INTEGER]) expect(privateCapacity(n)).toBe(false);
    expect(patch.header).toEqual(signed);
  });
  it('uses content-independent open/five-minute reads and two-slot dummy writes; a save is pending until sync', () => {
    const trace = (saves: number[]) => {
      const operations: { at: number; fetch: number; upload: number; pending: number }[] = []; let last = 0, pending = 0;
      for (let time = 0; time <= 600_000; time += 1000) {
        if (saves.includes(time)) pending++;
        if (privateSyncDue(time === 0, time - last)) { operations.push({ at: time, fetch: PRIVATE_PATCH_SLOTS, upload: PRIVATE_PATCH_SLOTS, pending }); pending = 0; last = time; }
      }
      return operations;
    };
    const empty = trace([]), populated = trace([1000, 90_000, 301_000]);
    expect(PRIVATE_SYNC_MS).toBe(300_000); expect(privateSyncDue(false, 299_999)).toBe(false); expect(privateSyncDue(false, 300_000)).toBe(true); expect(privateSyncDue(false, -1)).toBe(false);
    expect(empty.map(({ pending, ...observable }) => observable)).toEqual(populated.map(({ pending, ...observable }) => observable)); expect(populated.map(p => p.at)).toEqual([0, 300_000, 600_000]); expect(populated[1]!.pending).toBe(2);
  });
  it('never calls a server-only head paired, rejects rollback/corruption/predecessor attacks and preserves checkpoints', async () => {
    const f = await privateFixture(), h = await header(f), first = await verifyPrivateHeader(h, { vault: f.vault, author: f.identity }, { contentsHash: h.contentsHash });
    expect(first.decision).toBe('unverified'); expect(first.checkpoint.freshness).toBe('unverified');
    const repeated = await verifyPrivateHeader(h, { vault: f.vault, author: f.identity }, { contentsHash: h.contentsHash, checkpoint: first.checkpoint }); expect(repeated.decision).toBe('unverified');
    const paired = { ...first.checkpoint, freshness: 'paired' as const }, next = await header(f, 2, first.checkpoint.head);
    const verified = await verifyPrivateHeader(next, { vault: f.vault, author: f.identity }, { contentsHash: next.contentsHash, paired }); expect(verified.decision).toBe('verified');
    await expect(verifyPrivateHeader(h, { vault: f.vault, author: f.identity }, { contentsHash: h.contentsHash, checkpoint: verified.checkpoint })).rejects.toThrow('rollback');
    const wrongPrev = await header(f, 3, await privateHash('not previous'));
    expect((await verifyPrivateHeader(wrongPrev, { vault: f.vault, author: f.identity }, { contentsHash: wrongPrev.contentsHash, checkpoint: verified.checkpoint })).decision).toBe('verified');
    const missingPrev = await header(f, 3, null);
    await expect(verifyPrivateHeader(missingPrev, { vault: f.vault, author: f.identity }, { contentsHash: missingPrev.contentsHash, checkpoint: verified.checkpoint })).rejects.toThrow('predecessor');
    for (const invalid of [{ ...next, sig: h.sig }, { ...next, version: 0 }, { ...next, slots: next.slots.slice(1) }, { ...next, privateCount: 1 }]) await expect(verifyPrivateHeader(invalid, { vault: f.vault, author: f.identity }, { contentsHash: next.contentsHash })).rejects.toThrow();
    await expect(verifyPrivateHeader(next, { vault: f.vault, author: f.identity }, { contentsHash: await privateHash('forged') })).rejects.toThrow('digest');
    await expect(verifyPrivateHeader(h, { vault: f.vault, author: f.identity }, { contentsHash: h.contentsHash, paired: first.checkpoint })).rejects.toThrow('Unverified');
    const fork = await header(f, 2, first.checkpoint.head, await privateHash('fork'));
    expect((await verifyPrivateHeader(fork, { vault: f.vault, author: f.identity }, { contentsHash: fork.contentsHash, checkpoint: verified.checkpoint })).decision).toBe('merge');
    const third = await header(f, 3, verified.checkpoint.head);
    expect((await verifyPrivateHeader(third, { vault: f.vault, author: f.identity }, { contentsHash: third.contentsHash, checkpoint: paired })).decision).toBe('verified');
    const skipped = await header(f, 999, await privateHash('immediate predecessor only'));
    expect((await verifyPrivateHeader(skipped, { vault: f.vault, author: f.identity }, { contentsHash: skipped.contentsHash, checkpoint: paired })).checkpoint.version).toBe(999);
    expect((await verifyPrivateHeader(skipped, { vault: f.vault, author: f.identity }, { contentsHash: skipped.contentsHash, checkpoint: verified.checkpoint, paired })).checkpoint.version).toBe(999);
  });
  it('merges independently verified higher versions and ties, while tombstones beat longer live forks', async () => {
    const f = await privateFixture(), c = await created(f), trust = { vault: f.vault, author: f.identity }, options = { sessions: [f.session] };
    const a = await record(f.context, f.author, f.vault, f.copy, f.artifact, f.identity, 'private.version', c.records, content('A'));
    const b = await record(f.context, f.author, f.vault, f.copy, f.artifact, f.identity, 'private.version', c.records, content('B'));
    const left = await verifyPrivateRecords([...c.records, a.record], [...c.payloads, a.payload], [f.context], trust, options), right = await verifyPrivateRecords([...c.records, b.record], [...c.payloads, b.payload], [f.context], trust, options);
    expect(mergePrivateViews(c.view, left)[0]!.branches).toHaveLength(1); expect(mergePrivateViews(left, right)[0]!.branches).toHaveLength(2);
    const del = await record(f.context, f.author, f.vault, f.copy, f.artifact, f.identity, 'private.delete', c.records, marker());
    const tombstone = await verifyPrivateRecords([...c.records, del.record], [...c.payloads, del.payload], [f.context], trust, options);
    expect(mergePrivateViews(tombstone, left)[0]!.branches[0]!.deleted).toBe(true);
    expect(() => mergePrivateViews({ vault: f.vault }, left)).toThrow('Unverified');
    expect(rules.private_merge(2n, 3n, false, false, false).$).toBe('PrivateRight');
  });
});
