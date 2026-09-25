import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgeIdentity, createSigningIdentity, generateJourneyKey, hashEntry, importSigningKey, newId, open, removeAndRotate, seal, signEntry, verifyLog, wrapJourneyKey, type JourneyKey, type LogEntry } from '@ai-wayfinding/core';
import worker, { type Env } from '../src/index.js';
import { authenticator } from './authenticator.js';
import { base64url, digest, unbase64url } from '../src/crypto.js';

const origin = 'https://app.wayfinding.support';
const testSealed = () => ({ version: 1, identity: base64url(crypto.getRandomValues(new Uint8Array(96))), signing: base64url(crypto.getRandomValues(new Uint8Array(96))) });
let sent: string[] = [];
let ip = 1;
beforeEach(() => { sent = []; ip++; });
async function request(path: string, method = 'GET', body?: object, extra: Record<string, string> = {}, overrides: Partial<Env> = {}) {
  return worker.fetch(new Request(origin + path, { method, headers: { Origin: origin, 'X-Wayfinding': '1', 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.' + ip, ...extra }, body: body && JSON.stringify(body) }), { ...env, RP_ID: 'app.wayfinding.support', ORIGIN: origin, EMAIL_HASH_KEY: 'test-key', ADMIN_TOKEN: 'test-admin', AGENT_SESSION_RATE: { limit: async () => ({ success: true }) }, MAGIC_EMAIL: { send: async message => { sent.push('text' in message ? message.text ?? '' : ''); return { messageId: 'test' }; } }, ...overrides } as Env);
}
async function account(email: string) {
  const started = await request('/v1/auth/email/start', 'POST', { email });
  expect(started.status).toBe(202);
  const text = sent.at(-1)!;
  const token = /#token=([A-Za-z0-9_-]+)/.exec(text)![1]!;
  const verified = await request('/v1/auth/email/verify', 'POST', { token });
  expect(verified.status).toBe(200);
  const cookie = verified.headers.get('set-cookie')!.split(';')[0]!;
  const { challenge } = await verified.json() as { challenge: string };
  return { email, cookie, token, challenge };
}
async function person(email: string) {
  const a = await account(email);
  const device = await authenticator();
  const options = await request('/v1/auth/passkey/register/options','POST',{}, { Cookie: a.cookie });
  expect(options.status).toBe(200);
  const values = await options.json() as {challenge:string,extensions:{prf:{eval:{first:string}}},authenticatorSelection:{userVerification:string,residentKey:string}};
  expect(values.extensions.prf.eval.first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(values.authenticatorSelection.userVerification).toBe('required');
  expect(values.authenticatorSelection.residentKey).toBe('required');
  const verified = await request('/v1/auth/passkey/register/verify','POST',{response:device.register(values.challenge),sealed:testSealed()},{Cookie:a.cookie});
  expect(verified.status).toBe(200);
  return { ...a, device, age: await createAgeIdentity(), signing: await createSigningIdentity(), principal: newId() };
}
async function cipherLog(key: JourneyKey, id: string, entry: LogEntry) {
  const sealed = await seal({type:'membership',typeVersion:1,body:{entry:JSON.stringify(entry)}}, {id:newId(),journey:id,epoch:key.epoch,createdAt:new Date().toISOString()},key);
  return base64url(new TextEncoder().encode(JSON.stringify(sealed)));
}
async function journey(owner: Awaited<ReturnType<typeof person>>) {
  const key = generateJourneyKey();
  const id = newId();
  const genesis = await signEntry({v:1,seq:0,prev:null,at:new Date().toISOString(),actor:owner.principal,type:'genesis',body:{journey:id,name:'Shared space',creator:{id:owner.principal,kind:'person',recipient:owner.age.recipient,signingKey:owner.signing.publicKey},grants:['members.manage'],mode:'sealed',visibility:'private',minClientVersion:'0.1.0'}},await importSigningKey(owner.signing.privateKey));
  const recovery = await createAgeIdentity();
  const recoveryWrap = (await wrapJourneyKey(key,[{id:'recovery',recipient:recovery.recipient}]))[0]!.ciphertext;
  const create = await request('/v1/journeys','POST',{id,name:'Shared space',creatorEmail:'spoofed@example.org',creator:{id:owner.principal,recipient:owner.age.recipient,signingKey:owner.signing.publicKey},genesis:await cipherLog(key,id,genesis),wraps:(await wrapJourneyKey(key,[{id:owner.principal,recipient:owner.age.recipient}])).map(w=>({principal:w.recipient,epoch:w.epoch,wrap:w.ciphertext})),recoveryWrap,minClientVersion:'0.1.0'},{Cookie:owner.cookie});
  expect(create.status).toBe(201);
  expect((await create.json() as {id:string}).id).toBe(id);
  return {id,key,entries:[genesis]};
}
const as = (p: {cookie:string,principal:string}) => ({ Cookie:p.cookie, 'X-Principal':p.principal });

// Seam: the Worker HTTP API, real Durable Objects and SQLite; email delivery is the only fake.
describe('HTTP boundary', () => {
  it('stores only versioned ciphertext fields for its verified account', async () => {
    const p = await person('sealed-keys@example.org');
    const other = await person('other-sealed-keys@example.org');
    const ciphertext = base64url(crypto.getRandomValues(new Uint8Array(96)));
    const sealed = { version: 1, identity: ciphertext, signing: ciphertext };
    expect((await request('/v1/me/keys', 'PUT', sealed, { Cookie: p.cookie })).status).toBe(204);
    const response = await request('/v1/me/keys', 'GET', undefined, { Cookie: p.cookie });
    expect(await response.json()).toEqual(sealed);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await (await request('/v1/me/keys', 'GET', undefined, { Cookie: other.cookie })).json()).not.toEqual(sealed);
    expect((await request('/v1/me/keys', 'GET')).status).toBe(401);
    const unverified = await account('unverified-keys@example.org');
    expect((await request('/v1/me/keys', 'PUT', sealed, { Cookie: unverified.cookie })).status).toBe(401);
    expect((await request('/v1/me/keys', 'GET', undefined, { Cookie: unverified.cookie })).status).toBe(401);
    expect(await (await request('/v1/me/keys', 'GET', undefined, { Cookie: p.cookie })).json()).toEqual(sealed);
    expect((await request('/v1/me/keys', 'PUT', { ...sealed, privateKey: 'secret' }, { Cookie: p.cookie })).status).toBe(400);
    expect((await request('/v1/me/keys', 'PUT', { ...sealed, identity: 'plaintext' }, { Cookie: p.cookie })).status).toBe(400);
    expect((await request('/v1/me/keys', 'PUT', { identity: ciphertext, signing: ciphertext }, { Cookie: p.cookie })).status).toBe(400);
  });
  it('keeps a different random PRF salt per account and uses it for login in a new session', async () => {
    const first = await account('salt-first@example.org');
    const second = await account('salt-second@example.org');
    const options = async (cookie: string) => (await request('/v1/auth/passkey/register/options', 'POST', {}, { Cookie: cookie })).json() as Promise<{ challenge: string; extensions: { prf: { eval: { first: string } } } }>;
    const initial = await options(first.cookie);
    expect((await options(second.cookie)).extensions.prf.eval.first).not.toBe(initial.extensions.prf.eval.first);
    const latest = await options(first.cookie);
    expect(latest.extensions.prf.eval.first).toBe(initial.extensions.prf.eval.first);
    const device = await authenticator();
    expect((await request('/v1/auth/passkey/register/verify', 'POST', { response: device.register(latest.challenge), sealed: testSealed() }, { Cookie: first.cookie })).status).toBe(200);
    const next = await account(first.email);
    const login = await request('/v1/auth/passkey/login/options', 'POST', {}, { Cookie: next.cookie });
    expect((await login.json() as { extensions: { prf: { eval: { first: string } } } }).extensions.prf.eval.first).toBe(initial.extensions.prf.eval.first);
    const unlockedTab = await request('/v1/auth/passkey/login/options', 'POST', {}, { Cookie: first.cookie });
    expect((await unlockedTab.json() as { extensions: { prf: { eval: { first: string } } } }).extensions.prf.eval.first).toBe(initial.extensions.prf.eval.first);
  });
  it('refuses an unsealed registration without saving a credential', async () => {
    const a = await account('unsealed@example.org');
    const device = await authenticator();
    const options = await request('/v1/auth/passkey/register/options', 'POST', {}, { Cookie: a.cookie });
    const { challenge } = await options.json() as { challenge: string };
    expect((await request('/v1/auth/passkey/register/verify', 'POST', { response: device.register(challenge) }, { Cookie: a.cookie })).status).toBe(400);
    expect((await account(a.email)).challenge).toBe('register');
  });
  it('refuses registration without PRF and leaves no credential for a clean retry', async () => {
    const a = await account('no-prf@example.org');
    const device = await authenticator();
    const options = await request('/v1/auth/passkey/register/options', 'POST', {}, { Cookie: a.cookie });
    const { challenge } = await options.json() as { challenge: string };
    const withoutPrf = device.register(challenge, false);
    expect((await request('/v1/auth/passkey/register/verify', 'POST', { response: withoutPrf, sealed: testSealed() }, { Cookie: a.cookie })).status).toBe(400);
    const next = await account(a.email);
    expect(next.challenge).toBe('register');
    expect((await request('/v1/auth/passkey/register/options', 'POST', {}, { Cookie: next.cookie })).status).toBe(200);
  });
  it('logs passkey diagnostics from named fields only and requires a session', async () => {
    expect((await request('/v1/diagnostics/passkey', 'POST', { stage: 'register-create', outcome: 'no-output' })).status).toBe(401);
    const a = await account('diagnostics@example.org');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const sent = await request('/v1/diagnostics/passkey', 'POST', { stage: 'register-create', outcome: 'no-output', enabled: 'absent', first: 'absent', length: 0, aaguid: 'bada5566-a7aa-401f-bd96-45619a55120d', browser: 'Chrome 140', prfOutput: 'SECRET-PRF', email: a.email, error: 'bad value; SECRET-ERR' }, { Cookie: a.cookie });
      expect(sent.status).toBe(204);
      const line = log.mock.calls.map(call => call.join(' ')).find(text => text.startsWith('passkey-diagnostic'))!;
      expect(line).toContain('"stage":"register-create"');
      expect(line).toContain('"aaguid":"bada5566-a7aa-401f-bd96-45619a55120d"');
      expect(line).not.toContain('SECRET');
      expect(line).not.toContain(a.email);
      expect((await request('/v1/diagnostics/passkey', 'POST', { stage: 'anything' }, { Cookie: a.cookie })).status).toBe(400);
    } finally { log.mockRestore(); }
  });
  it('applies isolation headers to HTML assets without changing API responses', async () => {
    const assets: Fetcher = { fetch: async () => new Response('<h1>Journey</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' } }), connect: () => { throw new Error('not used'); } };
    const page = await request('/journeys', 'GET', undefined, {}, { ASSETS: assets });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(page.headers.get('permissions-policy')).toContain('camera=()');
    // Stops edge features (for example an analytics beacon) from being injected into the page.
    expect(page.headers.get('cache-control')).toContain('no-transform');
    expect((await request('/v1/missing', 'GET', undefined, {}, { ASSETS: assets })).status).toBe(404);
    expect((await request('/v1', 'GET', undefined, {}, { ASSETS: assets })).status).toBe(404);
  });
  it('hides account existence, requires CSRF and consumes links', async () => {
    sent = [];
    const first = await account('guest@example.org');
    expect((await request('/v1/auth/email/verify','POST',{token:first.token})).status).toBe(401);
    const secondStart = await request('/v1/auth/email/start','POST',{email:first.email});
    expect(secondStart.status).toBe(202);
    expect(await secondStart.json()).toEqual({status:'accepted'});
    const denied = await request('/v1/auth/email/start','POST',{email:first.email},{'X-Wayfinding':'0'});
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({error:{code:'csrf'}});
    expect((await request('/v1/auth/email/start','POST',{email:first.email},{Origin:'https://elsewhere.example'})).status).toBe(403);
    expect((await request('/v1/auth/passkey/register/options','POST',{})).status).toBe(401);
  });
  it('sends a normalized, structured magic link and rejects header injection', async () => {
    const emails: unknown[] = [];
    const delivery = { send: async (message: unknown) => { emails.push(message); return {messageId:'test'}; } };
    expect((await request('/v1/auth/email/start','POST',{email:'Mixed.Case@Example.ORG'},{},{MAGIC_EMAIL:delivery})).status).toBe(202);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toEqual({
      to:'mixed.case@example.org',
      from:{ name:'Wayfinding', email:'noreply@wayfinding.support' },
      replyTo:'hello@wayfinding.support',
      subject:'Your Wayfinding sign-in link',
      text:expect.stringContaining('/auth/verify#token='),
      html:expect.stringContaining('/auth/verify#token='),
    });
    const message = emails[0] as { text: string; html: string };
    // Says why the person got it and what to do if they did not ask.
    for (const body of [message.text, message.html]) {
      expect(body).toContain('app.wayfinding.support');
      expect(body).toContain('15 minutes');
      expect(body).toContain("If you didn't ask");
    }
    // The address is never echoed into the HTML, so it cannot inject markup.
    expect(message.html).not.toContain('mixed.case@example.org');
    expect(message.html).not.toMatch(/<script|<img|https?:\/\/(?!app\.wayfinding\.support)/);
    expect((await request('/v1/auth/email/start','POST',{email:'attacker@example.org\r\nBcc: victim@example.org'},{},{MAGIC_EMAIL:delivery})).status).toBe(400);
    expect(emails).toHaveLength(1);
    const failed = await request('/v1/auth/email/start','POST',{email:'delivery-failure@example.org'},{},{MAGIC_EMAIL:{send:async () => { throw new Error('delivery failed'); }}});
    expect(failed.status).toBe(202);
    expect(await failed.json()).toEqual({status:'accepted'});
  });
  it('logs an accepted send with its message ID only', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try { expect((await request('/v1/auth/email/start','POST',{email:'logged-ok@example.org'},{},{MAGIC_EMAIL:{send:async () => ({ messageId: 'msg-123' })}})).status).toBe(202); }
    finally { spy.mockRestore(); }
    const joined = lines.join('\n');
    expect(joined).toContain('magic-link accepted msg-123');
    expect(joined).not.toContain('logged-ok@example.org');
    expect(joined).not.toContain('#token=');
  });
  it('logs a delivery failure without the address or the sign-in link', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      const failed = await request('/v1/auth/email/start','POST',{email:'logged-failure@example.org'},{},{MAGIC_EMAIL:{send:async () => { throw Object.assign(new Error('sender not verified'), { code: 'E_SENDER' }); }}});
      expect(failed.status).toBe(202);
    } finally { spy.mockRestore(); }
    const joined = lines.join('\n');
    expect(joined).toContain('magic-link send failed');
    expect(joined).toContain('sender not verified');
    expect(joined).not.toContain('logged-failure@example.org');
    expect(joined).not.toContain('#token=');
  });
  it('returns to a named agent request without sending an invitation secret or open redirect', async () => {
    const emails: { text: string }[] = [];
    const delivery = { send: async (message: unknown) => { if (message && typeof message === 'object' && 'text' in message && typeof message.text === 'string') emails.push({ text: message.text }); return { messageId: 'test' }; } };
    expect((await request('/v1/auth/email/start', 'POST', { email: 'agent-return@example.org', returnPath: '/agent-sessions/valid_123' }, {}, { MAGIC_EMAIL: delivery })).status).toBe(202);
    expect(emails[0]!.text).toContain('#token=');
    expect(emails[0]!.text).toContain('&next=%2Fagent-sessions%2Fvalid_123');
    expect((await request('/v1/auth/email/start', 'POST', { email: 'agent-return@example.org', returnPath: 'https://elsewhere.example' }, {}, { MAGIC_EMAIL: delivery })).status).toBe(400);
    expect((await request('/v1/auth/email/start', 'POST', { email: 'agent-return@example.org', returnPath: '/invite#leaked' }, {}, { MAGIC_EMAIL: delivery })).status).toBe(400);
    expect(emails).toHaveLength(1);
  });
  it('enforces per-address and per-IP limits without changing the response', async () => {
    sent=[];
    for(let i=0;i<12;i++) expect((await request('/v1/auth/email/start','POST',{email:'limited@example.org'})).status).toBe(202);
    expect(sent).toHaveLength(5);
  });
  it('requires a real passkey and blocks unregistered account creation', async () => {
    sent=[];
    const noKey = await account('not-yet@example.org');
    expect((await request('/v1/journeys','POST',{}, {Cookie:noKey.cookie})).status).toBe(401);
    expect((await request('/v1/auth/passkey/register/verify','POST',{response:{}},{Cookie:noKey.cookie})).status).toBe(400);
    const p = await person('owner@example.org');
    const created = await journey(p);
    expect((await request('/v1/journeys', 'GET',undefined,as(p))).status).toBe(200);
    expect(created.id).toBeTruthy();
  });
});

