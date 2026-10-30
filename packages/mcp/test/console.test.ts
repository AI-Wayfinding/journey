import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet } from 'jose';
import { createApp } from '../src/app.ts';
import { createVerifier } from '../src/auth.ts';
import { MemoryBackend } from '../src/backend.ts';
import { bridge, ISSUER, keyPair, RESOURCE, token } from './helpers.ts';
import { runInNewContext } from 'node:vm';
import { authenticator } from './console-authenticator.ts';
import { parseCommand } from '../src/commands.ts';

const signer = await keyPair('console');
const origin = RESOURCE.origin;
const clientId = `${origin}/console/client.json`;
const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1]!;
const signedOut = (r: Response) => { assert.equal(r.status, 303); assert.equal(new URL(r.headers.get('location')!, origin).pathname, '/console/login'); };
async function fixture() {
  let now = Date.now();
  let accessToken = await token(signer, { sub: 'alice', client_id: clientId });
  const exchanges: URLSearchParams[] = [];
  const backend = new MemoryBackend({ async get(s) { return { name: s, email: `${s}@example.test` }; } }, () => now);
  const target = createApp({ verifier: createVerifier({ issuer: ISSUER, resource: RESOURCE, getKey: createLocalJWKSet(signer.jwks) }),
    resource: RESOURCE, issuer: ISSUER, allowedHosts: [RESOURCE.hostname], backend,
    console: { secret: 'synthetic-console-secret-at-least-32-bytes', backend, now: () => now,
      send: async (url, init) => { assert.equal(String(url), `${ISSUER}/oauth2/token`); exchanges.push(new URLSearchParams(String(init?.body))); return Response.json({ access_token: accessToken, token_type: 'Bearer' }); } },
  });
  const send = (path: string, init?: RequestInit) => bridge(target)(`${origin}${path}`, init);
  async function login() {
    const start = await send('/console/login');
    assert.equal(start.status, 302);
    const auth = new URL(start.headers.get('location')!);
    const transaction = start.headers.get('set-cookie')!.split(';')[0]!;
    const callback = `/console/callback?code=synthetic-code&state=${auth.searchParams.get('state')}`;
    const finish = await send(callback, { headers: { cookie: transaction } });
    return { auth, transaction, callback, finish, cookie: finish.headers.get('set-cookie')?.split(';')[0] ?? '' };
  }
  return { backend, send, exchanges, login, advance: (ms: number) => { now += ms; }, access: (value: string) => { accessToken = value; } };
}

test('console: OAuth metadata and PKCE login create an eight-hour hardened session', async () => {
  const f = await fixture();
  const metadata = await f.send('/console/client.json');
  assert.equal(metadata.status, 200);
  const doc = await metadata.json() as Record<string, unknown>;
  assert.equal(doc.client_id, clientId);
  assert.deepEqual(doc.redirect_uris, [`${origin}/console/callback`]);
  assert.equal(doc.token_endpoint_auth_method, 'none');
  const login = await f.login();
  assert.equal(login.auth.origin, ISSUER);
  assert.equal(login.auth.searchParams.get('client_id'), clientId);
  assert.equal(login.auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(login.auth.searchParams.get('redirect_uri'), `${origin}/console/callback`);
  assert.equal(login.auth.searchParams.get('resource'), RESOURCE.href);
  const exchange = f.exchanges[0]!;
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(exchange.get('client_id'), clientId);
  assert.equal(exchange.get('code'), 'synthetic-code');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exchange.get('code_verifier')!));
  assert.equal(Buffer.from(hash).toString('base64url'), login.auth.searchParams.get('code_challenge'));
  assert.equal(login.finish.status, 303);
  const cookie = login.finish.headers.get('set-cookie')!;
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=28800', 'Path=/']) assert.ok(cookie.includes(flag), flag);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.match(await (await f.send('/console', { headers: { cookie: login.cookie } })).text(), /Journeys.*Agents.*Connected clients/s);
});


