import { describe, expect, it } from 'vitest';
import { newPrivateId, newId, privateIdentity, privatePersonSession, privateAgentSession, verifyPrivateRecords, privateCopies, privateHash, privateSnapshotHash, signPrivateRecord, privateAuthority, selectPrivateCopies } from '../src/index.js';
import { artifactFixture, artifactAppend, privateFixture, created, contextFor, record, content, marker, jsonIdentity } from './stage0-fixture.js';

async function copyFixture(visibility: 'private' | 'public') {
  const source = await privateFixture(), original = await created(source), destination = await artifactFixture('0.1.7');
  await artifactAppend(destination, destination.guide, 'member.add', { member: { id: newId(), kind: 'person', signingKey: source.identity.signingKey, recipient: source.identity.recipient }, kind: 'person', grants: [] });
  const principal = destination.controls.at(-1)!.proof.body.member as { id: string };
  await artifactAppend(destination, destination.guide, 'member.role', { member: principal.id, role: 'read-write' });
  const context = await contextFor(destination, { visibility }), session = await privatePersonSession(context, source.identity, source.author.key, source.author.identity), copy = newPrivateId();
  const r = await record(context, source.author, source.vault, copy, source.artifact, source.identity, 'private.copy', [], content(), { origin: { journey: source.context.journey, copy: source.copy, artifact: source.artifact, version: original.record.body.version, recordHash: await privateHash(original.record) }, destination: { journey: context.journey, copy }, snapshotHash: await privateSnapshotHash(original.payload.payload) });
  const trust = { vault: source.vault, author: source.identity }, options = { sessions: [source.session, session], source: original.view };
  return { source, original, destination, context, session, copy, r, trust, options };
}

// Knowing a private origin, or choosing a public destination, must not create
// access, reveal that origin publicly or change its pinned author.
describe('private copy contracts in private and public destination models', () => {
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
      const tombstone = await verifyPrivateRecords([...f.original.records, deleted.record], [...f.original.payloads, deleted.payload], [f.source.context], f.trust, { sessions: [f.source.session] });
      expect(privateCopies(tombstone)[0]!.deleted).toBe(true); expect(privateCopies(view)[0]!.deleted).toBe(false);
      const edit = await record(f.context, f.source.author, f.source.vault, f.copy, f.source.artifact, f.source.identity, 'private.version', [f.r.record], content('Destination edit'));
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
      const tombstone = await verifyPrivateRecords([...f.original.records, deleted.record], [...f.original.payloads, deleted.payload], [f.source.context], f.trust, { sessions: [f.source.session] });
      await expect(check(f.r.record, tombstone)).rejects.toThrow('conflict');
      const { sig, ...unsigned } = f.r.record;
      await expect(signPrivateRecord({ ...unsigned, body: { ...unsigned.body, recipients: [f.source.foreign.member.recipient] } }, f.source.author.key)).rejects.toThrow();
      const foreignIdentity = privateIdentity(f.source.foreign.member);
      const foreign = await privateAgentSession(f.source.context, foreignIdentity, f.source.foreign.key, f.source.foreign.identity, 'authenticated');
      expect(foreign.identity).not.toEqual(f.source.identity);
    });
  }
});