async function agentHeaders(sessionId: string, privateKey: string, method: string, path: string, body?: object, nonce = newId(), timestamp = String(Date.now())) {
  const raw = body ? JSON.stringify(body) : '';
  const hash = await digest(raw);
  const key = await crypto.subtle.importKey('pkcs8',new Uint8Array(unbase64url(privateKey)),'Ed25519',false,['sign']);
  const message = [method,path,hash,timestamp,nonce].join('\n');
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('Ed25519',key,new TextEncoder().encode(message))));
  return {'X-Agent-Session':sessionId,'X-Agent-Nonce':nonce,'X-Agent-Timestamp':timestamp,'X-Agent-Signature':signature};
}

it('creates, joins, syncs and rotates ciphertext; denies unauthorized reads and stale writes', async () => {
  const owner = await person('holder@example.org');
  const guest = await person('later@example.org');
  const {id,key,entries} = await journey(owner);
  const id2 = (await journey(owner)).id;
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const invited = await request('/v1/journeys/'+id+'/invites','POST',{inviteIdHash:await digest(token),expiresAt:Date.now()+3_600_000},as(owner));
  expect(invited.status).toBe(201);
  expect((await request('/v1/invites/accept','POST',{inviteId:token,principal:{id:guest.principal,recipient:guest.age.recipient,signingKey:guest.signing.publicKey}},{Cookie:guest.cookie})).status).toBe(200);
  expect((await request('/v1/invites/accept','POST',{inviteId:token,principal:{id:newId(),recipient:guest.age.recipient,signingKey:guest.signing.publicKey}},{Cookie:guest.cookie})).status).toBe(404);
  const pending = await request('/v1/journeys/'+id+'/invites/pending','GET',undefined,as(owner));
  expect((await pending.json() as {pending:{principal:string}[]}).pending[0]!.principal).toBe(guest.principal);
  const memberWrap = (await wrapJourneyKey(key,[{id:guest.principal,recipient:guest.age.recipient}]))[0]!;
  const added = await signEntry({v:1,seq:1,prev:await hashEntry(entries[0]!),at:new Date().toISOString(),actor:owner.principal,type:'member.add',body:{member:{id:guest.principal,kind:'person',recipient:guest.age.recipient,signingKey:guest.signing.publicKey},kind:'person',grants:[]}},await importSigningKey(owner.signing.privateKey));
  entries.push(added);
  const joined = await request('/v1/journeys/'+id+'/log','POST',{entry:await cipherLog(key,id,added),accessChanges:[{principal:guest.principal,action:'add',kind:'person',scope:'read'}],memberWraps:[{principal:guest.principal,epoch:1,wrap:memberWrap.ciphertext}]},as(owner));
  expect(joined.status).toBe(201);
  const guestWrap = await request('/v1/journeys/'+id+'/wraps/me','GET',undefined,as(guest));
  expect((await guestWrap.json() as {wraps:{wrap:string}[]}).wraps[0]!.wrap).toBe(memberWrap.ciphertext);
  expect((await request('/v1/journeys/'+id2+'/wraps/me','GET',undefined,as(guest))).status).toBe(403);
  expect((await request('/v1/journeys/'+id2+'/log','GET',undefined,as(guest))).status).toBe(403);
  expect((await request('/v1/journeys/'+id2+'/records','GET',undefined,as(guest))).status).toBe(403);
  expect((await request('/v1/journeys/'+id+'/seq','POST',{},as(guest))).status).toBe(403);
  const reserved = await request('/v1/journeys/'+id+'/seq','POST',{},as(owner));
  expect(reserved.status).toBe(200);
  const {seq} = await reserved.json() as {seq:number};
  const envelope = await seal({type:'item',typeVersion:1,body:{title:'Encrypted only'}},{id:newId(),journey:id,epoch:1,seq,createdAt:new Date().toISOString()},key);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope},as(guest))).status).toBe(403);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope},as(owner))).status).toBe(201);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope},as(owner))).status).toBe(409);
  const list = await request('/v1/journeys/'+id+'/records','GET',undefined,as(guest));
  expect(list.status).toBe(200);
  const result = await list.json() as {records:typeof envelope[]};
  expect(result.records).toEqual([envelope]);
  expect(JSON.stringify(result)).not.toContain('Encrypted only');
  expect((await open(result.records[0]!,key)).body.title).toBe('Encrypted only');
  const admin = await request('/v1/admin/registry','GET',undefined,{Authorization:'Bearer test-admin'});
  const registry = await admin.text();
  expect(registry).toContain(owner.email);
  // A body address cannot choose the stored creator email.
  expect(registry).not.toContain('spoofed@example.org');
  expect(registry).not.toContain(guest.email);
  expect(registry).not.toContain('Encrypted only');
  expect((await request('/v1/admin/registry','GET',undefined,{Authorization:'Bearer invalid'})).status).toBe(401);
  const old = await request('/v1/journeys/'+id+'/seq','POST',{},as(owner));
  const oldSeq = (await old.json() as {seq:number}).seq;
  const state = await verifyLog(entries);
  if (!state.ok) throw new Error(state.error.code);
  const rotated = await removeAndRotate(state.state,guest.principal,owner.principal,await importSigningKey(owner.signing.privateKey));
  const removal = await request('/v1/journeys/'+id+'/log','POST',{entry:await cipherLog(key,id,rotated.entries[0]!),accessChanges:[{principal:guest.principal,action:'remove',kind:'person',scope:'read'}]},as(owner));
  expect(removal.status).toBe(201);
  expect((await request('/v1/journeys/'+id+'/seq','POST',{},as(owner))).status).toBe(409);
  const rotation = await request('/v1/journeys/'+id+'/log','POST',{entry:await cipherLog(rotated.key,id,rotated.entries[1]!),accessChanges:[],wraps:rotated.wraps.map(w=>({principal:w.recipient,epoch:w.epoch,wrap:w.ciphertext})),epoch:2},as(owner));
  expect(rotation.status).toBe(201);
  const verified = await verifyLog([...entries,...rotated.entries]);
  expect(verified.ok && verified.state.currentEpoch).toBe(2);
  expect((await request('/v1/journeys/'+id+'/records','GET',undefined,as(guest))).status).toBe(403);
  expect((await request('/v1/journeys/'+id+'/wraps/me','GET',undefined,as(guest))).status).toBe(403);
  const stale = await seal({type:'item',typeVersion:1,body:{title:'old'}},{id:newId(),journey:id,epoch:1,seq:oldSeq,createdAt:new Date().toISOString()},key);
  const denied = await request('/v1/journeys/'+id+'/records','POST',{envelope:stale},as(owner));
  expect(denied.status).toBe(409);
  expect(await denied.json()).toEqual({error:{code:'old-epoch'}});
  expect((await request('/v1/journeys/'+id+'/export','GET',undefined,as(guest))).status).toBe(403);
});

