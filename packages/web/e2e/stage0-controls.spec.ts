import { expect, test, type Page } from '@playwright/test';
import { browserPerson, signUp } from './person.js';
async function principal(page: Page, id: string) {
  const data = await (await page.request.get('/v1/journeys', { headers: { 'X-Client-Version': '0.1.7', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Project-Format': 'project-v1' } })).json() as { journeys: { id: string; principal: string }[] };
  return data.journeys.find(row => row.id === id)!.principal;
}
test('signed settings, separate role and guide authority, and read-only personal controls survive reload', async ({ browser, request }) => {
  const guide = await browserPerson(browser), guest = await browserPerson(browser);
  try {
    await signUp(guide.page, `stage0-guide-${Date.now()}@example.org`);
    await signUp(guest.page, `stage0-guest-${Date.now()}@example.org`);
    await guide.page.getByRole('link', { name: 'Start a journey' }).first().click();
    await guide.page.getByLabel('Journey name').fill('Stage zero');
    await guide.page.getByRole('button', { name: 'Create journey' }).click();
    await guide.page.getByLabel('I have saved my recovery key somewhere safe.').check();
    await guide.page.getByRole('button', { name: 'Continue to journey' }).click();
    await expect(guide.page).toHaveURL(/\/journeys\/[^/]+$/);
    await expect(guide.page.getByRole('heading', { name: 'Stage zero', exact: true })).toBeVisible();
    const path = new URL(guide.page.url()).pathname, id = path.split('/').at(-1)!, guideId = await principal(guide.page, id);
    await guide.page.goto(path + '/members');
    await expect(guide.page.getByRole('heading', { name: 'Share this journey with other people' })).toBeVisible();
    await expect(guide.page.locator('#leave')).toBeDisabled();
    await expect(guide.page.locator(`[data-grant="${guideId}"]`)).toHaveCount(0);
    await guide.page.locator(`[data-role="${guideId}"]`).click();
    await expect(guide.page.locator('li').filter({ has: guide.page.locator(`[data-role="${guideId}"]`) })).toContainText('Guide · Read-only');
    await guide.page.getByLabel('Journey name').fill('Current signed name');
    await guide.page.getByLabel('Description', { exact: true }).fill('Current signed description');
    await guide.page.getByLabel('New people start with').selectOption('read-only');
    await guide.page.getByRole('button', { name: 'Save settings' }).click();
    await expect(guide.page.getByRole('button', { name: 'Save settings' })).toBeEnabled();
    await guide.page.reload();
    await expect(guide.page.getByLabel('Journey name')).toHaveValue('Current signed name');
    await expect(guide.page.getByLabel('Description', { exact: true })).toHaveValue('Current signed description');
    await expect(guide.page.getByLabel('New people start with')).toHaveValue('read-only');
    await guide.page.getByRole('button', { name: 'Copy link instead' }).click();
    const invite = (await guide.page.locator('#invite-copy-value').textContent())!;
    await guest.page.goto(invite); await guest.page.getByRole('button', { name: 'Ask to join' }).click();
    await expect(guest.page.getByRole('heading', { name: 'Waiting for a member to let you in' })).toBeVisible();
    await guide.page.reload(); await guide.page.getByRole('button', { name: 'Let in' }).click();
    await expect(guest.page.getByRole('heading', { name: 'Current signed name', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(guest.page.getByText('Current signed description')).toBeVisible();
    await expect(guest.page.getByRole('link', { name: 'Add an artifact' })).toHaveCount(0);
    const guestId = await principal(guest.page, id);
    await guest.page.goto(path + '/members');
    await expect(guest.page.getByRole('heading', { name: 'Journey settings' })).toHaveCount(0);
    await expect(guest.page.locator('[data-role], [data-grant], [data-remove]')).toHaveCount(0);
    await guest.page.getByLabel('Your name', { exact: true }).fill('Read-only person');
    await guest.page.getByRole('button', { name: 'Save my name' }).click();
    await expect(guest.page.getByText('Read-only person (you)', { exact: true })).toBeVisible();
    await guest.page.getByLabel('Show my email to people in this journey').check();
    await expect(guest.page.getByLabel('Show my email to people in this journey')).toBeEnabled();
    await guest.page.reload(); await expect(guest.page.getByLabel('Show my email to people in this journey')).toBeChecked();
    await expect(guest.page.getByLabel('Your name', { exact: true })).toHaveValue('Read-only person');
    await guest.page.getByLabel('Agent name').fill('My reader');
    await guest.page.getByLabel('Link lasts').selectOption('1');
    await guest.page.getByRole('button', { name: 'Create link with passkey' }).click();
    const link = (await guest.page.locator('#agent-link-copy-value').textContent({ timeout: 30_000 }))!;
    expect(await (await request.get(link)).json()).toMatchObject({ journey: { name: 'Current signed name', description: 'Current signed description' }, access: { scope: 'read' } });
    await guest.page.getByRole('button', { name: 'Done', exact: true }).click();
    const own = guest.page.locator('li').filter({ hasText: 'My reader' });
    const ownId = (await own.locator('[data-rename]').getAttribute('data-rename'))!;
    guest.page.once('dialog', dialog => void dialog.accept('My renamed reader')); await own.getByRole('button', { name: 'Rename' }).click();
    await expect(guest.page.getByText('My renamed reader', { exact: true })).toBeVisible();
    await guest.page.goto(path + '/members#renew-' + ownId);
    await guest.page.getByLabel('Keep the link working for').selectOption('7');
    await guest.page.getByRole('button', { name: 'Extend with passkey' }).click();
    await expect(guest.page.getByRole('button', { name: 'Extend with passkey' })).toBeEnabled();
    expect(await (await request.get(link)).json()).toMatchObject({ access: { scope: 'read', agentName: 'My renamed reader' } });
    await guide.page.reload();
    await guide.page.locator(`[data-grant="${guestId}"]`).click();
    await expect(guide.page.locator(`[data-grant="${guestId}"]`)).toHaveText('Stop managing people');
    await guest.page.reload(); await expect(guest.page.getByRole('heading', { name: 'Journey settings' })).toBeVisible();
    await guest.page.getByLabel('Journey name').fill('Read-only guide settings');
    await guest.page.getByRole('button', { name: 'Save settings' }).click();
    await expect(guest.page.getByRole('button', { name: 'Save settings' })).toBeEnabled();
    await guest.page.locator(`[data-grant="${guideId}"]`).click();
    await expect(guest.page.locator(`[data-grant="${guestId}"]`)).toHaveCount(0); // cannot remove the last guide
    await expect(guest.page.locator('#leave')).toBeDisabled();
    await guide.page.reload(); await expect(guide.page.getByRole('heading', { name: 'Journey settings' })).toHaveCount(0);
    guest.page.on('dialog', dialog => void dialog.accept());
    await guest.page.locator(`[data-remove="${ownId}"]`).click(); await expect(guest.page.locator(`[data-remove="${ownId}"]`)).toHaveCount(0);
    const ended = await request.get(link);
    expect(ended.status()).toBe(404); expect(await ended.json()).toMatchObject({ error: 'ended' });
    await guest.page.locator(`[data-grant="${guideId}"]`).click(); await expect(guest.page.locator('#leave')).toBeEnabled();
    await guest.page.locator('#leave').click(); await expect(guest.page.getByRole('heading', { name: 'A place to find your way' })).toBeVisible();
    await guide.page.goto(path); await expect(guide.page.getByRole('heading', { name: 'Read-only guide settings', exact: true })).toBeVisible();
    await expect(guide.page.getByRole('link', { name: 'Add an artifact' })).toHaveCount(0);
  } finally { await guide.context.close(); await guest.context.close(); }
});

test('a future control clears the browser view rather than showing partial content', async ({ browser }) => {
  const person = await browserPerson(browser);
  try {
    await signUp(person.page, `future-browser-${Date.now()}@example.org`);
    await person.page.getByRole('link', { name: 'Start a journey' }).first().click();
    await person.page.getByLabel('Journey name').fill('Must not remain rendered'); await person.page.getByRole('button', { name: 'Create journey' }).click();
    await person.page.getByLabel('I have saved my recovery key somewhere safe.').check(); await person.page.getByRole('button', { name: 'Continue to journey' }).click();
    await expect(person.page.getByRole('heading', { name: 'Must not remain rendered' })).toBeVisible();
    await person.page.route('**/v1/journeys/*/log', async route => {
      const response = await route.fetch(), body = await response.json(); body.log.at(-1).proof.type = 'future.control'; await route.fulfill({ response, json: body });
    });
    await person.page.getByRole('link', { name: 'Share this journey' }).click();
    await expect(person.page.getByRole('heading', { name: 'Update Wayfinding' })).toBeVisible();
    await expect(person.page.getByRole('alert')).toContainText('do not ask for approval again');
    await expect(person.page.getByText('Must not remain rendered')).toHaveCount(0);
    await expect(person.page.getByRole('link', { name: 'Add an artifact' })).toHaveCount(0);
  } finally { await person.context.close(); }
});