test('console: passkey registration, exact card assertion and client binding use real WebAuthn', async () => {
  const f = await fixture(), login = await f.login(), key = await authenticator();
  const home = await (await f.send('/console', { headers: { cookie: login.cookie } })).text();
  const csrf = csrfOf(home);
  const post = (path: string, body: Record<string, unknown>) => f.send(path, { method: 'POST', headers: { cookie: login.cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ csrf, ...body }) });
  const optionsResponse = await post('/console/passkeys/options', {});
  assert.equal(optionsResponse.status, 200);
  const options = await optionsResponse.json() as { challenge: string; rp: { id: string }; authenticatorSelection: { userVerification: string } };
  assert.equal(options.rp.id, 'poc.wayfinding.support');
  assert.equal(options.authenticatorSelection.userVerification, 'required');
  assert.equal((await post('/console/passkeys/register', { credential: key.register(options.challenge) })).status, 303);
  assert.match(await (await f.send('/console/passkeys', { headers: { cookie: login.cookie } })).text(), new RegExp(key.id));
  assert.equal((await post('/console/passkeys/register', { credential: key.register(options.challenge) })).status, 403, 'registration is one-shot');
  const agentId = String((await f.backend.execute('alice', parseCommand('agent_create', { name: 'Scout' }), clientId)).agentId);
  const change = { kind: 'card', agentId, capabilities: ['post'] };
  assert.equal((await post('/console/authorize/complete', { change })).status, 403);
  const challengeResponse = await post('/console/authorize/options', { change });
  assert.equal(challengeResponse.status, 200);
  const challenge = (await challengeResponse.json() as { challenge: string }).challenge;
  const assertion = await key.assert(challenge);
  assert.equal((await post('/console/authorize/complete', { change: { ...change, capabilities: ['read'] }, assertion })).status, 403);
  assert.equal((await post('/console/authorize/complete', { change, assertion })).status, 303);
  assert.deepEqual((await f.backend.execute('alice', parseCommand('agent_capabilities', { agentId }), clientId)).capabilities, ['post']);
  assert.equal((await post('/console/authorize/complete', { change, assertion })).status, 403);
  const bind = { kind: 'bind', agentId, clientId: 'assistant' };
  assert.equal((await post('/console/authorize/complete', { change: bind, assertion })).status, 403);
  const binding = await (await post('/console/authorize/options', { change: bind })).json() as { challenge: string };
  assert.equal((await post('/console/authorize/complete', { change: bind, assertion: await key.assert(binding.challenge, 2) })).status, 303);
  assert.equal((await f.backend.execute('alice', parseCommand('client_list', {}), 'assistant')).actingAgent, agentId);
  await assert.rejects(f.backend.execute('alice', parseCommand('account_read', {}), 'assistant'));
  const unbind = { kind: 'unbind', agentId, clientId: 'assistant' };
  const unbindOptions = await (await post('/console/authorize/options', { change: unbind })).json() as { challenge: string };
  assert.equal((await post('/console/authorize/complete', { change: unbind, assertion: await key.assert(unbindOptions.challenge, 3) })).status, 303);
  assert.equal((await f.backend.execute('alice', parseCommand('client_list', {}), 'assistant')).actingAgent, undefined);
  assert.equal((await post('/console/agents/narrow', { agentId, capabilities: ['post'] })).status, 303);
  assert.deepEqual((await f.backend.execute('alice', parseCommand('agent_capabilities', { agentId }), clientId)).capabilities, []);
  assert.equal((await post('/console/agents/remove', { agentId })).status, 303);
  await assert.rejects(f.backend.execute('alice', parseCommand('agent_capabilities', { agentId }), clientId));
});