it('keeps a Wayfinding support invite read-only and expiring at the server boundary', async () => {
  const owner = await person('support-holder@example.org');
  const invited = await person('support-guest@example.org');
  const { id, key, entries } = await journey(owner);
  const token = base64url(crypto.getRandomValues(new Uint8Array(32))), expiresAt = Date.now() + 3_600_000;
  expect((await request('/v1/journeys/'+id+'/invites', 'POST', { inviteIdHash: await digest(token), expiresAt, support: true }, as(owner))).status).toBe(201);
  expect((await request('/v1/invites/accept', 'POST', { inviteId: token, principal: { id: invited.principal, recipient: invited.age.recipient, signingKey: invited.signing.publicKey } }, { Cookie: invited.cookie })).status).toBe(200);
  const pending = await request('/v1/journeys/'+id+'/invites/pending', 'GET', undefined, as(owner));
  expect((await pending.json() as { pending: { support: number; expires: number }[] }).pending[0]).toMatchObject({ support: 1, expires: expiresAt });
  const member = { id: invited.principal, kind: 'person', recipient: invited.age.recipient, signingKey: invited.signing.publicKey, scope: 'read', support: true, expiresAt: new Date(expiresAt).toISOString() };
  const entry = await signEntry({ v: 1, seq: 1, prev: await hashEntry(entries[0]!), at: new Date().toISOString(), actor: owner.principal, type: 'member.add', body: { member, kind: 'person', grants: [] } }, await importSigningKey(owner.signing.privateKey));
  const wrap = (await wrapJourneyKey(key, [{ id: invited.principal, recipient: invited.age.recipient }]))[0]!;
  const submission = { entry: await cipherLog(key, id, entry), memberWraps: [{ principal: invited.principal, epoch: 1, wrap: wrap.ciphertext }] };
  expect((await request('/v1/journeys/'+id+'/log', 'POST', { ...submission, accessChanges: [{ principal: invited.principal, action: 'add', kind: 'person', scope: 'readwrite' }] }, as(owner))).status).toBe(403);
  expect((await request('/v1/journeys/'+id+'/log', 'POST', { ...submission, accessChanges: [{ principal: invited.principal, action: 'add', kind: 'person', scope: 'read', expiresAt: expiresAt + 1 }] }, as(owner))).status).toBe(403);
  expect((await request('/v1/journeys/'+id+'/log', 'POST', { ...submission, accessChanges: [{ principal: invited.principal, action: 'add', kind: 'person', scope: 'read', expiresAt }] }, as(owner))).status).toBe(201);
  expect((await request('/v1/journeys/'+id+'/seq', 'POST', {}, as(invited))).status).toBe(403);
  expect((await request('/v1/journeys/'+id+'/log', 'GET', undefined, as(invited))).status).toBe(200);
});

