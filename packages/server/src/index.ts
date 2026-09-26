import { Hono } from 'hono';
import { isId, newId, type Envelope } from '@ai-wayfinding/core';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { appPrfSalt, base64url, digest, emailHash, equalSecret, randomToken, unbase64url, verifyAgentSignature } from './crypto.js';
import { EnclaveObject } from './enclave.js';
import { invitationEmail, magicLinkEmail } from './email.js';
import { Registry } from './registry.js';
import { failure, limitNumber, object, sequenceCursor, validEpoch, validExpiry, validKind, validScope, validSeq, validString } from './types.js';
import type { AccessChange, CreateJourney, EnclaveMessage, EpochWrap, RegistryMessage, Subject } from './types.js';
export { EnclaveObject, Registry };

export interface Env {
  REGISTRY: DurableObjectNamespace;
  ENCLAVES: DurableObjectNamespace;
  ASSETS: Fetcher;
  MAGIC_EMAIL: SendEmail;
  EMAIL_HASH_KEY: string;
  ADMIN_TOKEN: string;
  RP_ID: string;
  ORIGIN: string;
  EMAIL_IP_RATE?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  EMAIL_ACCOUNT_RATE?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  AGENT_SESSION_RATE?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}
type Auth = { accountHash: string; sessionHash: string; verifiedAt: number | null; email: string | null };
type Context = { Bindings: Env; Variables: { subject: Subject } };
const app = new Hono<Context>();
const json = (data: unknown, status = 200): Response => Response.json(data, { status });
const cookie = (value: string): string => 'wayfinding_session=' + value + '; Path=/v1; HttpOnly; Secure; SameSite=Strict; Max-Age=43200';
const discoveryCookie = (value: string): string => 'wayfinding_discovery=' + value + '; Path=/v1/auth/passkey; HttpOnly; Secure; SameSite=Strict; Max-Age=300';
type AppContext = import('hono').Context<Context>;
async function registry(env: Env, data: RegistryMessage): Promise<any> {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName('registry-v1'));
  const response = await stub.fetch('https://internal/', { method: 'POST', body: JSON.stringify(data) });
  if (!response.ok) throw new Error('registry failed');
  return response.json();
}
async function enclave(env: Env, id: string, data: EnclaveMessage): Promise<Response> {
  return env.ENCLAVES.get(env.ENCLAVES.idFromName(id)).fetch('https://internal/', { method: 'POST', body: JSON.stringify(data) });
}
async function payload(c: AppContext): Promise<Record<string, unknown>> {
  const length = Number(c.req.header('content-length') ?? 0);
  if (length > 1_500_000) throw new Error('body too large');
  const raw = await c.req.raw.text();
  if (new TextEncoder().encode(raw).length > 1_500_000) throw new Error('body too large');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('invalid body'); }
  if (!object(value)) throw new Error('invalid body');
  return value;
}
async function session(c: AppContext): Promise<Auth | null> {
  const match = /(?:^|;\s*)wayfinding_session=([A-Za-z0-9_-]+)/.exec(c.req.header('cookie') ?? '');
  if (!match) return null;
  const sessionHash = await digest(match[1]!);
  const row = await registry(c.env, { op: 'session', hash: sessionHash });
  return row ? { accountHash: row.accountHash, sessionHash, verifiedAt: row.verifiedAt, email: typeof row.email === 'string' ? row.email : null } : null;
}
async function agent(c: AppContext): Promise<Subject | null> {
  const id = c.req.header('x-agent-session'), timestamp = c.req.header('x-agent-timestamp');
  const nonce = c.req.header('x-agent-nonce'), signature = c.req.header('x-agent-signature');
  if (!id || !timestamp || !nonce || !signature || !validString(nonce, 128) || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60_000) return null;
  const row = await registry(c.env, { op: 'agentGet', id });
  if (!row || row.status !== 'approved' || Number(row.expires) <= Date.now()) return null;
  let path: string, body: string;
  try {
    const url = new URL(c.req.url);
    path = url.pathname + url.search;
    body = await c.req.raw.clone().text();
  } catch { return null; }
  if (!await verifyAgentSignature(row.signingKey, c.req.method, path, body, timestamp, nonce, signature)) return null;
  if (!await registry(c.env, { op: 'nonce', id, nonce })) return null;
  return { principal: row.principal, agent: true };
}
async function subject(c: AppContext): Promise<Subject | null> {
  if (c.req.header('x-agent-session')) return agent(c);
  const auth = await session(c);
  const principal = c.req.header('x-principal');
  return auth !== null && auth.verifiedAt !== null && validString(principal, 128) ? { principal, accountHash: auth.accountHash } : null;
}
function wraps(value: unknown, epoch: number): EpochWrap[] | null {
  if (!Array.isArray(value) || value.length > 100 || !value.every(w => object(w) && validString(w.principal, 128) && validString(w.wrap, 100_000) && w.epoch === epoch)) return null;
  if (new Set(value.map(w => w.principal)).size !== value.length) return null;
  return value.map(w => ({ principal: w.principal as string, epoch, wrap: w.wrap as string }));
}
function transportList(jsonText: string): string[] { try { const value: unknown = JSON.parse(jsonText); return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []; } catch { return []; } }
function encrypted(value: unknown, max = 1_048_576): value is string { return validString(value, max) && /^[A-Za-z0-9+/_=-]+$/.test(value); }
function sealedPersonKey(value: unknown): value is string {
  if (!validString(value, 100_000) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try { return unbase64url(value).length >= 64; } catch { return false; }
}
function sealedKeys(value: unknown, migration = false): value is { version: 1; identity: string; signing: string; migrate?: true } {
  return object(value) && Object.keys(value).every(key => ['version', 'identity', 'signing', ...(migration ? ['migrate'] : [])].includes(key)) && value.version === 1 && (value.migrate === undefined || migration && value.migrate === true) && sealedPersonKey(value.identity) && sealedPersonKey(value.signing);
}
type RegistrationResponse = Parameters<typeof verifyRegistrationResponse>[0]['response'];
type AuthenticationResponse = Parameters<typeof verifyAuthenticationResponse>[0]['response'];
function registrationResponse(value: unknown): value is RegistrationResponse {
  return object(value) && validString(value.id, 1024) && value.rawId === value.id && value.type === 'public-key' && object(value.clientExtensionResults) && object(value.response) && validString(value.response.clientDataJSON, 100_000) && validString(value.response.attestationObject, 100_000);
}
function authenticationResponse(value: unknown): value is AuthenticationResponse {
  return object(value) && validString(value.id, 1024) && value.rawId === value.id && value.type === 'public-key' && object(value.clientExtensionResults) && object(value.response) && validString(value.response.clientDataJSON, 100_000) && validString(value.response.authenticatorData, 100_000) && validString(value.response.signature, 100_000);
}
app.onError(() => failure('internal', 500));
app.use('/v1/*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && (!validString(c.env.ORIGIN) || c.req.header('x-wayfinding') !== '1' || c.req.header('origin') !== c.env.ORIGIN)) return failure('csrf', 403);
  await next();
});
app.post('/v1/auth/email/start', async c => {
  let data: Record<string, unknown>;
  try { data = await payload(c); } catch { return failure('invalid-request', 400); }
  if (!validString(data.email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || /[\r\n]/.test(data.email) || data.returnPath !== undefined && (typeof data.returnPath !== 'string' || !/^\/agent-sessions\/[A-Za-z0-9_-]{1,128}$/.test(data.returnPath))) return failure('invalid-request', 400);
  if (!validString(c.env.EMAIL_HASH_KEY)) return failure('internal', 500);
  const email = data.email.trim().toLowerCase();
  const hash = await emailHash(email, c.env.EMAIL_HASH_KEY);
  const ipHash = await digest(c.req.header('cf-connecting-ip') ?? 'unknown');
  const token = randomToken();
  const local = await registry(c.env, { op: 'emailStart', ipHash, emailHash: hash, tokenHash: await digest(token), email });
  const ipLimit = c.env.EMAIL_IP_RATE ? await c.env.EMAIL_IP_RATE.limit({ key: ipHash }) : { success: true };
  const emailLimit = c.env.EMAIL_ACCOUNT_RATE ? await c.env.EMAIL_ACCOUNT_RATE.limit({ key: hash }) : { success: true };
  // Always identical status and shape. No account-existence conditional is present.
  if (local.allowed && ipLimit.success && emailLimit.success) {
    const returnPath = typeof data.returnPath === 'string' ? data.returnPath : '';
    const link = c.env.ORIGIN + '/auth/verify#token=' + encodeURIComponent(token) + (returnPath ? '&next=' + encodeURIComponent(returnPath) : '');
    try {
      const sent = await c.env.MAGIC_EMAIL.send({ to: email, from: { name: 'Wayfinding', email: 'noreply@wayfinding.support' }, replyTo: 'hello@wayfinding.support', subject: 'Your Wayfinding sign-in link', ...magicLinkEmail(link) });
      console.log('magic-link accepted', String((sent as { messageId?: unknown } | undefined)?.messageId ?? 'no-id'));
    }
    catch (cause) {
      // The response never reveals delivery state; the operator log does, without the address or link.
      const detail = cause instanceof Error ? `${(cause as { code?: unknown }).code ?? cause.name}: ${cause.message}` : 'unknown error';
      console.error('magic-link send failed', detail.replaceAll(email, '<address>').slice(0, 300));
    }
  }
  return json({ status: 'accepted' }, 202);
});
app.post('/v1/auth/email/verify', async c => {
  const data = await payload(c).catch(() => null);
  if (!data || !validString(data.token, 128)) return failure('invalid-request', 400);
  const id = randomToken(), sessionHash = await digest(id);
  const row = await registry(c.env, { op: 'emailVerify', tokenHash: await digest(data.token), sessionHash });
  if (!row) return failure('unauthorized', 401);
  return new Response(JSON.stringify({ challenge: row.newAccount ? 'register' : 'login' }), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie(id), 'Cache-Control': 'no-store' } });
});
app.post('/v1/auth/passkey/register/options', async c => {
  const auth = await session(c);
  if (!auth) return failure('unauthorized', 401);
  const existing = await registry(c.env, { op: 'credentials', accountHash: auth.accountHash });
  if (existing.length) return failure('forbidden', 403);
  if (!validString(c.env.EMAIL_HASH_KEY)) return failure('internal', 500);
  const options = await generateRegistrationOptions({ rpName: 'Wayfinding', rpID: c.env.RP_ID, userName: auth.accountHash, userID: new Uint8Array(unbase64url(auth.accountHash)), authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: { prf: { eval: { first: unbase64url(await appPrfSalt(c.env.EMAIL_HASH_KEY)) } } }, excludeCredentials: existing.map((r: any) => ({ id: r.id, transports: transportList(r.transports) })) });
  await registry(c.env, { op: 'challengeSet', sessionHash: auth.sessionHash, challenge: options.challenge, kind: 'register' });
  return json({ ...options, extensions: { prf: { eval: { first: await appPrfSalt(c.env.EMAIL_HASH_KEY) } } } });
});
app.post('/v1/auth/passkey/register/verify', async c => {
  const auth = await session(c); if (!auth) return failure('unauthorized', 401);
  const data = await payload(c).catch(() => null); if (!data || !registrationResponse(data.response) || !sealedKeys(data.sealed)) return failure('invalid-request', 400);
  if ((await registry(c.env, { op: 'credentials', accountHash: auth.accountHash })).length) return failure('forbidden', 403);
  const challenge = await registry(c.env, { op: 'challengeTake', sessionHash: auth.sessionHash, kind: 'register' });
  if (!challenge) return failure('unauthorized', 401);
  if (data.response.clientExtensionResults.prf?.enabled !== true) { console.warn('passkey-register refused', 'prf-not-enabled'); return failure('invalid-request', 400); }
  try {
    const verified = await verifyRegistrationResponse({ response: data.response, expectedChallenge: challenge.challenge, expectedOrigin: c.env.ORIGIN, expectedRPID: c.env.RP_ID, requireUserVerification: true });
    if (!verified.verified) return failure('unauthorized', 401);
    const credential = verified.registrationInfo.credential;
    const added = await registry(c.env, { op: 'credentialAdd', id: credential.id, accountHash: auth.accountHash, publicKey: base64url(credential.publicKey), counter: credential.counter, transports: JSON.stringify(credential.transports ?? []), sessionHash: auth.sessionHash, identity: data.sealed.identity, signing: data.sealed.signing });
    if (!added) return failure('forbidden', 403);
    return json({ verified: true });
  } catch (cause) { console.warn('passkey-register refused', cause instanceof Error ? cause.name + ': ' + cause.message.slice(0, 160) : 'unknown'); return failure('unauthorized', 401); }
});
const diagnosticValues: Record<string, RegExp> = {
  stage: /^(register-create|register-get|login)$/, outcome: /^(ok|no-prf|no-output|error)$/, prf: /^(present|absent)$/, enabled: /^(true|false|absent)$/,
  first: /^(absent|string|arraybuffer|view|other)$/, attachment: /^(platform|cross-platform)$/, aaguid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  error: /^[A-Za-z_]{1,60}$/, browser: /^([A-Za-z]{1,10} \d{1,4}|other)$/,
};
// Accepts only the named shape fields from a signed-in browser; everything else is dropped before logging.
app.post('/v1/diagnostics/passkey', async c => {
  const auth = await session(c); if (!auth) return failure('unauthorized', 401);
  const data = await payload(c).catch(() => null);
  if (!data || typeof data.stage !== 'string' || !diagnosticValues.stage!.test(data.stage)) return failure('invalid-request', 400);
  const entry: Record<string, string | number> = { account: auth.accountHash.slice(0, 8) };
  for (const [field, pattern] of Object.entries(diagnosticValues)) { const value = data[field]; if (typeof value === 'string' && pattern.test(value)) entry[field] = value; }
  if (Number.isInteger(data.length) && (data.length as number) >= 0 && (data.length as number) <= 1024) entry.length = data.length as number;
  console.log('passkey-diagnostic', JSON.stringify(entry));
  return new Response(null, { status: 204 });
});
app.post('/v1/auth/passkey/login/options', async c => {
  const auth = await session(c); if (!auth) return failure('unauthorized', 401);
  const credentials = await registry(c.env, { op: 'credentials', accountHash: auth.accountHash });
  if (!credentials.length) return failure('unauthorized', 401);
  if (!validString(c.env.EMAIL_HASH_KEY)) return failure('internal', 500);
  const legacy = await registry(c.env, { op: 'legacySalt', accountHash: auth.accountHash });
  const appSalt = await appPrfSalt(c.env.EMAIL_HASH_KEY);
  const options = await generateAuthenticationOptions({ rpID: c.env.RP_ID, userVerification: 'required', extensions: { prf: { eval: { first: unbase64url(legacy?.prfSalt || appSalt), ...(legacy?.prfSalt ? { second: unbase64url(appSalt) } : {}) } } }, allowCredentials: credentials.map((r: any) => ({ id: r.id, transports: transportList(r.transports) })) });
  await registry(c.env, { op: 'challengeSet', sessionHash: auth.sessionHash, challenge: options.challenge, kind: 'login' });
  return json({ ...options, extensions: { prf: { eval: { first: legacy?.prfSalt || appSalt, ...(legacy?.prfSalt ? { second: appSalt } : {}) } } } });
});
app.post('/v1/auth/passkey/login/verify', async c => {
  const auth = await session(c); if (!auth) return failure('unauthorized', 401);
  const data = await payload(c).catch(() => null);
  if (!data || !authenticationResponse(data.response)) return failure('invalid-request', 400);
  const challenge = await registry(c.env, { op: 'challengeTake', sessionHash: auth.sessionHash, kind: 'login' });
  if (!challenge) return failure('unauthorized', 401);
  const credential = await registry(c.env, { op: 'credential', id: data.response.id, accountHash: auth.accountHash });
  if (!credential) return failure('unauthorized', 401);
  try {
    const result = await verifyAuthenticationResponse({ response: data.response, expectedChallenge: challenge.challenge, expectedOrigin: c.env.ORIGIN, expectedRPID: c.env.RP_ID, requireUserVerification: true, credential: { id: credential.id, publicKey: new Uint8Array(unbase64url(credential.publicKey)), counter: credential.counter, transports: JSON.parse(credential.transports) } });
    if (!result.verified) return failure('unauthorized', 401);
    const used = await registry(c.env, { op: 'credentialUse', id: credential.id, accountHash: auth.accountHash, counter: result.authenticationInfo.newCounter, sessionHash: auth.sessionHash });
    if (!used) return failure('unauthorized', 401);
    const legacy = await registry(c.env, { op: 'legacySalt', accountHash: auth.accountHash });
    return json({ verified: true, migrate: Boolean(legacy?.prfSalt) });
  } catch { return failure('unauthorized', 401); }
});
app.post('/v1/auth/passkey/start', async c => {
  if (!validString(c.env.EMAIL_HASH_KEY)) return failure('internal', 500);
  const ipHash = await digest(c.req.header('cf-connecting-ip') ?? 'unknown');
  if (!(await registry(c.env, { op: 'inviteRate', journeyId: 'passkey', accountHash: ipHash })).allowed) return failure('rate-limited', 429);
  const options = await generateAuthenticationOptions({ rpID: c.env.RP_ID, userVerification: 'required', extensions: { prf: { eval: { first: unbase64url(await appPrfSalt(c.env.EMAIL_HASH_KEY)) } } } });
  const id = randomToken();
  await registry(c.env, { op: 'challengeSet', sessionHash: await digest(id), challenge: options.challenge, kind: 'discover' });
  return new Response(JSON.stringify({ ...options, extensions: { prf: { eval: { first: await appPrfSalt(c.env.EMAIL_HASH_KEY) } } } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': discoveryCookie(id) } });
});
app.post('/v1/auth/passkey/finish', async c => {
  const data = await payload(c).catch(() => null);
  if (!data || !authenticationResponse(data.response)) return failure('invalid-request', 400);
  const id = /(?:^|;\s*)wayfinding_discovery=([A-Za-z0-9_-]+)/.exec(c.req.header('cookie') ?? '')?.[1];
  if (!id) return failure('unauthorized', 401);
  const challenge = await registry(c.env, { op: 'challengeTake', sessionHash: await digest(id), kind: 'discover' });
  if (!challenge) return failure('unauthorized', 401);
  const credential = await registry(c.env, { op: 'credentialById', id: data.response.id });
  if (!credential?.email || credential.prfSalt) return failure('unauthorized', 401);
  try {
    const result = await verifyAuthenticationResponse({ response: data.response, expectedChallenge: challenge.challenge, expectedOrigin: c.env.ORIGIN, expectedRPID: c.env.RP_ID, requireUserVerification: true, credential: { id: credential.id, publicKey: new Uint8Array(unbase64url(credential.publicKey)), counter: credential.counter, transports: transportList(credential.transports) } });
    if (!result.verified) return failure('unauthorized', 401);
    const sessionId = randomToken();
    const used = await registry(c.env, { op: 'passkeySession', id: credential.id, accountHash: credential.accountHash, counter: result.authenticationInfo.newCounter, sessionHash: await digest(sessionId) });
    if (!used) return failure('unauthorized', 401);
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', cookie(sessionId));
    headers.append('Set-Cookie', discoveryCookie('') + '; Max-Age=0');
    return new Response(JSON.stringify({ verified: true }), { headers });
  } catch { return failure('unauthorized', 401); }
});
app.post('/v1/auth/logout', async c => {
  const auth = await session(c); if (!auth) return failure('unauthorized', 401);
  await registry(c.env, { op: 'logout', hash: auth.sessionHash });
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'wayfinding_session=; Path=/v1; HttpOnly; Secure; SameSite=Strict; Max-Age=0' } });
});

