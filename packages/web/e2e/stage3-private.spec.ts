import { expect, test } from '@playwright/test';
import { importArtifactJourney, privateCopies, createAgeIdentity, importPrivateBundle, answerPrivateChallenge, privateIdentity, openIdentity, encodeVaultPatch } from '@ai-wayfinding/core';
import { requestAgent } from './agent.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserPerson, signUp } from './person.js';
import { createTrip, downloadBytes, joinTrip } from './stage1-fixtures.js';
import { addPrivate, durable, frozen, scheduled, device, observe, headers, controls, change, principal, navigate, firstDeviceCheckpoint, signedAgent, forkSnapshot, credentialAgent, credentialRead, adapterPage, deterministicVault, agentCreatesPrivate } from './stage3-fixtures.js';

// These tests use real browser code, real signed controls, Durable Objects and
// server vault bytes. No save-triggered sync or in-memory-only success oracle.
test('private create/edit/comment/files/delete and backup survive scheduled durable commits without shared export leakage', async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await browserPerson(browser);
  try {
    await signUp(owner.page, `private-workflow-${Date.now()}@example.org`);
    await frozen(owner.page); const trip = await createTrip(owner.page);
    const before = await durable(owner.page, trip.id), trace = observe(owner.page);
    const secret = Buffer.from('SECRET PRIVATE ATTACHMENT\0\xff'), hostile = '<script>window.privateExecuted=true</script><img src="https://example.org/private-canary">';
    const path = await addPrivate(owner.page, trip.path, 'PRIVATE TITLE CANARY', hostile, secret), copy = path.split('/').at(-1)!;
    expect(trace).toEqual([]); // Saves are local staged ciphertext, not network writes.
    expect((await durable(owner.page, trip.id)).branches).toHaveLength(0);
    await expect(owner.page.locator('#private-freshness')).toContainText('Unverified freshness');
    await expect(owner.page.locator('#private-durability')).toContainText('not an offline freshness guarantee');
    await expect(owner.page.locator('#private-viewer script, #private-viewer img')).toHaveCount(0);
    expect(await owner.page.evaluate(() => Object.hasOwn(window, 'privateExecuted'))).toBe(false);
    await scheduled(owner.page);
    const created = await durable(owner.page, trip.id), createdCopy = privateCopies(created.branches[0]!.view)[0]!;
    expect(createdCopy.copy).toBe(copy); expect(createdCopy.records.map(r => r.type)).toEqual(['private.create']);
    expect(created.branches[0]!.bundle.payloads[0]!.payload.body.title).toBe('PRIVATE TITLE CANARY');
    expect(createdCopy.records[0]!.authority.principal).toBe(created.current.actor);
    expect(created.snapshot.checkpoint.version).toBe(before.snapshot.checkpoint.version + 1);
    const downloading = owner.page.waitForEvent('download'); await owner.page.getByRole('button', { name: 'Download secret.bin' }).click();
    expect(await downloadBytes(await downloading)).toEqual(secret);
    await owner.page.getByLabel('Private comment', { exact: true }).fill('PRIVATE COMMENT CANARY'); await owner.page.getByRole('button', { name: 'Add private comment', exact: true }).click();
    await expect(owner.page.locator('#private-comments')).toContainText('PRIVATE COMMENT CANARY');
    await scheduled(owner.page);
    expect(privateCopies((await durable(owner.page, trip.id)).branches[0]!.view)[0]!.records.map(r => r.type)).toEqual(['private.create', 'private.comment']);
    await owner.page.getByRole('link', { name: 'Edit private artifact', exact: true }).click(); await owner.page.getByLabel('Private body', { exact: true }).fill('PRIVATE SECOND VERSION');
    await owner.page.getByRole('button', { name: 'Save private artifact', exact: true }).click(); await expect(owner.page).toHaveURL(path);
    await scheduled(owner.page); const edited = await durable(owner.page, trip.id);
    expect(privateCopies(edited.branches[0]!.view)[0]!.records.map(r => r.type)).toEqual(['private.create', 'private.comment', 'private.version']);
    await navigate(owner.page, trip.path + '/private/backup'); const backing = owner.page.waitForEvent('download'); await owner.page.getByRole('button', { name: 'Download encrypted private backup', exact: true }).click();
    const backup = await downloadBytes(await backing);
    expect(backup.toString()).not.toContain('PRIVATE TITLE CANARY');
    const opened = await importPrivateBundle(backup.toString(), edited.current.secrets.identity, { trust: { vault: edited.vault, author: edited.author }, recipient: edited.author, historical: true });
    expect(opened.bundle.records.map(r => r.type)).toEqual(['private.create', 'private.comment', 'private.version']);
    await owner.page.getByLabel('Encrypted private backup', { exact: true }).setInputFiles({ name: 'backup.age.txt', mimeType: 'text/plain', buffer: backup }); await owner.page.getByRole('button', { name: 'Import private backup', exact: true }).click();
    await expect(owner.page.getByRole('link', { name: 'PRIVATE TITLE CANARY', exact: true })).toBeVisible(); await scheduled(owner.page);
    expect((await durable(owner.page, trip.id)).branches[0]!.bundle.records).toEqual(opened.bundle.records);
    await navigate(owner.page, trip.path + '/export'); const recovery = await createAgeIdentity(); await owner.page.getByLabel('Recovery recipient').fill(recovery.recipient);
    const exporting = owner.page.waitForEvent('download'); await owner.page.getByRole('button', { name: 'Download encrypted export' }).click();
    const archive = await importArtifactJourney((await downloadBytes(await exporting)).toString(), [edited.current.secrets.identity], { journey: trip.id, creator: edited.current.rows[0]!.proof.body.creator as import('@ai-wayfinding/core').Member });
    expect(JSON.stringify(archive.archive)).not.toContain(copy); expect(JSON.stringify(archive.archive)).not.toContain('PRIVATE TITLE CANARY');
    expect((await controls(owner.page, trip.id)).filter(r => r.proof.type.startsWith('private.'))).toEqual([]);
    expect(JSON.stringify((await controls(owner.page, trip.id)))).not.toContain('PRIVATE COMMENT CANARY');
    await navigate(owner.page, path); owner.page.once('dialog', dialog => { void dialog.accept(); }); await owner.page.getByRole('button', { name: 'Delete private artifact', exact: true }).click();
    await expect(owner.page).toHaveURL(trip.path + '/private'); await scheduled(owner.page);
    const deleted = await durable(owner.page, trip.id); expect(privateCopies(deleted.branches[0]!.view)[0]!.deleted).toBe(true); expect(deleted.branches[0]!.bundle.blobs).toEqual([]);
    await navigate(owner.page, trip.path + '/private/backup'); await owner.page.getByLabel('Encrypted private backup', { exact: true }).setInputFiles({ name: 'old.age.txt', mimeType: 'text/plain', buffer: backup }); await owner.page.getByRole('button', { name: 'Import private backup', exact: true }).click();
    await expect(owner.page.locator('main > [role="alert"]')).toContainText('Stale private backup replacement');
    expect((await durable(owner.page, trip.id)).head).toBe(deleted.head);
    await navigate(owner.page, trip.path + '/private'); await expect(owner.page.locator('#private-count')).toHaveText('0 matching author-private artifacts');
    await expect(owner.page.locator('header .brand')).toHaveText('AI Wayfinding Journeys'); await expect(owner.page.locator('footer')).toContainText('Wayfinding is how you move when the destination is uncertain.');
    expect(owner.requests.every(url => new URL(url).hostname === 'localhost')).toBe(true);
  } finally { await owner.context.close(); }
});

