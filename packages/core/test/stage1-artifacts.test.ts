import { describe, expect, it } from 'vitest';
import { encode } from '../src/codec.js';
import { ARTIFACT_TYPES, MAX_BLOB_BYTES, MAX_ARTIFACT_PAYLOAD_BYTES, CLIENT_VERSION, CLIENT_CAPABILITIES, artifactTypeHash, copyArtifactPublic, newId, validateArtifactPayload, validateArtifactPublic, validateBlobDescriptor, suggestedArtifact, validArtifactUrl, validPackagePath, supportsArtifacts, seal, open, readArtifactPayload, signControlProof, hashControlProof, verifyControlProofs, signEntry, liveArtifactBlobIds, canonical } from '../src/index.js';
import type { JsonObject, BlobDescriptor, ArtifactPayload, ControlProof } from '../src/index.js';
import { artifactFixture, artifactAppend, artifactBody, artifactResult, documentPayload, person, agent } from './stage0-fixture.js';

const digest = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const blob = (journey = newId(), size = 0): BlobDescriptor => ({ v: 1, journey, id: newId(), epoch: 1, size, ciphertextSize: size + 16, nonce: 'AAAAAAAAAAAAAAAA', digest });
const attachment = (descriptor = blob(), path?: string) => ({ blob: descriptor, name: 'Private filename', mime: 'application/octet-stream', ...(path === undefined ? {} : { path }) });
async function state(f: Awaited<ReturnType<typeof artifactFixture>>) { const result = await artifactResult(f); expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error.message); return result.state; }

