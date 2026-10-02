import { expect, test, type Page } from '@playwright/test';
import { artifactTypeHash, createAgeIdentity, effectiveProjectParticipants, importArtifactJourney, newId, projectPurposeHash, type Member } from '@ai-wayfinding/core';
import { browserPerson, signUp } from './person.js';
import { requestAgent } from './agent.js';
import { change, controls, createTrip, downloadBytes, headers, joinTrip, personSecrets, principal } from './stage1-fixtures.js';
import { attempt, createProjectReload, participateReload, placeReload, purposeHistory, stateReload, stored } from './stage2-fixtures.js';

async function artifact(page: Page, path: string, title: string, type = 'document', attachment = false) {
  await page.goto(path + '/add'); await page.getByLabel('Type', { exact: true }).selectOption(type);
  await page.getByLabel('Title', { exact: true }).fill(title); await page.locator('#artifact-body').fill('Safe **local** text');
  await page.getByLabel('Tags (comma-separated)').fill('decision, ProjectTag');
  if (attachment) await page.getByLabel('Add attachments').setInputFiles({ name: 'project.txt', mimeType: 'text/plain', buffer: Buffer.from('Project attachment bytes') });
  await page.getByRole('button', { name: 'Save artifact', exact: true }).click();
  await expect(page).toHaveURL(/\/artifacts\/[0-9A-Z]+$/); await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  return new URL(page.url()).pathname;
}
async function purpose(page: Page, text: string) {
  await page.getByLabel('Purpose', { exact: true }).fill(text); await page.getByRole('button', { name: 'Save purpose' }).click();
  await expect(page.locator('#project-purpose-text')).toHaveText(text); await page.reload();
  await expect(page.locator('#project-purpose-text')).toHaveText(text);
}

