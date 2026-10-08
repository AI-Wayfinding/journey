import { describe, expect, it } from 'vitest';
import { newPrivateId, newId, privateIdentity, privatePersonSession, privateAgentSession, verifyPrivateRecords, privateCopies, privateHash, privateSnapshotHash, signPrivateRecord, privateAuthority, selectPrivateCopies, memberVaultId, verifyPrivateBundle, exportPrivateBundle, importPrivateBundle, privateAuthorityHistory, privateRandomBytes } from '../src/index.js';
import { artifactFixture, artifactAppend, privateFixture, created, contextFor, record, content, marker, jsonIdentity } from './stage0-fixture.js';
import { encode } from '../src/codec.js';

async function copyFixture(visibility: 'private' | 'public') {
  const source = await privateFixture(), original = await created(source), destination = await artifactFixture('0.1.7');
  await artifactAppend(destination, destination.guide, 'member.add', { member: { id: newId(), kind: 'person', signingKey: source.identity.signingKey, recipient: source.identity.recipient }, kind: 'person', grants: [] });
  const principal = destination.controls.at(-1)!.proof.body.member as { id: string };
  await artifactAppend(destination, destination.guide, 'member.role', { member: principal.id, role: 'read-write' });
  const context = await contextFor(destination, { visibility }), session = await privatePersonSession(context, source.identity, source.author.key, source.author.identity), copy = newPrivateId();
  const vault = await memberVaultId(context.journey, principal.id, source.identity.signingKey, source.identity.recipient);
  const r = await record(context, source.author, vault, copy, source.artifact, source.identity, 'private.copy', [], content(), { origin: { journey: source.context.journey, copy: source.copy, artifact: source.artifact, version: original.record.body.version, recordHash: await privateHash(original.record) }, destination: { journey: context.journey, copy }, snapshotHash: await privateSnapshotHash(original.payload.payload) });
  const trust = { vault, author: source.identity }, options = { sessions: [source.session, session], source: original.view };
  return { source, original, destination, context, session, copy, vault, r, trust, options };
}

async function destinationBundle(f: Awaited<ReturnType<typeof copyFixture>>) {
  return { format: 'private-v1' as const, version: 1 as const, vault: f.vault, author: f.source.identity, scope: 'author-backup' as const,
    authorityHistories: [privateAuthorityHistory(f.source.context), privateAuthorityHistory(f.context)],
    records: [f.r.record], payloads: [f.r.payload], copyKeys: [{ copy: f.copy, key: encode(privateRandomBytes(32)) }], blobs: [], unavailableDeletedBlobs: [],
    sourceHistories: [{ vault: f.source.vault, records: f.original.records, payloads: f.original.payloads }] };
}