describe('Stage 1 strict contracts', () => {
  it('accepts exactly the active types and packaging, not later-stage types or caller fields', async () => {
    expect(ARTIFACT_TYPES).toEqual(['skill', 'prompt', 'document', 'image', 'file', 'data', 'link']);
    const a = attachment(blob(), 'assets/example.txt');
    const contents = [
      { kind: 'skill', skill: '# SKILL.md' }, { kind: 'prompt', text: 'Prompt text' }, { kind: 'document', markdown: '# Document' },
      { kind: 'image', primary: a.blob.id }, { kind: 'file', primary: a.blob.id },
      ...['json', 'csv', 'toml', 'yaml'].map(format => ({ kind: 'data', format, text: 'Supplied bytes' })),
      { kind: 'data', format: 'sqlite', primary: a.blob.id }, { kind: 'link', url: 'https://example.org/path', summary: 'Supplied summary', notes: 'Supplied notes' },
    ];
    for (const content of contents) {
      const payload = { title: 'Title', tags: ['Tag', 'tag'], content, attachments: [a] };
      expect(validateArtifactPayload(payload).ok).toBe(true);
      for (const bad of [{ ...payload, grants: [] }, { ...payload, content: { ...content, actor: newId() } }, { ...payload, attachments: [{ ...a, secret: 'discard-me' }] }]) expect(validateArtifactPayload(bad).ok).toBe(false);
    }
    for (const kind of ['html', 'applet', 'interview', 'sensemaking-document', 'recovery', 'other']) {
      expect(validateArtifactPayload({ ...documentPayload(), content: { kind, markdown: 'x' } }).ok).toBe(false);
      await expect(artifactTypeHash(kind as 'document')).rejects.toThrow('Unsupported');
    }
    for (const content of [{ kind: 'skill', skill: '' }, { kind: 'prompt', text: '' }, { kind: 'file', primary: newId() }, { kind: 'data', format: 'xml', text: 'x' }, { kind: 'data', format: 'sqlite', text: 'x' }, { kind: 'data', format: 'json' }, { kind: 'data', format: 'json', text: 'x', primary: a.blob.id }]) expect(validateArtifactPayload({ ...documentPayload(), content }).ok).toBe(false);
    expect(validateArtifactPayload({ ...documentPayload(), tags: ['x', 'x'] }).ok).toBe(false);
    expect(validateArtifactPayload({ ...documentPayload(), attachments: [a, a] }).ok).toBe(false);
    expect(validateArtifactPayload({ ...documentPayload(), attachments: Array.from({ length: 8 }, () => attachment()) }).ok).toBe(true);
    expect(validateArtifactPayload({ ...documentPayload(), attachments: Array.from({ length: 9 }, () => attachment()) }).ok).toBe(false);
    for (const path of ['SKILL.md', undefined, '../secret', '/absolute', 'a/../b', 'a//b', 'C:/secret', 'a\\b', 'a\u0000b']) expect(validateArtifactPayload({ ...documentPayload(), content: { kind: 'skill', skill: 'Required text' }, attachments: [attachment(blob(), path)] }).ok).toBe(false);
    expect(validateArtifactPayload({ ...documentPayload(), attachments: [attachment(blob(), 'one'), attachment(blob(), 'one')] }).ok).toBe(false);
    expect(validPackagePath('assets/a.txt')).toBe(true);
    const base = documentPayload();
    const length = new TextEncoder().encode(JSON.stringify(base)).length;
    base.content.markdown = 'a'.repeat(MAX_ARTIFACT_PAYLOAD_BYTES - length + base.content.markdown.length);
    expect(validateArtifactPayload(base).ok).toBe(true);
    base.content.markdown += 'a'; expect(validateArtifactPayload(base).ok).toBe(false);
  });
  it('maps new categories to exact suggested tags and excludes recovery', () => {
    for (const category of ['note', 'decision', 'question', 'learning', 'tension', 'practice', 'success', 'resource', 'position', 'interview', 'lesson', 'Unrecognised category']) {
      expect(suggestedArtifact(category, ['Keep', category, 'Keep'])).toEqual({ type: 'document', tags: ['Keep', category] });
      expect(suggestedArtifact(category)).toEqual({ type: 'document', tags: [category] });
    }
    expect(suggestedArtifact('recovery', ['Keep'])).toBeNull();
  });
  it('validates descriptors against inclusive raw limits and rejects lies and unknown fields', () => {
    for (const size of [0, MAX_BLOB_BYTES - 1, MAX_BLOB_BYTES]) expect(validateBlobDescriptor(blob(newId(), size))).toBe(true);
    for (const patch of [{ size: -1 }, { size: MAX_BLOB_BYTES + 1, ciphertextSize: MAX_BLOB_BYTES + 17 }, { size: 1.5 }, { ciphertextSize: 17 }, { nonce: 'bad' }, { digest: 'bad' }, { epoch: 0 }, { journey: 'foreign' }, { name: 'private' }]) expect(validateBlobDescriptor({ ...blob(), ...patch })).toBe(false);
    const body = { format: 'artifact-v1', artifact: newId(), author: newId(), actor: newId(), version: newId(), typeHash: digest, blobs: [blob()] };
    expect(validateArtifactPublic('artifact.create', body).ok).toBe(true);
    const copied = copyArtifactPublic('artifact.create', body); body.blobs[0]!.size = 4; expect((copied.blobs as BlobDescriptor[])[0]!.size).toBe(0);
    expect(validateArtifactPublic('artifact.create', { ...body, secret: 'never-store' }).ok).toBe(false);
    expect(() => copyArtifactPublic('artifact.create', { ...body, grants: [] })).toThrow();
    expect(validateArtifactPublic('artifact.revive', body).ok).toBe(false);
  });
  it('refuses unsafe URLs without fetching and requires both Stage 1 capabilities', () => {
    for (const url of ['http://example.org', 'https://example.org/path?q=1#part']) expect(validArtifactUrl(url)).toBe(true);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://example.org/file', '/relative', 'https://user:pass@example.org', 'https://example.org/\n', ' https://example.org', 'https://example.org/a b']) expect(validArtifactUrl(url)).toBe(false);
    expect(CLIENT_VERSION).toBe('0.1.6'); expect(CLIENT_CAPABILITIES).toEqual(['control-proof-v1', 'artifact-v1', 'project-v1']);
    expect(supportsArtifacts('0.1.5', '0.1.5', CLIENT_CAPABILITIES)).toBe(true);
    for (const version of ['0.1.4', '0.1.3', '01.1.5', '0.1.5-extra']) expect(supportsArtifacts(version, '0.1.5', CLIENT_CAPABILITIES)).toBe(false);
    for (const capabilities of [[], ['control-proof-v1'], ['artifact-v1']]) expect(supportsArtifacts('0.1.5', '0.1.5', capabilities)).toBe(false);
    expect(supportsArtifacts('0.1.5', '0.1.6', CLIENT_CAPABILITIES)).toBe(false);
  });
});

