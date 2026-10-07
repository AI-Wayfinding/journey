import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RememberedAgent } from './storage.js';

export interface PendingState {
  status: 'pending'; server: string; journeyId: string; sessionId: string; identity: string; recipient: string;
  signingPrivateKey: string; signingKey: string; link: string; code: string; expiresAt: number; createdAt: number;
}
export interface ApprovedState { status: 'approved'; session: RememberedAgent; link: string; code: string; createdAt: number; expiresAt: number }
export type AgentState = PendingState | ApprovedState;
export class ExpiredStateError extends Error {
  readonly exitCode = 3;
  constructor(message: string, readonly state?: AgentState) { super(message); }
}
export class DeniedStateError extends Error { readonly exitCode = 4; }
const invalid = () => new Error('Invalid journey state file. Connect again.');
const permissions = () => new Error('Journey state file must be owned by you, be a regular file, and have permissions 0600.');

async function check(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || process.getuid && info.uid !== process.getuid()) throw permissions();
}
export async function loadState(path: string): Promise<AgentState> {
  await check(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: unknown;
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || process.getuid && info.uid !== process.getuid()) throw permissions();
    value = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
  } finally { await handle.close(); }
  if (!value || typeof value !== 'object') throw invalid();
  const state = value as AgentState;
  if ((state.status !== 'pending' && state.status !== 'approved') || !Number.isFinite(state.createdAt) || !Number.isFinite(state.expiresAt) || state.expiresAt <= state.createdAt || state.expiresAt > state.createdAt + 8 * 3_600_000 || typeof state.link !== 'string' || typeof state.code !== 'string') throw invalid();
  if (state.status === 'pending') {
    if (!['server', 'journeyId', 'sessionId', 'identity', 'recipient', 'signingPrivateKey', 'signingKey'].every(key => typeof state[key as keyof PendingState] === 'string' && state[key as keyof PendingState])) throw invalid();
  } else {
    const session = state.session;
    if (!session || !['server', 'journeyId', 'sessionId', 'principal', 'identity', 'recipient', 'signingPrivateKey', 'signingKey'].every(key => typeof session[key as keyof RememberedAgent] === 'string' && session[key as keyof RememberedAgent]) || session.scope !== 'read' && session.scope !== 'readwrite' || session.expiresAt !== state.expiresAt) throw invalid();
  }
  if (state.expiresAt <= Date.now()) { await rm(path); throw new ExpiredStateError('Journey state file expired and was deleted. Connect again.', state); }
  return state;
}
export async function ensureNewStatePath(path: string): Promise<void> {
  try { await check(path); throw new Error('Journey state file already exists. Choose a new --state file.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function saveState(path: string, state: AgentState, requireNew = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let exists = false;
  try { await check(path); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists && requireNew) throw new Error('Journey state file already exists. Choose a new --state file.');
  if (!exists) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(state)); } finally { await handle.close(); }
    return;
  }
  // Replacement is atomic: readers cannot observe a partially written session.
  const temp = join(dirname(path), '.wayfinding-' + crypto.randomUUID());
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(state)); } finally { await handle.close(); }
    await check(path);
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