test('stored projects: explicit participation, inherited new agents, read-only metadata, archive/reopen and nonparticipant reads', async ({ browser, request }) => {
  test.setTimeout(300_000);
  const owner = await browserPerson(browser), guest = await browserPerson(browser);
  try {
    await signUp(owner.page, `projects-owner-${Date.now()}@example.org`); await signUp(guest.page, `projects-guest-${Date.now()}@example.org`);
    const trip = await createTrip(owner.page, 'Projects journey');
    const filePath = await artifact(owner.page, trip.path, 'Project document', 'document', true);
    const hostile = '</textarea><script>window.__projectExecuted=true</script><img src="https://example.org/project-fetch">';
    const project = await createProjectReload(owner.page, trip.path, hostile);
    await expect(owner.page.locator('#project-state')).toContainText('getting started');
    await expect(owner.page.locator('#project-participants')).toHaveText('No participants.');
    await expect(owner.page.getByRole('button', { name: 'Save purpose' })).toHaveCount(0); // Even a creator/guide must join.
    await expect(owner.page.locator('main script, main img')).toHaveCount(0);
    expect(await owner.page.evaluate(() => Object.hasOwn(window, '__projectExecuted'))).toBe(false);
    await participateReload(owner.page, 'Join');
    await expect(owner.page.getByLabel('Purpose', { exact: true })).toHaveValue(hostile);
    await expect(owner.page.locator('main script, main img')).toHaveCount(0);
    await placeReload(owner.page, filePath, project.id);
    await joinTrip(owner.page, guest.page, trip.path); const guestId = await principal(guest.page, trip.id);
    await change(owner.page, trip.id, 'member.role', { member: guestId, role: 'read-only' });
    await owner.page.reload(); await guest.page.goto(project.path); await guest.page.reload();
    await expect(guest.page.getByRole('button', { name: 'Save purpose' })).toHaveCount(0);
    await expect(guest.page.locator('#project-artifacts')).toContainText('Project document');
    const nonparticipant = await stored(guest.page, trip.id), unchanged = nonparticipant.rows.length;
    const deniedPurpose = await attempt(guest.page, trip.id, 'project.purpose', { format: 'project-v1', project: project.id, purposeHash: await projectPurposeHash('Forbidden purpose'), predecessor: nonparticipant.state.projects!.items[project.id]!.revision }, { purpose: 'Forbidden purpose' });
    expect(deniedPurpose.status()).toBe(403);
    const otherPerson = await attempt(guest.page, trip.id, 'project.join', { format: 'project-v1', project: project.id, member: nonparticipant.state.projects!.items[project.id]!.creator, predecessor: nonparticipant.state.projects!.participation.find(p => p.project === project.id && p.member !== guestId)!.revision });
    expect(otherPerson.status()).toBe(403); expect((await controls(owner.page, trip.id)).length).toBe(unchanged);
    await guest.page.reload(); await expect(guest.page.locator('#project-purpose-text')).toHaveText(hostile);
    // D17 must not grant ordinary content writes, even after explicit participation.
    await participateReload(guest.page, 'Join'); await purpose(guest.page, 'Read-only participant purpose');
    for (const state of ['active', 'looking-for-others', 'archived', 'getting-started']) await stateReload(guest.page, state);
    await expect(guest.page.locator('#project-history')).toContainText('archived → getting started');
    await expect(guest.page.locator('#project-history')).toContainText(guestId);
    const agent = await requestAgent(request, trip.id, 'Following agent');
    await guest.page.goto(new URL(agent.approvalUrl).pathname); await guest.page.getByLabel('Six-digit code').fill(agent.code);
    await guest.page.getByLabel('Access', { exact: true }).selectOption('read'); await guest.page.getByRole('button', { name: 'Confirm with passkey' }).click();
    await expect(guest.page.getByRole('heading', { name: 'Agent approved' })).toBeVisible();
    await guest.page.goto(project.path); await guest.page.reload();
    await expect(guest.page.locator('#project-participants')).toContainText('Following agent');
    await expect(guest.page.locator('#project-participants')).toContainText('inherited participation');
    expect(effectiveProjectParticipants((await stored(owner.page, trip.id)).state, project.id)).toContain(agent.principal);
    await participateReload(guest.page, 'Leave'); await expect(guest.page.locator('#project-participants')).not.toContainText(agent.principal);
    await participateReload(guest.page, 'Join'); await expect(guest.page.locator('#project-participants')).toContainText(agent.principal);
    await guest.page.goto(filePath); await guest.page.reload();
    await expect(guest.page.getByRole('link', { name: 'Edit artifact' })).toHaveCount(0);
    await expect(guest.page.getByLabel('Add a comment')).toHaveCount(0); await expect(guest.page.getByRole('button', { name: 'Save placement' })).toHaveCount(0);
    const before = (await controls(owner.page, trip.id)).length, artifactId = filePath.split('/').at(-1)!;
    const original = (await stored(guest.page, trip.id)).state.artifacts!.items[artifactId]!;
    const placement = (await stored(guest.page, trip.id)).state.projects!.placements[artifactId]!;
    const common = { format: 'artifact-v1', artifact: artifactId, author: original.author, actor: guestId };
    for (const response of [
      await attempt(guest.page, trip.id, 'project.create', { format: 'project-v1', project: newId(), purposeHash: await projectPurposeHash('Forbidden project'), state: 'getting-started' }, { purpose: 'Forbidden project' }),
      await attempt(guest.page, trip.id, 'artifact.create', { format: 'artifact-v1', artifact: newId(), author: guestId, actor: guestId, version: newId(), typeHash: await artifactTypeHash('document'), blobs: [] }, { title: 'Forbidden artifact', tags: [], attachments: [], content: { kind: 'document', markdown: 'no' } }),
      await attempt(guest.page, trip.id, 'artifact.version', { ...common, version: newId(), predecessor: original.head, typeHash: await artifactTypeHash('document'), blobs: [] }, { title: 'Forbidden edit', tags: [], attachments: [], content: { kind: 'document', markdown: 'no' } }),
      await attempt(guest.page, trip.id, 'artifact.comment', { ...common, comment: newId() }, { text: 'Forbidden comment' }),
      await attempt(guest.page, trip.id, 'artifact.delete', common),
      await attempt(guest.page, trip.id, 'artifact.project', { format: 'project-v1', artifact: artifactId, author: original.author, actor: guestId, project: null, predecessor: placement.revision }),
    ]) expect(response.status(), await response.text()).toBe(403);
    const stage = await guest.page.request.post(`/v1/journeys/${trip.id}/blobs`, { headers: { ...headers, 'X-Principal': guestId, 'X-Wayfinding': '1', Origin: 'http://localhost:18787' }, data: { size: 1 } }); expect(stage.status()).toBe(403);
    expect((await controls(owner.page, trip.id)).length).toBe(before);
    await guest.page.goto(trip.path + '/projects'); await guest.page.reload(); await expect(guest.page.getByRole('button', { name: 'Create project' })).toHaveCount(0);
    await guest.page.goto(project.path); await participateReload(guest.page, 'Leave');
    await guest.page.goto(filePath); const downloading = guest.page.waitForEvent('download');
    await guest.page.getByRole('button', { name: 'Download project.txt', exact: true }).first().click(); expect(await downloadBytes(await downloading)).toEqual(Buffer.from('Project attachment bytes'));
    await expect(guest.page.locator('#artifact-viewer strong')).toHaveText('local');
    await owner.page.goto(project.path); await stateReload(owner.page, 'archived');
    await guest.page.goto(project.path); await guest.page.reload(); await expect(guest.page.locator('#project-artifacts')).toContainText('Project document');
    await guest.page.goto(trip.path + '/projects'); await guest.page.reload(); await expect(guest.page.locator('#projects')).toContainText('archived');
    await guest.page.goto(trip.path); await guest.page.getByLabel('Artifact list').selectOption(project.id); await guest.page.reload(); await expect(guest.page.locator('#artifacts')).toContainText('Project document');
    await guest.page.getByLabel('Artifact list').selectOption('all'); await guest.page.reload(); await expect(guest.page.locator('#artifacts')).toContainText('Project document');
    const secrets = await personSecrets(guest.page), recovery = await createAgeIdentity();
    await guest.page.goto(trip.path + '/export'); await guest.page.getByLabel('Recovery recipient').fill(recovery.recipient);
    const exporting = guest.page.waitForEvent('download'); await guest.page.getByRole('button', { name: 'Download encrypted export' }).click();
    const bytes = await downloadBytes(await exporting), rows = await controls(owner.page, trip.id);
    const archive = await importArtifactJourney(bytes.toString(), [secrets.identity], { journey: trip.id, creator: rows[0]!.proof.body.creator as Member });
    expect(archive.state.projects!.items[project.id]!.state).toBe('archived'); expect(archive.archive.blobs).toHaveLength(1);
    expect(archive.state.projects!.placements[artifactId]!.project).toBe(project.id);
    // Removing a participating person immediately removes their derived agents and invalidates the pair.
    await guest.page.goto(project.path); await participateReload(guest.page, 'Join');
    await change(owner.page, trip.id, 'member.remove', { member: guestId }); await owner.page.goto(project.path); await owner.page.reload();
    await expect(owner.page.locator('#project-participants')).not.toContainText(guestId); await expect(owner.page.locator('#project-participants')).not.toContainText(agent.principal);
    await guest.page.goto(project.path); await expect(guest.page.getByRole('heading', { name: 'Journey unavailable' })).toBeVisible();
    await joinTrip(owner.page, guest.page, trip.path); await owner.page.reload();
    await guest.page.goto(project.path); await guest.page.reload();
    await expect(guest.page.getByRole('button', { name: 'Join project', exact: true })).toBeVisible();
    await expect(guest.page.getByRole('button', { name: 'Save purpose' })).toHaveCount(0);
    await participateReload(guest.page, 'Join'); await owner.page.goto(project.path); await owner.page.reload();
    const final = await stored(owner.page, trip.id); expect(final.state.projects!.participation.find(p => p.project === project.id && p.member === guestId)?.active).toBe(false);
    expect(final.rows.filter(c => c.proof.type.startsWith('project.')).every(c => !JSON.stringify(c.proof).includes('Read-only participant purpose') && !JSON.stringify(c.proof).includes(hostile))).toBe(true);
    await expect(owner.page.locator('header .brand')).toHaveText('AI Wayfinding Journeys');
    await expect(owner.page.locator('footer')).toContainText('Wayfinding is how you move when the destination is uncertain.');
    expect(owner.requests.concat(guest.requests).every(url => new URL(url).hostname === 'localhost')).toBe(true);
  } finally { await owner.context.close(); await guest.context.close(); }
});