it('rejects a malformed journey ID when requesting an agent session', async () => {
  const body = {journeyId:'not-an-id',agentPublicKey:{recipient:'public-recipient',signingKey:'public-signing-key'},requestedScope:'read'};
  expect((await request('/v1/agent-sessions','POST',body)).status).toBe(400);
});

it('limits unauthenticated agent-session creation by IP', async () => {
  const keys: string[] = [];
  const rate = { limit: async ({key}: {key:string}) => { keys.push(key); return {success:keys.length <= 10}; } };
  const body = {journeyId:newId(),agentPublicKey:{recipient:'public-recipient',signingKey:'public-signing-key'},requestedScope:'read' as const};
  for (let i = 0; i < 10; i++) expect((await request('/v1/agent-sessions','POST',body,{}, {AGENT_SESSION_RATE:rate})).status).toBe(201);
  expect((await request('/v1/agent-sessions','POST',body,{}, {AGENT_SESSION_RATE:rate})).status).toBe(429);
  expect(new Set(keys).size).toBe(1);
  expect((await request('/v1/agent-sessions','POST',body,{}, {AGENT_SESSION_RATE:undefined})).status).toBe(500);
});

it('approves an agent session on the first correct code', async () => {
  const owner = await person('first-code-owner@example.org');
  const {id} = await journey(owner);
  const started = await request('/v1/agent-sessions','POST',{journeyId:id,agentPublicKey:{recipient:'recipient',signingKey:'signing-key'},requestedScope:'read'});
  expect(started.status).toBe(201);
  const {id:sessionId,code} = await started.json() as {id:string,code:string};
  const approval = {code,principal:owner.principal,scope:'read',expiresAt:Date.now()+3_600_000,wrap:'YWJjZA==',entry:'YWJjZA=='};
  expect((await request('/v1/agent-sessions/'+sessionId+'/approve','POST',approval,{Cookie:owner.cookie})).status).toBe(200);
  expect((await (await request('/v1/agent-sessions/'+sessionId)).json() as {status:string}).status).toBe('approved');
});