test('unpaired second device warns; paired checkpoint preserves freshness and refuses signed rollback without mutation', async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await browserPerson(browser);
  try {
    await signUp(owner.page, `private-pair-${Date.now()}@example.org`); await frozen(owner.page); const trip = await createTrip(owner.page);
    const old = await durable(owner.page, trip.id); await addPrivate(owner.page, trip.path, 'PAIR SECRET', 'Persisted on first device'); await scheduled(owner.page);
    const saved = await durable(owner.page, trip.id);
    const unpairedContext = await browser.newContext({ storageState: await owner.context.storageState() });
    try {
      const unpaired = await device(unpairedContext, owner.page, trip.id);
      expect(await unpaired.evaluate(() => (window as any).privateWork.vault.freshness)).toBe('unverified');
      expect(await unpaired.evaluate(async () => { const w = (window as any).privateWork; return (await w.content((await w.copies('all'))[0])).title; })).toBe('PAIR SECRET');
      await unpaired.evaluate(() => (window as any).Stage3.closePrivateVaults());
    } finally { await unpairedContext.close(); }
    const pairedContext = await browser.newContext({ storageState: await owner.context.storageState() });
    try {
      // Trusted checkpoint comes directly from first device's verified encrypted
      // cache, simulating the existing out-of-band pairing input seam.
      await expect.poll(async () => (await firstDeviceCheckpoint(owner.page, saved.vault, saved.current.secrets.identity)).head).toBe(saved.head);
      const paired = { ...await firstDeviceCheckpoint(owner.page, saved.vault, saved.current.secrets.identity), freshness: 'paired' as const };
      const second = await device(pairedContext, owner.page, trip.id, paired);
      expect(await second.evaluate(() => (window as any).privateWork.vault.freshness)).toBe('paired');
      const current = await durable(owner.page, trip.id), retained = await second.evaluate(() => (window as any).privateWork.vault.retainedCheckpoint);
      expect(retained.version).toBe(current.snapshot.checkpoint.version);
      await second.evaluate(() => (window as any).Stage3.closePrivateVaults());
      await second.route('**/private-vault?*', async route => { const query = new URL(route.request().url()).searchParams.get('slots')!, indices = query === 'all' ? Array.from({ length: 64 }, (_, i) => i) : query.split(',').map(Number); const bytes = new Uint8Array(65 + 32_768 + indices.length * (1 + 1_048_576)); bytes.set(new TextEncoder().encode(old.snapshot.token)); bytes[64] = 1; bytes.set(Buffer.from(old.snapshot.frame, 'base64'), 65); let offset = 65 + 32_768; for (const index of indices) { bytes[offset++] = index; bytes.set(Buffer.from(old.snapshot.slots[index]!, 'base64'), offset); offset += 1_048_576; } await route.fulfill({ contentType: 'application/octet-stream', body: Buffer.from(bytes) }); });
      let puts = 0; second.on('request', r => { if (r.method() === 'PUT' && r.url().endsWith('/private-vault')) puts++; });
      expect(await second.evaluate(async () => { try { await (window as any).Stage3.openJourneyVault((window as any).privateContext); return 'accepted'; } catch (error) { return (error as Error).message; } })).toContain('rollback');
      expect(puts).toBe(0); expect((await durable(owner.page, trip.id)).head).toBe(current.head);
    } finally { await pairedContext.close(); }
  } finally { await owner.context.close(); }
});


test('a read-only person can reopen committed private content but cannot write it', async ({ browser }) => {
  const owner = await browserPerson(browser);
  try {
    await signUp(owner.page, `private-readonly-${Date.now()}@example.org`);
    await frozen(owner.page); const trip = await createTrip(owner.page);
    const path = await addPrivate(owner.page, trip.path, 'READONLY PRIVATE CANARY', 'Still readable after a downgrade');
    await scheduled(owner.page);
    const before = await durable(owner.page, trip.id);
    await change(owner.page, trip.id, 'member.role', { member: before.current.actor, role: 'read-only' });
    const readonlyContext = await browser.newContext({ storageState: await owner.context.storageState() });
    try {
      const reader = await device(readonlyContext, owner.page, trip.id), retained = await durable(owner.page, trip.id);
      await expect(reader.evaluate(() => (window as any).privateWork.save({ title: 'FORBIDDEN PRIVATE WRITE', tags: [], content: { kind: 'document', markdown: 'Must not survive' }, attachments: [] }))).rejects.toThrow('Private write authority denied');
      expect((await durable(owner.page, trip.id)).head).toBe(retained.head);
      expect(privateCopies((await durable(owner.page, trip.id)).branches[0]!.view)).toHaveLength(1);
    } finally { await readonlyContext.close(); }
    await navigate(owner.page, path);
    await expect(owner.page.getByRole('heading', { name: 'READONLY PRIVATE CANARY', exact: true })).toBeVisible();
    await expect(owner.page.getByRole('link', { name: 'Edit private artifact', exact: true })).toHaveCount(0);
    await expect(owner.page.getByRole('button', { name: 'Delete private artifact', exact: true })).toHaveCount(0);
  } finally { await owner.context.close(); }
});


