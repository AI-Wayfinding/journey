import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newId, MAX_BLOB_BYTES, ARTIFACT_FORMAT, artifactTypeHash, hashControlProof, importSigningKey, sealArtifactPayload, signControlProof, sealBlob } from '@ai-wayfinding/core';
import { JourneyClient } from '../src/journey.js';
import { signedHeaders } from '../src/signing.js';
import { localServer, person, journey, connected, change, refresh, addPerson, scratch, server, command, failedCommand, state, mcp, approvedMcp, tool, failedTool, proxy } from './stage1-fixtures.js';
localServer();

describe('Stage 1 real CLI and stdio MCP artifacts', () => {
  it('CLI creates all active types, maps aliases, imports packages and round-trips explicit local bytes', async () => {
    const owner = await person(), trip = await journey(owner), agent = await connected(owner, trip), file = await state(agent);
    try {
      const binary = join(scratch, 'raw.bin'), bytes = Buffer.from([0, 255, 128, 42, 10]); await writeFile(binary, bytes);
      const cases = [
        ['document', '--body', '# Private markdown'], ['skill', '--body', '# Skill text'], ['prompt', '--body', 'Do the work'],
        ['image', '--file', binary], ['file', '--file', binary], ['data', '--format', 'json', '--body', '{"ok":true}'],
        ['link', '--url', 'https://example.org/resource', '--summary', 'Supplied summary', '--notes', 'No fetching']
      ];
      for (const [type, ...args] of cases) {
        const item = await command(file, 'add', '--type', type!, '--title', 'CLI ' + type, '--tags', 'Tag,tag,Tag', ...args);
        expect(item).toMatchObject({ itemType: type, author: agent.session.principal, writer: agent.session.principal, authoredBy: 'agent', tags: ['Tag', 'tag'] });
        expect((await command(file, 'show', item.id)).item).toEqual(item);
        expect((await command(file, 'list', '--type', type!, '--tag', 'Tag')).map((v: { id: string }) => v.id)).toContain(item.id);
        if (item.payload.attachments.length) {
          const output = join(scratch, newId() + '.bin');
          await command(file, 'download', item.id, '--blob', item.payload.attachments[0].blob.id, '--output', output);
          expect(await readFile(output)).toEqual(bytes);
          await failedCommand(file, 'EEXIST', 'download', item.id, '--blob', item.payload.attachments[0].blob.id, '--output', output);
        }
      }
      const limitBytes = Buffer.alloc(MAX_BLOB_BYTES, 163), limitFile = join(scratch, 'limit.bin'), limitOutput = join(scratch, 'limit-download.bin');
      await writeFile(limitFile, limitBytes);
      const limitItem = await command(file, 'add', '--type', 'file', '--title', 'Exact limit', '--file', limitFile);
      expect(limitItem.payload.attachments[0].blob).toMatchObject({ size: MAX_BLOB_BYTES, ciphertextSize: MAX_BLOB_BYTES + 16 });
      await command(file, 'download', limitItem.id, '--blob', limitItem.payload.attachments[0].blob.id, '--output', limitOutput);
      expect((await readFile(limitOutput)).equals(limitBytes)).toBe(true);
      for (const category of ['note','decision','question','learning','tension','practice','success','resource','position','interview','lesson','custom-category']) {
        const item = await command(file, 'create', '--type', category, '--title', category, '--body', 'Alias', '--tags', category + ',custom');
        expect(item.itemType).toBe('document'); expect(item.tags).toEqual([category, 'custom']);
      }
      const md = join(scratch, 'import.md');
      await writeFile(md, '---\ntitle: Imported\ntype: lesson\ntags: [lesson, FromFile]\nauthor: somebody\ncreated: forged\naccessChanges: remove\n---\nMarkdown body');
      const imported = (await command(file, 'import', md))[0];
      expect(imported).toMatchObject({ itemType: 'document', tags: ['lesson', 'FromFile'], author: agent.session.principal, body: 'Markdown body' });
      expect(imported.created).not.toBe('forged'); expect(imported.payload).not.toHaveProperty('accessChanges');
      const pkg = join(scratch, 'skill-package'); await mkdir(join(pkg, 'examples'), { recursive: true });
      await writeFile(join(pkg, 'SKILL.md'), '# Local skill'); await writeFile(join(pkg, 'examples', 'example.bin'), bytes);
      const skill = await command(file, 'import-skill', pkg, '--title', 'Packaged skill');
      expect(skill.payload.content).toEqual({ kind: 'skill', skill: '# Local skill' }); expect(skill.payload.attachments[0].path).toBe('examples/example.bin');
      const output = join(scratch, 'skill-download.bin');
      await command(file, 'download', skill.id, '--blob', skill.payload.attachments[0].blob.id, '--output', output); expect(await readFile(output)).toEqual(bytes);
      expect((await command(file, 'search', 'markdown')).map((v: { title: string }) => v.title)).toContain('CLI document');
      for (const type of ['html','applet','sensemaking-document','recovery']) await failedCommand(file, type === 'recovery' ? 'Recovery' : 'reserved', 'add', '--type', type, '--title', 'No', '--body', 'No');
      await failedCommand(file, 'Unsupported', 'add', '--type', 'data', '--title', 'No', '--format', 'xml', '--body', 'No');
      await failedCommand(file, 'Unsupported artifact', 'add', '--type', 'link', '--title', 'No', '--url', 'javascript:alert(1)');
      expect((await command(file, 'list')).some((v: { itemType: string }) => v.itemType === 'recovery')).toBe(false);
      await refresh(trip, owner);
      const publicText = JSON.stringify(trip.entries.map(c => c.proof));
      expect(publicText).not.toContain('Private markdown'); expect(publicText).not.toContain('example.bin');
    } finally { agent.close(); }
  }, 120_000);

  it('stdio MCP approval, immutable attribution, versions/comments, conflicts, retained attachments and deletion', async () => {
    const owner = await person(), trip = await journey(owner), sdk = await approvedMcp(owner, trip);
    const second = await connected(owner, trip), file = await state(second);
    try {
      const binary = join(scratch, 'mcp.bin'), bytes = Buffer.from('private MCP attachment'); await writeFile(binary, bytes);
      const item = await tool(sdk, 'add', { type: 'prompt', title: 'MCP prompt', body: 'Original prompt', tags: ['shared'], files: [{ path: binary }], author: owner.principal, writer: owner.principal, actor: owner.principal, grants: ['members.manage'], accessChanges: [{ action: 'remove' }] });
      expect(item.author).not.toBe(owner.principal); expect(item.writer).toBe(item.author); expect(item.authoredBy).toBe('agent');
      for (const key of ['grants','accessChanges','actor']) { expect(item).not.toHaveProperty(key); expect(item.payload).not.toHaveProperty(key); }
      const edited = await command(file, 'edit', item.id, '--predecessor', item.version, '--type', 'prompt', '--title', 'Edited prompt', '--body', 'Second signer', '--tags', 'shared,new');
      expect(edited).toMatchObject({ id: item.id, author: item.author, writer: second.session.principal }); expect(edited.version).not.toBe(item.version);
      expect(edited.payload.attachments).toEqual(item.payload.attachments);
      await failedTool(sdk, 'edit', 'conflict', { id: item.id, predecessor: item.version, type: 'prompt', title: 'Stale', body: 'Must not win' });
      await failedCommand(file, 'conflict', 'edit', item.id, '--predecessor', item.version, '--type', 'prompt', '--title', 'Stale', '--body', 'No');
      await failedTool(sdk, 'edit', 'conflict', { id: item.id, predecessor: edited.version, type: 'document', title: 'Change type', body: 'No' });
      const latest = await tool(sdk, 'edit', { id: item.id, predecessor: edited.version, type: 'prompt', title: 'Final prompt', body: 'Third version', tags: ['shared'] });
      const comment = await tool(sdk, 'comment', { id: item.id, text: 'Whole artifact', onVersion: item.version, author: owner.principal });
      expect(comment).toMatchObject({ item: item.id, onVersion: item.version, author: item.author, actor: item.author, body: 'Whole artifact' });
      await command(file, 'comment', item.id, 'CLI context', '--version', edited.version);
      expect((await tool(sdk, 'comments', { id: item.id })).length).toBe(2);
      expect((await command(file, 'versions', item.id)).map((v: { actor: string }) => v.actor)).toEqual([item.author, second.session.principal, item.author]);
      expect((await tool(sdk, 'versions', { id: item.id })).length).toBe(3);
      expect((await tool(sdk, 'show', { id: item.id })).item.version).toBe(latest.version);
      expect((await tool(sdk, 'list', { type: 'prompt', tag: 'shared' })).length).toBe(1);
      expect((await tool(sdk, 'search', { text: 'Third version' }))[0].id).toBe(item.id);
      const replacement = await tool(sdk, 'edit', { id: item.id, predecessor: latest.version, type: 'prompt', title: 'No attachments', body: 'Fourth version', files: [] });
      expect(replacement.payload.attachments).toEqual([]);
      const output = join(scratch, 'mcp-download.bin');
      await tool(sdk, 'download', { id: item.id, blob: item.payload.attachments[0].blob.id, path: output, version: item.version }); expect(await readFile(output)).toEqual(bytes);
      await failedTool(sdk, 'comment', 'conflict', { id: item.id, text: 'No', onVersion: newId() });
      const deleted = await tool(sdk, 'delete', { id: item.id }); expect(deleted.warning).toContain('not securely erased');
      expect(await command(file, 'list')).toEqual([]); expect(await tool(sdk, 'search', { text: 'prompt' })).toEqual([]);
      await failedTool(sdk, 'show', 'No journey artifact', { id: item.id });
      await failedCommand(file, 'No journey artifact', 'download', item.id, '--blob', item.payload.attachments[0].blob.id, '--output', join(scratch, 'deleted.bin'));
      const disposable = await tool(sdk, 'add', { type: 'document', title: 'CLI delete', body: 'Gone' });
      expect((await command(file, 'delete', disposable.id)).warning).toContain('cannot be recalled');
      await refresh(trip, owner); expect(trip.entries.filter(c => c.proof.type === 'artifact.version')).toHaveLength(3);
      expect(JSON.stringify(trip.entries.map(c => c.proof))).not.toContain('accessChanges');
    } finally { await sdk.close(); second.close(); }
  }, 90_000);

  it('MCP supports active content, explicit imports and refuses unrequested host paths and oversize files', async () => {
    const owner = await person(), trip = await journey(owner), agent = await connected(owner, trip), file = await state(agent), sdk = await mcp(file);
    try {
      const binary = join(scratch, 'zero.bin'); await writeFile(binary, Buffer.alloc(0));
      for (const type of ['skill','prompt','document','image','file','data','link']) {
        const item = await tool(sdk, 'add', { type, title: 'MCP ' + type, body: 'Text', ...(type === 'image' || type === 'file' ? { files: [{ path: binary }] } : {}), ...(type === 'data' ? { format: 'yaml' } : {}), ...(type === 'link' ? { url: 'http://example.org', summary: 'Supplied', notes: 'Notes' } : {}) });
        expect(item.itemType).toBe(type);
        if (item.payload.attachments.length) { const path = join(scratch, newId()); await tool(sdk, 'download', { id: item.id, blob: item.payload.attachments[0].blob.id, path }); expect((await readFile(path)).length).toBe(0); }
      }
      const pkg = join(scratch, 'mcp-skill'); await mkdir(pkg); await writeFile(join(pkg, 'SKILL.md'), '# MCP package');
      expect((await tool(sdk, 'import_skill', { path: pkg, title: 'Imported skill' })).itemType).toBe('skill');
      const md = join(scratch, 'mcp-import.md'); await writeFile(md, '---\ntype: position\n---\nPosition text');
      expect((await tool(sdk, 'import', { path: md }))[0].tags).toEqual(['position']);
      const oversized = join(scratch, 'too-large.bin'); await writeFile(oversized, Buffer.alloc(MAX_BLOB_BYTES + 1));
      await failedTool(sdk, 'add', '25,000,000', { type: 'file', title: 'Too large', files: [{ path: oversized }] });
      await failedCommand(file, '25,000,000', 'add', '--type', 'file', '--title', 'Too large', '--file', oversized);
      const link = join(scratch, 'symlink.bin'); await symlink(binary, link);
      await failedTool(sdk, 'add', 'regular local file', { type: 'file', title: 'No symlinks', files: [{ path: link }] });
      await failedTool(sdk, 'add', 'Unknown attachment field', { type: 'file', title: 'No extra fields', files: [{ path: binary, author: owner.principal }] });
      await failedTool(sdk, 'add', 'Invalid artifact attachment', { type: 'prompt', title: 'No traversal', body: 'No', files: [{ path: binary, packagePath: '../escape' }] });
      await failedTool(sdk, 'add', 'explicit local', { type: 'file', title: 'No remote', url: 'https://example.org/file' });
      expect((await tool(sdk, 'list')).length).toBe(9);
    } finally { await sdk.close(); agent.close(); }
  }, 90_000);

  it('interrupted uploads create no artifacts; incomplete and foreign staged references cannot commit', async () => {
    const owner = await person(), trip = await journey(owner), agent = await connected(owner, trip);
    const binary = join(scratch, 'interrupted.bin'); await writeFile(binary, 'Upload must complete');
    let id = '';
    const interrupted = new JourneyClient(agent.session, { fetch: async (url, init) => {
      if (init?.method === 'PUT') throw new Error('Interrupted local upload');
      const result = await fetch(url, init);
      if (init?.method === 'POST' && String(url).endsWith('/blobs')) id = (await result.clone().json()).id;
      return result;
    } });
    const signed = async (path: string, method: string, body: string | Uint8Array, extra: Record<string, string> = {}) => fetch(server + path, { method, headers: { ...await signedHeaders(agent.session.signingPrivateKey, method, path, body), 'X-Agent-Session': agent.session.sessionId, 'X-Client-Version': '0.1.5', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': ARTIFACT_FORMAT, Origin: server, 'X-Wayfinding': '1', ...extra }, body });
    try {
      await expect(interrupted.add({ type: 'file', title: 'No partial artifact', files: [{ path: binary }] })).rejects.toThrow('Interrupted local upload');
      expect(await agent.list()).toEqual([]); expect(id).not.toBe('');
      const sealed = await sealBlob(new Uint8Array(Buffer.from('Upload must complete')), { journey: trip.id, id, epoch: 1 }, trip.key);
      await refresh(trip, owner);
      const at = new Date().toISOString(), body = { format: ARTIFACT_FORMAT, artifact: newId(), author: agent.session.principal, actor: agent.session.principal, version: newId(), typeHash: await artifactTypeHash('file'), blobs: [sealed.descriptor] };
      const envelope = await sealArtifactPayload('artifact.create', body, { title: 'No incomplete reference', tags: [], content: { kind: 'file', primary: id }, attachments: [{ blob: sealed.descriptor, name: 'private.bin', mime: 'application/octet-stream' }] }, { id: newId(), journey: trip.id, seq: trip.entries.length, epoch: 1, createdAt: at }, trip.key);
      const proof = await signControlProof({ v: 1, seq: trip.entries.length, prev: await hashControlProof(trip.entries.at(-1)!.proof), at, actor: agent.session.principal, type: 'artifact.create', body }, envelope, trip.id, await importSigningKey(agent.session.signingPrivateKey));
      expect((await signed('/v1/journeys/' + trip.id + '/log', 'POST', JSON.stringify({ control: { proof, envelope } }), { 'Content-Type': 'application/json' })).status).toBe(409);
      expect(await agent.list()).toEqual([]);
      // A staged blob belongs to this uploader. Another currently approved writer cannot finish it.
      const other = await connected(owner, trip);
      try {
        const path = `/v1/journeys/${trip.id}/blobs/${id}`;
        const response = await fetch(server + path, { method: 'PUT', headers: { ...await signedHeaders(other.session.signingPrivateKey, 'PUT', path, sealed.ciphertext), 'X-Agent-Session': other.session.sessionId, 'X-Client-Version': '0.1.5', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': ARTIFACT_FORMAT, Origin: server, 'X-Wayfinding': '1', 'Content-Type': 'application/octet-stream', 'X-Blob-Descriptor': JSON.stringify(sealed.descriptor) }, body: new Uint8Array(sealed.ciphertext) });
        expect(response.status).toBe(403);
      } finally { other.close(); }
    } finally { interrupted.close(); agent.close(); }
  }, 60_000);

  it('CLI and live MCP obey current inherited access, read-only approval and removal', async () => {
    const guide = await person(), trip = await journey(guide), adding = await addPerson(trip, guide);
    const writer = await connected(adding, trip), reader = await connected(adding, trip, 'read');
    const file = await state(writer), readerFile = await state(reader), sdk = await mcp(file);
    try {
      const item = await command(file, 'add', '--type', 'document', '--title', 'Access check', '--body', 'Original');
      await failedCommand(readerFile, 'read-only', 'add', '--type', 'document', '--title', 'No', '--body', 'No');
      await change(trip, guide, 'member.role', { member: adding.principal, role: 'read-only' });
      expect((await command(file, 'status')).scope).toBe('read'); expect((await tool(sdk, 'status')).scope).toBe('read');
      await failedCommand(file, 'read-only', 'edit', item.id, '--predecessor', item.version, '--type', 'document', '--title', 'No', '--body', 'No');
      for (const [name, args] of [['add', { type: 'document', title: 'No', body: 'No' }], ['comment', { id: item.id, text: 'No' }], ['delete', { id: item.id }]] as const) await failedTool(sdk, name, 'read-only', args);
      expect((await tool(sdk, 'show', { id: item.id })).item.title).toBe('Access check');
      await change(trip, guide, 'member.role', { member: adding.principal, role: 'read-write' });
      const edited = await tool(sdk, 'edit', { id: item.id, predecessor: item.version, type: 'document', title: 'Restored', body: 'Allowed' }); expect(edited.title).toBe('Restored');
      expect((await command(readerFile, 'status')).scope).toBe('read');
      await change(trip, guide, 'member.remove', { member: adding.principal });
      for (const commandName of ['status','list','show']) await failedCommand(file, 'Access to this journey has ended', commandName, item.id);
      for (const name of ['list','show','delete']) await failedTool(sdk, name, 'Access to this journey has ended', { id: item.id });
    } finally { await sdk.close(); writer.close(); reader.close(); }
  }, 60_000);

  it('downgrade after binary upload prevents the artifact commit', async () => {
    const guide = await person(), trip = await journey(guide), adding = await addPerson(trip, guide), agent = await connected(adding, trip);
    const binary = join(scratch, 'downgrade.bin'); await writeFile(binary, 'Race');
    const racing = new JourneyClient(agent.session, { fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === 'PUT' && response.ok) await change(trip, guide, 'member.role', { member: adding.principal, role: 'read-only' });
      return response;
    } });
    try { await expect(racing.add({ type: 'file', title: 'No race artifact', files: [{ path: binary }] })).rejects.toThrow('read-only'); expect(await agent.list()).toEqual([]); }
    finally { racing.close(); agent.close(); }
  }, 60_000);

  it('CLI and live MCP fail closed for unsupported actions, capability and newer minimum without reconnecting', async () => {
    const owner = await person(), trip = await journey(owner), agent = await connected(owner, trip);
    let gate = '';
    const transport = await proxy((path, _method, text, status) => {
      if (status !== 200) return text;
      if (gate === 'action' && path.includes('/log')) { const data = JSON.parse(text); data.log.at(-1).proof.type = 'artifact.future'; return JSON.stringify(data); }
      if (gate === 'format' && path.includes('/protocol')) { const data = JSON.parse(text); data.artifactFormat = 'artifact-v2'; return JSON.stringify(data); }
      return text;
    });
    const file = await state(agent, transport.origin), sdk = await mcp(file), saved = await readFile(file);
    try {
      const item = await tool(sdk, 'add', { type: 'document', title: 'Before upgrade', body: 'Private content' });
      for (const mode of ['action','format','minimum']) {
        gate = mode;
        if (mode === 'minimum') await change(trip, owner, 'client.minVersion', { version: '0.1.8' }, {}, { 'X-Client-Version': '0.1.8' });
        transport.requests.length = 0;
        await failedCommand(file, 'do not need to connect or be approved again', 'show', item.id);
        await failedCommand(file, 'npm install -g @ai-wayfinding/client@latest', 'add', '--type', 'document', '--title', 'No', '--body', 'No');
        for (const name of ['status','list','show','edit','delete']) await failedTool(sdk, name, 'npm install -g @ai-wayfinding/client@latest', { id: item.id, predecessor: item.version, type: 'document', title: 'No', body: 'No' });
        expect(transport.requests.some(r => r.method !== 'GET' || r.path.includes('/agent-sessions'))).toBe(false);
        expect(await readFile(file)).toEqual(saved);
      }
    } finally { await sdk.close(); agent.close(); await transport.close(); }
  }, 60_000);
});
