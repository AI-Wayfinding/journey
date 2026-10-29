import { exportJWK, generateKeyPair, createLocalJWKSet, SignJWT, type JWTPayload } from 'jose';
import { createVerifier } from '../src/auth.ts';
import { createApp } from '../src/app.ts';
import type { CoordinationBackend } from '../src/commands.ts';

export const ISSUER = 'https://welcoming-folk-53-staging.authkit.app';
export const RESOURCE = new URL('https://poc.wayfinding.support/mcp');
export const METADATA_URL = 'https://poc.wayfinding.support/.well-known/oauth-protected-resource/mcp';

/** A signing key pair standing in for AuthKit's, and its public JWK set. */
export async function keyPair(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, kid, jwks: { keys: [jwk] } };
}

export type Signer = Awaited<ReturnType<typeof keyPair>>;

/** Sign an access token shaped like AuthKit's; `claims` override the defaults. */
export async function token(signer: Signer, claims: JWTPayload = {}, kid = signer.kid): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    iss: ISSUER,
    sub: 'user_01TESTSUBJECT',
    aud: RESOURCE.href,
    iat: now,
    exp: now + 300,
    sid: 'session_01TEST',
    jti: crypto.randomUUID(),
    ...claims,
  };
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' }).sign(signer.privateKey);
}

/** The Worker app trusting only `signer`'s key, as the deployed Worker trusts only AuthKit's JWKS. */
export function app(signer: Signer, backend?: CoordinationBackend) {
  return createApp({
    verifier: createVerifier({ issuer: ISSUER, resource: RESOURCE, getKey: createLocalJWKSet(signer.jwks) }),
    resource: RESOURCE,
    issuer: ISSUER,
    allowedHosts: ['poc.wayfinding.support', 'localhost'],
    backend,
  });
}

/**
 * A fetch that serves requests in-process from `target`. Workers always see a
 * `Host` header; Node's fetch types leave it to the network layer, so set it
 * here from the URL, as the runtime would.
 */
export function bridge(target: { fetch(request: Request): Promise<Response> }) {
  return (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!headers.has('host')) headers.set('host', new URL(url).host);
    return target.fetch(new Request(url, { ...init, headers }));
  };
}

/** A raw `tools/list` POST, as a client would send before it knows it needs a token. */
export function listToolsRequest(bearer?: string): RequestInit {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (bearer !== undefined) headers['authorization'] = `Bearer ${bearer}`;
  return { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) };
}
