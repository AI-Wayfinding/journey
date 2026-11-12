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
import { authenticator } from './console-authenticator.ts';
import { runInNewContext } from 'node:vm';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WayfindingProxy } from '../../proxy/src/proxy.ts';
import {capabilities} from '../../rules/src/capabilities.ts';
import {cardCaps} from '../src/agents.ts';

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
  let browserCookie = '';
  const send = async (p: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (browserCookie) headers.set('cookie', [headers.get('cookie'), browserCookie].filter(Boolean).join('; '));
    const response = await bridge(app)(new URL(p, origin), { ...init, headers });
    const value = response.headers.getSetCookie().find(c => c.startsWith('__Host-wayfinding-consent='));
    if (value) browserCookie = value.split(';')[0]!;
    return response;
  };
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
    const page = await send(location, { headers: { cookie } }), html = await page.text();
    // The consent script fetches passkey options; the page policy must allow same-origin fetch.
    assert.ok(html.includes('data-options="/oauth/consent/options"'));
    assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
    const id = new URL(location, origin).searchParams.get('request')!;
    const allow = await post('/oauth/consent', { csrf: csrfOf(html), request: id, decision: 'allow', name: 'Scout', capabilities, journeys }, cookie);
    assert.equal(allow.status, 303);
    const redirect = new URL(allow.headers.get('location')!);
    assert.equal(redirect.searchParams.get('state'), 'client-state');
    return redirect.searchParams.get('code')!;
  }
  return { backend, send, login, post, authorize, exchange, consent, client, upstream, advance: (ms: number) => { now += ms; }, document: (v: unknown) => { document = v; } };
}

test('oauth AS: anonymous throttling uses the trusted client IP, not a shared global key', async () => {
  const f = await fixture(), keys = new Set<string>();
  const app = createApp({resource:RESOURCE,issuer:ISSUER,allowedHosts:[RESOURCE.hostname],backend:f.backend,
    verifier:createVerifier({issuer:ISSUER,resource:RESOURCE,getKey:createLocalJWKSet(signer.jwks)}),
    authRateLimit:{async limit({key}: {key:string}) { const success=!keys.has(key);keys.add(key);return {success}; }} });
  const register = (ip:string) => app.fetch(new Request(new URL('/oauth/register',origin),{method:'POST',headers:{host:RESOURCE.host,'cf-connecting-ip':ip,'content-type':'application/json'},body:JSON.stringify({redirect_uris:[callback]})}));
  assert.equal((await register('192.0.2.1')).status,201);
  assert.equal((await register('192.0.2.1')).status,429);
  assert.equal((await register('192.0.2.2')).status,201);
});

test('oauth AS: unused DCR clients expire and anonymous registrations do not share a hard cap', async () => {
  let now = 1_800_000_000_000;
  const host = new AccountsHost(new MemoryStorage(), { get: async () => ({name:'test',email:'test@example.test'}) }, undefined, undefined, () => now);
  let first = '';
  for (let n = 0; n < 1030; n++) {
    const result = await host.oauth({ op: 'register', client: { client_name: 'Synthetic', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] } });
    assert.equal(result.kind, 'client');
    if (result.kind === 'client' && !first) first = result.client!.client_id;
  }
  now += 86_400_001;
  assert.deepEqual(await host.oauth({ op:'client', clientId:first }), {kind:'client',client:undefined});
});

test('oauth AS: pre-auth login does not write Accounts or lock out other browsers', async () => {
  const f = await fixture(), before = f.backend.accountStorage.writes;
  for (let n = 0; n < 140; n++) assert.equal((await f.send('/console/login')).status, 302);
  assert.equal(f.backend.accountStorage.writes, before);
  await f.login();
});

test('oauth AS: consent identifies redirect and client and requires the initiating browser', async () => {
  const f = await fixture(), cookie = await f.login(), start = await f.authorize();
  const path = start.headers.get('location')!;
  const html = await (await f.send(path, { headers: { cookie } })).text();
  assert.ok(html.includes('127.0.0.1:32123'));
  assert.ok(html.includes(f.client.client_id));
  const other = await fixture(), otherCookie = await other.login();
  // Reusing a real session from this server without the browser's authorization cookie must fail.
  const app = createApp({ resource: RESOURCE, issuer: ISSUER, allowedHosts: [RESOURCE.hostname], backend: f.backend,
    verifier: createVerifier({ issuer: ISSUER, resource: RESOURCE, getKey: createLocalJWKSet(signer.jwks) }),
    console: { backend: f.backend, secret: 'synthetic-secret-with-at-least-32-bytes' } });
  assert.equal((await app.fetch(new Request(new URL(path, origin), { headers: { cookie, host: RESOURCE.host } }))).status, 403);
  void otherCookie;
});

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


