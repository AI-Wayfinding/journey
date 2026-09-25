import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { open, unwrapJourneyKey } from '@ai-wayfinding/core';
import type { Envelope, JourneyKey } from '@ai-wayfinding/core';
import { agentWritesItem, requestAgent } from './agent.js';

declare global { interface Window { __passkeyCalls: { create: number; get: number } } }
const calls = (page: Page) => page.evaluate(() => window.__passkeyCalls);
async function browserPerson(browser: Browser, hasPrf = true, omitPrfOnCreate = false): Promise<{ page: Page; context: BrowserContext; requests: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(({ omitPrfOnCreate }) => {
    window.__passkeyCalls = { create: 0, get: 0 };
    const create = navigator.credentials.create.bind(navigator.credentials);
    const get = navigator.credentials.get.bind(navigator.credentials);
    Object.defineProperty(navigator.credentials, 'create', { value: async (...args: Parameters<typeof create>) => {
      window.__passkeyCalls.create++;
      const credential = await create(...args);
      if (omitPrfOnCreate && credential instanceof PublicKeyCredential) {
        const extensions = credential.getClientExtensionResults.bind(credential);
        Object.defineProperty(credential, 'getClientExtensionResults', { value: () => {
          const results = extensions();
          if (results.prf) delete results.prf.results;
          return results;
        } });
      }
      return credential;
    } });
    Object.defineProperty(navigator.credentials, 'get', { value: (...args: Parameters<typeof get>) => { window.__passkeyCalls.get++; return get(...args); } });
  }, { omitPrfOnCreate });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf } });
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  return { page, context, requests };
}
async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const message = await page.request.get(`/__test/email?address=${encodeURIComponent(email)}`);
  expect(message.ok()).toBeTruthy();
  const { text } = await message.json() as { text: string | null };
  expect(text).toContain('/auth/verify#token=');
  const link = /https?:\/\/[^\s]+#token=[A-Za-z0-9_-]+/.exec(text!)![0]!;
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Create your passkey' })).toBeVisible();
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page.getByRole('heading', { name: 'A place to find your way' })).toBeVisible({ timeout: 30_000 });
  const count = await calls(page);
  expect(count.create).toBe(1);
  expect(count.get).toBeLessThanOrEqual(1);
  console.log(`Sign-up taps: ${count.create} create, ${count.get} get`);
}

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
    await alice.page.getByRole('link', { name: 'Add an item' }).click();
    await alice.page.getByLabel('Title').fill('First observation');
    await alice.page.getByLabel('Body (Markdown as plain text)').fill('A note shared with Bob');
    await alice.page.getByRole('button', { name: 'Save item' }).click();
    await expect(alice.page.getByRole('heading', { name: 'First observation' })).toBeVisible();
    const itemPath = new URL(alice.page.url()).pathname;
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await alice.page.getByRole('link', { name: 'People & agents' }).click();
    await alice.page.getByRole('button', { name: 'Create invitation link' }).click();
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
    await expect.poll(() => calls(bob.page).then(count => count.create)).toBe(1);
    expect((await calls(bob.page)).get).toBeLessThanOrEqual(1);
    await expect(bob.page.getByRole('heading', { name: 'Join a journey' })).toBeVisible({ timeout: 30_000 });
    await bob.page.getByRole('button', { name: 'Ask to join' }).click();
    await expect(bob.page.getByRole('heading', { name: 'Waiting for a member to let you in' })).toBeVisible();
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await alice.page.getByRole('link', { name: 'People & agents' }).click();
    await alice.page.getByRole('button', { name: 'Let in' }).click();
    await expect(bob.page.getByRole('heading', { name: 'Our shared path' })).toBeVisible({ timeout: 20_000 });
    const bobLists = await bob.page.request.get('/v1/journeys');
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
    const bobWrapsResponse = await bob.page.request.get('/v1' + journeyPath + '/wraps/me', { headers: { 'X-Principal': bobPrincipal } });
    const bobWraps = (await bobWrapsResponse.json()) as { wraps: { epoch: number; wrap: string }[] };
    expect(bobWraps.wraps.map(w => w.epoch)).toContain(1);
    const agent = await requestAgent(request, journeyPath.split('/').at(-1)!);
    await alice.page.goto(agent.approvalUrl);
    await expect(alice.page.getByRole('heading', { name: 'Unlock with your passkey' })).toBeVisible();
    const beforeUnlock = await calls(alice.page);
    await alice.page.getByRole('button', { name: 'Unlock with passkey' }).click();
    await expect(alice.page.getByRole('heading', { name: 'Approve an agent' })).toBeVisible();
    expect((await calls(alice.page)).get - beforeUnlock.get).toBe(1);
    console.log('New-tab unlock taps: 1 get');
    await alice.page.getByLabel('Six-digit code').fill(agent.code);
    await alice.page.getByLabel('Access').selectOption('readwrite');
    await alice.page.getByRole('button', { name: 'Confirm with passkey' }).click();
    await expect(alice.page.getByRole('heading', { name: 'Agent approved' })).toBeVisible();
    await agentWritesItem(request, agent, journeyPath.split('/').at(-1)!);
    await alice.page.getByRole('link', { name: 'People & agents' }).click();
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await expect(alice.page.getByRole('link', { name: 'Agent observation' })).toBeVisible();
    await alice.page.getByRole('link', { name: 'People & agents' }).click();
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
    const denied = await bob.page.request.get('/v1' + journeyPath + '/records', { headers: { 'X-Principal': bobPrincipal } });
    expect(denied.status()).toBe(403);
    const afterRemoval = await alice.page.request.get('/v1' + journeyPath + '/records', { headers: { 'X-Principal': (await alice.page.request.get('/v1/journeys').then(r => r.json()) as { journeys: { principal: string; id: string }[] }).journeys.find(j => journeyPath.endsWith(j.id))!.principal } });
    const envelopes = (await afterRemoval.json()) as { records: Envelope[] };
    const newest = envelopes.records.at(-1)!;
    expect(newest.outside.epoch).toBeGreaterThan(Math.max(...bobWraps.wraps.map(w => w.epoch)));
    const oldKey: JourneyKey = { epoch: 1, key: new Uint8Array(32) };
    await expect(open(newest, oldKey)).rejects.toThrow('Wrong journey key epoch');
    expect(alice.requests.every(url => new URL(url).hostname === 'localhost')).toBeTruthy();
    expect(bob.requests.every(url => new URL(url).hostname === 'localhost')).toBeTruthy();
    expect(itemPath).toContain(journeyPath);
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await alice.page.getByRole('link', { name: 'People & agents' }).click();
    await alice.page.getByLabel('Invitation').selectOption('support');
    await alice.page.getByRole('button', { name: 'Create invitation link' }).click();
    const supportLink = (await alice.page.locator('#invite-copy-value').textContent())!;
    await signUp(support.page, `support-${Date.now()}@example.org`);
    await support.page.getByLabel('Invitation link').fill(supportLink);
    await support.page.getByRole('button', { name: 'Open invitation' }).click();
    await support.page.getByRole('button', { name: 'Ask to join' }).click();
    await expect(support.page.getByRole('heading', { name: 'Waiting for a member to let you in' })).toBeVisible();
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await alice.page.getByRole('link', { name: 'People & agents' }).click();
    await expect(alice.page.getByText('Wayfinding support (Hypha), read only')).toBeVisible();
    await alice.page.getByRole('button', { name: 'Let in' }).click();
    await expect(support.page.getByRole('heading', { name: 'Our shared path' })).toBeVisible({ timeout: 20_000 });
    await expect(support.page.getByRole('link', { name: 'Add an item' })).toHaveCount(0);
    await alice.page.getByRole('link', { name: 'Back to journey' }).click();
    await alice.page.getByRole('link', { name: 'People & agents' }).click();
    await expect(alice.page.getByText('Wayfinding support (Hypha)')).toBeVisible({ timeout: 10_000 });
    const supportLists = await support.page.request.get('/v1/journeys');
    const supportPrincipal = ((await supportLists.json()) as { journeys: { id: string; principal: string }[] }).journeys.find(j => journeyPath.endsWith(j.id))!.principal;
    expect((await support.page.request.post(`/v1${journeyPath}/seq`, { data: {}, headers: { 'X-Wayfinding': '1', Origin: 'http://localhost:18787', 'X-Principal': supportPrincipal } })).status()).toBe(403);
    expect(support.requests.every(url => new URL(url).hostname === 'localhost')).toBeTruthy();
  } finally { await alice.context.close(); await bob.context.close(); await support.context.close(); }
});
