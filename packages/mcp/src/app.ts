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

/** Inputs for {@link createApp}. Everything the Worker reads from its environment is passed in here. */
export interface AppOptions {
  /** Verifies AuthKit access tokens; tests inject one backed by a local key pair. */
  verifier: OAuthTokenVerifier;
  /** The MCP endpoint, which is also the RFC 8707 resource identifier, e.g. `https://poc.wayfinding.support/mcp`. */
  resource: URL;
  /** The AuthKit issuer, which is the authorization server. */
  issuer: string;
  /** Hostnames accepted in the `Host` header of `/mcp` requests. */
  allowedHosts: string[];
  backend?: CoordinationBackend;
  /** AuthKit hosted authorization/sign-in URL. Never taken from request input. */
  signinUrl?: string;
}

/**
 * RFC 8414 metadata for AuthKit, mirrored at the resource origin for clients
 * that probe it directly. Paths match AuthKit's own discovery document.
 */
export function authkitMetadata(issuer: string): OAuthMetadata {
  const at = (path: string) => new URL(path, issuer).href;
  return {
    issuer,
    authorization_endpoint: at('/oauth2/authorize'),
    token_endpoint: at('/oauth2/token'),
    registration_endpoint: at('/oauth2/register'),
    introspection_endpoint: at('/oauth2/introspection'),
    jwks_uri: at('/oauth2/jwks'),
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['email', 'offline_access', 'openid', 'profile'],
    client_id_metadata_document_supported: true,
  };
}

/**
 * The Worker's request pipeline:
 * 1. the two OAuth discovery documents;
 * 2. `/mcp` only, behind Host validation and the bearer gate (no scopes are
 *    required: AuthKit tokens carry none for this resource);
 * 3. the SDK handler, serving 2026-07-28 per request and 2025-era clients
 *    statelessly from the same factory.
 */
export function createApp(options: AppOptions): { fetch(request: Request): Promise<Response> } {
  const metadata = {
    oauthMetadata: authkitMetadata(options.issuer),
    resourceServerUrl: options.resource,
    resourceName: 'AI Wayfinding',
  };
  const authenticate = requireBearerAuth({
    verifier: options.verifier,
    expectedResource: options.resource,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(options.resource),
  });
  // 10 MiB ciphertext expands to ~14 MiB base64, plus the JSON-RPC envelope.
  const handler = createMcpHandler((ctx) => buildServer(ctx, options.backend), { legacy: 'stateless', maxRequestBodySize: 15 * 1024 * 1024 });

  return {
    async fetch(request: Request): Promise<Response> {
      const document = oauthMetadataResponse(request, metadata);
      if (document !== undefined) return document;

      if (new URL(request.url).pathname === '/signin') {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
        const destination = new URL(options.signinUrl ?? metadata.oauthMetadata.authorization_endpoint!);
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
      return handler.fetch(request, { authInfo: auth });
    },
  };
}
