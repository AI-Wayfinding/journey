import { describe, expect, it } from 'vitest';
import { privateHash, importSigningKey, signPrivateHeader } from '@ai-wayfinding/core';
import { localServer } from './local-server.js';
import { agentState, cacheBytes, cli, command, denyTool, execute, privateFixture, privateMcp, privateProxy, retained, tool } from './stage3-fixtures.js';
import { forkCache, forkFile, forkRecord } from './stage3-forks.js';

localServer();
describe('real CLI/MCP signed forks', () => {
  it.each(['CLI', 'MCP'] as const)('%s retains ties, chooses higher artifact versions and preserves tombstones under higher signed heads', async surface => {
    for (const scenario of ['tie', 'higher', 'deleted'] as const) {
      const f = await privateFixture(), proxy = await privateProxy(), state = await agentState(f.agentSession, proxy.origin);
      const m = surface === 'MCP' ? await privateMcp(state, f.cache, true) : undefined;
      try {
        if (m) await tool(m.sdk, 'private_init'); else await command(state, f.cache, 'private', 'init');
        const base = await retained(f.cache, f.vaultId, f.agentSession.identity), bundle = structuredClone(f.bundle);
        await forkRecord(f, bundle, 'FORK CANARY', scenario === 'deleted' ? 'private.delete' : 'private.version');
        if (scenario === 'higher') await forkRecord(f, bundle, 'HIGHER CANARY');
        // Left branch has the same artifact-version count as the tied right branch.
        if (scenario === 'tie') {
          if (m) { const shown = await tool(m.sdk, 'private_show', { id: f.copy }); await tool(m.sdk, 'private_edit', { id: f.copy, predecessor: shown.copy.head, type: 'document', title: 'LEFT CANARY' }); await m.advance(300_000); }
          else {
            const shown = await command(state, f.cache, 'private', 'show', f.copy);
            await command(state, f.cache, 'private', 'edit', f.copy, '--predecessor', shown.copy.head, '--type', 'document', '--title', 'LEFT CANARY');
            const writer = await privateMcp(state, f.cache, true); try { await tool(writer.sdk, 'private_init'); await writer.advance(300_000); } finally { await writer.close(); }
          }
        }
        const current = await retained(f.cache, f.vaultId, f.agentSession.identity);
        const path = await forkFile(await forkCache(f, { ...base, checkpoint: current.checkpoint, frame: current.frame }, bundle));
        const before = proxy.trace.filter(t => t.path.includes('/private-vault')).length;
        const result = m ? await tool(m.sdk, 'private_merge', { path }) : await command(state, f.cache, 'private', 'merge', path);
        if (m) { expect(result.status).toBe('staged'); expect(proxy.trace.filter(t => t.path.includes('/private-vault'))).toHaveLength(before); await m.advance(scenario === 'tie' ? 600_000 : 300_000); }
        const branches = m ? await tool(m.sdk, 'private_branches') : await command(state, f.cache, 'private', 'branches');
        if (scenario === 'tie') expect(branches.map((b: any[]) => b[0].content.title).sort()).toEqual(['FORK CANARY', 'LEFT CANARY']);
        else if (scenario === 'higher') expect(branches.map((b: any[]) => b[0].content.title)).toEqual(['HIGHER CANARY']);
        else expect(branches).toEqual([[]]);
        const merged = await retained(f.cache, f.vaultId, f.agentSession.identity);
        expect(merged.checkpoint.version).toBeGreaterThan(current.checkpoint.version);
        expect(merged.checkpoint.head).not.toBe(current.checkpoint.head);
        expect(JSON.stringify(proxy.trace)).not.toContain('CANARY');
      } finally { await m?.close(); await proxy.close(); }
    }
  }, 240_000);

  it.each(['CLI', 'MCP'] as const)('%s rejects unsigned, corrupt, stale, bad-signature/digest/predecessor forks without local/server mutation', async surface => {
    const f = await privateFixture(), proxy = await privateProxy(), state = await agentState(f.agentSession, proxy.origin);
    const m = surface === 'MCP' ? await privateMcp(state, f.cache, true) : undefined;
    try {
      if (m) await tool(m.sdk, 'private_init'); else await command(state, f.cache, 'private', 'init');
      const base = await retained(f.cache, f.vaultId, f.agentSession.identity), bundle = structuredClone(f.bundle);
      await forkRecord(f, bundle, 'INVALID FORK CANARY');
      const good = await forkCache(f, base, bundle), malformed = structuredClone(bundle);
      malformed.records.at(-1)!.prev = await privateHash('unrelated predecessor');
      const { sig: _sig, ...unsigned } = malformed.records.at(-1)!;
      malformed.records[malformed.records.length - 1] = await (await import('@ai-wayfinding/core')).signPrivateRecord(unsigned, await importSigningKey(f.owner.signing.privateKey));
      const wrongSignature = structuredClone(bundle); wrongSignature.records.at(-1)!.sig = Buffer.alloc(64).toString('base64');
      const wrongPayload = structuredClone(bundle); wrongPayload.payloads.at(-1)!.payload.body.title = 'TAMPERED PAYLOAD CANARY';
      const cases = [
        { name: 'unsigned', value: await forkCache(f, base, bundle, async raw => { raw.header.sig = ''; }) },
        { name: 'signature', value: await forkCache(f, base, bundle, async raw => { raw.header.sig = Buffer.alloc(64).toString('base64'); }) },
        { name: 'digest', value: { ...good, slots: good.slots.map((s, i) => i === 63 ? Buffer.alloc(1_048_576).toString('base64') : s) } },
        { name: 'complete-digest', value: await forkCache(f, base, bundle, async raw => { const { sig, ...h } = raw.header; raw.header = await signPrivateHeader({ ...h, contentsHash: await privateHash('wrong digest') }, await importSigningKey(f.owner.signing.privateKey)); }) },
        { name: 'predecessor', value: await forkCache(f, base, malformed) },
        { name: 'record-signature', value: await forkCache(f, base, wrongSignature) },
        { name: 'payload-digest', value: await forkCache(f, base, wrongPayload) },
        { name: 'header-predecessor', value: await forkCache(f, base, bundle, async raw => { const { sig, ...h } = raw.header; raw.header = await signPrivateHeader({ ...h, prev: null }, await importSigningKey(f.owner.signing.privateKey)); }) },
        { name: 'stale', value: await forkCache(f, base, bundle, async raw => { const { sig, ...h } = raw.header; raw.header = await signPrivateHeader({ ...h, version: h.version - 1 }, await importSigningKey(f.owner.signing.privateKey)); }) },
        { name: 'unknown-version', value: await forkCache(f, base, bundle, async raw => { (raw.header as any).v = 2; }) },
        { name: 'extra-field', value: { ...good, plaintext: 'INVALID FORK CANARY' } },
      ];
      const before = await cacheBytes(f.cache, f.vaultId), credentials = await (await import('node:fs/promises')).readFile(state), writes = proxy.trace.filter(t => t.method === 'PUT').length;
      for (const c of cases) {
        const path = await forkFile(c.value);
        if (m) { const denied = await m.sdk.callTool({ name: 'private_merge', arguments: { path } }); expect(denied.isError, c.name).toBe(true); expect(JSON.stringify(denied.content)).not.toContain('CANARY'); }
        else await expect(execute(process.execPath, [cli, 'private', 'merge', path, '--state', state, '--private-cache', f.cache], { timeout: 90_000 })).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.not.stringContaining('CANARY') });
        expect(await cacheBytes(f.cache, f.vaultId), c.name).toEqual(before);
        expect(proxy.trace.filter(t => t.method === 'PUT'), c.name).toHaveLength(writes);
        expect(await (await import('node:fs/promises')).readFile(state)).toEqual(credentials);
      }
    } finally { await m?.close(); await proxy.close(); }
  }, 240_000);
});
