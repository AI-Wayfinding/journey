import * as z from 'zod';
import { base64url } from '../agents.ts';
import { Refused } from '../commands.ts';
import type { ConsoleConfig } from './contract.ts';
import { ConsoleSessions, SESSION_COOKIE, OAUTH_COOKIE, random, cookie } from './session.ts';

import { home, agentPage, passkeysPage, confirmation, journeyPage, routeId } from './pages.ts';
import { style, webauthn } from './assets.ts';
import { parseCommand } from '../commands.ts';
import { formBody } from './forms.ts';
import { changeSchema, assertionSchema } from '../agents.ts';
import { registration } from './contract.ts';
export function createConsole(config: ConsoleConfig) {
  const origin = config.resource.origin, clientId = `${origin}/console/client.json`, redirectUri = `${origin}/console/callback`;
  const now = config.now ?? Date.now, send = config.send ?? fetch.bind(globalThis);
  const tokenEndpoint = new URL('/oauth2/token', config.issuer);
  if (tokenEndpoint.protocol !== 'https:') throw new Refused('HTTPS AuthKit issuer required');
  const sessions = new ConsoleSessions(config.backend, config.secret, origin, now);
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
  const redirect = (location: string, cookies: string[] = []) => {
    const h = new Headers({ ...headers, Location: location });
    for (const c of cookies) h.append('Set-Cookie', c);
    return new Response(null, { status: 303, headers: h });
  };
  return { async fetch(request: Request): Promise<Response> {
    if (new TextEncoder().encode(config.secret).length < 32) return new Response('Console secret is not configured', { status: 503, headers });
    try {
      const url = new URL(request.url), path = url.pathname;
      if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
      if (request.method === 'GET' && path === '/console/style.css') return new Response(style, { headers: { ...headers, 'Content-Type': 'text/css; charset=utf-8' } });
      if (request.method === 'GET' && path === '/console/webauthn.js') return new Response(webauthn, { headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' } });
      if (request.method === 'GET' && path === '/console/client.json') return Response.json({ client_id: clientId, client_name: 'Wayfinding console',
        redirect_uris: [redirectUri], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }, { headers });
      if (request.method === 'GET' && path === '/console/login') {
        const state = random(), verifier = random();
        const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        const destination = new URL('/oauth2/authorize', config.issuer);
        destination.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile email',
          resource: config.resource.href, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
        const response = redirect(destination.href, [await sessions.create(OAUTH_COOKIE, { kind: 'oauth', state, verifier, expiresAt: now() + 600_000 })]);
        return new Response(null, { status: 302, headers: response.headers });
      }
      if (request.method === 'GET' && path === '/console/callback') {
        const pending = await sessions.read(request, OAUTH_COOKIE, 'take');
        if (pending?.kind !== 'oauth' || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== pending.state) throw new Refused('OAuth state refused');
        const code = z.string().min(1).max(4096).parse(url.searchParams.get('code'));
        if (url.searchParams.getAll('code').length !== 1 || url.searchParams.has('error')) throw new Refused('OAuth code refused');
        const response = await send(tokenEndpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId,
            redirect_uri: redirectUri, code_verifier: pending.verifier, resource: config.resource.href }).toString() });
        if (!response.ok) throw new Refused('Sign-in exchange refused');
        const result = z.object({ access_token: z.string().min(1).max(16384), token_type: z.string() }).parse(await response.json());
        if (result.token_type.toLowerCase() !== 'bearer') throw new Refused('Bearer token required');
        const auth = await config.verifier.verifyAccessToken(result.access_token), subject = auth.extra?.['sub'];
        if (auth.clientId !== clientId || typeof subject !== 'string') throw new Refused('Only the console client may sign in');
        await config.backend.execute(subject, { tool: 'account_read', input: {} }, clientId);
        return redirect('/console', [await sessions.create(SESSION_COOKIE, { kind: 'session', subject, clientId, csrf: random(), expiresAt: now() + 28_800_000 }), cookie(OAUTH_COOKIE, '', 0)]);
      }
      const session = await sessions.require(request);
      if (request.method === 'POST') {
        const body = await formBody(request, session.csrf, origin), identity = { subject: session.subject, clientId: session.clientId };
        if (path === '/console/logout') {
          await sessions.read(request, SESSION_COOKIE, 'delete');
          return redirect('/console/login', [cookie(SESSION_COOKIE, '', 0)]);
        }
        if (path === '/console/passkeys/options') return Response.json(await config.backend.passkey(identity, { op: 'begin' }), { headers });
        if (path === '/console/passkeys/register') {
          await config.backend.passkey(identity, { op: 'finish', credential: registration.parse(body.credential) });
          return redirect('/console/passkeys');
        }
        if (path === '/console/passkeys/delete') {
          await config.backend.passkey(identity, { op: 'delete', id: z.string().min(1).max(2048).parse(body.id) });
          return redirect('/console/passkeys');
        }
        if (path === '/console/authorize/options' || path === '/console/authorize/complete') {
          const change = changeSchema.parse(body.change);
          if (change.kind !== 'card' && change.clientId === clientId) throw new Refused('The console connection cannot be bound');
          if (path.endsWith('/options')) {
            const keys = await config.backend.passkey(identity, { op: 'list' });
            const credentials = z.array(z.object({ id: z.string() })).parse(keys.passkeys);
            if (!credentials.length) throw new Refused('Register a passkey first');
            const { challenge } = await config.backend.beginAuthorization(identity, change);
            return Response.json({ challenge, rpId: 'poc.wayfinding.support', userVerification: 'required', timeout: 60000,
              allowCredentials: credentials.map(c => ({ type: 'public-key', id: c.id })) }, { headers });
          }
          await config.backend.completeAuthorization(identity, change, assertionSchema.parse(body.assertion));
          return redirect(change.kind === 'card' ? `/console/agents/${encodeURIComponent(change.agentId)}` : '/console');
        }
        if (path === '/console/authorize/start') {
          const change = changeSchema.parse(body.kind === 'card' ? { kind: body.kind, agentId: body.agentId, capabilities: body.capabilities ?? [] }
            : { kind: body.kind, clientId: body.clientId, agentId: body.agentId });
          return new Response(confirmation(change, session.csrf), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
        }
        if (['/console/agents/create', '/console/agents/narrow', '/console/agents/remove'].includes(path)) {
          const tool = path.endsWith('/create') ? 'agent_create' : path.endsWith('/narrow') ? 'agent_narrow' : 'agent_remove';
          const input = tool === 'agent_create' ? { name: body.name } : tool === 'agent_narrow' ? { agentId: body.agentId, remove: body.capabilities ?? [] } : { agentId: body.agentId };
          await config.backend.execute(session.subject, parseCommand(tool, input), session.clientId);
          return redirect('/console');
        }
        return new Response('Not found', { status: 404, headers });
      }
      const identity = { subject: session.subject, clientId: session.clientId };
      const html = (text: string) => new Response(text, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      if (path === '/console' || path === '/console/') return html(await home(config.backend, identity, session.csrf));
      if (path === '/console/passkeys') return html(await passkeysPage(config.backend, identity, session.csrf));
      if (path.startsWith('/console/agents/')) return html(await agentPage(config.backend, identity, routeId(path, '/console/agents/'), session.csrf));
      if (path.startsWith('/console/journeys/')) return html(await journeyPage(config.backend, identity, routeId(path, '/console/journeys/'), session.csrf));
      return new Response('Not found', { status: 404, headers });
    } catch { return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Console request refused</title><main><h1>Console request refused</h1><p>Check the form or <a href="/console/login">sign in to your console</a>.</p></main></html>', { status: 403, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } }); }
  } };
}
