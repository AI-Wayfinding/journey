import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { LINK_SECRET_PATTERN, createAgeIdentity, createSigningIdentity, hashControlProof, importSigningKey, linkLookupHash, newId, newLinkSecret, seal, sealLinkIdentity, signEntry, wrapJourneyKey, type JourneyKey } from '@ai-wayfinding/core';
import type { Env } from '../src/index.js';
import { authenticator } from './authenticator.js';
import { base64url, digest } from '../src/crypto.js';

import { sent, resetSent, testSealed, request, account, person, journey, cipherLog, as } from './fixtures.js';
const origin = 'https://app.wayfinding.support';
// Seam: the Worker HTTP API, real Durable Objects and SQLite; email delivery is the only fake.
describe('HTTP boundary', () => {
  it('keeps verified sessions for 30 days and rejects an expired session', async () => {
    const owner = await person('session-duration@example.org');
    const registry = (env as unknown as Env).REGISTRY.get((env as unknown as Env).REGISTRY.idFromName('registry-v2'));
    const hash = await digest(owner.cookie.split('=')[1]!);
    const issued = await account('email-session-duration@example.org');
    expect(issued.cookie).toMatch(/^wayfinding_session=/);
    const cookieResponse = await request('/v1/auth/email/verify', 'POST', { token: issued.token });
    expect(cookieResponse.status).toBe(401); // One-use link cannot issue another cookie.
    const row = await runInDurableObject(registry, (_object, state) => state.storage.sql.exec('SELECT expires FROM sessions WHERE hash=?', hash).toArray()[0] as { expires: number });
    expect(row.expires).toBeGreaterThanOrEqual(Date.now() + 2_592_000_000 - 60_000);
    expect(row.expires).toBeLessThanOrEqual(Date.now() + 2_592_000_000);
    expect((await request('/v1/me/keys', 'GET', undefined, { Cookie: owner.cookie })).status).toBe(200);
    await runInDurableObject(registry, (_object, state) => { state.storage.sql.exec('UPDATE sessions SET expires=? WHERE hash=?', Date.now() - 1, hash); });
    expect((await request('/v1/me/keys', 'GET', undefined, { Cookie: owner.cookie })).status).toBe(401);
    const started = await request('/v1/auth/passkey/start', 'POST', {});
    const discovery = started.headers.get('set-cookie')!.split(';')[0]!;
    const { challenge } = await started.json() as { challenge: string };
    const finished = await request('/v1/auth/passkey/finish', 'POST', { response: await owner.device.login(challenge) }, { Cookie: discovery });
    expect(finished.status).toBe(200);
    expect(finished.headers.get('set-cookie')).toContain('Max-Age=2592000');
  });
  it('reads only the sealed copy for the verified credential', async () => {
    const p = await person('sealed-keys@example.org');
    const other = await person('other-sealed-keys@example.org');
    const response = await request('/v1/me/keys', 'GET', undefined, { Cookie: p.cookie });
    expect(await response.json()).toMatchObject({ version: 1, identity: expect.any(String), signing: expect.any(String) });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await (await request('/v1/me/keys', 'GET', undefined, { Cookie: other.cookie })).json()).not.toEqual(await (await request('/v1/me/keys', 'GET', undefined, { Cookie: p.cookie })).json());
    expect((await request('/v1/me/keys', 'GET')).status).toBe(401);
    const unverified = await account('unverified-keys@example.org');
    expect((await request('/v1/me/keys', 'GET', undefined, { Cookie: unverified.cookie })).status).toBe(401);
    expect((await request('/v1/me/keys', 'PUT', testSealed(), { Cookie: p.cookie })).status).toBe(404);
  });
  it('returns the signed-in person’s email only to their verified account', async () => {
    const owner = await person('private-profile@example.org');
    const other = await person('another-profile@example.org');
    const response = await request('/v1/me/email', 'GET', undefined, { Cookie: owner.cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: owner.email });
    expect(await (await request('/v1/me/email', 'GET', undefined, { Cookie: other.cookie })).json()).toEqual({ email: other.email });
    expect((await request('/v1/me/email')).status).toBe(401);
    const unverified = await account('unverified-profile@example.org');
    expect((await request('/v1/me/email', 'GET', undefined, { Cookie: unverified.cookie })).status).toBe(401);
  });
  it('uses one app-wide PRF salt, including discoverable options', async () => {
    const first = await account('salt-first@example.org');
    const second = await account('salt-second@example.org');
    const options = async (cookie: string) => (await request('/v1/auth/passkey/register/options', 'POST', {}, { Cookie: cookie })).json() as Promise<{ challenge: string; extensions: { prf: { eval: { first: string } } } }>;
    const initial = await options(first.cookie);
    expect((await options(second.cookie)).extensions.prf.eval.first).toBe(initial.extensions.prf.eval.first);
    const latest = await options(first.cookie);
    expect(latest.extensions.prf.eval.first).toBe(initial.extensions.prf.eval.first);
    const device = await authenticator();
    expect((await request('/v1/auth/passkey/register/verify', 'POST', { response: device.register(latest.challenge), sealed: testSealed() }, { Cookie: first.cookie })).status).toBe(200);
    const next = await account(first.email);
    const login = await request('/v1/auth/passkey/login/options', 'POST', {}, { Cookie: next.cookie });
    expect((await login.json() as { extensions: { prf: { eval: { first: string } } } }).extensions.prf.eval.first).toBe(initial.extensions.prf.eval.first);
    const unlockedTab = await request('/v1/auth/passkey/login/options', 'POST', {}, { Cookie: first.cookie });
    expect((await unlockedTab.json() as { extensions: { prf: { eval: { first: string } } } }).extensions.prf.eval.first).toBe(initial.extensions.prf.eval.first);
    const discover = await request('/v1/auth/passkey/start', 'POST', {});
    const values = await discover.json() as { allowCredentials?: unknown[]; extensions: { prf: { eval: { first: string } } } };
    expect(values.allowCredentials ?? []).toEqual([]);
    expect(values.extensions.prf.eval.first).toBe(initial.extensions.prf.eval.first);
  });
  it('seals keys per credential and limits one-time backup recovery to passkey enrollment', async () => {
    const owner = await person('backup-owner@example.org');
    const first = owner.device.register('unused').id;
    const original = await (await request('/v1/me/keys', 'GET', undefined, { Cookie: owner.cookie })).json();
    const verifiers = Array.from({ length: 8 }, () => base64url(crypto.getRandomValues(new Uint8Array(32))));
    const codes = await Promise.all(verifiers.map(async verifier => { const { identity, signing } = testSealed(); return { verifierHash: await digest(verifier), identity, signing }; }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect((await request('/v1/me/backup-codes', 'PUT', { codes, plaintext: 'SECRET-CODE' }, { Cookie: owner.cookie })).status).toBe(400);
      expect((await request('/v1/me/backup-codes', 'PUT', { codes }, { Cookie: owner.cookie })).status).toBe(204);
      const registry = (env as unknown as Env).REGISTRY.get((env as unknown as Env).REGISTRY.idFromName('registry-v2'));
      const rows = await runInDurableObject(registry, (_object, state) => JSON.stringify(state.storage.sql.exec('SELECT * FROM backup_codes').toArray()));
      expect(rows).not.toContain(verifiers[0]!); expect(rows).not.toContain('SECRET-CODE');
      expect(log.mock.calls.flat().join(' ')).not.toContain(verifiers[0]!);
      const second = await authenticator();
      const options = await request('/v1/auth/passkey/register/options', 'POST', {}, { Cookie: owner.cookie });
      const secondSealed = testSealed();
      const secondId = second.register('unused').id;
      expect((await request('/v1/auth/passkey/register/verify', 'POST', { response: second.register((await options.json() as { challenge: string }).challenge), sealed: secondSealed }, { Cookie: owner.cookie })).status).toBe(200);
      expect(await (await request('/v1/me/keys', 'GET', undefined, { Cookie: owner.cookie })).json()).toEqual(secondSealed);
      const next = await account(owner.email);
      const login = await request('/v1/auth/passkey/login/options', 'POST', {}, { Cookie: next.cookie });
      expect((await request('/v1/auth/passkey/login/verify', 'POST', { response: await owner.device.login((await login.json() as { challenge: string }).challenge) }, { Cookie: next.cookie })).status).toBe(200);
      expect(await (await request('/v1/me/keys', 'GET', undefined, { Cookie: next.cookie })).json()).toEqual(original);
      expect((await request('/v1/me/passkeys/' + first, 'DELETE', undefined, { Cookie: owner.cookie })).status).toBe(204);
      expect((await request('/v1/me/passkeys/' + secondId, 'DELETE', undefined, { Cookie: owner.cookie })).status).toBe(403);
      const wrong = base64url(crypto.getRandomValues(new Uint8Array(32)));
      for (let i = 0; i < 5; i++) expect((await request('/v1/auth/backup-code/redeem', 'POST', { verifier: wrong })).status).toBe(401);
      expect((await request('/v1/auth/backup-code/redeem', 'POST', { verifier: wrong })).status).toBe(429);
      const redeemed = await request('/v1/auth/backup-code/redeem', 'POST', { verifier: verifiers[0]! });
      expect(redeemed.status).toBe(200);
      const recovery = { Cookie: redeemed.headers.get('set-cookie')!.split(';')[0]! };
      expect(await (await request('/v1/me/keys', 'GET', undefined, recovery)).json()).toEqual({ version: 1, identity: codes[0]!.identity, signing: codes[0]!.signing });
      expect((await request('/v1/auth/backup-code/redeem', 'POST', { verifier: verifiers[0]! })).status).toBe(401);
      expect((await request('/v1/journeys', 'GET', undefined, recovery)).status).toBe(403);
      expect((await request('/v1/journeys', 'POST', {}, recovery)).status).toBe(403);
      expect((await request('/v1/invites/accept', 'POST', {}, recovery)).status).toBe(403);
      expect((await request('/v1/agent-sessions/missing/approve', 'POST', {}, recovery)).status).toBe(403);
      expect((await request('/v1/me/passkeys/' + secondId, 'DELETE', undefined, recovery)).status).toBe(403);
      expect((await request('/v1/me/backup-codes', 'PUT', { codes }, recovery)).status).toBe(403);
      const reEnroll = await request('/v1/auth/passkey/register/options', 'POST', {}, recovery);
      expect((await request('/v1/auth/passkey/register/verify', 'POST', { response: (await authenticator()).register((await reEnroll.json() as { challenge: string }).challenge), sealed: testSealed() }, recovery)).status).toBe(200);
      expect((await request('/v1/me/passkeys', 'GET', undefined, recovery)).status).toBe(200);
    } finally { log.mockRestore(); }
  });
  it('signs in by discoverable passkey with no prior email session; unknown and legacy credentials fail', async () => {
    const owner = await person('discovery@example.org');
    const start = await request('/v1/auth/passkey/start', 'POST', {});
    const { challenge } = await start.json() as { challenge: string };
    const discovery = start.headers.get('set-cookie')!.split(';')[0]!;
    const response = await owner.device.login(challenge);
    expect((await request('/v1/auth/passkey/finish', 'POST', { response }, { Cookie: discovery, Origin: 'https://other.example' })).status).toBe(403);
    const finished = await request('/v1/auth/passkey/finish', 'POST', { response }, { Cookie: discovery });
    expect(finished.status).toBe(200);
    expect((await request('/v1/me/keys', 'GET', undefined, { Cookie: finished.headers.get('set-cookie')!.split(';')[0]! })).status).toBe(200);
    expect((await request('/v1/auth/passkey/finish', 'POST', { response }, { Cookie: discovery })).status).toBe(401);
    const missing = await request('/v1/auth/passkey/start', 'POST', {});
    const forged = { ...response, id: 'unknown', rawId: 'unknown' };
    expect((await request('/v1/auth/passkey/finish', 'POST', { response: forged }, { Cookie: missing.headers.get('set-cookie')!.split(';')[0]! })).status).toBe(401);
    const registry = (env as unknown as Env).REGISTRY.get((env as unknown as Env).REGISTRY.idFromName('registry-v2'));
    await runInDurableObject(registry, (_object, state) => { state.storage.sql.exec('UPDATE accounts SET email=NULL WHERE hash=(SELECT accountHash FROM credentials WHERE id=?)', response.id); });
    const noEmail = await request('/v1/auth/passkey/start', 'POST', {});
    const noEmailResponse = await owner.device.login((await noEmail.json() as { challenge: string }).challenge, 2);
    expect((await request('/v1/auth/passkey/finish', 'POST', { response: noEmailResponse }, { Cookie: noEmail.headers.get('set-cookie')!.split(';')[0]! })).status).toBe(401);
  });
  it('emails a client-secret invitation only to a validated address, without storing or logging it', async () => {
    const owner = await person('invite-email-owner@example.org');
    const { id } = await journey(owner);
    const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const email = 'invitee@example.org';
    const deliveries: string[] = [];
    const delivery = { send: async (message: { to: string; text?: string }) => { deliveries.push(message.to + ' ' + message.text); return { messageId: 'sent' }; } } as Env['MAGIC_EMAIL'];
    const path = `/v1/journeys/${id}/invites`;
    expect((await request(path, 'POST', { inviteIdHash: await digest(secret), inviteId: secret, email, expiresAt: Date.now() + 60_000 }, as(owner), { MAGIC_EMAIL: delivery })).status).toBe(201);
    expect(deliveries[0]).toContain(email);
    expect(deliveries[0]).toContain(`${origin}/invite#${secret}`);
    expect((await request(path, 'POST', { inviteIdHash: await digest(secret), inviteId: secret, email: 'bad\r\nBcc: someone@example.org', expiresAt: Date.now() + 60_000 }, as(owner), { MAGIC_EMAIL: delivery })).status).toBe(400);
    const registry = (env as unknown as Env).REGISTRY.get((env as unknown as Env).REGISTRY.idFromName('registry-v2'));
    const hash = await digest(secret);
    expect(await runInDurableObject(registry, (_object, state) => JSON.stringify(state.storage.sql.exec('SELECT * FROM invites WHERE hash=?', hash).toArray()))).not.toContain(email);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const second = base64url(crypto.getRandomValues(new Uint8Array(32)));
      expect((await request(path, 'POST', { inviteIdHash: await digest(second), inviteId: second, email, expiresAt: Date.now() + 60_000 }, as(owner), { MAGIC_EMAIL: { send: async () => { throw new Error('mail failed for ' + email); } } as Env['MAGIC_EMAIL'] })).status).toBe(500);
      expect(log.mock.calls.flat().join(' ')).not.toContain(email);
    } finally { log.mockRestore(); }
  });
  it('refuses an unsealed registration without saving a credential', async () => {
    const a = await account('unsealed@example.org');
    const device = await authenticator();
    const options = await request('/v1/auth/passkey/register/options', 'POST', {}, { Cookie: a.cookie });
    const { challenge } = await options.json() as { challenge: string };
    expect((await request('/v1/auth/passkey/register/verify', 'POST', { response: device.register(challenge) }, { Cookie: a.cookie })).status).toBe(400);
    expect((await account(a.email)).challenge).toBe('register');
  });
  it('refuses registration without PRF and leaves no credential for a clean retry', async () => {
    const a = await account('no-prf@example.org');
    const device = await authenticator();
    const options = await request('/v1/auth/passkey/register/options', 'POST', {}, { Cookie: a.cookie });
    const { challenge } = await options.json() as { challenge: string };
    const withoutPrf = device.register(challenge, false);
    expect((await request('/v1/auth/passkey/register/verify', 'POST', { response: withoutPrf, sealed: testSealed() }, { Cookie: a.cookie })).status).toBe(400);
    const next = await account(a.email);
    expect(next.challenge).toBe('register');
    expect((await request('/v1/auth/passkey/register/options', 'POST', {}, { Cookie: next.cookie })).status).toBe(200);
  });
  it('logs passkey diagnostics from named fields only and requires a session', async () => {
    expect((await request('/v1/diagnostics/passkey', 'POST', { stage: 'register-create', outcome: 'no-output' })).status).toBe(401);
    const a = await account('diagnostics@example.org');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const sent = await request('/v1/diagnostics/passkey', 'POST', { stage: 'register-create', outcome: 'no-output', enabled: 'absent', first: 'absent', length: 0, aaguid: 'bada5566-a7aa-401f-bd96-45619a55120d', browser: 'Chrome 140', prfOutput: 'SECRET-PRF', email: a.email, error: 'bad value; SECRET-ERR' }, { Cookie: a.cookie });
      expect(sent.status).toBe(204);
      const line = log.mock.calls.map(call => call.join(' ')).find(text => text.startsWith('passkey-diagnostic'))!;
      expect(line).toContain('"stage":"register-create"');
      expect(line).toContain('"aaguid":"bada5566-a7aa-401f-bd96-45619a55120d"');
      expect(line).not.toContain('SECRET');
      expect(line).not.toContain(a.email);
      expect((await request('/v1/diagnostics/passkey', 'POST', { stage: 'anything' }, { Cookie: a.cookie })).status).toBe(400);
    } finally { log.mockRestore(); }
  });
  it('applies isolation headers to HTML assets without changing API responses', async () => {
    const assets: Fetcher = { fetch: async () => new Response('<h1>Journey</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' } }), connect: () => { throw new Error('not used'); } };
    const page = await request('/journeys', 'GET', undefined, {}, { ASSETS: assets });
    expect(page.status).toBe(200);
    // Exact equality prevents adding unsafe-eval, inline scripts, remote sources or any other permission.
    expect(page.headers.get('content-security-policy')).toBe("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(page.headers.get('permissions-policy')).toContain('camera=()');
    // Stops edge features (for example an analytics beacon) from being injected into the page.
    expect(page.headers.get('cache-control')).toContain('no-transform');
    expect((await request('/v1/missing', 'GET', undefined, {}, { ASSETS: assets })).status).toBe(404);
    expect((await request('/v1', 'GET', undefined, {}, { ASSETS: assets })).status).toBe(404);
  });
  it('hides account existence, requires CSRF and consumes links', async () => {
    resetSent();
    const first = await account('guest@example.org');
    expect((await request('/v1/auth/email/verify','POST',{token:first.token})).status).toBe(401);
    const secondStart = await request('/v1/auth/email/start','POST',{email:first.email});
    expect(secondStart.status).toBe(202);
    expect(await secondStart.json()).toEqual({status:'accepted'});
    const denied = await request('/v1/auth/email/start','POST',{email:first.email},{'X-Wayfinding':'0'});
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({error:{code:'csrf'}});
    expect((await request('/v1/auth/email/start','POST',{email:first.email},{Origin:'https://elsewhere.example'})).status).toBe(403);
    expect((await request('/v1/auth/passkey/register/options','POST',{})).status).toBe(401);
  });
  it('sends a normalized, structured magic link and rejects header injection', async () => {
    const emails: unknown[] = [];
    const delivery = { send: async (message: unknown) => { emails.push(message); return {messageId:'test'}; } };
    expect((await request('/v1/auth/email/start','POST',{email:'Mixed.Case@Example.ORG'},{},{MAGIC_EMAIL:delivery})).status).toBe(202);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toEqual({
      to:'mixed.case@example.org',
      from:{ name:'Wayfinding', email:'noreply@wayfinding.support' },
      replyTo:'hello@wayfinding.support',
      subject:'Your Wayfinding sign-in link',
      text:expect.stringContaining('/auth/verify#token='),
      html:expect.stringContaining('/auth/verify#token='),
    });
    const message = emails[0] as { text: string; html: string };
    // Says why the person got it and what to do if they did not ask.
    for (const body of [message.text, message.html]) {
      expect(body).toContain('app.wayfinding.support');
      expect(body).toContain('15 minutes');
      expect(body).toContain("If you didn't ask");
    }
    // The address is never echoed into the HTML, so it cannot inject markup.
    expect(message.html).not.toContain('mixed.case@example.org');
    expect(message.html).not.toMatch(/<script|<img|https?:\/\/(?!app\.wayfinding\.support)/);
    expect((await request('/v1/auth/email/start','POST',{email:'attacker@example.org\r\nBcc: victim@example.org'},{},{MAGIC_EMAIL:delivery})).status).toBe(400);
    expect(emails).toHaveLength(1);
    const failed = await request('/v1/auth/email/start','POST',{email:'delivery-failure@example.org'},{},{MAGIC_EMAIL:{send:async () => { throw new Error('delivery failed'); }}});
    expect(failed.status).toBe(202);
    expect(await failed.json()).toEqual({status:'accepted'});
  });
  it('logs an accepted send with its message ID only', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try { expect((await request('/v1/auth/email/start','POST',{email:'logged-ok@example.org'},{},{MAGIC_EMAIL:{send:async () => ({ messageId: 'msg-123' })}})).status).toBe(202); }
    finally { spy.mockRestore(); }
    const joined = lines.join('\n');
    expect(joined).toContain('magic-link accepted msg-123');
    expect(joined).not.toContain('logged-ok@example.org');
    expect(joined).not.toContain('#token=');
  });
  it('logs a delivery failure without the address or the sign-in link', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      const failed = await request('/v1/auth/email/start','POST',{email:'logged-failure@example.org'},{},{MAGIC_EMAIL:{send:async () => { throw Object.assign(new Error('sender not verified'), { code: 'E_SENDER' }); }}});
      expect(failed.status).toBe(202);
    } finally { spy.mockRestore(); }
    const joined = lines.join('\n');
    expect(joined).toContain('magic-link send failed');
    expect(joined).toContain('sender not verified');
    expect(joined).not.toContain('logged-failure@example.org');
    expect(joined).not.toContain('#token=');
  });
  it('returns to a named agent request without sending an invitation secret or open redirect', async () => {
    const emails: { text: string }[] = [];
    const delivery = { send: async (message: unknown) => { if (message && typeof message === 'object' && 'text' in message && typeof message.text === 'string') emails.push({ text: message.text }); return { messageId: 'test' }; } };
    expect((await request('/v1/auth/email/start', 'POST', { email: 'agent-return@example.org', returnPath: '/agent-sessions/valid_123' }, {}, { MAGIC_EMAIL: delivery })).status).toBe(202);
    expect(emails[0]!.text).toContain('#token=');
    expect(emails[0]!.text).toContain('&next=%2Fagent-sessions%2Fvalid_123');
    expect((await request('/v1/auth/email/start', 'POST', { email: 'agent-return@example.org', returnPath: 'https://elsewhere.example' }, {}, { MAGIC_EMAIL: delivery })).status).toBe(400);
    expect((await request('/v1/auth/email/start', 'POST', { email: 'agent-return@example.org', returnPath: '/invite#leaked' }, {}, { MAGIC_EMAIL: delivery })).status).toBe(400);
    expect(emails).toHaveLength(1);
  });
  it('enforces per-address and per-IP limits without changing the response', async () => {
    resetSent();
    for(let i=0;i<12;i++) expect((await request('/v1/auth/email/start','POST',{email:'limited@example.org'})).status).toBe(202);
    expect(sent).toHaveLength(5);
  });
  it('requires a real passkey and blocks unregistered account creation', async () => {
    resetSent();
    const noKey = await account('not-yet@example.org');
    expect((await request('/v1/journeys','POST',{}, {Cookie:noKey.cookie})).status).toBe(401);
    expect((await request('/v1/auth/passkey/register/verify','POST',{response:{}},{Cookie:noKey.cookie})).status).toBe(400);
    const p = await person('owner@example.org');
    const created = await journey(p);
    expect((await request('/v1/journeys', 'GET',undefined,as(p))).status).toBe(200);
    expect(created.id).toBeTruthy();
  });
});

