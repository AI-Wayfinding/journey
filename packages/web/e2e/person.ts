import { expect, test, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { open, unwrapJourneyKey } from '@ai-wayfinding/core';
import type { Envelope, JourneyKey } from '@ai-wayfinding/core';
import { agentWritesItem, requestAgent } from './agent.js';

declare global { interface Window { __passkeyCalls: { create: number; get: number } } }
const calls = (page: Page) => page.evaluate(() => window.__passkeyCalls);
let nextTestIp = 1;
export async function browserPerson(browser: Browser, hasPrf = true, omitPrfOnCreate = false): Promise<{ page: Page; context: BrowserContext; requests: string[]; cdp: CDPSession; authenticatorId: string }> {
  // Local e2e traffic otherwise shares one unknown IP and hits the production 10-email/minute limit.
  const context = await browser.newContext({ extraHTTPHeaders: { 'CF-Connecting-IP': `198.51.100.${nextTestIp++}` } });
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
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf } });
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  return { page, context, requests, cdp, authenticatorId };
}
export async function signUp(page: Page, email: string): Promise<string[]> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: "Let's get started" })).toBeVisible();
  await page.locator('#content').getByRole('link', { name: 'Start your journey' }).click();
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
  await expect(page.getByRole('heading', { name: 'Save your backup codes' })).toBeVisible({ timeout: 30_000 });
  const codes = (await page.locator('#backup-copy-value').textContent())!.trim().split('\n');
  expect(codes).toHaveLength(8);
  await page.getByLabel('I saved these codes').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A place to find your way' })).toBeVisible({ timeout: 30_000 });
  const count = await calls(page);
  expect(count.create).toBe(1);
  expect(count.get).toBeLessThanOrEqual(1);
  console.log(`Sign-up taps: ${count.create} create, ${count.get} get`);
  return codes;
}

