import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgeIdentity, createSigningIdentity, generateJourneyKey, hashEntry, importSigningKey, newId, seal, signEntry, verifyLog, wrapJourneyKey, type JourneyKey, type LogEntry } from '@ai-wayfinding/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { authenticator } from '../../server/test/authenticator.js';
import { connectJourney } from '../src/connection.js';
import type { JourneyClient } from '../src/journey.js';

const root = resolve('../..'), server = 'http://localhost:18787';
const scratch = join(root, '.scratch', 'client-integration');
let worker: ChildProcess, workerOutput = '';
const headers = { Origin: server, 'X-Wayfinding': '1', 'Content-Type': 'application/json' };
async function request(path: string, method = 'GET', body?: object, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(server + path, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function ready(): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (worker.exitCode !== null) break;
    try { const result = await fetch(server + '/__test/email?address=health@example.org'); if (result.ok) return; } catch { /* waiting for workerd */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('The local journey server did not start: ' + workerOutput.slice(-3000));
}
beforeAll(async () => {
  await mkdir(scratch, { recursive: true });
  worker = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', join(root, 'packages/server/test/wrangler.jsonc'), '--port', '18787', '--local', '--persist-to', scratch], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout!.on('data', (value: Buffer) => { workerOutput = (workerOutput + value.toString()).slice(-8000); });
  worker.stderr!.on('data', (value: Buffer) => { workerOutput = (workerOutput + value.toString()).slice(-8000); });
  await ready();
}, 45_000);
afterAll(async () => { worker?.kill('SIGTERM'); await rm(scratch, { recursive: true, force: true }); });
async function person() {
  const email = ('owner-' + newId().slice(0, 12) + '@example.org').toLowerCase();
  expect((await request('/v1/auth/email/start', 'POST', { email })).status).toBe(202);
  const sent = await (await request('/__test/email?address=' + email)).json() as { text: string };
  const token = /#token=([A-Za-z0-9_-]+)/.exec(sent.text ?? '')?.[1];
  if (!token) throw new Error('No local approval email was delivered. Server log: ' + workerOutput.slice(-900));
  const verified = await request('/v1/auth/email/verify', 'POST', { token });
  expect(verified.status).toBe(200);
  const cookie = verified.headers.get('set-cookie')!.split(';')[0]!;
  const device = await authenticator('localhost', server);
  const options = await request('/v1/auth/passkey/register/options', 'POST', {}, { Cookie: cookie });
  expect(options.status).toBe(200);
  const { challenge } = await options.json() as { challenge: string };
  const ciphertext = () => Buffer.from(crypto.getRandomValues(new Uint8Array(96))).toString('base64url');
  const result = await request('/v1/auth/passkey/register/verify', 'POST', { response: device.register(challenge), sealed: { version: 1, identity: ciphertext(), signing: ciphertext() } }, { Cookie: cookie });
  expect(result.status).toBe(200);
  return { email, cookie, principal: newId(), age: await createAgeIdentity(), signing: await createSigningIdentity() };
}
type Owner = Awaited<ReturnType<typeof person>>;
const as = (owner: Owner) => ({ Cookie: owner.cookie, 'X-Principal': owner.principal });
async function cipherLog(key: JourneyKey, id: string, entry: LogEntry): Promise<string> {
  const envelope = await seal({ type: 'membership', typeVersion: 1, body: entry as unknown as { [key: string]: string | number | null } }, { id: newId(), journey: id, epoch: key.epoch, createdAt: entry.at }, key);
  return Buffer.from(JSON.stringify(envelope)).toString('base64url');
}
async function journey(owner: Owner) {
  const id = newId(), key = generateJourneyKey();
  const first = await signEntry({ v: 1, seq: 0, prev: null, at: new Date().toISOString(), actor: owner.principal, type: 'genesis', body: { journey: id, name: 'Journey test', creator: { id: owner.principal, kind: 'person', recipient: owner.age.recipient, signingKey: owner.signing.publicKey }, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: '0.1.0' } }, await importSigningKey(owner.signing.privateKey));
  const recovery = await createAgeIdentity();
  const recoveryWrap = (await wrapJourneyKey(key, [{ id: 'recovery', recipient: recovery.recipient }]))[0]!.ciphertext;
  const wraps = (await wrapJourneyKey(key, [{ id: owner.principal, recipient: owner.age.recipient }])).map(wrap => ({ principal: wrap.recipient, epoch: wrap.epoch, wrap: wrap.ciphertext }));
  const created = await request('/v1/journeys', 'POST', { id, name: 'Journey test', creatorEmail: owner.email, creator: { id: owner.principal, recipient: owner.age.recipient, signingKey: owner.signing.publicKey }, genesis: await cipherLog(key, id, first), wraps, recoveryWrap, minClientVersion: '0.1.0' }, { Cookie: owner.cookie });
  expect(created.status).toBe(201);
  return { id, key, entries: [first] };
}
type Fixture = Awaited<ReturnType<typeof journey>>;
async function approve(owner: Owner, trip: Fixture, url: string, code: string, scope: 'read' | 'readwrite' = 'readwrite'): Promise<void> {
  const sessionId = url.split('/').at(-1)!;
  const info = await (await request('/v1/agent-sessions/' + sessionId)).json() as { principal: string; recipient: string; signingKey: string };
  const expiresAt = Date.now() + 3_600_000;
  const member = { id: info.principal, kind: 'agent', recipient: info.recipient, signingKey: info.signingKey, addedBy: owner.principal, scope, expiresAt: new Date(expiresAt).toISOString() };
  const previous = trip.entries.at(-1)!;
  const entry = await signEntry({ v: 1, seq: trip.entries.length, prev: await hashEntry(previous), at: new Date().toISOString(), actor: owner.principal, type: 'member.add', body: { member, grants: [], kind: 'agent' } }, await importSigningKey(owner.signing.privateKey));
  expect((await verifyLog([...trip.entries, entry])).ok).toBe(true);
  const wrap = (await wrapJourneyKey(trip.key, [{ id: member.id, recipient: member.recipient }]))[0]!;
  const approved = await request('/v1/agent-sessions/' + sessionId + '/approve', 'POST', { code, principal: owner.principal, scope, expiresAt, wrap: wrap.ciphertext, entry: await cipherLog(trip.key, trip.id, entry) }, { Cookie: owner.cookie });
  expect(approved.status).toBe(200);
  trip.entries.push(entry);
}
async function connected(owner: Owner, trip: Fixture, scope: 'read' | 'readwrite' = 'readwrite'): Promise<JourneyClient> {
  let approval: Promise<void> | undefined;
  const connection = await connectJourney(trip.id, { server, scope, pollMs: 30, onApproval: (url, code) => { approval = approve(owner, trip, url, code, scope); } });
  await approval;
  return connection.client;
}

describe('real journey server in workerd', () => {
  it('approves an agent, adds, lists, searches, comments and reads; refuses read-only and removed agents', async () => {
    const owner = await person(), trip = await journey(owner), client = await connected(owner, trip);
    const added = await client.add({ type: 'resource', title: 'Visible journey title', body: 'Only in journey ciphertext', tags: ['journey'] });
    expect(added.authoredBy).toBe('agent');
    expect((await client.list()).map(item => item.id)).toContain(added.id);
    expect((await client.search('ciphertext')).map(item => item.id)).toContain(added.id);
    expect((await client.show(added.id)).item.title).toBe(added.title);
    expect((await client.comment(added.id, 'Journey comment')).authoredBy).toBe('agent');
    expect((await client.comments(added.id))[0]?.body).toBe('Journey comment');
    const reader = await connected(owner, trip, 'read');
    await expect(reader.add({ type: 'resource', title: 'Denied', body: 'no', tags: [] })).rejects.toThrow('read-only');
    reader.close();
    const last = trip.entries.at(-1)!;
    const removal = await signEntry({ v: 1, seq: trip.entries.length, prev: await hashEntry(last), at: new Date().toISOString(), actor: owner.principal, type: 'member.remove', body: { member: client.session.principal } }, await importSigningKey(owner.signing.privateKey));
    const removed = await request('/v1/journeys/' + trip.id + '/log', 'POST', { entry: await cipherLog(trip.key, trip.id, removal), accessChanges: [{ principal: client.session.principal, action: 'remove', kind: 'agent', scope: 'readwrite' }] }, as(owner));
    expect(removed.status).toBe(201);
    await expect(client.list()).rejects.toThrow('Access to this journey has ended');
    client.close();
  }, 30_000);
  it('refuses to write when a forged last history entry was appended by a server-side member', async () => {
    const owner = await person(), trip = await journey(owner), client = await connected(owner, trip);
    const stranger = await createSigningIdentity();
    const forged = await signEntry({ v: 1, seq: trip.entries.length, prev: await hashEntry(trip.entries.at(-1)!), at: new Date().toISOString(), actor: owner.principal, type: 'member.remove', body: { member: client.session.principal } }, await importSigningKey(stranger.privateKey));
    expect((await verifyLog([...trip.entries, forged])).ok).toBe(false);
    expect((await request('/v1/journeys/' + trip.id + '/log', 'POST', { entry: await cipherLog(trip.key, trip.id, forged) }, as(owner))).status).toBe(201);
    await expect(client.add({ type: 'resource', title: 'Must not write', body: 'Hidden', tags: [] })).rejects.toThrow('journey history could not be verified');
    client.close();
  }, 30_000);
  it('calls list, add and search through the stdio MCP SDK client', async () => {
    const owner = await person(), trip = await journey(owner);
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'packages/client/dist/cli.js'), 'mcp', '--connect', trip.id, '--server', server, '--scope', 'readwrite'], stderr: 'pipe' });
    let approval: Promise<void> | undefined;
    transport.stderr?.on('data', (chunk: Buffer) => {
      const match = /agent-sessions\/([A-Za-z0-9_-]+)[^\n]*\nSix-digit code: (\d{6})/.exec(chunk.toString());
      if (match && !approval) approval = approve(owner, trip, server + '/agent-sessions/' + match[1], match[2]!);
    });
    const sdk = new Client({ name: 'journey-test', version: '1.0.0' });
    try {
      await sdk.connect(transport);
      await approval;
      expect((await sdk.callTool({ name: 'list' })).isError).not.toBe(true);
      const added = await sdk.callTool({ name: 'add', arguments: { type: 'resource', title: 'MCP journey title', body: 'MCP journey body', author: owner.principal, authoredBy: 'human', accessChanges: [{ principal: owner.principal, action: 'remove' }] } });
      expect(added.isError).not.toBe(true);
      const addedItem = JSON.parse((added.content as Array<{ text: string }>)[0]!.text);
      expect(addedItem.authoredBy).toBe('agent');
      expect(addedItem.author).not.toBe(owner.principal);
      expect(addedItem).not.toHaveProperty('accessChanges');
      const search = await sdk.callTool({ name: 'search', arguments: { text: 'MCP journey title' } });
      expect(JSON.stringify(search.content)).toContain('MCP journey title');
    } finally { await sdk.close(); }
  }, 30_000);
});