it('rejects a malformed journey ID when requesting an agent session', async () => {
  const body = {journeyId:'not-an-id',agentPublicKey:{recipient:'public-recipient',signingKey:'public-signing-key'},requestedScope:'read'};
  expect((await request('/v1/agent-sessions','POST',body)).status).toBe(400);
});

it('validates a proposed agent name before storing and returning it', async () => {
  const body = { journeyId: newId(), agentPublicKey: { recipient: 'public-recipient', signingKey: 'public-signing-key' }, requestedScope: 'read', name: 'Friendly <agent>' };
  for (const name of ['', ' untrimmed', 'bad\nname', 'A'.repeat(61), 42, null]) {
    expect((await request('/v1/agent-sessions', 'POST', { ...body, name })).status).toBe(400);
  }
  const started = await request('/v1/agent-sessions', 'POST', { ...body, extra: 'not-persisted' });
  expect(started.status).toBe(201);
  const { id } = await started.json() as { id: string };
  const stored = await (await request('/v1/agent-sessions/' + id)).json() as Record<string, unknown>;
  expect(stored.name).toBe(body.name);
  expect(stored).not.toHaveProperty('extra');
});

it('stores only the permitted key-storage flag for the approval screen', async () => {
  const body = { journeyId: newId(), agentPublicKey: { recipient: 'public-recipient', signingKey: 'public-signing-key' }, requestedScope: 'read', remembered: false, keyStorage: 'file' };
  for (const keyStorage of ['vault', true, null]) expect((await request('/v1/agent-sessions', 'POST', { ...body, keyStorage })).status).toBe(400);
  expect((await request('/v1/agent-sessions', 'POST', { ...body, remembered: true })).status).toBe(400);
  const started = await request('/v1/agent-sessions', 'POST', { ...body, untrusted: 'do-not-store' });
  expect(started.status).toBe(201);
  const { id } = await started.json() as { id: string };
  const stored = await (await request('/v1/agent-sessions/' + id)).json() as Record<string, unknown>;
  expect(stored.keyStorage).toBe('file');
  expect(stored).not.toHaveProperty('untrusted');
});