test('oauth AS: device.keys is unchecked and fresh login alone cannot grant it or change state', async () => {
  const f = await fixture(), cookie = await f.login();
  const path = (await f.authorize()).headers.get('location')!;
  const html = await (await f.send(path, { headers: { cookie } })).text();
  assert.match(html, /value="device.keys"(?! checked)/);
  assert.match(html, /passkey/i);
  const before = f.backend.snapshot();
  const denied = await f.post('/oauth/consent', { request: new URL(path, origin).searchParams.get('request'), csrf: csrfOf(html), decision: 'allow', name: 'Device', capabilities: ['device.keys'], journeys: [] }, cookie);
  assert.equal(denied.status, 403);
  assert.equal(f.backend.snapshot(), before);
});


async function deviceConsentFixture() {
  const f = await fixture(), cookie = await f.login(), key = await authenticator();
  const identity = { subject: 'alice', clientId: consoleClient };
  const options = await f.backend.passkey(identity, { op: 'begin' });
  await f.backend.passkey(identity, { op: 'finish', credential: key.register(String(options.challenge)) });
  async function pending() {
    const path = (await f.authorize()).headers.get('location')!;
    const html = await (await f.send(path, { headers: { cookie } })).text();
    assert.match(html, /value="device.keys"(?! checked)/);
    return { request: new URL(path, origin).searchParams.get('request')!, csrf: csrfOf(html), decision: 'allow', name: 'Encryption proxy', capabilities: ['device.keys'], journeys: [] as string[] };
  }
  return { ...f, cookie, key, pending };
}

test('oauth AS: selecting all assignable capabilities succeeds with passkey-confirmed consent',async()=>{
 const f=await deviceConsentFixture(),pending=await f.pending();
 const html=await (await f.send(`/oauth/consent?request=${pending.request}`,{headers:{cookie:f.cookie}})).text();
 const selected=[...html.matchAll(/name="capabilities" value="([^"]+)"/g)].map(m=>m[1]!);
 const expected=capabilities.filter(c=>c.name!=='grant.issue').map(c=>c.name);
 assert.deepEqual(new Set(selected),new Set(expected));
 assert.equal(selected.length,expected.length);
 const body={...pending,capabilities:selected};
 const optionsResponse=await f.post('/oauth/consent/options',body,f.cookie);
 assert.equal(optionsResponse.status,200);
 const options=await optionsResponse.json() as {challenge:string};
 const response=await f.post('/oauth/consent',{...body,assertion:await f.key.assert(options.challenge)},f.cookie);
 assert.equal(response.status,303);
 const code=new URL(response.headers.get('location')!).searchParams.get('code')!;
 assert.equal((await f.exchange(code)).status,200);
 const account=(await f.backend.accountsHost.lookup('alice'))!;
 assert.equal(account.agents.length,1);
 assert.deepEqual(new Set(cardCaps(account.agents[0]!.card)),new Set(expected));
});