app.get('/v1/me/keys', async c => {
  const auth = await session(c);
  if (!auth || auth.verifiedAt === null) return failure('unauthorized', 401);
  const keys = await registry(c.env, { op: 'keysGet', accountHash: auth.accountHash });
  return new Response(JSON.stringify(keys), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
});
app.put('/v1/me/keys', async c => {
  const auth = await session(c);
  if (!auth || auth.verifiedAt === null) return failure('unauthorized', 401);
  const b = await payload(c).catch(() => null);
  if (!sealedKeys(b, true)) return failure('invalid-request', 400);
  const saved = await registry(c.env, { op: 'keysPut', accountHash: auth.accountHash, sessionHash: auth.sessionHash, version: 1, identity: b.identity, signing: b.signing, migrate: b.migrate === true });
  if (!saved) return failure('forbidden', 403);
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
});

app.post('/v1/journeys', async c => {
  const auth = await session(c); if (!auth || auth.verifiedAt === null) return failure('unauthorized', 401);
  const credentials = await registry(c.env, { op: 'credentials', accountHash: auth.accountHash });
  if (!credentials.length) return failure('forbidden', 403);
  const b = await payload(c).catch(() => null);
  if (!b || !validString(b.name, 200) || !object(b.creator) || !validString(b.creator.id, 128) || !validString(b.creator.recipient, 1024) || !validString(b.creator.signingKey, 1024) || !encrypted(b.genesis) || !encrypted(b.recoveryWrap, 100_000) || !validString(b.minClientVersion, 32)) return failure('invalid-request', 400);
  // The creator's address comes from the verified sign-in, never from the request body.
  const creatorEmail = auth.email;
  if (!creatorEmail || await emailHash(creatorEmail, c.env.EMAIL_HASH_KEY) !== auth.accountHash) return failure('unauthorized', 401);
  const id = b.id;
  if (!isId(id)) return failure('invalid-request', 400);
  const initialWraps = wraps(b.wraps, 1);
  if (!initialWraps || initialWraps.length !== 1 || initialWraps[0]!.principal !== b.creator.id) return failure('invalid-request', 400);
  const data: CreateJourney = { id, name: b.name, creatorEmail, creatorHash: auth.accountHash, creator: { id: b.creator.id, kind: 'person', scope: 'readwrite', accountHash: auth.accountHash }, genesis: b.genesis, wraps: initialWraps, recoveryWrap: b.recoveryWrap, minClientVersion: b.minClientVersion };
  await registry(c.env, { op: 'journeyCreate', data });
  const created = await enclave(c.env, id, { op: 'create', data });
  if (!created.ok) { await registry(c.env, { op: 'journeyDelete', id }); return failure('conflict', 409); }
  return json({ id, principal: b.creator.id }, 201);
});
app.get('/v1/journeys', async c => {
  const auth = await session(c); if (!auth || auth.verifiedAt === null) return failure('unauthorized', 401);
  const rows = await registry(c.env, { op: 'journeys', accountHash: auth.accountHash });
  const visible = [];
  for (const row of rows) {
    const response = await enclave(c.env, row.id, { op: 'access', journeyId: row.id, subject: { principal: row.principal, accountHash: auth.accountHash } });
    if (response.ok) visible.push({ id: row.id, name: row.name, created: row.created, lastActive: row.lastActive, memberCount: row.memberCount, storageBytes: row.storageBytes, visibility: row.visibility, mode: row.mode, minClientVersion: row.minClientVersion, principal: row.principal });
  }
  return json({ journeys: visible });
});
app.get('/v1/admin/registry', async c => {
  const token = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
  if (!validString(c.env.ADMIN_TOKEN) || !equalSecret(await digest(token), await digest(c.env.ADMIN_TOKEN))) return failure('unauthorized', 401);
  return json({ registry: await registry(c.env, { op: 'registry' }) });
});
app.post('/v1/invites/accept', async c => {
  const auth = await session(c); if (!auth || auth.verifiedAt === null) return failure('unauthorized', 401);
  if (!(await registry(c.env, { op: 'credentials', accountHash: auth.accountHash })).length) return failure('forbidden', 403);
  const b = await payload(c).catch(() => null);
  if (!b || !validString(b.inviteId, 256) || !/^[A-Za-z0-9_-]{43,}$/.test(b.inviteId) || !object(b.principal) || !validString(b.principal.id, 128) || !validString(b.principal.recipient, 1024) || !validString(b.principal.signingKey, 1024)) return failure('invalid-request', 400);
  const result = await registry(c.env, { op: 'inviteTake', hash: await digest(b.inviteId), accountHash: auth.accountHash, principal: b.principal.id, recipient: b.principal.recipient, signingKey: b.principal.signingKey });
  if (!result) return failure('not-found', 404);
  return json({ journeyId: result.journeyId, status: 'pending' });
});
// All per-journey routes resolve a server-authenticated principal before contacting the object.
app.use('/v1/journeys/:id/*', async (c, next) => {
  const s = await subject(c);
  if (!s) return failure('unauthorized', 401);
  c.set('subject', s);
  await next();
});
function journeySubject(c: AppContext): Subject { return c.get('subject'); }
app.post('/v1/journeys/:id/seq', async c => enclave(c.env, c.req.param('id'), { op: 'reserve', journeyId: c.req.param('id'), subject: journeySubject(c) }));
app.post('/v1/journeys/:id/records', async c => {
  const b = await payload(c).catch(() => null), id = c.req.param('id');
  if (!b || !object(b.envelope) || !object(b.envelope.outside)) return failure('invalid-request', 400);
  const o = b.envelope.outside;
  if (Object.keys(o).some(k => !['v','id','journey','seq','epoch','size','createdAt'].includes(k)) || o.v !== 1 || !validString(o.id, 128) || o.journey !== id || !validSeq(o.seq) || !validEpoch(o.epoch) || !validString(o.createdAt, 64) || !validSeq(o.size) || o.size > 1_048_576 || !validString(b.envelope.nonce, 64) || !encrypted(b.envelope.ciphertext, 1_400_000)) return failure(o.size && Number(o.size) > 1_048_576 ? 'too-large' : 'invalid-request', o.size && Number(o.size) > 1_048_576 ? 413 : 400);
  const bytes = new TextEncoder().encode(b.envelope.ciphertext).length;
  if (bytes > Math.ceil((1_048_576 + 16) / 3) * 4) return failure('too-large', 413);
  try { if (unbase64url(b.envelope.nonce).length !== 12 || unbase64url(b.envelope.ciphertext).length !== o.size + 16) return failure('invalid-request', 400); } catch { return failure('invalid-request', 400); }
  const envelope: Envelope = { outside: { v: 1, id: o.id, journey: id, seq: o.seq, epoch: o.epoch, size: o.size, createdAt: o.createdAt }, nonce: b.envelope.nonce, ciphertext: b.envelope.ciphertext };
  const response = await enclave(c.env, id, { op: 'recordWrite', journeyId: id, subject: journeySubject(c), envelope });
  if (response.ok) await registry(c.env, { op: 'activity', id, memberDelta: 0, bytes });
  return response;
});
app.get('/v1/journeys/:id/records', async c => {
  const after = sequenceCursor(c.req.query('after'), 0), limit = limitNumber(c.req.query('limit'), 100);
  if (after === null || limit === null || limit > 100) return failure('invalid-request', 400);
  return enclave(c.env, c.req.param('id'), { op: 'records', journeyId: c.req.param('id'), subject: journeySubject(c), after, limit });
});
app.post('/v1/journeys/:id/log', async c => {
  const b = await payload(c).catch(() => null), id = c.req.param('id');
  if (!b) return failure('invalid-request', 400);
  if (journeySubject(c).agent && (b.accessChanges !== undefined || b.wraps !== undefined || b.epoch !== undefined || b.memberWraps !== undefined)) return failure('forbidden', 403);
  if (!encrypted(b.entry) || b.accessChanges !== undefined && (!Array.isArray(b.accessChanges) || b.accessChanges.length > 100)) return failure('invalid-request', 400);
  const changes: AccessChange[] = [];
  const linked: { accountHash: string; principal: string }[] = [];
  for (const value of b.accessChanges ?? []) {
    if (!object(value) || !validString(value.principal, 128) || !['add', 'remove'].includes(String(value.action)) || !validKind(value.kind) || !validScope(value.scope) || value.expiresAt !== undefined && !validExpiry(value.expiresAt)) return failure('invalid-request', 400);
    const change: AccessChange = { principal: value.principal, action: value.action as 'add' | 'remove', kind: value.kind, scope: value.scope };
    if (value.expiresAt !== undefined) change.expiresAt = value.expiresAt as number;
    if (change.action === 'add' && change.kind === 'person') {
      const pending = await registry(c.env, { op: 'pendingGet', journeyId: id, principal: change.principal });
      if (!pending) return failure('forbidden', 403);
      // A support invitation cannot be turned into a writable or permanent server principal.
      if (pending.support === 1 && (change.scope !== 'read' || change.expiresAt !== pending.expires || !validExpiry(pending.expires))) return failure('forbidden', 403);
      change.accountHash = pending.accountHash;
      linked.push({ accountHash: pending.accountHash, principal: change.principal });
    }
    // Agent additions are exclusively through the signed-in approval route.
    if (change.action === 'add' && change.kind === 'agent') return failure('forbidden', 403);
    changes.push(change);
  }
  const epoch = b.epoch;
  if (epoch !== undefined && !validEpoch(epoch)) return failure('invalid-request', 400);
  const rotated = b.wraps === undefined ? undefined : wraps(b.wraps, epoch as number);
  const memberWraps = b.memberWraps === undefined ? undefined : Array.isArray(b.memberWraps) && b.memberWraps.length <= 100 && b.memberWraps.every(w => object(w) && validString(w.principal, 128) && validString(w.wrap, 100_000) && validEpoch(w.epoch)) && new Set(b.memberWraps.map(w => `${w.principal}:${w.epoch}`)).size === b.memberWraps.length ? b.memberWraps.map(w => ({ principal: w.principal as string, epoch: w.epoch as number, wrap: w.wrap as string })) : null;
  if (rotated === null || memberWraps === null) return failure('invalid-request', 400);
  const result = await enclave(c.env, id, { op: 'logWrite', journeyId: id, subject: journeySubject(c), entry: b.entry, changes, epoch, wraps: rotated, memberWraps });
  if (result.ok) {
    for (const added of linked) { await registry(c.env, { op: 'link', accountHash: added.accountHash, journeyId: id, principal: added.principal }); await registry(c.env, { op: 'pendingDelete', journeyId: id, principal: added.principal }); }
    const { memberDelta } = await result.clone().json() as { memberDelta: number };
    await registry(c.env, { op: 'activity', id, memberDelta, bytes: b.entry.length });
  }
  return result;
});
app.get('/v1/journeys/:id/log', async c => {
  const after = sequenceCursor(c.req.query('after'), -1);
  if (after === null) return failure('invalid-request', 400);
  return enclave(c.env, c.req.param('id'), { op: 'log', journeyId: c.req.param('id'), subject: journeySubject(c), after });
});
app.get('/v1/journeys/:id/wraps/me', async c => enclave(c.env, c.req.param('id'), { op: 'wraps', journeyId: c.req.param('id'), subject: journeySubject(c) }));
app.get('/v1/journeys/:id/export', async c => enclave(c.env, c.req.param('id'), { op: 'export', journeyId: c.req.param('id'), subject: journeySubject(c) }));
app.post('/v1/journeys/:id/invites', async c => {
  const b = await payload(c).catch(() => null), id = c.req.param('id');
  if (!b || !validString(b.inviteIdHash, 43) || !/^[A-Za-z0-9_-]{43}$/.test(b.inviteIdHash) || !validExpiry(b.expiresAt) || b.expiresAt > Date.now() + 604_800_000 || b.support !== undefined && typeof b.support !== 'boolean' || b.email !== undefined && (!validString(b.email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email))) return failure('invalid-request', 400);
  if (b.email !== undefined && (journeySubject(c).agent || !journeySubject(c).accountHash || !validString(b.inviteId, 43) || !/^[A-Za-z0-9_-]{43}$/.test(b.inviteId) || await digest(b.inviteId) !== b.inviteIdHash)) return failure('invalid-request', 400);
  const access = await enclave(c.env, id, { op: 'inviteAccess', journeyId: id, subject: journeySubject(c) });
  if (!access.ok) return access;
  if (b.email !== undefined && !(await registry(c.env, { op: 'inviteRate', journeyId: id, accountHash: journeySubject(c).accountHash! })).allowed) return failure('rate-limited', 429);
  await registry(c.env, { op: 'inviteCreate', journeyId: id, hash: b.inviteIdHash, expires: b.expiresAt, support: b.support === true });
  if (typeof b.email === 'string') {
    const email = b.email.trim().toLowerCase();
    const link = c.env.ORIGIN + '/invite#' + b.inviteId;
    try {
      await c.env.MAGIC_EMAIL.send({ to: email, from: { name: 'Wayfinding', email: 'noreply@wayfinding.support' }, replyTo: 'hello@wayfinding.support', subject: 'An invitation to a Wayfinding journey', ...invitationEmail(link) });
    } catch (cause) {
      // Delivery errors can include the address or invitation URL; never write their message to logs.
      console.error('invitation send failed', cause instanceof Error ? cause.name : 'unknown');
      return failure('internal', 500);
    }
  }
  return json({ status: 'created' }, 201);
});
app.get('/v1/journeys/:id/invites/pending', async c => {
  const id = c.req.param('id');
  const access = await enclave(c.env, id, { op: 'inviteAccess', journeyId: id, subject: journeySubject(c) });
  if (!access.ok) return access;
  return json({ pending: await registry(c.env, { op: 'invitePending', journeyId: id }) });
});
app.post('/v1/agent-sessions', async c => {
  const b = await payload(c).catch(() => null);
  if (!b || !isId(b.journeyId) || !object(b.agentPublicKey) || !validString(b.agentPublicKey.recipient, 1024) || !validString(b.agentPublicKey.signingKey, 1024) || !validScope(b.requestedScope)) return failure('invalid-request', 400);
  if (!c.env.AGENT_SESSION_RATE) return failure('internal', 500);
  const ipHash = await digest(c.req.header('cf-connecting-ip') ?? 'unknown');
  if (!(await c.env.AGENT_SESSION_RATE.limit({ key: ipHash })).success) return failure('rate-limited', 429);
  const id = randomToken(), principal = newId(), code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0');
  await registry(c.env, { op: 'agentCreate', id, journeyId: b.journeyId, principal, recipient: b.agentPublicKey.recipient, signingKey: b.agentPublicKey.signingKey, requestedScope: b.requestedScope, code, remembered: b.remembered === true });
  return json({ id, code, approvalUrl: c.env.ORIGIN + '/agent-sessions/' + id }, 201);
});
app.get('/v1/agent-sessions/:id', async c => {
  const row = await registry(c.env, { op: 'agentGet', id: c.req.param('id') });
  if (!row) return failure('not-found', 404);
  const expired = row.status === 'pending' ? Number(row.createdAt) + 600_000 <= Date.now() : row.status === 'approved' && Number(row.expires) <= Date.now();
  return json({ status: expired ? 'expired' : row.status, journeyId: row.journeyId, principal: row.principal, recipient: row.recipient, signingKey: row.signingKey, requestedScope: row.requestedScope, remembered: row.remembered === 1, scope: row.scope, expiresAt: row.expires });
});
app.post('/v1/agent-sessions/:id/approve', async c => {
  const auth = await session(c); if (!auth || auth.verifiedAt === null || Date.now() - auth.verifiedAt > 300_000) return failure('unauthorized', 401);
  const b = await payload(c).catch(() => null), id = c.req.param('id');
  const row = await registry(c.env, { op: 'agentGet', id });
  if (!row || row.status !== 'pending' || Number(row.createdAt) + 600_000 <= Date.now()) return failure('not-found', 404);
  const maxDuration = row.remembered ? 90 * 86_400_000 : 8 * 3_600_000;
  if (!b || !validString(b.code, 6)) return failure('invalid-request', 400);
  const attempt = await registry(c.env, { op: 'agentAttempt', id, code: b.code });
  if (!attempt.available) return failure('not-found', 404);
  if (!attempt.matched) return failure('invalid-request', 400);
  if (!validString(b.principal, 128) || !validScope(b.scope) || !validExpiry(b.expiresAt) || b.expiresAt > Date.now() + maxDuration || !encrypted(b.wrap, 100_000) || !encrypted(b.entry)) return failure('invalid-request', 400);
  const s: Subject = { principal: b.principal, accountHash: auth.accountHash };
  const check = await enclave(c.env, row.journeyId, { op: 'access', journeyId: row.journeyId, subject: s });
  if (!check.ok) return check;
  const { epoch } = await check.json() as { epoch: number };
  const result = await enclave(c.env, row.journeyId, { op: 'logWrite', journeyId: row.journeyId, subject: s, entry: b.entry, changes: [{ principal: row.principal, kind: 'agent', scope: b.scope, action: 'add', expiresAt: b.expiresAt, addedBy: s.principal }], memberWraps: [{ principal: row.principal, epoch, wrap: b.wrap }] });
  if (!result.ok) return result;
  await registry(c.env, { op: 'agentApprove', id, scope: b.scope, expires: b.expiresAt });
  await registry(c.env, { op: 'activity', id: row.journeyId, memberDelta: 1, bytes: b.entry.length });
  return json({ status: 'approved' });
});
app.notFound(async c => {
  if (c.req.path === '/v1' || c.req.path.startsWith('/v1/')) return failure('not-found', 404);
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) return response;
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  // no-transform keeps Cloudflare from rewriting the page, such as injecting an analytics beacon.
  headers.set('Cache-Control', 'no-cache, no-transform');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});
export default app;