test('console: CSRF, foreign origins, oversized bodies and hostile form fields cannot mutate', async () => {
  const f = await fixture(), login = await f.login();
  const html = await (await f.send('/console', { headers: { cookie: login.cookie } })).text(), csrf = csrfOf(html);
  const post = (body: string, requestOrigin: string = origin, type = 'application/json') => f.send('/console/agents/create', { method: 'POST', headers: { cookie: login.cookie, origin: requestOrigin, 'content-type': type }, body });
  for (const body of [{ name: 'Missing' }, { name: 'Wrong', csrf: 'bad' }]) assert.equal((await post(JSON.stringify(body))).status, 403);
  assert.equal((await post(JSON.stringify({ csrf, name: 'Cross site' }), 'https://evil.example')).status, 403);
  assert.equal((await post(JSON.stringify({ csrf, name: 'x'.repeat(100_000) }))).status, 403);
  assert.equal((await post(`csrf=${csrf}&csrf=${csrf}&name=duplicate`, origin, 'application/x-www-form-urlencoded')).status, 403);
  assert.deepEqual((await f.backend.execute('alice', parseCommand('agent_list', {}), clientId)).agents, []);
  assert.equal((await post(JSON.stringify({ csrf, name: 'Allowed', capabilities: ['read'], subject: 'mallory', live: true }))).status, 303);
  const agents = (await f.backend.execute('alice', parseCommand('agent_list', {}), clientId)).agents as { name: string; capabilities: string[] }[];
  assert.equal(agents[0]!.name, 'Allowed'); assert.deepEqual(agents[0]!.capabilities, []);
});

test('console: OAuth state is cookie-bound, expires, and a callback can be exchanged only once', async () => {
  const f = await fixture();
  const start = await f.send('/console/login'), auth = new URL(start.headers.get('location')!), cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const callback = `/console/callback?code=code&state=${auth.searchParams.get('state')}`;
  assert.equal((await f.send(callback)).status, 403);
  assert.equal((await f.send(callback.replace('state=', 'state=wrong'), { headers: { cookie } })).status, 403);
  assert.equal(f.exchanges.length, 0);
  const login = await f.login(); assert.equal(login.finish.status, 303);
  assert.equal((await f.send(login.callback, { headers: { cookie: login.transaction } })).status, 403);
  assert.equal(f.exchanges.length, 1);
  const late = await f.send('/console/login');
  const lateAuth = new URL(late.headers.get('location')!), lateCookie = late.headers.get('set-cookie')!.split(';')[0]!;
  f.advance(600_001);
  assert.equal((await f.send(`/console/callback?code=late&state=${lateAuth.searchParams.get('state')}`, { headers: { cookie: lateCookie } })).status, 403);
  assert.equal(f.exchanges.length, 1);
});

test('console: bound and foreign client tokens cannot create sessions or authenticate pages', async () => {
  const f = await fixture();
  for (const claims of [{ sub: 'alice', client_id: 'assistant' }, { sub: 'alice', client_id: clientId, aud: 'https://evil.example/mcp' }, { sub: 'alice', client_id: clientId, iss: 'https://evil.example' }]) {
    const bearer = await token(signer, claims); f.access(bearer);
    assert.equal((await f.login()).finish.status, 403);
    signedOut(await f.send('/console', { redirect: 'manual', headers: { authorization: `Bearer ${bearer}` } }));
  }
  f.access(await token(signer, { sub: 'alice', client_id: clientId }));
  const login = await f.login(); assert.equal(login.finish.status, 303);
  const agentId = String((await f.backend.execute('alice', parseCommand('agent_create', { name: 'Bound console probe' }), clientId)).agentId);
  const key = await authenticator(), csrf = csrfOf(await (await f.send('/console', { headers: { cookie: login.cookie } })).text());
  const post = (path: string, body: Record<string, unknown>) => f.send(path, { method: 'POST', headers: { cookie: login.cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ csrf, ...body }) });
  const registration = await (await post('/console/passkeys/options', {})).json() as { challenge: string };
  assert.equal((await post('/console/passkeys/register', { credential: key.register(registration.challenge) })).status, 303);
  const change = { kind: 'bind' as const, clientId, agentId };
  assert.equal((await post('/console/authorize/options', { change })).status, 403, 'HTTP cannot bind the console id');
  // Exercise an already-bound console identity through the real host authorization seam.
  const identity = { subject: 'alice', clientId: 'trusted-test-person' };
  const { challenge } = await f.backend.beginAuthorization(identity, change);
  await f.backend.completeAuthorization(identity, change, await key.assert(challenge));
  assert.equal((await f.send('/console', { headers: { cookie: login.cookie } })).status, 403);
  assert.equal((await f.login()).finish.status, 403);
});

