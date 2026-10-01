import { env } from 'cloudflare:test';
import { beforeEach, expect } from 'vitest';
import { createAgeIdentity, createSigningIdentity, generateJourneyKey, importSigningKey, newId, sealControlLabels, signControlProof, signEntry, wrapJourneyKey, type JourneyKey, type LogEntry } from '@ai-wayfinding/core';
import worker, { type Env } from '../src/index.js';
import { authenticator } from './authenticator.js';
import { base64url } from '../src/crypto.js';
const testSigners = new Map<string,string>();
const origin = 'https://app.wayfinding.support';
export const testSealed = () => ({ version: 1, identity: base64url(crypto.getRandomValues(new Uint8Array(96))), signing: base64url(crypto.getRandomValues(new Uint8Array(96))) });
export let sent: string[] = [];
let ip = 1;
export function resetSent() { sent = []; }
beforeEach(() => { sent = []; ip++; });
export async function request(path: string, method = 'GET', body?: object, extra: Record<string, string> = {}, overrides: Partial<Env> = {}) {
  return worker.fetch(new Request(origin + path, { method, headers: { Origin: origin, 'X-Wayfinding': '1', 'Content-Type': 'application/json', 'X-Client-Version':'0.1.4', 'X-Control-Format':'control-proof-v1', 'CF-Connecting-IP': '198.51.100.' + ip, ...extra }, body: body && JSON.stringify(body) }), { ...env, RP_ID: 'app.wayfinding.support', ORIGIN: origin, EMAIL_HASH_KEY: 'test-key', ADMIN_TOKEN: 'test-admin', AGENT_SESSION_RATE: { limit: async () => ({ success: true }) }, MAGIC_EMAIL: { send: async message => { sent.push('text' in message ? message.text ?? '' : ''); return { messageId: 'test' }; } }, ...overrides } as Env);
}
export async function account(email: string) {
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
export async function person(email: string) {
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
  const signing = await createSigningIdentity();
  const principal = newId();
  testSigners.set(principal, signing.privateKey);
  return { ...a, device, age: await createAgeIdentity(), signing, principal };
}
export async function cipherLog(key: JourneyKey, id: string, entry: LogEntry) {
  const envelope = await sealControlLabels(entry, {id:newId(),journey:id,seq:entry.seq,epoch:key.epoch,createdAt:new Date().toISOString()},key);
  return { proof: await signControlProof(entry,envelope,id,await importSigningKey(testSigners.get(entry.actor)!)), envelope };
}
export async function journey(owner: Awaited<ReturnType<typeof person>>) {
  const key = generateJourneyKey();
  const id = newId();
  const genesis = await signEntry({v:1,seq:0,prev:null,at:new Date().toISOString(),actor:owner.principal,type:'genesis',body:{journey:id,name:'Shared space',creator:{id:owner.principal,kind:'person',recipient:owner.age.recipient,signingKey:owner.signing.publicKey},grants:['members.manage'],mode:'sealed',visibility:'private',minClientVersion:'0.1.4'}},await importSigningKey(owner.signing.privateKey));
  const recovery = await createAgeIdentity();
  const recoveryWrap = (await wrapJourneyKey(key,[{id:'recovery',recipient:recovery.recipient}]))[0]!.ciphertext;
  const control = await cipherLog(key,id,genesis);
  const create = await request('/v1/journeys','POST',{id,name:'Shared space',creatorEmail:'spoofed@example.org',creator:{id:owner.principal,recipient:owner.age.recipient,signingKey:owner.signing.publicKey},control,wraps:(await wrapJourneyKey(key,[{id:owner.principal,recipient:owner.age.recipient}])).map(w=>({principal:w.recipient,epoch:w.epoch,wrap:w.ciphertext})),recoveryWrap,minClientVersion:'0.1.4'},{Cookie:owner.cookie});
  expect(create.status).toBe(201);
  expect((await create.json() as {id:string}).id).toBe(id);
  return {id,key,entries:[genesis],controls:[control]};
}
export const as = (p: {cookie:string,principal:string}) => ({ Cookie:p.cookie, 'X-Principal':p.principal });

