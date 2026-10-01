import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { newId } from '@ai-wayfinding/core';
import { saveState } from '../src/state.js';
import type { JourneyClient } from '../src/journey.js';
import { root, scratch, server, approve, type Owner, type Fixture } from './local-server.js';
export * from './local-server.js';
const exec = promisify(execFile);
export const cli = join(root, 'packages/client/dist/cli.js');
export async function command(file: string, ...args: string[]): Promise<any> { return JSON.parse((await exec(process.execPath, [cli, ...args, '--state', file])).stdout); }
export async function failedCommand(file: string, message: string, ...args: string[]): Promise<void> {
  const error = await exec(process.execPath, [cli, ...args, '--state', file]).then(() => null, error => error);
  expect(error).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining(message) });
}
export async function state(agent: JourneyClient, origin = server): Promise<string> {
  const file = join(scratch, newId() + '.json');
  await saveState(file, { status: 'approved', session: { ...agent.session, server: origin }, createdAt: Date.now(), expiresAt: agent.session.expiresAt, link: 'local', code: '123456' });
  return file;
}
export async function mcp(file: string): Promise<Client> {
  const sdk = new Client({ name: 'stage1-artifacts', version: '1.0.0' });
  await sdk.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--state', file], stderr: 'pipe' }));
  return sdk;
}
export async function approvedMcp(owner: Owner, trip: Fixture): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--connect', trip.id, '--server', server, '--scope', 'readwrite', '--name', 'Stage 1 MCP'], stderr: 'pipe' });
  let approval: Promise<void> | undefined, output = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    const match = /agent-sessions\/([A-Za-z0-9_-]+)[^\n]*\nSix-digit code: (\d{6})/.exec(output);
    if (match && !approval) approval = approve(owner, trip, server + '/agent-sessions/' + match[1], match[2]!, 'readwrite', 'Stage 1 MCP');
  });
  const sdk = new Client({ name: 'stage1-approval', version: '1.0.0' });
  await sdk.connect(transport);
  // The first tool waits on the same approval-first connection as production MCP.
  await tool(sdk, 'status'); await approval;
  return sdk;
}
export async function tool(sdk: Client, name: string, args?: Record<string, unknown>): Promise<any> {
  const result = await sdk.callTool({ name, ...(args ? { arguments: args } : {}) });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return JSON.parse((result.content as { text: string }[])[0]!.text);
}
export async function failedTool(sdk: Client, name: string, message: string, args?: Record<string, unknown>): Promise<void> {
  const result = await sdk.callTool({ name, ...(args ? { arguments: args } : {}) });
  expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain(message);
}
/** Local forwarding transport, used to inject unsupported formats and races into real API calls. */
export async function proxy(transform: (path: string, method: string, text: string, status: number) => string = (_p, _m, text) => text) {
  const requests: { path: string; method: string }[] = [];
  const forwarding = createServer(async (req, res) => {
    try {
      const path = req.url!, method = req.method!; requests.push({ path, method });
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string' && !['host', 'connection', 'content-length'].includes(name)) headers.set(name, value);
      if (headers.has('origin')) headers.set('origin', server);
      const response = await fetch(server + path, { method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const text = transform(path, method, await response.text(), response.status);
      res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(text);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => forwarding.listen(0, '127.0.0.1', resolve));
  const address = forwarding.address(); if (!address || typeof address === 'string') throw new Error('No local proxy');
  return { origin: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>(resolve => forwarding.close(() => resolve())) };
}
