import * as z from 'zod';
import { OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { CoordinationBackend } from './commands.ts';
import { Refused, parseCommand } from './commands.ts';
import type { ConsoleOptions } from './console/contract.ts';
import { ConsoleSessions, SESSION_COOKIE } from './console/session.ts';
import { formBody } from './console/forms.ts';
import { page, escape, form, capabilityFields } from './console/pages.ts';
import { agentConsent, authorizationRequest, clientMetadata, oauthId, type OAuthClient } from './oauth-contract.ts';
import { randomToken } from './oauth-store.ts';

const headers = { 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const redirect = (url: string) => new Response(null, { status: 303, headers: { ...headers, Location: url } });
const oauthError = (error: string, status = 400) => json({ error }, status);
const rows = (v: unknown) => z.array(z.record(z.string(), z.unknown())).parse(v);
const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escape(value)}">`;

/** Bounded byte streaming, also used for CIMD. Never follow metadata redirects or buffer an unbounded response. */
async function boundedBody(response: Response | Request, max = 16_384): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Refused('Body required');
  let size = 0, text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > max) throw new Refused('Body too large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function params(text: string): URLSearchParams {
  const p = new URLSearchParams(text);
  for (const key of p.keys()) if (p.getAll(key).length !== 1) throw new Refused('Duplicate OAuth parameter');
  return p;
}
function redirectURL(value: string): URL {
  const u = new URL(value);
  const loopback = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if ((!loopback && u.protocol !== 'https:') || u.username || u.password || u.hash) throw new Refused('Redirect URI refused');
  return u;
}
function matchesRedirect(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  const a = redirectURL(requested), b = redirectURL(registered);
  if (a.protocol !== 'http:' || b.protocol !== 'http:' || a.hostname !== b.hostname) return false;
  // RFC 8252: only the ephemeral port differs. Token exchange still matches the original request exactly.
  const withoutPort = (value: string) => value.replace(/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?=\/|\?|$)/, 'http://$1');
  return withoutPort(requested) === withoutPort(registered);
}
function publicMetadataURL(value: string): URL {
  const u = new URL(value), h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || (u.port && u.port !== '443') || !h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':') || ['localhost', 'local', 'internal', 'test'].some(s => h === s || h.endsWith('.' + s))) throw new Refused('Public HTTPS client metadata required');
  return u;
}
export function createOpaqueVerifier(backend: CoordinationBackend | undefined, resource: URL): OAuthTokenVerifier {
  return { async verifyAccessToken(token) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !backend?.oauth) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Wayfinding access token required');
    const result = await backend.oauth({ op: 'verify', token });
    if (result.kind !== 'access') throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is expired or revoked');
    return { token, clientId: result.identity.clientId, scopes: [], expiresAt: Math.floor(result.expiresAt / 1000), resource,
      extra: { sub: result.identity.subject, personId: result.identity.personId, agentId: result.identity.agentId } };
  } };
}
export function createOAuth(config: { backend?: CoordinationBackend; console?: ConsoleOptions; resource: URL }) {
  const origin = config.resource.origin, now = config.console?.now ?? Date.now, send = config.console?.send ?? fetch.bind(globalThis);
  const backend = config.backend;
  const sessions = config.console ? new ConsoleSessions(config.console.backend, config.console.secret, origin, now) : undefined;
  async function client(id: string): Promise<OAuthClient> {
    oauthId.parse(id);
    if (!backend?.oauth) throw new Refused('OAuth storage unavailable');
    if (id.startsWith('https://')) {
      const url = publicMetadataURL(id), controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await send(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Refused('Client metadata fetch refused');
        const raw: unknown = JSON.parse(await boundedBody(response));
        const doc = clientMetadata.extend({ client_id: z.literal(id) }).parse(raw);
        doc.redirect_uris.forEach(redirectURL);
        return doc;
      } finally { clearTimeout(timeout); }
    }
    const r = await backend.oauth({ op: 'client', clientId: id });
    if (r.kind !== 'client' || !r.client) throw new Refused('Unknown OAuth client');
    return r.client;
  }
  return { async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    if (!backend?.oauth) return oauthError('temporarily_unavailable', 503);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, Allow: 'GET, POST, OPTIONS' } });
    const consentRoute = path === '/oauth/consent';
    try {
      if (path === '/oauth/authorize' && request.method === 'GET') {
        const p = params(url.search.slice(1)), id = oauthId.parse(p.get('client_id'));
        const metadata = await client(id), uri = oauthId.parse(p.get('redirect_uri'));
        redirectURL(uri);
        if (!metadata.redirect_uris.some(r => matchesRedirect(uri, r))) throw new Refused('Redirect URI mismatch');
        if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256') throw new Refused('Code with S256 required');
        if (p.has('resource') && p.get('resource') !== config.resource.href) throw new Refused('Resource mismatch');
        const pending = authorizationRequest.parse({ clientId: id, clientName: metadata.client_name, redirectUri: uri,
          challenge: p.get('code_challenge'), ...(p.has('state') ? { state: p.get('state') } : {}), expiresAt: now() + 600_000 });
        const transaction = randomToken(); await backend.oauth({ op: 'request', id: transaction, request: pending });
        return redirect(`/oauth/consent?request=${transaction}`);
      }
      if (consentRoute && ['GET', 'POST'].includes(request.method)) {
        if (!sessions || !config.console || new TextEncoder().encode(config.console.secret).length < 32) return oauthError('temporarily_unavailable', 503);
        const session = await sessions.read(request, SESSION_COOKIE);
        // Older sessions have no sign-in timestamp and are deliberately not fresh.
        if (session?.kind !== 'session' || session.signedInAt === undefined || session.signedInAt > now() || now() - session.signedInAt > 600_000) {
          const returnTo = request.method === 'GET' ? `&return_to=${encodeURIComponent(url.pathname + url.search)}` : '';
          return redirect(`/console/login?prompt=login${returnTo}`);
        }
        await sessions.require(request);
        const body = request.method === 'POST' ? await formBody(request, session.csrf, origin) : undefined;
        const id = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(body ? body.request : url.searchParams.get('request'));
        const pending = await backend.oauth({ op: 'request', id });
        if (pending.kind !== 'request' || !pending.request) throw new Refused('Authorization expired');
        const r = pending.request, destination = new URL(r.redirectUri);
        if (r.state !== undefined) destination.searchParams.set('state', r.state);
        // Prevent the code appearing in referrers at the native client's redirect.
        const finish = () => { const response = redirect(destination.href); response.headers.set('Referrer-Policy', 'no-referrer'); return response; };
        if (body) {
          if (body.decision === 'deny') { await backend.oauth({ op: 'deny', id }); destination.searchParams.set('error', 'access_denied'); return finish(); }
          if (body.decision !== 'allow') throw new Refused('Consent decision required');
          // Never copy posted subject, clientId, agentId or authority flags into storage.
          if (Object.keys(body).some(k => !['csrf', 'request', 'decision', 'name', 'capabilities', 'journeys'].includes(k))) throw new Refused('Unknown consent field');
          const consent = agentConsent.parse({ name: body.name, capabilities: body.capabilities ?? [], journeys: body.journeys ?? [] });
          const agentId = await config.console.backend.consentAgent(session.subject, id, consent);
          const code = await backend.oauth({ op: 'code', id, subject: session.subject, agentId });
          if (code.kind !== 'code') throw new Refused('Authorization code refused');
          destination.searchParams.set('code', code.code); return finish();
        }
        const [agents, clients, journeys] = await Promise.all(['agent_list', 'client_list', 'journey_list'].map(tool => backend.execute(session.subject, parseCommand(tool, {}), session.clientId)));
        const bound = rows(clients!.clients).find(c => c.clientId === r.clientId && c.bound);
        const agent = bound ? rows(agents!.agents).find(a => a.agentId === bound.agentId && a.live) : undefined;
        const caps = agent ? z.array(z.string()).parse(agent.capabilities) : ['read', 'post'];
        const selected = agent ? z.array(z.string()).parse(agent.journeys ?? []) : [];
        const fields = hidden('request', id) + `<p>Connect <strong>${escape(r.clientName)}</strong> as your agent. Its access is always limited by your live authority.</p><label>Agent name <input name="name" value="${escape(agent?.name ?? r.clientName)}" maxlength="60" required></label>`
          + capabilityFields(caps) + `<fieldset><legend>Journeys</legend>${rows(journeys!.journeys).filter(j => !j.pending).map(j => `<label><input type="checkbox" name="journeys" value="${escape(j.journeyId)}"${selected.includes(String(j.journeyId)) ? ' checked' : ''}> ${escape(j.name)}</label>`).join('')}</fieldset>`;
        const html = page('Allow agent access', `<form method="post" action="/oauth/consent">${hidden('csrf', session.csrf)}${fields}<button name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></form>`, session.csrf);
        return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self' ${destination.origin}; frame-ancestors 'none'; base-uri 'none'` } });
      }
      if (path === '/oauth/register' && request.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Refused('JSON required');
        const supplied = clientMetadata.parse(JSON.parse(await boundedBody(request)));
        supplied.redirect_uris.forEach(redirectURL);
        const result = await backend.oauth({ op: 'register', client: supplied });
        return result.kind === 'client' ? json(result.client, 201) : oauthError('invalid_client_metadata');
      }
      if ((path === '/oauth/token' || path === '/oauth/revoke') && request.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded') || request.headers.has('authorization')) throw new Refused('Public form client required');
        const p = params(await boundedBody(request)), clientId = oauthId.parse(p.get('client_id'));
        if (p.has('resource') && p.get('resource') !== config.resource.href) throw new Refused('Resource mismatch');
        if (p.has('client_secret')) throw new Refused('Public client required');
        if (path.endsWith('/revoke')) { await backend.oauth({ op: 'revoke', clientId, token: oauthId.parse(p.get('token')) }); return json({}); }
        const grant = p.get('grant_type');
        const result = grant === 'authorization_code' ? await backend.oauth({ op: 'exchange', clientId, code: oauthId.parse(p.get('code')), redirectUri: oauthId.parse(p.get('redirect_uri')), verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).parse(p.get('code_verifier')) })
          : grant === 'refresh_token' ? await backend.oauth({ op: 'refresh', clientId, token: oauthId.parse(p.get('refresh_token')) }) : undefined;
        if (!result) return oauthError('unsupported_grant_type');
        return result.kind === 'tokens' ? json(result.tokens) : oauthError(result.kind === 'error' ? result.error : 'invalid_grant');
      }
      return oauthError('invalid_request', 405);
    } catch { return oauthError(consentRoute ? 'access_denied' : 'invalid_request', consentRoute ? 403 : 400); }
  } };
}