it('limits unauthenticated agent-session creation by IP', async () => {
  const keys: string[] = [];
  const rate = { limit: async ({key}: {key:string}) => { keys.push(key); return {success:keys.length <= 10}; } };
  const body = {journeyId:newId(),agentPublicKey:{recipient:'public-recipient',signingKey:'public-signing-key'},requestedScope:'read' as const};
  for (let i = 0; i < 10; i++) expect((await request('/v1/agent-sessions','POST',body,{}, {AGENT_SESSION_RATE:rate})).status).toBe(201);
  expect((await request('/v1/agent-sessions','POST',body,{}, {AGENT_SESSION_RATE:rate})).status).toBe(429);
  expect(new Set(keys).size).toBe(1);
  expect((await request('/v1/agent-sessions','POST',body,{}, {AGENT_SESSION_RATE:undefined})).status).toBe(500);
});

it('expires unapproved agent sessions after ten minutes', async () => {
  const owner = await person('pending-agent-owner@example.org');
  const {id} = await journey(owner);
  const started = await request('/v1/agent-sessions','POST',{journeyId:id,agentPublicKey:{recipient:'recipient',signingKey:'signing-key'},requestedScope:'read'});
  expect(started.status).toBe(201);
  const {id:sessionId,code} = await started.json() as {id:string,code:string};
  const now = Date.now();
  try {
    vi.useFakeTimers(); vi.setSystemTime(now + 600_001);
    const status = await request('/v1/agent-sessions/'+sessionId);
    expect((await status.json() as {status:string}).status).toBe('expired');
    const next = await account(owner.email);
    const options = await request('/v1/auth/passkey/login/options','POST',{}, {Cookie:next.cookie});
    const {challenge} = await options.json() as {challenge:string};
    const assertion = await owner.device.login(challenge);
    expect((await request('/v1/auth/passkey/login/verify','POST',{response:assertion},{Cookie:next.cookie})).status).toBe(200);
    const approval = {code,principal:owner.principal,scope:'read',expiresAt:Date.now()+3_600_000,wrap:'YWJjZA==',entry:'YWJjZA=='};
    expect((await request('/v1/agent-sessions/'+sessionId+'/approve','POST',approval,{Cookie:next.cookie})).status).toBe(404);
  } finally { vi.useRealTimers(); }
});

