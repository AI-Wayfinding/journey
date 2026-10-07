import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect } from 'vitest';
import { join } from 'node:path';
import { PrivateVault, artifactTypeHash, canonical, decodeVaultWire, encodeVaultPatch, importSigningKey, memberVaultId, newId, newPrivateId, privateAuthority, privateAuthorityHistory, privateHash, privateIdentity, privatePersonSession, signPrivateRecord, verifyPrivateContext } from '@ai-wayfinding/core';
import type { Member, PrivateBundle } from '@ai-wayfinding/core';
import { JourneyClient } from '../src/journey.js';
import { openPersonPrivateVault } from '../src/private-store.js';
import { loadState, saveState } from '../src/state.js';
import { as, approve, change, connected, journey, person, refresh, request, root, scratch } from './local-server.js';

export const cli = join(root, 'packages/client/dist/cli.js');
export const execute = promisify(execFile);
/** Same person vault/agent delivery adapter used by the browser; real workerd transport. */
export async function privateFixture(populated = true, destination?: { owner: import('./local-server.js').Owner; trip: import('./local-server.js').Fixture; agentSession: import('../src/storage.js').RememberedAgent }) {
  const owner = destination?.owner ?? await person(), trip = destination?.trip ?? await journey(owner);
  if (!destination) await change(trip, owner, 'client.minVersion', { version: '0.1.7' });
  const agent = destination ? new JourneyClient(destination.agentSession) : await connected(owner, trip);
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
  if (populated) await controller.stage(bundle);
  time = 300_000; await controller.tick(); controller.close();
  const state = join(scratch, 'private-agent-' + newId() + '.json'), cache = join(scratch, 'private-cache-' + newId());
  const createdAt = Date.now();
  await saveState(state, { status: 'approved', session: agent.session, link: 'http://localhost:18787/agent-sessions/' + agent.session.sessionId, code: '000000', createdAt, expiresAt: agent.session.expiresAt });
  agent.close();
  return { owner, trip, copy, bundle, state, cache, agentSession: agent.session, vaultId };
}

/** Virtual scheduling is injected into the real CLI entry, not a replacement CLI.
 * Clock controls live on a loopback fixture port, never in the shipped tool schema. */
export async function clockedCli() {
  const path = join(scratch, 'clocked-cli-' + newId() + '.mjs');
  await writeFile(path, `import { createServer } from 'node:http';
import { main } from ${JSON.stringify(pathToFileURL(cli).href)};
let now = 0; const ticks = new Set();
const control = createServer(async (req, res) => {
  try { now = Number(new URL(req.url, 'http://localhost').searchParams.get('at')); for (const tick of ticks) await tick(); res.end('ok'); }
  catch (error) { res.writeHead(500); res.end(error.message); }
});
await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));
console.error('PRIVATE_CLOCK=' + control.address().port);
const args = process.argv.slice(2);
try { await main(args, { privateNow: () => now, privateSchedule: tick => { ticks.add(tick); return () => ticks.delete(tick); } }); }
catch (error) { console.error(error.message); process.exitCode = 1; }
if (args[0] !== 'mcp') control.close();
`);
  return path;
}
export async function privateMcp(state: string, cache: string, clock = false, paired?: string) {
  const entry = clock ? await clockedCli() : cli;
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp', '--state', state, '--private-cache', cache, ...(paired ? ['--paired', paired] : [])], stderr: 'pipe' });
  let port: number | undefined, errors = '';
  transport.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString(); port = Number(/PRIVATE_CLOCK=(\d+)/.exec(errors)?.[1]) || port; });
  const sdk = new Client({ name: 'stage3-private', version: '1.0.0' }); await sdk.connect(transport);
  return { sdk, errors: () => errors, advance: async (at: number) => {
    if (!port) throw new Error('Virtual clock not ready');
    const response = await fetch(`http://127.0.0.1:${port}/?at=${at}`);
    if (!response.ok) throw new Error(await response.text());
  }, close: () => sdk.close() };
}
export async function tool(sdk: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await sdk.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return JSON.parse((result.content as { text: string }[])[0]!.text);
}
export async function denyTool(sdk: Client, name: string, args: Record<string, unknown>, message: string): Promise<void> {
  const result = await sdk.callTool({ name, arguments: args });
  expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain(message);
  expect(JSON.stringify(result.content)).not.toContain('PERSON PRIVATE');
}
export async function command(state: string, cache: string, ...args: string[]): Promise<any> {
  return JSON.parse((await execute(process.execPath, [cli, ...args, '--state', state, '--private-cache', cache], { timeout: 90_000 })).stdout);
}
export async function agentState(session: import('../src/storage.js').RememberedAgent, origin = session.server) {
  const path = join(scratch, 'state-' + newId() + '.json');
  await saveState(path, { status: 'approved', session: { ...session, server: origin }, link: 'local', code: '123456', createdAt: Date.now(), expiresAt: session.expiresAt });
  return path;
}
/** Opaque byte-forwarding proxy preserves signing paths and body bytes. */
export async function privateProxy(transform?: (path: string, method: string, bytes: Buffer, status: number) => { bytes: Buffer; status?: number }) {
  let at = 0;
  const trace: { at: number; path: string; method: string; request: number; response: number; status: number; headers: Record<string, string | string[] | undefined> }[] = [];
  const forwarding = createServer(async (req, res) => {
    try {
      const path = req.url!, method = req.method!, chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
      const body = Buffer.concat(chunks), headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string' && !['host','connection','content-length'].includes(name)) headers.set(name, value);
      if (headers.has('origin')) headers.set('origin', 'http://localhost:18787');
      const response = await fetch('http://localhost:18787' + path, { method, headers, ...(body.length ? { body } : {}) });
      const raw = Buffer.from(await response.arrayBuffer()), changed = transform?.(path, method, raw, response.status);
      const bytes = changed?.bytes ?? raw, status = changed?.status ?? response.status;
      trace.push({ at, path, method, request: body.length, response: bytes.length, status, headers: req.headers });
      res.writeHead(status, { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream' }); res.end(bytes);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => forwarding.listen(0, '127.0.0.1', resolve));
  const address = forwarding.address(); if (!address || typeof address === 'string') throw new Error('No private proxy');
  return { origin: `http://127.0.0.1:${address.port}`, trace, time: (value: number) => { at = value; }, close: () => new Promise<void>(resolve => forwarding.close(() => resolve())) };
}

export async function privateDestination(source: Awaited<ReturnType<typeof privateFixture>>) {
  const trip = await journey(source.owner); await change(trip, source.owner, 'client.minVersion', { version: '0.1.7' });
  // The second approval has its own session/principal but deliberately admits
  // the same local key pair. No private grant or inferred destination binding.
  const response = await request('/v1/agent-sessions', 'POST', { journeyId: trip.id, agentPublicKey: { recipient: source.agentSession.recipient, signingKey: source.agentSession.signingKey }, remembered: false, keyStorage: 'file' });
  expect(response.status).toBe(201);
  const approval = await response.json() as { id: string; code: string; approvalUrl: string };
  await approve(source.owner, trip, approval.approvalUrl, approval.code);
  const admitted = await (await request('/v1/agent-sessions/' + approval.id)).json() as { principal: string; expiresAt: number };
  return privateFixture(false, { owner: source.owner, trip, agentSession: { ...source.agentSession, journeyId: trip.id, sessionId: approval.id, principal: admitted.principal, expiresAt: admitted.expiresAt } });
}
