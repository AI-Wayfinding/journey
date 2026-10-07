#!/usr/bin/env node
import { homedir } from 'node:os';
import { stdin, stderr } from 'node:process';
import { join } from 'node:path';
import { connectJourney, requestConnection, resumeConnection } from './connection.js';
import { ExpiredStateError, loadState } from './state.js';
import type { AgentState } from './state.js';
import { importMarkdown } from './import.js';
import { JourneyClient } from './journey.js';
import type { JourneyOptions } from './journey.js';
import { pathToFileURL } from 'node:url';
import { runMcp } from './mcp.js';
import { forgetRemembered, loadRemembered } from './storage.js';
import { NetworkError } from './network.js';
import type { ArtifactInput } from './artifacts.js';
import { PrivateArtifacts } from './private.js';
import { localBytes } from './artifacts.js';

const help = `wayfinding — read and write an approved journey

wayfinding connect <journey-id> [--name "Agent name"] [--remember] [--server https://app.wayfinding.support] [--key-folder PATH]
wayfinding connect <journey-id> --state FILE --no-wait [--json]
wayfinding connect --state FILE --wait [--timeout SECONDS] [--json]
wayfinding disconnect [--key-folder PATH]
wayfinding add --type TYPE --title TITLE [--body TEXT] [--tags a,b] [--file PATH] [--format json|csv|toml|yaml|sqlite] [--url URL]
wayfinding import <file-or-folder>
wayfinding import-skill <folder> --title TITLE
wayfinding project list|show|create|join|leave|purpose|state
wayfinding project show|join|leave <project-id>
wayfinding project create --purpose TEXT
wayfinding project purpose <project-id> --purpose TEXT --predecessor SEQUENCE
wayfinding project state <project-id> --project-state getting-started|active|looking-for-others|archived --predecessor SEQUENCE
wayfinding artifact project <artifact-id> <project-id|none> --predecessor SEQUENCE|null
wayfinding list [--type TYPE] [--tag TAG] [--project main|PROJECT_ID|all]
wayfinding edit <id> --predecessor VERSION --type TYPE --title TITLE [--body TEXT] [--file PATH]
wayfinding versions <id>
wayfinding delete <id>
wayfinding download <id> --blob BLOB_ID --output PATH [--version VERSION]
wayfinding search <text> [--project main|PROJECT_ID|all] [--type TYPE] [--tag TAG]
wayfinding show <id>
wayfinding comment <id> <text> [--version VERSION]
wayfinding comments <id>
wayfinding status
wayfinding private init|list|show|create|edit|comment|delete|project|copy|backup|import|handoff|return|checkpoint|watch
Private commands require --private-cache PATH; use --paired FILE for a trusted exported checkpoint.
Private saves are staged, not immediately uploaded. Keep mcp or private watch open for five-minute sync.
wayfinding mcp [--connect <journey-id>] [--name "Agent name"]

Use --state FILE with commands or mcp to use an approved file-backed session.
Use --journey <journey-id> with any one-shot command to ask for approval each time without remembering keys.
Use --cache to store only encrypted journey records and a verified log head; --no-cache turns it off.
Keys never go into the local cache. Agent capabilities follow the adding person’s current access.`;