it('locks an agent session after five wrong approval codes', async () => {
  const owner = await person('locked-agent-owner@example.org');
  const {id} = await journey(owner);
  const started = await request('/v1/agent-sessions','POST',{journeyId:id,agentPublicKey:{recipient:'recipient',signingKey:'signing-key'},requestedScope:'read'});
  expect(started.status).toBe(201);
  const {id:sessionId,code} = await started.json() as {id:string,code:string};
  const url = '/v1/agent-sessions/'+sessionId+'/approve';
  const approval = {code,principal:owner.principal,scope:'read',expiresAt:Date.now()+3_600_000,wrap:'YWJjZA==',entry:'YWJjZA=='};
  for (let i = 0; i < 5; i++) expect((await request(url,'POST',{...approval,code:code === '000000' ? '999999' : '000000'},{Cookie:owner.cookie})).status).toBe(400);
  expect((await (await request('/v1/agent-sessions/'+sessionId)).json() as {status:string}).status).toBe('locked');
  expect((await request(url,'POST',approval,{Cookie:owner.cookie})).status).toBe(404);
});

it('requires passkey verification again after a later email sign-in', async () => {
  const owner = await person('returning@example.org');
  const {id} = await journey(owner);
  const next = await account(owner.email);
  expect((await request('/v1/journeys/'+id+'/records','GET',undefined,{'Cookie':next.cookie,'X-Principal':owner.principal})).status).toBe(401);
  const options = await request('/v1/auth/passkey/login/options','POST',{}, {Cookie:next.cookie});
  expect(options.status).toBe(200);
  const {challenge} = await options.json() as {challenge:string};
  const assertion = await owner.device.login(challenge);
  expect((await request('/v1/auth/passkey/login/verify','POST',{response:assertion},{Cookie:next.cookie})).status).toBe(200);
  expect((await request('/v1/journeys/'+id+'/records','GET',undefined,{'Cookie':next.cookie,'X-Principal':owner.principal})).status).toBe(200);
  expect((await request('/v1/auth/passkey/login/verify','POST',{response:assertion},{Cookie:next.cookie})).status).toBe(401);
  expect((await request('/v1/auth/logout','POST',{}, {Cookie:next.cookie})).status).toBe(200);
  expect((await request('/v1/journeys/'+id+'/records','GET',undefined,{'Cookie':next.cookie,'X-Principal':owner.principal})).status).toBe(401);
});