it('expires unapproved agent sessions after ten minutes', async () => {
  const owner = await person('pending-agent-owner@example.org');
  const {id} = await journey(owner);
  const started = await request('/v1/agent-sessions','POST',{journeyId:id,agentPublicKey:{recipient:'recipient',signingKey:'signing-key'},requestedScope:'read'});
  expect(started.status).toBe(201);
  const {id:sessionId,code} = await started.json() as {id:string,code:string};
  const now = Date.now();
  try {
    vi.useFakeTimers(); vi.setSystemTime(now + 600_001);
    const status = await request('/v1/agent-sessions/'+sessionId);
    expect((await status.json() as {status:string}).status).toBe('expired');
    const next = await account(owner.email);
    const options = await request('/v1/auth/passkey/login/options','POST',{}, {Cookie:next.cookie});
    const {challenge} = await options.json() as {challenge:string};
    const assertion = await owner.device.login(challenge);
    expect((await request('/v1/auth/passkey/login/verify','POST',{response:assertion},{Cookie:next.cookie})).status).toBe(200);
    const approval = {code,principal:owner.principal,scope:'read',expiresAt:Date.now()+3_600_000,wrap:'YWJjZA==',entry:'YWJjZA=='};
    expect((await request('/v1/agent-sessions/'+sessionId+'/approve','POST',approval,{Cookie:next.cookie})).status).toBe(404);
  } finally { vi.useRealTimers(); }
});

