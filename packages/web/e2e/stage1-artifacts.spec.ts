import { expect, test, type Page } from '@playwright/test';
import { createAgeIdentity, importArtifactJourney, type Member } from '@ai-wayfinding/core';
import { browserPerson, signUp } from './person.js';
import { change, controls, createTrip, downloadBytes, headers, joinTrip, personSecrets, principal } from './stage1-fixtures.js';

async function add(page: Page, path: string, type: string, title: string, body = 'Private artifact text') {
  await page.goto(path + '/add'); await page.getByLabel('Type', { exact: true }).selectOption(type);
  await page.getByLabel('Title', { exact: true }).fill(title);
  if (!['file', 'image', 'link'].includes(type)) await page.locator('#artifact-body').fill(body);
  if (type === 'link') { await page.getByLabel('URL', { exact: true }).fill('https://example.org/private'); await page.getByLabel('Summary', { exact: true }).fill('Supplied summary'); await page.getByLabel('Notes', { exact: true }).fill('Private notes'); }
}
async function saveReload(page: Page, title: string) {
  await page.getByRole('button', { name: 'Save artifact', exact: true }).click();
  await expect(page).toHaveURL(/\/artifacts\/[0-9A-Z]+$/); await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  return new URL(page.url()).pathname;
}

test('stored supported types, tags, signed attribution, versions, whole-artifact comments, conflicts, files, deletion and encrypted export', async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await browserPerson(browser), guest = await browserPerson(browser);
  try {
    await signUp(owner.page, `artifact-owner-${Date.now()}@example.org`);
    await signUp(guest.page, `artifact-guest-${Date.now()}@example.org`);
    const trip = await createTrip(owner.page), ownerId = await principal(owner.page, trip.id);
    const secret = Buffer.from('PRIVATE attachment bytes\0\xff');
    const paths = new Map<string, string>();
    for (const type of ['skill','prompt','document','image','file','data','link']) {
      const title = `Stored ${type}`; await add(owner.page, trip.path, type, title);
      await expect(owner.page.locator('#artifact-type option')).toHaveCount(7);
      await expect(owner.page.locator('#authored-by')).toHaveCount(0);
      await owner.page.getByLabel('Tags (comma-separated)').fill('Custom, Custom, custom');
      await owner.page.getByRole('button', { name: 'decision', exact: true }).click();
      await owner.page.getByRole('button', { name: 'decision', exact: true }).click();
      await expect(owner.page.getByLabel('Tags (comma-separated)')).toHaveValue('Custom, custom, decision');
      if (type !== 'link' && type !== 'data') await owner.page.getByLabel('Add attachments').setInputFiles({ name: 'private.bin', mimeType: 'application/octet-stream', buffer: secret });
      if (type === 'skill') await owner.page.getByLabel('Package paths').fill('scripts/private.bin');
      const path = await saveReload(owner.page, title); paths.set(type, path);
      await expect(owner.page.locator('#artifact-author')).toContainText(ownerId);
      await expect(owner.page.locator('#versions')).toContainText('Writer: Person · ' + ownerId);
      await expect(owner.page.getByText('Tags: Custom, custom, decision', { exact: true }).first()).toBeVisible();
      if (type !== 'link' && type !== 'data') {
        const downloading = owner.page.waitForEvent('download'); await owner.page.getByRole('button', { name: 'Download private.bin', exact: true }).first().click();
        const download = await downloading; expect(download.suggestedFilename()).toBe('private.bin'); expect(await downloadBytes(download)).toEqual(secret);
      }
    }
    // A hostile response must not turn corrupted bytes into a download.
    await owner.page.goto(paths.get('file')!);
    let unexpectedDownloads = 0;
    const countDownload = () => { unexpectedDownloads++; };
    owner.page.on('download', countDownload);
    await owner.page.route('**/v1/journeys/*/blobs/*', async route => {
      const response = await route.fetch(), bytes = await response.body(); bytes[0] = bytes[0]! ^ 1;
      await route.fulfill({ response, body: bytes });
    });
    await owner.page.getByRole('button', { name: 'Download private.bin', exact: true }).first().click();
    await expect(owner.page.getByRole('alert')).toContainText('Invalid blob ciphertext digest');
    expect(unexpectedDownloads).toBe(0);
    await owner.page.unroute('**/v1/journeys/*/blobs/*'); owner.page.off('download', countDownload);
    await owner.page.goto(trip.path); await owner.page.reload();
    await expect(owner.page.locator('#artifacts .card')).toHaveCount(7);
    await expect(owner.page.getByText('Recovery recipient', { exact: true })).toHaveCount(0);
    await owner.page.getByLabel('Search your artifacts').fill('recovery'); await expect(owner.page.locator('#artifacts .card')).toHaveCount(0);
    await owner.page.getByLabel('Search your artifacts').fill(''); await owner.page.getByLabel('Filter by type').selectOption('prompt'); await expect(owner.page.locator('#artifacts .card')).toHaveCount(1);
    await expect(owner.page.locator('header .brand')).toHaveText('AI Wayfinding Journeys');
    await expect(owner.page.locator('footer')).toContainText('Wayfinding is how you move when the destination is uncertain.');
    await joinTrip(owner.page, guest.page, trip.path);
    const guestId = await principal(guest.page, trip.id), documentPath = paths.get('document')!;
    await guest.page.goto(documentPath + '/edit'); await expect(guest.page.getByLabel('Type', { exact: true })).toBeDisabled();
    await guest.page.getByLabel('Title', { exact: true }).fill('Written by second person');
    await guest.page.locator('#artifact-body').fill('Second version'); await saveReload(guest.page, 'Written by second person');
    await expect(guest.page.locator('#artifact-author')).toContainText(ownerId); await expect(guest.page.locator('#artifact-author')).not.toContainText(guestId);
    await expect(guest.page.locator('#versions > li')).toHaveCount(2);
    await expect(guest.page.locator('#versions > li').last()).toContainText('Writer: Person · ' + guestId);
    const downloading = guest.page.waitForEvent('download'); await guest.page.getByRole('button', { name: 'Download private.bin' }).first().click(); expect(await downloadBytes(await downloading)).toEqual(secret);
    await guest.page.getByLabel('Add a comment').fill('Whole-artifact comment'); await guest.page.getByRole('button', { name: 'Add comment', exact: true }).click();
    await expect(guest.page.locator('#comments')).toContainText('Whole-artifact comment'); await guest.page.reload();
    await expect(guest.page.locator('#comments')).toContainText('Writer: Person · ' + guestId);
    // Both edit screens start from the same stored predecessor. The stale form must not silently win.
    await owner.page.goto(documentPath + '/edit'); await guest.page.goto(documentPath + '/edit');
    await owner.page.locator('#artifact-body').fill('Winning version'); await saveReload(owner.page, 'Written by second person');
    await guest.page.locator('#artifact-body').fill('Losing stale version'); await guest.page.getByRole('button', { name: 'Save artifact' }).click();
    await expect(guest.page.getByRole('alert')).toContainText('Something changed while you were working. Reload and try again.');
    await owner.page.reload(); await expect(owner.page.locator('#versions > li')).toHaveCount(3); await expect(owner.page.locator('#versions')).not.toContainText('Losing stale version');
    const rows = await controls(owner.page, trip.id);
    expect(rows.filter(c => c.proof.type.startsWith('artifact.')).every(c => !JSON.stringify(c.proof).includes('PRIVATE') && !JSON.stringify(c.proof).includes('private.bin'))).toBe(true);
    const deletedPath = paths.get('file')!, deletedId = deletedPath.split('/').at(-1)!;
    const deletedBlob = (rows.find(c => c.proof.body.artifact === deletedId)!.proof.body.blobs as { id: string }[])[0]!.id;
    await owner.page.goto(deletedPath);
    owner.page.once('dialog', dialog => { expect(dialog.message()).toContain('retained history, not secure erasure'); expect(dialog.message()).toContain('Previously downloaded copies cannot be recalled'); void dialog.accept(); });
    await owner.page.getByRole('button', { name: 'Delete artifact' }).click(); await expect(owner.page).toHaveURL(trip.path); await owner.page.reload();
    await expect(owner.page.locator('#artifacts .card')).toHaveCount(6); await expect(owner.page.getByRole('link', { name: 'Stored file', exact: true })).toHaveCount(0);
    expect((await owner.page.request.get(`/v1/journeys/${trip.id}/blobs/${deletedBlob}`, { headers: { ...headers, 'X-Principal': ownerId } })).status()).toBe(404);
    await owner.page.goto(trip.path + '/export'); await expect(owner.page.getByText(/Deleted artifacts retain signed proofs/)).toBeVisible();
    const secrets = await personSecrets(owner.page), recovery = await createAgeIdentity(); await owner.page.getByLabel('Recovery recipient').fill(recovery.recipient);
    const exporting = owner.page.waitForEvent('download'); await owner.page.getByRole('button', { name: 'Download encrypted export' }).click();
    const bytes = await downloadBytes(await exporting), ciphertext = bytes.toString(); expect(ciphertext).not.toContain('Winning version'); expect(ciphertext).not.toContain('private.bin');
    const trust = { journey: trip.id, creator: rows[0]!.proof.body.creator as Member };
    const archive = await importArtifactJourney(ciphertext, [secrets.identity], trust);
    const backup = await importArtifactJourney(ciphertext, [recovery.identity], trust);
    expect(backup.state.lastHash).toBe(archive.state.lastHash); expect(archive.archive.unavailableDeletedBlobs).toContain(deletedBlob);
    expect(archive.archive.blobs).toHaveLength(4); expect(archive.state.artifacts!.items[deletedId]!.deleted).toBe(true);
    expect(owner.requests.concat(guest.requests).every(url => new URL(url).hostname === 'localhost')).toBe(true);
  } finally { await owner.context.close(); await guest.context.close(); }
});