test('oauth AS: device.keys passkey is bound to the pending authorization, exact card, person and expiry; cannot replay', async () => {
  const f = await deviceConsentFixture(), body = await f.pending();
  const optionsResponse = await f.post('/oauth/consent/options', body, f.cookie);
  assert.equal(optionsResponse.status, 200);
  const options = await optionsResponse.json() as { challenge: string; userVerification: string };
  assert.equal(options.userVerification, 'required');
  const assertion = await f.key.assert(options.challenge);
  const other = await f.pending();
  // Another person's consent cannot consume Alice's assertion.
  await f.backend.execute('bob', parseCommand('account_read', {}));
  const bob = { subject: 'bob', clientId: consoleClient };
  const bobKey = await authenticator();
  const registration = await f.backend.passkey(bob, { op: 'begin' });
  await f.backend.passkey(bob, { op: 'finish', credential: bobKey.register(String(registration.challenge)) });
  const consent = { name: body.name, capabilities: ['device.keys' as const], journeys: [] };
  await f.backend.oauth({ op: 'consent-options', subject: 'bob', id: body.request, consent });
  const personBefore = f.backend.snapshot();
  await assert.rejects(f.backend.consentAgent('bob', body.request, consent, assertion));
  assert.equal(f.backend.snapshot(), personBefore);
  const before = f.backend.snapshot();
  for (const changed of [ { ...body, request: other.request }, { ...body, capabilities: ['device.keys', 'journey.create'] }, { ...body, name: 'Changed' }, { ...body, journeys: ['foreign'] } ]) {
    assert.equal((await f.post('/oauth/consent', { ...changed, assertion }, f.cookie)).status, 403);
    assert.equal(f.backend.snapshot(), before);
  }
  const foreignOrigin = await f.key.assert(options.challenge, 1, 'https://evil.test');
  assert.equal((await f.post('/oauth/consent', { ...body, assertion: foreignOrigin }, f.cookie)).status, 403);
  assert.equal(f.backend.snapshot(), before);
  assert.equal((await f.post('/oauth/consent', { ...body, assertion }, f.cookie)).status, 303);
  assert.equal((await f.post('/oauth/consent', { ...body, assertion }, f.cookie)).status, 403);
  // A newly displayed reauthorization must default off even for an existing device card.
  const next = await f.pending();
  assert.equal((await f.post('/oauth/consent', next, f.cookie)).status, 403);
  const nextOptions = await (await f.post('/oauth/consent/options', next, f.cookie)).json() as { challenge: string };
  const expired = await f.key.assert(nextOptions.challenge, 2);
  f.advance(300_001);
  const beforeExpiry = f.backend.snapshot();
  assert.equal((await f.post('/oauth/consent', { ...next, assertion: expired }, f.cookie)).status, 403);
  assert.equal(f.backend.snapshot(), beforeExpiry);
});

test('oauth AS: device.keys agent token bootstraps real proxy and round-trips sealed content; removing capability refuses every private path unchanged', async t => {
  const f = await deviceConsentFixture(), body = await f.pending();
  const options = await (await f.post('/oauth/consent/options', body, f.cookie)).json() as { challenge: string };
  const allowed = await f.post('/oauth/consent', { ...body, assertion: await f.key.assert(options.challenge) }, f.cookie);
  assert.equal(allowed.status, 303);
  const tokens = await (await f.exchange(new URL(allowed.headers.get('location')!).searchParams.get('code')!)).json() as { access_token: string };
  const remote = new Client({ name: 'real-encryption-proxy', version: '1' });
  await remote.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: (url, init) => f.send(new URL(String(url)).pathname, init), requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
  t.after(() => remote.close());
  const records = new Map<string, string>();
  const store = { async read(name: string) { return records.get(name); }, async write(name: string, value: string) { records.set(name, value); } };
  const proxy = await WayfindingProxy.open(remote, store);
  await proxy.createGroup(proxy.personalGroupId);
  const artifact = await proxy.createArtifact({ groupId: proxy.personalGroupId, name: 'Synthetic private document', type: 'text/plain', content: 'SEALED-DEVICE-KEYS-ROUNDTRIP' });
  assert.equal((await proxy.readArtifact(proxy.personalGroupId, artifact.artifactId)).content, 'SEALED-DEVICE-KEYS-ROUNDTRIP');
  assert.equal(f.backend.snapshot().includes('SEALED-DEVICE-KEYS-ROUNDTRIP'), false);
  const second = await WayfindingProxy.open(remote, { async read() { return undefined; }, async write() {} });
  const prepared = await second.prepareGroup(proxy.personalGroupId);
  await proxy.addMember(proxy.personalGroupId, second.personId, prepared.deviceId);
  assert.equal((await second.readArtifact(proxy.personalGroupId, artifact.artifactId)).content, 'SEALED-DEVICE-KEYS-ROUNDTRIP');
  const account = (await f.backend.accountsHost.lookup('alice'))!;
  await f.backend.execute('alice', parseCommand('agent_narrow', { agentId: account.agents[0]!.id, remove: ['device.keys'] }), consoleClient);
  const calls: [string, Record<string, unknown>][] = [
    ['account_read', {}], ['personal_group_read', {}], ['personal_group_add', { name: 'No', kind: 'device' }], ['personal_group_remove', { memberId: prepared.deviceId }],
    ['mls_key_package_publish', { deviceId: prepared.deviceId, data: 'AQ==' }], ['mls_key_package_fetch', { personId: account.personId, deviceId: prepared.deviceId }],
    ['mls_message_fetch', { groupId: proxy.personalGroupId }], ['mls_message_post', { groupId: proxy.personalGroupId, epoch: 0, kind: 'application', data: 'AQ==' }],
    ['artifact_blob_put', { groupId: proxy.personalGroupId, artifactId: artifact.artifactId, version: 2, data: 'AQ==' }],
    ['artifact_blob_get', { groupId: proxy.personalGroupId, artifactId: artifact.artifactId, version: 1 }], ['artifact_blob_delete', { groupId: proxy.personalGroupId, artifactId: artifact.artifactId }],
  ];
  for (const [tool, input] of calls) {
    const before = f.backend.snapshot();
    await assert.rejects(f.backend.execute('alice', parseCommand(tool, input), f.client.client_id), /device.keys/);
    assert.equal(f.backend.snapshot(), before, tool);
  }
  await assert.rejects(WayfindingProxy.open(remote, store), /device.keys/);
});


