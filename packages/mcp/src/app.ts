import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  oauthMetadataResponse,
  requireBearerAuth,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { buildServer } from './server.ts';
import type { CoordinationBackend } from './commands.ts';
import { inboxJourney, InboxBus, subscriptionBody } from './inbox.ts';

import { createConsole } from './console/index.ts';
import type { ConsoleOptions } from './console/contract.ts';
import { createOAuth, createOpaqueVerifier } from './oauth.ts';
/** Inputs for {@link createApp}. Everything the Worker reads from its environment is passed in here. */
export interface AppOptions {
  authRateLimit?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  registerRateLimit?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  /** Verifies upstream AuthKit tokens for console login only. */
  verifier: OAuthTokenVerifier;
  /** Test seam for transport-only suites. Production always uses the opaque verifier. */
  mcpVerifier?: OAuthTokenVerifier;
  /** The MCP endpoint, which is also the RFC 8707 resource identifier, e.g. `https://poc.wayfinding.support/mcp`. */
  resource: URL;
  /** The upstream AuthKit issuer, never the MCP authorization server. */
  issuer: string;
  /** Hostnames accepted in the `Host` header of `/mcp` requests. */
  allowedHosts: string[];
  backend?: CoordinationBackend;
  /** AuthKit hosted authorization/sign-in URL. Never taken from request input. */
  signinUrl?: string;
  console?: ConsoleOptions;
}

export function workerMetadata(issuer: string): OAuthMetadata {
  const at = (path: string) => new URL(path, issuer).href;
  return { issuer, authorization_endpoint: at('/oauth/authorize'), token_endpoint: at('/oauth/token'),
    registration_endpoint: at('/oauth/register'), revocation_endpoint: at('/oauth/revoke'), response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true };
}

/** Worker discovery, same-origin console/OAuth routes, then opaque bearer authentication before the MCP handler. */
export function createApp(options: AppOptions): { fetch(request: Request): Promise<Response> } {
  const console = options.console ? createConsole({ ...options.console, verifier: options.verifier, resource: options.resource, issuer: options.issuer }) : undefined;
  const oauth = createOAuth({ backend: options.backend, console: options.console, resource: options.resource });
  const metadata = {
    oauthMetadata: workerMetadata(options.resource.origin),
    resourceServerUrl: options.resource,
    resourceName: 'AI Wayfinding',
  };
  const authenticate = requireBearerAuth({
    verifier: options.mcpVerifier ?? createOpaqueVerifier(options.backend, options.resource),
    expectedResource: options.resource,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(options.resource),
  });
  // 10 MiB ciphertext expands to ~14 MiB base64, plus the JSON-RPC envelope.
  const handler = createMcpHandler((ctx) => buildServer(ctx, options.backend), { legacy: 'stateless', maxRequestBodySize: 15 * 1024 * 1024 });

  const routes = {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      const limiter = path === '/oauth/register' ? (options.registerRateLimit ?? options.authRateLimit) : options.authRateLimit;
      if (limiter && ['/console/login', '/oauth/register', '/oauth/authorize', '/oauth/token'].includes(path)) {
        const ip = request.headers.get('cf-connecting-ip');
        if (!ip) return new Response('Client IP unavailable', { status: 503 });
        try { if (!(await limiter.limit({ key: `${path}:${ip}` })).success) return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '60' } }); }
        catch { return new Response('Rate limiter unavailable', { status: 503 }); }
      }
      // The bare origin is the public landing page, served by the console so it can see the session.
      if (path === '/' || path === '/console' || path.startsWith('/console/')) {
        if (path === '/' && request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
        const rejected = hostHeaderValidationResponse(request, options.allowedHosts);
        if (rejected) return rejected;
        if (new URL(request.url).origin !== options.resource.origin) return new Response('Console origin refused', { status: 403 });
        return console ? console.fetch(request) : new Response('Console is not configured', { status: 503 });
      }
      if (path.startsWith('/oauth/')) {
        const rejected = hostHeaderValidationResponse(request, options.allowedHosts);
        if (rejected) return rejected;
        if (new URL(request.url).origin !== options.resource.origin) return new Response('OAuth origin refused', { status: 403 });
        return oauth.fetch(request);
      }
      const document = oauthMetadataResponse(request, metadata);
      if (document !== undefined) return document;

      if (new URL(request.url).pathname === '/signin') {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
        const destination = new URL(options.signinUrl ?? new URL('/oauth2/authorize', options.issuer).href);
        if (destination.protocol !== 'https:') return new Response('Sign-in is not configured', { status: 503 });
        return new Response(null, { status: 302, headers: { Location: destination.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
      }
      if (new URL(request.url).pathname !== options.resource.pathname) {
        return new Response('Not found', { status: 404 });
      }

      const rejected = hostHeaderValidationResponse(request, options.allowedHosts);
      if (rejected !== undefined) return rejected;

      const auth = await authenticate(request);
      if (auth instanceof Response) return auth;
      if (request.headers.get('mcp-method') === 'subscriptions/listen' && options.backend?.watchInbox) {
        const streams: ReadableStream<Uint8Array>[] = [];
        let id: string | number | null = null;
        try {
          const raw = await subscriptionBody(request);
          const body = JSON.parse(raw) as { id?: unknown; method?: unknown; params?: { notifications?: { resourceSubscriptions?: unknown } } };
          if (typeof body.id === 'string' || typeof body.id === 'number') id = body.id;
          if (body.method !== 'subscriptions/listen') throw new Error('Invalid subscription method');
          const uris = body.params?.notifications?.resourceSubscriptions ?? [];
          if (!Array.isArray(uris) || uris.length > 32 || uris.some((uri) => typeof uri !== 'string')) throw new Error('Invalid inbox subscriptions');
          const subject = auth.extra?.['sub'];
          if (typeof subject !== 'string') throw new Error('Missing subject');
          for (const uri of new Set<string>(uris)) streams.push(await options.backend.watchInbox(subject, inboxJourney(uri), auth.clientId));
          let dispose = () => {};
          let closed = false;
          const bus = new InboxBus(streams, () => dispose());
          const listen = createMcpHandler((ctx) => buildServer(ctx, options.backend), { legacy: 'reject', bus });
          const expire = setTimeout(() => dispose(), Math.min(2_147_483_647, Math.max(0, (auth.expiresAt ?? 0) * 1000 - Date.now())));
          dispose = () => {
            if (closed) return;
            closed = true; clearTimeout(expire); request.signal.removeEventListener('abort', dispose);
            void bus.close(); void listen.close();
          };
          request.signal.addEventListener('abort', dispose, { once: true });
          if (request.signal.aborted) dispose();
          const response = await listen.fetch(request, { authInfo: auth });
          if (!response.headers.get('content-type')?.includes('text/event-stream')) dispose();
          return response;
        } catch {
          await Promise.all(streams.map((stream) => stream.cancel().catch(() => undefined)));
          return Response.json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Inbox subscription refused' } });
        }
      }
      return handler.fetch(request, { authInfo: auth });
    },
  };
  return { async fetch(request: Request): Promise<Response> {
    const response = await routes.fetch(request);
    const headers = new Headers(response.headers);
    if (new URL(request.url).protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } };
}
