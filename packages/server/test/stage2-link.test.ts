import { describe, expect, it, vi } from 'vitest';
import { newId, newLinkSecret, linkLookupHash, sealLinkIdentity, seal, projectPurposeHash, verifyArtifactArchive, selectProjectArtifacts, exportArtifactJourney, importArtifactJourney, openBlob, type ArtifactArchive } from '@ai-wayfinding/core';
import { PAGE_LIMIT } from '../src/agentLink.js';
import { fixture, createProject, project, send, addAgent, addPerson, as, request, artifact, body, payload, submit, staged, upload, change, proof, stored } from './stage2-fixtures.js';

async function linked() {
  const { owner, j } = await fixture(), agent = await addAgent(j, owner, 'read', true), secret = newLinkSecret();
  expect((await request(`/v1/journeys/${j.id}/agent-links`, 'POST', { sessionId: agent.id, hash: await linkLookupHash(secret), blob: await sealLinkIdentity(secret, agent.age.identity, j.id, agent.principal) }, as(owner))).status).toBe(201);
  return { owner, j, agent, secret };
}
interface LinkPage {
  selection: string;
  access: { scope: string };
  howToWrite: string;
  page: { number: number; next: string | null };
  projects: { id: string; purpose?: string; participants: { id: string }[] }[];
  items: { id: string; body: string }[];
}
async function pages(secret: string, selector?: string) {
  let url = `/a/${secret}${selector === undefined ? '' : `?project=${selector}`}`, raw = '', entries: LinkPage[] = [];
  const visited = new Set<string>();
  for (;;) {
    expect(visited.has(url)).toBe(false); visited.add(url);
    const response = await request(url); expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-transform');
    const text = await response.text(); expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(12_000);
    const data: LinkPage = JSON.parse(text); entries.push(data); raw += text;
    expect(data.selection).toBe(selector ?? 'main');
    expect(data.access.scope).toBe('read'); expect(data.howToWrite).toContain('read-only');
    if (!data.page.next) break;
    const next = new URL(data.page.next); expect(next.searchParams.get('project')).toBe(selector ?? null);
    expect(Number(next.searchParams.get('page'))).toBe(data.page.number + 1);
    url = next.pathname + next.search;
  }
  return { raw, entries };
}

