import { expect, test } from '@playwright/test';
import { importArtifactJourney, privateCopies, createAgeIdentity, importPrivateBundle } from '@ai-wayfinding/core';
import { browserPerson, signUp } from './person.js';
import { createTrip, downloadBytes, joinTrip } from './stage1-fixtures.js';
import { addPrivate, durable, frozen, scheduled, device, observe, headers, controls, change, principal, navigate } from './stage3-fixtures.js';

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
      const paired = { ...saved.snapshot.checkpoint, freshness: 'paired' as const };
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
