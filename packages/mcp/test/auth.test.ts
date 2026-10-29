import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { app, bridge, ISSUER, keyPair, listToolsRequest, METADATA_URL, RESOURCE, token } from './helpers.ts';

const authkit = await keyPair('authkit-key');
const stranger = await keyPair('authkit-key');
const send = bridge(app(authkit));

/** Every refusal must be a 401 whose challenge points at the protected-resource metadata. */
async function assertChallenge(response: Response): Promise<void> {
  assert.equal(response.status, 401);
  const challenge = response.headers.get('www-authenticate') ?? '';
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, /error="invalid_token"/);
  assert.ok(challenge.includes(`resource_metadata="${METADATA_URL}"`), challenge);
}

test('auth: a request without a token gets a 401 challenge naming the metadata URL', async () => {
  await assertChallenge(await send(RESOURCE, listToolsRequest()));
});

test('auth: a token signed by another key gets a 401 challenge', async () => {
  // Same kid, same claims, different private key: only the signature differs.
  await assertChallenge(await send(RESOURCE, listToolsRequest(await token(stranger))));
});

test('auth: an expired token gets a 401 challenge', async () => {
  const now = Math.floor(Date.now() / 1000);
  await assertChallenge(await send(RESOURCE, listToolsRequest(await token(authkit, { iat: now - 900, exp: now - 600 }))));
});

test('auth: a token for another audience gets a 401 challenge', async () => {
  for (const aud of ['https://other.example/mcp', 'https://poc.wayfinding.support/other', 'https://poc.wayfinding.support']) {
    await assertChallenge(await send(RESOURCE, listToolsRequest(await token(authkit, { aud }))));
  }
});

test('auth: a token from another issuer or without a subject gets a 401 challenge', async () => {
  await assertChallenge(await send(RESOURCE, listToolsRequest(await token(authkit, { iss: 'https://evil.authkit.app' }))));
  await assertChallenge(await send(RESOURCE, listToolsRequest(await token(authkit, { sub: undefined }))));
});

test('auth: a token with an unsigned algorithm gets a 401 challenge', async () => {
  const body = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const forged = `${body({ alg: 'none', typ: 'JWT' })}.${body({ iss: ISSUER, sub: 'user_x', aud: RESOURCE.href, exp: now + 300 })}.`;
  await assertChallenge(await send(RESOURCE, listToolsRequest(forged)));
});

test('auth: a valid token on a foreign Host header is refused before the gate', async () => {
  const init = listToolsRequest(await token(authkit));
  const response = await send(RESOURCE, { ...init, headers: { ...(init.headers as Record<string, string>), host: 'evil.example' } });
  assert.equal(response.status, 403);
});

test('auth: protected resource metadata names the resource and AuthKit', async () => {
  const response = await send(METADATA_URL);
  assert.equal(response.status, 200);
  const document = (await response.json()) as Record<string, unknown>;
  assert.equal(document['resource'], 'https://poc.wayfinding.support/mcp');
  assert.deepEqual(document['authorization_servers'], ['https://welcoming-folk-53-staging.authkit.app']);
});

test('auth: the authorization server metadata mirror names AuthKit endpoints', async () => {
  const response = await send('https://poc.wayfinding.support/.well-known/oauth-authorization-server');
  assert.equal(response.status, 200);
  const document = (await response.json()) as Record<string, unknown>;
  assert.equal(document['issuer'], ISSUER);
  assert.equal(document['token_endpoint'], `${ISSUER}/oauth2/token`);
  assert.deepEqual(document['code_challenge_methods_supported'], ['S256']);
});

test('auth: a valid token reaches whoami, which reports the token subject', async () => {
  const bearer = await token(authkit, { sub: 'user_01HAPPYPATH' });
  const client = new Client({ name: 'auth-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(
    new StreamableHTTPClientTransport(RESOURCE, { fetch: send, requestInit: { headers: { authorization: `Bearer ${bearer}` } } }),
  );
  try {
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { subject: 'user_01HAPPYPATH', era: 'modern' });
  } finally {
    await client.close();
  }
});

test('auth: the subject comes from the token, not from tool arguments', async () => {
  const bearer = await token(authkit, { sub: 'user_01REAL' });
  const client = new Client({ name: 'auth-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(
    new StreamableHTTPClientTransport(RESOURCE, { fetch: send, requestInit: { headers: { authorization: `Bearer ${bearer}` } } }),
  );
  try {
    const result = await client.callTool({ name: 'whoami', arguments: { subject: 'user_01FORGED', sub: 'user_01FORGED' } });
    assert.equal((result.structuredContent as { subject?: string } | undefined)?.subject, 'user_01REAL');
  } finally {
    await client.close();
  }
});
