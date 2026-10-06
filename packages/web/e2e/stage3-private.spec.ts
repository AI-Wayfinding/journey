import { expect, test } from '@playwright/test';
import { importArtifactJourney, privateCopies, createAgeIdentity, importPrivateBundle, answerPrivateChallenge, privateIdentity, openIdentity, encodeVaultPatch } from '@ai-wayfinding/core';
import { requestAgent } from './agent.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserPerson, signUp } from './person.js';
import { createTrip, downloadBytes, joinTrip } from './stage1-fixtures.js';
import { addPrivate, durable, frozen, scheduled, device, observe, headers, controls, change, principal, navigate, firstDeviceCheckpoint, signedAgent, forkSnapshot } from './stage3-fixtures.js';

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


test('own authenticated read-only agent gets its wrap and possession handoff but cannot PUT; person records returned work', async ({ browser, request }) => {
  test.setTimeout(300_000);
  const owner = await browserPerson(browser);
  try {
    await signUp(owner.page, `private-agent-${Date.now()}@example.org`); await frozen(owner.page); const trip = await createTrip(owner.page);
    const agent = await requestAgent(request, trip.id, 'Private reader');
    await navigate(owner.page, new URL(agent.approvalUrl).pathname); await owner.page.getByLabel('Six-digit code').fill(agent.code); await owner.page.getByLabel('Access', { exact: true }).selectOption('read');
    await owner.page.getByRole('button', { name: 'Confirm with passkey', exact: true }).click(); await expect(owner.page.getByRole('heading', { name: 'Agent approved' })).toBeVisible();
    const path = await addPrivate(owner.page, trip.path, 'SCOPED AGENT INPUT', 'The person owns this content'); await scheduled(owner.page); const saved = await durable(owner.page, trip.id);
    const wrap = await signedAgent(owner.page, agent, 'GET', `/v1/journeys/${trip.id}/private-agent-wrap/${agent.principal}`); expect(wrap.status()).toBe(200); expect(JSON.stringify(await wrap.json())).not.toContain('SCOPED AGENT INPUT');
    const read = await signedAgent(owner.page, agent, 'GET', `/v1/journeys/${trip.id}/private-vault?slots=00,01`); expect(read.status()).toBe(200); expect((await read.body()).length).toBe(2_129_987); await read.dispose();
    const denied = await signedAgent(owner.page, agent, 'PUT', `/v1/journeys/${trip.id}/private-vault`, encodeVaultPatch({ token: saved.snapshot.token, frame: saved.snapshot.frame, slots: [0, 1].map(index => ({ index, ciphertext: saved.snapshot.slots[index]! })) })); expect(denied.status()).toBe(403); expect((await durable(owner.page, trip.id)).head).toBe(saved.head);
    await owner.page.getByRole('button', { name: 'Create one-use possession challenge', exact: true }).click();
    await expect(owner.page.locator('#private-challenge')).not.toBeEmpty(); const challenge = JSON.parse((await owner.page.locator('#private-challenge').textContent())!);
    const response = await answerPrivateChallenge(challenge, agent.signingPrivateKey, agent.identity);
    await owner.page.getByLabel('Agent possession response JSON').fill(JSON.stringify(response)); const downloading = owner.page.waitForEvent('download'); await owner.page.getByRole('button', { name: 'Download scoped encrypted handoff', exact: true }).click();
    const ciphertext = (await downloadBytes(await downloading)).toString(); expect(ciphertext).not.toContain('SCOPED AGENT INPUT');
    const opened = JSON.parse(await openIdentity(ciphertext, [agent.identity])); expect(opened.scope).toBe('agent-handoff'); expect(opened.payloads[0].payload.body.title).toBe('SCOPED AGENT INPUT'); expect(opened.author).toEqual(saved.author);
    await expect(openIdentity(ciphertext, [saved.current.secrets.identity])).rejects.toThrow();
    await owner.page.getByRole('button', { name: 'Download scoped encrypted handoff', exact: true }).click(); await expect(owner.page.locator('main > [role="alert"]')).toContainText('Create a fresh local challenge first');
    expect((await durable(owner.page, trip.id)).head).toBe(saved.head);
    await navigate(owner.page, path + '/edit'); await owner.page.getByLabel('Private body', { exact: true }).fill('Reviewed agent result, recorded by the person'); await owner.page.getByRole('button', { name: 'Save private artifact', exact: true }).click(); await expect(owner.page).toHaveURL(path); await scheduled(owner.page);
    const result = await durable(owner.page, trip.id); expect(privateCopies(result.branches[0]!.view)[0]!.records.at(-1)!.actor).toEqual(saved.author); expect(result.branches[0]!.bundle.payloads.at(-1)!.payload.body.content).toEqual({ kind: 'document', markdown: 'Reviewed agent result, recorded by the person' });
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
