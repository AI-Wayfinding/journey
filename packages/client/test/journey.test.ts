import { describe, expect, it, vi } from 'vitest';
import { createAgeIdentity, createSigningIdentity, generateJourneyKey, hashEntry, importSigningKey, newId, seal, signEntry, wrapJourneyKey } from '@ai-wayfinding/core';
import type { LogEntry } from '@ai-wayfinding/core';
import { JourneyClient } from '../src/journey.js';
import type { RememberedAgent } from '../src/storage.js';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function fixture(scope: 'read' | 'readwrite' = 'readwrite') {
  const journeyId = newId(), principal = newId(), ownerId = newId();
  const ownerAge = await createAgeIdentity(), ownerSign = await createSigningIdentity();
  const agentAge = await createAgeIdentity(), agentSign = await createSigningIdentity();
  const key = generateJourneyKey();
  const owner = { id: ownerId, kind: 'person' as const, recipient: ownerAge.recipient, signingKey: ownerSign.publicKey };
  const genesis = await signEntry({ v: 1, seq: 0, prev: null, at: new Date().toISOString(), actor: ownerId, type: 'genesis', body: { journey: journeyId, name: 'Test journey', creator: owner, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: '0.1.0' } }, await importSigningKey(ownerSign.privateKey));
  const member = { id: principal, kind: 'agent' as const, recipient: agentAge.recipient, signingKey: agentSign.publicKey, scope, addedBy: ownerId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const added = await signEntry({ v: 1, seq: 1, prev: await hashEntry(genesis), at: new Date().toISOString(), actor: ownerId, type: 'member.add', body: { member, grants: [], kind: 'agent' } }, await importSigningKey(ownerSign.privateKey));
  const entries: LogEntry[] = [genesis, added];
  const wrap = (await wrapJourneyKey(key, [{ id: principal, recipient: agentAge.recipient }]))[0]!;
  const session: RememberedAgent = { server: 'https://app.wayfinding.support', journeyId, sessionId: newId(), principal, identity: agentAge.identity, recipient: agentAge.recipient, signingPrivateKey: agentSign.privateKey, signingKey: agentSign.publicKey, scope, expiresAt: Date.now() + 3_600_000 };
  const requests: string[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    requests.push((init?.method ?? 'GET') + ' ' + path);
    if (path.endsWith('/wraps/me')) return Response.json({ wraps: [{ epoch: 1, wrap: wrap.ciphertext }] });
    if (path.endsWith('/log')) return Response.json({ log: await Promise.all(entries.map(async (entry, seq) => ({ seq, entry: encode(await seal({ type: 'membership', typeVersion: 1, body: entry }, { id: newId(), journey: journeyId, epoch: 1, createdAt: entry.at }, key)) }))) });
    if (path.endsWith('/records')) return Response.json({ records: [] });
    if (path.endsWith('/seq')) return Response.json({ seq: 1, epoch: 1 });
    return Response.json({ status: 'created' }, { status: 201 });
  });
  return { session, entries, key, ownerId, ownerSign, fetcher, requests };
}

describe('journey client guard', () => {
  it('refuses a write when a signed log entry is forged before requesting a record sequence', async () => {
    const f = await fixture();
    f.entries[1]!.body = { ...f.entries[1]!.body, kind: 'person' };
    const client = new JourneyClient(f.session, { fetch: f.fetcher });
    await expect(client.add({ type: 'note', title: 'Sensitive title', body: 'Sensitive body', tags: [] })).rejects.toThrow(/verified|history/i);
    expect(f.requests.some(value => value.includes('/seq'))).toBe(false);
  });
  it('refuses writes after a signed member removal even if a server still serves old wraps', async () => {
    const f = await fixture();
    const removal = await signEntry({ v: 1, seq: 2, prev: await hashEntry(f.entries[1]!), at: new Date().toISOString(), actor: f.ownerId, type: 'member.remove', body: { member: f.session.principal } }, await importSigningKey(f.ownerSign.privateKey));
    f.entries.push(removal);
    await expect(new JourneyClient(f.session, { fetch: f.fetcher }).add({ type: 'note', title: 'No', body: 'No', tags: [] })).rejects.toThrow('Access to this journey has ended');
    expect(f.requests.some(value => value.includes('/seq'))).toBe(false);
  });
  it('refuses read-only writes and a newer minimum client version', async () => {
    const readOnly = await fixture('read');
    await expect(new JourneyClient(readOnly.session, { fetch: readOnly.fetcher }).add({ type: 'note', title: 'No', body: 'No', tags: [] })).rejects.toThrow(/read.only/i);
    const newer = await fixture();
    newer.entries[0]!.body.minClientVersion = '999.0.0';
    await expect(new JourneyClient(newer.session, { fetch: newer.fetcher }).add({ type: 'note', title: 'No', body: 'No', tags: [] })).rejects.toThrow(/verified|newer/i);
  });
});