it('rejects oversized records, wrong journey metadata, stale reservations and foreign write attempts', async () => {
  const owner = await person('limits@example.org');
  const {id,key} = await journey(owner);
  const second = await person('stranger@example.org');
  const {id:otherId} = await journey(second);
  const {seq} = await (await request('/v1/journeys/'+id+'/seq','POST',{},as(owner))).json() as {seq:number};
  const envelope = await seal({type:'item',typeVersion:1,body:{note:'private'}},{id:newId(),journey:id,epoch:1,seq,createdAt:new Date().toISOString()},key);
  expect((await request('/v1/journeys/'+otherId+'/records','POST',{envelope},as(owner))).status).toBe(400);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope},as(second))).status).toBe(403);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope:{...envelope,outside:{...envelope.outside,size:1048577}}},as(owner))).status).toBe(413);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope:{...envelope,outside:{...envelope.outside,secret:'visible'}}},as(owner))).status).toBe(400);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope:{...envelope,outside:{...envelope.outside,seq:seq+1}}},as(owner))).status).toBe(409);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope},as(owner))).status).toBe(201);
  const archive = await request('/v1/journeys/'+id+'/export','GET',undefined,as(owner));
  expect(archive.status).toBe(200);
  expect((await archive.json() as {envelopes:unknown[]}).envelopes).toEqual([envelope]);
});