it('locks an agent session after five wrong approval codes', async () => {
  const owner = await person('locked-agent-owner@example.org');
  const {id} = await journey(owner);
  const started = await request('/v1/agent-sessions','POST',{journeyId:id,agentPublicKey:{recipient:'recipient',signingKey:'signing-key'},requestedScope:'read'});
  expect(started.status).toBe(201);
  const {id:sessionId,code} = await started.json() as {id:string,code:string};
  const url = '/v1/agent-sessions/'+sessionId+'/approve';
  const approval = {code,principal:owner.principal,scope:'read',expiresAt:Date.now()+3_600_000,wrap:'YWJjZA==',entry:'YWJjZA=='};
  for (let i = 0; i < 5; i++) expect((await request(url,'POST',{...approval,code:code === '000000' ? '999999' : '000000'},{Cookie:owner.cookie})).status).toBe(400);
  expect((await (await request('/v1/agent-sessions/'+sessionId)).json() as {status:string}).status).toBe('locked');
  expect((await request(url,'POST',approval,{Cookie:owner.cookie})).status).toBe(404);
});

it('approves a session agent and rejects a replay, expired timestamp and unauthorized signature', async () => {
  const owner = await person('agent-holder@example.org');
  const {id,key,entries} = await journey(owner);
  const bot = await createSigningIdentity();
  const agentAge = await createAgeIdentity();
  const started = await request('/v1/agent-sessions','POST',{journeyId:id,agentPublicKey:{recipient:agentAge.recipient,signingKey:bot.publicKey},requestedScope:'readwrite'});
  expect(started.status).toBe(201);
  const {id:sessionId,code} = await started.json() as {id:string,code:string};
  expect(code).toMatch(/^\d{6}$/);
  const row = await request('/v1/agent-sessions/'+sessionId);
  const {principal:agentPrincipal} = await row.json() as {principal:string};
  const agentWrap = (await wrapJourneyKey(key,[{id:agentPrincipal,recipient:agentAge.recipient}]))[0]!;
  const agentEntry = await signEntry({v:1,seq:1,prev:await hashEntry(entries[0]!),at:new Date().toISOString(),actor:owner.principal,type:'member.add',body:{member:{id:agentPrincipal,kind:'agent',recipient:agentAge.recipient,signingKey:bot.publicKey,scope:'readwrite',addedBy:owner.principal},kind:'agent',grants:[]}},await importSigningKey(owner.signing.privateKey));
  expect((await verifyLog([...entries,agentEntry])).ok).toBe(true);
  const encryptedEntry = await cipherLog(key,id,agentEntry);
  const approval = {principal:owner.principal,code,scope:'readwrite',expiresAt:Date.now()+3600_000,wrap:agentWrap.ciphertext,entry:encryptedEntry};
  expect((await request('/v1/agent-sessions/'+sessionId+'/approve','POST',{...approval,code:code === '000000' ? '999999' : '000000'}, {Cookie:owner.cookie})).status).toBe(400);
  expect((await request('/v1/agent-sessions/'+sessionId+'/approve','POST',{...approval,expiresAt:Date.now()+9*3600_000}, {Cookie:owner.cookie})).status).toBe(400);
  const unverified = await account(owner.email);
  expect((await request('/v1/agent-sessions/'+sessionId+'/approve','POST',approval, {Cookie:unverified.cookie})).status).toBe(401);
  expect((await request('/v1/agent-sessions/'+sessionId+'/approve','POST',approval, {Cookie:owner.cookie})).status).toBe(200);
  const path='/v1/journeys/'+id+'/seq';
  const headers = await agentHeaders(sessionId,bot.privateKey,'POST',path,{});
  const allocated = await request(path,'POST',{},headers);
  expect(allocated.status).toBe(200);
  const {seq} = await allocated.json() as {seq:number};
  expect((await request(path,'POST',{},headers)).status).toBe(401);
  const envelope = await seal({type:'item',typeVersion:1,body:{title:'Bot entry'}},{id:newId(),journey:id,seq,epoch:1,createdAt:new Date().toISOString()},key);
  const recordPath = '/v1/journeys/'+id+'/records';
  const written = await request(recordPath,'POST',{envelope},await agentHeaders(sessionId,bot.privateKey,'POST',recordPath,{envelope}));
  expect(written.status).toBe(201);
  const read = await request(recordPath,'GET',undefined,await agentHeaders(sessionId,bot.privateKey,'GET',recordPath));
  expect((await read.json() as {records:typeof envelope[]}).records).toEqual([envelope]);
  const stale = await agentHeaders(sessionId,bot.privateKey,'POST',path,{},newId(),String(Date.now()-61_000));
  expect((await request(path,'POST',{},stale)).status).toBe(401);
  const stranger = await createSigningIdentity();
  expect((await request(path,'POST',{},await agentHeaders(sessionId,stranger.privateKey,'POST',path,{}))).status).toBe(401);
  const signed = await agentHeaders(sessionId,bot.privateKey,'GET','/v1/journeys/'+id+'/wraps/me');
  expect((await request('/v1/journeys/'+id+'/wraps/me','GET',undefined,signed)).status).toBe(200);
  expect((await request('/v1/auth/passkey/register/options','POST',{},signed)).status).toBe(401);
  const logPath = '/v1/journeys/'+id+'/log';
  const agentChange = {entry:encryptedEntry,accessChanges:[{principal:owner.principal,action:'remove',kind:'person',scope:'readwrite'}]};
  expect((await request(logPath,'POST',agentChange,await agentHeaders(sessionId,bot.privateKey,'POST',logPath,agentChange))).status).toBe(403);
  const agentRotation = {entry:encryptedEntry,wraps:[{principal:owner.principal,epoch:2,wrap:agentWrap.ciphertext}],epoch:2};
  expect((await request(logPath,'POST',agentRotation,await agentHeaders(sessionId,bot.privateKey,'POST',logPath,agentRotation))).status).toBe(403);
  const agentMemberWrap = {entry:encryptedEntry,memberWraps:[{principal:agentPrincipal,epoch:1,wrap:agentWrap.ciphertext}]};
  expect((await request(logPath,'POST',agentMemberWrap,await agentHeaders(sessionId,bot.privateKey,'POST',logPath,agentMemberWrap))).status).toBe(403);
  expect((await request(logPath,'GET',undefined,await agentHeaders(sessionId,bot.privateKey,'GET',logPath))).status).toBe(200);
  // The server cannot read or validate this log entry; a person can still revoke an agent they added.
  expect((await request(logPath,'POST',{entry:encryptedEntry,accessChanges:[{principal:agentPrincipal,action:'remove',kind:'agent',scope:'readwrite'}]},as(owner))).status).toBe(201);
  expect((await request(recordPath,'GET',undefined,await agentHeaders(sessionId,bot.privateKey,'GET',recordPath))).status).toBe(403);
  const rows = await (await request('/v1/admin/registry','GET',undefined,{Authorization:'Bearer test-admin'})).json() as {registry:{id:string,memberCount:number}[]};
  expect(rows.registry.find(row => row.id === id)?.memberCount).toBe(1);
});