test('inclusive exact-limit and zero-byte files survive reload; oversized files are rejected before staging', async ({ browser }) => {
  test.setTimeout(240_000); const person = await browserPerson(browser);
  try {
    await signUp(person.page, `artifact-limits-${Date.now()}@example.org`); const trip = await createTrip(person.page);
    for (const size of [0, 25_000_000]) {
      const bytes = Buffer.alloc(size, 83); await add(person.page, trip.path, 'file', `Bytes ${size}`);
      await person.page.getByLabel('Add attachments').setInputFiles({ name: `size-${size}.bin`, mimeType: 'application/octet-stream', buffer: bytes });
      await saveReload(person.page, `Bytes ${size}`);
      const downloading = person.page.waitForEvent('download'); await person.page.getByRole('button', { name: `Download size-${size}.bin`, exact: true }).first().click(); expect(await downloadBytes(await downloading)).toEqual(bytes);
      const rows = await controls(person.page, trip.id), blob = (rows.at(-1)!.proof.body.blobs as { id: string; size: number; ciphertextSize: number }[])[0]!;
      expect(blob.size).toBe(size); expect(blob.ciphertextSize).toBe(size + 16);
    }
    await add(person.page, trip.path, 'file', 'Must not save');
    await person.page.getByLabel('Add attachments').setInputFiles({ name: 'oversize.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(25_000_001) });
    const before = (await controls(person.page, trip.id)).length, stages: string[] = [];
    person.page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/blobs')) stages.push(r.url()); });
    await person.page.getByRole('button', { name: 'Save artifact' }).click(); await expect(person.page.getByRole('alert')).toContainText('25,000,000 bytes');
    expect(stages).toEqual([]); expect((await controls(person.page, trip.id)).length).toBe(before);
    await person.page.goto(trip.path); await person.page.reload(); await expect(person.page.locator('#artifacts .card')).toHaveCount(2);
  } finally { await person.context.close(); }
});

test('downgrade and pending rotation stop staged uploads and writes; signed newer minimum clears stored content', async ({ browser }) => {
  test.setTimeout(240_000); const owner = await browserPerson(browser), guest = await browserPerson(browser);
  try {
    await signUp(owner.page, `artifact-access-${Date.now()}@example.org`); await signUp(guest.page, `artifact-access-guest-${Date.now()}@example.org`);
    let removableAgent: string | undefined;
    const trip = await createTrip(owner.page); await add(owner.page, trip.path, 'document', 'Existing artifact'); const storedPath = await saveReload(owner.page, 'Existing artifact');
    await joinTrip(owner.page, guest.page, trip.path); const guestId = await principal(guest.page, trip.id);
    for (const operation of ['downgrade','rotation']) {
      await add(guest.page, trip.path, 'file', 'Blocked ' + operation); await guest.page.getByLabel('Add attachments').setInputFiles({ name: 'staged.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('staged private bytes') });
      let staged!: () => void, resume!: () => void;
      const waiting = new Promise<void>(r => { staged = r; }), released = new Promise<void>(r => { resume = r; });
      let blobId = ''; const statuses: number[] = [];
      guest.page.on('response', r => { if (r.request().method() === 'PUT' && r.url().includes('/blobs/')) statuses.push(r.status()); });
      await guest.page.route('**/v1/journeys/*/blobs/*', async route => {
        if (route.request().method() !== 'PUT') return route.continue();
        blobId = route.request().url().split('/').at(-1)!; staged(); await released; await route.continue();
      });
      await guest.page.getByRole('button', { name: 'Save artifact' }).click(); await waiting;
      try {
        if (operation === 'downgrade') await change(owner.page, trip.id, 'member.role', { member: guestId, role: 'read-only' });
        else {
          // Remove a test agent without visiting the browser's auto-rotation screen.
          await change(owner.page, trip.id, 'member.remove', { member: removableAgent! });
        }
      } finally { resume(); }
      await expect(guest.page.getByRole('alert')).toContainText("You don't have access"); expect(statuses.at(-1)).toBe(403);
      await guest.page.unroute('**/v1/journeys/*/blobs/*');
      const denied = await guest.page.request.get(`/v1/journeys/${trip.id}/blobs/${blobId}`, { headers: { ...headers, 'X-Principal': guestId } }); expect(denied.status()).toBe(404);
      if (operation === 'downgrade') {
        await guest.page.goto(storedPath); await guest.page.reload(); await expect(guest.page.getByRole('link', { name: 'Edit artifact' })).toHaveCount(0); await expect(guest.page.getByLabel('Add a comment')).toHaveCount(0);
        await owner.page.goto(trip.path + '/members'); await owner.page.locator(`[data-role="${guestId}"]`).click(); await expect(owner.page.locator(`[data-role="${guestId}"]`)).toHaveText('Make read-only');
        await owner.page.getByLabel('Agent name').fill('Removal fixture'); await owner.page.getByRole('button', { name: 'Create link with passkey' }).click(); await owner.page.getByRole('button', { name: 'Done', exact: true }).click();
        removableAgent = (await owner.page.locator('[data-rename]').getAttribute('data-rename'))!;
      }
    }
    await guest.page.goto(storedPath); await guest.page.reload(); await expect(guest.page.getByRole('link', { name: 'Edit artifact' })).toHaveCount(0);
    await guest.page.goto(trip.path + '/add'); await expect(guest.page.getByRole('alert')).toContainText('key update is pending');
    await owner.page.goto(trip.path); await expect(owner.page.getByRole('heading', { name: 'Artifacts journey', exact: true })).toBeVisible(); // guide finishes rotation
    await change(owner.page, trip.id, 'client.minVersion', { version: '0.1.6' });
    await guest.page.goto(trip.path); await expect(guest.page.getByRole('heading', { name: 'Update Wayfinding' })).toBeVisible(); await expect(guest.page.getByRole('alert')).toContainText('do not ask for approval again');
    await expect(guest.page.getByText('Existing artifact', { exact: true })).toHaveCount(0);
  } finally { await owner.context.close(); await guest.context.close(); }
});