// Knowing a private origin, or choosing a public destination, must not create
// access, reveal that origin publicly or change its pinned author.
describe('private copy contracts in private and public destination models', () => {
  it('copies an agent-authored record with a distinct sibling signer between person vaults', async () => {
    const f = await copyFixture('private'), author = privateIdentity(f.source.writer.member), actor = privateIdentity(f.source.reader.member);
    const first = await record(f.source.context, f.source.writer, f.source.vault, f.source.copy, f.source.artifact, author);
    const source = await verifyPrivateRecords([first.record], [first.payload], [f.source.context], { vault: f.source.vault, author: f.source.identity }, { historical: true });
    const principal = f.destination.controls.find(c => c.proof.type === 'member.add')!.proof.body.member as { id: string };
    const destinationPerson = { ...f.source.author, member: { ...f.source.author.member, id: principal.id } };
    for (const bot of [f.source.writer, f.source.reader]) await artifactAppend(f.destination, destinationPerson, 'member.add', { member: { ...bot.member, id: newId(), addedBy: principal.id }, kind: 'agent', grants: [] });
    const context = await contextFor(f.destination), session = await privateAgentSession(context, actor, f.source.reader.key, f.source.reader.identity, 'authenticated');
    const sourceSession = await privateAgentSession(f.source.context, actor, f.source.reader.key, f.source.reader.identity, 'authenticated');
    const copied = await record(context, f.source.reader, f.vault, f.copy, f.source.artifact, author, 'private.copy', [], content(), { origin: { journey: f.source.context.journey, copy: f.source.copy, artifact: f.source.artifact, version: first.record.body.version, recordHash: await privateHash(first.record) }, destination: { journey: context.journey, copy: f.copy }, snapshotHash: await privateSnapshotHash(first.payload.payload) });
    const view = await verifyPrivateRecords([copied.record], [copied.payload], [f.source.context, context], f.trust, { source, sessions: [sourceSession, session] });
    expect(privateCopies(view)[0]!.author).toEqual(author);
    expect(privateCopies(view)[0]!.records[0]!.actor).toEqual(actor);
    expect(privateCopies(view)[0]!.records[0]!.sig).toBe(copied.record.sig);
  });
  it('durably replays independently signed histories with real distinct member vault IDs', async () => {
    const f = await copyFixture('private');
    expect(f.trust.vault).not.toBe(f.source.vault);
    const view = await verifyPrivateRecords([f.r.record], [f.r.payload], [f.source.context, f.context], f.trust, { historical: true, provenance: [f.original.view] });
    expect(privateCopies(view).find(c => c.copy === f.copy)!.head).toBe(f.r.record.body.version);
  });
  it('exports and imports a destination-only bundle with independently verified source provenance', async () => {
    const f = await copyFixture('private'), bundle = await destinationBundle(f), options = { trust: f.trust, contexts: [f.source.context, f.context], sessions: f.options.sessions };
    const checked = await verifyPrivateBundle(bundle, options);
    expect(privateCopies(checked.view).map(c => c.copy)).toEqual([f.copy]);
    expect(checked.bundle.sourceHistories![0]!.records).toEqual(f.original.records);
    const encrypted = await exportPrivateBundle(bundle, { ...options, recipient: f.session });
    const imported = await importPrivateBundle(encrypted, f.source.author.identity, { ...options, recipient: f.source.identity });
    expect(imported.bundle).toEqual(bundle);
    const offline = await importPrivateBundle(encrypted, f.source.author.identity, { trust: f.trust, recipient: f.source.identity, historical: true });
    expect(privateCopies(offline.view).map(c => c.copy)).toEqual([f.copy]);
    expect(offline.bundle.sourceHistories![0]!.records).toEqual(f.original.records);
  });
  it('replays and exports an accepted snapshot without a live source after source edit and deletion, but new proposals still need that session', async () => {
    const f = await copyFixture('private'), bundle = await destinationBundle(f);
    // Explicit source is the new-proposal path. Provenance is signed historical
    // evidence, not a source credential or a replacement for destination access.
    await expect(verifyPrivateRecords([f.r.record], [f.r.payload], [f.source.context, f.context], f.trust, { source: f.original.view, sessions: [f.session] })).rejects.toThrow('conflict');
    const accepted = await verifyPrivateRecords([f.r.record], [f.r.payload], [f.source.context, f.context], f.trust, f.options);
    expect(privateCopies(accepted)[0]!.head).toBe(f.r.record.body.version);
    const edit = await record(f.source.context, f.source.author, f.source.vault, f.source.copy, f.source.artifact, f.source.identity, 'private.version', f.original.records, content('Later source'));
    const deleted = await record(f.source.context, f.source.author, f.source.vault, f.source.copy, f.source.artifact, f.source.identity, 'private.delete', [...f.original.records, edit.record], marker());
    const records = [...f.original.records, edit.record, deleted.record], payloads = [...f.original.payloads, edit.payload, deleted.payload];
    const provenance = await verifyPrivateRecords(records, payloads, [f.source.context], { vault: f.source.vault, author: f.source.identity }, { historical: true });
    const replayed = await verifyPrivateRecords([f.r.record], [f.r.payload], [f.source.context, f.context], f.trust, { provenance: [provenance], sessions: [f.session] });
    expect(privateCopies(replayed)[0]!.deleted).toBe(false);
    expect(privateCopies(replayed)[0]!.payloads[0]!.payload.body.title).toBe('Private title 🌱');
    bundle.sourceHistories = [{ vault: f.source.vault, records, payloads }];
    const options = { trust: f.trust, contexts: [f.context], sessions: [f.session] };
    const encrypted = await exportPrivateBundle(bundle, { ...options, recipient: f.session });
    const imported = await importPrivateBundle(encrypted, f.source.author.identity, { ...options, recipient: f.source.identity });
    expect(privateCopies(imported.view)[0]!.records).toEqual([f.r.record]);
    expect(privateCopies(imported.view)[0]!.deleted).toBe(false);
    await expect(verifyPrivateRecords([f.r.record], [f.r.payload], [f.source.context, f.context], f.trust, { provenance: [provenance] })).rejects.toThrow('conflict');
    const forged = structuredClone(f.r.record); forged.sig = encode(new Uint8Array(64));
    await expect(verifyPrivateRecords([forged], [f.r.payload], [f.source.context, f.context], f.trust, { provenance: [provenance], sessions: [f.session] })).rejects.toThrow('signature');
  });
  it('does not use an older permissive source snapshot when supplied history denies the copy signer at copy time', async () => {
    const f = await copyFixture('private');
    await artifactAppend(f.source.f, f.source.f.guide, 'member.role', { member: f.source.author.member.id, role: 'read-only' });
    const denied = await contextFor(f.source.f);
    await expect(verifyPrivateRecords([f.r.record], [f.r.payload], [f.source.context, denied, f.context], f.trust, { provenance: [f.original.view], sessions: [f.session] })).rejects.toThrow('conflict');
    await expect(verifyPrivateRecords([f.r.record], [f.r.payload], [f.source.context, denied, f.context], f.trust, { provenance: [f.original.view], historical: true })).rejects.toThrow('conflict');
  });
  it('refuses an independently verified origin owned by another author', async () => {
    const f = await copyFixture('private');
    const foreign = privateIdentity(f.source.f.guide.member);
    const vault = await memberVaultId(f.source.context.journey, f.source.f.guide.member.id, foreign.signingKey, foreign.recipient);
    const origin = await record(f.source.context, f.source.f.guide, vault, f.source.copy, f.source.artifact, foreign);
    const source = await verifyPrivateRecords([origin.record], [origin.payload], [f.source.context], { vault, author: foreign }, { historical: true });
    const { sig, ...unsigned } = f.r.record;
    const copied = await signPrivateRecord({ ...unsigned, body: { ...unsigned.body, origin: { journey: f.source.context.journey, copy: f.source.copy, artifact: f.source.artifact, version: origin.record.body.version, recordHash: await privateHash(origin.record) } } }, f.source.author.key);
    await expect(verifyPrivateRecords([copied], [f.r.payload], [f.source.context, f.context], f.trust, { ...f.options, source })).rejects.toThrow('Private copy origin mismatch');
  });
  it('refuses a source author with a substituted signing key', async () => {
    const f = await copyFixture('private'), bundle = await destinationBundle(f);
    const foreign = { ...f.source.identity, signingKey: f.source.f.guide.member.signingKey };
    const r = await record(f.source.context, f.source.f.guide, f.source.vault, f.source.copy, f.source.artifact, foreign);
    bundle.sourceHistories = [{ vault: f.source.vault, records: [r.record], payloads: [r.payload] }];
    await expect(verifyPrivateBundle(bundle, { trust: f.trust, historical: true })).rejects.toThrow('Private author/vault mismatch');
  });
  it('refuses a source author with a substituted recipient', async () => {
    const f = await copyFixture('private'), bundle = await destinationBundle(f);
    const foreign = { ...f.source.identity, recipient: f.source.f.guide.member.recipient };
    const r = await record(f.source.context, f.source.author, f.source.vault, f.source.copy, f.source.artifact, foreign);
    bundle.sourceHistories = [{ vault: f.source.vault, records: [r.record], payloads: [r.payload] }];
    await expect(verifyPrivateBundle(bundle, { trust: f.trust, historical: true })).rejects.toThrow('Private author/vault mismatch');
  });
  it('refuses forged signed source history', async () => {
    const f = await copyFixture('private'), bundle = await destinationBundle(f);
    bundle.sourceHistories[0]!.records[0]!.sig = f.r.record.sig;
    // Bind the destination to the forged bytes, so signature verification is the
    // only refusal: a hash mismatch must not accidentally protect this test.
    const { sig, ...unsigned } = f.r.record;
    bundle.records = [await signPrivateRecord({ ...unsigned, body: { ...unsigned.body, origin: { ...(f.r.record.body.origin as Record<string, string>), recordHash: await privateHash(bundle.sourceHistories[0]!.records[0]!) } } }, f.source.author.key)];
    await expect(verifyPrivateBundle(bundle, { trust: f.trust, historical: true })).rejects.toThrow('signature');
  });
  it('refuses truncated source history', async () => {
    const f = await copyFixture('private'), bundle = await destinationBundle(f);
    const version = await record(f.source.context, f.source.author, f.source.vault, f.source.copy, f.source.artifact, f.source.identity, 'private.version', f.original.records);
    bundle.sourceHistories = [{ vault: f.source.vault, records: [version.record], payloads: [version.payload] }];
    await expect(verifyPrivateBundle(bundle, { trust: f.trust, historical: true })).rejects.toThrow('predecessor hash mismatch');
  });
  it('refuses forged source journey authority', async () => {
    const f = await copyFixture('private'), bundle = await destinationBundle(f);
    bundle.authorityHistories[0]!.controls.at(-1)!.proof.sig = f.r.record.sig;
    await expect(verifyPrivateBundle(bundle, { trust: f.trust, historical: true })).rejects.toThrow();
  });
  it('refuses mismatched origin recordHash even on an author-signed destination', async () => {
    const f = await copyFixture('private'), bundle = await destinationBundle(f);
    const { sig, ...unsigned } = f.r.record;
    bundle.records = [await signPrivateRecord({ ...unsigned, body: { ...unsigned.body, origin: { ...(f.r.record.body.origin as Record<string, string>), recordHash: f.r.record.payloadHash } } }, f.source.author.key)];
    await expect(verifyPrivateBundle(bundle, { trust: f.trust, historical: true })).rejects.toThrow('Private copy snapshot mismatch');
  });
  it('refuses mismatched origin version even on an author-signed destination', async () => {
    const f = await copyFixture('private'), bundle = await destinationBundle(f);
    const { sig, ...unsigned } = f.r.record;
    bundle.records = [await signPrivateRecord({ ...unsigned, body: { ...unsigned.body, origin: { ...(f.r.record.body.origin as Record<string, string>), version: newId() } } }, f.source.author.key)];
    await expect(verifyPrivateBundle(bundle, { trust: f.trust, historical: true })).rejects.toThrow('Private copy origin mismatch');
  });
  it('refuses a signed source history under a non-derived vault ID', async () => {
    const f = await copyFixture('private'), bundle = await destinationBundle(f), vault = newPrivateId();
    const { sig, ...unsigned } = f.original.record;
    const sourceRecord = await signPrivateRecord({ ...unsigned, vault }, f.source.author.key);
    bundle.sourceHistories = [{ vault, records: [sourceRecord], payloads: f.original.payloads }];
    const { sig: copySig, ...copyUnsigned } = f.r.record;
    bundle.records = [await signPrivateRecord({ ...copyUnsigned, body: { ...copyUnsigned.body, origin: { ...(f.r.record.body.origin as Record<string, string>), recordHash: await privateHash(sourceRecord) } } }, f.source.author.key)];
    await expect(verifyPrivateBundle(bundle, { trust: f.trust, historical: true })).rejects.toThrow('Private source vault mismatch');
  });
  it('refuses source records claiming the destination vault', async () => {
    const f = await copyFixture('private'), bundle = await destinationBundle(f);
    const { sig, ...unsigned } = f.original.record;
    bundle.sourceHistories[0]!.records = [await signPrivateRecord({ ...unsigned, vault: f.vault }, f.source.author.key)];
    await expect(verifyPrivateBundle(bundle, { trust: f.trust, historical: true })).rejects.toThrow('Private author/vault mismatch');
  });
  it('refuses a source history relabelled and re-signed into the destination vault', async () => {
    const f = await copyFixture('private'), bundle = await destinationBundle(f);
    bundle.sourceHistories[0]!.vault = f.vault;
    const { sig, ...unsigned } = f.original.record;
    bundle.sourceHistories[0]!.records = [await signPrivateRecord({ ...unsigned, vault: f.vault }, f.source.author.key)];
    await expect(verifyPrivateBundle(bundle, { trust: f.trust, historical: true })).rejects.toThrow('Invalid private source history');
  });
  it('keeps destination own records strictly bound to its trust vault', async () => {
    const f = await copyFixture('private'), bundle = await destinationBundle(f);
    const { sig, ...unsigned } = f.r.record;
    bundle.records = [await signPrivateRecord({ ...unsigned, vault: f.source.vault }, f.source.author.key)];
    await expect(verifyPrivateBundle(bundle, { trust: f.trust, historical: true })).rejects.toThrow('Private author/vault mismatch');
  });
  for (const visibility of ['private', 'public'] as const) {
    it(`preserves authorship and snapshot with independent lifecycle in ${visibility}`, async () => {
      const f = await copyFixture(visibility);
      const view = await verifyPrivateRecords([f.r.record], [f.r.payload], [f.source.context, f.context], f.trust, f.options);
      const copy = privateCopies(view)[0]!;
      expect(copy.author).toEqual(f.source.identity); expect(copy.artifact).toBe(f.source.artifact); expect(copy.copy).not.toBe(f.source.copy); expect(copy.project).toBeNull(); expect(copy.records).toHaveLength(1);
      expect(f.r.record.authority.principal).not.toBe(f.source.author.member.id);
      expect(f.r.record.body.origin).toMatchObject({ journey: f.source.context.journey, copy: f.source.copy, version: f.original.record.body.version });
      expect(selectPrivateCopies(view, f.context, f.session)).toHaveLength(1);
      const deleted = await record(f.source.context, f.source.author, f.source.vault, f.source.copy, f.source.artifact, f.source.identity, 'private.delete', f.original.records, marker());
      const tombstone = await verifyPrivateRecords([...f.original.records, deleted.record], [...f.original.payloads, deleted.payload], [f.source.context], { vault: f.source.vault, author: f.source.identity }, { sessions: [f.source.session] });
      expect(privateCopies(tombstone)[0]!.deleted).toBe(true); expect(privateCopies(view)[0]!.deleted).toBe(false);
      const edit = await record(f.context, f.source.author, f.vault, f.copy, f.source.artifact, f.source.identity, 'private.version', [f.r.record], content('Destination edit'));
      const edited = await verifyPrivateRecords([f.r.record, edit.record], [f.r.payload, edit.payload], [f.source.context, f.context], f.trust, f.options);
      expect(privateCopies(edited)[0]!.head).toBe(edit.record.body.version); expect(privateCopies(f.original.view)[0]!.head).toBe(f.original.record.body.version);
      expect(JSON.stringify(f.destination.controls)).not.toContain(f.source.artifact); expect(JSON.stringify(f.destination.controls)).not.toContain(f.source.copy);
      // Public genesis remains forbidden; visibility is only the verified model descriptor.
      expect(f.destination.controls[0]!.proof.body.visibility).toBe('private');
    });
    it(`rejects forged source, stale snapshot, deleted copy, destination denial and extra grants in ${visibility}`, async () => {
      const f = await copyFixture(visibility), check = (r = f.r.record, source = f.original.view, sessions = f.options.sessions) => verifyPrivateRecords([r], [{ record: r.id, payload: f.r.payload.payload }], [f.source.context, f.context], f.trust, { source, sessions });
      for (const mutate of [
        (r: typeof f.r.record) => { (r.body.origin as { recordHash: string }).recordHash = r.payloadHash; },
        (r: typeof f.r.record) => { (r.body.origin as { version: string }).version = newId(); },
        (r: typeof f.r.record) => { r.body.snapshotHash = r.payloadHash; },
        (r: typeof f.r.record) => { r.copy = f.source.copy; (r.body.destination as { copy: string }).copy = f.source.copy; },
      ]) {
        const bad = structuredClone(f.r.record); mutate(bad); const { sig, ...unsigned } = bad;
        await expect(check(await signPrivateRecord(unsigned, f.source.author.key))).rejects.toThrow();
      }
      await expect(check(f.r.record, { vault: f.source.vault })).rejects.toThrow('Unverified');
      await expect(check(f.r.record, f.original.view, [f.source.session])).rejects.toThrow('conflict');
      const deleted = await record(f.source.context, f.source.author, f.source.vault, f.source.copy, f.source.artifact, f.source.identity, 'private.delete', f.original.records, marker());
      const tombstone = await verifyPrivateRecords([...f.original.records, deleted.record], [...f.original.payloads, deleted.payload], [f.source.context], { vault: f.source.vault, author: f.source.identity }, { sessions: [f.source.session] });
      await expect(check(f.r.record, tombstone)).rejects.toThrow('conflict');
      const { sig, ...unsigned } = f.r.record;
      await expect(signPrivateRecord({ ...unsigned, body: { ...unsigned.body, recipients: [f.source.foreign.member.recipient] } }, f.source.author.key)).rejects.toThrow();
      const foreignIdentity = privateIdentity(f.source.foreign.member);
      const foreign = await privateAgentSession(f.source.context, foreignIdentity, f.source.foreign.key, f.source.foreign.identity, 'authenticated');
      expect(foreign.identity).not.toEqual(f.source.identity);
    });
  }
});