test('console: tampered, expired and logged-out session cookies are refused; logout needs CSRF', async () => {
  const f = await fixture(), login = await f.login();
  const html = await (await f.send('/console', { headers: { cookie: login.cookie } })).text(), csrf = csrfOf(html);
  const [name, value] = login.cookie.split('=');
  const altered = `${name}=${value!.slice(0, -8)}AAAAAAAA`;
  signedOut(await f.send('/console', { redirect: 'manual', headers: { cookie: altered } }));
  assert.equal((await f.send('/console/logout', { method: 'POST', headers: { cookie: login.cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: '' })).status, 403);
  const loggedOut = await f.send('/console/logout', { method: 'POST', headers: { cookie: login.cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: `csrf=${csrf}` });
  assert.equal(loggedOut.status, 303); assert.match(loggedOut.headers.get('set-cookie')!, /Max-Age=0/);
  signedOut(await f.send('/console', { redirect: 'manual', headers: { cookie: login.cookie } }));
  const expired = await f.login(); f.advance(28_800_001);
  signedOut(await f.send('/console', { redirect: 'manual', headers: { cookie: expired.cookie } }));
});

test('console: semantic pages escape names and preserve membership and card limits', async () => {
  const f = await fixture(), login = await f.login(), headers = { cookie: login.cookie };
  const journeyId = String((await f.backend.execute('alice', parseCommand('journey_create', { name: '<script>journey</script>' }), clientId)).journeyId);
  const agentId = String((await f.backend.execute('alice', parseCommand('agent_create', { name: '<img src=x onerror=alert(1)>' }), clientId)).agentId);
  const home = await (await f.send('/console', { headers })).text();
  assert.match(home, /&lt;script&gt;journey&lt;\/script&gt;/); assert.doesNotMatch(home, /<img src=x/);
  const detail = await f.send(`/console/agents/${agentId}`, { headers });
  const body = await detail.text(); assert.equal(detail.status, 200);
  assert.match(body, /<fieldset><legend>Account capabilities/); assert.match(body, /Journey capabilities/);
  assert.doesNotMatch(body, /value="grant.issue"/); assert.match(body, /name="capabilities" value="post"/);
  assert.match(detail.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const csrf = csrfOf(home);
  assert.equal((await f.send('/console/authorize/start', { method: 'POST', headers: { ...headers, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, kind: 'card', agentId }).toString() })).status, 200);
  const boards = await f.backend.execute('alice', parseCommand('forum_boards', { journeyId }), clientId);
  const boardId = (boards.boards as { boardId: string }[])[0]!.boardId;
  await f.backend.execute('alice', parseCommand('topic_create', { boardId, title: '<script>Forum title</script>', body: 'Synthetic post' }), clientId);
  const journey = await f.send(`/console/journeys/${journeyId}`, { headers }); assert.equal(journey.status, 200);
  const journeyHtml = await journey.text();
  assert.match(journeyHtml, /Members.*Library.*Forum topics.*Sensemaking rounds/s);
  assert.equal(journeyHtml.includes('&lt;script&gt;Forum title&lt;/script&gt; · 0 replies'), true);
  assert.doesNotMatch(journeyHtml, /<script>Forum title/);
  const other = String((await f.backend.execute('bob', parseCommand('journey_create', { name: 'Bob private' }), 'other')).journeyId);
  assert.equal((await f.send(`/console/journeys/${other}`, { headers })).status, 403);
  assert.equal((await f.send('/console', { headers: { ...headers, host: 'evil.example' } })).status, 403);
  assert.equal((await f.send('/console/agents/%2Fbad', { headers })).status, 403);
});


test('console: registration and assertions reject wrong origin, expiry, counter replay and deleted keys', async () => {
  const f = await fixture(), login = await f.login(), key = await authenticator();
  const csrf = csrfOf(await (await f.send('/console', { headers: { cookie: login.cookie } })).text());
  const post = (path: string, body: Record<string, unknown>) => f.send(path, { method: 'POST', headers: { cookie: login.cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ csrf, ...body }) });
  const options = await (await post('/console/passkeys/options', {})).json() as { challenge: string };
  assert.equal((await post('/console/passkeys/register', { credential: key.register(options.challenge, 'https://evil.example') })).status, 403);
  assert.equal((await post('/console/passkeys/register', { credential: key.register(options.challenge) })).status, 303);
  const agentId = String((await f.backend.execute('alice', parseCommand('agent_create', { name: 'Expiry' }), clientId)).agentId);
  const change = { kind: 'card', agentId, capabilities: ['post'] };
  const first = await (await post('/console/authorize/options', { change })).json() as { challenge: string };
  assert.equal((await post('/console/authorize/complete', { change, assertion: await key.assert(first.challenge, 1, 'https://evil.example') })).status, 403);
  assert.equal((await post('/console/authorize/complete', { change, assertion: await key.assert(first.challenge, 1) })).status, 303);
  const second = await (await post('/console/authorize/options', { change })).json() as { challenge: string };
  assert.equal((await post('/console/authorize/complete', { change, assertion: await key.assert(second.challenge, 1) })).status, 403, 'authenticator counter cannot replay');
  f.advance(300_001);
  const expired = await key.assert(second.challenge, 2);
  assert.equal((await post('/console/authorize/complete', { change, assertion: expired })).status, 403, 'five minute assertion expiry');
  const pending = await (await post('/console/authorize/options', { change })).json() as { challenge: string };
  const deleted = await key.assert(pending.challenge, 2);
  // Session survives; deleting a key clears every outstanding exact-change challenge.
  assert.equal((await post('/console/passkeys/delete', { id: key.id })).status, 303);
  assert.equal((await post('/console/authorize/complete', { change, assertion: deleted })).status, 403);
  assert.doesNotMatch(await (await f.send('/console/passkeys', { headers: { cookie: login.cookie } })).text(), new RegExp(key.id));
});


test('console: real Durable Object adapters persist one-shot sessions, registration and logout after eviction', async () => {
  const { AccountsHost } = await import('../src/accounts.ts');
  const { Accounts, durableBackend } = await import('../src/objects.ts');
  const { MemoryStorage } = await import('../src/storage.ts');
  const { MemoryBlobs } = await import('../src/relay.ts');
  const storage = new MemoryStorage(), blobs = new MemoryBlobs();
  await new AccountsHost(storage, { async get() { return { name: 'Alice', email: 'alice@example.test' }; } }).provision('alice');
  const backend = durableBackend({ WORKOS_API_KEY: 'unused', BLOBS: blobs,
    ACCOUNTS: { getByName() { const object = new Accounts({ storage }, { WORKOS_API_KEY: 'unused', BLOBS: blobs }); return { fetch: (request) => object.fetch(request) }; } },
    JOURNEYS: { getByName() { throw new Error('No journeys requested'); } },
  });
  const access_token = await token(signer, { sub: 'alice', client_id: clientId });
  // Recreate both the app and object adapters for each HTTP request.
  const send = (path: string, init?: RequestInit) => bridge(createApp({ resource: RESOURCE, issuer: ISSUER, allowedHosts: [RESOURCE.hostname], backend,
    verifier: createVerifier({ issuer: ISSUER, resource: RESOURCE, getKey: createLocalJWKSet(signer.jwks) }),
    console: { backend, secret: 'synthetic-console-secret-at-least-32-bytes', send: async () => Response.json({ access_token, token_type: 'Bearer' }) },
  }))(`${origin}${path}`, init);
  const start = await send('/console/login'), auth = new URL(start.headers.get('location')!);
  const callback = `/console/callback?code=test&state=${auth.searchParams.get('state')}`, transaction = start.headers.get('set-cookie')!.split(';')[0]!;
  const finish = await send(callback, { headers: { cookie: transaction } }); assert.equal(finish.status, 303);
  assert.equal((await send(callback, { headers: { cookie: transaction } })).status, 403);
  const cookie = finish.headers.get('set-cookie')!.split(';')[0]!;
  const home = await send('/console', { headers: { cookie } }); assert.equal(home.status, 200);
  const csrf = csrfOf(await home.text()), key = await authenticator();
  const post = (path: string, body: Record<string, unknown>) => send(path, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ csrf, ...body }) });
  const options = await (await post('/console/passkeys/options', {})).json() as { challenge: string };
  assert.equal((await post('/console/passkeys/register', { credential: key.register(options.challenge) })).status, 303);
  assert.match(await (await send('/console/passkeys', { headers: { cookie } })).text(), new RegExp(key.id));
  assert.equal((await post('/console/logout', {})).status, 303);
  signedOut(await send('/console', { redirect: 'manual', headers: { cookie } }));
});