test('private cross-journey copies have independent keys, files and lifecycle; placement filters keep archived content readable', async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await browserPerson(browser);
  try {
    await signUp(owner.page, `private-copy-${Date.now()}@example.org`); await frozen(owner.page);
    const source = await createTrip(owner.page, 'Private source');
    await navigate(owner.page, '/'); const destination = await createTrip(owner.page, 'Private destination');
    await navigate(owner.page, source.path + '/projects'); await owner.page.getByLabel('Purpose', { exact: true }).fill('Private grouping');
    await owner.page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(owner.page).toHaveURL(/\/projects\/[0-9A-Z]+$/);
    const project = new URL(owner.page.url()).pathname.split('/').at(-1)!;
    await expect(owner.page.locator('#project-purpose-text')).toHaveText('Private grouping');
    const path = await addPrivate(owner.page, source.path, 'INDEPENDENT PRIVATE COPY', 'Original snapshot', Buffer.from('Independent bytes'));
    await scheduled(owner.page); const original = await durable(owner.page, source.id);
    await owner.page.getByLabel('Place private copy in').selectOption(project); await owner.page.getByRole('button', { name: 'Save private placement', exact: true }).click();
    await expect(owner.page.getByLabel('Place private copy in')).toHaveValue(project); await scheduled(owner.page);
    const placed = await durable(owner.page, source.id); expect(privateCopies(placed.branches[0]!.view)[0]!.project).toBe(project);
    await navigate(owner.page, source.path + '/private'); await expect(owner.page.locator('#private-count')).toHaveText('0 matching author-private artifacts');
    await owner.page.getByLabel('Private artifact list', { exact: true }).selectOption(project); await expect(owner.page.locator('#private-count')).toHaveText('1 matching author-private artifacts');
    await owner.page.getByLabel('Private artifact list', { exact: true }).selectOption('all'); await expect(owner.page.locator('#private-count')).toHaveText('1 matching author-private artifacts');
    await change(owner.page, source.id, 'project.join', { format: 'project-v1', project, member: original.current.actor, predecessor: null });
    await change(owner.page, source.id, 'project.state', { format: 'project-v1', project, state: 'archived', predecessor: 1 });
    await navigate(owner.page, source.path + '/projects/' + project); await expect(owner.page.locator('#project-state')).toContainText('archived');
    await navigate(owner.page, source.path + '/private'); await owner.page.getByLabel('Private artifact list', { exact: true }).selectOption(project); await expect(owner.page.getByRole('link', { name: 'INDEPENDENT PRIVATE COPY', exact: true })).toBeVisible();
    await navigate(owner.page, path); await owner.page.getByLabel('Copy privately to journey').selectOption(destination.id); await owner.page.getByRole('button', { name: 'Create independent private copy', exact: true }).click();
    await expect(owner.page).toHaveURL(new RegExp(destination.path + '/private/[A-Za-z0-9_-]{43}$')); const copiedPath = new URL(owner.page.url()).pathname;
    await scheduled(owner.page); const copied = await durable(owner.page, destination.id), sourceNow = await durable(owner.page, source.id), destCopy = privateCopies(copied.branches[0]!.view)[0]!;
    expect(copied.vault).not.toBe(original.vault); expect(destCopy.copy).not.toBe(privateCopies(original.branches[0]!.view)[0]!.copy); expect(destCopy.author).toEqual(original.author); expect(destCopy.project).toBeNull();
    expect(destCopy.records.map(r => r.type)).toEqual(['private.copy']); expect(destCopy.records[0]!.body.destination).toEqual({ journey: destination.id, copy: destCopy.copy });
    expect(copied.branches[0]!.bundle.copyKeys[0]!.key).not.toBe(sourceNow.branches[0]!.bundle.copyKeys[0]!.key);
    expect(copied.branches[0]!.bundle.blobs[0]!.descriptor.id).not.toBe(sourceNow.branches[0]!.bundle.blobs[0]!.descriptor.id);
    expect(copied.branches[0]!.bundle.blobs[0]!.ciphertext).not.toBe(sourceNow.branches[0]!.bundle.blobs[0]!.ciphertext);
    expect(copied.branches[0]!.bundle.sourceHistories![0]!.vault).toBe(original.vault);
    await navigate(owner.page, path); owner.page.once('dialog', d => { void d.accept(); }); await owner.page.getByRole('button', { name: 'Delete private artifact', exact: true }).click(); await scheduled(owner.page);
    expect(privateCopies((await durable(owner.page, source.id)).branches[0]!.view)[0]!.deleted).toBe(true);
    await navigate(owner.page, copiedPath); await expect(owner.page.getByRole('heading', { name: 'INDEPENDENT PRIVATE COPY', exact: true })).toBeVisible();
    const download = owner.page.waitForEvent('download'); await owner.page.getByRole('button', { name: 'Download secret.bin', exact: true }).click(); expect(await downloadBytes(await download)).toEqual(Buffer.from('Independent bytes'));
    expect(privateCopies((await durable(owner.page, destination.id)).branches[0]!.view)[0]!.deleted).toBe(false);
    expect(JSON.stringify(await controls(owner.page, destination.id))).not.toContain(destCopy.copy);
  } finally { await owner.context.close(); }
});


test('empty and populated browser lifetimes use matched two-slot dummy/dirty traffic, retained-cache reopen and lock cancellation', async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await browserPerson(browser);
  try {
    await signUp(owner.page, `private-traffic-${Date.now()}@example.org`); await frozen(owner.page);
    const first = observe(owner.page), trip = await createTrip(owner.page);
    expect(first.filter(r => r.method === 'GET' && r.path.endsWith('?slots=all'))).toHaveLength(1);
    await navigate(owner.page, trip.path + '/private'); first.length = 0; const start = await owner.page.evaluate(() => Date.now());
    await scheduled(owner.page); const empty = await durable(owner.page, trip.id), dummy = first.map(r => ({ method: r.method, path: r.path, bytes: r.bytes, headers: r.headers }));
    expect(dummy.map(r => r.method)).toEqual(['GET', 'PUT']); expect(dummy[0]!.path).toBe(`/v1/journeys/${trip.id}/private-vault?slots=two`); expect(dummy[1]!.bytes).toBe(2_129_986);
    first.length = 0; const path = await addPrivate(owner.page, trip.path, 'TRAFFIC PRIVATE CANARY', 'Not sent on save'); expect(first).toEqual([]);
    await owner.page.clock.runFor(start + 600_000 - await owner.page.evaluate(() => Date.now()) - 1); expect(first).toEqual([]);
    const put = owner.page.waitForResponse(r => r.url().endsWith('/private-vault') && r.request().method() === 'PUT'); await owner.page.clock.runFor(1); expect((await put).status()).toBe(200);
    await expect.poll(async () => (await durable(owner.page, trip.id)).branches.length).toBe(1);
    const populated = await durable(owner.page, trip.id); expect(populated.snapshot.checkpoint.version).toBe(empty.snapshot.checkpoint.version + 1);
    expect(first.map(r => ({ method: r.method, path: r.path, bytes: r.bytes, headers: r.headers }))).toEqual(dummy);
    await navigate(owner.page, '/'); first.length = 0; await navigate(owner.page, path); await expect(owner.page.getByRole('heading', { name: 'TRAFFIC PRIVATE CANARY', exact: true })).toBeVisible();
    expect(first.filter(r => r.path.endsWith('?slots=all'))).toEqual([]); expect(first.map(r => r.method)).toEqual(['GET', 'PUT']);
    const held = await durable(owner.page, trip.id); first.length = 0;
    // Lock while a detail render is awaiting its final authority response. A
    // careless continuation must not restore the previously decrypted viewer.
    let locked = false;
    await owner.page.route('**/private-agents', async route => { if (!locked) { locked = true; await owner.page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); } await route.continue(); });
    await navigate(owner.page, path);
    await expect(owner.page.getByRole('heading', { name: 'Session locked' })).toBeVisible();
    await expect(owner.page.locator('main > [role="alert"]')).toContainText('locked'); expect(await owner.page.locator('main').textContent()).not.toContain('TRAFFIC PRIVATE CANARY');
    await owner.page.clock.runFor(600_000); expect(first).toEqual([]); expect((await durable(owner.page, trip.id)).head).toBe(held.head);
  } finally { await owner.context.close(); }
});


