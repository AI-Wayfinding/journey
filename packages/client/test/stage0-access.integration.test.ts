import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { newId } from '@ai-wayfinding/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { saveState } from '../src/state.js';
import { localServer, person, journey, connected, change, addPerson, root, scratch } from './local-server.js';
const exec = promisify(execFile), cli = join(root, 'packages/client/dist/cli.js');
localServer();
it('CLI and a live MCP connection follow current effective access, not remembered approval', async () => {
  const guide = await person(), trip = await journey(guide), adding = await addPerson(trip, guide);
  const writer = await connected(adding, trip), reader = await connected(adding, trip, 'read');
  const clients = [writer, reader], files: string[] = [], sdks: Client[] = [];
  try {
    for (const client of clients) {
      const file = join(scratch, newId() + '.json'); files.push(file);
      await saveState(file, { status: 'approved', session: client.session, createdAt: Date.now(), expiresAt: client.session.expiresAt, link: 'local', code: '123456' });
      const sdk = new Client({ name: 'stage0', version: '1.0.0' }); sdks.push(sdk);
      await sdk.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--state', file], stderr: 'pipe' }));
    }
    const addArgs = ['add', '--type', 'note', '--title', 'Allowed only when effective', '--body', 'body'];
    for (const [role, scopes] of [['read-write', ['readwrite','readwrite']], ['read-only', ['read','read']], ['read-write', ['readwrite','readwrite']]] as const) {
      await change(trip, guide, 'member.role', { member: adding.principal, role });
      for (let index = 0; index < 2; index++) {
        expect(JSON.parse((await exec(process.execPath, [cli, 'status', '--state', files[index]!])).stdout).scope).toBe(scopes[index]);
        const status = await sdks[index]!.callTool({ name: 'status' });
        expect(JSON.stringify(status.content)).toContain(scopes[index]);
        const cliAdd = exec(process.execPath, [cli, ...addArgs, '--state', files[index]!]);
        const mcpAdd = await sdks[index]!.callTool({ name: 'add', arguments: { type: 'note', title: 'MCP effective', body: 'body' } });
        if (scopes[index] === 'readwrite') { expect(JSON.parse((await cliAdd).stdout).authoredBy).toBe('agent'); expect(mcpAdd.isError).not.toBe(true); }
        else { await expect(cliAdd).rejects.toMatchObject({ stderr: expect.stringContaining('read-only') }); expect(mcpAdd.isError).toBe(true); expect(JSON.stringify(mcpAdd.content)).toContain('read-only'); }
        expect(JSON.parse((await exec(process.execPath, [cli, 'list', '--state', files[index]!])).stdout).length).toBeGreaterThan(0);
        expect((await sdks[index]!.callTool({ name: 'list' })).isError).not.toBe(true);
      }
    }
    await change(trip, guide, 'member.remove', { member: adding.principal });
    for (let index = 0; index < 2; index++) {
      for (const command of ['status', 'list']) await expect(exec(process.execPath, [cli, command, '--state', files[index]!])).rejects.toMatchObject({ stderr: expect.stringContaining('Access to this journey has ended') });
      for (const name of ['status', 'list', 'add']) expect((await sdks[index]!.callTool({ name, ...(name === 'add' ? { arguments: { type: 'note', title: 'Denied', body: 'No' } } : {}) })).isError).toBe(true);
    }
  } finally { for (const sdk of sdks) await sdk.close(); for (const client of clients) client.close(); }
}, 60_000);