it('applies the independent per-IP budget to different emails', async () => {
  resetSent();
  for(let i=0;i<12;i++) expect((await request('/v1/auth/email/start','POST',{email:'ip-'+i+'@example.org'})).status).toBe(202);
  expect(sent).toHaveLength(10);
});

it('does not let a fresh email link replace an existing passkey without the old passkey', async () => {
  const owner = await person('existing@example.org');
  const next = await account(owner.email);
  expect((await request('/v1/auth/passkey/register/options','POST',{}, {Cookie:next.cookie})).status).toBe(403);
});

it('accepts sequence cursors beyond the first thousand records', async () => {
  const owner = await person('cursor@example.org');
  const {id} = await journey(owner);
  expect((await request('/v1/journeys/'+id+'/records?after=1001','GET',undefined,as(owner))).status).toBe(200);
  expect((await request('/v1/journeys/'+id+'/log?after=1001','GET',undefined,as(owner))).status).toBe(200);
});

it('rejects a magic link after its 15-minute lifetime', async () => {
  const initial=Date.now();
  const started=await request('/v1/auth/email/start','POST',{email:'old-link@example.org'});
  expect(started.status).toBe(202);
  const token=/#token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)!)![1]!;
  try {
    vi.useFakeTimers(); vi.setSystemTime(initial+16*60_000);
    expect((await request('/v1/auth/email/verify','POST',{token})).status).toBe(401);
  } finally { vi.useRealTimers(); }
});

it('does not create an invitation beyond seven days or accept an unknown secret', async () => {
  const owner = await person('invite-limit@example.org');
  const guest = await person('invite-guest@example.org');
  const {id} = await journey(owner);
  const secret=base64url(crypto.getRandomValues(new Uint8Array(32)));
  expect((await request('/v1/journeys/'+id+'/invites','POST',{inviteIdHash:await digest(secret),expiresAt:Date.now()+8*86400000},as(owner))).status).toBe(400);
  expect((await request('/v1/invites/accept','POST',{inviteId:secret,principal:{id:guest.principal,recipient:guest.age.recipient,signingKey:guest.signing.publicKey}},{Cookie:guest.cookie})).status).toBe(404);
});

it('offers registration again when the first email link was verified but no passkey was added', async () => {
  const initial=await account('unfinished@example.org');
  const second=await account(initial.email);
  expect(second.challenge).toBe('register');
  expect((await request('/v1/auth/email/verify','POST',{token:second.token})).status).toBe(401);
  const options = await request('/v1/auth/passkey/register/options','POST',{}, {Cookie:second.cookie});
  expect(options.status).toBe(200);
});

it('accepts a record at the exact 1 MiB plaintext boundary', async () => {
  const owner = await person('boundary@example.org');
  const {id,key} = await journey(owner);
  const {seq} = await (await request('/v1/journeys/'+id+'/seq','POST',{},as(owner))).json() as {seq:number};
  const base = {type:'item',typeVersion:1,body:{data:''}};
  const overhead = new TextEncoder().encode(JSON.stringify(base)).length;
  const envelope = await seal({type:'item',typeVersion:1,body:{data:'A'.repeat(1048576-overhead)}},{id:newId(),journey:id,seq,epoch:1,createdAt:new Date().toISOString()},key);
  expect(envelope.outside.size).toBe(1048576);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope},as(owner))).status).toBe(201);
});

it('keeps the operator registry closed when its secret is absent', async () => {
  const response = await request('/v1/admin/registry','GET',undefined,{}, {ADMIN_TOKEN:undefined});
  expect(response.status).toBe(401);
});

it('fails closed rather than hashing addresses with a missing key', async () => {
  const response=await request('/v1/auth/email/start','POST',{email:'no-key@example.org'},{},{EMAIL_HASH_KEY:undefined});
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({error:{code:'internal'}});
  expect(sent).toHaveLength(0);
});

it('serves the single-page app from the Worker assets binding', async () => {
  const response = await request('/');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
});

