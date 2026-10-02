import { describe, expect, it, vi } from 'vitest';
import { createAgeIdentity, createSigningIdentity, generateJourneyKey, hashControlProof, importSigningKey, newId, sealControlLabels, signControlProof, wrapJourneyKey, type ControlProof, type Envelope, type JsonObject } from '@ai-wayfinding/core';
import { JourneyClient } from '../src/journey.js';
import type { RememberedAgent } from '../src/storage.js';

async function fixture(scope: 'read' | 'readwrite' = 'readwrite') {
  const journeyId = newId(), principal = newId(), ownerId = newId();
  const ownerAge = await createAgeIdentity(), ownerSign = await createSigningIdentity();
  const agentAge = await createAgeIdentity(), agentSign = await createSigningIdentity();
  const key = generateJourneyKey();
  const controls: { seq: number; proof: ControlProof; envelope: Envelope }[] = [];
  async function append(type: string, body: JsonObject) {
    const entry = { v: 1 as const, seq: controls.length, prev: controls.length ? await hashControlProof(controls.at(-1)!.proof) : null, at: new Date().toISOString(), actor: ownerId, type, body };
    const envelope = await sealControlLabels(entry, { id: newId(), journey: journeyId, seq: entry.seq, epoch: 1, createdAt: entry.at }, key);
    controls.push({ seq: entry.seq, envelope, proof: await signControlProof(entry, envelope, journeyId, await importSigningKey(ownerSign.privateKey)) });
  }
  await append('genesis', { journey: journeyId, name: 'Test journey', creator: { id: ownerId, kind: 'person', recipient: ownerAge.recipient, signingKey: ownerSign.publicKey }, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: '0.1.4' });
  await append('member.add', { member: { id: principal, kind: 'agent', recipient: agentAge.recipient, signingKey: agentSign.publicKey, scope, addedBy: ownerId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, grants: [], kind: 'agent' });
  const wrap = (await wrapJourneyKey(key, [{ id: principal, recipient: agentAge.recipient }]))[0]!;
  const session: RememberedAgent = { server: 'https://app.wayfinding.support', journeyId, sessionId: newId(), principal, identity: agentAge.identity, recipient: agentAge.recipient, signingPrivateKey: agentSign.privateKey, signingKey: agentSign.publicKey, scope, expiresAt: Date.now() + 3_600_000 };
  const requests: string[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    requests.push((init?.method ?? 'GET') + ' ' + path);
    if (path.endsWith('/protocol')) return Response.json({ minClientVersion: '0.1.4', controlFormat: 'control-proof-v1' });
    if (path.endsWith('/wraps/me')) return Response.json({ wraps: [{ epoch: 1, wrap: wrap.ciphertext }] });
    if (path.endsWith('/log')) return Response.json({ log: controls });
    if (path.endsWith('/records')) return Response.json({ records: [] });
    if (path.endsWith('/seq')) return Response.json({ seq: 1, epoch: 1 });
    return Response.json({ status: 'created' }, { status: 201 });
  });
  return { session, controls, append, ownerId, fetcher, requests };
}

describe('journey client guard', () => {
  it('refuses a forged control before making a write request', async () => {
    const f = await fixture(); f.controls[1]!.proof.body.kind = 'person';
    await expect(new JourneyClient(f.session, { fetch: f.fetcher }).add({ type: 'note', title: 'No', body: 'No', tags: [] })).rejects.toThrow(/verified|history/i);
    expect(f.requests.some(value => value.startsWith('POST '))).toBe(false);
  });
  it('refuses removed agents despite remembered scope and old wraps', async () => {
    const f = await fixture(); await f.append('member.remove', { member: f.session.principal });
    await expect(new JourneyClient(f.session, { fetch: f.fetcher }).add({ type: 'note', title: 'No', body: 'No', tags: [] })).rejects.toThrow('Access to this journey has ended');
    expect(f.requests.some(value => value.startsWith('POST '))).toBe(false);
  });
  it('fails closed with an update message for unsupported controls and newer signed minimum', async () => {
    const f = await fixture(); f.controls[1]!.proof.type = 'future.control';
    await expect(new JourneyClient(f.session, { fetch: f.fetcher }).list()).rejects.toThrow('npm install -g @ai-wayfinding/client@latest');
    const newer = await fixture(); await newer.append('client.minVersion', { version: '0.1.8' });
    await expect(new JourneyClient(newer.session, { fetch: newer.fetcher }).add({ type: 'note', title: 'No', body: 'No', tags: [] })).rejects.toThrow('newer format');
    expect(newer.requests.some(value => value.startsWith('POST '))).toBe(false);
  });
  it('refuses read-only writes before reservation', async () => {
    const f = await fixture('read');
    await expect(new JourneyClient(f.session, { fetch: f.fetcher }).add({ type: 'note', title: 'No', body: 'No', tags: [] })).rejects.toThrow('read-only');
    expect(f.requests.some(value => value.startsWith('POST '))).toBe(false);
  });
});
