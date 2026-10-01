import { expect, test, type Page } from '@playwright/test';
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { browserPerson, signUp } from './person.js';
import { createTrip, downloadBytes } from './stage1-fixtures.js';

async function artifact(page: Page, path: string, type: string, title: string, text = '', format = 'json', attachment?: Buffer) {
  await page.goto(path + '/add'); await page.getByLabel('Type', { exact: true }).selectOption(type);
  await page.getByLabel('Title', { exact: true }).fill(title);
  if (type === 'data') await page.getByLabel('Data format', { exact: true }).selectOption(format);
  if (['document', 'data'].includes(type)) await page.locator('#artifact-body').fill(text);
  if (attachment) await page.getByLabel('Add attachments').setInputFiles({ name: title, mimeType: 'application/octet-stream', buffer: attachment });
  await page.getByRole('button', { name: 'Save artifact', exact: true }).click();
  await expect(page).toHaveURL(/\/artifacts\/[0-9A-Z]+$/); await page.reload();
  await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
}
async function original(page: Page, expected: Buffer, name?: string) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: name ? 'Download ' + name : 'Download original text', exact: true }).first().click();
  expect(await downloadBytes(await event)).toEqual(expected);
}

test('local workers render all data formats, bound hostile inputs, cancel, and preserve original bytes without remote requests', async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await browserPerson(browser), external: string[] = [];
  await owner.context.route('**/*', async route => {
    if (new URL(route.request().url()).hostname !== 'localhost') { external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  try {
    await signUp(owner.page, `viewer-data-${Date.now()}@example.org`); const trip = await createTrip(owner.page);
    const host = owner.page.locator('#artifact-viewer');
    for (const [format, text] of [['json', '{"name":"local","__proto__":{"polluted":true}}'], ['toml', 'name = "local"'], ['yaml', 'name: local']]) {
      await artifact(owner.page, trip.path, 'data', 'Structured ' + format, text, format);
      await expect(host.getByRole('status')).toContainText('Local view'); await expect(host.locator('pre')).toContainText('local');
      await original(owner.page, Buffer.from(text));
    }
    const csv = Array.from({ length: 101 }, (_, i) => 'c' + i).join(',') + '\n' + Array(101).fill(['=1+1', '@SUM(1)', '+CMD', '-2', '<img src=https://evil.example/x>', ...Array(96).fill('x')].join(',')).join('\n');
    await artifact(owner.page, trip.path, 'data', 'Bounded CSV', csv, 'csv');
    await expect(host.locator('tbody tr')).toHaveCount(100); await expect(host.locator('thead th')).toHaveCount(100);
    await expect(host.getByRole('status')).toContainText('Truncated'); await expect(host.locator('td').first()).toHaveText('=1+1'); await expect(host.locator('img')).toHaveCount(0);
    await original(owner.page, Buffer.from(csv));
    const require = createRequire(import.meta.url), SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const db = new SQL.Database();
    db.run('CREATE TABLE alpha (value TEXT); INSERT INTO alpha VALUES (\'<img src=https://evil.example>\'); CREATE TABLE beta (n INTEGER); INSERT INTO beta VALUES (7); CREATE VIEW excluded AS SELECT * FROM beta;');
    const sqlite = Buffer.from(db.export()); db.close();
    await artifact(owner.page, trip.path, 'data', 'local.sqlite', '', 'sqlite', sqlite);
    await expect(host.getByLabel('SQLite table')).toBeVisible(); await expect(host.locator('td')).toHaveText('<img src=https://evil.example>');
    await expect(host.locator('option')).toHaveText(['alpha', 'beta']); await host.getByLabel('SQLite table').selectOption('beta'); await expect(host.locator('td')).toHaveText('7');
    await original(owner.page, sqlite, 'local.sqlite');
    for (const [format, text, message] of [['yaml', 'x: !evil script', 'tag'], ['yaml', 'a: &a [1]\nb: *a', 'aliases'], ['json', '['.repeat(65) + '0' + ']'.repeat(65), '64'], ['json', JSON.stringify(Array(1000).fill(0)), '1,000'], ['toml', 'x=', 'Download']]) {
      await artifact(owner.page, trip.path, 'data', 'Fallback ' + format, text, format); await expect(host.getByRole('status')).toContainText(message); await expect(host.locator('table')).toHaveCount(0);
      await original(owner.page, Buffer.from(text));
    }
    const bad = Buffer.from('SQLite format 3\0broken'); await artifact(owner.page, trip.path, 'data', 'broken.sqlite', '', 'sqlite', bad);
    await expect(host.getByRole('status')).toContainText('Download the original bytes'); await original(owner.page, bad, 'broken.sqlite');
    // Delay only the already-authenticated member download, then cancel before it reaches a worker.
    await owner.page.route('**/v1/journeys/*/blobs/*', route => new Promise<void>(resolve => { setTimeout(() => { void route.continue().then(resolve).catch(resolve); }, 1500); }));
    await owner.page.reload(); await host.getByRole('button', { name: 'Cancel view' }).click();
    await expect(host.getByRole('status')).toContainText('View cancelled'); await expect(host.locator('table,pre')).toHaveCount(0);
    await owner.page.unroute('**/v1/journeys/*/blobs/*');
    expect(external).toEqual([]);
  } finally { await owner.context.close(); }
});

test('PNG, JPEG, GIF and WebP decode locally; SVG/HTML stay downloads; Markdown and links remain inert', async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await browserPerson(browser), external: string[] = [];
  await owner.context.route('**/*', async route => {
    if (new URL(route.request().url()).hostname !== 'localhost') { external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  try {
    await signUp(owner.page, `viewer-image-${Date.now()}@example.org`); const trip = await createTrip(owner.page), host = owner.page.locator('#artifact-viewer');
    const raster = await owner.page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
      const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 2, 2);
      return ['image/png', 'image/jpeg', 'image/webp'].map(type => ({ type, base64: canvas.toDataURL(type).split(',')[1]! }));
    });
    raster.push({ type: 'image/gif', base64: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' });
    for (const image of raster) {
      const input = Buffer.from(image.base64, 'base64'), name = 'picture.' + image.type.split('/')[1];
      // Filename/MIME intentionally do not establish trust; bytes must decode.
      await artifact(owner.page, trip.path, 'image', name, '', '', input);
      await expect(host.getByRole('status')).toHaveText('Validated local image preview.');
      expect(await host.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0 && img.src.startsWith('blob:'))).toBe(true);
      await original(owner.page, input, name);
    }
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__viewerEvil=1"><image href="https://evil.example/svg"/></svg>';
    await artifact(owner.page, trip.path, 'image', 'evil.png', '', '', Buffer.from(hostile));
    await expect(host.getByRole('status')).toContainText('No image preview'); await expect(host.locator('img')).toHaveCount(0); await original(owner.page, Buffer.from(hostile), 'evil.png');
    const html = '<script>window.__viewerEvil=1</script><img src=https://evil.example/active>';
    await artifact(owner.page, trip.path, 'file', 'evil.html', '', '', Buffer.from(html)); await expect(host).toContainText('No inline view'); await original(owner.page, Buffer.from(html), 'evil.html');
    const markdown = '# Local heading\n\n**Safe emphasis**\n\n' + html + '\n\n![remote](https://evil.example/img)\n\n[blocked](javascript:alert(1))\n\n[deliberate](https://example.org/open)';
    await artifact(owner.page, trip.path, 'document', 'Safe Markdown', markdown);
    await expect(host.locator('h1')).toHaveText('Local heading'); await expect(host.locator('strong')).toHaveText('Safe emphasis'); await expect(host.locator('script,img,a,iframe')).toHaveCount(0);
    await original(owner.page, Buffer.from(markdown));
    expect(await owner.page.evaluate(() => Object.hasOwn(window, '__viewerEvil'))).toBe(false); expect(external).toEqual([]);
    // An explicit button click is the only external navigation, with no opener/referrer.
    const popupEvent = owner.page.waitForEvent('popup'); await host.getByRole('button', { name: 'deliberate', exact: true }).click();
    const popup = await popupEvent; await popup.waitForLoadState().catch(() => {}); await popup.close();
    expect(external.every(url => url === 'https://example.org/open')).toBe(true);
    await owner.page.goto(trip.path + '/add'); await owner.page.getByLabel('Type', { exact: true }).selectOption('link'); await owner.page.getByLabel('Title', { exact: true }).fill('Bad link');
    for (const url of ['javascript:alert(1)', 'https://user:pass@example.org']) {
      await owner.page.getByLabel('URL', { exact: true }).fill(url); await owner.page.getByRole('button', { name: 'Save artifact' }).click(); await expect(owner.page.getByRole('alert')).toBeVisible();
    }
  } finally { await owner.context.close(); }
});
