import { mkdtemp, mkdir, chmod, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LINK_FALLBACK, NetworkError, networkFetch } from '../src/network.js';
import { requestConnection, resumeConnection, waitForApproval } from '../src/connection.js';
import { ExpiredStateError, loadState } from '../src/state.js';
import type { PendingState } from '../src/state.js';

const folders: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function path() { const parent = resolve('../..', '.scratch'); await mkdir(parent, { recursive: true }); const folder = await mkdtemp(join(parent, 'wayfinding-state-')); folders.push(folder); return join(folder, 'private', 'agent.json'); }
const requestId = 'request-id';
const response = (data: object, status = 200) => Response.json(data, { status });
const started = { id: requestId, approvalUrl: 'https://app.wayfinding.support/agent-sessions/' + requestId, code: '123456' };
const pendingResponse = (state: PendingState, status: string) => ({ status, journeyId: state.journeyId, recipient: state.recipient, signingKey: state.signingKey, requestedScope: state.requestedScope });

const journeyId = '01M3MGFPRB80Y0G5QTVVX19YN7';
describe('file-backed journey connection', () => {
  it('persists a pending request as 0600, refuses insecure existing files, and does not send arbitrary data', async () => {
    const file = await path();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ journeyId, agentPublicKey: { recipient: expect.any(String), signingKey: expect.any(String) }, requestedScope: 'read', remembered: false, keyStorage: 'file', name: 'Research assistant' });
      return response(started, 201);
    });
    const state = await requestConnection(journeyId, { state: file, name: 'Research assistant', fetch: fetcher });
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ status: 'pending', server: 'https://app.wayfinding.support', sessionId: requestId, requestedScope: 'read', identity: expect.any(String), signingPrivateKey: expect.any(String), expiresAt: state.expiresAt });
    await expect(requestConnection(journeyId, { state: file, fetch: fetcher })).rejects.toThrow('already exists');
    await chmod(file, 0o644);
    await expect(requestConnection(journeyId, { state: file, fetch: fetcher })).rejects.toThrow('0600');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('resumes approval, verifies the signed log through the client and caps state lifetime at eight hours', async () => {
    const file = await path();
    const state = await requestConnection(journeyId, { state: file, scope: 'readwrite', fetch: async () => response(started, 201) });
    const approved = { ...pendingResponse(state, 'approved'), principal: 'agent-principal', scope: 'readwrite', expiresAt: Date.now() + 3_600_000, remembered: false };
    const fetcher = vi.fn<typeof fetch>(async url => String(url).includes('agent-sessions') ? response(approved) : response({ error: { code: 'forbidden' } }, 403));
    // A failed full-log check does not turn pending keys into an approved session.
    await expect(resumeConnection(file, { fetch: fetcher, pollMs: 1, timeoutMs: 100 })).rejects.toThrow('Access to this journey has ended');
    expect((await loadState(file)).status).toBe('pending');
    expect(fetcher).toHaveBeenCalled();
  });
  it('deletes and refuses an expired pending file, including across a new process', async () => {
    const file = await path();
    const state = await requestConnection(journeyId, { state: file, fetch: async () => response(started, 201) });
    await writeFile(file, JSON.stringify({ ...state, createdAt: Date.now() - 600_000, expiresAt: Date.now() - 1 }), { mode: 0o600 });
    await expect(loadState(file)).rejects.toBeInstanceOf(ExpiredStateError);
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('deletes an expired approved state file as well', async () => {
    const file = await path();
    const state = await requestConnection(journeyId, { state: file, fetch: async () => response(started, 201) });
    const expiresAt = Date.now() - 1;
    const session = { server: state.server, journeyId, sessionId: state.sessionId, principal: 'agent', identity: state.identity, recipient: state.recipient, signingPrivateKey: state.signingPrivateKey, signingKey: state.signingKey, scope: 'read', expiresAt };
    await writeFile(file, JSON.stringify({ status: 'approved', session, createdAt: Date.now() - 600_000, expiresAt, link: state.link, code: state.code }));
    await expect(loadState(file)).rejects.toMatchObject({ exitCode: 3 });
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('maps pending timeout, expired and denied or locked-out approval to distinct exit codes', async () => {
    const file = await path();
    const state = await requestConnection(journeyId, { state: file, fetch: async () => response(started, 201) });
    await expect(waitForApproval(state, { state: file, timeoutMs: 8, pollMs: 1, fetch: async () => response(pendingResponse(state, 'pending')) })).rejects.toMatchObject({ exitCode: 2 });
    expect((await loadState(file)).status).toBe('pending');
    for (const status of ['denied', 'locked']) {
      await expect(waitForApproval(state, { state: file, pollMs: 1, fetch: async () => response(pendingResponse(state, status)) })).rejects.toMatchObject({ exitCode: 4 });
    }
    await expect(waitForApproval(state, { state: file, pollMs: 1, fetch: async () => response(pendingResponse(state, 'expired')) })).rejects.toMatchObject({ exitCode: 3 });
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('network failures', () => {
  it('reports the underlying cause and proxy/allowlist hint with exit code five', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1');
    const error = await networkFetch('https://app.wayfinding.support/v1/agent-sessions').catch(cause => cause) as NetworkError;
    expect(error.exitCode).toBe(5);
    expect(error.message).toMatch(/ECONNREFUSED|proxy error/i);
    expect(error.message).not.toContain('(fetch failed)');
    expect(error.message).toContain('proxy');
    expect(error.message).toContain('app.wayfinding.support');
    expect(error.message).toContain("If this environment can't reach app.wayfinding.support but you can read web pages, ask the person to open their journey, go to People & agents \u2192 Add agent by link, and give you the link. Read it with your web fetch tool; it returns JSON. That access is read-only.");
    expect(error.fallback).toBe(LINK_FALLBACK);
    expect(error.reason).not.toContain('web fetch');
  });
});
