import { expect } from 'vitest';
import { createAgeIdentity, createSigningIdentity, importSigningKey, newId, hashEntry, signEntry, verifyLog } from '../src/index.js';
import type { LogEntry, Member, ControlProof, Envelope, JsonObject, ArtifactActionType, ProjectActionType } from '../src/index.js';
import { generateJourneyKey, hashControlProof, sealControlLabels, sealArtifactPayload, signControlProof, verifyControlProofs, isArtifactAction, artifactTypeHash, isProjectAction, sealProjectPayload } from '../src/index.js';
export async function person() {
  const sign = await createSigningIdentity(), age = await createAgeIdentity();
  return { member: { id: newId(), kind: 'person', recipient: age.recipient, signingKey: sign.publicKey } as Member, key: await importSigningKey(sign.privateKey), identity: age.identity };
}
export async function agent(owner: string, scope: 'read' | 'readwrite' = 'readwrite') {
  const p = await person(); p.member = { id: p.member.id, kind: 'agent', recipient: p.member.recipient, signingKey: p.member.signingKey, addedBy: owner, scope }; return p;
}
export async function genesis(p: Awaited<ReturnType<typeof person>>, minimum = '0.1.5') {
  return [await signEntry({ v: 1, seq: 0, prev: null, at: '2026-01-01T00:00:00.000Z', actor: p.member.id, type: 'genesis', body: { journey: newId(), name: 'Journey', description: 'Private', creator: p.member, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: minimum } }, p.key)];
}
export async function append(entries: LogEntry[], p: Awaited<ReturnType<typeof person>>, type: string, body: LogEntry['body']) {
  return [...entries, await signEntry({ v: 1, seq: entries.length, prev: await hashEntry(entries.at(-1)!), at: '2026-01-02T00:00:00.000Z', actor: p.member.id, type, body }, p.key)];
}
export async function state(entries: LogEntry[]) { const v = await verifyLog(entries); if (!v.ok) throw Error(v.error.message); return v.state; }
export async function rejected(entries: LogEntry[], code?: string) { const v = await verifyLog(entries); expect(v.ok).toBe(false); if (!v.ok && code) expect(v.error.code).toBe(code); }
export const settings = { name: 'Changed', description: 'New description', defaultRole: 'read-only', visibility: 'private', joiningPolicy: 'invitation-only' };

/** Signed public-chain fixture; legacy regression helpers above remain unchanged. */
export async function artifactFixture(minimum = '0.1.5') {
  const guide = await person(), key = generateJourneyKey(), journey = newId();
  const f = { guide, key, journey, controls: [] as { proof: ControlProof; envelope: Envelope }[], trust: { journey, creator: guide.member } };
  await artifactAppend(f, guide, 'genesis', { journey, name: 'Secret journey', description: 'Private description', creator: guide.member, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: minimum });
  return f;
}
export type ArtifactFixture = Awaited<ReturnType<typeof artifactFixture>>;
export const documentPayload = () => ({ title: 'Secret title', tags: ['Note', 'note'], content: { kind: 'document', markdown: 'Private Markdown' }, attachments: [] });
export async function artifactBody(actor: string, overrides: JsonObject = {}): Promise<JsonObject> {
  return { format: 'artifact-v1', artifact: newId(), version: newId(), author: actor, actor, typeHash: await artifactTypeHash('document'), blobs: [], ...overrides };
}
export async function artifactAppend(f: ArtifactFixture, actor: Awaited<ReturnType<typeof person>>, type: string, body: JsonObject, payload: JsonObject = documentPayload(), at = '2026-01-02T00:00:00.000Z') {
  const entry = { v: 1 as const, seq: f.controls.length, prev: f.controls.length ? await hashControlProof(f.controls.at(-1)!.proof) : null, at, actor: actor.member.id, type, body };
  const outside = { id: newId(), journey: f.journey, seq: entry.seq, epoch: f.key.epoch, createdAt: at };
  const envelope = isProjectAction(type) ? await sealProjectPayload(type as ProjectActionType, body, payload, outside, f.key) : isArtifactAction(type) ? await sealArtifactPayload(type as ArtifactActionType, body, payload, outside, f.key) : await sealControlLabels(entry, outside, f.key);
  const control = { proof: await signControlProof(entry, envelope, f.journey, actor.key), envelope };
  f.controls.push(control);
  return control;
}
export const artifactResult = (f: ArtifactFixture, keyed = true) => verifyControlProofs(f.controls.map(c => c.proof), f.controls.map(c => c.envelope), f.trust, keyed ? [f.key] : []);
