import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { newId, sealIdentity, createAgeIdentity, createSigningIdentity } from '@ai-wayfinding/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { localServer, scratch, addPerson, connected, change, request, as } from './local-server.js';
import { cli, execute, privateFixture, privateMcp, tool, denyTool, command, privateProxy, agentState, privateDestination } from './stage3-fixtures.js';

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

// These assertions cross the real CLI/stdio boundary. Virtual time controls only
// the portable scheduler; authentication and signed records use wall time.
describe('Stage 3 durable staged lifecycle', () => {
  it('CLI save survives process restart; MCP edits person and agent history, downloads only to explicit paths and keeps tombstones', async () => {
    const f = await privateFixture();
    const file = join(scratch, 'private-input-' + newId()); await writeFile(file, 'ATTACHMENT PRIVATE CANARY');
    const saved = await command(f.state, f.cache, 'private', 'create', '--type', 'document', '--title', 'CLI PRIVATE CANARY', '--body', 'CLI body', '--file', file);
    expect(saved.status).toBe('staged'); expect(JSON.stringify(saved)).not.toContain('CLI PRIVATE CANARY');
    const reopened = await command(f.state, f.cache, 'private', 'show', saved.id);
    expect(reopened.content.title).toBe('CLI PRIVATE CANARY'); expect(reopened.status).toBe('staged');
    expect(reopened.copy.author.kind).toBe('agent'); expect(reopened.copy.author.signingKey).toBe(f.agentSession.signingKey);
    const blob = reopened.content.attachments[0].blob.id, download = join(scratch, 'private-output-' + newId());
    await command(f.state, f.cache, 'private', 'download', saved.id, '--blob', blob, '--output', download);
    expect(await readFile(download, 'utf8')).toBe('ATTACHMENT PRIVATE CANARY');
    const m = await privateMcp(f.state, f.cache, true);
    try {
      const initial = await tool(m.sdk, 'private_show', { id: saved.id });
      const before = initial.copy.head;
      await denyTool(m.sdk, 'private_edit', { id: saved.id, predecessor: newId(), type: 'document', title: 'WRONG' }, 'conflict');
      expect((await tool(m.sdk, 'private_show', { id: saved.id })).copy.head).toBe(before);
      await tool(m.sdk, 'private_edit', { id: saved.id, predecessor: before, type: 'document', title: 'MCP PRIVATE CANARY', body: 'New body' });
      const edited = await tool(m.sdk, 'private_show', { id: saved.id });
      expect(edited.content.title).toBe('MCP PRIVATE CANARY'); expect(edited.content.attachments[0].blob.id).toBe(blob);
      expect(edited.copy.records).toHaveLength(2); expect(edited.copy.author).toEqual(initial.copy.author);
      const person = await tool(m.sdk, 'private_show', { id: f.copy });
      await tool(m.sdk, 'private_edit', { id: f.copy, predecessor: person.copy.head, type: 'document', title: 'Agent edited person', body: 'same person authority' });
      expect((await tool(m.sdk, 'private_show', { id: f.copy })).copy.author).toEqual(f.bundle.author);
      await tool(m.sdk, 'private_comment', { id: saved.id, text: 'PRIVATE COMMENT', onVersion: edited.copy.head });
      const project = await tool(m.sdk, 'project_create', { purpose: 'Private placement fixture' });
      // Public authority changes require reopening the private workflow.
      await m.close();
      const next = await privateMcp(f.state, f.cache, true);
      try {
        await tool(next.sdk, 'private_project', { id: saved.id, project: project.id, predecessor: null });
        expect(await tool(next.sdk, 'private_list')).toHaveLength(1);
        const assigned = await tool(next.sdk, 'private_list', { project: project.id }); expect(assigned.map((c: any) => c.copy)).toEqual([saved.id]);
        expect(assigned[0].placement).not.toBeNull();
        await next.advance(300_000);
        expect((await tool(next.sdk, 'private_init')).status).toBe('committed');
        const copy = await tool(next.sdk, 'private_show', { id: saved.id });
        await tool(next.sdk, 'private_delete', { id: saved.id, predecessor: copy.copy.head });
        await denyTool(next.sdk, 'private_show', { id: saved.id }, 'unavailable');
        await next.advance(600_000);
      } finally { await next.close(); }
      expect(m.errors()).not.toContain('PRIVATE CANARY');
    } finally { await m.close(); }
    expect((await command(f.state, f.cache, 'private', 'list', '--project', 'all')).map((c: any) => c.copy)).toEqual([f.copy]);
    const files = await readdir(join(f.cache, f.bundle.vault));
    for (const name of files) { const bytes = await readFile(join(f.cache, f.bundle.vault, name)); for (const hidden of ['CLI PRIVATE CANARY', 'MCP PRIVATE CANARY', 'ATTACHMENT PRIVATE CANARY', f.agentSession.identity, f.agentSession.signingPrivateKey]) expect(bytes.includes(Buffer.from(hidden))).toBe(false); }
  }, 180_000);
});