test('own authenticated agent creates private artifacts in its person vault with agent authorship and signatures', async ({ browser, request }) => {
  test.setTimeout(300_000);
  const owner = await browserPerson(browser);
  try {
    await signUp(owner.page, `private-agent-${Date.now()}@example.org`); await frozen(owner.page); const trip = await createTrip(owner.page);
    const agent = await requestAgent(request, trip.id, 'Private reader');
    await navigate(owner.page, new URL(agent.approvalUrl).pathname); await owner.page.getByLabel('Six-digit code').fill(agent.code); await expect(owner.page.getByLabel('Access', { exact: true })).toHaveCount(0);
    await owner.page.getByRole('button', { name: 'Confirm with passkey', exact: true }).click(); await expect(owner.page.getByRole('heading', { name: 'Agent approved' })).toBeVisible();
    const path = await addPrivate(owner.page, trip.path, 'SCOPED AGENT INPUT', 'The person owns this content'); await scheduled(owner.page); const saved = await durable(owner.page, trip.id);
    const wrap = await signedAgent(owner.page, agent, 'GET', `/v1/journeys/${trip.id}/private-agent-wrap/${agent.principal}`); expect(wrap.status()).toBe(200); expect(JSON.stringify(await wrap.json())).not.toContain('SCOPED AGENT INPUT');
    const read = await signedAgent(owner.page, agent, 'GET', `/v1/journeys/${trip.id}/private-vault?slots=00,01`); expect(read.status()).toBe(200); expect((await read.body()).length).toBe(2_129_987); await read.dispose();
    await owner.page.getByRole('button', { name: 'Create one-use possession challenge', exact: true }).click();
    await expect(owner.page.locator('#private-challenge')).not.toBeEmpty(); const challenge = JSON.parse((await owner.page.locator('#private-challenge').textContent())!);
    const response = await answerPrivateChallenge(challenge, agent.signingPrivateKey, agent.identity);
    await owner.page.getByLabel('Agent possession response JSON').fill(JSON.stringify(response)); const downloading = owner.page.waitForEvent('download'); await owner.page.getByRole('button', { name: 'Download scoped encrypted handoff', exact: true }).click();
    const ciphertext = (await downloadBytes(await downloading)).toString(); expect(ciphertext).not.toContain('SCOPED AGENT INPUT');
    const opened = JSON.parse(await openIdentity(ciphertext, [agent.identity])); expect(opened.scope).toBe('agent-handoff'); expect(opened.payloads[0].payload.body.title).toBe('SCOPED AGENT INPUT'); expect(opened.author).toEqual(saved.author);
    await expect(openIdentity(ciphertext, [saved.current.secrets.identity])).rejects.toThrow();
    await owner.page.getByRole('button', { name: 'Download scoped encrypted handoff', exact: true }).click(); await expect(owner.page.locator('main > [role="alert"]')).toContainText('Create a fresh local challenge first');
    expect((await durable(owner.page, trip.id)).head).toBe(saved.head);
    const written = await agentCreatesPrivate(owner.page, agent, trip.id, 'AGENT PRIVATE AUTHOR');
    const result = await durable(owner.page, trip.id), authored = privateCopies(result.branches[0]!.view).find(c => c.copy === written.copy)!;
    expect(result.vault).toBe(saved.vault); expect(authored.author).toEqual(written.actor); expect(authored.records[0]!.actor).toEqual(written.actor); expect(authored.records[0]!.sig).toBe(written.record.sig);
    expect(authored.payloads[0]!.payload.body.content).toEqual({ kind: 'document', markdown: 'Authored privately by the agent' });
    // The first fixed sync discovers the new signed directory; the next reads
    // its missing live slots. Neither save triggers a sync or full-vault fetch.
    await scheduled(owner.page); await scheduled(owner.page);
    await navigate(owner.page, trip.path + '/private/' + written.copy); await expect(owner.page.getByRole('heading', { name: 'AGENT PRIVATE AUTHOR', exact: true })).toBeVisible();
    await expect(owner.page.locator('#private-author')).toContainText('Private reader');
  } finally { await owner.context.close(); }
});


