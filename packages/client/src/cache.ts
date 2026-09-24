import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isId } from '@ai-wayfinding/core';
import type { Envelope } from '@ai-wayfinding/core';
export interface CipherRow { seq: number; entry: string }
export interface CipherCache { seq: number; hash: string; log: CipherRow[]; records: Envelope[] }
function directory(root: string): string { return join(root, 'ai-wayfinding', 'journeys'); }
function location(root: string, journeyId: string): string {
  if (!isId(journeyId)) throw new Error('Invalid journey ID');
  return join(directory(root), journeyId + '.json');
}
/** Only copy ciphertext envelopes and the head of a fully verified signed log. */
export async function writeCache(root: string, journeyId: string, cache: CipherCache): Promise<string> {
  const path = location(root, journeyId), dir = directory(root);
  await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(join(root, 'ai-wayfinding'), 0o700); await chmod(dir, 0o700);
  const safe: CipherCache = { seq: cache.seq, hash: cache.hash, log: cache.log.map(row => ({ seq: row.seq, entry: row.entry })), records: cache.records.map(row => ({ outside: { v: 1, id: row.outside.id, journey: row.outside.journey, seq: row.outside.seq, epoch: row.outside.epoch, size: row.outside.size, createdAt: row.outside.createdAt }, nonce: row.nonce, ciphertext: row.ciphertext })) };
  const temp = join(dir, '.' + crypto.randomUUID());
  try { await writeFile(temp, JSON.stringify(safe), { mode: 0o600, flag: 'wx' }); await rename(temp, path); await chmod(path, 0o600); }
  finally { await rm(temp, { force: true }); }
  return path;
}
export async function readCache(root: string, journeyId: string): Promise<CipherCache | null> {
  let value: unknown;
  try { value = JSON.parse(await readFile(location(root, journeyId), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!value || typeof value !== 'object') throw new Error('Invalid journey cache');
  const row = value as CipherCache;
  if (!Number.isSafeInteger(row.seq) || typeof row.hash !== 'string' || !Array.isArray(row.log) || !Array.isArray(row.records)) throw new Error('Invalid journey cache');
  return row;
}
export async function forgetCache(root: string, journeyId: string): Promise<void> { await rm(location(root, journeyId), { force: true }); }
