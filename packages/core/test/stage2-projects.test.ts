import { describe, expect, it } from 'vitest';
import { CLIENT_CAPABILITIES, CLIENT_VERSION, isProjectAction, PROJECT_STATES, canonical, canWriteContent, canReadContent, canEditProject, stage0Rules, effectiveProjectParticipants, newId, projectPurposeHash, projectSelector, selectProjectArtifacts, seal, sealProjectPayload, signControlProof, validateProjectPublic, logDefinitions, supportsProjects, verifyControlProofs } from '../src/index.js';
import type { JsonObject, LogState } from '../src/index.js';
import { artifactFixture, artifactAppend, artifactResult, artifactBody, agent, person } from './stage0-fixture.js';

async function fixture() {
  const f = await artifactFixture('0.1.6'), project = newId();
  const body = { format: 'project-v1', project, purposeHash: await projectPurposeHash('A private purpose 🌱'), state: 'getting-started' };
  await artifactAppend(f, f.guide, 'project.create', body, { purpose: 'A private purpose 🌱' });
  return { f, project, body };
}
async function checked(f: Awaited<ReturnType<typeof artifactFixture>>, keyed = true): Promise<LogState> {
  const result = await artifactResult(f, keyed);
  if (!result.ok) throw Error(result.error.message);
  return result.state;
}
const join = (project: string, member: string, predecessor: number | null = null) => ({ format: 'project-v1', project, member, predecessor });
async function denied(f: Awaited<ReturnType<typeof artifactFixture>>, code?: string) {
  const result = await artifactResult(f);
  expect(result.ok).toBe(false);
  if (!result.ok && code) expect(result.error.code).toBe(code);
  f.controls.pop();
}