test('console: served browser script completes registration and assertion through native credential APIs', async () => {
  const f = await fixture(), login = await f.login(), key = await authenticator();
  const csrf = csrfOf(await (await f.send('/console', { headers: { cookie: login.cookie } })).text());
  const script = await (await f.send('/console/webauthn.js')).text();
  async function browser(kind: 'register' | 'assert', change?: Record<string, unknown>) {
    let handler: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
    const button = { disabled: false }, status = { textContent: '' }, navigations: string[] = [];
    const fields = new Map<string, string>([['csrf', csrf]]); if (change) fields.set('change', JSON.stringify(change));
    const form = { dataset: { ceremony: kind, options: kind === 'register' ? '/console/passkeys/options' : '/console/authorize/options' },
      action: kind === 'register' ? '/console/passkeys/register' : '/console/authorize/complete', querySelector: () => button,
      addEventListener(_name: string, callback: typeof handler) { handler = callback; } };
    const decode = (value: string) => Buffer.from(value, 'base64url');
    async function credential(register: boolean, options: { publicKey: { challenge: Uint8Array } }) {
      const challenge = Buffer.from(options.publicKey.challenge).toString('base64url');
      const result = register ? key.register(challenge) : await key.assert(challenge);
      const response = Object.fromEntries(Object.entries(result.response).filter(([, value]) => typeof value === 'string').map(([name, value]) => [name, decode(String(value))]));
      return { id: result.id, rawId: decode(result.rawId), response: { ...response, getTransports: () => ['internal'] } };
    }
    runInNewContext(script, { document: { querySelectorAll: () => [form], getElementById: () => status },
      FormData: class { get(name: string) { return fields.get(name); } has(name: string) { return fields.has(name); } },
      window: { PublicKeyCredential: {} }, navigator: { credentials: { create: (options: { publicKey: { challenge: Uint8Array } }) => credential(true, options), get: (options: { publicKey: { challenge: Uint8Array } }) => credential(false, options) } },
      Uint8Array, atob, btoa, URL, location: { origin, assign: (value: string) => navigations.push(value) },
      fetch: async (path: string, init: RequestInit) => {
        const url = new URL(path, origin);
        const response = await f.send(url.pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie: login.cookie, origin } });
        // Browser fetch follows same-origin 303 redirects and exposes the final URL.
        const destination = response.headers.get('location');
        if (response.status === 303 && destination) return { ok: true, url: `${origin}${destination}` };
        return response;
      },
    }, { timeout: 3000 });
    assert.ok(handler); await handler({ preventDefault() {} });
    assert.equal(status.textContent, ''); assert.equal(button.disabled, false); assert.equal(navigations.length, 1);
    return navigations[0];
  }
  assert.equal(await browser('register'), '/console/passkeys');
  const agentId = String((await f.backend.execute('alice', parseCommand('agent_create', { name: 'Browser' }), clientId)).agentId);
  assert.equal(await browser('assert', { kind: 'card', agentId, capabilities: ['post'] }), `/console/agents/${agentId}`);
  assert.deepEqual((await f.backend.execute('alice', parseCommand('agent_capabilities', { agentId }), clientId)).capabilities, ['post']);
});