// Agent links: a labelled exception to end-to-end encryption for agents that can only fetch web pages.
describe('agent links', () => {
  const day = 86_400_000;
  let emails = 0;
  async function addItem(owner: Awaited<ReturnType<typeof person>>, id: string, key: JourneyKey, title: string, body: string) {
    const {seq} = await (await request('/v1/journeys/'+id+'/seq','POST',{},as(owner))).json() as {seq:number};
    const envelope = await seal({type:'item',typeVersion:1,body:{id:newId(),itemType:'note',title,body,author:owner.principal,authoredBy:'human',created:new Date().toISOString(),tags:['a']}},{id:newId(),journey:id,epoch:key.epoch,seq,createdAt:new Date().toISOString()},key);
    expect((await request('/v1/journeys/'+id+'/records','POST',{envelope},as(owner))).status).toBe(201);
  }
  async function fixture(days = 7) {
    const owner = await person(`link-owner-${++emails}@example.org`);
    const {id,key,entries,controls} = await journey(owner);
    const ownerKey = await importSigningKey(owner.signing.privateKey);
    const age = await createAgeIdentity(), bot = await createSigningIdentity();
    const start = async (extra: object = {}) => {
      const started = await request('/v1/agent-sessions','POST',{journeyId:id,agentPublicKey:{recipient:age.recipient,signingKey:bot.publicKey},requestedScope:'read',name:'Cowork',keyStorage:'link',remembered:true,...extra});
      expect(started.status).toBe(201);
      const {id:sessionId,code} = await started.json() as {id:string,code:string};
      const {principal} = await (await request('/v1/agent-sessions/'+sessionId)).json() as {principal:string};
      return {sessionId,code,principal};
    };
    const {sessionId,code,principal} = await start();
    const expiresAt = Date.now()+days*day;
    const member = {id:principal,kind:'agent' as const,recipient:age.recipient,signingKey:bot.publicKey,scope:'read' as const,addedBy:owner.principal,name:'Cowork',expiresAt:new Date(expiresAt).toISOString()};
    const added = await signEntry({v:1,seq:1,prev:await hashControlProof(controls[0]!.proof),at:new Date().toISOString(),actor:owner.principal,type:'member.add',body:{member,kind:'agent',grants:[]}},ownerKey);
    const wrap = (await wrapJourneyKey(key,[{id:principal,recipient:age.recipient}]))[0]!;
    const approval = {principal:owner.principal,code,scope:'read',expiresAt,wrap:wrap.ciphertext,control:await cipherLog(key,id,added)};
    const secret = newLinkSecret();
    return {owner,ownerKey,id,key,entries,controls,age,bot,principal,sessionId,code,approval,expiresAt,secret,member,start,
      async approve() { const approved = await request('/v1/agent-sessions/'+sessionId+'/approve','POST',approval,{Cookie:owner.cookie}); expect(approved.status).toBe(200); controls.push(approval.control); },
      async link(sealed = age.identity) {
        return request('/v1/journeys/'+id+'/agent-links','POST',{sessionId,hash:await linkLookupHash(secret),blob:await sealLinkIdentity(secret,sealed,id,principal)},as(owner));
      }};
  }
  async function live(days = 7) {
    const f = await fixture(days);
    await f.approve();
    expect((await f.link()).status).toBe(201);
    return f;
  }
  const read = (secret: string, query = '') => request('/a/'+secret+query,'GET',undefined,{});

  it('creates a read-only link agent and stores only the sealed identity and a hash of the secret', async () => {
    const f = await fixture();
    expect((await request('/v1/agent-sessions','POST',{journeyId:f.id,agentPublicKey:{recipient:'r',signingKey:'s'},requestedScope:'readwrite',keyStorage:'link',remembered:true})).status).toBe(400);
    expect((await request('/v1/agent-sessions','POST',{journeyId:f.id,agentPublicKey:{recipient:'r',signingKey:'s'},requestedScope:'read',keyStorage:'link'})).status).toBe(400);
    expect((await f.link()).status).toBe(404); // Not yet approved.
    expect((await request('/v1/agent-sessions/'+f.sessionId+'/approve','POST',{...f.approval,scope:'readwrite'},{Cookie:f.owner.cookie})).status).toBe(400);
    expect((await request('/v1/agent-sessions/'+f.sessionId+'/approve','POST',{...f.approval,expiresAt:Date.now()+31*day},{Cookie:f.owner.cookie})).status).toBe(400);
    await f.approve();
    const unverified = await account(f.owner.email);
    expect((await request('/v1/journeys/'+f.id+'/agent-links','POST',{sessionId:f.sessionId,hash:await linkLookupHash(f.secret),blob:'abcd'},{Cookie:unverified.cookie,'X-Principal':f.owner.principal})).status).toBe(401);
    const created = await f.link();
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({memberId:f.principal,expiresAt:f.expiresAt});
    expect((await f.link()).status).toBe(409);
    const registry = (env as unknown as Env).REGISTRY.get((env as unknown as Env).REGISTRY.idFromName('registry-v2'));
    const stored = await runInDurableObject(registry, (_object, state) => JSON.stringify([state.storage.sql.exec('SELECT * FROM agent_links').toArray(), state.storage.sql.exec('SELECT * FROM agent_sessions').toArray()]));
    expect(stored).toContain(await linkLookupHash(f.secret));
    expect(stored).not.toContain(f.secret);
    expect(stored).not.toContain(f.age.identity);
    const listed = await (await request('/v1/journeys/'+f.id+'/agent-links','GET',undefined,as(f.owner))).json() as {links:{memberId:string,expiresAt:number}[]};
    expect(listed.links).toMatchObject([{memberId:f.principal,expiresAt:f.expiresAt}]);
    expect(JSON.stringify(listed)).not.toContain(f.secret);
    const kind = await (await request('/v1/agent-sessions/'+f.sessionId)).json() as {keyStorage:string};
    expect(kind.keyStorage).toBe('link');
  });

  it('serves the decrypted journey as JSON with no-store headers, and never logs or stores the plaintext', async () => {
    const f = await live();
    await addItem(f.owner,f.id,f.key,'First note','Plain text the agent should read');
    const logs = [vi.spyOn(console,'log'),vi.spyOn(console,'error'),vi.spyOn(console,'warn'),vi.spyOn(console,'info')].map(spy => spy.mockImplementation(() => undefined));
    try {
      const response = await read(f.secret);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
      expect(response.headers.get('x-robots-tag')).toBe('noindex');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      const text = await response.text();
      expect(new TextEncoder().encode(text).length).toBeLessThan(12_288);
      const body = JSON.parse(text);
      expect(body).toMatchObject({
        about: 'Read-only access to an AI Wayfinding journey. Use this content to help the person; present it however they ask.',
        journey: {id:f.id,name:'Shared space',description:'',kind:'individual'},
        access: {agentName:'Cowork',scope:'read',expiresAt:new Date(f.expiresAt).toISOString(),expiringSoon:false,renewUrl:`${origin}/journeys/${f.id}/people#renew-${f.principal}`},
        items: [{type:'note',title:'First note',body:'Plain text the agent should read',tags:['a'],author:{name:'Journey member',kind:'person'}}],
        people: [{name:'Journey member',kind:'person'}],
        page: {number:1,of:1,next:null},
        howToWrite: 'This link is read-only. To add something, give the person the text and ask them to add it in the journey.',
      });
      expect(body.access.expiresInHours).toBeGreaterThanOrEqual(167);
      expect(body.access.renewHint).toContain(body.access.renewUrl);
      expect(JSON.stringify(body)).not.toContain('recipient');
      expect(JSON.stringify(body)).not.toContain('example.org');
      expect(logs.flatMap(spy => spy.mock.calls).flat().join(' ')).not.toContain(f.secret);
      expect(logs.flatMap(spy => spy.mock.calls).flat().join(' ')).not.toContain('Plain text');
    } finally { logs.forEach(spy => spy.mockRestore()); }
    const registry = (env as unknown as Env).REGISTRY.get((env as unknown as Env).REGISTRY.idFromName('registry-v2'));
    expect(await runInDurableObject(registry, (_object, state) => JSON.stringify(state.storage.sql.exec('SELECT * FROM agent_links').toArray()))).not.toContain('Plain text');
  });

  it('shows a person’s email to the link only when they chose to share it', async () => {
    const f = await live();
    const withProfile = async (name: string, email?: string) => {
      const entry = await signEntry({v:1,seq:f.controls.length,prev:await hashControlProof(f.controls.at(-1)!.proof),at:new Date().toISOString(),actor:f.owner.principal,type:'member.profile',body:{id:f.owner.principal,name,...(email ? {email} : {})}},f.ownerKey);
      const control = await cipherLog(f.key,f.id,entry);
      expect((await request('/v1/journeys/'+f.id+'/log','POST',{control},as(f.owner))).status).toBe(201); f.controls.push(control);
    };
    await withProfile('Dana');
    expect((await (await read(f.secret)).json() as {people:object[]}).people).toEqual([{name:'Dana',kind:'person'}]);
    await withProfile('Dana','dana@example.org');
    expect((await (await read(f.secret)).json() as {people:object[]}).people).toEqual([{name:'Dana',kind:'person',email:'dana@example.org'}]);
  });

  it('answers 404 for a wrong, malformed or unknown secret without saying which', async () => {
    const f = await live();
    const ended = {error:'ended',message:'This agent link has ended. Ask the person for a new one.'};
    for (const secret of [newLinkSecret(),'short','x'.repeat(43)+'!',f.secret.slice(0,-1)+(f.secret.endsWith('A') ? 'B' : 'A')]) {
      const response = await read(secret);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(ended);
      expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
    }
    expect((await read(f.secret,'?page=0')).status).toBe(400);
    expect((await read(f.secret,'?page=2')).status).toBe(404);
    expect(LINK_SECRET_PATTERN.test(f.secret)).toBe(true);
  });

  it('answers 410 with a renew address once the link has expired', async () => {
    const f = await live(1);
    expect((await read(f.secret)).status).toBe(200);
    try {
      vi.useFakeTimers(); vi.setSystemTime(f.expiresAt + 1);
      const response = await read(f.secret);
      expect(response.status).toBe(410);
      const body = await response.json() as {error:string,renewUrl:string,renewHint:string,message:string};
      expect(body.error).toBe('expired');
      expect(body.renewUrl).toBe(`${origin}/journeys/${f.id}/people#renew-${f.principal}`);
      expect(body.renewHint).toContain(body.renewUrl);
      expect(body.message).not.toContain('Shared space');
    } finally { vi.useRealTimers(); }
  });

  it('flags a link that is close to expiry', async () => {
    const f = await live(1);
    const body = await (await read(f.secret)).json() as {access:{expiringSoon:boolean,expiresInHours:number}};
    expect(body.access.expiringSoon).toBe(true);
    expect(body.access.expiresInHours).toBeLessThanOrEqual(24);
  });

  it('splits a long journey across pages that each stay under 12 KB', async () => {
    const f = await live(30);
    const long = 'Long body with émoji 🌱 and text. '.repeat(1200);
    await addItem(f.owner,f.id,f.key,'Huge',long);
    for (let i = 0; i < 12; i++) await addItem(f.owner,f.id,f.key,'Note '+i,('x'.repeat(900)+' ').repeat(2));
    let url = '/a/'+f.secret; const seen: {number:number,of:number}[] = []; const parts = new Map<string,string>(); let titles: string[] = [];
    for (let n = 0; n < 30; n++) {
      const response = await request(url,'GET',undefined,{});
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(new TextEncoder().encode(text).length).toBeLessThan(12_288);
      const body = JSON.parse(text) as {page:{number:number,of:number,next:string|null},items:{title:string,body:string,part?:{number:number,of:number}}[]};
      seen.push({number:body.page.number,of:body.page.of});
      for (const item of body.items) { titles.push(item.title); parts.set(item.title,(parts.get(item.title) ?? '')+item.body); }
      if (!body.page.next) break;
      expect(body.page.next.startsWith(origin+'/a/'+f.secret+'?page=')).toBe(true);
      url = body.page.next.slice(origin.length);
    }
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.every(page => page.of === seen.length)).toBe(true);
    expect(seen.map(page => page.number)).toEqual(seen.map((_page,index) => index+1));
    expect(parts.get('Huge')).toBe(long);
    expect(new Set(titles).size).toBe(13);
    expect((await read(f.secret,'?page='+(seen.length+1))).status).toBe(404);
  });

  it('applies a per-link request limit without affecting other links', async () => {
    const f = await live(), other = await live();
    for (let i = 0; i < 60; i++) expect((await read(f.secret)).status).toBe(200);
    const limited = await read(f.secret);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('cache-control')).toBe('no-store, no-transform');
    expect((await read(other.secret)).status).toBe(200);
  }, 60_000);

  it('ends the link at once when the member is removed', async () => {
    const f = await live();
    expect((await read(f.secret)).status).toBe(200);
    const removal = await signEntry({v:1,seq:f.controls.length,prev:await hashControlProof(f.controls.at(-1)!.proof),at:new Date().toISOString(),actor:f.owner.principal,type:'member.remove',body:{member:f.principal}},f.ownerKey);
    const removed = await request('/v1/journeys/'+f.id+'/log','POST',{control:await cipherLog(f.key,f.id,removal)},as(f.owner));
    expect(removed.status).toBe(201);
    const response = await read(f.secret);
    expect(response.status).toBe(404);
    expect((await response.json() as {message:string}).message).toBe('This agent link has ended. Ask the person for a new one.');
    expect((await (await request('/v1/journeys/'+f.id+'/agent-links','GET',undefined,as(f.owner))).json() as {links:unknown[]}).links).toEqual([]);
  });

  it('refuses a link whose stored control signature no longer verifies', async () => {
    const f = await live();
    expect((await read(f.secret)).status).toBe(200);
    const stub = (env as unknown as Env).ENCLAVES.get((env as unknown as Env).ENCLAVES.idFromName(f.id));
    await runInDurableObject(stub, (_object, state) => {
      const row = state.storage.sql.exec('SELECT entry FROM log WHERE seq=0').toArray()[0]!;
      const control = JSON.parse(String(row.entry));
      control.proof.sig = 'AAAA';
      state.storage.sql.exec('UPDATE log SET entry=? WHERE seq=0', JSON.stringify(control));
    });
    const response = await read(f.secret);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'unavailable', message: 'This journey history could not be verified, so it is not shown. Ask the person to check the journey.' });
  });
});
