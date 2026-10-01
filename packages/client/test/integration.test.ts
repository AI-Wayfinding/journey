import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSigningIdentity, hashControlProof, newId, verifyControlProofs, type Member } from '@ai-wayfinding/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { root, scratch, as, request, person, journey, signedControl, approve, connected, localServer, refresh } from './local-server.js';
const exec = promisify(execFile), server = 'http://localhost:18787';
localServer();
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
    await refresh(trip, owner);
    const last = trip.entries.at(-1)!;
    const removal = await signedControl(trip.key, trip.id, { v: 1, seq: trip.entries.length, prev: await hashControlProof(last.proof), at: new Date().toISOString(), actor: owner.principal, type: 'member.remove', body: { member: client.session.principal } }, owner.signing.privateKey);
    const removed = await request('/v1/journeys/' + trip.id + '/log', 'POST', { control: removal }, as(owner));
    expect(removed.status).toBe(201);
    await expect(client.list()).rejects.toThrow('Access to this journey has ended');
    client.close();
  }, 30_000);
  it('connects across separate CLI commands using a private state file and a verified log', async () => {
    const owner = await person(), trip = await journey(owner);
    const statePath = join(scratch, 'agent-' + newId() + '.json');
    try {
      const cli = join(root, 'packages/client/dist/cli.js');
      const created = await exec(process.execPath, [cli, 'connect', trip.id, '--scope', 'read', '--name', 'File agent', '--server', server, '--state', statePath, '--no-wait', '--json']);
      const pending = JSON.parse(created.stdout) as { link: string; code: string; requestId: string; expiresAt: string; status: string };
      expect(pending).toMatchObject({ link: expect.any(String), code: expect.any(String), requestId: expect.any(String), expiresAt: expect.any(String), status: 'pending' });
      expect((await lstat(statePath)).mode & 0o777).toBe(0o600);
      await expect(exec(process.execPath, [cli, 'connect', '--state', statePath, '--wait', '--timeout', '1', '--json'])).rejects.toMatchObject({ code: 2, stdout: expect.stringContaining('"status":"pending"') });
      const expiredPath = join(scratch, 'expired-' + newId() + '.json');
      const expired = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
      await writeFile(expiredPath, JSON.stringify({ ...expired, createdAt: Date.now() - 600_000, expiresAt: Date.now() - 1 }), { mode: 0o600 });
      await expect(exec(process.execPath, [cli, 'connect', '--state', expiredPath, '--wait', '--json'])).rejects.toMatchObject({ code: 3, stdout: expect.stringContaining('"status":"expired"') });
      await expect(lstat(expiredPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await approve(owner, trip, pending.link, pending.code, 'read', 'File agent');
      const result = await exec(process.execPath, [cli, 'connect', '--state', statePath, '--wait', '--timeout', '5', '--json']);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ link: pending.link, code: pending.code, requestId: pending.requestId, status: 'approved' });
      expect((await lstat(statePath)).mode & 0o777).toBe(0o600);
      const list = await exec(process.execPath, [cli, 'list', '--state', statePath]);
      expect(JSON.parse(list.stdout)).toEqual([]);
      expect(JSON.parse((await exec(process.execPath, [cli, 'connect', '--state', statePath, '--wait', '--json'])).stdout).status).toBe('approved');
    } finally { await rm(statePath, { force: true }); }
  }, 30_000);
  it('returns network-unreachable exit code with an actionable proxy error', async () => {
    const cli = join(root, 'packages/client/dist/cli.js');
    const statePath = join(scratch, 'proxy-' + newId() + '.json');
    await expect(exec(process.execPath, [cli, 'connect', newId(), '--state', statePath, '--no-wait', '--server', 'http://127.0.0.1:18798', '--json'], { env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:18799' } })).rejects.toMatchObject({ code: 5, stderr: expect.stringContaining('app.wayfinding.support') });
    await expect(lstat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('tells a sandboxed agent about the agent link fallback, in plain text and in --json', async () => {
    const cli = join(root, 'packages/client/dist/cli.js');
    const env = { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:18799' };
    const args = ['connect', newId(), '--state', join(scratch, 'fallback-' + newId() + '.json'), '--no-wait', '--server', 'http://127.0.0.1:18798'];
    const text = "If this environment can't reach app.wayfinding.support but you can read web pages, ask the person to open their journey, go to People & agents \u2192 Add agent by link, and give you the link. Read it with your web fetch tool; it returns JSON. That access is read-only.";
    await expect(exec(process.execPath, [cli, ...args], { env })).rejects.toMatchObject({ code: 5, stderr: expect.stringContaining(text) });
    const failed = await exec(process.execPath, [cli, ...args, '--json'], { env }).catch(cause => cause) as { code: number; stderr: string };
    expect(failed.code).toBe(5);
    expect(JSON.parse(failed.stderr)).toMatchObject({ exitCode: 5, fallback: text, error: expect.stringContaining('Could not reach the journey server') });
  });
  it('sends a suggested agent name with the connection request', async () => {
    const owner = await person(), trip = await journey(owner);
    const client = await connected(owner, trip, 'read', 'Planning assistant');
    expect((await client.list())).toEqual([]);
    client.close();
  }, 30_000);
  it('refuses to write when a forged last history entry was appended by a server-side member', async () => {
    const owner = await person(), trip = await journey(owner), client = await connected(owner, trip);
    await refresh(trip, owner);
    const stranger = await createSigningIdentity();
    const forged = await signedControl(trip.key, trip.id, { v: 1, seq: trip.entries.length, prev: await hashControlProof(trip.entries.at(-1)!.proof), at: new Date().toISOString(), actor: owner.principal, type: 'member.remove', body: { member: client.session.principal } }, stranger.privateKey);
    expect((await verifyControlProofs([...trip.entries, forged].map(c => c.proof), [...trip.entries, forged].map(c => c.envelope), { journey: trip.id, creator: trip.entries[0]!.proof.body.creator as Member })).ok).toBe(false);
    expect((await request('/v1/journeys/' + trip.id + '/log', 'POST', { control: forged }, as(owner))).status).toBe(400);
    trip.entries.push(forged); // A hostile transport cannot make the client trust a rejected signature.
    const rejecting = new (await import('../src/journey.js')).JourneyClient(client.session, { fetch: async (url, init) => String(url).includes('/log') ? Response.json({ log: trip.entries.map(c => ({ seq: c.proof.seq, ...c })) }) : fetch(url, init) });
    await expect(rejecting.add({ type: 'resource', title: 'Must not write', body: 'Hidden', tags: [] })).rejects.toThrow('journey history could not be verified');
    client.close();
  }, 30_000);
  it('calls list, add and search through the stdio MCP SDK client', async () => {
    const owner = await person(), trip = await journey(owner);
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'packages/client/dist/cli.js'), 'mcp', '--connect', trip.id, '--server', server, '--scope', 'readwrite', '--name', 'MCP assistant'], stderr: 'pipe' });
    let approval: Promise<void> | undefined;
    transport.stderr?.on('data', (chunk: Buffer) => {
      const match = /agent-sessions\/([A-Za-z0-9_-]+)[^\n]*\nSix-digit code: (\d{6})/.exec(chunk.toString());
      if (match && !approval) approval = approve(owner, trip, server + '/agent-sessions/' + match[1], match[2]!, 'readwrite', 'MCP assistant');
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