test('views console: linked journey library, forum and round routes read live work and escape text', async () => {
  const f = await fixture(), login = await f.login();
  const call = (tool: string, input: Record<string, unknown> = {}) => f.backend.execute('alice', parseCommand(tool, input), clientId);
  const journeyId = (await call('journey_create', { name: 'Workspace' })).journeyId;
  const itemId = (await call('library_add', { journeyId, name: '<b>Source</b>', kind: 'prompt', labels: ['research'], description: '<script>unsafe</script>', text: 'ARTIFACT-CONTENT' })).itemId;
  const roundId = (await call('round_create', { journeyId, title: 'First position', goal: 'Find a heading' })).roundId;
  await call('interview_write', { roundId, text: '<img src=x onerror=alert(1)> PRIVATE-NOTES' });
  const topicId = (await call('conversation_post', { journeyId, target: { itemId }, body: '<script>Forum words</script>' })).topicId;
  const root = `/console/journeys/${journeyId}`;
  const read = async (path: string) => { const response = await f.send(path, { headers: { cookie: login.cookie } }); assert.equal(response.status, 200, path); return response.text(); };
  const home = await read(root);
  for (const suffix of ['/library', '/forum', '/rounds']) assert.ok(home.includes(`${root}${suffix}`));
  const library = await read(`${root}/library?kind=prompt&label=research&query=Source`);
  assert.ok(library.includes(`${root}/library/${itemId}`)); assert.match(library, /&lt;b&gt;Source&lt;\/b&gt;/);
  assert.doesNotMatch(library, /ARTIFACT-CONTENT|PRIVATE-NOTES/);
  const detail = await read(`${root}/library/${itemId}`);
  assert.match(detail, /&lt;script&gt;unsafe&lt;\/script&gt;/); assert.match(detail, /&lt;script&gt;Forum words&lt;\/script&gt;/);
  assert.doesNotMatch(detail, /<script>unsafe|ARTIFACT-CONTENT/);
  const forum = await read(`${root}/forum`); assert.ok(forum.includes(`${root}/forum/${topicId}`));
  assert.match(await read(`${root}/forum/${topicId}`), /alice.*person.*Forum words/s);
  assert.ok((await read(`${root}/rounds`)).includes(`${root}/rounds/${roundId}`));
  const round = await read(`${root}/rounds/${roundId}`);
  assert.match(round, /Find a heading.*planned.*open.*synthesising.*closed/s); assert.doesNotMatch(round, /PRIVATE-NOTES/);
  const mine = await read(`${root}/rounds/${roundId}?interview=mine`);
  assert.match(mine, /My interview.*&lt;img src=x onerror=alert\(1\)&gt; PRIVATE-NOTES/s);
});

