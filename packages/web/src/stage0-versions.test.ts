import { afterEach, expect, it, vi } from 'vitest';
import { createAgeIdentity, createSigningIdentity, generateJourneyKey, hashControlProof, importSigningKey, newId, sealControlLabels, signControlProof, wrapJourneyKey, type Member, type JsonObject } from '@ai-wayfinding/core';
import { assertSupported, verifiedJourney, saveRecord, type SignedControl } from './journey.js';
import { UPDATE_REQUIRED } from './messages.js';
import type { PersonKeys } from './keys.js';
vi.mock('./keys.js', () => ({ getPersonKeys: () => keys, rememberJourneyKey: vi.fn() }));
let keys: PersonKeys;
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const age = await createAgeIdentity(), signing = await createSigningIdentity();
  keys = { identity: age.identity, recipient: age.recipient, signingKey: signing.publicKey, signingPrivateKey: await importSigningKey(signing.privateKey) };
  const id = newId(), principal = newId(), key = generateJourneyKey(), controls: SignedControl[] = [], requests: string[] = [];
  const creator: Member = { id: principal, kind: 'person', recipient: age.recipient, signingKey: signing.publicKey };
  async function append(type: string, body: JsonObject) {
    const entry = { v: 1 as const, seq: controls.length, prev: controls.length ? await hashControlProof(controls.at(-1)!.proof) : null, at: new Date().toISOString(), actor: principal, type, body };
    const envelope = await sealControlLabels(entry, { id: newId(), journey: id, seq: entry.seq, epoch: 1, createdAt: entry.at }, key);
    controls.push({ proof: await signControlProof(entry, envelope, id, keys.signingPrivateKey), envelope });
  }
  await append('genesis', { journey: id, name: 'Visible only after verification', creator, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: '0.1.4' });
  const wrap = (await wrapJourneyKey(key, [creator]))[0]!;
  let minimum = '0.1.4';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push((init?.method ?? 'GET') + ' ' + url);
    if (url.endsWith('/protocol')) return Response.json({ minClientVersion: minimum, controlFormat: 'control-proof-v1' });
    if (url.endsWith('/log')) return Response.json({ log: controls.map(c => ({ seq: c.proof.seq, ...c })) });
    if (url.endsWith('/wraps/me')) return Response.json({ wraps: [{ epoch: 1, wrap: wrap.ciphertext }] });
    return Response.json({});
  }));
  return { id, principal, controls, requests, append, minimum: (value: string) => { minimum = value; } };
}
it('requires browser update for newer protocol and unsupported control formats', () => {
  expect(() => assertSupported('0.1.6')).toThrow(UPDATE_REQUIRED);
  expect(() => assertSupported('0.1.4', 'future')).toThrow(UPDATE_REQUIRED);
});
it('uses signed minimum and never writes through an older browser context', async () => {
  const f = await fixture(), context = await verifiedJourney(f.id, f.principal, keys);
  await f.append('client.minVersion', { version: '0.1.6' });
  await expect(verifiedJourney(f.id, f.principal, keys)).rejects.toThrow(UPDATE_REQUIRED);
  await expect(saveRecord(context, { type: 'item', typeVersion: 1, body: {} })).rejects.toThrow(UPDATE_REQUIRED);
  expect(f.requests.some(r => r.includes('/seq') || r.includes('/records'))).toBe(false);
  f.minimum('0.1.6'); f.requests.length = 0;
  await expect(verifiedJourney(f.id, f.principal, keys)).rejects.toThrow(UPDATE_REQUIRED);
  expect(f.requests).toHaveLength(1);
});
it('does not render partial controls, trust forged labels, or migrate legacy rows', async () => {
  const f = await fixture(); f.controls[0]!.proof.type = 'future.control';
  await expect(verifiedJourney(f.id, f.principal, keys)).rejects.toThrow(UPDATE_REQUIRED);
  f.controls[0]!.proof.type = 'genesis'; f.controls[0]!.proof.body.name = 'Unsigned name';
  await expect(verifiedJourney(f.id, f.principal, keys)).rejects.toThrow('history could not be verified');
  vi.stubGlobal('fetch', async (url: string) => Response.json(url.endsWith('/protocol') ? { minClientVersion: '0.1.4', controlFormat: 'control-proof-v1' } : { log: [{ seq: 0, entry: 'legacy-encrypted-log' }] }));
  await expect(verifiedJourney(f.id, f.principal, keys)).rejects.toThrow('history could not be verified');
});