describe('Stage 2 read-only verified project link pages', () => {
  it('selects main/project/all without project membership or recovery/download/mutation routes', async () => {
    const { owner, j, secret } = await linked(), p = await createProject(j, owner), guest = await addPerson(j, owner);
    const join = await project(j, owner, 'project.join', { project: p.id, member: owner.principal, predecessor: null }); expect((await send(j, owner, join)).status).toBe(201);
    const attachment = await staged(j, owner); expect((await upload(j, owner, attachment)).status).toBe(201);
    const main = await body(owner), placed = await body(owner, [attachment]);
    expect((await submit(j, owner, await artifact(j, owner, 'artifact.create', main, { ...payload(), title: 'MAIN ARTIFACT' }))).status).toBe(201);
    expect((await submit(j, owner, await artifact(j, owner, 'artifact.create', placed, { ...payload([attachment]), title: 'PROJECT ARTIFACT' }))).status).toBe(201);
    expect((await send(j, owner, await project(j, owner, 'artifact.project', { artifact: placed.artifact, author: owner.principal, actor: owner.principal, project: p.id, predecessor: null }))).status).toBe(201);
    expect((await send(j, owner, await project(j, owner, 'project.state', { project: p.id, predecessor: p.revision, state: 'archived' }))).status).toBe(201);
    const legacySeq = await (await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(owner))).json() as { seq: number; epoch: number };
    const legacyItem = await seal({ type: 'item', typeVersion: 1, body: { id: newId(), authoredBy: 'human', itemType: 'resource', title: 'LEGACY MAIN ITEM', body: 'LEGACY MAIN ITEM', tags: [], author: owner.principal, created: new Date().toISOString() } }, { id: newId(), journey: j.id, epoch: legacySeq.epoch, seq: legacySeq.seq, createdAt: new Date().toISOString() }, j.key);
    expect((await request(`/v1/journeys/${j.id}/records`, 'POST', { envelope: legacyItem }, as(owner))).status).toBe(201);
    const reserved = await (await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(owner))).json() as { seq: number; epoch: number };
    const recovery = await seal({ type: 'item', typeVersion: 1, body: { id: newId(), authoredBy: 'human', itemType: 'recovery', title: 'HIDDEN RECOVERY', body: 'HIDDEN RECOVERY', tags: [], author: owner.principal, created: new Date().toISOString() } }, { id: newId(), journey: j.id, epoch: reserved.epoch, seq: reserved.seq, createdAt: new Date().toISOString() }, j.key);
    expect((await request(`/v1/journeys/${j.id}/records`, 'POST', { envelope: recovery }, as(owner))).status).toBe(201);
    const defaultPage = await pages(secret), mainPage = await pages(secret, 'main'), projectPage = await pages(secret, p.id), allPage = await pages(secret, 'all');
    expect(defaultPage.raw).toContain('MAIN ARTIFACT'); expect(defaultPage.raw).not.toContain('PROJECT ARTIFACT'); expect(mainPage.entries.flatMap(p => p.items).map(p => p.id)).toContain(main.artifact); expect(mainPage.raw).toContain('LEGACY MAIN ITEM');
    expect(projectPage.raw).not.toContain('MAIN ARTIFACT'); expect(projectPage.raw).toContain('PROJECT ARTIFACT'); expect(projectPage.raw).toContain('archived'); expect(projectPage.raw).not.toContain('LEGACY MAIN ITEM');
    expect(allPage.raw).toContain('MAIN ARTIFACT'); expect(allPage.raw).toContain('PROJECT ARTIFACT'); expect(allPage.raw).toContain('LEGACY MAIN ITEM');
    for (const page of [defaultPage, projectPage, allPage]) { expect(page.raw).not.toContain('HIDDEN RECOVERY'); expect(page.raw).not.toContain(attachment.descriptor.digest); expect(page.raw).not.toContain('downloadUrl'); }
    for (const selector of ['bogus', 'not-a-project', 'main,all']) expect((await request(`/a/${secret}?project=${selector}`)).status).toBe(400);
    expect((await request(`/a/${secret}?project=${newId()}`)).status).toBe(404);
    const other = await fixture(), foreign = await createProject(other.j, other.owner); expect((await request(`/a/${secret}?project=${foreign.id}`)).status).toBe(404);
    expect((await request(`/v1/journeys/${j.id}/log`, 'GET', undefined, as(guest))).status).toBe(200);
    // The member export, keyed replay and read-only link must agree on grouping;
    // archive is a label, never a read boundary or a reason to drop live bytes.
    const exported = await request(`/v1/journeys/${j.id}/export`, 'GET', undefined, as(guest));
    expect(exported.status).toBe(200);
    const archive = await exported.json() as ArtifactArchive;
    const trust = { journey: j.id, creator: j.controls[0]!.proof.body.creator as ArtifactArchive['creator'] };
    const verified = await verifyArtifactArchive(archive, [guest.age.identity], trust);
    for (const [selector, page] of [['main', mainPage], [p.id, projectPage], ['all', allPage]] as const) {
      const linkIds = page.entries.flatMap(entry => entry.items.map(item => item.id));
      const artifactIds = selectProjectArtifacts(verified.state, selector);
      expect(linkIds.filter(id => id === main.artifact || id === placed.artifact).sort()).toEqual(artifactIds.sort());
    }
    expect(verified.state.projects!.items[p.id]!.state).toBe('archived');
    expect(verified.state.projects!.participation.some(pair => pair.member === guest.principal)).toBe(false);
    const encrypted = await exportArtifactJourney(archive, [guest.age.recipient], [guest.age.identity], trust);
    const imported = await importArtifactJourney(encrypted, [guest.age.identity], trust);
    expect(imported.archive).toEqual(archive);
    expect(imported.archive.blobs).toHaveLength(1);
    const downloaded = await request(`/v1/journeys/${j.id}/blobs/${attachment.descriptor.id}`, 'GET', undefined, as(guest));
    expect(downloaded.status).toBe(200);
    const ciphertext = new Uint8Array(await downloaded.arrayBuffer());
    expect(Array.from(ciphertext)).toEqual(Array.from(attachment.ciphertext));
    expect(new TextDecoder().decode(await openBlob(ciphertext, attachment.descriptor, j.key))).toBe('SECRET attachment bytes');
    const before = await stored(j);
    for (const suffix of ['', '/log', '/projects', '/search', '/show', `/blobs/${attachment.descriptor.id}`]) {
      const denied = await request(`/a/${secret}${suffix}`, 'POST', { control: await project(j, owner, 'project.join', { project: p.id, member: guest.principal, predecessor: null }) }); expect(denied.status).toBeGreaterThanOrEqual(400); expect(await denied.text()).not.toContain('PROJECT ARTIFACT');
      if (suffix) { const read = await request(`/a/${secret}${suffix}`); expect(await read.text()).not.toContain('PROJECT ARTIFACT'); }
    }
    expect(await stored(j)).toBe(before);
    expect((await submit(j, owner, await artifact(j, owner, 'artifact.delete', { format: 'artifact-v1', artifact: placed.artifact, author: owner.principal, actor: owner.principal }))).status).toBe(201);
    expect((await pages(secret, 'all')).raw).not.toContain('PROJECT ARTIFACT');
  });

  it('continues large Unicode purposes, text and effective rosters under PAGE_LIMIT with unchanged selectors and no plaintext storage', async () => {
    expect(PAGE_LIMIT).toBe(12_000);
    const { owner, j, agent: linkAgent, secret } = await linked(), purpose = '🧭\n\t"\\'.repeat(1100), p = await createProject(j, owner, purpose);
    expect((await send(j, owner, await project(j, owner, 'project.join', { project: p.id, member: owner.principal, predecessor: null }))).status).toBe(201);
    // Large names stress both the overview's people rows and project participant continuations.
    const expected = [owner.principal, linkAgent.principal];
    for (let i = 0; i < 70; i++) {
      const agent = await addAgent(j, owner, 'read'); expected.push(agent.principal);
      expect((await change(j, owner, 'member.rename', { id: agent.principal, name: ('人🧭' + i).repeat(10) })).status).toBe(201);
    }
    const b = await body(owner), text = '💬共同作業\n'.repeat(2800);
    expect((await submit(j, owner, await artifact(j, owner, 'artifact.create', b, { ...payload(), title: 'UNICODE BODY', content: { kind: 'document', markdown: text } }))).status).toBe(201);
    expect((await send(j, owner, await project(j, owner, 'artifact.project', { artifact: b.artifact, author: owner.principal, actor: owner.principal, project: p.id, predecessor: null }))).status).toBe(201);
    for (const selector of ['main', p.id, 'all']) {
      const result = await pages(secret, selector); expect(result.entries.length).toBeGreaterThan(2);
      const projectRows = result.entries.flatMap(p => p.projects).filter(r => r.id === p.id);
      expect(projectRows.filter(r => 'purpose' in r).map(r => r.purpose).join('')).toBe(purpose);
      const roster = projectRows.flatMap(r => r.participants); expect(new Set(roster.map(r => r.id))).toEqual(new Set(expected));
      expect(projectRows.filter(r => r.participants.length).length).toBeGreaterThan(1);
      if (selector !== 'main') expect(result.entries.flatMap(p => p.items).map(p => p.body).join('')).toContain(text);
      expect(result.raw).not.toContain('�');
    }
    expect(await stored(j)).not.toContain(purpose);
  });

  it('keeps current updates, expiry, renewal, revocation and unsupported-server errors content-free', async () => {
    const { owner, j, agent, secret } = await linked(), p = await createProject(j, owner);
    expect((await send(j, owner, await project(j, owner, 'project.join', { project: p.id, member: owner.principal, predecessor: null }))).status).toBe(201);
    expect((await send(j, owner, await project(j, owner, 'project.purpose', { project: p.id, predecessor: p.revision, purposeHash: await projectPurposeHash('UPDATED PURPOSE') }, 'UPDATED PURPOSE'))).status).toBe(201);
    expect((await pages(secret, p.id)).raw).toContain('UPDATED PURPOSE');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(agent.expiresAt + 1);
    try { const expired = await request(`/a/${secret}?project=${p.id}`); expect(expired.status).toBe(410); expect(await expired.text()).not.toContain('UPDATED PURPOSE'); } finally { clock.mockRestore(); }
    expect((await change(j, owner, 'member.renew', { id: agent.principal, expiresAt: new Date(Date.now() + 7_200_000).toISOString() })).status).toBe(201);
    expect((await pages(secret, p.id)).raw).toContain('UPDATED PURPOSE');
    const future = await proof(j, owner, 'client.minVersion', { version: '0.1.8' });
    expect((await request(`/v1/journeys/${j.id}/log`, 'POST', { control: future }, { ...as(owner), 'X-Client-Version': '0.1.8' })).status).toBe(201); j.controls.push(future);
    const unavailable = await request(`/a/${secret}?project=all`); expect(unavailable.status).toBe(502); const message = await unavailable.text(); expect(message).toContain('Update the server'); expect(message).not.toContain('UPDATED PURPOSE');
    // A separate current journey exercises revocation independently of the update gate.
    const live = await linked(); expect((await change(live.j, live.owner, 'member.remove', { member: live.agent.principal })).status).toBe(201);
    expect((await request(`/a/${live.secret}?project=all`)).status).toBe(404);
  });
});