test('views console: private interview selectors, mismatched journeys and outsider reads fail closed', async () => {
  const f = await fixture(), login = await f.login();
  const alice = (tool: string, input: Record<string, unknown> = {}) => f.backend.execute('alice', parseCommand(tool, input), clientId);
  const journeyId = (await alice('journey_create', { name: 'Shared', policy: 'open', defaultRole: 'write' })).journeyId;
  const bob = (await f.backend.execute('bob', parseCommand('account_read', {}))).personId;
  await f.backend.execute('bob', parseCommand('journey_join', { journeyId }));
  const roundId = (await alice('round_create', { journeyId, title: 'Private', goal: 'Protect notes' })).roundId;
  await f.backend.execute('bob', parseCommand('interview_write', { roundId, text: 'BOB-PRIVATE' }));
  const hiddenId = (await f.backend.execute('bob', parseCommand('library_add', { journeyId, name: 'Bob private', visibility: 'private', text: 'BOB-PRIVATE' }))).itemId;
  const otherJourney = (await alice('journey_create', { name: 'Other' })).journeyId;
  const outsiderJourney = (await f.backend.execute('bob', parseCommand('journey_create', { name: 'Bob only' }))).journeyId;
  for (const path of [`/console/journeys/${journeyId}/rounds/${roundId}?personId=${bob}`, `/console/journeys/${journeyId}/rounds/${roundId}?interview=${bob}`, `/console/journeys/${otherJourney}/rounds/${roundId}`, `/console/journeys/${journeyId}/library/${hiddenId}`, `/console/journeys/${outsiderJourney}/library`]) {
    const response = await f.send(path, { headers: { cookie: login.cookie } });
    assert.equal(response.status, 403, path); assert.doesNotMatch(await response.text(), /BOB-PRIVATE/);
  }
  const response = await f.send(`/console/journeys/${journeyId}/rounds/${roundId}?interview=mine`, { headers: { cookie: login.cookie } });
  assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /BOB-PRIVATE/);
});

test('console: a signed-out page visit redirects to sign-in while signed-out POSTs stay refused', async () => {
  const f = await fixture();
  const page = await f.send('/console', { redirect: 'manual' });
  assert.equal(page.status, 303);
  assert.equal(new URL(page.headers.get('location')!, origin).pathname, '/console/login');
  const forged = await f.send('/console/agents/create', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=x&name=Forged' });
  assert.equal(forged.status, 403);
});