it('forbids a person from removing another person’s agent even if the claimed kind is person', async () => {
  const owner = await person('agent-owner@example.org');
  const guest = await person('agent-guest@example.org');
  const {id} = await journey(owner);
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  expect((await request('/v1/journeys/'+id+'/invites','POST',{inviteIdHash:await digest(secret),expiresAt:Date.now()+60_000},as(owner))).status).toBe(201);
  expect((await request('/v1/invites/accept','POST',{inviteId:secret,principal:{id:guest.principal,recipient:guest.age.recipient,signingKey:guest.signing.publicKey}},{Cookie:guest.cookie})).status).toBe(200);
  const path = '/v1/journeys/'+id+'/log';
  expect((await request(path,'POST',{entry:'YWJjZA==',accessChanges:[{principal:guest.principal,action:'add',kind:'person',scope:'readwrite'}]},as(owner))).status).toBe(201);
  const bot = await createSigningIdentity();
  const age = await createAgeIdentity();
  const started = await request('/v1/agent-sessions','POST',{journeyId:id,agentPublicKey:{recipient:age.recipient,signingKey:bot.publicKey},requestedScope:'readwrite'});
  expect(started.status).toBe(201);
  const {id:sessionId,code} = await started.json() as {id:string,code:string};
  const approved = await request('/v1/agent-sessions/'+sessionId+'/approve','POST',{code,principal:owner.principal,scope:'readwrite',expiresAt:Date.now()+3_600_000,wrap:'YWJjZA==',entry:'YWJjZA=='},{Cookie:owner.cookie});
  expect(approved.status).toBe(200);
  const {principal:agentPrincipal} = await (await request('/v1/agent-sessions/'+sessionId)).json() as {principal:string};
  expect((await request(path,'POST',{entry:'YWJjZA==',accessChanges:[{principal:agentPrincipal,action:'remove',kind:'person',scope:'readwrite'}]},as(guest))).status).toBe(403);
});

it('allows a person to remove themselves from a journey', async () => {
  const owner = await person('self-removal@example.org');
  const {id} = await journey(owner);
  const path = '/v1/journeys/'+id+'/log';
  expect((await request(path,'POST',{entry:'YWJjZA==',accessChanges:[{principal:owner.principal,action:'remove',kind:'person',scope:'readwrite'}]},as(owner))).status).toBe(201);
  expect((await request(path,'GET',undefined,as(owner))).status).toBe(403);
});

it('requires passkey verification again after a later email sign-in', async () => {
  const owner = await person('returning@example.org');
  const {id} = await journey(owner);
  const next = await account(owner.email);
  expect((await request('/v1/journeys/'+id+'/records','GET',undefined,{'Cookie':next.cookie,'X-Principal':owner.principal})).status).toBe(401);
  const options = await request('/v1/auth/passkey/login/options','POST',{}, {Cookie:next.cookie});
  expect(options.status).toBe(200);
  const {challenge} = await options.json() as {challenge:string};
  const assertion = await owner.device.login(challenge);
  expect((await request('/v1/auth/passkey/login/verify','POST',{response:assertion},{Cookie:next.cookie})).status).toBe(200);
  expect((await request('/v1/journeys/'+id+'/records','GET',undefined,{'Cookie':next.cookie,'X-Principal':owner.principal})).status).toBe(200);
  expect((await request('/v1/auth/passkey/login/verify','POST',{response:assertion},{Cookie:next.cookie})).status).toBe(401);
  expect((await request('/v1/auth/logout','POST',{}, {Cookie:next.cookie})).status).toBe(200);
  expect((await request('/v1/journeys/'+id+'/records','GET',undefined,{'Cookie':next.cookie,'X-Principal':owner.principal})).status).toBe(401);
});

it('rejects oversized records, wrong journey metadata, stale reservations and foreign write attempts', async () => {
  const owner = await person('limits@example.org');
  const {id,key} = await journey(owner);
  const second = await person('stranger@example.org');
  const {id:otherId} = await journey(second);
  const {seq} = await (await request('/v1/journeys/'+id+'/seq','POST',{},as(owner))).json() as {seq:number};
  const envelope = await seal({type:'item',typeVersion:1,body:{note:'private'}},{id:newId(),journey:id,epoch:1,seq,createdAt:new Date().toISOString()},key);
  expect((await request('/v1/journeys/'+otherId+'/records','POST',{envelope},as(owner))).status).toBe(400);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope},as(second))).status).toBe(403);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope:{...envelope,outside:{...envelope.outside,size:1048577}}},as(owner))).status).toBe(413);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope:{...envelope,outside:{...envelope.outside,secret:'visible'}}},as(owner))).status).toBe(400);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope:{...envelope,outside:{...envelope.outside,seq:seq+1}}},as(owner))).status).toBe(409);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope},as(owner))).status).toBe(201);
  const archive = await request('/v1/journeys/'+id+'/export','GET',undefined,as(owner));
  expect(archive.status).toBe(200);
  expect((await archive.json() as {envelopes:unknown[]}).envelopes).toEqual([envelope]);
});

