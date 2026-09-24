#!/usr/bin/env node
import { homedir } from 'node:os';
import { stdin, stderr } from 'node:process';
import { join } from 'node:path';
import { connectJourney } from './connection.js';
import { importMarkdown } from './import.js';
import { JourneyClient } from './journey.js';
import { runMcp } from './mcp.js';
import { forgetRemembered, loadRemembered } from './storage.js';

const help = `wayfinding — read and write an approved journey

wayfinding connect <journey-id> [--scope read|readwrite] [--remember] [--server https://app.wayfinding.support] [--key-folder PATH]
wayfinding disconnect [--key-folder PATH]
wayfinding add --type TYPE --title TITLE --body TEXT [--tags a,b]
wayfinding import <file-or-folder>
wayfinding list [--type TYPE]
wayfinding search <text>
wayfinding show <id>
wayfinding comment <id> <text>
wayfinding comments <id>
wayfinding status
wayfinding mcp [--connect <journey-id>]

Use --journey <journey-id> with any one-shot command to ask for approval each time without remembering keys.
Use --cache to store only encrypted journey records and a verified log head; --no-cache turns it off.
Keys never go into the local cache. An agent cannot change journey membership or access.`;

const valueFlags = new Set(['--scope', '--server', '--key-folder', '--journey', '--connect', '--type', '--title', '--body', '--tags']);
const boolFlags = new Set(['--remember', '--cache', '--no-cache', '--help']);
function parse(args: string[]): { command: string; positional: string[]; flags: Record<string, string | boolean> } {
  const command = args[0] ?? '--help', flags: Record<string, string | boolean> = {}, positional: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const part = args[index]!;
    if (valueFlags.has(part)) {
      if (args[index + 1] === undefined || args[index + 1]!.startsWith('--')) throw new Error(part + ' needs a value.');
      flags[part] = args[++index]!;
    } else if (boolFlags.has(part)) flags[part] = true;
    else if (part.startsWith('-')) throw new Error('Unknown option: ' + part);
    else positional.push(part);
  }
  return { command, positional, flags };
}
function flag(flags: Record<string, string | boolean>, key: string): string | undefined { return typeof flags[key] === 'string' ? flags[key] : undefined; }
async function passphrase(folder?: string): Promise<string | undefined> {
  if (!folder) return undefined;
  if (process.env.WAYFINDING_PASSPHRASE) return process.env.WAYFINDING_PASSPHRASE;
  if (!stdin.isTTY || !stdin.setRawMode) throw new Error('A passphrase is required for --key-folder. Set WAYFINDING_PASSPHRASE or run from a terminal to enter it.');
  stderr.write('Passphrase for the journey key folder: ');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false); stdin.pause(); stderr.write('\n');
      if (error) reject(error); else if (!value) reject(new Error('A journey key-folder passphrase cannot be empty.')); else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) { finish(new Error('Cancelled.')); return; }
        if (byte === 13 || byte === 10) { finish(); return; }
        if (byte === 127 || byte === 8) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    };
    stdin.setRawMode(true); stdin.resume(); stdin.on('data', onData);
  });
}
function cacheFolder(): string {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'wayfinding', 'journeys');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'wayfinding', 'journeys');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'wayfinding', 'journeys');
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { command, positional, flags } = parse(args);
  if (command === '--help' || command === 'help' || flags['--help']) { console.log(help); return; }
  const keyFolder = flag(flags, '--key-folder');
  if (command === 'disconnect') {
    await forgetRemembered({ folder: keyFolder });
    const { rm } = await import('node:fs/promises');
    await rm(cacheFolder(), { recursive: true, force: true });
    console.log('Remembered journey keys and the local cache have been removed.'); return;
  }
  const secret = await passphrase(keyFolder);
  const server = flag(flags, '--server'), scope = flag(flags, '--scope');
  if (scope && scope !== 'read' && scope !== 'readwrite') throw new Error('Use --scope read or --scope readwrite.');
  const connect = async (journeyId: string, mcp = false) => connectJourney(journeyId, { server, scope: scope as 'read' | 'readwrite' | undefined, remember: !!flags['--remember'], keyFolder, passphrase: secret, onApproval: (url, code) => { (mcp ? console.error : console.log)('Open this link, check the code matches, and approve access to this journey: ' + url + '\nSix-digit code: ' + code); } });
  if (command === 'connect') {
    const journeyId = positional[0]; if (!journeyId) throw new Error('Give the journey ID to connect.');
    const { client } = await connect(journeyId);
    client.close();
    console.log(flags['--remember'] ? 'This journey is connected and the keys are remembered.' : 'Journey access was approved. No keys were saved; use wayfinding mcp --connect <journey-id> for an in-memory agent session, or --journey on each command.'); return;
  }
  let held: JourneyClient | undefined;
  const getClient = async (): Promise<JourneyClient> => {
    if (held) return held;
    const oneShot = command === 'mcp' ? flag(flags, '--connect') : flag(flags, '--journey');
    if (oneShot) { held = (await connect(oneShot, command === 'mcp')).client; }
    else {
      const session = await loadRemembered({ folder: keyFolder, passphrase: secret });
      if (!session) throw new Error('No remembered journey connection. Use wayfinding connect <journey-id> --remember, or --journey <journey-id> to ask for approval for this command. For an in-memory MCP session, use wayfinding mcp --connect <journey-id>.');
      held = new JourneyClient(session, flags['--no-cache'] ? {} : { cacheRoot: cacheFolder() });
    }
    if ((flags['--cache'] || flags['--no-cache']) && held) {
      // Cache is chosen when the client is constructed; ephemeral sessions default to no cache.
      if (flags['--cache'] && oneShot) held = new JourneyClient(held.session, { cacheRoot: cacheFolder() });
      if (flags['--no-cache'] && oneShot) held = new JourneyClient(held.session);
    }
    return held;
  };
  if (command === 'mcp') { await runMcp(getClient); return; }
  try {
    const client = await getClient(); let result: unknown;
    switch (command) {
      case 'add': {
        const type = flag(flags, '--type'), title = flag(flags, '--title'), body = flag(flags, '--body');
        if (!type || !title || !body) throw new Error('Add needs --type, --title and --body.');
        result = await client.add({ type, title, body, tags: flag(flags, '--tags')?.split(',').map(tag => tag.trim()).filter(Boolean) ?? [] }); break;
      }
      case 'import': if (!positional[0]) throw new Error('Give a Markdown file or folder to import.'); result = await importMarkdown(client, positional[0]); break;
      case 'list': result = await client.list(flag(flags, '--type')); break;
      case 'search': if (!positional[0]) throw new Error('Give words to search for in the journey.'); result = await client.search(positional.join(' ')); break;
      case 'show': if (!positional[0]) throw new Error('Give the journey item ID to show.'); result = await client.show(positional[0]); break;
      case 'comment': if (!positional[0] || !positional[1]) throw new Error('Give the journey item ID and comment text.'); result = await client.comment(positional[0], positional.slice(1).join(' ')); break;
      case 'comments': if (!positional[0]) throw new Error('Give the journey item ID to read comments.'); result = await client.comments(positional[0]); break;
      case 'status': result = await client.status(); break;
      default: throw new Error('Unknown journey command: ' + command + '. Try wayfinding --help.');
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { held?.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
