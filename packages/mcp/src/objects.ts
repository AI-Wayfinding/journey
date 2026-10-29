import { AccountsHost, WorkOSProfiles, type Account } from './accounts.ts';
import { Backend, type AccountsPort, type JourneyPort } from './backend.ts';
import { Refused, parseCommand, type Command, type ToolData } from './commands.ts';
import { JourneyHost } from './journey.ts';
import type { KeyValueStorage } from './storage.ts';

interface ObjectState { storage: KeyValueStorage }
interface Stub { fetch(request: Request): Promise<Response> }
export interface ObjectNamespace { getByName(name: string): Stub }
export interface ObjectBindings { ACCOUNTS: ObjectNamespace; JOURNEYS: ObjectNamespace; WORKOS_API_KEY: string }

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Refused('Invalid internal request');
  return value as Record<string, unknown>;
}
function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) throw new Refused(`Invalid ${key}`);
  return value;
}
function command(body: Record<string, unknown>): Command { return parseCommand(field(body, 'tool'), body['input']); }
async function respond(operation: () => Promise<unknown>): Promise<Response> {
  try { return Response.json({ value: await operation() }); }
  catch (error) {
    if (error instanceof Refused) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: 'Coordination storage operation failed' }, { status: 500 });
  }
}

/** Fetch-only DO adapters: no rules or writes live outside the tested hosts. */
export class Journey {
  private readonly host: JourneyHost;
  constructor(state: ObjectState) { this.host = new JourneyHost(state.storage); }
  async fetch(request: Request): Promise<Response> {
    return respond(async () => {
      if (request.method !== 'POST') throw new Refused('Internal requests must be POST');
      const body = record(await request.json());
      const personId = field(body, 'personId');
      if (body['action'] === 'summary') return this.host.summary(personId);
      return this.host.execute(personId, command(body), typeof body['journeyId'] === 'string' ? field(body, 'journeyId') : undefined);
    });
  }
}
export class Accounts {
  private readonly host: AccountsHost;
  constructor(state: ObjectState, env: Pick<ObjectBindings, 'WORKOS_API_KEY'>) { this.host = new AccountsHost(state.storage, new WorkOSProfiles(env.WORKOS_API_KEY)); }
  async fetch(request: Request): Promise<Response> {
    return respond(async () => {
      if (request.method !== 'POST') throw new Refused('Internal requests must be POST');
      const body = record(await request.json());
      if (body['action'] === 'provision') return this.host.provision(field(body, 'subject'));
      if (body['action'] === 'directory') return this.host.directory(typeof body['add'] === 'string' ? field(body, 'add') : undefined);
      if (body['action'] === 'group') return this.host.group(field(body, 'personId'), command(body));
      throw new Refused('Unknown accounts operation');
    });
  }
}

async function call<T>(namespace: ObjectNamespace, name: string, body: Record<string, unknown>): Promise<T> {
  const stub = namespace.getByName(name);
  const response = await stub.fetch(new Request('https://coordination.internal/', { method: 'POST', body: JSON.stringify(body) }));
  const envelope = record(await response.json());
  if (!response.ok) throw new Refused(typeof envelope['error'] === 'string' ? envelope['error'] : 'Coordination operation failed');
  return envelope['value'] as T;
}
export function durableBackend(env: ObjectBindings): Backend {
  const accounts: AccountsPort = {
    provision: (subject) => call<Account>(env.ACCOUNTS, 'accounts', { action: 'provision', subject }),
    directory: (add) => call<string[]>(env.ACCOUNTS, 'accounts', { action: 'directory', add }),
    group: (personId, command) => call<ToolData>(env.ACCOUNTS, 'accounts', { action: 'group', personId, tool: command.tool, input: command.input }),
  };
  return new Backend(accounts, (id): JourneyPort => ({
    execute: (personId, command, journeyId) => call<ToolData>(env.JOURNEYS, id, { personId, journeyId, tool: command.tool, input: command.input }),
    summary: (personId) => call<ToolData | undefined>(env.JOURNEYS, id, { action: 'summary', personId }),
  }));
}
