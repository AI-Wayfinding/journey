import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { newId, sealControlLabels, signControlProof, importSigningKey, projectPurposeHash, verifyControlProofs, effectiveProjectParticipants, type Member, type JsonObject } from '@ai-wayfinding/core';
import { fixture, createProject, project, send, queued, freshRead, persisted, stored, change, proof, as, request, addPerson, addAgent, state, artifact, body, staged, upload, submit, rows, bucket, bucketKey, enclaveStub, payload } from './stage2-fixtures.js';
import { fixture as legacy } from './stage1-fixtures.js';
import { fixture as stage0, wraps } from './stage0-fixtures.js';
import { EnclaveObject, type Env } from '../src/index.js';

const join = async (j: Parameters<typeof project>[0], actor: Parameters<typeof send>[1], id: string, predecessor: number | null = null) => {
  const c = await project(j, actor, 'project.join', { project: id, member: actor.principal, predecessor });
  expect((await send(j, actor, c)).status).toBe(201); return c.proof.seq;
};

describe('Stage 2 current project authority in local workerd/R2', () => {
  it('atomically persists verified projection, exact retries and fresh-object replay without plaintext or caller extras', async () => {
    const { owner, j } = await fixture(), p = await createProject(j, owner);
    expect((await persisted(j)).projects.participation).toEqual([]);
    await join(j, owner, p.id);
    const c = await project(j, owner, 'project.purpose', { project: p.id, predecessor: p.revision, purposeHash: await projectPurposeHash('NEW SECRET PURPOSE') }, 'NEW SECRET PURPOSE');
    expect((await send(j, owner, c)).status).toBe(201);
    const before = await stored(j);
    const retry = await send(j, owner, c); expect(retry.status).toBe(200); expect((await retry.json() as { retry: boolean }).retry).toBe(true);
    expect(await stored(j)).toBe(before);
    const changed = { ...c, proof: { ...c.proof, body: { ...c.proof.body, purposeHash: await projectPurposeHash('OTHER') } } };
    expect((await send(j, owner, changed)).status).toBe(409); expect(await stored(j)).toBe(before);
    const next = await project(j, owner, 'project.state', { project: p.id, predecessor: c.proof.seq, state: 'active' });
    for (const value of [
      { control: { ...next, proof: { ...next.proof, body: { ...next.proof.body, purpose: 'SMUGGLED' } } } },
      { control: next, projects: { [p.id]: 'SMUGGLED' } },
      { control: { ...next, envelope: { ...next.envelope, purpose: 'SMUGGLED' } } },
    ]) { expect((await request(`/v1/journeys/${j.id}/log`, 'POST', value, as(owner))).status).toBe(400); expect(await stored(j)).toBe(before); }
    expect(before).not.toContain(p.purpose); expect(before).not.toContain('NEW SECRET PURPOSE'); expect(before).not.toContain('SMUGGLED');
    const read = await freshRead(j, owner); expect(read.status).toBe(200);
    const controls = (read.body as { log: typeof j.controls }).log;
    const checked = await verifyControlProofs(controls.map(c => c.proof), controls.map(c => c.envelope), { journey: j.id, creator: j.controls[0]!.proof.body.creator as Member }, [j.key]);
    expect(checked.ok).toBe(true); if (!checked.ok) throw Error('replay');
    expect(checked.state.projects!.items[p.id]!.purpose).toBe('NEW SECRET PURPOSE');
    expect(checked.state.projects!.items[p.id]!.revision).toBe(c.proof.seq);
    expect((await persisted(j)).lastHash).toBe(checked.state.lastHash);
  });

  it('uses D17 only for participant metadata and derives agents from their live adding person', async () => {
    const { owner, j } = await fixture(), p = await createProject(j, owner), guest = await addPerson(j, owner);
    const readAgent = await addAgent(j, guest, 'read');
    expect((await send(j, owner, await project(j, owner, 'project.state', { project: p.id, predecessor: p.revision, state: 'active' }))).status).toBe(403); // guide is not a participant
    await join(j, guest, p.id);
    const lateAgent = await addAgent(j, guest, 'readwrite');
    expect(effectiveProjectParticipants(await state(j), p.id).sort()).toEqual([guest.principal, readAgent.principal, lateAgent.principal].sort());
    expect((await change(j, owner, 'member.role', { member: guest.principal, role: 'read-only' })).status).toBe(201);
    let revision = p.revision;
    for (const actor of [guest, readAgent, lateAgent]) {
      const c = await project(j, actor, 'project.purpose', { project: p.id, predecessor: revision, purposeHash: await projectPurposeHash(actor.principal) }, actor.principal);
      expect((await send(j, actor, c)).status).toBe(201); revision = c.proof.seq;
      const snapshot = await stored(j);
      expect((await send(j, actor, await project(j, actor, 'project.create', { project: newId(), state: 'getting-started', purposeHash: await projectPurposeHash('DENIED') }, 'DENIED'))).status).toBe(403);
      expect((await send(j, actor, await project(j, actor, 'project.join', { project: p.id, member: owner.principal, predecessor: null }))).status).toBe(403);
      expect(await stored(j)).toBe(snapshot);
    }
    const b = await body(owner); expect((await submit(j, owner, await artifact(j, owner, 'artifact.create', b))).status).toBe(201);
    const snapshot = await stored(j);
    expect((await send(j, guest, await project(j, guest, 'artifact.project', { project: p.id, artifact: b.artifact, author: owner.principal, actor: guest.principal, predecessor: null }))).status).toBe(403);
    expect((await request(`/v1/journeys/${j.id}/blobs`, 'POST', { size: 1 }, as(guest))).status).toBe(403);
    for (const [type, fields] of [
      ['artifact.create', await body(guest)],
      ['artifact.version', { ...b, actor: guest.principal, predecessor: b.version, version: newId() }],
      ['artifact.comment', { format: 'artifact-v1', artifact: b.artifact, author: owner.principal, actor: guest.principal, comment: newId() }],
      ['artifact.delete', { format: 'artifact-v1', artifact: b.artifact, author: owner.principal, actor: guest.principal }],
    ] as const) expect((await submit(j, guest, await artifact(j, guest, type, fields as JsonObject))).status).toBe(403);
    expect(await stored(j)).toBe(snapshot);
  });

  it('serializes queued leave and downgrade ahead of edits: leave denies metadata, downgrade preserves metadata not creation', async () => {
    for (const first of ['leave', 'downgrade'] as const) {
      const { owner, j } = await fixture(), p = await createProject(j, owner); const pair = await join(j, owner, p.id);
      const barrier = first === 'leave' ? await project(j, owner, 'project.leave', { project: p.id, member: owner.principal, predecessor: pair }) : await proof(j, owner, 'member.role', { member: owner.principal, role: 'read-only' });
      const pending = { ...j, controls: [...j.controls, barrier] };
      const edit = await project(pending, owner, 'project.state', { project: p.id, predecessor: p.revision, state: 'active' });
      expect(await queued(j, owner, [barrier, edit])).toEqual([201, first === 'leave' ? 403 : 201]);
      const s = await persisted(j); expect(s.lastSeq).toBe(first === 'leave' ? barrier.proof.seq : edit.proof.seq);
      j.controls.push(barrier); if (first === 'downgrade') j.controls.push(edit);
      const before = await stored(j);
      expect((await send(j, owner, await project(j, owner, 'project.create', { project: newId(), purposeHash: await projectPurposeHash('MORE'), state: 'getting-started' }, 'MORE'))).status).toBe(first === 'leave' ? 201 : 403);
      if (first === 'downgrade') expect(await stored(j)).toBe(before);
    }
  });

  it('rejects edits queued behind removal and conflicting placement commits without storing the rejected proof', async () => {
    const { owner, j } = await fixture(), guest = await addPerson(j, owner), p = await createProject(j, owner);
    await join(j, guest, p.id);
    const removal = await proof(j, owner, 'member.remove', { member: guest.principal });
    const queuedEdit = await project({ ...j, controls: [...j.controls, removal] }, guest, 'project.state', { project: p.id, predecessor: p.revision, state: 'active' });
    expect(await queued(j, owner, [removal, queuedEdit], [owner, guest])).toEqual([201, 403]); j.controls.push(removal);
    expect((await persisted(j)).lastSeq).toBe(removal.proof.seq);
    // Removal intentionally makes ordinary content writes pending rotation; use a separate journey.
    const live = await fixture(), a = await createProject(live.j, live.owner), b = await createProject(live.j, live.owner, 'SECOND');
    const fields = await body(live.owner); expect((await submit(live.j, live.owner, await artifact(live.j, live.owner, 'artifact.create', fields))).status).toBe(201);
    const place = await project(live.j, live.owner, 'artifact.project', { artifact: fields.artifact, author: live.owner.principal, actor: live.owner.principal, project: a.id, predecessor: null });
    const stale = await project({ ...live.j, controls: [...live.j.controls, place] }, live.owner, 'artifact.project', { artifact: fields.artifact, author: live.owner.principal, actor: live.owner.principal, project: b.id, predecessor: null });
    expect(await queued(live.j, live.owner, [place, stale])).toEqual([201, 409]);
    expect((await persisted(live.j)).projects.placements[fields.artifact as string].project).toBe(a.id);
    expect((await persisted(live.j)).lastSeq).toBe(place.proof.seq);
  });

  it('rejects queued concurrent revisions and checks live expiry rather than signed entry time', async () => {
    const { owner, j } = await fixture(), p = await createProject(j, owner); await join(j, owner, p.id);
    const a = await project(j, owner, 'project.state', { project: p.id, predecessor: p.revision, state: 'active' });
    const pending = { ...j, controls: [...j.controls, a] };
    const b = await project(pending, owner, 'project.state', { project: p.id, predecessor: p.revision, state: 'archived' });
    expect(await queued(j, owner, [a, b])).toEqual([201, 409]); j.controls.push(a);
    expect((await persisted(j)).projects.items[p.id].revision).toBe(a.proof.seq);
    const agent = await addAgent(j, owner, 'read');
    const expired = await project(j, agent, 'project.state', { project: p.id, predecessor: a.proof.seq, state: 'archived' });
    const before = await stored(j), clock = vi.spyOn(Date, 'now').mockReturnValue(agent.expiresAt + 1);
    try {
      const response = await runInDurableObject(enclaveStub(j.id), async (o) => o.fetch!(new Request('https://internal/', { method: 'POST', body: JSON.stringify({ op: 'controlWrite', journeyId: j.id, control: expired, subject: { principal: agent.principal, agent: true, clientVersion: '0.1.6', controlFormat: 'control-proof-v1', artifactFormat: 'artifact-v1', projectFormat: 'project-v1' } }) })));
      expect(response.status).toBe(403);
    } finally { clock.mockRestore(); }
    expect(await stored(j)).toBe(before);
  });

  it('invalidates removal participation while allowing authorized metadata during pending rotation', async () => {
    const { owner, j } = await fixture(), p = await createProject(j, owner), guest = await addPerson(j, owner);
    await join(j, owner, p.id); await join(j, guest, p.id); const agent = await addAgent(j, guest, 'read');
    expect((await change(j, owner, 'member.remove', { member: guest.principal })).status).toBe(201);
    expect((await persisted(j)).projects.participation.find((p: { member: string }) => p.member === guest.principal).active).toBe(false);
    expect(effectiveProjectParticipants(await state(j), p.id)).toEqual([owner.principal]);
    const before = await stored(j);
    expect((await send(j, agent, await project(j, agent, 'project.state', { project: p.id, predecessor: p.revision, state: 'archived' }))).status).toBe(403);
    expect((await send(j, owner, await project(j, owner, 'project.create', { project: newId(), purposeHash: await projectPurposeHash('ROTATION'), state: 'getting-started' }, 'ROTATION'))).status).toBe(403);
    expect(await stored(j)).toBe(before);
    expect((await change(j, owner, 'member.role', { member: owner.principal, role: 'read-only' })).status).toBe(201);
    expect((await send(j, owner, await project(j, owner, 'project.state', { project: p.id, predecessor: p.revision, state: 'archived' }))).status).toBe(201);
  });

  it('keeps one placement without altering artifact/blob identities and lets nonparticipants read archived artifacts', async () => {
    const { owner, j } = await fixture(), p = await createProject(j, owner), q = await createProject(j, owner, 'OTHER PROJECT'), guest = await addPerson(j, owner);
    const pair = await join(j, owner, p.id), blob = await staged(j, owner); expect((await upload(j, owner, blob)).status).toBe(201);
    const b = await body(owner, [blob]); expect((await submit(j, owner, await artifact(j, owner, 'artifact.create', b, payload([blob])))).status).toBe(201);
    const initial = (await persisted(j)).artifacts, references = await rows(j);
    const placement = (projectId: string | null, predecessor: number | null, extra: JsonObject = {}) => project(j, owner, 'artifact.project', { artifact: b.artifact, author: owner.principal, actor: owner.principal, project: projectId, predecessor, ...extra });
    const first = await placement(p.id, null); expect((await send(j, owner, first)).status).toBe(201);
    const snapshot = await stored(j);
    for (const control of [await placement(q.id, null), await placement(newId(), first.proof.seq), await placement(p.id, first.proof.seq), await placement(q.id, first.proof.seq, { author: guest.principal })]) { expect((await send(j, owner, control)).status).toBe(409); expect(await stored(j)).toBe(snapshot); }
    const foreign = await fixture(), foreignProject = await createProject(foreign.j, foreign.owner);
    expect((await send(j, owner, await placement(foreignProject.id, first.proof.seq))).status).toBe(409);
    const moved = await placement(q.id, first.proof.seq); expect((await send(j, owner, moved)).status).toBe(201);
    expect((await send(j, owner, await placement(null, moved.proof.seq))).status).toBe(201);
    expect((await persisted(j)).artifacts).toEqual(initial); expect(await rows(j)).toEqual(references);
    expect((await send(j, owner, await project(j, owner, 'project.state', { project: p.id, predecessor: p.revision, state: 'archived' }))).status).toBe(201);
    const archivedPlacement = await placement(p.id, j.controls.at(-2)!.proof.seq); // clear placement revision
    expect((await send(j, owner, archivedPlacement)).status).toBe(201);
    for (const route of ['log', 'records', 'wraps/me', 'export', `blobs/${blob.descriptor.id}`]) expect((await request(`/v1/journeys/${j.id}/${route}`, 'GET', undefined, as(guest))).status).toBe(200);
    expect(await bucket().get(bucketKey(j, blob.descriptor.id))).not.toBeNull();
    expect((await send(j, owner, await project(j, owner, 'project.leave', { project: p.id, member: owner.principal, predecessor: pair }))).status).toBe(201);
    expect((await submit(j, owner, await artifact(j, owner, 'artifact.delete', { format: 'artifact-v1', artifact: b.artifact, author: owner.principal, actor: owner.principal }))).status).toBe(201);
    const deleted = await stored(j); expect((await send(j, owner, await placement(q.id, archivedPlacement.proof.seq))).status).toBe(409); expect(await stored(j)).toBe(deleted);
  });

  it('requires the signed project minimum, current epoch and all capabilities on new-journey creation', async () => {
    const old = await legacy(), id = newId();
    const below = await project(old.j, old.owner, 'project.create', { project: id, state: 'getting-started', purposeHash: await projectPurposeHash('BELOW MINIMUM') }, 'BELOW MINIMUM');
    const oldSnapshot = await stored(old.j);
    expect((await send(old.j, old.owner, below)).status).toBe(403); expect(await stored(old.j)).toBe(oldSnapshot);
    const { owner, j } = await fixture();
    const stale = await project(j, owner, 'project.create', { project: newId(), state: 'getting-started', purposeHash: await projectPurposeHash('OLD EPOCH') }, 'OLD EPOCH');
    const before = await stored(j);
    expect((await send(j, owner, { ...stale, envelope: { ...stale.envelope, outside: { ...stale.envelope.outside, epoch: j.key.epoch + 1 } } })).status).toBe(409); expect(await stored(j)).toBe(before);
    const source = await stage0(), genesis = source.j.controls[0]!, target = newId();
    const candidate = { ...source.j, id: target, controls: [] };
    const entry = { v: 1 as const, seq: 0, prev: null, at: new Date().toISOString(), actor: source.owner.principal, type: 'genesis', body: { ...genesis.proof.body, journey: target, minClientVersion: '0.1.6' } };
    const envelope = await sealControlLabels(entry, { id: newId(), journey: target, seq: 0, epoch: 1, createdAt: entry.at }, candidate.key);
    const control = { envelope, proof: await signControlProof(entry, envelope, target, await importSigningKey(source.owner.signing.privateKey)) };
    const creation = { id: target, name: 'Project journey', creator: { id: source.owner.principal, recipient: source.owner.age.recipient, signingKey: source.owner.signing.publicKey }, control, wraps: await wraps(candidate, [{ id: source.owner.principal, recipient: source.owner.age.recipient }]), recoveryWrap: (await wraps(candidate, [{ id: 'recovery', recipient: source.owner.age.recipient }]))[0]!.wrap, minClientVersion: '0.1.6' };
    const incompatible: Record<string, string>[] = [{ 'X-Client-Version': '0.1.5' }, { 'X-Project-Format': '' }, { 'X-Artifact-Format': '' }, { 'X-Control-Format': '' }];
    for (const headers of incompatible) expect((await request('/v1/journeys', 'POST', creation, { ...as(source.owner), ...headers })).status).toBe(426);
    expect((await request('/v1/journeys', 'POST', creation, as(source.owner))).status).toBe(201);
  });

  it('gates every content path and resulting minimum before returning content; negotiation stays content-free', async () => {
    const { owner, j } = await legacy();
    const raise = await proof(j, owner, 'client.minVersion', { version: '0.1.6' }); const before = await stored(j);
    expect((await request(`/v1/journeys/${j.id}/log`, 'POST', { control: raise }, { ...as(owner), 'X-Project-Format': '' })).status).toBe(426); expect(await stored(j)).toBe(before);
    expect((await submit(j, owner, raise)).status).toBe(201);
    const p = await createProject(j, owner), blob = await staged(j, owner);
    const incompatible: Record<string, string>[] = [{ 'X-Client-Version': '0.1.5' }, { 'X-Client-Version': '0.1.3' }, { 'X-Client-Version': 'garbage' }, { 'X-Client-Version': '' }, { 'X-Project-Format': '' }, { 'X-Artifact-Format': '' }, { 'X-Control-Format': '' }];
    for (const headers of incompatible) {
      const baseline = await stored(j);
      for (const route of ['log', 'records', 'wraps/me', 'export', `blobs/${blob.descriptor.id}`]) expect((await request(`/v1/journeys/${j.id}/${route}`, 'GET', undefined, { ...as(owner), ...headers })).status).toBe(426);
      expect((await request('/v1/journeys', 'GET', undefined, { ...as(owner), ...headers })).status).toBe(426);
      expect((await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, { ...as(owner), ...headers })).status).toBe(426);
      expect((await request(`/v1/journeys/${j.id}/blobs`, 'POST', { size: 1 }, { ...as(owner), ...headers })).status).toBe(426);
      expect((await upload(j, owner, blob, blob.ciphertext, headers)).status).toBe(426);
      expect((await send(j, owner, await project(j, owner, 'project.join', { project: p.id, member: owner.principal, predecessor: null }), headers)).status).toBe(426);
      const protocol = await request(`/v1/journeys/${j.id}/protocol`, 'GET', undefined, { ...as(owner), ...headers }); expect(protocol.status).toBe(200);
      expect(await protocol.json()).toEqual({ minClientVersion: '0.1.6', controlFormat: 'control-proof-v1', artifactFormat: 'artifact-v1', projectFormat: 'project-v1' });
      expect(await stored(j)).toBe(baseline);
    }
  });

  it('cancels a denied request stream before responding and does not store denied bytes', async () => {
    const { owner, j } = await fixture(), blob = await staged(j, owner); expect((await change(j, owner, 'member.role', { member: owner.principal, role: 'read-only' })).status).toBe(201);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const result = await runInDurableObject(enclaveStub(j.id), async (_o, s) => {
      const accountHash = String(s.storage.sql.exec('SELECT accountHash FROM principals WHERE id=?', owner.principal).one().accountHash);
      return new EnclaveObject(s, env as unknown as Env).fetch(new Request('https://internal/blob', { method: 'PUT', body: stream, headers: { 'x-blob-message': JSON.stringify({ op: 'blobUpload', journeyId: j.id, descriptor: blob.descriptor, subject: { principal: owner.principal, accountHash, clientVersion: '0.1.6', controlFormat: 'control-proof-v1', artifactFormat: 'artifact-v1', projectFormat: 'project-v1' } }) } }));
    });
    expect(result.status).toBe(403); expect(cancelled).toBe(true); expect(await bucket().get(bucketKey(j, blob.descriptor.id))).toBeNull(); expect((await rows(j))[0]!.complete).toBe(0);
  });
});