test('oauth AS: served consent browser script signs and submits the same frozen fields through the native form redirect', async () => {
  const f = await deviceConsentFixture(), body = await f.pending();
  const script = await (await f.send('/console/webauthn.js')).text();
  let handler: ((event: { preventDefault(): void; submitter: { value: string } }) => Promise<void>) | undefined;
  const elements = Object.entries(body).filter(([name]) => name !== 'decision').flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(value => ({ name, value, disabled: false })));
  const status = { textContent: '' }, button = { disabled: false };
  let posted: Promise<Response> | undefined;
  class Form {
    elements = elements;
    dataset = { ceremony: 'consent', options: '/oauth/consent/options' };
    action = '/oauth/consent';
    querySelector() { return button; }
    addEventListener(_name: string, callback: typeof handler) { handler = callback; }
    append(element: typeof elements[number]) { elements.push(element); }
    submit() {
      posted = f.send(this.action, { method: 'POST', headers: { cookie: f.cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(elements.filter(e => !e.disabled).map(e => [e.name, String(e.value)] as [string, string])).toString() });
    }
  }
  const form = new Form();
  const decode = (value: string) => Buffer.from(value, 'base64url');
  runInNewContext(script, {
    document: { querySelectorAll: () => [form], getElementById: () => status, createElement: () => ({ name: '', value: '', disabled: false }) },
    FormData: class {
      entries = elements.filter(e => !e.disabled).map(e => [e.name, e.value] as const);
      get(name: string) { return this.entries.find(([key]) => key === name)?.[1]; }
      getAll(name: string) { return this.entries.filter(([key]) => key === name).map(([, value]) => value); }
      has(name: string) { return this.entries.some(([key]) => key === name); }
      [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
    },
    HTMLFormElement: Form, window: { PublicKeyCredential: {} },
    navigator: { credentials: { async get(options: { publicKey: { challenge: Uint8Array } }) {
      // Edits during the OS prompt must not change what the server receives after signing.
      elements.find(e => e.name === 'name')!.value = 'Changed while prompting';
      const result = await f.key.assert(Buffer.from(options.publicKey.challenge).toString('base64url'));
      return { id: result.id, rawId: decode(result.rawId), response: { clientDataJSON: decode(result.response.clientDataJSON), authenticatorData: decode(result.response.authenticatorData), signature: decode(result.response.signature) } };
    } } },
    Uint8Array, atob, btoa, URL,
    fetch: (path: string, init: RequestInit) => f.send(path, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie: f.cookie, origin } }),
  }, { timeout: 3000 });
  assert.ok(handler);
  await handler({ preventDefault() {}, submitter: { value: 'allow' } });
  assert.equal(status.textContent, '');
  assert.ok(posted);
  assert.equal((await posted).status, 303);
  assert.equal((await f.backend.accountsHost.lookup('alice'))!.agents[0]!.name, 'Encryption proxy');
});