test('placement assign/move/clear, selector intersection, loaded revisions, rotation distinctions and whole-view errors', async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await browserPerson(browser), guest = await browserPerson(browser);
  try {
    await signUp(owner.page, `projects-filter-${Date.now()}@example.org`); await signUp(guest.page, `projects-filter-guest-${Date.now()}@example.org`);
    const trip = await createTrip(owner.page, 'Placement journey');
    const doc = await artifact(owner.page, trip.path, 'Grouped document'); await artifact(owner.page, trip.path, 'Main prompt', 'prompt');
    const one = await createProjectReload(owner.page, trip.path, 'First project'), two = await createProjectReload(owner.page, trip.path, 'Empty project');
    await expect(owner.page.locator('#project-participants')).toHaveText('No participants.');
    await expect(owner.page.locator('#project-artifacts')).toHaveText('No artifacts in this project.');
    await owner.page.goto(trip.path + '/projects'); await owner.page.reload(); await expect(owner.page.locator('#projects li')).toHaveCount(2);
    await owner.page.goto(one.path); await participateReload(owner.page, 'Join');
    await placeReload(owner.page, doc, one.id); await owner.page.goto(trip.path); await owner.page.reload();
    await expect(owner.page.getByLabel('Artifact list')).toHaveValue('main'); await expect(owner.page.locator('#artifacts .card')).toHaveCount(1);
    await expect(owner.page.locator('#artifacts')).toContainText('Main prompt'); await expect(owner.page.locator('#artifacts')).not.toContainText('Grouped document');
    await owner.page.getByLabel('Artifact list').selectOption(one.id); await expect(owner.page.locator('#artifacts .card')).toHaveCount(1);
    await owner.page.getByLabel('Filter by type').selectOption('prompt'); await expect(owner.page.locator('#artifacts .card')).toHaveCount(0);
    await owner.page.getByLabel('Filter by type').selectOption('document'); await owner.page.getByLabel('Search your artifacts').fill('ProjectTag'); await expect(owner.page.locator('#artifacts .card')).toHaveCount(1);
    await owner.page.getByLabel('Search your artifacts').fill('nonmatching'); await expect(owner.page.locator('#artifacts .card')).toHaveCount(0);
    await owner.page.reload(); await expect(owner.page.getByLabel('Artifact list')).toHaveValue(one.id);
    await owner.page.getByRole('link', { name: 'Grouped document', exact: true }).click(); await owner.page.getByRole('link', { name: '← Back to journey' }).click(); await expect(owner.page.getByLabel('Artifact list')).toHaveValue(one.id);
    await placeReload(owner.page, doc, two.id); await owner.page.goto(one.path); await owner.page.reload(); await expect(owner.page.locator('#project-artifacts')).not.toContainText('Grouped document');
    await owner.page.goto(two.path); await owner.page.reload(); await expect(owner.page.locator('#project-artifacts')).toContainText('Grouped document');
    await placeReload(owner.page, doc); await owner.page.goto(trip.path); await owner.page.getByLabel('Artifact list').selectOption('all'); await expect(owner.page.locator('#artifacts .card')).toHaveCount(2);
    await owner.page.getByLabel('Artifact list').selectOption('main'); await owner.page.reload(); await expect(owner.page.locator('#artifacts .card')).toHaveCount(2);
    const docId = doc.split('/').at(-1)!, original = (await stored(owner.page, trip.id)).state.artifacts!.items[docId]!; expect(original.versions).toHaveLength(1);
    await joinTrip(owner.page, guest.page, trip.path); await guest.page.goto(one.path); await participateReload(guest.page, 'Join');
    await owner.page.goto(one.path); await guest.page.goto(one.path); await purpose(owner.page, 'Winning purpose');
    const before = (await controls(owner.page, trip.id)).length;
    await guest.page.getByLabel('Purpose', { exact: true }).fill('Stale purpose'); await guest.page.getByRole('button', { name: 'Save purpose' }).click();
    await expect(guest.page.getByRole('alert')).toContainText('Something changed while you were working. Reload and try again.');
    expect((await controls(owner.page, trip.id)).length).toBe(before); expect(await purposeHistory(owner.page, trip.id, one.id)).toEqual(['First project', 'Winning purpose']);
    await guest.page.locator('#project-state-choice').selectOption('archived'); await guest.page.getByRole('button', { name: 'Save state' }).click();
    await expect(guest.page.getByRole('alert').last()).toContainText('Something changed'); expect((await controls(owner.page, trip.id)).length).toBe(before);
    await guest.page.reload(); await expect(guest.page.locator('#project-purpose-text')).toHaveText('Winning purpose');
    await owner.page.goto(doc); await guest.page.goto(doc); await placeReload(owner.page, doc, one.id);
    await guest.page.getByLabel('Place saved artifact in').selectOption(two.id); await guest.page.getByRole('button', { name: 'Save placement' }).click();
    await expect(guest.page.getByRole('alert')).toContainText('Something changed'); await guest.page.reload(); await expect(guest.page.locator('#placement-current')).toContainText('Winning purpose');
    // Rotation is pending after removal of a test agent; a nonguide may still use metadata controls.
    await owner.page.goto(trip.path + '/members'); await owner.page.getByLabel('Agent name').fill('Rotation fixture'); await owner.page.getByRole('button', { name: 'Create link with passkey' }).click(); await owner.page.getByRole('button', { name: 'Done', exact: true }).click();
    const agent = (await owner.page.locator('[data-rename]').getAttribute('data-rename'))!;
    await change(owner.page, trip.id, 'member.remove', { member: agent });
    await guest.page.goto(one.path); await guest.page.reload(); await purpose(guest.page, 'Purpose during rotation'); await stateReload(guest.page, 'active');
    await participateReload(guest.page, 'Leave'); await participateReload(guest.page, 'Join');
    await guest.page.goto(doc); await expect(guest.page.getByRole('button', { name: 'Save placement' })).toHaveCount(0); await expect(guest.page.getByRole('link', { name: 'Edit artifact' })).toHaveCount(0); await expect(guest.page.getByLabel('Add a comment')).toHaveCount(0);
    await guest.page.goto(trip.path + '/projects'); await expect(guest.page.getByRole('button', { name: 'Create project' })).toHaveCount(0);
    await guest.page.goto(trip.path + '/add'); await expect(guest.page.getByRole('alert')).toContainText('key update is pending'); await expect(guest.page.locator('#artifact-form')).toHaveCount(0);
    const guestId = await principal(guest.page, trip.id), state = (await stored(guest.page, trip.id)).state, placement = state.projects!.placements[docId]!;
    const denied = await attempt(guest.page, trip.id, 'artifact.project', { format: 'project-v1', project: two.id, artifact: docId, author: original.author, actor: guestId, predecessor: placement.revision }); expect(denied.status()).toBe(403);
    const stage = await guest.page.request.post(`/v1/journeys/${trip.id}/blobs`, { headers: { ...headers, 'X-Wayfinding': '1', 'X-Principal': guestId, Origin: 'http://localhost:18787' }, data: { size: 1 } }); expect(stage.status()).toBe(403);
    await owner.page.goto(trip.path); await expect(owner.page.getByRole('heading', { name: 'Placement journey', exact: true })).toBeVisible();
    await owner.page.goto(one.path); await owner.page.reload(); await expect(owner.page.locator('#project-purpose-text')).toHaveText('Purpose during rotation');
    // A malformed/unknown control or missing capability must replace content, not leave a partial view.
    await guest.page.goto(one.path); await expect(guest.page.locator('#project-purpose-text')).toHaveText('Purpose during rotation'); await guest.page.route('**/v1/journeys/*/log*', async route => { const response = await route.fetch(), data = await response.json(); data.log.at(-1).proof.type = 'project.unknown'; await route.fulfill({ response, json: data }); });
    await guest.page.getByRole('link', { name: '← Back to projects' }).click(); await expect(guest.page.getByRole('heading', { name: 'Update Wayfinding' })).toBeVisible(); await expect(guest.page.locator('#project-purpose-text, #projects')).toHaveCount(0);
    await guest.page.unroute('**/v1/journeys/*/log*');
    await guest.page.route('**/v1/journeys/*/log*', route => route.continue({ headers: Object.fromEntries(Object.entries(route.request().headers()).filter(([key]) => key !== 'x-project-format')) }));
    await guest.page.goto(one.path); await expect(guest.page.getByRole('heading', { name: 'Update Wayfinding' })).toBeVisible(); await expect(guest.page.locator('#project-purpose-text')).toHaveCount(0);
    await guest.page.unroute('**/v1/journeys/*/log*');
    await guest.page.route('**/v1/journeys/*/log*', async route => { const response = await route.fetch(), data = await response.json(); data.log.at(-1).proof.sig = 'bad'; await route.fulfill({ response, json: data }); });
    await guest.page.goto(one.path); await expect(guest.page.getByRole('alert')).toContainText('Journey history could not be verified'); await expect(guest.page.locator('#project-purpose-text, #project-artifacts')).toHaveCount(0);
    await guest.page.unroute('**/v1/journeys/*/log*');
    await change(owner.page, trip.id, 'client.minVersion', { version: '0.1.7' }, { 'X-Client-Version': '0.1.7' });
    await guest.page.goto(trip.path); await expect(guest.page.getByRole('heading', { name: 'Update Wayfinding' })).toBeVisible(); await expect(guest.page.getByRole('alert')).toContainText('do not ask for approval again'); await expect(guest.page.locator('#artifacts, #project-purpose-text')).toHaveCount(0);
    await expect(guest.page.locator('header .brand')).toHaveText('AI Wayfinding Journeys'); await expect(guest.page.locator('footer')).toContainText('Wayfinding is how you move when the destination is uncertain.');
  } finally { await owner.context.close(); await guest.context.close(); }
});
