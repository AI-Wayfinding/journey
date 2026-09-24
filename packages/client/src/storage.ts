import * as age from 'age-encryption';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface RememberedAgent { server: string; journeyId: string; sessionId: string; principal: string; identity: string; recipient: string; signingPrivateKey: string; signingKey: string; scope: 'read' | 'readwrite'; expiresAt: number }
export type CommandRunner = (command: string, args: string[], input?: string) => Promise<string>;
export interface StoreOptions { folder?: string; passphrase?: string; platform?: NodeJS.Platform; run?: CommandRunner }
const service = 'ai-wayfinding-journey-agent';
const account = 'remembered-session';
const location = (folder: string): string => join(folder, 'agent.age');

export const runCommand: CommandRunner = (command, args, input) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; if (output.length > 1_000_000) child.kill(); });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { error += chunk; if (error.length > 1_000_000) child.kill(); });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(command + ' could not access the OS keychain. ' + (error.includes('not found') ? 'Install or unlock it.' : 'Check that it is available and unlocked.'))));
  child.stdin.end(input);
});
function validate(value: unknown): RememberedAgent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved journey keys. Disconnect and connect again.');
  const row = value as Record<string, unknown>;
  for (const key of ['server', 'journeyId', 'sessionId', 'principal', 'identity', 'recipient', 'signingPrivateKey', 'signingKey']) if (typeof row[key] !== 'string' || !row[key]) throw new Error('Invalid saved journey keys. Disconnect and connect again.');
  if (row.scope !== 'read' && row.scope !== 'readwrite' || typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt)) throw new Error('Invalid saved journey keys. Disconnect and connect again.');
  if (row.expiresAt <= Date.now()) throw new Error('Your journey agent access has expired. Disconnect and connect again.');
  return { server: row.server as string, journeyId: row.journeyId as string, sessionId: row.sessionId as string, principal: row.principal as string, identity: row.identity as string, recipient: row.recipient as string, signingPrivateKey: row.signingPrivateKey as string, signingKey: row.signingKey as string, scope: row.scope, expiresAt: row.expiresAt };
}
function supported(options: StoreOptions): { platform: NodeJS.Platform; run: CommandRunner } {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('Remembered journey keys are not supported on this OS. Use --key-folder with a passphrase instead.');
  return { platform, run: options.run ?? runCommand };
}
async function privateFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const info = await stat(folder);
  if (!info.isDirectory()) throw new Error('Key folder must be a directory');
  await chmod(folder, 0o700);
}
function requirePassphrase(options: StoreOptions): string {
  if (!options.passphrase) throw new Error('A passphrase is required for the journey key folder. Set WAYFINDING_PASSPHRASE or use the prompt.');
  return options.passphrase;
}
export async function saveRemembered(value: RememberedAgent, options: StoreOptions = {}): Promise<void> {
  if (value.expiresAt <= Date.now()) throw new Error('Your journey agent access has expired.');
  if (value.expiresAt > Date.now() + 90 * 86_400_000 + 60_000) throw new Error('Remembered journey access cannot last more than 90 days.');
  const json = JSON.stringify(validate(value));
  if (options.folder) {
    await privateFolder(options.folder);
    const cipher = new age.Encrypter(); cipher.setPassphrase(requirePassphrase(options));
    const bytes = await cipher.encrypt(new TextEncoder().encode(json));
    const temp = join(options.folder, '.agent-' + crypto.randomUUID());
    try { await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' }); await rename(temp, location(options.folder)); await chmod(location(options.folder), 0o600); }
    finally { await rm(temp, { force: true }); }
    return;
  }
  const { platform, run } = supported(options);
  if (platform === 'linux') { await run('secret-tool', ['store', '--label=Wayfinding journey agent', 'service', service, 'account', account], json); return; }
  // security add-generic-password accepts passwords only in argv. Its interactive mode reads
  // a base64url-encoded command from stdin instead, keeping the key out of the process list.
  const encoded = Buffer.from(json).toString('base64url');
  await run('security', ['-i'], 'add-generic-password -U -s "' + service + '" -a "' + account + '" -w "' + encoded + '"\nquit\n');
}
export async function loadRemembered(options: StoreOptions = {}): Promise<RememberedAgent | null> {
  let raw: string;
  if (options.folder) {
    let bytes: Buffer;
    try { bytes = await readFile(location(options.folder)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const decipher = new age.Decrypter(); decipher.addPassphrase(requirePassphrase(options));
    raw = new TextDecoder().decode(await decipher.decrypt(bytes));
  } else {
    const { platform, run } = supported(options);
    try { raw = platform === 'darwin' ? Buffer.from(await run('security', ['find-generic-password', '-s', service, '-a', account, '-w']), 'base64url').toString() : await run('secret-tool', ['lookup', 'service', service, 'account', account]); }
    catch { return null; }
  }
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Invalid saved journey keys. Disconnect and connect again.'); }
  return validate(value);
}
export async function forgetRemembered(options: StoreOptions = {}): Promise<void> {
  if (options.folder) { await rm(location(options.folder), { force: true }); return; }
  const { platform, run } = supported(options);
  try { await (platform === 'darwin' ? run('security', ['delete-generic-password', '-s', service, '-a', account]) : run('secret-tool', ['clear', 'service', service, 'account', account])); } catch { /* No saved key. */ }
}
