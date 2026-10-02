import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { saveState } from '../src/state.js';
import { localServer, person, journey, connected, change, root, scratch } from './local-server.js';
const exec = promisify(execFile), cli = join(root, 'packages/client/dist/cli.js');
localServer();
it('CLI and live MCP fail closed for upgraded minimum and unsupported controls without reapproval', async () => {
  const owner = await person(), trip = await journey(owner), agent = await connected(owner, trip);
  let unsupported = false; const requests: string[] = [];
  // Real journey data through a local transport that simulates a future server's control type.
  const proxy = createServer(async (req, res) => {
    try {
      requests.push(req.url!);
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string' && key !== 'host' && key !== 'connection') headers.set(key, value);
      if (headers.has('origin')) headers.set('origin', 'http://localhost:18787');
      const response = await fetch('http://localhost:18787' + req.url, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      let text = await response.text();
      if (unsupported && req.url?.includes('/log') && response.ok) { const data = JSON.parse(text); data.log.at(-1).proof.type = 'future.control'; text = JSON.stringify(data); }
      res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(text);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('No local proxy');
  const file = join(scratch, 'versions.json');
  await saveState(file, { status: 'approved', session: { ...agent.session, server: `http://127.0.0.1:${address.port}` }, createdAt: Date.now(), expiresAt: agent.session.expiresAt, link: 'local', code: '123456' });
  const sdk = new Client({ name: 'stage0-versions', version: '1.0.0' });
  try {
    await sdk.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--state', file], stderr: 'pipe' }));
    expect(JSON.parse((await exec(process.execPath, [cli, 'list', '--state', file])).stdout)).toEqual([]);
    expect((await sdk.callTool({ name: 'list' })).isError).not.toBe(true);
    for (const gate of ['unsupported', 'minimum']) {
      unsupported = gate === 'unsupported';
      if (!unsupported) await change(trip, owner, 'client.minVersion', { version: '0.1.7' });
      requests.length = 0;
      for (const args of [['list'], ['status'], ['add','--type','note','--title','Must not save','--body','No']]) {
        const failed = await exec(process.execPath, [cli, ...args, '--state', file]).catch(error => error);
        expect(failed.code).toBe(1); expect(failed.stderr).toContain('npm install -g @ai-wayfinding/client@latest'); expect(failed.stderr).toContain('do not need to connect or be approved again'); expect(failed.stdout).toBe('');
      }
      for (const name of ['list', 'status', 'add']) {
        const failed = await sdk.callTool({ name, ...(name === 'add' ? { arguments: { type: 'note', title: 'No', body: 'No' } } : {}) });
        expect(failed.isError).toBe(true); expect(JSON.stringify(failed.content)).toContain('npm install -g @ai-wayfinding/client@latest');
      }
      expect(requests.some(path => path.includes('/seq') || path.includes('/records') || path.includes('/agent-sessions'))).toBe(false);
    }
  } finally { await sdk.close(); agent.close(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
}, 60_000);