test('complete same-version forks retain both tied private versions under a higher durable signed merge', async ({ browser }) => {
  test.setTimeout(300_000); const owner = await browserPerson(browser), scratch = resolve('../../.scratch/private-fork-' + Date.now()); await mkdir(scratch, { recursive: true });
  try {
    await signUp(owner.page, `private-fork-${Date.now()}@example.org`); await frozen(owner.page); const trip = await createTrip(owner.page);
    await addPrivate(owner.page, trip.path, 'TIED PRIVATE CONTENT', 'LEFT VERIFIED VERSION'); await scheduled(owner.page);
    const saved = await durable(owner.page, trip.id), fork = await forkSnapshot(saved, 'RIGHT VERIFIED VERSION');
    const { changed, ...snapshot } = fork;
    await navigate(owner.page, trip.path + '/private/backup');
    const corrupt = structuredClone(snapshot); corrupt.slots[changed] = Buffer.alloc(1_048_576).toString('base64');
    await writeFile(scratch + '/corrupt.json', JSON.stringify(corrupt));
    await owner.page.getByLabel('Encrypted device snapshot JSON').setInputFiles(scratch + '/corrupt.json');
    await owner.page.getByRole('button', { name: 'Merge verified device histories' }).click(); await expect(owner.page.locator('main > [role="alert"]')).toContainText('digest'); expect((await durable(owner.page, trip.id)).head).toBe(saved.head);
    // Install the independently signed other device head in the real server using
    // its atomic two-slot CAS. This does not replace the retained first-device checkpoint.
    const put = await owner.page.request.put(`/v1/journeys/${trip.id}/private-vault`, { headers: { ...headers, 'X-Principal': saved.current.actor, 'X-Wayfinding': '1', Origin: new URL(owner.page.url()).origin, 'Content-Type': 'application/octet-stream' }, data: Buffer.from(encodeVaultPatch({ token: saved.snapshot.token, frame: snapshot.frame, slots: [changed, (changed + 1) % 64].map(index => ({ index, ciphertext: snapshot.slots[index]! })) })) }); expect(put.status()).toBe(200);
    await writeFile(scratch + '/fork.json', JSON.stringify(snapshot));
    await owner.page.getByLabel('Encrypted device snapshot JSON').setInputFiles(scratch + '/fork.json'); await owner.page.getByRole('button', { name: 'Merge verified device histories' }).click();
    await expect(owner.page.getByRole('heading', { name: 'Author-private artifacts', exact: true })).toBeVisible(); await scheduled(owner.page); const merged = await durable(owner.page, trip.id);
    expect(merged.snapshot.checkpoint.version).toBe(saved.snapshot.checkpoint.version + 1); expect(merged.branches).toHaveLength(2);
    expect(merged.branches.map(b => b.bundle.payloads[0]!.payload.body.content).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([{ kind: 'document', markdown: 'LEFT VERIFIED VERSION' }, { kind: 'document', markdown: 'RIGHT VERIFIED VERSION' }]);
    await navigate(owner.page, trip.path + '/private'); await expect(owner.page.getByRole('heading', { name: 'Conflicting private versions' })).toBeVisible(); await expect(owner.page.locator('main')).toContainText('LEFT VERIFIED VERSION'); await expect(owner.page.locator('main')).toContainText('RIGHT VERIFIED VERSION'); await expect(owner.page.getByRole('link', { name: 'Add a private artifact' })).toHaveCount(0);
    const secondContext = await browser.newContext({ storageState: await owner.context.storageState() });
    try { const second = await device(secondContext, owner.page, trip.id, { ...merged.snapshot.checkpoint, freshness: 'paired' }); expect(await second.evaluate(() => (window as any).privateWork.vault.branches.length)).toBe(2); } finally { await secondContext.close(); }
  } finally { await owner.context.close(); await rm(scratch, { recursive: true, force: true }); }
});


test('oversized private files refuse fixed-vault capacity without a server or local pending mutation', async ({ browser }) => {
  test.setTimeout(300_000); const owner = await browserPerson(browser);
  try {
    await signUp(owner.page, `private-capacity-${Date.now()}@example.org`); await frozen(owner.page); const trip = await createTrip(owner.page);
    const before = await durable(owner.page, trip.id), trace = observe(owner.page);
    await navigate(owner.page, trip.path + '/private/add'); await owner.page.getByLabel('Private title', { exact: true }).fill('CAPACITY MUST NOT SURVIVE');
    await owner.page.getByLabel('Private attachments', { exact: true }).setInputFiles([0, 1, 2].map(i => ({ name: `large-${i}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.alloc(17_000_000, i + 1) })));
    await owner.page.getByRole('button', { name: 'Save private artifact', exact: true }).click(); await expect(owner.page.locator('main > [role="alert"]')).toContainText('Private vault is full; nothing was saved', { timeout: 60_000 });
    expect(trace).toEqual([]); expect((await durable(owner.page, trip.id)).head).toBe(before.head);
    await expect(owner.page.locator('#private-save-status')).toContainText('Verified committed'); await scheduled(owner.page);
    expect((await durable(owner.page, trip.id)).branches).toHaveLength(0); // Dummy commit cannot leak a partially staged file.
  } finally { await owner.context.close(); }
});


test('browser proposals refuse stale edits, unsupported content, foreign backups and project/destination elevation without mutation', async ({ browser }) => {
  test.setTimeout(300_000); const owner = await browserPerson(browser);
  try {
    await signUp(owner.page, `private-negative-${Date.now()}@example.org`); await frozen(owner.page); const source = await createTrip(owner.page, 'Negative source');
    await navigate(owner.page, '/'); const destination = await createTrip(owner.page, 'Negative destination');
    await addPrivate(owner.page, source.path, 'NEGATIVE BASELINE', 'Committed original'); await scheduled(owner.page);
    const secondContext = await browser.newContext({ storageState: await owner.context.storageState() });
    try {
      const second = await device(secondContext, owner.page, source.id);
      await second.evaluate(async () => { const w = (window as any).privateWork; (window as any).oldPrivateCopy = (await w.copies('all'))[0]; });
      await second.evaluate(async () => { const w = (window as any).privateWork; await w.save({ title: 'CURRENT VERSION', tags: [], content: { kind: 'document', markdown: 'Current' }, attachments: [] }, (window as any).oldPrivateCopy); });
      const reject = (operation: 'stale' | 'unsupported' | 'foreign' | 'project') => second.evaluate(async operation => {
        const w = (window as any).privateWork, core = (window as any).Stage3;
        try {
          if (operation === 'foreign') { const key = await core.createAgeIdentity(); await w.restore(await core.sealIdentity('{}', [key.recipient])); }
          else if (operation === 'project') await w.place((await w.copies('all'))[0], core.newId());
          else await w.save({ title: 'DISALLOWED INPUT', tags: [], content: operation === 'unsupported' ? { kind: 'html', html: '<script>bad()</script>' } : { kind: 'document', markdown: 'Stale overwrite' }, attachments: [] }, operation === 'stale' ? (window as any).oldPrivateCopy : undefined);
          return 'accepted';
        } catch (error) { return (error as Error).message; }
      }, operation);
      const before = await durable(owner.page, source.id), trace = observe(second);
      expect(await reject('stale')).toContain('conflict'); expect(await reject('unsupported')).toBe('Unsupported artifact type'); expect(await reject('foreign')).not.toBe('accepted'); expect(await reject('project')).toContain('conflict');
      expect(trace).toEqual([]); expect((await durable(owner.page, source.id)).head).toBe(before.head);
      await second.clock.runFor(300_000); await expect.poll(async () => (await durable(owner.page, source.id)).branches[0]!.bundle.records.length).toBe(2);
      const committed = await durable(owner.page, source.id); expect(committed.branches[0]!.bundle.payloads.at(-1)!.payload.body.title).toBe('CURRENT VERSION');
      const destinationDevice = await device(secondContext, owner.page, destination.id);
      const project = await destinationDevice.evaluate(async () => { const core = (window as any).Stage3, ctx = (window as any).privateContext; return core.createProject(ctx, 'Read-only participant'); });
      const destinationPrincipal = await principal(owner.page, destination.id);
      await change(owner.page, destination.id, 'member.role', { member: destinationPrincipal, role: 'read-only' });
      await destinationDevice.evaluate(async project => { const core = (window as any).Stage3, ctx = (window as any).privateContext; await core.participateProject(await core.verifiedJourney(ctx.id, ctx.principal, ctx.keys), 'project.join', project); }, project);
      await second.evaluate(async ({ id, destinationPrincipal }) => {
        const core = (window as any).Stage3;
        (window as any).destinationWork = await core.BrowserPrivateArtifacts.open(await core.verifiedJourney(id, destinationPrincipal, (window as any).privateContext.keys));
      }, { id: destination.id, destinationPrincipal });
      const destBefore = await durable(owner.page, destination.id);
      expect(await second.evaluate(async () => {
        const source = (window as any).privateWork, dest = (window as any).destinationWork;
        try { await source.copyTo((await source.copies('all'))[0], dest); return 'accepted'; } catch (error) { return (error as Error).message; }
      })).toContain('Private write authority denied');
      expect((await durable(owner.page, destination.id)).head).toBe(destBefore.head); expect((await durable(owner.page, destination.id)).branches).toHaveLength(0);
    } finally { await secondContext.close(); }
  } finally { await owner.context.close(); }
});


// Supplying a handle, a person principal, or a known agent ID must never grant
// another credential the author's ciphertext, wraps or possession audience.
test('removed, expired, link and foreign-agent browser credentials cannot obtain the author vault or handoff audience', async ({ browser }) => {
  test.setTimeout(300_000); const owner = await browserPerson(browser), guest = await browserPerson(browser);
  try {
    await signUp(owner.page, `private-credentials-${Date.now()}@example.org`); const trip = await createTrip(owner.page);
    await signUp(guest.page, `private-foreign-${Date.now()}@example.org`); await joinTrip(owner.page, guest.page, trip.path);
    const foreign = await credentialAgent(guest.page, trip.id), own = await credentialAgent(owner.page, trip.id), removed = await credentialAgent(owner.page, trip.id), link = await credentialAgent(owner.page, trip.id, 'link');
    await frozen(owner.page); await navigate(owner.page, '/'); await addPrivate(owner.page, trip.path, 'CREDENTIAL PRIVATE CANARY', 'No foreign audience'); await scheduled(owner.page);
    const saved = await durable(owner.page, trip.id), secondContext = await browser.newContext({ storageState: await owner.context.storageState() });
    try {
      const second = await device(secondContext, owner.page, trip.id);
      const readPath = `/v1/journeys/${trip.id}/private-vault?slots=00,01`, wrapPath = `/v1/journeys/${trip.id}/private-agent-wrap/${own.principal}`;
      const allowed = await credentialRead(second, own, readPath); expect(allowed.status).toBe(200); expect(allowed.bytes).toBe(2_129_987);
      expect((await credentialRead(second, own, wrapPath)).status).toBe(200);
      await change(owner.page, trip.id, 'member.remove', { member: removed.principal });

      await owner.page.clock.setSystemTime(new Date()); await navigate(owner.page, trip.path); await expect(owner.page.getByRole('heading', { name: 'Artifacts journey', exact: true })).toBeVisible(); // existing guide rotation completes before testing the audience
      // Expiry uses a real server credential and actual server wall time. Only the
      // browser's vault timer is virtual; moving it cannot expire server auth.
      const expired = await credentialAgent(owner.page, trip.id, 'memory', 30_000);
      await expect.poll(() => Date.now(), { timeout: 40_000 }).toBeGreaterThan(expired.expiresAt);
      await second.evaluate(async () => { const w = (window as any).privateWork, core = (window as any).Stage3; core.closePrivateVaults(); (window as any).privateWork = await core.BrowserPrivateArtifacts.open(await core.verifiedJourney(w.ctx.id, w.ctx.principal, w.ctx.keys)); });
      const before = await durable(owner.page, trip.id);

      expect(await second.evaluate(async principal => (await (window as any).privateWork.challenge(principal)).message.principal, own.principal)).toBe(own.principal);
      for (const [name, agent] of [['removed', removed], ['expired', expired], ['link', link]] as const) {
        for (const path of [readPath, wrapPath, `/v1/journeys/${trip.id}/private-agent-wrap/${agent.principal}`]) {
          const denied = await credentialRead(second, agent, path, { 'X-Principal': saved.current.actor });
          expect([401, 403], name).toContain(denied.status); expect(denied.frame).toBeNull(); expect(denied.text).not.toContain('ciphertext'); expect(denied.text).not.toContain('CREDENTIAL PRIVATE CANARY');
        }
      }
      // A foreign agent has its own person's separate vault, not the requested
      // author's vault, even when it supplies that author's principal.
      const other = await credentialRead(second, foreign, readPath, { 'X-Principal': saved.current.actor });
      expect(other.status).toBe(200); expect(other.frame).not.toBe(saved.snapshot.frame);
      const guestVault = await durable(guest.page, trip.id); expect(guestVault.vault).not.toBe(saved.vault); expect(other.frame).toBe(guestVault.snapshot.frame); expect(guestVault.branches).toEqual([]);
      await expect(second.evaluate(async ({ frame, identity, recipient }) => (window as any).Stage3.openPrivateFrame(frame, identity, recipient), { frame: saved.snapshot.frame, identity: foreign.identity, recipient: saved.author.recipient })).rejects.toThrow();
      expect((await credentialRead(second, foreign, wrapPath)).status).toBe(403);
      for (const agent of [removed, expired, link, foreign]) {
        expect(await second.evaluate(async principal => { try { await (window as any).privateWork.challenge(principal); return 'accepted'; } catch (error) { return (error as Error).message; } }, agent.principal)).toBe('Authenticated own agent required');
      }
      const audience = await second.evaluate(async () => { const w = (window as any).privateWork; return (await (await fetch(`/v1/journeys/${w.ctx.id}/private-agents`, { headers: { 'X-Principal': w.ctx.principal, 'X-Client-Version': '0.1.7', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Project-Format': 'project-v1', 'X-Private-Format': 'private-v1' } })).json()).agents.map((a: { principal: string }) => a.principal); });
      expect(audience).toEqual([own.principal]); expect((await durable(owner.page, trip.id)).head).toBe(before.head);
      expect(privateCopies(before.branches[0]!.view)).toHaveLength(1); expect(before.branches[0]!.bundle.payloads[0]!.payload.body.title).toBe('CREDENTIAL PRIVATE CANARY');
    } finally { await secondContext.close(); }
  } finally { await owner.context.close(); await guest.context.close(); }
});

// Reuse one browser profile across two real accounts. Cache database names must
// be memberVaultId bindings, and old decrypted controllers must stay unusable.
test('sign-out and author switching clear private viewers, keys and pending state without crossing member vaults', async ({ browser }) => {
  test.setTimeout(300_000); const owner = await browserPerson(browser), guest = await browserPerson(browser);
  try {
    const aliceEmail = `private-switch-a-${Date.now()}@example.org`; await signUp(owner.page, aliceEmail); const trip = await createTrip(owner.page);
    await signUp(guest.page, `private-switch-b-${Date.now()}@example.org`); await joinTrip(owner.page, guest.page, trip.path);
    await frozen(owner.page); await navigate(owner.page, '/'); const alicePath = await addPrivate(owner.page, trip.path, 'AUTHOR A PRIVATE CANARY', 'A committed secret'); await scheduled(owner.page);
    const a = await durable(owner.page, trip.id);
    await frozen(guest.page); await navigate(guest.page, '/'); const bobPath = await addPrivate(guest.page, trip.path, 'AUTHOR B PRIVATE CANARY', 'B independent secret'); await scheduled(guest.page); const b = await durable(guest.page, trip.id);
    expect(b.vault).not.toBe(a.vault);
    const secondContext = await browser.newContext({ storageState: await owner.context.storageState() });
    try {
      const second = await device(secondContext, owner.page, trip.id);
      await second.evaluate(async () => { const w = (window as any).privateWork; await w.save({ title: 'A UNSENT CANARY', tags: [], content: { kind: 'document', markdown: 'Must clear on sign-out' }, attachments: [] }); });
      await navigate(owner.page, alicePath); await expect(owner.page.getByRole('heading', { name: 'AUTHOR A PRIVATE CANARY', exact: true })).toBeVisible();
      const trace = observe(owner.page); await owner.page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(owner.page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
      expect(await owner.page.locator('main').textContent()).not.toContain('AUTHOR A PRIVATE CANARY'); await expect(owner.page.locator('#private-viewer, #private-versions, #private-count')).toHaveCount(0);

      const signedOutKeys = await adapterPage(owner.context);
      expect(await signedOutKeys.evaluate(async () => (window as any).Stage3.restorePersonKeys())).toBeNull(); await signedOutKeys.close();
      await owner.page.clock.runFor(600_000); expect(trace).toEqual([]);
      await second.evaluate(async () => { await (window as any).Stage3.clearPersonKeys(); });
      expect(await second.evaluate(async () => (window as any).Stage3.restorePersonKeys())).toBeNull();
      expect(await second.evaluate(() => (window as any).Stage3.getPersonKeys())).toBeNull();
      await expect(second.evaluate(() => (window as any).privateWork.copies('all'))).rejects.toThrow('locked');
      await expect(second.evaluate(() => (window as any).privateWork.vault.agentContentIdentity)).rejects.toThrow('locked');
      await second.clock.runFor(600_000);
      // Switch cookies in the SAME IndexedDB profile. Same-key device seam below
      // transfers B's existing keys, never A's vault or a fabricated vault ID.
      await owner.context.addCookies((await guest.context.storageState()).cookies);
      const bobDevice = await device(owner.context, guest.page, trip.id);
      expect(await bobDevice.evaluate(async () => { const w = (window as any).privateWork; return (await Promise.all((await w.copies('all')).map((c: any) => w.content(c)))).map((p: any) => p.title); })).toEqual(['AUTHOR B PRIVATE CANARY']);
      const bobNow = await durable(guest.page, trip.id); expect(bobNow.vault).toBe(b.vault); expect(bobNow.branches[0]!.bundle.records).toEqual(b.branches[0]!.bundle.records);
      // A known A copy route must not show A's body or count to B.
      await owner.page.goto(alicePath); await expect(owner.page.locator('main > [role="alert"]')).toContainText('Private copy unavailable'); expect(await owner.page.locator('main').textContent()).not.toContain('AUTHOR A PRIVATE CANARY');
      await navigate(owner.page, bobPath); await expect(owner.page.getByRole('heading', { name: 'AUTHOR B PRIVATE CANARY', exact: true })).toBeVisible(); expect(await owner.page.locator('main').textContent()).not.toContain('AUTHOR A PRIVATE CANARY');
      await bobDevice.evaluate(() => (window as any).Stage3.closePrivateVaults());
      // The real logout revoked A's copied cookie in every profile. Sign A back
      // in with the existing passkey rather than reviving that revoked session.
      await owner.page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(owner.page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
      await owner.page.getByLabel('Email address', { exact: true }).fill(aliceEmail); await owner.page.getByRole('button', { name: 'Send sign-in link', exact: true }).click(); await expect(owner.page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible();
      const message = await (await owner.page.request.get(`/__test/email?address=${encodeURIComponent(aliceEmail)}`)).json();
      await owner.page.goto(/https?:\/\/[^\s]+#token=[A-Za-z0-9_-]+/.exec(message.text)![0]!); await owner.page.getByRole('button', { name: 'Sign in with passkey', exact: true }).click(); await expect(owner.page.getByRole('heading', { name: 'A place to find your way', exact: true })).toBeVisible();
      const aliceContext = await browser.newContext({ storageState: await owner.context.storageState() });
      try { const aliceAgain = await device(aliceContext, owner.page, trip.id); expect(await aliceAgain.evaluate(async () => (await (window as any).privateWork.copies('all')).length)).toBe(1); } finally { await aliceContext.close(); }
    } finally { await secondContext.close(); }
  } finally { await owner.context.close(); await guest.context.close(); }
});


for (const mode of ['higher', 'delete', 'live-against-delete'] as const) {
  test(`verified same-vault fork merge selects ${mode} from durable histories and preserves it on a second device`, async ({ browser }) => {
    test.setTimeout(300_000); const owner = await browserPerson(browser), scratch = resolve('../../.scratch/private-merge-' + mode + '-' + Date.now()); await mkdir(scratch, { recursive: true });
    try {
      await signUp(owner.page, `private-merge-${mode}-${Date.now()}@example.org`); await frozen(owner.page); const trip = await createTrip(owner.page);
      const path = await addPrivate(owner.page, trip.path, 'MERGE PRIVATE CANARY', 'LOWER ARTIFACT VERSION'); await scheduled(owner.page);
      const created = await durable(owner.page, trip.id); await expect.poll(async () => (await firstDeviceCheckpoint(owner.page, created.vault, created.current.secrets.identity)).head).toBe(created.head);
      if (mode === 'live-against-delete') { owner.page.once('dialog', d => { void d.accept(); }); await owner.page.getByRole('button', { name: 'Delete private artifact', exact: true }).click(); await expect(owner.page).toHaveURL(trip.path + '/private'); await scheduled(owner.page); }
      const saved = await durable(owner.page, trip.id), { changed, ...fork } = await forkSnapshot(saved, 'HIGHER ARTIFACT VERSION', mode);
      const checkpoint = await firstDeviceCheckpoint(owner.page, saved.vault, saved.current.secrets.identity);
      expect(checkpoint.head).toBe(saved.head); expect(fork.checkpoint.version).toBe(checkpoint.version); expect(fork.checkpoint.head).not.toBe(checkpoint.head);
      await navigate(owner.page, trip.path + '/private/backup');
      const put = await owner.page.request.put(`/v1/journeys/${trip.id}/private-vault`, { headers: { ...headers, 'X-Principal': saved.current.actor, 'X-Wayfinding': '1', Origin: new URL(owner.page.url()).origin, 'Content-Type': 'application/octet-stream' }, data: Buffer.from(encodeVaultPatch({ token: saved.snapshot.token, frame: fork.frame, slots: [changed, (changed + 1) % 64].map(index => ({ index, ciphertext: fork.slots[index]! })) })) }); expect(put.status()).toBe(200);
      const remote = await durable(owner.page, trip.id); expect(remote.head).toBe(fork.checkpoint.head);
      const remoteCopy = privateCopies(remote.branches[0]!.view)[0]!;
      expect(remoteCopy.deleted).toBe(mode === 'delete'); expect(remoteCopy.records.filter(r => r.type === 'private.create' || r.type === 'private.version')).toHaveLength(mode === 'higher' ? 2 : mode === 'delete' ? 1 : 3);
      await writeFile(scratch + '/fork.json', JSON.stringify(fork)); await owner.page.getByLabel('Encrypted device snapshot JSON').setInputFiles(scratch + '/fork.json'); await owner.page.getByRole('button', { name: 'Merge verified device histories', exact: true }).click();
      await expect(owner.page.getByRole('heading', { name: 'Author-private artifacts', exact: true })).toBeVisible(); await scheduled(owner.page);
      const merged = await durable(owner.page, trip.id); expect(merged.snapshot.checkpoint.version).toBe(saved.snapshot.checkpoint.version + 1); expect(merged.snapshot.checkpoint.prev).toBe(remote.head); expect(merged.branches).toHaveLength(1);

      await expect.poll(async () => (await firstDeviceCheckpoint(owner.page, merged.vault, merged.current.secrets.identity)).head).toBe(merged.head); await navigate(owner.page, trip.path + '/private');
      const winner = privateCopies(merged.branches[0]!.view)[0]!;
      if (mode === 'higher') {
        expect(winner.records.map(r => r.type)).toEqual(['private.create', 'private.version']); expect(winner.head).toBe(remoteCopy.head);
        await navigate(owner.page, path); await expect(owner.page.locator('#private-viewer')).toContainText('HIGHER ARTIFACT VERSION');
      } else {
        expect(winner.deleted).toBe(true); expect(winner.records.at(-1)!.type).toBe('private.delete');
        expect(winner.records).toEqual(mode === 'delete' ? remoteCopy.records : privateCopies(saved.branches[0]!.view)[0]!.records);
        await expect(owner.page.locator('#private-count')).toHaveText('0 matching author-private artifacts');
        await navigate(owner.page, path); await expect(owner.page.locator('main > [role="alert"]')).toContainText('Private copy unavailable'); await expect(owner.page.locator('#private-viewer')).toHaveCount(0);
      }
      const secondContext = await browser.newContext({ storageState: await owner.context.storageState() });
      try {
        const second = await device(secondContext, owner.page, trip.id, { ...merged.snapshot.checkpoint, freshness: 'paired' });
        expect(await second.evaluate(() => (window as any).privateWork.vault.branches.map((b: any) => b.bundle.records))).toEqual([winner.records]);
        const copies = await second.evaluate(async () => (await (window as any).privateWork.copies('all')).map((c: any) => ({ copy: c.copy, head: c.head })));
        expect(copies).toEqual(mode === 'higher' ? [{ copy: winner.copy, head: winner.head }] : []);
        const reopened = await durable(owner.page, trip.id); expect(privateCopies(reopened.branches[0]!.view)[0]!.records).toEqual(winner.records); expect(reopened.snapshot.checkpoint.version).toBe(merged.snapshot.checkpoint.version + 1);
      } finally { await secondContext.close(); }
    } finally { await owner.context.close(); await rm(scratch, { recursive: true, force: true }); }
  });
}


test('injected random slots and failed empty/populated commits keep exactly the matched five-minute retry schedule', async ({ browser }) => {
  test.setTimeout(300_000); const owner = await browserPerson(browser);
  try {
    await signUp(owner.page, `private-random-retry-${Date.now()}@example.org`); await frozen(owner.page); const emptyTrip = await createTrip(owner.page, 'Empty retry journey');
    await navigate(owner.page, '/'); const populatedTrip = await createTrip(owner.page, 'Populated retry journey');
    await addPrivate(owner.page, populatedTrip.path, 'RETRY PRIVATE CANARY', 'Committed before matched failure'); await scheduled(owner.page);
    const baseline = await durable(owner.page, populatedTrip.id), emptyBefore = await durable(owner.page, emptyTrip.id);
    await navigate(owner.page, '/'); const context = await browser.newContext({ storageState: await owner.context.storageState() }), populatedContext = await browser.newContext({ storageState: await owner.context.storageState() });
    try {
      const empty = await device(context, owner.page, emptyTrip.id), populated = await device(populatedContext, owner.page, populatedTrip.id);
      const starts = [await deterministicVault(empty), await deterministicVault(populated)];
      const pages = [empty, populated], trips = [emptyTrip, populatedTrip];
      const trace = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).traffic);
      const shape = (rows: any[], start: number, id: string, actor: string) => rows.map(r => ({ at: r.at - start, method: r.method, path: r.path.replace(id, 'journey'), indices: r.indices, requestBytes: r.requestBytes, requestHeaders: { ...r.requestHeaders, 'X-Principal': r.requestHeaders['X-Principal'] === actor ? 'author' : r.requestHeaders['X-Principal'] }, status: r.status, responseBytes: r.responseBytes, responseHeaders: Object.fromEntries(Object.entries(r.responseHeaders).filter(([name]) => name !== 'date')) }));
      const initial = await Promise.all(pages.map(trace));
      for (const rows of initial) { expect(rows.map((r: any) => r.method)).toEqual(['GET', 'PUT']); expect(rows[0].indices).toBe('47,12'); expect(rows[1].indices).toEqual([47, 12]); }
      const before = [await durable(owner.page, emptyTrip.id), await durable(owner.page, populatedTrip.id)];
      // Same HTTP failure for both real scheduled writes. No alternate save or
      // forced tick is used to retry; the portable controller owns its timer.
      for (const page of pages) await page.route('**/private-vault', route => route.request().method() === 'PUT' ? route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":{"code":"conflict"}}' }) : route.continue());
      for (const page of pages) {
        await page.clock.runFor(299_999); expect((await trace(page)).length).toBe(2);
        const failed = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/private-vault'));
        await page.clock.runFor(1); expect((await failed).status()).toBe(409); await expect.poll(async () => (await trace(page)).at(-1).status).toBe(409);
        const rows = await trace(page); expect(rows.at(-2).indices).toBe('31,06'); expect(rows.at(-1).indices).toEqual([31, 6]);

        await expect.poll(() => page.evaluate(() => (window as any).trafficVault.busy)).toBe(false);
        await page.clock.runFor(299_999); expect((await trace(page)).length).toBe(4);
      }
      for (let i = 0; i < pages.length; i++) { const held = await durable(owner.page, trips[i]!.id); expect(held.head).toBe(before[i]!.head); expect(held.snapshot.token).toBe(before[i]!.snapshot.token); await pages[i]!.unroute('**/private-vault'); }
      for (const page of pages) {
        const retried = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/private-vault'));
        await page.clock.runFor(1); expect((await retried).status()).toBe(200);
        await expect.poll(() => page.evaluate(() => (window as any).trafficVault.retainedCheckpoint.version)).toBe(before[pages.indexOf(page)]!.snapshot.checkpoint.version + 1);

        await expect.poll(() => page.evaluate(() => (window as any).trafficVault.busy)).toBe(false);
        const rows = await trace(page); expect(rows.at(-2).indices).toBe('55,18'); expect(rows.at(-1).indices).toEqual([55, 18]);
        await page.clock.runFor(299_999); expect((await trace(page)).length).toBe(6);
        const next = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/private-vault'));
        await page.clock.runFor(1); expect((await next).status()).toBe(200);
        await expect.poll(() => page.evaluate(() => (window as any).trafficVault.retainedCheckpoint.version)).toBe(before[pages.indexOf(page)]!.snapshot.checkpoint.version + 2);

        await expect.poll(() => page.evaluate(() => (window as any).trafficVault.busy)).toBe(false);
        const final = await trace(page); expect(final.at(-2).indices).toBe('24,03'); expect(final.at(-1).indices).toEqual([24, 3]);
      }
      const final = await Promise.all(pages.map(trace));
      expect(shape(final[0], starts[0]!, emptyTrip.id, emptyBefore.current.actor)).toEqual(shape(final[1], starts[1]!, populatedTrip.id, baseline.current.actor));
      expect(final[0].map((r: any) => [r.at - starts[0]!, r.method, r.requestBytes, r.responseBytes, r.status])).toEqual([[0, 'GET', 0, 2_129_987, 200], [0, 'PUT', 2_129_986, 76, 200], [300_000, 'GET', 0, 2_129_987, 200], [300_000, 'PUT', 2_129_986, 29, 409], [600_000, 'GET', 0, 2_129_987, 200], [600_000, 'PUT', 2_129_986, 76, 200], [900_000, 'GET', 0, 2_129_987, 200], [900_000, 'PUT', 2_129_986, 76, 200]]);
      const emptyAfter = await durable(owner.page, emptyTrip.id), populatedAfter = await durable(owner.page, populatedTrip.id);
      expect(emptyAfter.branches).toEqual([]); expect(populatedAfter.branches[0]!.bundle.records).toEqual(baseline.branches[0]!.bundle.records); expect(populatedAfter.branches[0]!.bundle.payloads[0]!.payload.body.title).toBe('RETRY PRIVATE CANARY');
      for (const page of pages) await page.evaluate(() => (window as any).trafficVault.close());
    } finally { await context.close(); await populatedContext.close(); }
  } finally { await owner.context.close(); }
});
