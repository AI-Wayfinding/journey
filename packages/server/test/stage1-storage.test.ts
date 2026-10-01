import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { exportArtifactJourney, generateJourneyKey, importArtifactJourney, MAX_BLOB_BYTES, newId, openBlob, recipientsHash, sealBlob, type ArtifactArchive, type Member } from '@ai-wayfinding/core';
import { artifact, as, addAgent, addPerson, agentHeaders, begin, body, bucket, bucketKey, change, collect, enclaveStub, expireStage, fixture, payload, request, rows, settings, staged, state, stored, submit, upload, proof, wraps } from './stage1-fixtures.js';

describe('Stage 1 authenticated local R2 lifecycle', () => {
  it('stores binary ciphertext only, denies staged reads, commits atomically and retries the exact proof', async () => {
    const { owner, j } = await fixture(), blob = await staged(j, owner), b = await body(owner, [blob]);
    const control = await artifact(j, owner, 'artifact.create', b, payload([blob]));
    const before = await stored(j);
    expect((await submit(j, owner, control)).status).toBe(409); // Unfinished upload.
    expect(await stored(j)).toBe(before);
    expect((await request(`/v1/journeys/${j.id}/blobs/${blob.descriptor.id}`, 'GET', undefined, as(owner))).status).toBe(404);
    expect((await upload(j, owner, blob)).status).toBe(201);
    expect(new Uint8Array(await (await bucket().get(bucketKey(j, blob.descriptor.id)))!.arrayBuffer())).toEqual(blob.ciphertext);
    const uploaded = await stored(j);
    for (const bad of [
      { ...control, proof: { ...control.proof, sig: 'AAAA' } },
      { ...control, proof: { ...control.proof, actor: newId() } },
      { ...control, proof: { ...control.proof, journey: newId() } },
      { ...control, envelope: { ...control.envelope, ciphertext: control.envelope.ciphertext + 'AAAA' } },
      { ...control, proof: { ...control.proof, body: { ...control.proof.body, secret: 'CALLER EXTRA' } } },
    ]) {
      expect((await submit(j, owner, bad)).ok).toBe(false);
      expect(await stored(j)).toBe(uploaded);
    }
    expect((await submit(j, owner, control, { secret: 'CALLER EXTRA' })).status).toBe(400);
    expect(await stored(j)).toBe(uploaded);
    expect((await submit(j, owner, control)).status).toBe(201);
    const committed = await stored(j);
    const retry = await request(`/v1/journeys/${j.id}/log`, 'POST', { control }, as(owner));
    expect(retry.status).toBe(200); expect(await retry.json()).toMatchObject({ retry: true });
    expect(await stored(j)).toBe(committed);
    expect(committed).not.toContain('SECRET'); expect(committed).not.toContain('CALLER EXTRA');
    const download = await request(`/v1/journeys/${j.id}/blobs/${blob.descriptor.id}`, 'GET', undefined, as(owner));
    expect(download.status).toBe(200);
    expect(download.headers.get('Cache-Control')).toBe('no-store');
    expect(download.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(download.headers.get('Content-Disposition')).toBe(`attachment; filename="${blob.descriptor.id}.encrypted"`);
    expect(await openBlob(new Uint8Array(await download.arrayBuffer()), blob.descriptor, j.key)).toEqual(new TextEncoder().encode('SECRET attachment bytes'));
    const outsider = await fixture();
    expect((await request(`/v1/journeys/${j.id}/blobs/${blob.descriptor.id}`, 'GET', undefined, as(outsider.owner))).status).toBe(403);
  });

  it('enforces actual streamed lengths and digest with zero and inclusive 25,000,000 byte limits', async () => {
    const { owner, j } = await fixture();
    for (const size of [0, MAX_BLOB_BYTES - 1, MAX_BLOB_BYTES]) {
      const blob = await staged(j, owner, new Uint8Array(size));
      expect((await upload(j, owner, blob)).status).toBe(201);
      expect((await bucket().head(bucketKey(j, blob.descriptor.id)))!.size).toBe(size + 16);
    }
    for (const size of [-1, MAX_BLOB_BYTES + 1, 1.5]) expect((await request(`/v1/journeys/${j.id}/blobs`, 'POST', { size }, as(owner))).status).toBe(400);
    expect((await request(`/v1/journeys/${j.id}/blobs`, 'POST', { size: 0, name: 'CALLER EXTRA' }, as(owner))).status).toBe(400);
    const blob = await staged(j, owner, new Uint8Array(2));
    for (const [bytes, status] of [[blob.ciphertext.slice(1), 400], [new Uint8Array(19), 413], [new Uint8Array(18), 400]] as const) {
      expect((await upload(j, owner, blob, bytes, { 'Content-Length': '18' })).status).toBe(status);
      expect((await rows(j)).find(r => r.id === blob.descriptor.id)!.complete).toBe(0);
      expect(await bucket().head(bucketKey(j, blob.descriptor.id))).toBeNull();
    }
    // Send valid initial bytes then exceed the declared size in a later chunk.
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(blob.ciphertext); c.enqueue(new Uint8Array(1)); c.close(); } });
    expect((await upload(j, owner, blob, stream, { 'Content-Length': '18' })).status).toBe(413);
    expect((await upload(j, owner, blob, blob.ciphertext, { 'X-Blob-Descriptor': JSON.stringify({ ...blob.descriptor, name: 'CALLER EXTRA' }) })).status).toBe(400);
    expect((await upload(j, owner, blob, blob.ciphertext, { 'X-Blob-Descriptor': JSON.stringify({ ...blob.descriptor, size: MAX_BLOB_BYTES + 1, ciphertextSize: MAX_BLOB_BYTES + 17 }) })).status).toBe(400);
    expect((await upload(j, owner, blob)).status).toBe(201); // A failed upload is retryable.
    expect((await upload(j, owner, blob)).status).toBe(403); // Completed bytes are immutable.
    expect(await stored(j)).not.toContain('CALLER EXTRA');
  });

  it('rejects stolen stages, cross-journey references and dishonest descriptors without partial writes', async () => {
    const { owner, j } = await fixture(), guest = await addPerson(j, owner), blob = await staged(j, owner);
    expect((await upload(j, guest, blob)).status).toBe(403);
    expect((await upload(j, owner, blob)).status).toBe(201);
    const b = await body(guest, [blob]), before = await stored(j);
    expect((await submit(j, guest, await artifact(j, guest, 'artifact.create', b, payload([blob])))).status).toBe(409);
    expect(await stored(j)).toBe(before);
    const other = await fixture(), foreign = await staged(other.j, other.owner);
    expect((await upload(other.j, other.owner, foreign)).status).toBe(201);
    // A signer can sign a public foreign descriptor even though a well-behaved client refuses it.
    const signed = await artifact(j, owner, 'artifact.create', await body(owner));
    const malicious = { ...signed.proof.body, blobs: [foreign.descriptor] };
    const { signControlProof, importSigningKey } = await import('@ai-wayfinding/core');
    const altered = { proof: await signControlProof({ ...signed.proof, body: malicious }, signed.envelope, j.id, await importSigningKey(owner.signing.privateKey)), envelope: signed.envelope };
    expect((await submit(j, owner, altered)).ok).toBe(false);
    expect(await stored(j)).toBe(before);
    const changed = { ...blob, descriptor: { ...blob.descriptor, nonce: 'AAAAAAAAAAAAAAAA' } };
    expect((await submit(j, owner, await artifact(j, owner, 'artifact.create', await body(owner, [changed]), payload([changed])))).status).toBe(409);
    expect(await stored(j)).toBe(before);
  });

  it('pins author and writer, conflicts concurrent/stale edits, retains every live version and denies resurrection', async () => {
    const { owner, j } = await fixture(), guest = await addPerson(j, owner), blob = await staged(j, owner);
    expect((await upload(j, owner, blob)).status).toBe(201);
    const b = await body(owner, [blob]);
    expect((await submit(j, owner, await artifact(j, owner, 'artifact.create', b, payload([blob])))).status).toBe(201);
    const edited = { ...b, actor: guest.principal, predecessor: b.version, version: newId() };
    const before = await stored(j);
    for (const invalid of [{ ...edited, author: guest.principal }, { ...edited, actor: owner.principal }, { ...edited, predecessor: newId() }]) {
      expect((await submit(j, guest, await artifact(j, guest, 'artifact.version', invalid, payload([blob])))).status).toBe(409);
      expect(await stored(j)).toBe(before);
    }
    const a = await artifact(j, guest, 'artifact.version', edited, payload([blob]));
    const b2 = await artifact(j, owner, 'artifact.version', { ...edited, actor: owner.principal, version: newId() }, payload([blob]));
    const results = await Promise.all([request(`/v1/journeys/${j.id}/log`, 'POST', { control: a }, as(guest)), request(`/v1/journeys/${j.id}/log`, 'POST', { control: b2 }, as(owner))]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    j.controls.push(results[0]!.ok ? a : b2);
    const head = (await state(j)).artifacts!.items[String(b.artifact)]!;
    expect(head.author).toBe(owner.principal); expect(head.versions).toHaveLength(2);
    expect(head.versions.at(-1)!.actor).toBe(results[0]!.ok ? guest.principal : owner.principal);
    const different = await body(owner, [blob]);
    expect((await submit(j, owner, await artifact(j, owner, 'artifact.create', different, payload([blob])))).status).toBe(409);
    const noAttachment = { ...b, actor: guest.principal, predecessor: head.head, version: newId(), blobs: [] };
    expect((await submit(j, guest, await artifact(j, guest, 'artifact.version', noAttachment))).status).toBe(201);
    await expireStage(j, blob.descriptor.id); await collect(j);
    expect(await bucket().head(bucketKey(j, blob.descriptor.id))).not.toBeNull(); // Older version remains live.
    const comment = { format: 'artifact-v1', artifact: b.artifact, author: owner.principal, actor: guest.principal, comment: newId(), onVersion: b.version };
    expect((await submit(j, guest, await artifact(j, guest, 'artifact.comment', comment))).status).toBe(201);
    const tombstone = { format: 'artifact-v1', artifact: b.artifact, author: owner.principal, actor: guest.principal };
    expect((await submit(j, guest, await artifact(j, guest, 'artifact.delete', tombstone))).status).toBe(201);
    expect((await request(`/v1/journeys/${j.id}/blobs/${blob.descriptor.id}`, 'GET', undefined, as(owner))).status).toBe(404);
    expect((await submit(j, guest, await artifact(j, guest, 'artifact.version', { ...noAttachment, predecessor: noAttachment.version, version: newId() }))).status).toBe(409);
    expect((await submit(j, guest, await artifact(j, guest, 'artifact.comment', { ...comment, comment: newId() }))).status).toBe(409);
    await collect(j); await collect(j);
    expect(await bucket().head(bucketKey(j, blob.descriptor.id))).toBeNull();
    expect(await rows(j)).toEqual([]);
    expect((await state(j)).artifacts!.items[String(b.artifact)]!.comments).toHaveLength(1);
  });

  it.each(['downgrade', 'remove', 'pending', 'version', 'expiry', 'epoch'] as const)('rechecks %s during a streamed upload and blocks the prebuilt commit', async scenario => {
    const { owner, j } = await fixture(), guest = await addPerson(j, owner), blob = await staged(j, guest);
    const control = await artifact(j, guest, 'artifact.create', await body(guest, [blob]), payload([blob]));
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>(r => { entered = r; }), resume = new Promise<void>(r => { release = r; });
    const stream = new ReadableStream<Uint8Array>({ async pull(c) { entered(); await resume; c.enqueue(blob.ciphertext); c.close(); } }, { highWaterMark: 0 });
    const result = upload(j, guest, blob, stream);
    await reading;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    if (scenario === 'downgrade') expect((await change(j, owner, 'member.role', { member: guest.principal, role: 'read-only' })).status).toBe(201);
    if (scenario === 'remove') expect((await change(j, owner, 'member.remove', { member: guest.principal })).status).toBe(201);
    if (scenario === 'pending' || scenario === 'epoch') {
      const agent = await addAgent(j, owner);
      expect((await change(j, owner, 'member.remove', { member: agent.principal })).status).toBe(201);
      if (scenario === 'epoch') {
        const key = generateJourneyKey(2), members = (await state(j)).members;
        expect((await submit(j, owner, await proof(j, owner, 'key.rotate', { epoch: 2, recipientsHash: await recipientsHash(members) }, key), { wraps: await wraps(j, Object.values(members).map(v => v.member), key) })).status).toBe(201);
        j.key = key;
      }
    }
    if (scenario === 'version') expect((await change(j, owner, 'client.minVersion', { version: '0.1.6' })).status).toBe(201);
    if (scenario === 'expiry') await expireStage(j, blob.descriptor.id);
    release();
    try {
      expect((await result).status).toBe(403);
      expect((await rows(j)).find(r => r.id === blob.descriptor.id)!.complete).toBe(0);
      const before = await stored(j);
      expect((await submit(j, guest, control)).ok).toBe(false);
      expect(await stored(j)).toBe(before);
      if (scenario !== 'version') expect((await request(`/v1/journeys/${j.id}/blobs`, 'POST', { size: 0 }, as(guest))).status).toBe(scenario === 'expiry' || scenario === 'epoch' ? 201 : 403);
    } finally { clock?.mockRestore(); }
  });

  it('inherits agent limits from the person, authenticates exact binary bytes, and checks live expiry', async () => {
    const { owner, j } = await fixture(), guest = await addPerson(j, owner), agent = await addAgent(j, guest, 'readwrite');
    const path = `/v1/journeys/${j.id}/blobs`;
    const beginResponse = await request(path, 'POST', { size: 0 }, await agentHeaders(agent, 'POST', path, { size: 0 }));
    expect(beginResponse.status).toBe(201);
    const stage = await beginResponse.json() as { id: string; epoch: number };
    const blob = await sealBlob(new Uint8Array(), { id: stage.id, journey: j.id, epoch: stage.epoch }, j.key);
    expect((await upload(j, agent, blob, blob.ciphertext, { 'X-Agent-Signature': 'AAAA' })).status).toBe(401);
    expect((await upload(j, agent, blob)).status).toBe(201);
    const b = await body(agent, [blob]), control = await artifact(j, agent, 'artifact.create', b, payload([blob]));
    const logPath = `/v1/journeys/${j.id}/log`;
    const written = await request(logPath, 'POST', { control }, await agentHeaders(agent, 'POST', logPath, { control }));
    expect(written.status).toBe(201); j.controls.push(control);
    expect((await change(j, owner, 'member.role', { member: guest.principal, role: 'read-only' })).status).toBe(201);
    expect((await request(path, 'POST', { size: 0 }, await agentHeaders(agent, 'POST', path, { size: 0 }))).status).toBe(403);
    const reading = `/v1/journeys/${j.id}/blobs/${blob.descriptor.id}`;
    expect((await request(reading, 'GET', undefined, await agentHeaders(agent, 'GET', reading))).status).toBe(200);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(agent.expiresAt + 1);
    try { expect((await request(reading, 'GET', undefined, await agentHeaders(agent, 'GET', reading))).status).toBe(401); } finally { clock.mockRestore(); }
    expect((await change(j, owner, 'member.remove', { member: guest.principal })).status).toBe(201);
    expect((await request(reading, 'GET', undefined, await agentHeaders(agent, 'GET', reading))).status).toBe(403);
  });

  it('denies read-only guides and incompatible capabilities before accepting uploads or partial content', async () => {
    const { owner, j } = await fixture();
    await settings(j, owner, 'read-only');
    const guide = await addPerson(j, owner, { grants: ['members.manage'] });
    expect((await request(`/v1/journeys/${j.id}/blobs`, 'POST', { size: 0 }, as(guide))).status).toBe(403);
    expect((await submit(j, guide, await artifact(j, guide, 'artifact.create', await body(guide)))).status).toBe(403);
    for (const extra of [{ 'X-Client-Version': '0.1.4' }, { 'X-Artifact-Format': '' }, { 'X-Control-Format': '' }]) {
      for (const route of ['log', 'records', 'export']) expect((await request(`/v1/journeys/${j.id}/${route}`, 'GET', undefined, { ...as(owner), ...extra })).status).toBe(426);
      expect((await request(`/v1/journeys/${j.id}/blobs`, 'POST', { size: 0 }, { ...as(owner), ...extra })).status).toBe(426);
    }
    expect(await (await request(`/v1/journeys/${j.id}/protocol`, 'GET', undefined, { ...as(owner), 'X-Client-Version': '0.1.4' })).json()).toEqual({ minClientVersion: '0.1.5', controlFormat: 'control-proof-v1', artifactFormat: 'artifact-v1' });
  });

  it('collects expired abandoned uploads, retries bucket failures, and exports surviving verified ciphertext', async () => {
    const { owner, j } = await fixture(), abandoned = await staged(j, owner), live = await staged(j, owner), deleted = await staged(j, owner);
    for (const blob of [abandoned, live, deleted]) expect((await upload(j, owner, blob)).status).toBe(201);
    const a = await body(owner, [live]), d = await body(owner, [deleted]);
    expect((await submit(j, owner, await artifact(j, owner, 'artifact.create', a, payload([live])))).status).toBe(201);
    expect((await submit(j, owner, await artifact(j, owner, 'artifact.create', d, payload([deleted])))).status).toBe(201);
    expect((await submit(j, owner, await artifact(j, owner, 'artifact.delete', { format: 'artifact-v1', artifact: d.artifact, author: owner.principal, actor: owner.principal }))).status).toBe(201);
    await collect(j);
    expect(await bucket().head(bucketKey(j, abandoned.descriptor.id))).not.toBeNull();
    await expireStage(j, abandoned.descriptor.id);
    // Real local R2 for successful effects, injected one-shot delete failure for retry.
    await runInDurableObject(enclaveStub(j.id), async object => {
      const o = object as unknown as { env: { ARTIFACT_BLOBS: R2Bucket }; alarm(): Promise<void> };
      const real = o.env.ARTIFACT_BLOBS;
      o.env.ARTIFACT_BLOBS = { delete: async () => { throw new Error('local failure'); } } as unknown as R2Bucket;
      try { await o.alarm(); } finally { o.env.ARTIFACT_BLOBS = real; }
    });
    expect(await bucket().head(bucketKey(j, abandoned.descriptor.id))).not.toBeNull();
    await collect(j); await collect(j);
    expect(await bucket().head(bucketKey(j, abandoned.descriptor.id))).toBeNull();
    expect(await bucket().head(bucketKey(j, live.descriptor.id))).not.toBeNull();
    const archive = await (await request(`/v1/journeys/${j.id}/export`, 'GET', undefined, as(owner))).json() as ArtifactArchive;
    expect(archive.blobs.map(b => b.descriptor.id)).toEqual([live.descriptor.id]);
    expect(archive.unavailableDeletedBlobs).toEqual([deleted.descriptor.id]);
    expect(JSON.stringify(archive)).not.toContain('SECRET');
    const trust = { journey: j.id, creator: j.controls[0]!.proof.body.creator as Member };
    const encrypted = await exportArtifactJourney(archive, [owner.age.recipient], [owner.age.identity], trust);
    expect(encrypted).not.toContain('SECRET');
    const imported = await importArtifactJourney(encrypted, [owner.age.identity], trust);
    expect(imported.archive).toEqual(archive);
    expect(imported.state.artifacts!.items[String(d.artifact)]!.deleted).toBe(true);
    expect(imported.state.artifacts!.items[String(a.artifact)]!.deleted).toBe(false);
  });
});