const valueFlags = new Set(['--name', '--server', '--key-folder', '--journey', '--connect', '--type', '--title', '--body', '--tags', '--state', '--timeout', '--tag', '--file', '--format', '--url', '--summary', '--notes', '--predecessor', '--blob', '--output', '--version', '--project', '--purpose', '--project-state', '--private-cache', '--paired', '--destination-state']);
const boolFlags = new Set(['--remember', '--cache', '--no-cache', '--help', '--no-wait', '--wait', '--json']);
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
function reportConnect(state: AgentState, status: 'pending' | 'approved' | 'expired' | 'denied' | 'locked', json: boolean): void {
  const result = { link: state.link, code: state.code, requestId: state.status === 'pending' ? state.sessionId : state.session.sessionId, expiresAt: new Date(state.expiresAt).toISOString(), status };
  if (json) console.log(JSON.stringify(result));
  else if (status === 'pending') console.log('Open this link, check the code matches, and approve access to this journey: ' + result.link + '\nSix-digit code: ' + result.code);
  else if (status === 'approved') console.log('Journey access was approved. The keys are stored in your state file.');
}
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
export async function main(args = process.argv.slice(2), journeyOptions: JourneyOptions = {}): Promise<void> {
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
  const server = flag(flags, '--server');
  const statePath = flag(flags, '--state');
  const connect = async (journeyId: string, mcp = false) => connectJourney(journeyId, { server, name: flag(flags, '--name'), remember: !!flags['--remember'], keyFolder, passphrase: secret, onApproval: (url, code) => { (mcp ? console.error : console.log)('Open this link, check the code matches, and approve access to this journey: ' + url + '\nSix-digit code: ' + code); } });
  if (command === 'connect') {
    const journeyId = positional[0], json = !!flags['--json'];
    if (flags['--no-wait']) {
      if (!journeyId || !statePath || flags['--wait'] || flags['--remember']) throw new Error('Use connect <journey-id> --state FILE --no-wait without --remember.');
      reportConnect(await requestConnection(journeyId, { server, name: flag(flags, '--name'), state: statePath }), 'pending', json);
      return;
    }
    if (flags['--wait']) {
      if (journeyId || !statePath || flags['--remember'] || server || flags['--name']) throw new Error('Use connect --state FILE --wait [--timeout SECONDS].');
      const timeout = flag(flags, '--timeout') ?? '600';
      if (!/^[0-9]+$/.test(timeout) || !Number.isSafeInteger(Number(timeout)) || Number(timeout) < 1) throw new Error('--timeout must be a positive number of seconds.');
      let state;
      try {
        state = await loadState(statePath);
        const { client } = await resumeConnection(statePath, { timeoutMs: Number(timeout) * 1000 });
        client.close();
        reportConnect(await loadState(statePath), 'approved', json);
      } catch (error) {
        if (json && error instanceof Error && 'exitCode' in error) {
          const status = error.exitCode === 2 ? 'pending' : error.exitCode === 3 ? 'expired' : error.exitCode === 4 ? error.message.includes('wrong approval codes') ? 'locked' : 'denied' : state?.status;
          const reportState = state ?? (error instanceof ExpiredStateError ? error.state : undefined);
          if (reportState && status) reportConnect(reportState, status, true);
        }
        throw error;
      }
      return;
    }
    if (!journeyId || flags['--timeout'] || statePath || json) throw new Error('Give the journey ID to connect, or use --state FILE --no-wait / --wait.');
    const { client } = await connect(journeyId);
    client.close();
    console.log(flags['--remember'] ? 'This journey is connected and the keys are remembered.' : 'Journey access was approved. No keys were saved; use wayfinding mcp --connect <journey-id> for an in-memory agent session, or --journey on each command.'); return;
  }
  let held: JourneyClient | undefined;
  const getClient = async (): Promise<JourneyClient> => {
    if (held) return held;
    const oneShot = command === 'mcp' ? flag(flags, '--connect') : flag(flags, '--journey');
    if (statePath && (oneShot || keyFolder)) throw new Error('Use --state instead of --connect, --journey or --key-folder.');
    if (statePath) {
      const state = await loadState(statePath);
      if (state.status !== 'approved') throw new Error('This journey is still pending approval. Run connect --state FILE --wait first.');
      held = new JourneyClient(state.session, { ...journeyOptions, ...(flag(flags, '--private-cache') ? { cacheRoot: flag(flags, '--private-cache') } : flags['--cache'] && !flags['--no-cache'] ? { cacheRoot: cacheFolder() } : {}) });
    } else if (oneShot) { held = (await connect(oneShot, command === 'mcp')).client; }
    else {
      const session = await loadRemembered({ folder: keyFolder, passphrase: secret });
      if (!session) throw new Error('No remembered journey connection. Use wayfinding connect <journey-id> --remember, --state FILE for an approved file, or --journey <journey-id> to ask for approval for this command.');
      held = new JourneyClient(session, { ...journeyOptions, ...(flag(flags, '--private-cache') ? { cacheRoot: flag(flags, '--private-cache') } : flags['--no-cache'] ? {} : { cacheRoot: cacheFolder() }) });
    }
    if ((flags['--cache'] || flags['--no-cache']) && oneShot && held) {
      if (flags['--cache']) held = new JourneyClient(held.session, { ...journeyOptions, cacheRoot: cacheFolder() });
      if (flags['--no-cache']) held = new JourneyClient(held.session, journeyOptions);
    }
    return held;
  };
  const pairedPath = flag(flags, '--paired');
  const paired = pairedPath ? JSON.parse(new TextDecoder().decode(await localBytes(pairedPath))) as import('@ai-wayfinding/core').PrivateCheckpoint : undefined;
  if (command === 'mcp') { await runMcp(getClient, paired); return; }
  try {
    const client = await getClient(); let result: unknown;
    const input = (): ArtifactInput => {
      const type = flag(flags, '--type'), title = flag(flags, '--title'), format = flag(flags, '--format'), file = flag(flags, '--file');
      if (!type || !title) throw new Error('Add or edit needs --type and --title.');
      if (format && !['json', 'csv', 'toml', 'yaml', 'sqlite'].includes(format)) throw new Error('Unsupported data format.');
      return { type, title, body: flag(flags, '--body'), tags: flag(flags, '--tags')?.split(',').map(tag => tag.trim()).filter(Boolean) ?? [], files: file ? [{ path: file }] : undefined, format: format as ArtifactInput['format'], url: flag(flags, '--url'), summary: flag(flags, '--summary'), notes: flag(flags, '--notes') };
    };
    const predecessor = (): number | null => {
      const value = flag(flags, '--predecessor');
      if (value === 'null') return null;
      if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Supply --predecessor with the observed sequence or null.');
      return Number(value);
    };
    switch (command) {
      case 'private': {
        if (!flag(flags, '--private-cache')) throw new Error('Private commands need --private-cache with an explicit encrypted staging folder.');
        const workflow = await PrivateArtifacts.open(client, paired), [action, id, text] = positional;
        const required = (value: string | undefined, name: string) => { if (!value) throw new Error('Supply ' + name); return value; };
        const observed = () => required(flag(flags, '--predecessor'), '--predecessor');
        const target = async () => {
          const state = await loadState(required(flag(flags, '--destination-state'), '--destination-state FILE'));
          if (state.status !== 'approved') throw new Error('Destination requires separate approved state');
          return new JourneyClient(state.session, { ...journeyOptions, cacheRoot: flag(flags, '--private-cache') });
        };
        switch (action) {
          case 'init': result = await workflow.status(); break;
          case 'list': result = await workflow.list(flag(flags, '--project')); break;
          case 'show': result = await workflow.show(required(id, 'copy ID')); break;
          case 'create': result = await workflow.save(input()); break;
          case 'edit': result = await workflow.save(input(), required(id, 'copy ID'), observed()); break;
          case 'comment': result = await workflow.comment(required(id, 'copy ID'), required(text, 'comment text'), flag(flags, '--version')); break;
          case 'delete': result = await workflow.delete(required(id, 'copy ID'), observed()); break;
          case 'project': result = await workflow.project(required(id, 'copy ID'), required(text, 'project ID or none') === 'none' ? null : text!, observed() === 'null' ? null : observed()); break;
          case 'download': result = await workflow.download(required(id, 'copy ID'), required(flag(flags, '--blob'), '--blob'), required(flag(flags, '--output'), '--output PATH')); break;
          case 'backup': case 'return': result = await workflow.backup(required(flag(flags, '--output'), '--output PATH'), action === 'return' ? 'agent-return' : 'author-backup'); break;
          case 'import': result = await workflow.import(required(id, 'bundle path')); break;
          case 'checkpoint': result = await workflow.checkpoint(required(flag(flags, '--output'), '--output PATH')); break;
          case 'handoff': { const destination = await target(); try { result = await workflow.backup(required(flag(flags, '--output'), '--output PATH'), 'agent-handoff', destination); } finally { destination.close(); } break; }
          case 'copy': { const destination = await target(); try { result = await workflow.copyTo(required(id, 'copy ID'), observed(), await PrivateArtifacts.open(destination)); } finally { destination.close(); } break; }
          case 'watch': console.log(JSON.stringify(await workflow.status())); await new Promise<void>(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); }); return;
          default: throw new Error('Unknown private command');
        }
        break;
      }
      case 'project': {
        const [action, id] = positional;
        switch (action) {
          case 'list': result = await client.projectList(); break;
          case 'create': if (!flag(flags, '--purpose')) throw new Error('Supply --purpose TEXT.'); result = await client.projectCreate(flag(flags, '--purpose')!); break;
          case 'show': if (!id) throw new Error('Give the project ID.'); result = await client.projectShow(id); break;
          case 'join': case 'leave': if (!id) throw new Error('Give the project ID.'); result = await client.projectParticipation(id, action); break;
          case 'purpose': if (!id || !flag(flags, '--purpose')) throw new Error('Give the project ID and --purpose TEXT.'); result = await client.projectPurpose(id, flag(flags, '--purpose')!, predecessor()); break;
          case 'state': if (!id || !flag(flags, '--project-state')) throw new Error('Give the project ID and --project-state.'); result = await client.projectState(id, flag(flags, '--project-state')!, predecessor()); break;
          default: throw new Error('Use project list, show, create, join, leave, purpose or state.');
        }
        break;
      }
      case 'artifact': if (positional[0] !== 'project' || !positional[1] || !positional[2]) throw new Error('Use artifact project <artifact-id> <project-id|none> --predecessor SEQUENCE|null.'); result = await client.artifactProject(positional[1], positional[2] === 'none' ? null : positional[2], predecessor()); break;
      case 'add': case 'create': result = await client.add(input()); break;
      case 'edit': if (!positional[0] || !flag(flags, '--predecessor')) throw new Error('Edit needs an artifact ID and --predecessor VERSION.'); result = await client.edit(positional[0], flag(flags, '--predecessor')!, input()); break;
      case 'versions': if (!positional[0]) throw new Error('Give the artifact ID.'); result = await client.versions(positional[0]); break;
      case 'delete': if (!positional[0]) throw new Error('Give the artifact ID.'); result = await client.delete(positional[0]); break;
      case 'download': if (!positional[0] || !flag(flags, '--blob') || !flag(flags, '--output')) throw new Error('Download needs an artifact ID, --blob and --output local path.'); result = await client.download(positional[0], flag(flags, '--blob')!, flag(flags, '--output')!, flag(flags, '--version')); break;
      case 'import-skill': if (!positional[0] || !flag(flags, '--title')) throw new Error('Give a skill folder and --title.'); result = await client.importSkill(positional[0], flag(flags, '--title')!, flag(flags, '--tags')?.split(',') ?? []); break;
      case 'import': if (!positional[0]) throw new Error('Give a Markdown file or folder to import.'); result = await importMarkdown(client, positional[0]); break;
      case 'list': result = await client.list(flag(flags, '--type'), flag(flags, '--tag'), flag(flags, '--project')); break;
      case 'search': if (!positional[0]) throw new Error('Give words to search for in the journey.'); result = await client.search(positional.join(' '), flag(flags, '--project'), flag(flags, '--type'), flag(flags, '--tag')); break;
      case 'show': if (!positional[0]) throw new Error('Give the journey item ID to show.'); result = await client.show(positional[0]); break;
      case 'comment': if (!positional[0] || !positional[1]) throw new Error('Give the journey item ID and comment text.'); result = await client.comment(positional[0], positional.slice(1).join(' '), flag(flags, '--version')); break;
      case 'comments': if (!positional[0]) throw new Error('Give the journey item ID to read comments.'); result = await client.comments(positional[0]); break;
      case 'status': result = await client.status(); break;
      default: throw new Error('Unknown journey command: ' + command + '. Try wayfinding --help.');
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { held?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  if (error instanceof NetworkError && process.argv.includes('--json')) console.error(JSON.stringify({ error: error.reason, exitCode: error.exitCode, fallback: error.fallback }));
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error && typeof error.exitCode === 'number' ? error.exitCode : 1; });