it('expires access for a principal and refuses writes or reads after expiry', async () => {
  const owner = await person('expiry-owner@example.org');
  const guest = await person('expiry-guest@example.org');
  const {id,key} = await journey(owner);
  const invite = base64url(crypto.getRandomValues(new Uint8Array(32)));
  expect((await request('/v1/journeys/'+id+'/invites','POST',{inviteIdHash:await digest(invite),expiresAt:Date.now()+60000},as(owner))).status).toBe(201);
  expect((await request('/v1/invites/accept','POST',{inviteId:invite,principal:{id:guest.principal,recipient:guest.age.recipient,signingKey:guest.signing.publicKey}},{Cookie:guest.cookie})).status).toBe(200);
  const until=Date.now()+1100;
  const memberWrap=(await wrapJourneyKey(key,[{id:guest.principal,recipient:guest.age.recipient}]))[0]!;
  expect((await request('/v1/journeys/'+id+'/log','POST',{entry:'YWJjZA==',accessChanges:[{principal:guest.principal,action:'add',kind:'person',scope:'readwrite',expiresAt:until}],memberWraps:[{principal:guest.principal,epoch:1,wrap:memberWrap.ciphertext}]},as(owner))).status).toBe(201);
  expect((await request('/v1/journeys/'+id+'/seq','POST',{},as(guest))).status).toBe(200);
  await new Promise(resolve => setTimeout(resolve, 1200));
  expect((await request('/v1/journeys/'+id+'/seq','POST',{},as(guest))).status).toBe(403);
  expect((await request('/v1/journeys/'+id+'/records','GET',undefined,as(guest))).status).toBe(403);
});

it('applies the independent per-IP budget to different emails', async () => {
  sent=[];
  for(let i=0;i<12;i++) expect((await request('/v1/auth/email/start','POST',{email:'ip-'+i+'@example.org'})).status).toBe(202);
  expect(sent).toHaveLength(10);
});

it('does not let a fresh email link replace an existing passkey without the old passkey', async () => {
  const owner = await person('existing@example.org');
  const next = await account(owner.email);
  expect((await request('/v1/auth/passkey/register/options','POST',{}, {Cookie:next.cookie})).status).toBe(403);
});

it('accepts sequence cursors beyond the first thousand records', async () => {
  const owner = await person('cursor@example.org');
  const {id} = await journey(owner);
  expect((await request('/v1/journeys/'+id+'/records?after=1001','GET',undefined,as(owner))).status).toBe(200);
  expect((await request('/v1/journeys/'+id+'/log?after=1001','GET',undefined,as(owner))).status).toBe(200);
});

it('rejects a magic link after its 15-minute lifetime', async () => {
  const initial=Date.now();
  const started=await request('/v1/auth/email/start','POST',{email:'old-link@example.org'});
  expect(started.status).toBe(202);
  const token=/#token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)!)![1]!;
  try {
    vi.useFakeTimers(); vi.setSystemTime(initial+16*60_000);
    expect((await request('/v1/auth/email/verify','POST',{token})).status).toBe(401);
  } finally { vi.useRealTimers(); }
});

it('does not create an invitation beyond seven days or accept an unknown secret', async () => {
  const owner = await person('invite-limit@example.org');
  const guest = await person('invite-guest@example.org');
  const {id} = await journey(owner);
  const secret=base64url(crypto.getRandomValues(new Uint8Array(32)));
  expect((await request('/v1/journeys/'+id+'/invites','POST',{inviteIdHash:await digest(secret),expiresAt:Date.now()+8*86400000},as(owner))).status).toBe(400);
  expect((await request('/v1/invites/accept','POST',{inviteId:secret,principal:{id:guest.principal,recipient:guest.age.recipient,signingKey:guest.signing.publicKey}},{Cookie:guest.cookie})).status).toBe(404);
});

it('offers registration again when the first email link was verified but no passkey was added', async () => {
  const initial=await account('unfinished@example.org');
  const second=await account(initial.email);
  expect(second.challenge).toBe('register');
  expect((await request('/v1/auth/email/verify','POST',{token:second.token})).status).toBe(401);
  const options = await request('/v1/auth/passkey/register/options','POST',{}, {Cookie:second.cookie});
  expect(options.status).toBe(200);
});

it('accepts a record at the exact 1 MiB plaintext boundary', async () => {
  const owner = await person('boundary@example.org');
  const {id,key} = await journey(owner);
  const {seq} = await (await request('/v1/journeys/'+id+'/seq','POST',{},as(owner))).json() as {seq:number};
  const base = {type:'item',typeVersion:1,body:{data:''}};
  const overhead = new TextEncoder().encode(JSON.stringify(base)).length;
  const envelope = await seal({type:'item',typeVersion:1,body:{data:'A'.repeat(1048576-overhead)}},{id:newId(),journey:id,seq,epoch:1,createdAt:new Date().toISOString()},key);
  expect(envelope.outside.size).toBe(1048576);
  expect((await request('/v1/journeys/'+id+'/records','POST',{envelope},as(owner))).status).toBe(201);
});

it('keeps the operator registry closed when its secret is absent', async () => {
  const response = await request('/v1/admin/registry','GET',undefined,{}, {ADMIN_TOKEN:undefined});
  expect(response.status).toBe(401);
});

it('fails closed rather than hashing addresses with a missing key', async () => {
  const response=await request('/v1/auth/email/start','POST',{email:'no-key@example.org'},{},{EMAIL_HASH_KEY:undefined});
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({error:{code:'internal'}});
  expect(sent).toHaveLength(0);
});

it('serves the single-page app from the Worker assets binding', async () => {
  const response = await request('/');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
});