describe('signed artifact replay calls production Bend', () => {
  it('keeps stable identity, immutable author, real writers, whole-artifact comments and all live versions', async () => {
    const f = await artifactFixture(), writer = await person(), bot = await agent(writer.member.id);
    await artifactAppend(f, f.guide, 'member.add', { kind: 'person', member: writer.member, grants: [] });
    await artifactAppend(f, writer, 'member.add', { kind: 'agent', member: bot.member, grants: [] });
    const descriptor = blob(f.journey), body = await artifactBody(f.guide.member.id, { blobs: [descriptor] });
    const payload = { ...documentPayload(), attachments: [attachment(descriptor)] };
    const creation = await artifactAppend(f, f.guide, 'artifact.create', body, payload);
    expect(JSON.stringify(creation.proof)).not.toMatch(/Secret title|Private Markdown|Private filename|application\/octet-stream|Note/);
    const read = await readArtifactPayload(creation.proof, creation.envelope, f.key); expect(read.body).toEqual(payload);
    payload.tags.push('later'); expect((read.body as ArtifactPayload).tags).toEqual(['Note', 'note']);
    const version = newId();
    await artifactAppend(f, bot, 'artifact.version', { ...body, version, predecessor: body.version, actor: bot.member.id, blobs: [] });
    const comment = newId();
    await artifactAppend(f, writer, 'artifact.comment', { format: 'artifact-v1', artifact: body.artifact, author: f.guide.member.id, actor: writer.member.id, comment }, { text: 'Whole artifact' });
    await artifactAppend(f, bot, 'artifact.comment', { format: 'artifact-v1', artifact: body.artifact, author: f.guide.member.id, actor: bot.member.id, comment: newId(), onVersion: body.version }, { text: 'Earlier context' });
    const checked = await state(f), item = checked.artifacts!.items[body.artifact as string]!;
    expect(item).toMatchObject({ id: body.artifact, author: f.guide.member.id, head: version, deleted: false });
    expect(item.versions.map(v => v.actor)).toEqual([f.guide.member.id, bot.member.id]);
    expect(item.comments[0]).toMatchObject({ id: comment, actor: writer.member.id }); expect(item.comments[0]).not.toHaveProperty('onVersion');
    expect(item.comments[1]!.onVersion).toBe(body.version);
    expect(liveArtifactBlobIds(checked)).toEqual([descriptor.id]);
    const publicResult = await artifactResult(f, false); expect(publicResult.ok).toBe(true); if (publicResult.ok) expect(publicResult.state.artifacts).toEqual(checked.artifacts);
    await artifactAppend(f, writer, 'artifact.delete', { format: 'artifact-v1', artifact: body.artifact, author: f.guide.member.id, actor: writer.member.id }, {});
    const deleted = await state(f); expect(deleted.artifacts!.items[body.artifact as string]!.deleted).toBe(true);
    expect(deleted.artifacts!.items[body.artifact as string]!.versions).toHaveLength(2); expect(liveArtifactBlobIds(deleted)).toEqual([]);
    await artifactAppend(f, bot, 'artifact.version', { ...body, version: newId(), predecessor: version, actor: bot.member.id, blobs: [] });
    expect((await artifactResult(f)).ok).toBe(false);
  });
  it('rejects forged author or actor, stale predecessors, reused IDs, changed type and cross-artifact references', async () => {
    const f = await artifactFixture(), other = await person();
    await artifactAppend(f, f.guide, 'member.add', { kind: 'person', member: other.member, grants: [] });
    const b = blob(f.journey), body = await artifactBody(f.guide.member.id, { blobs: [b] }), payload = { ...documentPayload(), attachments: [attachment(b)] };
    for (const override of [{ author: other.member.id }, { actor: other.member.id }, { version: body.artifact }]) {
      await artifactAppend(f, f.guide, 'artifact.create', { ...body, ...override }, payload); expect((await artifactResult(f)).ok).toBe(false); f.controls.pop();
    }
    await artifactAppend(f, f.guide, 'artifact.create', body, payload);
    const head = newId(); await artifactAppend(f, other, 'artifact.version', { ...body, version: head, predecessor: body.version, actor: other.member.id }, payload);
    for (const override of [{ predecessor: body.version }, { author: other.member.id }, { actor: f.guide.member.id }, { version: body.version }, { version: body.artifact }]) {
      await artifactAppend(f, other, 'artifact.version', { ...body, version: newId(), predecessor: head, actor: other.member.id, ...override }, payload);
      expect((await artifactResult(f)).ok).toBe(false); f.controls.pop();
    }
    await artifactAppend(f, other, 'artifact.version', { ...body, version: newId(), predecessor: head, actor: other.member.id, typeHash: await artifactTypeHash('prompt') }, { ...payload, content: { kind: 'prompt', text: 'Other type' } });
    expect((await artifactResult(f)).ok).toBe(false); f.controls.pop();
    await artifactAppend(f, other, 'artifact.create', await artifactBody(other.member.id, { blobs: [b] }), payload);
    expect((await artifactResult(f)).ok).toBe(false); f.controls.pop();
    const commentBody = { format: 'artifact-v1', artifact: body.artifact, author: body.author, actor: other.member.id, comment: newId() };
    for (const override of [{ onVersion: newId() }, { comment: body.artifact }, { author: other.member.id }, { actor: f.guide.member.id }]) {
      await artifactAppend(f, other, 'artifact.comment', { ...commentBody, ...override }, { text: 'No' }); expect((await artifactResult(f)).ok).toBe(false); f.controls.pop();
    }
    for (const override of [{ author: other.member.id }, { actor: f.guide.member.id }]) {
      await artifactAppend(f, other, 'artifact.delete', { format: 'artifact-v1', artifact: body.artifact, author: body.author, actor: other.member.id, ...override }, {}); expect((await artifactResult(f)).ok).toBe(false); f.controls.pop();
    }
    expect((await artifactResult(f)).ok).toBe(true);
  });
  it('requires current inherited write access, never guide grants or an agent control privilege', async () => {
    const f = await artifactFixture(), p = await person(), bot = await agent(p.member.id), limited = await agent(p.member.id, 'read');
    await artifactAppend(f, f.guide, 'member.add', { kind: 'person', member: p.member, grants: [] });
    for (const a of [bot, limited]) await artifactAppend(f, p, 'member.add', { kind: 'agent', member: a.member, grants: [] });
    const body = await artifactBody(bot.member.id); await artifactAppend(f, bot, 'artifact.create', body); expect((await artifactResult(f)).ok).toBe(true);
    await artifactAppend(f, limited, 'artifact.create', await artifactBody(limited.member.id)); expect((await artifactResult(f)).ok).toBe(false); f.controls.pop();
    await artifactAppend(f, bot, 'journey.settings', { name: 'Agent takeover', description: '', defaultRole: 'read-write', visibility: 'private', joiningPolicy: 'invitation-only' }); expect((await artifactResult(f)).ok).toBe(false); f.controls.pop();
    await artifactAppend(f, f.guide, 'member.role', { member: p.member.id, role: 'read-only' });
    for (const a of [p, bot]) { await artifactAppend(f, a, 'artifact.create', await artifactBody(a.member.id)); expect((await artifactResult(f)).ok).toBe(false); f.controls.pop(); }
    await artifactAppend(f, f.guide, 'member.role', { member: f.guide.member.id, role: 'read-only' });
    await artifactAppend(f, f.guide, 'artifact.create', await artifactBody(f.guide.member.id)); expect((await artifactResult(f)).ok).toBe(false); f.controls.pop();
    await artifactAppend(f, f.guide, 'member.role', { member: f.guide.member.id, role: 'read-write' });
    await artifactAppend(f, f.guide, 'member.remove', { member: p.member.id });
    await artifactAppend(f, f.guide, 'artifact.create', await artifactBody(f.guide.member.id)); expect((await artifactResult(f)).ok).toBe(false); f.controls.pop();
    await artifactAppend(f, bot, 'artifact.create', await artifactBody(bot.member.id)); expect((await artifactResult(f)).ok).toBe(false);
    const expired = await artifactFixture(), e = await agent(expired.guide.member.id); e.member.expiresAt = '2026-01-02T00:00:00.000Z';
    await artifactAppend(expired, expired.guide, 'member.add', { kind: 'agent', member: e.member, grants: [] }, {}, '2026-01-01T00:00:00.000Z');
    await artifactAppend(expired, e, 'artifact.create', await artifactBody(e.member.id)); expect((await artifactResult(expired)).ok).toBe(false);
  });
  it('requires the signed Stage 1 minimum before any artifact', async () => {
    const f = await artifactFixture('0.1.4'), body = await artifactBody(f.guide.member.id);
    await artifactAppend(f, f.guide, 'artifact.create', body); expect((await artifactResult(f)).ok).toBe(false); f.controls.pop();
    await artifactAppend(f, f.guide, 'client.minVersion', { version: '0.1.5' }); await artifactAppend(f, f.guide, 'artifact.create', body); expect((await artifactResult(f)).ok).toBe(true);
    await expect(signEntry({ v: 1, seq: 0, prev: null, at: '', actor: f.guide.member.id, type: 'artifact.create', body }, f.guide.key)).rejects.toThrow('ControlProof');
  });
  it('rejects tampered signatures, chain, journey, ciphertext and unexpected signed fields', async () => {
    const f = await artifactFixture(), body = await artifactBody(f.guide.member.id); const row = await artifactAppend(f, f.guide, 'artifact.create', body);
    for (const patch of [{ journey: newId() }, { seq: 0 }, { prev: null }, { actor: newId() }, { sig: digest }, { type: 'artifact.unknown' }, { grants: [] }]) {
      const proof = { ...row.proof, ...patch } as ControlProof;
      expect((await verifyControlProofs([f.controls[0]!.proof, proof], f.controls.map(c => c.envelope), f.trust)).ok).toBe(false);
    }
    const extra = { ...row.proof, body: { ...row.proof.body, secret: 'never-store' } };
    // Re-sign extras so this test catches shape validation, not just a bad signature.
    const { sig: _sig, ...unsigned } = extra;
    extra.sig = encode(new Uint8Array(await crypto.subtle.sign('Ed25519', f.guide.key, new TextEncoder().encode(canonical(unsigned)))));
    expect((await verifyControlProofs([f.controls[0]!.proof, extra], f.controls.map(c => c.envelope), f.trust)).ok).toBe(false);
    const envelope = { ...row.envelope, ciphertext: row.envelope.ciphertext.slice(0, -4) + 'AAAA' };
    expect((await verifyControlProofs(f.controls.map(c => c.proof), [f.controls[0]!.envelope, envelope], f.trust)).ok).toBe(false);
  });
  it('never treats ciphertext as another action or grants and rejects cross-journey descriptors', async () => {
    const f = await artifactFixture(), body = await artifactBody(f.guide.member.id), entry = { v: 1 as const, seq: 1, prev: await hashControlProof(f.controls[0]!.proof), at: '2026-01-02T00:00:00.000Z', actor: f.guide.member.id, type: 'artifact.create', body };
    const envelope = await seal({ type: 'artifact.content', typeVersion: 1, body: { ...documentPayload(), actor: newId(), grants: ['members.manage'] } }, { id: newId(), journey: f.journey, seq: 1, epoch: 1, createdAt: entry.at }, f.key);
    f.controls.push({ proof: await signControlProof(entry, envelope, f.journey, f.guide.key), envelope });
    expect((await artifactResult(f, false)).ok).toBe(true); expect((await artifactResult(f)).ok).toBe(false); f.controls.pop();
    const b = blob(), foreignBody = { ...body, blobs: [b] };
    await expect(artifactAppend(f, f.guide, 'artifact.create', foreignBody, { ...documentPayload(), attachments: [attachment(b)] })).rejects.toThrow('projection');
    const foreignEnvelope = await seal({ type: 'artifact.content', typeVersion: 1, body: documentPayload() }, { id: newId(), journey: f.journey, seq: 1, epoch: 1, createdAt: entry.at }, f.key);
    f.controls.push({ proof: await signControlProof({ ...entry, body: foreignBody }, foreignEnvelope, f.journey, f.guide.key), envelope: foreignEnvelope });
    expect((await artifactResult(f, false)).ok).toBe(false);
    expect(await open(envelope, f.key)).toHaveProperty('body.actor');
  });
});
