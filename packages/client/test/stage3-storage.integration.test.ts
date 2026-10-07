import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createSigningIdentity } from '@ai-wayfinding/core';
import { addPerson, change, connected, journey, localServer, person, scratch } from './local-server.js';
import { agentState, cacheBytes, cli, command, execute, privateFixture, privateMcp, privateProxy, tool } from './stage3-fixtures.js';
import { allocations, registryChange } from './stage3-storage.js';

localServer();
describe('real workerd admission and private denials', () => {
  it('allocates exactly 64 one-MiB slots at person join before any open, and none at CLI/MCP agent admission', async () => {
    const before = await allocations(), owner = await person(), trip = await journey(owner);
    const created = await allocations();
    expect(created.filter(v => !before.some(b => b.file === v.file))).toEqual([expect.objectContaining({ n: 64, min: 1_048_576, max: 1_048_576 })]);
    const guest = await addPerson(trip, owner), joined = await allocations();
    expect(joined.filter(v => !created.some(b => b.file === v.file))).toEqual([expect.objectContaining({ n: 64, min: 1_048_576, max: 1_048_576 })]);
    await change(trip, owner, 'client.minVersion', { version: '0.1.7' });
    for (const actor of [owner, guest]) {
      const agent = await connected(actor, trip);
      try {
        const state = await agentState(agent.session), cache = join(scratch, 'allocation-' + agent.session.principal);
        expect(await allocations()).toEqual(joined);
        await command(state, cache, 'private', 'init');
        const m = await privateMcp(state, cache, true);
        try { await tool(m.sdk, 'private_init'); } finally { await m.close(); }
        expect(await allocations()).toEqual(joined);
      } finally { agent.close(); }
    }
  }, 120_000);

  it('an initialized container with a missing delivered key is refused, never reinitialized under agent keys', async () => {
    const f = await privateFixture(), proxy = await privateProxy((path, method, bytes, status) => path.includes('/private-agent-wrap/') && method === 'GET' ? { bytes: Buffer.from('{"error":{"code":"not-found"}}'), status: 404 } : { bytes, status });
    const state = await agentState(f.agentSession, proxy.origin), cache = join(scratch, 'missing-wrap');
    try {
      await expect(execute(process.execPath, [cli, 'private', 'init', '--state', state, '--private-cache', cache], { timeout: 90_000 })).rejects.toMatchObject({ code: 1, stdout: '' });
      const m = await privateMcp(state, cache, true);
      try { const denied = await m.sdk.callTool({ name: 'private_init', arguments: {} }); expect(denied.isError).toBe(true); } finally { await m.close(); }
      expect(proxy.trace.filter(t => t.method === 'PUT')).toEqual([]);
      const actual = await command(f.state, f.cache, 'private', 'show', f.copy); expect(actual.content.title).toBe('PERSON PRIVATE CANARY');
    } finally { await proxy.close(); }
  }, 120_000);

  it.each(['expires', 'signingKey', 'keyStorage', 'unknown-version'] as const)('CLI/MCP deny real server %s with unchanged private cache and credentials', async field => {
    const f = await privateFixture(), proxy = await privateProxy((path, method, bytes, status) => {
      if (field === 'unknown-version' && path.endsWith('/protocol') && method === 'GET' && status === 200) {
        const value = JSON.parse(bytes.toString()); value.privateFormat = 'private-v999'; return { bytes: Buffer.from(JSON.stringify(value)) };
      }
      return { bytes };
    });
    const state = await agentState(f.agentSession, proxy.origin);
    // Establish a retained checkpoint through the genuine approved session.
    await command(f.state, f.cache, 'private', 'init');
    const before = await cacheBytes(f.cache, f.vaultId), credentials = await readFile(state);
    if (field === 'expires') await registryChange(f.agentSession.sessionId, field, Date.now() - 1);
    if (field === 'signingKey') await registryChange(f.agentSession.sessionId, field, (await createSigningIdentity()).publicKey);
    if (field === 'keyStorage') await registryChange(f.agentSession.sessionId, field, 'link');
    await expect(execute(process.execPath, [cli, 'private', 'show', f.copy, '--state', state, '--private-cache', f.cache], { timeout: 90_000 })).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.not.stringContaining('PERSON PRIVATE') });
    const m = await privateMcp(state, f.cache, true);
    try {
      const denied = await m.sdk.callTool({ name: 'private_show', arguments: { id: f.copy } });
      expect(denied.isError).toBe(true); expect(JSON.stringify(denied.content)).not.toContain('PERSON PRIVATE');
      expect(await cacheBytes(f.cache, f.vaultId)).toEqual(before); expect(await readFile(state)).toEqual(credentials);
      expect(proxy.trace.filter(t => t.path.includes('/private-vault'))).toEqual([]);
      expect(proxy.trace.filter(t => t.path.includes('/private-agent-wrap')).map(t => [t.method, t.status])).toEqual(field === 'keyStorage' ? [['GET', 403], ['GET', 403]] : []);
      if (field === 'expires' || field === 'signingKey') expect(proxy.trace.some(t => t.status === 401)).toBe(true);
    } finally { await m.close(); await proxy.close(); }
  }, 120_000);
});