describe('Stage 3 real padded traffic', () => {
  it('matches empty/populated D36 observations on open and virtual five-minute ticks; saves never sync and reopens never refetch all slots', async () => {
    const empty = await privateFixture(false), populated = await privateFixture(true);
    const left = await privateProxy(), right = await privateProxy();
    const leftState = await agentState(empty.agentSession, left.origin), rightState = await agentState(populated.agentSession, right.origin);
    const a = await privateMcp(leftState, empty.cache, true), b = await privateMcp(rightState, populated.cache, true);
    const padded = (proxy: typeof left) => proxy.trace.filter(t => t.path.includes('/private-vault')).map(t => ({ at: t.at, method: t.method, request: t.request, response: t.response, status: t.status, queryLength: t.path.split('?')[1]?.length ?? 0, headerNames: Object.keys(t.headers).sort() }));
    try {
      await tool(a.sdk, 'private_init'); await tool(b.sdk, 'private_init');
      expect(padded(left)).toEqual(padded(right));
      expect(padded(right).map(t => [t.method, t.request, t.response])).toEqual([['GET', 0, 67_141_761], ['GET', 0, 2_129_987], ['PUT', 2_129_986, 76]]);
      const baseline = padded(right);
      const save = await tool(b.sdk, 'private_create', { type: 'document', title: 'D36 HIDDEN', body: 'Private save' });
      expect(save.status).toBe('staged'); expect(padded(right)).toEqual(baseline);
      left.time(299_999); right.time(299_999); await a.advance(299_999); await b.advance(299_999);
      expect(padded(right)).toEqual(baseline);
      left.time(300_000); right.time(300_000); await a.advance(300_000); await b.advance(300_000);
      expect((await tool(b.sdk, 'private_init')).status).toBe('committed');
      expect(padded(left)).toEqual(padded(right));
      left.time(600_000); right.time(600_000); await a.advance(600_000); await b.advance(600_000);
      expect(padded(left)).toEqual(padded(right));
      expect(padded(right).filter(t => t.method === 'PUT')).toHaveLength(3);
      const privateWrites = right.trace.filter(t => t.method === 'PUT' || t.method === 'POST');
      expect(privateWrites.every(t => /\/private-vault$|\/private-agent-wrap\//.test(t.path))).toBe(true);
      expect(b.errors()).not.toContain('D36 HIDDEN');
      await a.close(); await b.close();
      const before = right.trace.length;
      expect((await command(rightState, populated.cache, 'private', 'show', save.id)).content.title).toBe('D36 HIDDEN');
      const reopen = right.trace.slice(before).filter(t => t.path.includes('/private-vault'));
      expect(reopen.map(t => [t.method, t.request, t.response])).toEqual([['GET', 0, 2_129_987], ['PUT', 2_129_986, 76]]);
      const ordinary = await execute(process.execPath, [cli, 'list', '--state', rightState]);
      expect(ordinary.stdout).not.toContain('D36 HIDDEN'); expect(ordinary.stdout).not.toContain(save.id);
      expect(await readFile(rightState, 'utf8')).not.toContain(save.id);
    } finally { await a.close(); await b.close(); await left.close(); await right.close(); }
  }, 180_000);
});

describe('Stage 3 paired and unpaired devices', () => {
  it('exports the retained checkpoint, bootstraps another paired device and rejects replay below the retained version without writes', async () => {
    const f = await privateFixture(); let replay = false, oldWire: Buffer | undefined;
    const proxy = await privateProxy((path, method, bytes) => {
      if (method === 'GET' && path.includes('/private-vault?slots=') && !path.endsWith('=all')) {
        if (replay) { const replayed = Buffer.from(bytes); oldWire!.copy(replayed, 0, 0, 65 + 32768); return { bytes: replayed }; }
        oldWire ??= Buffer.from(bytes);
      }
      return { bytes };
    });
    const state = await agentState(f.agentSession, proxy.origin), checkpoint = join(scratch, 'checkpoint-' + newId());
    try {
      const initial = await command(state, f.cache, 'private', 'init'); expect(initial.freshness).toBe('unverified'); expect(initial.version).toBe(3);
      await command(state, f.cache, 'private', 'checkpoint', '--output', checkpoint);
      const retained = JSON.parse(await readFile(checkpoint, 'utf8')); expect(retained.version).toBe(4); expect(retained.freshness).toBe('unverified');
      // An export is not confirmation by itself. This fixture is the trusted
      // device exchange: the other device confirms the exact retained head.
      const trusted = join(scratch, 'confirmed-' + newId());
      await writeFile(trusted, JSON.stringify({ ...retained, freshness: 'paired' }));
      const second = join(scratch, 'second-device-' + newId());
      const m = await privateMcp(state, second, true, trusted);
      try {
        const paired = await tool(m.sdk, 'private_init'); expect(paired.freshness).toBe('paired'); expect(paired.version).toBe(5);
        expect((await tool(m.sdk, 'private_show', { id: f.copy })).content.title).toBe('PERSON PRIVATE CANARY');
        proxy.time(300_000); replay = true; const before = proxy.trace.filter(t => t.method === 'PUT').length;
        await expect(m.advance(300_000)).rejects.toThrow('rollback');
        expect(proxy.trace.filter(t => t.method === 'PUT')).toHaveLength(before);
      } finally { await m.close(); }
      replay = false;
      const third = await command(state, join(scratch, 'unpaired-device-' + newId()), 'private', 'init'); expect(third.freshness).toBe('unverified');
    } finally { await proxy.close(); }
  }, 120_000);
});

describe('Stage 3 real denial and leakage matrix', () => {
  it('rejects extra grants, changed keys, expired and foreign sessions before private traffic; imports reject wrong recipient, stale and unknown bundles without staging', async () => {
    const f = await privateFixture(), proxy = await privateProxy(), state = await agentState(f.agentSession, proxy.origin);
    const m = await privateMcp(state, f.cache, true);
    const cacheState = async () => {
      const names = await readdir(join(f.cache, f.vaultId)); const result: Record<string, string> = {};
      for (const name of names) result[name] = (await readFile(join(f.cache, f.vaultId, name))).toString('base64'); return result;
    };
    try {
      const shown = await tool(m.sdk, 'private_show', { id: f.copy });
      const before = await cacheState(), writes = proxy.trace.filter(t => t.method === 'PUT').length;
      await denyTool(m.sdk, 'private_create', { type: 'document', title: 'no', role: 'read-write' }, 'Unknown private input field');
      await denyTool(m.sdk, 'private_edit', { id: f.copy, predecessor: newId(), type: 'document', title: 'no' }, 'conflict');
      await denyTool(m.sdk, 'private_backup', {}, 'path');
      await denyTool(m.sdk, 'private_download', { id: f.copy, blob: newId() }, 'path');
      expect(await cacheState()).toEqual(before); expect(proxy.trace.filter(t => t.method === 'PUT')).toHaveLength(writes);
      const unsupported = { ...f.bundle, version: 2 }, bad = join(scratch, 'unsupported-' + newId());
      await writeFile(bad, await sealIdentity(JSON.stringify(unsupported), [f.agentSession.recipient]));
      await denyTool(m.sdk, 'private_import', { path: bad }, 'Invalid private bundle');
      await writeFile(bad, await sealIdentity(JSON.stringify(f.bundle), [(await createAgeIdentity()).recipient]));
      await denyTool(m.sdk, 'private_import', { path: bad }, "no identity matched any of the file's recipients");
      expect(await cacheState()).toEqual(before);
      const backup = join(scratch, 'old-backup-' + newId()); await tool(m.sdk, 'private_backup', { path: backup });
      await tool(m.sdk, 'private_edit', { id: f.copy, predecessor: shown.copy.head, type: 'document', title: 'New version' }); await m.advance(300_000);
      const edited = await cacheState();
      await denyTool(m.sdk, 'private_import', { path: backup }, 'Stale private backup'); expect(await cacheState()).toEqual(edited);
      await m.close();
      for (const overrides of [{ signingPrivateKey: (await createSigningIdentity()).privateKey }, { recipient: (await createAgeIdentity()).recipient }, { identity: (await createAgeIdentity()).identity }, { expiresAt: Date.now() - 1 }]) {
        const altered = await agentState({ ...f.agentSession, ...overrides }, proxy.origin), noCache = join(scratch, 'denied-' + newId());
        const count = proxy.trace.filter(t => t.path.includes('/private-vault') || t.path.includes('/private-agent-wrap')).length;
        await expect(command(altered, noCache, 'private', 'init')).rejects.toMatchObject({ stdout: '' });
        expect(proxy.trace.filter(t => t.path.includes('/private-vault') || t.path.includes('/private-agent-wrap'))).toHaveLength(count);
        await expect(readdir(noCache)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      const guest = await addPerson(f.trip, f.owner), foreign = await connected(guest, f.trip);
      const own = await privateFixture(false, { owner: guest, trip: f.trip, agentSession: foreign.session });
      const foreignState = await agentState(foreign.session, proxy.origin); foreign.close();
      const foreignCache = join(scratch, 'foreign-' + newId()), foreignCredentials = await readFile(foreignState);
      const other = await privateMcp(foreignState, foreignCache, true);
      try {
        // A foreign person's agent may open its own vault, but cannot read this
        // person's copy. Baseline the scheduled open before testing the denial.
        await tool(other.sdk, 'private_init');
        const foreignBefore = await cacheState();
        const ownBefore = await readFile(join(foreignCache, own.vaultId, 'checkpoint.age'));
        const privateBefore = proxy.trace.filter(t => t.path.includes('/private-vault') || t.path.includes('/private-agent-wrap')).length;
        const denied = await other.sdk.callTool({ name: 'private_show', arguments: { id: f.copy } });
        expect(denied.isError).toBe(true);
        for (const hidden of ['PERSON PRIVATE', 'New version', f.copy, f.vaultId, f.bundle.records[0]!.body.artifact]) expect(JSON.stringify(denied.content)).not.toContain(hidden);
        expect(proxy.trace.filter(t => t.path.includes('/private-vault') || t.path.includes('/private-agent-wrap'))).toHaveLength(privateBefore);
        expect(await cacheState()).toEqual(foreignBefore);
        expect(await readFile(join(foreignCache, own.vaultId, 'checkpoint.age'))).toEqual(ownBefore);
        expect(await readFile(foreignState)).toEqual(foreignCredentials);
        expect(other.errors()).not.toContain('PERSON PRIVATE');
      } finally { await other.close(); }
      await expect(command(foreignState, foreignCache, 'private', 'show', f.copy)).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.not.stringContaining('PERSON PRIVATE') });
      const logs = await request(`/v1/journeys/${f.trip.id}/log`, 'GET', undefined, as(f.owner)); expect(await logs.text()).not.toContain('New version');
      expect(m.errors()).not.toContain('PERSON PRIVATE');
    } finally { await m.close(); await proxy.close(); }
  }, 180_000);

  it('a live reader-person agent can read, cannot write, and loses all access when removed; agent read scope does not cap a write-person', async () => {
    // The creator is the signed guide. It may downgrade itself to read-only.
    const f = await privateFixture(), reader = await connected(f.owner, f.trip, 'read');
    const readerState = await agentState(reader.session), cache = join(scratch, 'reader-' + newId()); reader.close();
    await command(f.state, f.cache, 'private', 'init'); // Backfill the newly admitted agent's encrypted content key.
    const m = await privateMcp(readerState, cache, true);
    try {
      // D45 derives capability from the person, not remembered approval scope.
      const created = await tool(m.sdk, 'private_create', { type: 'document', title: 'Scope parity' }); expect(created.status).toBe('staged');
      await m.advance(300_000);
      await change(f.trip, f.owner, 'member.role', { member: f.owner.principal, role: 'read-only' });
      expect((await tool(m.sdk, 'private_show', { id: f.copy })).content.title).toBe('PERSON PRIVATE CANARY');
      const before = await readFile(join(cache, f.vaultId, 'checkpoint.age'));
      await denyTool(m.sdk, 'private_create', { type: 'document', title: 'Denied' }, 'denied');
      await denyTool(m.sdk, 'private_backup', { path: join(scratch, 'denied-backup') }, 'denied');
      expect(await readFile(join(cache, f.vaultId, 'checkpoint.age'))).toEqual(before);
      await expect(command(readerState, cache, 'private', 'create', '--type', 'document', '--title', 'Denied')).rejects.toMatchObject({ stdout: '', stderr: expect.stringContaining('denied') });
      // Restore guide capability then remove the agent with signed ordinary authority.
      await change(f.trip, f.owner, 'member.role', { member: f.owner.principal, role: 'read-write' });
      await change(f.trip, f.owner, 'member.remove', { member: reader.session.principal });
      await denyTool(m.sdk, 'private_show', { id: f.copy }, 'ended');
      await expect(command(readerState, cache, 'private', 'list')).rejects.toMatchObject({ stdout: '', stderr: expect.stringContaining('ended') });
    } finally { await m.close(); }
  }, 180_000);
});

describe('Stage 3 independently admitted copies and handoff', () => {
  it('CLI cross-journey copy preserves author/origin with independent placement and deletion; handoff/return is encrypted to separately approved states', async () => {
    const f = await privateFixture();
    // Cross-journey agent copy keeps the *agent* author, not an inferred person.
    const authored = await command(f.state, f.cache, 'private', 'create', '--type', 'document', '--title', 'Agent source', '--body', 'private agent body');
    const original = await command(f.state, f.cache, 'private', 'show', authored.id);
    const dest = await privateDestination(f);
    const copied = await command(f.state, f.cache, 'private', 'copy', authored.id, '--predecessor', original.copy.head, '--destination-state', dest.state);
    expect(copied.status).toBe('staged');
    const copy = await command(dest.state, f.cache, 'private', 'show', copied.id);
    expect(copy.copy.author).toEqual(original.copy.author); expect(copy.copy.artifact).toBe(original.copy.artifact);
    expect(copy.copy.copy).not.toBe(original.copy.copy); expect(copy.copy.journey).toBe(dest.trip.id);
    expect(copy.copy.records[0].body.origin).toMatchObject({ journey: f.trip.id, copy: authored.id, artifact: original.copy.artifact, version: original.copy.head });
    expect(copy.content.title).toBe('Agent source'); expect(copy.copy.placement).toBeNull();
    await command(f.state, f.cache, 'private', 'delete', authored.id, '--predecessor', original.copy.head);
    expect((await command(dest.state, f.cache, 'private', 'show', copied.id)).content.title).toBe('Agent source');
    const destinationWriter = await privateMcp(dest.state, f.cache, true);
    try { await tool(destinationWriter.sdk, 'private_init'); await destinationWriter.advance(300_000); expect((await tool(destinationWriter.sdk, 'private_init')).status).toBe('committed'); }
    finally { await destinationWriter.close(); }
    const nextAgent = await connected(dest.owner, dest.trip), nextState = await agentState(nextAgent.session); nextAgent.close();
    await command(dest.state, f.cache, 'private', 'init');
    const handoff = join(scratch, 'private-handoff-' + newId());
    await command(dest.state, f.cache, 'private', 'handoff', '--output', handoff, '--destination-state', nextState);
    expect(await readFile(handoff, 'utf8')).not.toContain('Agent source');
    const nextCache = join(scratch, 'handoff-recipient-' + newId());
    await command(nextState, nextCache, 'private', 'import', handoff);
    const recipient = await privateMcp(nextState, nextCache, true);
    try {
      const c = await tool(recipient.sdk, 'private_show', { id: copied.id }); expect(c.copy.author).toEqual(original.copy.author);
      await tool(recipient.sdk, 'private_comment', { id: copied.id, text: 'Recipient private comment' });
      const returned = join(scratch, 'private-return-' + newId()); await tool(recipient.sdk, 'private_return', { path: returned, destinationState: dest.state });
      expect(await readFile(returned, 'utf8')).not.toContain('Recipient private comment');
      await recipient.advance(300_000);
      expect((await tool(recipient.sdk, 'private_init')).status).toBe('committed');
      // Import the return through the CLI into the separately approved original
      // agent. No source journey session is supplied by either subprocess.
      await command(dest.state, f.cache, 'private', 'import', returned);
      const roundTrip = await command(dest.state, f.cache, 'private', 'show', copied.id);
      expect(roundTrip.copy.author).toEqual(original.copy.author);
      expect(roundTrip.copy.records.at(-1).actor.signingKey).toBe(nextAgent.session.signingKey);
      expect(roundTrip.copy.payloads.at(-1).payload.body.text).toBe('Recipient private comment');
    } finally { await recipient.close(); }
  }, 240_000);
});
