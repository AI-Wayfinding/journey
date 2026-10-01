import { expect, test, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { open, unwrapJourneyKey } from '@ai-wayfinding/core';
import type { Envelope, JourneyKey } from '@ai-wayfinding/core';
import { agentWritesItem, requestAgent } from './agent.js';

import { browserPerson, signUp } from './person.js';
const calls = (page: Page) => page.evaluate(() => window.__passkeyCalls);
const journeyHeaders = { 'X-Client-Version': '0.1.4', 'X-Control-Format': 'control-proof-v1' };
test('account name and per-journey email visibility are shared only when chosen', async ({ browser }) => {
  const owner = await browserPerson(browser), guest = await browserPerson(browser);
  try {
    const ownerEmail = `profile-owner-${Date.now()}@example.org`;
    await signUp(owner.page, ownerEmail);
    await owner.page.getByRole('link', { name: 'Account' }).click();
    await expect(owner.page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await owner.page.getByLabel('Your name').fill('Avery');
    await owner.page.getByRole('button', { name: 'Save name' }).click();
    await expect(owner.page.getByRole('status').filter({ hasText: 'Name saved.' })).toBeVisible();
    await owner.page.getByRole('link', { name: 'Start a journey' }).first().click();
    await owner.page.getByLabel('Journey name').fill('Profile sharing');
    await owner.page.getByRole('button', { name: 'Create journey' }).click();
    await owner.page.getByLabel('I have saved my recovery key somewhere safe.').check();
    await owner.page.getByRole('button', { name: 'Continue to journey' }).click();
    await owner.page.getByRole('link', { name: 'Share this journey' }).click();
    await expect(owner.page.getByText('Avery (you)')).toBeVisible();
    await expect(owner.page.getByText(ownerEmail, { exact: true })).toHaveCount(0);
    await owner.page.getByRole('button', { name: 'Copy link instead' }).click();
    const invite = (await owner.page.locator('#invite-copy-value').textContent())!;
    await guest.page.goto(invite);
    const guestEmail = `profile-guest-${Date.now()}@example.org`;
    await guest.page.getByLabel('Email address').fill(guestEmail);
    await guest.page.getByRole('button', { name: 'Send sign-in link' }).click();
    const delivered = await guest.page.request.get(`/__test/email?address=${encodeURIComponent(guestEmail)}`);
    const { text } = await delivered.json() as { text: string };
    await guest.page.goto(/https?:\/\/[^\s]+#token=[A-Za-z0-9_-]+/.exec(text)![0]!);
    await guest.page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(guest.page.getByRole('heading', { name: 'Save your backup codes' })).toBeVisible();
    await guest.page.getByLabel('I saved these codes').check();
    await guest.page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(guest.page.getByRole('heading', { name: 'Join a journey' })).toBeVisible();
    await guest.page.getByRole('button', { name: 'Ask to join' }).click();
    await expect(guest.page.getByRole('heading', { name: 'Waiting for a member to let you in' })).toBeVisible();
    await owner.page.reload();
    await owner.page.getByRole('button', { name: 'Let in' }).click();
    await expect(guest.page.getByRole('heading', { name: 'Profile sharing' })).toBeVisible({ timeout: 20_000 });
    await guest.page.getByRole('link', { name: 'Share this journey' }).click();
    await expect(guest.page.getByText('Avery', { exact: true })).toBeVisible();
    await expect(guest.page.getByText(ownerEmail, { exact: true })).toHaveCount(0);
    await owner.page.getByLabel('Show my email to people in this journey').check();
    await expect(owner.page.getByText(ownerEmail, { exact: true })).toBeVisible();
    await guest.page.reload();
    await expect(guest.page.getByText(ownerEmail, { exact: true })).toBeVisible();
    await owner.page.getByRole('link', { name: 'Account' }).click();
    await expect(owner.page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await expect(owner.page.getByLabel('Your name')).toHaveValue('Avery');
    await owner.page.getByLabel('Your name').fill('Avery Updated');
    await owner.page.getByRole('button', { name: 'Save name' }).click();
    await expect(owner.page.getByRole('status').filter({ hasText: 'Name saved.' })).toBeVisible();
    await guest.page.reload();
    await expect(guest.page.getByText('Avery Updated', { exact: true })).toBeVisible();
    await expect(guest.page.getByText(ownerEmail, { exact: true })).toBeVisible();
    await owner.page.getByRole('link', { name: 'My journeys' }).click();
    await owner.page.getByRole('link', { name: 'Profile sharing' }).click();
    await owner.page.getByRole('link', { name: 'Share this journey' }).click();
    await owner.page.getByLabel('Show my email to people in this journey').uncheck();
    await expect(owner.page.getByText(ownerEmail, { exact: true })).toHaveCount(0);
    await guest.page.reload();
    await expect(guest.page.getByText(ownerEmail, { exact: true })).toHaveCount(0);
  } finally { await owner.context.close(); await guest.context.close(); }
});

test('sign-in survives a reload and a new tab until sign out', async ({ browser }) => {
  const person = await browserPerson(browser);
  try {
    await signUp(person.page, `persistent-${Date.now()}@example.org`);
    await person.page.reload();
    await expect(person.page.getByRole('heading', { name: 'A place to find your way' })).toBeVisible();
    expect((await calls(person.page)).get).toBe(0);
    const second = await person.context.newPage();
    await second.goto('/');
    await expect(second.getByRole('heading', { name: 'A place to find your way' })).toBeVisible();
    await person.context.clearCookies(); // The local keys outlast an expired server session.
    await person.page.reload();
    await expect(person.page.getByRole('heading', { name: 'Continue your journey' })).toBeVisible();
    await person.page.getByRole('button', { name: 'Continue with passkey' }).click();
    await expect(person.page.getByRole('heading', { name: 'A place to find your way' })).toBeVisible();
    await person.page.getByRole('button', { name: 'Sign out' }).click();
    await expect(person.page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await second.reload();
    await expect(second.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await person.page.reload();
    await expect(person.page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  } finally { await person.context.close(); }
});

test('start, continue with a discoverable passkey in a new page, and email a journey invitation', async ({ browser }) => {
  const owner = await browserPerson(browser);
  const second = await browserPerson(browser);
  try {
    const email = `continue-${Date.now()}@example.org`;
    await signUp(owner.page, email);
    await owner.page.getByRole('link', { name: 'Start a journey' }).first().click();
    await expect(owner.page.getByLabel('Who is it for?')).toHaveCount(0);
    await owner.page.getByLabel('Journey name').fill('A shared beginning');
    await owner.page.getByRole('button', { name: 'Create journey' }).click();
    await owner.page.getByLabel('I have saved my recovery key somewhere safe.').check();
    await owner.page.getByRole('button', { name: 'Continue to journey' }).click();
    await owner.page.getByRole('link', { name: 'Add your agent' }).click();
    await expect(owner.page.locator('#agent-copy-value')).toContainText('https://wayfinding.support/agents/install.md');
    await expect(owner.page.locator('#agent-copy-value')).toContainText(owner.page.url().split('/journeys/')[1]!.split('/')[0]!);
    await owner.page.getByRole('link', { name: '← Back to journey' }).click();
    await owner.page.getByRole('link', { name: 'Share this journey' }).click();
    const guestEmail = `invited-${Date.now()}@example.org`;
    await owner.page.getByLabel('Email addresses (separate with commas)').fill(guestEmail);
    await owner.page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(owner.page.getByText(`Invitation sent to ${guestEmail}.`)).toBeVisible();
    const delivered = await owner.page.request.get(`/__test/email?address=${encodeURIComponent(guestEmail)}`);
    const { text } = await delivered.json() as { text: string };
    expect(text).toContain('/invite#');
    await second.page.goto(/https?:\/\/[^\s]+\/invite#[A-Za-z0-9_-]+/.exec(text)![0]!);
    await expect(second.page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await owner.page.goto('/');
    await expect(owner.page.getByRole('heading', { name: 'A place to find your way' })).toBeVisible();
    await owner.page.getByRole('link', { name: 'A shared beginning' }).click();
    await expect(owner.page.getByRole('heading', { name: 'A shared beginning' })).toBeVisible();
  } finally { await owner.context.close(); await second.context.close(); }
});

test('add, replace and recover passkeys with a single-use backup code', async ({ browser }) => {
  const owner = await browserPerson(browser);
  const lost = await browserPerson(browser);
  try {
    const codes = await signUp(owner.page, `replace-${Date.now()}@example.org`);
    await owner.page.getByRole('link', { name: 'Account' }).click();
    await expect(owner.page.getByRole('button', { name: 'Remove' })).toBeDisabled();
    const second = await owner.cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await owner.page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(owner.page.getByRole('button', { name: 'Remove' })).toHaveCount(2);
    const firstId = await owner.page.locator('.remove-passkey').first().getAttribute('data-id');
    await owner.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: owner.authenticatorId });
    // The second passkey can now confirm removal of the first.
    await owner.page.locator(`.remove-passkey[data-id="${firstId}"]`).click();
    await expect(owner.page.getByRole('button', { name: 'Remove' })).toHaveCount(1);
    await expect(owner.page.getByRole('button', { name: 'Remove' })).toBeDisabled();
    const remaining = await owner.page.request.get('/v1/me/passkeys');
    expect((await remaining.json() as { passkeys: unknown[] }).passkeys).toHaveLength(1);
    await owner.page.goto('/continue');
    await owner.page.getByRole('button', { name: 'Continue with passkey' }).click();
    await expect(owner.page.getByRole('heading', { name: 'A place to find your way' })).toBeVisible();
    await owner.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: second.authenticatorId });
    await lost.page.goto('/recover');
    await lost.page.getByLabel('Backup code').fill(codes[0]!);
    await lost.page.getByRole('button', { name: 'Use backup code' }).click();
    await expect(lost.page.getByRole('heading', { name: 'Add a new passkey' })).toBeVisible();
    expect((await lost.page.request.get('/v1/journeys', { headers: journeyHeaders })).status()).toBe(403);
    await lost.page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(lost.page.getByRole('heading', { name: 'Passkey added' })).toBeVisible();
    await lost.page.getByRole('link', { name: 'Open my journeys' }).click();
    await expect(lost.page.getByRole('heading', { name: 'A place to find your way' })).toBeVisible();
    await lost.page.goto('/recover');
    await lost.page.getByLabel('Backup code').fill(codes[0]!);
    await lost.page.getByRole('button', { name: 'Use backup code' }).click();
    await expect(lost.page.getByRole('alert')).toBeVisible();
  } finally { await owner.context.close(); await lost.context.close(); }
});

test('cancelled passkey prompt never shows a browser exception or specification URL', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.credentials, 'get', { value: () => Promise.reject(new DOMException('The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.', 'NotAllowedError')) });
  });
  await page.goto('/continue');
  await page.getByRole('button', { name: 'Continue with passkey' }).click();
  await expect(page.getByRole('alert')).toContainText("No passkey was used. If you removed it or it's on another device, use a backup code.");
  await expect(page.getByRole('link', { name: 'Lost your passkey? Use a backup code' })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(/w3\.org|operation either timed out/i);
});

test('missing PRF output at creation uses the same passkey once more', async ({ browser }) => {
  const person = await browserPerson(browser, true, true);
  try {
    await signUp(person.page, `prf-retry-${Date.now()}@example.org`);
    expect(await calls(person.page)).toEqual({ create: 1, get: 1 });
    console.log('Sign-up without creation output: 1 create, 1 get');
  } finally { await person.context.close(); }
});

test('a passkey without PRF stops sign-up without another prompt or a saved credential', async ({ browser }) => {
  const person = await browserPerson(browser, false);
  try {
    const email = `no-prf-${Date.now()}@example.org`;
    await person.page.goto('/sign-in');
    await person.page.getByLabel('Email address').fill(email);
    await person.page.getByRole('button', { name: 'Send sign-in link' }).click();
    const sent = await person.page.request.get(`/__test/email?address=${encodeURIComponent(email)}`);
    const { text } = await sent.json() as { text: string };
    await person.page.goto(/https?:\/\/[^\s]+#token=[A-Za-z0-9_-]+/.exec(text)![0]!);
    await person.page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(person.page.getByRole('alert')).toContainText("This passkey can't protect your journey keys. Use your device's own passkeys");
    expect(await calls(person.page)).toEqual({ create: 1, get: 0 });
    expect((await person.page.request.get('/v1/me/keys')).status()).toBe(401);
    console.log('No-PRF sign-up taps: 1 create, 0 get');
  } finally { await person.context.close(); }
});

test('two people share a journey with PRF passkeys and same-origin assets', async ({ browser, request }) => {
  const response = await request.get('/');
  expect(response.headers()['content-security-policy']).toContain("default-src 'self'");
  const alice = await browserPerson(browser);
  const bob = await browserPerson(browser);
  const support = await browserPerson(browser);
  try {
    const aliceEmail = `alice-${Date.now()}@example.org`;
    await signUp(alice.page, aliceEmail);
    await alice.page.getByRole('link', { name: 'Start a journey' }).first().click();
    await alice.page.getByLabel('Journey name').fill('Our shared path');
    await alice.page.getByLabel('Description (optional)').fill('A place to work together');
    await expect(alice.page.getByLabel('Your email address')).toHaveCount(0);
    await expect(alice.page.getByLabel('Who is it for?')).toHaveCount(0);
    await alice.page.getByRole('button', { name: 'Create journey' }).click();
    await expect(alice.page.getByRole('heading', { name: 'Your recovery key' })).toBeVisible();
    const recovery = await alice.page.locator('#recovery-copy-value').textContent();
    expect(recovery).toContain('AGE-SECRET-KEY');
    await alice.page.getByLabel('I have saved my recovery key somewhere safe.').check();
    await alice.page.getByRole('button', { name: 'Continue to journey' }).click();
    await expect(alice.page.getByRole('heading', { name: 'Our shared path' })).toBeVisible();
    await alice.page.setViewportSize({ width: 390, height: 844 });
    expect(await alice.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    const journeyPath = new URL(alice.page.url()).pathname;
    const alicePrincipal = ((await (await alice.page.request.get('/v1/journeys', { headers: journeyHeaders })).json()) as { journeys: { id: string; principal: string }[] }).journeys.find(j => journeyPath.endsWith(j.id))!.principal;
    await alice.page.getByRole('link', { name: 'Add an item' }).click();
    await alice.page.getByLabel('Title').fill('First observation');
    await alice.page.getByLabel('Body (Markdown as plain text)').fill('A note shared with Bob');
    await alice.page.getByRole('button', { name: 'Save item' }).click();
    await expect(alice.page.getByRole('heading', { name: 'First observation' })).toBeVisible();
    const itemPath = new URL(alice.page.url()).pathname;
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await alice.page.getByRole('link', { name: 'Share this journey' }).click();
    await expect(alice.page.getByRole('heading', { name: 'Share this journey with other people' })).toBeVisible();
    await alice.page.getByRole('button', { name: 'Copy link instead' }).click();
    const link = (await alice.page.locator('#invite-copy-value').textContent())!;
    expect(link).toMatch(/\/invite#[A-Za-z0-9_-]{43}/);

    const bobEmail = `bob-${Date.now()}@example.org`;
    await bob.page.goto(link);
    await expect(bob.page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await bob.page.getByLabel('Email address').fill(bobEmail);
    await bob.page.getByRole('button', { name: 'Send sign-in link' }).click();
    await expect(bob.page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    const bobMessage = await bob.page.request.get(`/__test/email?address=${encodeURIComponent(bobEmail)}`);
    const bobText = (await bobMessage.json() as { text: string }).text;
    await bob.page.goto(/https?:\/\/[^\s]+#token=[A-Za-z0-9_-]+/.exec(bobText)![0]!);
    await expect(bob.page.getByRole('heading', { name: 'Create your passkey' })).toBeVisible();
    await bob.page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(bob.page.getByRole('heading', { name: 'Save your backup codes' })).toBeVisible();
    await bob.page.getByLabel('I saved these codes').check();
    await bob.page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => calls(bob.page).then(count => count.create)).toBe(1);
    expect((await calls(bob.page)).get).toBeLessThanOrEqual(1);
    await expect(bob.page.getByRole('heading', { name: 'Join a journey' })).toBeVisible({ timeout: 30_000 });
    await bob.page.getByRole('button', { name: 'Ask to join' }).click();
    await expect(bob.page.getByRole('heading', { name: 'Waiting for a member to let you in' })).toBeVisible();
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await alice.page.getByRole('link', { name: 'Share this journey' }).click();
    await alice.page.getByRole('button', { name: 'Let in' }).click();
    await expect(bob.page.getByRole('heading', { name: 'Our shared path' })).toBeVisible({ timeout: 20_000 });
    const bobLists = await bob.page.request.get('/v1/journeys', { headers: journeyHeaders });
    const bobPrincipal = ((await bobLists.json()) as { journeys: { id: string; principal: string }[] }).journeys.find(j => journeyPath.endsWith(j.id))!.principal;
    await bob.page.getByRole('link', { name: 'First observation' }).click();
    await expect(bob.page.getByText('A note shared with Bob')).toBeVisible();
    await bob.page.getByLabel('Add a comment').fill('I can see this now.');
    await bob.page.getByRole('button', { name: 'Add comment' }).click();
    await expect(bob.page.getByText('I can see this now.')).toBeVisible();
    await bob.page.getByRole('button', { name: 'Sign out' }).click();
    await expect(bob.page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await bob.page.getByLabel('Email address').fill(bobEmail);
    await bob.page.getByRole('button', { name: 'Send sign-in link' }).click();
    await expect(bob.page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    const bobLoginText = ((await (await bob.page.request.get(`/__test/email?address=${encodeURIComponent(bobEmail)}`)).json()) as { text: string }).text;
    await bob.page.goto(/https?:\/\/[^\s]+#token=[A-Za-z0-9_-]+/.exec(bobLoginText)![0]!);
    await expect(bob.page.getByRole('heading', { name: 'Confirm your passkey' })).toBeVisible();
    const beforeLogin = await calls(bob.page);
    await bob.page.getByRole('button', { name: 'Sign in with passkey' }).click();
    await expect(bob.page.getByRole('heading', { name: 'A place to find your way' })).toBeVisible({ timeout: 30_000 });
    expect((await calls(bob.page)).get - beforeLogin.get).toBe(1);
    console.log('Sign-in taps: 1 get');
    await bob.page.getByRole('link', { name: 'Our shared path' }).click();
    await bob.page.getByRole('link', { name: 'First observation' }).click();
    const bobWrapsResponse = await bob.page.request.get('/v1' + journeyPath + '/wraps/me', { headers: { 'X-Client-Version': '0.1.4', 'X-Control-Format': 'control-proof-v1', 'X-Principal': bobPrincipal } });
    const bobWraps = (await bobWrapsResponse.json()) as { wraps: { epoch: number; wrap: string }[] };
    expect(bobWraps.wraps.map(w => w.epoch)).toContain(1);
    const agent = await requestAgent(request, journeyPath.split('/').at(-1)!, 'Proposed <guide>');
    await alice.page.goto(agent.approvalUrl);
    await expect(alice.page.getByRole('heading', { name: 'Approve an agent' })).toBeVisible();
    await expect(alice.page.getByText('This agent will keep its keys in a file on its machine.')).toHaveCount(0);
    const fileAgent = await requestAgent(request, journeyPath.split('/').at(-1)!, 'File-backed guide', 'file');
    await alice.page.goto(fileAgent.approvalUrl);
    await expect(alice.page.getByText('This agent will keep its keys in a file on its machine.')).toBeVisible();
    await alice.page.goto(agent.approvalUrl);
    expect((await calls(alice.page)).get).toBe(0);
    console.log('New-tab unlock taps: 0 get');
    await expect(alice.page.getByLabel('Name', { exact: true })).toHaveValue('Proposed <guide>');
    await alice.page.getByLabel('Name', { exact: true }).fill('Alice’s guide');
    await alice.page.getByLabel('Six-digit code').fill(agent.code);
    await alice.page.getByLabel('Access').selectOption('readwrite');
    await alice.page.getByRole('button', { name: 'Confirm with passkey' }).click();
    await expect(alice.page.getByRole('heading', { name: 'Agent approved' })).toBeVisible();
    await agentWritesItem(request, agent, journeyPath.split('/').at(-1)!);
    await alice.page.getByRole('link', { name: 'People & agents' }).click();
    await expect(alice.page.getByText('Alice’s guide', { exact: false })).toBeVisible();
    const beforeRenameWraps = await (await alice.page.request.get('/v1' + journeyPath + '/wraps/me', { headers: { 'X-Client-Version': '0.1.4', 'X-Control-Format': 'control-proof-v1', 'X-Principal': alicePrincipal } })).json() as { wraps: { epoch: number }[] };
    alice.page.once('dialog', dialog => void dialog.accept('<renamed guide>'));
    await alice.page.locator(`[data-rename="${agent.principal}"]`).click();
    await expect(alice.page.getByText('<renamed guide>', { exact: false })).toBeVisible();
    expect(await alice.page.locator('strong').filter({ hasText: '<renamed guide>' }).count()).toBe(1);
    const afterRenameWraps = await (await alice.page.request.get('/v1' + journeyPath + '/wraps/me', { headers: { 'X-Client-Version': '0.1.4', 'X-Control-Format': 'control-proof-v1', 'X-Principal': alicePrincipal } })).json() as { wraps: { epoch: number }[] };
    expect(afterRenameWraps.wraps.map(w => w.epoch)).toEqual(beforeRenameWraps.wraps.map(w => w.epoch));
    await expect(alice.page.locator('[data-rename]')).toHaveCount(1);
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await expect(alice.page.getByRole('link', { name: 'Agent observation' })).toBeVisible();
    await alice.page.getByRole('link', { name: 'Agent observation' }).click();
    await expect(alice.page.locator('p.meta').filter({ hasText: '<renamed guide>' })).toBeVisible();
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await alice.page.getByRole('link', { name: 'Share this journey' }).click();
    alice.page.on('dialog', dialog => void dialog.accept());
    await alice.page.locator(`[data-remove="${bobPrincipal}"]`).click();
    await expect(alice.page.locator(`[data-remove="${bobPrincipal}"]`)).toHaveCount(0, { timeout: 20_000 });
    await expect(alice.page.getByText('Key update pending')).toHaveCount(0);
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await alice.page.getByRole('link', { name: 'Add an item' }).click();
    await alice.page.getByLabel('Title').fill('Only after Bob left');
    await alice.page.getByRole('button', { name: 'Save item' }).click();
    await expect(alice.page.getByRole('heading', { name: 'Only after Bob left' })).toBeVisible();
    await bob.page.getByRole('link', { name: 'Back to journey' }).click();
    await expect(bob.page.getByText('You no longer have access to this journey.')).toBeVisible();
    const denied = await bob.page.request.get('/v1' + journeyPath + '/records', { headers: { 'X-Client-Version': '0.1.4', 'X-Control-Format': 'control-proof-v1', 'X-Principal': bobPrincipal } });
    expect(denied.status()).toBe(403);
    const afterRemoval = await alice.page.request.get('/v1' + journeyPath + '/records', { headers: { 'X-Client-Version': '0.1.4', 'X-Control-Format': 'control-proof-v1', 'X-Principal': (await alice.page.request.get('/v1/journeys', { headers: journeyHeaders }).then(r => r.json()) as { journeys: { principal: string; id: string }[] }).journeys.find(j => journeyPath.endsWith(j.id))!.principal } });
    const envelopes = (await afterRemoval.json()) as { records: Envelope[] };
    const newest = envelopes.records.at(-1)!;
    expect(newest.outside.epoch).toBeGreaterThan(Math.max(...bobWraps.wraps.map(w => w.epoch)));
    const oldKey: JourneyKey = { epoch: 1, key: new Uint8Array(32) };
    await expect(open(newest, oldKey)).rejects.toThrow('Wrong journey key epoch');
    expect(alice.requests.every(url => new URL(url).hostname === 'localhost')).toBeTruthy();
    expect(bob.requests.every(url => new URL(url).hostname === 'localhost')).toBeTruthy();
    expect(itemPath).toContain(journeyPath);
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await alice.page.getByRole('link', { name: 'Share this journey' }).click();
    await alice.page.getByLabel('Invitation').selectOption('support');
    await alice.page.getByRole('button', { name: 'Copy link instead' }).click();
    const supportLink = (await alice.page.locator('#invite-copy-value').textContent())!;
    await signUp(support.page, `support-${Date.now()}@example.org`);
    await support.page.getByLabel('Invitation link').fill(supportLink);
    await support.page.getByRole('button', { name: 'Open invitation' }).click();
    await support.page.getByRole('button', { name: 'Ask to join' }).click();
    await expect(support.page.getByRole('heading', { name: 'Waiting for a member to let you in' })).toBeVisible();
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await alice.page.getByRole('link', { name: 'Share this journey' }).click();
    await expect(alice.page.getByText('Wayfinding support (Hypha), read only')).toBeVisible();
    await alice.page.getByRole('button', { name: 'Let in' }).click();
    await expect(support.page.getByRole('heading', { name: 'Our shared path' })).toBeVisible({ timeout: 20_000 });
    await expect(support.page.getByRole('link', { name: 'Add an item' })).toHaveCount(0);
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await alice.page.getByRole('link', { name: 'Share this journey' }).click();
    await expect(alice.page.getByText('Wayfinding support (Hypha)')).toBeVisible({ timeout: 10_000 });
    const supportLists = await support.page.request.get('/v1/journeys', { headers: journeyHeaders });
    const supportPrincipal = ((await supportLists.json()) as { journeys: { id: string; principal: string }[] }).journeys.find(j => journeyPath.endsWith(j.id))!.principal;
    expect((await support.page.request.post(`/v1${journeyPath}/seq`, { data: {}, headers: { 'X-Client-Version': '0.1.4', 'X-Control-Format': 'control-proof-v1', 'X-Wayfinding': '1', Origin: 'http://localhost:18787', 'X-Principal': supportPrincipal } })).status()).toBe(403);
    expect(support.requests.every(url => new URL(url).hostname === 'localhost')).toBeTruthy();
  } finally { await alice.context.close(); await bob.context.close(); await support.context.close(); }
});

test('an agent link is created, read as JSON, extended and revoked', async ({ browser, request }) => {
  const alice = await browserPerson(browser);
  try {
    await signUp(alice.page, `link-${Date.now()}@example.org`);
    await alice.page.getByRole('link', { name: 'Start a journey' }).first().click();
    await alice.page.getByLabel('Journey name').fill('Link test journey');
    await alice.page.getByRole('button', { name: 'Create journey' }).click();
    await alice.page.getByLabel('I have saved my recovery key somewhere safe.').check();
    await alice.page.getByRole('button', { name: 'Continue to journey' }).click();
    await expect(alice.page.getByRole('heading', { name: 'Link test journey' })).toBeVisible();
    const journeyPath = new URL(alice.page.url()).pathname;
    const journeyId = journeyPath.split('/').pop()!;
    await alice.page.getByRole('link', { name: 'Add an item' }).click();
    await alice.page.getByLabel('Title').fill('Packing list');
    await alice.page.getByLabel('Body (Markdown as plain text)').fill('Passport, charger, **umbrella**');
    await alice.page.getByRole('button', { name: 'Save item' }).click();
    await expect(alice.page.getByRole('heading', { name: 'Packing list' })).toBeVisible();

    // Create the link.
    await alice.page.goto(`${journeyPath}/people`);
    await expect(alice.page.getByRole('heading', { name: 'Add agent by link' })).toBeVisible();
    await alice.page.getByLabel('Agent name').fill('Cowork helper');
    await expect(alice.page.getByLabel('Link lasts')).toHaveValue('7');
    await expect(alice.page.getByText("Wayfinding's server decrypts the journey while it answers the link.").first()).toBeVisible();
    const before = (await calls(alice.page)).get;
    await alice.page.getByRole('button', { name: 'Create link with passkey' }).click();
    const url = (await alice.page.locator('#agent-link-copy-value').textContent({ timeout: 30_000 }))!;
    expect((await calls(alice.page)).get).toBeGreaterThan(before);
    expect(url).toMatch(/\/a\/[A-Za-z0-9_-]{43}$/);
    await expect(alice.page.getByText('Anyone with this link can read this journey until it expires or you remove it.').first()).toBeVisible();
    await expect(alice.page.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible();
    await alice.page.getByRole('button', { name: 'Done' }).click();
    const memberLi = alice.page.locator('li', { hasText: 'Cowork helper' });
    await expect(memberLi).toContainText('Agent link');
    await expect(memberLi).toContainText('read');

    // Read it the way a sandboxed agent does: a plain fetch of the URL.
    const path = new URL(url).pathname;
    const fetched = await request.get(path);
    expect(fetched.status()).toBe(200);
    expect(fetched.headers()['content-type']).toBe('application/json; charset=utf-8');
    expect(fetched.headers()['cache-control']).toBe('no-store, no-transform');
    expect(fetched.headers()['x-robots-tag']).toBe('noindex');
    expect(fetched.headers()['referrer-policy']).toBe('no-referrer');
    const data = await fetched.json() as { journey: { id: string; name: string }; access: { agentName: string; scope: string; renewUrl: string; expiresAt: string }; items: { title: string; body: string; author: { kind: string } }[]; page: { number: number; of: number; next: string | null } };
    expect(data.journey).toMatchObject({ id: journeyId, name: 'Link test journey' });
    expect(data.access).toMatchObject({ agentName: 'Cowork helper', scope: 'read' });
    expect(data.access.renewUrl).toContain(`/journeys/${journeyId}/people#renew-`);
    expect(data.items).toMatchObject([{ title: 'Packing list', body: 'Passport, charger, **umbrella**', author: { kind: 'person' } }]);
    expect(data.page).toEqual({ number: 1, of: 1, next: null });
    const firstExpiry = Date.parse(data.access.expiresAt);
    expect(firstExpiry).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    // Extend it from the renewUrl anchor.
    await alice.page.goto(new URL(data.access.renewUrl).pathname + new URL(data.access.renewUrl).hash);
    await expect(alice.page.getByText('Extend access')).toBeVisible();
    await expect(alice.page.locator('details.renew')).toHaveAttribute('open', '');
    await alice.page.getByLabel('Keep the link working for').selectOption('30');
    await alice.page.getByRole('button', { name: 'Extend with passkey' }).click();
    await expect(alice.page.getByRole('heading', { name: 'People in this journey' })).toBeVisible();
    await expect.poll(async () => Date.parse(((await (await request.get(path)).json()) as typeof data).access.expiresAt), { timeout: 15_000 }).toBeGreaterThan(firstExpiry + 20 * 86_400_000);
    expect((await request.get(path)).status()).toBe(200); // The same URL still works.

    // Remove the agent: the link ends at once.
    alice.page.once('dialog', dialog => void dialog.accept());
    await alice.page.locator('li', { hasText: 'Cowork helper' }).getByRole('button', { name: 'Remove' }).click();
    await expect(alice.page.locator('li', { hasText: 'Cowork helper' })).toHaveCount(0, { timeout: 30_000 });
    const gone = await request.get(path);
    expect(gone.status()).toBe(404);
    expect(await gone.json()).toMatchObject({ message: 'This agent link has ended. Ask the person for a new one.' });
  } finally { await alice.context.close(); }
});
