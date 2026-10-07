import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { PrivateVault, artifactTypeHash, canonical, decodeVaultWire, encodeVaultPatch, importSigningKey, memberVaultId, newId, newPrivateId, privateAuthority, privateAuthorityHistory, privateHash, privateIdentity, privatePersonSession, signPrivateRecord, verifyPrivateContext } from '@ai-wayfinding/core';
import type { Member, PrivateBundle } from '@ai-wayfinding/core';
import { JourneyClient } from '../src/journey.js';
import { openPersonPrivateVault } from '../src/private-store.js';
import { saveState } from '../src/state.js';
import { as, change, connected, journey, person, refresh, request, root, scratch } from './local-server.js';

export const cli = join(root, 'packages/client/dist/cli.js');
export const execute = promisify(execFile);
/** Same person vault/agent delivery adapter used by the browser; real workerd transport. */
export async function privateFixture() {
  const owner = await person(), trip = await journey(owner);
  await change(trip, owner, 'client.minVersion', { version: '0.1.7' });
  const agent = await connected(owner, trip);
  await refresh(trip, owner);
  const context = await verifyPrivateContext({ journey: trip.id, creator: trip.entries[0]!.proof.body.creator as Member, controls: trip.entries }, { now: Date.now(), currentHead: await privateHash(trip.entries.at(-1)!.proof) });
  const author = privateIdentity({ id: owner.principal, kind: 'person', signingKey: owner.signing.publicKey, recipient: owner.age.recipient });
  const signingKey = await importSigningKey(owner.signing.privateKey);
  const session = await privatePersonSession(context, author, signingKey, owner.age.identity);
  const vaultId = await memberVaultId(trip.id, owner.principal, author.signingKey, author.recipient);
  let time = 0;
  const path = `/v1/journeys/${trip.id}/private-vault`;
  const controller = await openPersonPrivateVault({ trust: { vault: vaultId, author }, identity: owner.age.identity, signingKey, contexts: [context], sessions: [session], now: () => time,
    transport: {
      read: async indices => { const response = await request(path + '?slots=' + (indices === 'all' ? 'all' : indices.map(i => String(i).padStart(2, '0')).join(',')), 'GET', undefined, as(owner)); if (!response.ok) throw new Error('Person vault read failed: ' + response.status); return decodeVaultWire(new Uint8Array(await response.arrayBuffer()), indices); },
      commit: async patch => { const response = await fetch('http://localhost:18787' + path, { method: 'PUT', headers: { ...as(owner), Origin: 'http://localhost:18787', 'X-Wayfinding': '1', 'Content-Type': 'application/octet-stream', 'X-Client-Version': '0.1.7', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Project-Format': 'project-v1', 'X-Private-Format': 'private-v1' }, body: new Uint8Array(encodeVaultPatch(patch)) }); if (!response.ok) throw new Error('Person vault commit failed: ' + response.status); return response.json() as Promise<{ token: string }>; }
    }
  }, context, { agents: async () => [trip.entries.at(-1)!.proof.body.member as Member], put: async (id, ciphertext) => { const response = await request(`/v1/journeys/${trip.id}/private-agent-wrap/${id}`, 'PUT', { ciphertext }, as(owner)); if (!response.ok) throw new Error('Person wrap delivery failed: ' + response.status); } });
  const copy = newPrivateId(), payload = { type: 'artifact.content', typeVersion: 1, body: { title: 'PERSON PRIVATE CANARY', tags: [], content: { kind: 'document', markdown: 'PERSON PRIVATE BODY' }, attachments: [] } };
  const record = await signPrivateRecord({ format: 'private-v1', v: 1, id: newId(), vault: vaultId, copy, seq: 0, prev: null, at: new Date().toISOString(), actor: author, authority: privateAuthority(context, author), type: 'private.create', body: { artifact: newPrivateId(), author: { kind: author.kind, signingKey: author.signingKey, recipient: author.recipient }, actor: { kind: author.kind, signingKey: author.signingKey, recipient: author.recipient }, version: newId(), typeHash: await artifactTypeHash('document'), blobs: [], predecessor: null }, payloadHash: await privateHash(payload) }, signingKey);
  const bundle: PrivateBundle = { format: 'private-v1', version: 1, vault: vaultId, author, scope: 'author-backup', authorityHistories: [privateAuthorityHistory(context)], records: [record], payloads: [{ record: record.id, payload }], copyKeys: [{ copy, key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') }], blobs: [], unavailableDeletedBlobs: [] };
  await controller.stage(bundle); time = 300_000; await controller.tick(); controller.close();
  const state = join(scratch, 'private-agent-' + newId() + '.json'), cache = join(scratch, 'private-cache-' + newId());
  const createdAt = Date.now();
  await saveState(state, { status: 'approved', session: agent.session, link: 'http://localhost:18787/agent-sessions/' + agent.session.sessionId, code: '000000', createdAt, expiresAt: agent.session.expiresAt });
  agent.close();
  return { owner, trip, copy, bundle, state, cache };
}
