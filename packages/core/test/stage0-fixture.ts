import { expect } from 'vitest';
import { createAgeIdentity, createSigningIdentity, importSigningKey, newId, hashEntry, signEntry, verifyLog } from '../src/index.js';
import type { LogEntry, Member } from '../src/index.js';
export async function person() {
  const sign = await createSigningIdentity(), age = await createAgeIdentity();
  return { member: { id: newId(), kind: 'person', recipient: age.recipient, signingKey: sign.publicKey } as Member, key: await importSigningKey(sign.privateKey), identity: age.identity };
}
export async function agent(owner: string, scope: 'read' | 'readwrite' = 'readwrite') {
  const p = await person(); p.member = { id: p.member.id, kind: 'agent', recipient: p.member.recipient, signingKey: p.member.signingKey, addedBy: owner, scope }; return p;
}
export async function genesis(p: Awaited<ReturnType<typeof person>>, minimum = '0.1.4') {
  return [await signEntry({ v: 1, seq: 0, prev: null, at: '2026-01-01T00:00:00.000Z', actor: p.member.id, type: 'genesis', body: { journey: newId(), name: 'Journey', description: 'Private', creator: p.member, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: minimum } }, p.key)];
}
export async function append(entries: LogEntry[], p: Awaited<ReturnType<typeof person>>, type: string, body: LogEntry['body']) {
  return [...entries, await signEntry({ v: 1, seq: entries.length, prev: await hashEntry(entries.at(-1)!), at: '2026-01-02T00:00:00.000Z', actor: p.member.id, type, body }, p.key)];
}
export async function state(entries: LogEntry[]) { const v = await verifyLog(entries); if (!v.ok) throw Error(v.error.message); return v.state; }
export async function rejected(entries: LogEntry[], code?: string) { const v = await verifyLog(entries); expect(v.ok).toBe(false); if (!v.ok && code) expect(v.error.code).toBe(code); }
export const settings = { name: 'Changed', description: 'New description', defaultRole: 'read-only', visibility: 'private', joiningPolicy: 'invitation-only' };
