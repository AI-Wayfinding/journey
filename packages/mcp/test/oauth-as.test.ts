import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet } from 'jose';
import { createApp } from '../src/app.ts';
import { createVerifier } from '../src/auth.ts';
import { MemoryBackend } from '../src/backend.ts';
import { parseCommand } from '../src/commands.ts';
import { AccountsHost } from '../src/accounts.ts';
import { Accounts } from '../src/objects.ts';
import { MemoryStorage } from '../src/storage.ts';
import { bridge, ISSUER, keyPair, RESOURCE, token, listToolsRequest } from './helpers.ts';

const signer = await keyPair('oauth-as');
const origin = RESOURCE.origin, consoleClient = `${origin}/console/client.json`;
const verifier = 'a'.repeat(43), challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
const callback = 'http://127.0.0.1:32123/callback';
const csrfOf = (s: string) => /name="csrf" value="([^"]+)"/.exec(s)![1]!;
async function fixture() {
  let now = Date.now();
  const backend = new MemoryBackend({ async get(s) { return { name: s, email: `${s}@example.test` }; } }, () => now);
  const upstream = await token(signer, { sub: 'alice', client_id: consoleClient });
  let document: unknown = { client_id: 'https://pi.dev/oauth/client.json', client_name: 'Pi', redirect_uris: [callback] };
  const app = createApp({ resource: RESOURCE, issuer: ISSUER, allowedHosts: [RESOURCE.hostname], backend,
    verifier: createVerifier({ issuer: ISSUER, resource: RESOURCE, getKey: createLocalJWKSet(signer.jwks) }),
    console: { backend, secret: 'synthetic-secret-with-at-least-32-bytes', now: () => now, send: async (url) => String(url).endsWith('/oauth2/token') ? Response.json({ access_token: upstream, token_type: 'Bearer' }) : Response.json(document) } });
  const send = (p: string, init?: RequestInit) => bridge(app)(new URL(p, origin), init);
  async function login(path = '/console/login') {
    const start = await send(path), dest = new URL(start.headers.get('location')!);
    const finish = await send(`/console/callback?code=synthetic&state=${dest.searchParams.get('state')}`, { headers: { cookie: start.headers.get('set-cookie')!.split(';')[0]! } });
    assert.equal(finish.status, 303);
    return finish.headers.get('set-cookie')!.split(';')[0]!;
  }
  const post = (path: string, body: Record<string, unknown>, cookie = '', originHeader = origin) => send(path, { method: 'POST', headers: { cookie, origin: originHeader, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const registered = await post('/oauth/register', { client_name: 'Claude Code', redirect_uris: [callback], token_endpoint_auth_method: 'none' });
  assert.equal(registered.status, 201);
  const client = await registered.json() as { client_id: string };
  const authorize = (clientId = client.client_id, extra: Record<string, string> = {}) => send('/oauth/authorize?' + new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'client-state', resource: RESOURCE.href, ...extra }));
  const exchange = (code: string, extra: Record<string, string> = {}) => send('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: callback, ...extra }).toString() });
  async function consent(cookie: string, capabilities = ['read', 'post'], journeys: string[] = []) {
    const start = await authorize();
    const location = start.headers.get('location')!;
    assert.ok(location.startsWith('/oauth/consent?'));
    const html = await (await send(location, { headers: { cookie } })).text();
    const id = new URL(location, origin).searchParams.get('request')!;
    const allow = await post('/oauth/consent', { csrf: csrfOf(html), request: id, decision: 'allow', name: 'Scout', capabilities, journeys }, cookie);
    assert.equal(allow.status, 303);
    const redirect = new URL(allow.headers.get('location')!);
    assert.equal(redirect.searchParams.get('state'), 'client-state');
    return redirect.searchParams.get('code')!;
  }
  return { backend, send, login, post, authorize, exchange, consent, client, upstream, advance: (ms: number) => { now += ms; }, document: (v: unknown) => { document = v; } };
}

test('oauth AS: metadata, DCR and CIMD validate before redirect, S256 and resource are mandatory', async () => {
  const f = await fixture();
  const metadata = await (await f.send('/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
  assert.equal(metadata.issuer, origin); assert.equal(metadata.token_endpoint, `${origin}/oauth/token`);
  const resource = await (await f.send('/.well-known/oauth-protected-resource/mcp')).json() as { authorization_servers: string[] };
  assert.deepEqual(resource.authorization_servers, [origin]);
  assert.equal((await f.authorize(undefined, { code_challenge_method: 'plain' })).status, 400);
  assert.equal((await f.authorize(undefined, { resource: 'https://evil.test/mcp' })).status, 400);
  assert.equal((await f.authorize(undefined, { redirect_uri: 'https://evil.test/callback' })).status, 400);
  assert.equal((await f.authorize('https://pi.dev/oauth/client.json')).status, 303);
  f.document({ client_id: 'https://evil.test/client.json', redirect_uris: [callback] });
  assert.equal((await f.authorize('https://pi.dev/oauth/client.json')).status, 400);
});

test('oauth AS: consent needs a fresh session, CSRF, origin, and refuses forbidden capabilities without storing them', async () => {
  const f = await fixture(), cookie = await f.login();
  const start = await f.authorize(), path = start.headers.get('location')!;
  const missing = await f.send(path); assert.equal(missing.status, 303); assert.match(missing.headers.get('location')!, /^\/console\/login/);
  const html = await (await f.send(path, { headers: { cookie } })).text(), csrf = csrfOf(html), id = new URL(path, origin).searchParams.get('request');
  assert.doesNotMatch(html, /value="grant.issue"|value="client.bind"/);
  const fields = { csrf, request: id, decision: 'allow', name: 'Scout', capabilities: ['read'], journeys: [] };
  assert.equal((await f.post('/oauth/consent', { ...fields, csrf: 'bad' }, cookie)).status, 403);
  assert.equal((await f.post('/oauth/consent', fields, cookie, 'https://evil.test')).status, 403);
  for (const capability of ['grant.issue', 'client.bind', 'agent.add', 'card.change', 'passkey.manage']) {
    assert.equal((await f.post('/oauth/consent', { ...fields, capabilities: [capability] }, cookie)).status, 403);
  }
  assert.equal((await f.backend.accountsHost.lookup('alice'))!.agents.length, 0);
  f.advance(600_001);
  assert.equal((await f.send(path, { headers: { cookie } })).status, 303);
});

test('oauth AS: code exchange binds PKCE, redirect and client, is single use and never accepts AuthKit at MCP', async () => {
  const f = await fixture(), cookie = await f.login();
  const code = await f.consent(cookie);
  assert.equal((await f.exchange(code, { code_verifier: 'b'.repeat(43) })).status, 400);
  assert.equal((await f.exchange(code, { redirect_uri: 'http://127.0.0.1:32124/callback' })).status, 400);
  assert.equal((await f.exchange(code, { client_id: 'another-client' })).status, 400);
  const response = await f.exchange(code); assert.equal(response.status, 200);
  const tokens = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
  assert.equal(tokens.expires_in, 3600);
  assert.equal((await f.exchange(code)).status, 400);
  assert.equal((await f.send('/mcp', listToolsRequest(f.upstream))).status, 401);
  assert.equal((await f.send('/mcp', listToolsRequest(tokens.access_token))).status, 200);
  assert.ok(!f.backend.snapshot().includes(tokens.access_token));
  assert.ok(!f.backend.snapshot().includes(tokens.refresh_token));
});

test('oauth AS: reauthorization updates one live agent; narrowing is live; deletion removes memberships and revokes tokens', async () => {
  const f = await fixture(), cookie = await f.login();
  const journey = await f.backend.execute('alice', parseCommand('journey_create', { name: 'Synthetic' }));
  const journeyId = String(journey.journeyId);
  const code = await f.consent(cookie, ['read', 'post'], [journeyId]);
  const tokens = await (await f.exchange(code)).json() as { access_token: string };
  const account = (await f.backend.accountsHost.lookup('alice'))!, agent = account.agents[0]!;
  assert.equal((await f.backend.execute('alice', parseCommand('journey_list', {}), f.client.client_id)).journeys instanceof Array, true);
  await f.consent(cookie, ['post'], [journeyId]);
  assert.equal((await f.backend.accountsHost.lookup('alice'))!.agents.length, 1);
  await assert.rejects(f.backend.execute('alice', parseCommand('journey_read', { journeyId }), f.client.client_id));
  await f.backend.execute('alice', parseCommand('agent_remove', { agentId: agent.id }), consoleClient);
  assert.equal((await f.send('/mcp', listToolsRequest(tokens.access_token))).status, 401);
  const view = await f.backend.execute('alice', parseCommand('journey_read', { journeyId }), consoleClient);
  assert.ok(!(view.members as { memberId: string }[]).some(m => m.memberId === agent.id));
});

test('oauth AS: refresh rotation reuse and revocation invalidate the whole family', async () => {
  const f = await fixture(), cookie = await f.login();
  const tokens = await (await f.exchange(await f.consent(cookie))).json() as { access_token: string; refresh_token: string };
  const refresh = (token: string) => f.send('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: f.client.client_id }).toString() });
  const rotatedResponse = await refresh(tokens.refresh_token); assert.equal(rotatedResponse.status, 200);
  const rotated = await rotatedResponse.json() as { access_token: string; refresh_token: string };
  assert.equal((await refresh(tokens.refresh_token)).status, 400);
  assert.equal((await refresh(rotated.refresh_token)).status, 400);
  assert.equal((await f.send('/mcp', listToolsRequest(rotated.access_token))).status, 401);
});

test('oauth AS: consent cannot attach another person agent or a journey the person does not belong to', async () => {
  const f = await fixture(), cookie = await f.login();
  const bob = await f.backend.execute('bob', parseCommand('journey_create', { name: 'Bob private' }));
  const start = await f.authorize(), path = start.headers.get('location')!, id = new URL(path, origin).searchParams.get('request');
  const html = await (await f.send(path, { headers: { cookie } })).text();
  assert.equal((await f.post('/oauth/consent', { csrf: csrfOf(html), request: id, decision: 'allow', name: 'Bad', capabilities: ['read'], journeys: [bob.journeyId], agentId: 'bobs-agent', subject: 'bob' }, cookie)).status, 403);
  assert.equal((await f.backend.accountsHost.lookup('alice'))!.agents.length, 0);
});

// Exercise the production bearer gate and backend together, not the legacy JWT test seam.
async function callTool(f: Awaited<ReturnType<typeof fixture>>, access: string, name: string, args: Record<string, unknown> = {}) {
  const response = await f.send('/mcp', { ...listToolsRequest(access), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = text.startsWith('data:') || text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data:'))!.slice(5) : text;
  return (JSON.parse(data) as { result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] } }).result;
}

test('oauth AS: whoami identifies the bound agent; bearer input cannot select another person agent or create agents', async () => {
  const f = await fixture(), cookie = await f.login();
  const journey = await f.backend.execute('alice', parseCommand('journey_create', { name: 'Shared test' }));
  const bob = await f.backend.execute('bob', parseCommand('agent_create', { name: 'Bob agent' }));
  const tokens = await (await f.exchange(await f.consent(cookie, ['read', 'post', 'journey.create'], [String(journey.journeyId)]))).json() as { access_token: string };
  const alice = (await f.backend.accountsHost.lookup('alice'))!;
  const identity = (await callTool(f, tokens.access_token, 'whoami')).structuredContent!;
  assert.deepEqual(identity.person, { id: alice.personId, name: 'alice' });
  assert.deepEqual(identity.agent, { id: alice.agents[0]!.id, name: 'Scout', capabilities: ['journey.create', 'read', 'post'], journeys: [journey.journeyId] });
  const refused = await callTool(f, tokens.access_token, 'journey_create', { name: 'Impersonation', actingAgent: bob.agentId });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /Bound client cannot replace its agent/);
  assert.equal((await callTool(f, tokens.access_token, 'agent_create', { name: 'Extra' })).isError, true);
  assert.equal((await f.backend.accountsHost.lookup('alice'))!.agents.length, 1);
});

test('oauth AS: consent refuses a foreign journey even without any injected identity fields', async () => {
  const f = await fixture(), cookie = await f.login();
  const bob = await f.backend.execute('bob', parseCommand('journey_create', { name: 'Private' }));
  const path = (await f.authorize()).headers.get('location')!;
  const html = await (await f.send(path, { headers: { cookie } })).text();
  const request = new URL(path, origin).searchParams.get('request');
  const denied = await f.post('/oauth/consent', { request, csrf: csrfOf(html), decision: 'allow', name: 'Scout', capabilities: ['read'], journeys: [bob.journeyId] }, cookie);
  assert.equal(denied.status, 403);
  assert.equal((await f.backend.accountsHost.lookup('alice'))!.agents.length, 0);
});

test('oauth AS: deny echoes state without creating an agent; loopback may vary only its port', async () => {
  const f = await fixture(), cookie = await f.login();
  assert.equal((await f.authorize(undefined, { redirect_uri: 'http://127.0.0.1:40222/other' })).status, 400);
  const path = (await f.authorize(undefined, { redirect_uri: 'http://127.0.0.1:40222/callback' })).headers.get('location')!;
  const html = await (await f.send(path, { headers: { cookie } })).text();
  const denied = await f.post('/oauth/consent', { request: new URL(path, origin).searchParams.get('request'), csrf: csrfOf(html), decision: 'deny' }, cookie);
  const destination = new URL(denied.headers.get('location')!);
  assert.equal(destination.origin, 'http://127.0.0.1:40222');
  assert.equal(destination.searchParams.get('state'), 'client-state');
  assert.equal(destination.searchParams.get('error'), 'access_denied');
  assert.equal(destination.searchParams.has('code'), false);
  assert.equal((await f.backend.accountsHost.lookup('alice'))!.agents.length, 0);
});

test('oauth AS: expired consent and stale POST re-login safely; sign-in returns to the saved request', async () => {
  const f = await fixture(), cookie = await f.login();
  const path = (await f.authorize()).headers.get('location')!;
  const html = await (await f.send(path, { headers: { cookie } })).text();
  f.advance(600_001);
  const stale = await f.post('/oauth/consent', { request: new URL(path, origin).searchParams.get('request'), csrf: csrfOf(html), decision: 'allow', name: 'Scout', capabilities: ['read'] }, cookie);
  assert.equal(stale.status, 303);
  assert.equal((await f.send(stale.headers.get('location')!)).status, 302);
  const fresh = await f.login();
  assert.equal((await f.send(path, { headers: { cookie: fresh } })).status, 403);
  const next = (await f.authorize()).headers.get('location')!;
  const needsLogin = await f.send(next);
  const login = await f.send(needsLogin.headers.get('location')!);
  const destination = new URL(login.headers.get('location')!);
  assert.equal(destination.searchParams.get('prompt'), 'login');
  const callbackResponse = await f.send(`/console/callback?code=synthetic&state=${destination.searchParams.get('state')}`, { headers: { cookie: login.headers.get('set-cookie')!.split(';')[0]! } });
  assert.equal(callbackResponse.headers.get('location'), next);
});

test('oauth AS: explicit revocation invalidates access and refresh; authorization and access tokens expire', async () => {
  const f = await fixture(), cookie = await f.login();
  const expiredCode = await f.consent(cookie);
  f.advance(60_001);
  assert.equal((await f.exchange(expiredCode)).status, 400);
  const tokens = await (await f.exchange(await f.consent(cookie))).json() as { access_token: string; refresh_token: string };
  const revoke = await f.send('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: f.client.client_id, token: tokens.access_token }).toString() });
  assert.equal(revoke.status, 200);
  assert.equal((await f.send('/mcp', listToolsRequest(tokens.access_token))).status, 401);
  const refresh = await f.send('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: f.client.client_id, refresh_token: tokens.refresh_token }).toString() });
  assert.equal(refresh.status, 400);
  const next = await (await f.exchange(await f.consent(cookie))).json() as { access_token: string };
  f.advance(3_600_001);
  assert.equal((await f.send('/mcp', listToolsRequest(next.access_token))).status, 401);
});

test('oauth AS: console can rename, change journeys and narrow without a passkey; widening still requires one', async () => {
  const f = await fixture(), cookie = await f.login();
  const journey = await f.backend.execute('alice', parseCommand('journey_create', { name: 'Chosen' }));
  const tokens = await (await f.exchange(await f.consent(cookie))).json() as { access_token: string };
  const agentId = (await f.backend.accountsHost.lookup('alice'))!.agents[0]!.id;
  const html = await (await f.send(`/console/agents/${agentId}`, { headers: { cookie } })).text(), csrf = csrfOf(html);
  assert.equal((await f.post('/console/agents/update', { csrf, agentId, name: 'Renamed', journeys: [journey.journeyId] }, cookie)).status, 303);
  assert.equal((await f.post('/console/agents/narrow', { csrf, agentId, capabilities: ['post'] }, cookie)).status, 303);
  const identity = (await callTool(f, tokens.access_token, 'whoami')).structuredContent!;
  assert.deepEqual(identity.agent, { id: agentId, name: 'Renamed', capabilities: ['read'], journeys: [journey.journeyId] });
  assert.equal((await f.post('/console/authorize/options', { csrf, change: { kind: 'card', agentId, capabilities: ['read', 'post'] } }, cookie)).status, 409);
  assert.equal((await f.post('/console/agents/update', { csrf, agentId, name: 'Renamed', journeys: [] }, cookie)).status, 303);
  assert.deepEqual(((await callTool(f, tokens.access_token, 'whoami')).structuredContent!.agent as { journeys: string[] }).journeys, []);
  assert.equal((await f.post('/console/agents/remove', { csrf, agentId }, cookie)).status, 303);
  assert.equal((await f.send('/mcp', listToolsRequest(tokens.access_token))).status, 401);
});

test('oauth AS: oversized and private CIMD documents fail closed', async () => {
  const f = await fixture();
  f.document({ client_id: 'https://pi.dev/oauth/client.json', client_name: 'x'.repeat(20_000), redirect_uris: [callback] });
  assert.equal((await f.authorize('https://pi.dev/oauth/client.json')).status, 400);
  assert.equal((await f.authorize('https://127.0.0.1/client.json')).status, 400);
  assert.equal((await f.authorize('https://host.internal/client.json')).status, 400);
});

test('oauth AS: Accounts eviction preserves old accounts, single-use codes and refresh reuse revocation', async () => {
  const storage = new MemoryStorage(), profiles = { async get() { return { name: 'Alice', email: 'alice@example.test' }; } };
  let now = Date.now();
  const host = () => new AccountsHost(storage, profiles, undefined, undefined, () => now);
  const original = await host().provision('alice'); // Existing account record without OAuth state.
  const registered = await host().oauth({ op: 'register', client: { client_name: 'Synthetic', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] } });
  assert.equal(registered.kind, 'client');
  if (registered.kind !== 'client' || !registered.client) throw new Error('Registration failed');
  const clientId = registered.client.client_id, id = 'saved-request';
  await host().oauth({ op: 'request', id, request: { clientId, clientName: 'Synthetic', redirectUri: callback, challenge, expiresAt: now + 600_000 } });
  const consent = await host().oauth({ op: 'consent', id, subject: 'alice', consent: { name: 'Scout', capabilities: ['read'], journeys: [] } });
  if (consent.kind !== 'agent') throw new Error('Consent failed');
  await assert.rejects(host().oauth({ op: 'consent', id, subject: 'alice', consent: { name: 'Racing', capabilities: ['post'], journeys: [] } }), /already in progress/);
  const code = await host().oauth({ op: 'code', id, subject: 'alice', agentId: consent.agentId });
  if (code.kind !== 'code') throw new Error('Code failed');
  const exchange = { op: 'exchange' as const, code: code.code, clientId, redirectUri: callback, verifier };
  const tokens = await host().oauth(exchange);
  if (tokens.kind !== 'tokens') throw new Error('Exchange failed');
  assert.deepEqual(await host().oauth(exchange), { kind: 'error', error: 'invalid_grant' });
  assert.equal((await host().lookup('alice'))!.personId, original.personId);
  const raw = String(await storage.get('accounts'));
  assert.equal(raw.includes(code.code), false);
  assert.equal(raw.includes(tokens.tokens.access_token), false);
  assert.equal(raw.includes(tokens.tokens.refresh_token), false);
  const object = new Accounts({ storage }, { WORKOS_API_KEY: 'sk_test_synthetic' });
  const verified = await object.fetch(new Request('https://accounts.internal/', { method: 'POST', body: JSON.stringify({ action: 'oauth', operation: { op: 'verify', token: tokens.tokens.access_token } }) }));
  const identity = await verified.json() as { value: { kind: string; identity: { agentId: string } } };
  assert.equal(identity.value.kind, 'access');
  assert.equal(identity.value.identity.agentId, consent.agentId);
  const refresh = { op: 'refresh' as const, clientId, token: tokens.tokens.refresh_token };
  const rotated = await host().oauth(refresh);
  if (rotated.kind !== 'tokens') throw new Error('Refresh failed');
  assert.deepEqual(await host().oauth(refresh), { kind: 'error', error: 'invalid_grant' });
  assert.deepEqual(await host().oauth({ op: 'verify', token: rotated.tokens.access_token }), { kind: 'error', error: 'invalid_token' });
  now += 30 * 86400_000 + 1;
  assert.deepEqual(await host().oauth({ op: 'refresh', clientId, token: rotated.tokens.refresh_token }), { kind: 'error', error: 'invalid_grant' });
});
