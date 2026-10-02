import { expect, it } from 'vitest';
import { linkLookupHash, newId, newLinkSecret, seal, sealLinkIdentity } from '@ai-wayfinding/core';
import { PAGE_LIMIT } from '../src/agentLink.js';
import { addAgent, artifact, as, body, change, fixture, payload, request, agentHeaders, staged, submit, upload } from './stage1-fixtures.js';

it('keeps the existing paged link overview read-only with artifact text/metadata and no recovery or downloads', async () => {
  const { owner, j } = await fixture(), agent = await addAgent(j, owner, 'read', true);
  const secret = newLinkSecret();
  expect((await request(`/v1/journeys/${j.id}/agent-links`, 'POST', { sessionId: agent.id, hash: await linkLookupHash(secret), blob: await sealLinkIdentity(secret, agent.age.identity, j.id, agent.principal) }, as(owner))).status).toBe(201);
  const attachment = await staged(j, owner);
  expect((await upload(j, owner, attachment)).status).toBe(201);
  const writer = await addAgent(j, owner, 'readwrite');
  const b = await body(owner, [attachment]);
  const text = { ...payload([attachment]), title: 'Paged artifact', content: { kind: 'document', markdown: 'LONG ARTIFACT TEXT '.repeat(1500) } };
  expect((await submit(j, owner, await artifact(j, owner, 'artifact.create', b, { ...text, title: 'Original title', content: { kind: 'document', markdown: 'Superseded text' } }))).status).toBe(201);
  const edit = { ...b, actor: writer.principal, version: newId(), predecessor: b.version };
  const signedEdit = await artifact(j, writer, 'artifact.version', edit, text);
  const editPath = `/v1/journeys/${j.id}/log`, editBody = { control: signedEdit };
  expect((await request(editPath, 'POST', editBody, await agentHeaders(writer, 'POST', editPath, editBody))).status).toBe(201);
  j.controls.push(signedEdit);
  const comment = { format: 'artifact-v1', artifact: b.artifact, author: owner.principal, actor: owner.principal, comment: newId() };
  expect((await submit(j, owner, await artifact(j, owner, 'artifact.comment', comment, { text: 'Whole artifact comment' }))).status).toBe(201);
  const reserved = await (await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(owner))).json() as { seq: number; epoch: number };
  const envelope = await seal({ type: 'item', typeVersion: 1, body: { id: newId(), authoredBy: 'human', itemType: 'recovery', title: 'HIDDEN RECOVERY', body: 'HIDDEN RECOVERY', tags: [], author: owner.principal, created: new Date().toISOString() } }, { id: newId(), journey: j.id, epoch: reserved.epoch, seq: reserved.seq, createdAt: new Date().toISOString() }, j.key);
  expect((await request(`/v1/journeys/${j.id}/records`, 'POST', { envelope }, as(owner))).status).toBe(201);
  let page = 1, all = '', reconstructed = '';
  for (;;) {
    const response = await request(`/a/${secret}?page=${page}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-transform');
    const raw = await response.text(); expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(PAGE_LIMIT);
    const data = JSON.parse(raw);
    expect(data.access.scope).toBe('read'); expect(data.howToWrite).toContain('read-only'); expect(data.attachments).toContain('member interface');
    for (const item of data.items) { expect(item.id).toBe(b.artifact); expect(item.author.kind).toBe('person'); expect(item.writer.kind).toBe('agent'); expect(item.writer.name).toBe('Bot'); expect(item.version).toBe(edit.version); reconstructed += item.body; }
    all += raw;
    if (!data.page.next) break;
    expect(data.page.next).toBe(`https://app.wayfinding.support/a/${secret}?page=${++page}`);
  }
  expect(page).toBeGreaterThan(1); expect(reconstructed).toContain(text.content.markdown);
  expect(reconstructed).toContain('Whole artifact comment'); expect(reconstructed).toContain('SECRET filename.txt');
  expect(all).not.toContain('Superseded text');
  expect(all).not.toContain('HIDDEN RECOVERY'); expect(all).not.toContain(attachment.descriptor.digest);
  for (const suffix of ['search', 'show', `blobs/${attachment.descriptor.id}`]) {
    const response = await request(`/a/${secret}/${suffix}`);
    // Unknown non-API paths can receive the existing SPA fallback, never link data.
    if (response.ok) expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).not.toContain('LONG ARTIFACT TEXT');
  }
  expect((await request(`/a/${secret}`, 'POST', { control: await artifact(j, owner, 'artifact.create', await body(owner)) })).status).not.toBe(201);
  expect((await submit(j, owner, await artifact(j, owner, 'artifact.delete', { format: 'artifact-v1', artifact: b.artifact, author: owner.principal, actor: owner.principal }))).status).toBe(201);
  const hidden = await (await request('/a/' + secret)).text();
  expect(hidden).not.toContain('LONG ARTIFACT TEXT'); expect(hidden).not.toContain('Whole artifact comment');
  expect((await change(j, owner, 'client.minVersion', { version: '0.1.8' }, { 'X-Client-Version': '0.1.8' })).status).toBe(201);
  const incompatible = await request('/a/' + secret); expect(incompatible.status).toBe(502);
  expect(await incompatible.text()).toContain('Update the server');
});