describe('signed project-v1 contracts', () => {
  it('rejects unknown project controls even with an empty public body', () => {
    expect(isProjectAction('project.future')).toBe(false);
    expect(validateProjectPublic('project.future', { format: 'project-v1', project: newId(), predecessor: null }).ok).toBe(false);
  });
  it('creates a fixed initial state with empty participation and committed private purpose; old histories are empty', async () => {
    for (const minimum of ['0.1.4', '0.1.5']) {
      const old = await artifactFixture(minimum);
      expect((await checked(old)).projects).toEqual({ items: {}, participation: [], placements: {} });
    }
    const { f, project } = await fixture();
    expect(logDefinitions.some(d => d.name.startsWith('project.'))).toBe(false);
    const s = await checked(f), p = s.projects!.items[project]!;
    expect(p).toMatchObject({ purpose: 'A private purpose 🌱', state: 'getting-started', revision: 1, creator: f.guide.member.id });
    expect(effectiveProjectParticipants(s, project)).toEqual([]);
    expect(canonical(f.controls[1]!.proof)).not.toContain('A private purpose');
    expect((await checked(f, false)).projects!.items[project]!.purpose).toBe('[unavailable]');
    for (const bad of ['', ' x', 'x ', 'x'.repeat(10_001), '🌱'.repeat(2501)]) await expect(projectPurposeHash(bad)).rejects.toThrow();
    expect(await projectPurposeHash('x'.repeat(10_000))).toMatch(/=$/);
  });

  it('rejects unexpected fields, multiple/foreign shapes, unknown states and malformed references before replay', async () => {
    const { f, project, body } = await fixture();
    const invalid: [string, JsonObject][] = [
      ['project.create', { ...body, state: 'active' }], ['project.create', { ...body, purpose: 'smuggled' }],
      ['project.purpose', { format: 'project-v1', project, purposeHash: body.purposeHash, predecessor: -1 }],
      ['project.state', { format: 'project-v1', project, state: 'future', predecessor: 1 }],
      ['project.join', { ...join(project, f.guide.member.id), grants: ['members.manage'] }],
      ['project.leave', { ...join(project, f.guide.member.id), predecessor: 1.5 }],
      ['artifact.project', { format: 'project-v1', project: [project], artifact: newId(), author: f.guide.member.id, actor: f.guide.member.id, predecessor: null }],
      ['project.join', { ...join(project, f.guide.member.id), format: 'future' }], ['project.join', { ...join('foreign', f.guide.member.id) }],
    ];
    for (const [type, b] of invalid) {
      expect(validateProjectPublic(type, b).ok).toBe(false);
      await expect(signControlProof({ v: 1, seq: 2, prev: null, at: '2026-01-02T00:00:00.000Z', actor: f.guide.member.id, type, body: b }, f.controls[1]!.envelope, f.journey, f.guide.key)).rejects.toThrow();
    }
    const envelope = await seal({ type: 'project.marker', typeVersion: 1, body: {} }, { id: newId(), journey: f.journey, seq: 2, epoch: 1, createdAt: '2026-01-02T00:00:00.000Z' }, f.key);
    f.controls.push({ envelope, proof: { ...f.controls[1]!.proof, seq: 2, type: 'project.future' } });
    await denied(f);
  });

  it('enforces self-only live person joins and derives agents without independent participation or content elevation', async () => {
    const { f, project } = await fixture(), p = await person(), a = await agent(p.member.id, 'read');
    await artifactAppend(f, f.guide, 'member.add', { member: p.member, kind: 'person', grants: [] });
    await artifactAppend(f, f.guide, 'member.role', { member: p.member.id, role: 'read-only' });
    await artifactAppend(f, p, 'project.join', join(project, f.guide.member.id), {}); await denied(f, 'unauthorized');
    await artifactAppend(f, p, 'project.join', join(newId(), p.member.id), {}); await denied(f);
    await artifactAppend(f, p, 'project.join', join(project, p.member.id), {});
    const joinedSeq = f.controls.length - 1;
    await artifactAppend(f, p, 'project.join', join(project, p.member.id, joinedSeq), {}); await denied(f);
    await artifactAppend(f, p, 'project.leave', join(project, p.member.id, null), {}); await denied(f);
    await artifactAppend(f, p, 'member.add', { member: a.member, kind: 'agent', grants: [] });
    const s = await checked(f);
    expect(effectiveProjectParticipants(s, project, Date.parse('2026-01-02')).sort()).toEqual([p.member.id, a.member.id].sort());
    expect(canEditProject(s, a.member.id, project)).toBe(true);
    expect(canWriteContent(s, p.member.id)).toBe(false); expect(canWriteContent(s, a.member.id)).toBe(false);
    await artifactAppend(f, a, 'project.join', join(project, a.member.id), {}); await denied(f, 'unauthorized');
    await artifactAppend(f, a, 'project.leave', join(project, p.member.id, joinedSeq), {}); await denied(f, 'unauthorized');
    await artifactAppend(f, f.guide, 'project.state', { format: 'project-v1', project, state: 'active', predecessor: 1 }, {}); await denied(f, 'unauthorized');
    await artifactAppend(f, a, 'project.state', { format: 'project-v1', project, state: 'archived', predecessor: 1 }, {});
    expect((await checked(f)).projects!.items[project]!.state).toBe('archived');
    await artifactAppend(f, p, 'project.create', { format: 'project-v1', project: newId(), purposeHash: await projectPurposeHash('No'), state: 'getting-started' }, { purpose: 'No' }); await denied(f, 'unauthorized');
    await artifactAppend(f, a, 'artifact.create', await artifactBody(a.member.id)); await denied(f, 'unauthorized');
    await artifactAppend(f, p, 'project.leave', join(project, p.member.id, joinedSeq), {});
    expect(effectiveProjectParticipants(await checked(f), project)).toEqual([]);
    await artifactAppend(f, a, 'project.purpose', { format: 'project-v1', project, purposeHash: await projectPurposeHash('No'), predecessor: 6 }, { purpose: 'No' }); await denied(f, 'unauthorized');
  });

  it('invalidates removal participation so readmission does not resurrect pairs; expiry and agent limits are live', async () => {
    const { f, project } = await fixture(), p = await person(), a = await agent(p.member.id);
    await artifactAppend(f, f.guide, 'member.add', { member: p.member, kind: 'person', grants: [] });
    await artifactAppend(f, p, 'project.join', join(project, p.member.id), {});
    await artifactAppend(f, p, 'member.add', { member: a.member, kind: 'agent', grants: [] });
    const before = await checked(f);
    before.members[p.member.id]!.member.expiresAt = '2026-01-03T00:00:00.000Z';
    expect(effectiveProjectParticipants(before, project, Date.parse('2026-01-03'))).toEqual([]);
    before.members[p.member.id]!.member.expiresAt = undefined;
    before.members[a.member.id]!.member.expiresAt = '2026-01-03T00:00:00.000Z';
    expect(effectiveProjectParticipants(before, project, Date.parse('2026-01-03'))).toEqual([p.member.id]);
    await artifactAppend(f, f.guide, 'member.remove', { member: p.member.id });
    const removedSeq = f.controls.length - 1;
    expect((await checked(f)).projects!.participation).toEqual([{ project, member: p.member.id, revision: removedSeq, active: false }]);
    await artifactAppend(f, f.guide, 'member.add', { member: p.member, kind: 'person', grants: [] });
    expect(effectiveProjectParticipants(await checked(f), project)).toEqual([]);
    // Pending key rotation blocks content, not explicit rejoin or D17 metadata.
    await artifactAppend(f, p, 'project.join', join(project, p.member.id, removedSeq), {});
    const rejoined = await checked(f);
    expect(canWriteContent(rejoined, p.member.id)).toBe(false);
    await artifactAppend(f, p, 'project.state', { format: 'project-v1', project, predecessor: 1, state: 'active' }, {});
    expect((await checked(f)).projects!.items[project]!.state).toBe('active');
    await artifactAppend(f, p, 'project.create', { format: 'project-v1', project: newId(), state: 'getting-started', purposeHash: await projectPurposeHash('Pending') }, { purpose: 'Pending' }); await denied(f, 'unauthorized');
  });

  it('never elevates D17 to edit, comment, delete, placement or blob staging, including during rotation', async () => {
    const { f, project } = await fixture(), p = await person(), a = await agent(p.member.id, 'readwrite');
    const b = await artifactBody(f.guide.member.id);
    await artifactAppend(f, f.guide, 'artifact.create', b);
    await artifactAppend(f, f.guide, 'member.add', { member: p.member, kind: 'person', grants: [] });
    await artifactAppend(f, p, 'project.join', join(project, p.member.id), {});
    await artifactAppend(f, p, 'member.add', { member: a.member, kind: 'agent', grants: [] });
    await artifactAppend(f, f.guide, 'member.role', { member: p.member.id, role: 'read-only' });
    const snapshot = await checked(f);
    expect(canEditProject(snapshot, a.member.id, project)).toBe(true);
    for (const actor of [p, a]) {
      const common = { format: 'artifact-v1', artifact: b.artifact, author: f.guide.member.id, actor: actor.member.id };
      const attempts: [string, JsonObject, JsonObject | undefined][] = [
        ['artifact.version', { ...common, version: newId(), predecessor: b.version, typeHash: b.typeHash, blobs: [] }, undefined],
        ['artifact.comment', { ...common, comment: newId() }, { text: 'No elevation' }],
        ['artifact.delete', common, {}],
        ['artifact.project', { ...common, format: 'project-v1', project, predecessor: null }, {}],
      ];
      for (const [type, body, payload] of attempts) {
        await artifactAppend(f, actor, type, body, payload); await denied(f, 'unauthorized');
        expect((await checked(f)).artifacts).toEqual(snapshot.artifacts);
      }
    }
    expect(stage0Rules.blob_stage({ $: 'Some', value: { $: 'ReadOnly' } }, true, true, false, 1n, 1n)).toBe(false);
    // A removed unrelated person starts rotation, without changing the participant's read-write role.
    const other = await person();
    await artifactAppend(f, f.guide, 'member.role', { member: p.member.id, role: 'read-write' });
    await artifactAppend(f, f.guide, 'member.add', { member: other.member, kind: 'person', grants: [] });
    await artifactAppend(f, f.guide, 'member.remove', { member: other.member.id });
    await artifactAppend(f, a, 'project.state', { format: 'project-v1', project, state: 'active', predecessor: 1 }, {});
    expect((await checked(f)).projects!.items[project]!.state).toBe('active');
    await artifactAppend(f, p, 'artifact.project', { format: 'project-v1', project, artifact: b.artifact, author: f.guide.member.id, actor: p.member.id, predecessor: null }, {}); await denied(f, 'unauthorized');
    expect(stage0Rules.blob_stage({ $: 'Some', value: { $: 'ReadWrite' } }, true, true, true, 1n, 1n)).toBe(false);
  });

  it('checks signed entry-time expiry of the participant and adding person', async () => {
    for (const expiredOwner of [false, true]) {
      const { f, project } = await fixture(), p = await person(), a = await agent(p.member.id);
      if (expiredOwner) p.member.expiresAt = '2026-01-03T00:00:00.000Z';
      else a.member.expiresAt = '2026-01-03T00:00:00.000Z';
      await artifactAppend(f, f.guide, 'member.add', { member: p.member, kind: 'person', grants: [] });
      await artifactAppend(f, p, 'project.join', join(project, p.member.id), {});
      await artifactAppend(f, p, 'member.add', { member: a.member, kind: 'agent', grants: [] });
      await artifactAppend(f, a, 'project.state', { format: 'project-v1', project, state: 'active', predecessor: 1 }, {}, '2026-01-03T00:00:00.000Z');
      await denied(f, 'unauthorized');
      if (expiredOwner) {
        await artifactAppend(f, p, 'project.leave', join(project, p.member.id, 3), {}, '2026-01-03T00:00:00.000Z');
        await denied(f, 'unauthorized');
      }
    }
  });

  it('shares only metadata revisions, records every state transition including archive/reopening and remains readable', async () => {
    const { f, project } = await fixture();
    await artifactAppend(f, f.guide, 'project.join', join(project, f.guide.member.id), {});
    expect((await checked(f)).projects!.items[project]!.revision).toBe(1);
    let predecessor = 1;
    for (const state of ['active', 'archived', 'looking-for-others', 'getting-started', 'archived', 'active'] as const) {
      await artifactAppend(f, f.guide, 'project.state', { format: 'project-v1', project, state, predecessor }, {});
      predecessor = f.controls.length - 1;
      const s = await checked(f);
      expect(s.projects!.items[project]!.state).toBe(state); expect(canReadContent(s, f.guide.member.id)).toBe(true);
      await artifactAppend(f, f.guide, 'project.state', { format: 'project-v1', project, state, predecessor }, {}); await denied(f);
    }
    await artifactAppend(f, f.guide, 'project.state', { format: 'project-v1', project, state: 'looking-for-others', predecessor: 1 }, {}); await denied(f);
    await artifactAppend(f, f.guide, 'project.purpose', { format: 'project-v1', project, purposeHash: await projectPurposeHash('Updated'), predecessor: 1 }, { purpose: 'Updated' }); await denied(f);
    await artifactAppend(f, f.guide, 'project.purpose', { format: 'project-v1', project, purposeHash: await projectPurposeHash('Updated'), predecessor }, { purpose: 'Updated' });
    expect((await checked(f)).projects!.items[project]!.history).toHaveLength(8);
    expect((await checked(f)).projects!.items[project]!.history[2]).toMatchObject({ from: 'active', to: 'archived', actor: f.guide.member.id });
    expect(PROJECT_STATES).toEqual(['getting-started', 'active', 'looking-for-others', 'archived']);
  });

  it('keeps one same-journey placement, intersections, attribution, content/blob identity and archived nonparticipant reads', async () => {
    const { f, project } = await fixture(), b = await artifactBody(f.guide.member.id);
    await artifactAppend(f, f.guide, 'artifact.create', b);
    const id = b.artifact as string, content = structuredClone((await checked(f)).artifacts);
    const pointer = { format: 'project-v1', artifact: id, project, author: f.guide.member.id, actor: f.guide.member.id, predecessor: null };
    await artifactAppend(f, f.guide, 'artifact.project', pointer, {});
    const revision = f.controls.length - 1;
    let s = await checked(f);
    expect(s.artifacts).toEqual(content); expect(selectProjectArtifacts(s)).toEqual([]);
    expect(s.projects!.placements[id]!.history).toEqual([{ seq: revision, actor: f.guide.member.id, at: '2026-01-02T00:00:00.000Z', from: null, to: project }]);
    expect(selectProjectArtifacts(s, project)).toEqual([id]); expect(selectProjectArtifacts(s, 'all')).toEqual([id]);
    expect(selectProjectArtifacts(s, project).filter(v => v !== id)).toEqual([]);
    expect(canReadContent(s, f.guide.member.id)).toBe(true); expect(effectiveProjectParticipants(s, project)).toEqual([]);
    for (const mutation of [{ predecessor: null, project: null }, { predecessor: revision, project }, { predecessor: revision, project: newId() }, { predecessor: revision, author: newId(), project: null }, { predecessor: revision, actor: newId(), project: null }]) {
      await artifactAppend(f, f.guide, 'artifact.project', { ...pointer, ...mutation }, {}); await denied(f);
      expect((await checked(f)).projects!.placements[id]!.project).toBe(project);
    }
    await artifactAppend(f, f.guide, 'artifact.project', { ...pointer, project: null, predecessor: revision }, {});
    s = await checked(f); expect(selectProjectArtifacts(s, 'main')).toEqual([id]); expect(selectProjectArtifacts(s, project)).toEqual([]);
    expect(s.projects!.placements[id]!.history.at(-1)).toMatchObject({ from: project, to: null });
    expect(() => selectProjectArtifacts(s, newId())).toThrow('Unknown project');
    for (const bad of [null, [], {}, 'missing']) expect(() => projectSelector(bad)).toThrow('Invalid');
    await artifactAppend(f, f.guide, 'artifact.delete', { format: 'artifact-v1', artifact: id, author: f.guide.member.id, actor: f.guide.member.id }, {});
    expect(selectProjectArtifacts(await checked(f), 'all')).toEqual([]);
    await artifactAppend(f, f.guide, 'artifact.project', { ...pointer, predecessor: 4 }, {}); await denied(f);
    // No content identifier (including versions/comments) may collide with a project.
    await artifactAppend(f, f.guide, 'artifact.create', await artifactBody(f.guide.member.id, { artifact: project })); await denied(f);
    await artifactAppend(f, f.guide, 'project.create', { format: 'project-v1', project: id, purposeHash: await projectPurposeHash('Collision'), state: 'getting-started' }, { purpose: 'Collision' }); await denied(f);
  });

  it('fails closed on signatures, references, ciphertext commitments, payload authority and missing keyed epochs without partial state', async () => {
    const { f, project, body } = await fixture();
    for (const mutate of [
      (c: typeof f.controls) => { c[1]!.proof.sig = 'AAAA'; },
      (c: typeof f.controls) => { c[1]!.proof.body.project = newId(); },
      (c: typeof f.controls) => { c[1]!.proof.prev = null; },
      (c: typeof f.controls) => { c[1]!.envelope.ciphertext = c[0]!.envelope.ciphertext; },
      (c: typeof f.controls) => { Object.assign(c[1]!.proof.body, { purpose: 'never-return' }); },
    ]) {
      const c = structuredClone(f.controls); mutate(c);
      const result = await verifyControlProofs(c.map(v => v.proof), c.map(v => v.envelope), f.trust, [f.key]);
      expect(result.ok).toBe(false); expect(result).not.toHaveProperty('state');
    }
    for (const payload of [{ purpose: 'Wrong hash' }, { purpose: 'A private purpose 🌱', grants: ['members.manage'] }, { purpose: 'A private purpose 🌱', project: newId() }]) {
      const envelope = await seal({ type: 'project.content', typeVersion: 1, body: payload }, f.controls[1]!.envelope.outside, f.key);
      const entry = { v: 1 as const, seq: 1, prev: f.controls[1]!.proof.prev, at: f.controls[1]!.proof.at, actor: f.guide.member.id, type: 'project.create', body };
      const proof = await signControlProof(entry, envelope, f.journey, f.guide.key);
      const result = await verifyControlProofs([f.controls[0]!.proof, proof], [f.controls[0]!.envelope, envelope], f.trust, [f.key]);
      expect(result.ok).toBe(false); expect(result).not.toHaveProperty('state');
    }
    await expect(sealProjectPayload('project.state', { format: 'project-v1', project, state: 'active', predecessor: 1 }, { actor: f.guide.member.id }, f.controls[1]!.envelope.outside, f.key)).rejects.toThrow('marker');
    const missing = await artifactResult({ ...f, key: { epoch: 2, key: f.key.key } });
    expect(missing.ok).toBe(false); expect(missing).not.toHaveProperty('state');
  });

  it('requires a signed Stage 2 barrier and all capabilities, while 0.1.5 remains supported for old histories', async () => {
    expect(CLIENT_VERSION).toBe('0.1.6'); expect(CLIENT_CAPABILITIES).toContain('project-v1');
    for (const version of ['0.1.3', '0.1.5', '', 'bad']) expect(supportsProjects(version, '0.1.6', CLIENT_CAPABILITIES)).toBe(false);
    expect(supportsProjects('0.1.6', '0.1.6', CLIENT_CAPABILITIES)).toBe(true);
    expect(supportsProjects('0.1.6', '0.1.7', CLIENT_CAPABILITIES)).toBe(false);
    for (const cap of CLIENT_CAPABILITIES) expect(supportsProjects('0.1.6', '0.1.6', CLIENT_CAPABILITIES.filter(v => v !== cap))).toBe(false);
    const { f, body } = await fixture();
    const old = await artifactFixture('0.1.5');
    await artifactAppend(old, old.guide, 'project.create', body, { purpose: 'A private purpose 🌱' }); await denied(old, 'unauthorized');
    await artifactAppend(old, old.guide, 'client.minVersion', { version: '0.1.6' });
    await artifactAppend(old, old.guide, 'project.create', body, { purpose: 'A private purpose 🌱' }); expect((await checked(old)).projects!.items).toHaveProperty(body.project);
    await artifactAppend(f, f.guide, 'client.minVersion', { version: '0.1.7' });
    const unsupported = await artifactResult(f);
    expect(unsupported.ok).toBe(false); expect(unsupported).not.toHaveProperty('state');
    // Existing nonproject readers need the signed minimum to display their update message.
    const legacy = await artifactFixture('0.1.5');
    await artifactAppend(legacy, legacy.guide, 'client.minVersion', { version: '0.1.7' });
    expect((await checked(legacy)).minClientVersion).toBe('0.1.7');
  });
});
