import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
const scratch = resolve('../..', '.scratch', 'client-unit');
beforeAll(async () => { await mkdir(scratch, { recursive: true }); });
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });
import { describe, expect, it, vi } from 'vitest';
import { generateJourneyKey, newId, seal } from '@ai-wayfinding/core';
import { forgetRemembered, loadRemembered, saveRemembered, type RememberedAgent } from '../src/storage.js';
import { readCache, writeCache } from '../src/cache.js';
const sample: RememberedAgent = { server: 'https://app.wayfinding.support', journeyId: 'journey-id', sessionId: 'session-id', principal: 'agent-id', identity: 'AGE-SECRET-KEY-PRIVATE', recipient: 'age1test', signingPrivateKey: 'SIGNING-SECRET-PRIVATE', signingKey: 'public', scope: 'readwrite', expiresAt: Date.now() + 86_400_000 };

describe('remembered agent keys', () => {
  it('stores and retrieves using macOS security without exposing keys in command arguments', async () => {
    let saved = '';
    const run = vi.fn(async (command: string, args: string[], input?: string): Promise<string> => { expect(command).toBe('security'); expect(args.join(' ')).not.toContain('SECRET'); if (args[0] === '-i') { saved = input!.match(/-w \"([^\"]+)/)![1]!; return ''; } return args[0] === 'find-generic-password' ? saved : ''; });
    await saveRemembered(sample, { platform: 'darwin', run });
    expect(await loadRemembered({ platform: 'darwin', run })).toEqual(sample);
    await forgetRemembered({ platform: 'darwin', run });
    expect(run.mock.calls.some(call => call[1][0] === 'delete-generic-password')).toBe(true);
  });
  it('stores and retrieves through Linux secret-tool stdin, never in argv', async () => {
    let saved = '';
    const run = vi.fn(async (command: string, args: string[], input?: string): Promise<string> => { expect(command).toBe('secret-tool'); expect(args.join(' ')).not.toContain('SECRET'); if (args[0] === 'store') saved = input!; return args[0] === 'lookup' ? saved : ''; });
    await saveRemembered(sample, { platform: 'linux', run });
    expect(await loadRemembered({ platform: 'linux', run })).toEqual(sample);
    await forgetRemembered({ platform: 'linux', run });
    expect(run.mock.calls.some(call => call[1][0] === 'clear')).toBe(true);
  });
  it('age-encrypts a key-folder file, refuses a wrong passphrase, and uses private permissions', async () => {
    const folder = await mkdtemp(join(scratch, 'journey-keys-'));
    await saveRemembered(sample, { folder, passphrase: 'correct horse battery staple' });
    const disk = await readFile(join(folder, 'agent.age'));
    expect(disk.toString()).not.toContain('AGE-SECRET-KEY-PRIVATE');
    expect(disk.toString()).not.toContain('SIGNING-SECRET-PRIVATE');
    await expect(loadRemembered({ folder, passphrase: 'wrong' })).rejects.toThrow();
    expect(await loadRemembered({ folder, passphrase: 'correct horse battery staple' })).toEqual(sample);
    if (process.platform !== 'win32') {
      expect((await stat(folder)).mode & 0o777).toBe(0o700);
      expect((await stat(join(folder, 'agent.age'))).mode & 0o777).toBe(0o600);
    }
    await forgetRemembered({ folder });
    await expect(loadRemembered({ folder, passphrase: 'correct horse battery staple' })).resolves.toBeNull();
  });
  it('rejects an expired or too-long remembered session and unsupported platforms', async () => {
    const folder = await mkdtemp(join(scratch, 'journey-expired-'));
    await expect(saveRemembered({ ...sample, expiresAt: Date.now() + 91 * 86_400_000 }, { folder, passphrase: 'safe' })).rejects.toThrow(/90 days/);
    await expect(saveRemembered({ ...sample, expiresAt: Date.now() - 1 }, { folder, passphrase: 'safe' })).rejects.toThrow(/expired/);
    await expect(loadRemembered({ platform: 'linux', run: async () => JSON.stringify({ ...sample, expiresAt: Date.now() - 1 }) })).rejects.toThrow(/expired/);
    await expect(saveRemembered(sample, { platform: 'win32' })).rejects.toThrow(/not supported/);
  });
});

describe('encrypted journey cache', () => {
  it('keeps only ciphertext and verified head, never item title or body, with private permissions', async () => {
    const folder = await mkdtemp(join(scratch, 'journey-cache-'));
    const journeyId = newId(), key = generateJourneyKey();
    const envelope = await seal({ type: 'item', typeVersion: 1, body: { title: 'Sensitive title', body: 'Sensitive body' } }, { id: newId(), journey: journeyId, seq: 1, epoch: 1, createdAt: new Date().toISOString() }, key);
    const path = await writeCache(folder, journeyId, { seq: 2, hash: 'verified-hash', log: [{ seq: 0, entry: 'ciphertext' }], records: [envelope] });
    const contents = await readFile(path, 'utf8');
    expect(contents).not.toMatch(/Sensitive title|Sensitive body/);
    expect(await readCache(folder, journeyId)).toMatchObject({ seq: 2, hash: 'verified-hash' });
    if (process.platform !== 'win32') {
      expect((await stat(join(folder, 'ai-wayfinding', 'journeys'))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });
});
