import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { localServer, scratch } from './local-server.js';
import { cli, execute, privateFixture } from './stage3-fixtures.js';

localServer();
describe('Stage 3 real CLI/MCP private workflows', () => {
  it('approved CLI agent reads person-authored history and backs it up without plaintext stdout', async () => {
    const f = await privateFixture();
    const args = ['--state', f.state, '--private-cache', f.cache];
    const show = await execute(process.execPath, [cli, 'private', 'show', f.copy, ...args]);
    expect(JSON.parse(show.stdout).content.title).toBe('PERSON PRIVATE CANARY');
    const path = join(scratch, 'person-backup.age');
    const backup = await execute(process.execPath, [cli, 'private', 'backup', '--output', path, ...args]);
    expect(backup.stdout).not.toContain('PERSON PRIVATE CANARY');
    expect(await readFile(path, 'utf8')).not.toContain('PERSON PRIVATE CANARY');
  }, 120_000);
  it('stdio MCP agent reads person-authored history and exports a verified return bundle', async () => {
    const f = await privateFixture();
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--state', f.state, '--private-cache', f.cache], stderr: 'pipe' });
    const sdk = new Client({ name: 'stage3-private', version: '1.0.0' });
    try {
      await sdk.connect(transport);
      const shown = await sdk.callTool({ name: 'private_show', arguments: { id: f.copy } });
      expect(shown.isError).not.toBe(true);
      expect(JSON.stringify(shown.content)).toContain('PERSON PRIVATE CANARY');
      const result = await sdk.callTool({ name: 'private_return', arguments: { path: join(scratch, 'person-return.age') } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).not.toContain('PERSON PRIVATE CANARY');
    } finally { await sdk.close(); }
  }, 120_000);
});
