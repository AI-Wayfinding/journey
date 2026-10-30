import * as z from 'zod';
import { AccountsHost, WorkOSProfiles, type Account } from './accounts.ts';
import { Backend, type AccountsPort, type JourneyPort } from './backend.ts';
import { Refused, parseCommand, type Command, type ToolData } from './commands.ts';
import { JourneyHost } from './journey.ts';
import { actorSchema, assertionSchema, changeSchema, type Actor } from './agents.ts';
import type { KeyValueStorage } from './storage.ts';
import type { BlobStore } from './relay.ts';

import { passkeyOperation, recordOperation, type ConsoleRecord } from './console/contract.ts';
interface ObjectState { storage: KeyValueStorage }
interface Stub { fetch(request: Request): Promise<Response> }
export interface ObjectNamespace { getByName(name: string): Stub }
export interface ObjectBindings { ACCOUNTS: ObjectNamespace; JOURNEYS: ObjectNamespace; WORKOS_API_KEY: string; BLOBS: BlobStore }

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
    // Log the internal cause for operators; callers only see a generic message.
    console.error('coordination storage operation failed', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return Response.json({ error: 'Coordination storage operation failed' }, { status: 500 });
  }
}

/** DO adapters keep rules and writes in the serial, tested host. */
export class Journey {
  private readonly host: JourneyHost;
  constructor(state: ObjectState, env?: Pick<ObjectBindings, 'BLOBS'>, now: () => number = Date.now) { this.host = new JourneyHost(state.storage, now, env?.BLOBS); }
  alarm(): Promise<void> { return this.host.alarm(); }
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== 'POST') throw new Refused('Internal requests must be POST');
      const body = record(await request.json());
      const personId = field(body, 'personId');
      const actor = body['actor'] === undefined ? undefined : actorSchema.parse(body['actor']);
      if (body['action'] === 'watchInbox') return new Response(await this.host.watchInbox(personId, actor), { headers: { 'content-type': 'application/x-ndjson' } });
      return respond(async () => {
        if (body['action'] === 'requireGuide') return this.host.requireGuide(personId, command(body), actor);
        if (body['action'] === 'summary') return this.host.summary(personId, actor);
        if (body['action'] === 'inbox') return this.host.inbox(personId, actor);
        if (body['action'] === 'task') {
          const method = field(body, 'method');
          if (method !== 'get' && method !== 'update' && method !== 'cancel') throw new Refused('Invalid task method');
          return this.host.task(personId, method, field(body, 'taskId'), actor);
        }
        return this.host.execute(personId, command(body), typeof body['journeyId'] === 'string' ? field(body, 'journeyId') : undefined, actor);
      });
    } catch (error) {
      return respond(async () => { throw error; });
    }
  }
}
export class Accounts {
  private readonly host: AccountsHost;
  constructor(state: ObjectState, env: Pick<ObjectBindings, 'WORKOS_API_KEY'> & Partial<Pick<ObjectBindings, 'BLOBS'>>, verifier?: import('./agents.ts').PasskeyVerifier) { this.host = new AccountsHost(state.storage, new WorkOSProfiles(env.WORKOS_API_KEY), env.BLOBS, verifier); }
  async fetch(request: Request): Promise<Response> {
    return respond(async () => {
      if (request.method !== 'POST') throw new Refused('Internal requests must be POST');
      const body = record(await request.json());
      if (body['action'] === 'consoleRecord') return this.host.consoleRecord(recordOperation.parse(body['operation']));
      if (body['action'] === 'passkey') return this.host.passkey({ subject: field(body, 'subject'), clientId: field(body, 'clientId') }, passkeyOperation.parse(body['operation']));
      if (body['action'] === 'observeClient') return this.host.observeClient(field(body, 'personId'), field(body, 'clientId'));
      if (body['action'] === 'resolveActor') return this.host.resolveActor(field(body, 'personId'), field(body, 'clientId'), typeof body['actingAgent'] === 'string' ? field(body, 'actingAgent') : undefined);
      if (body['action'] === 'agentCommand') return this.host.agentCommand(field(body, 'personId'), field(body, 'clientId'), command(body));
      if (body['action'] === 'beginAuthorization' || body['action'] === 'completeAuthorization') {
        const identity = { subject: field(body, 'subject'), clientId: field(body, 'clientId') }, change = changeSchema.parse(body['change']);
        return body['action'] === 'beginAuthorization' ? this.host.beginAuthorization(identity, change)
          : this.host.completeAuthorization(identity, change, body['assertion'] === undefined ? undefined : assertionSchema.parse(body['assertion']));
      }
      if (body['action'] === 'provision') return this.host.provision(field(body, 'subject'));
      if (body['action'] === 'lookup') return this.host.lookup(field(body, 'subject'));
      if (body['action'] === 'update') {
        const parsed = command(body);
        if (parsed.tool !== 'account_update') throw new Refused('Account update required');
        return this.host.update(field(body, 'personId'), parsed.input.nickname);
      }
      if (body['action'] === 'names') return this.host.names(z.array(z.string().min(1).max(200)).max(128).parse(body['personIds']));
      if (body['action'] === 'personIdByEmail') return this.host.personIdByEmail(z.email().max(320).parse(body['email']));
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
async function watch(namespace: ObjectNamespace, id: string, personId: string, actor?: Actor): Promise<ReadableStream<Uint8Array>> {
  const response = await namespace.getByName(id).fetch(new Request('https://coordination.internal/', { method: 'POST', body: JSON.stringify({ action: 'watchInbox', personId, actor }) }));
  if (!response.ok || !response.body) throw new Refused('Inbox subscription refused');
  return response.body;
}
export function durableBackend(env: ObjectBindings): Backend {
  const accounts: AccountsPort = {
    consoleRecord: (operation) => call<ConsoleRecord | undefined>(env.ACCOUNTS, 'accounts', { action: 'consoleRecord', operation }),
    passkey: (identity, operation) => call(env.ACCOUNTS, 'accounts', { action: 'passkey', subject: identity.subject, clientId: identity.clientId, operation }),
    provision: (subject) => call<Account>(env.ACCOUNTS, 'accounts', { action: 'provision', subject }),
    lookup: (subject) => call<Account | undefined>(env.ACCOUNTS, 'accounts', { action: 'lookup', subject }),
    update: (personId, nickname) => call<Account>(env.ACCOUNTS, 'accounts', { action: 'update', personId, tool: 'account_update', input: { nickname } }),
    names: (personIds) => call<Record<string, string>>(env.ACCOUNTS, 'accounts', { action: 'names', personIds }),
    personIdByEmail: (email) => call<string | undefined>(env.ACCOUNTS, 'accounts', { action: 'personIdByEmail', email }),
    directory: (add) => call<string[]>(env.ACCOUNTS, 'accounts', { action: 'directory', add }),
    group: (personId, command) => call<ToolData>(env.ACCOUNTS, 'accounts', { action: 'group', personId, tool: command.tool, input: command.input }),
    observeClient: (personId, clientId) => call<void>(env.ACCOUNTS, 'accounts', { action: 'observeClient', personId, clientId }),
    resolveActor: (personId, clientId, actingAgent) => call<Actor>(env.ACCOUNTS, 'accounts', { action: 'resolveActor', personId, clientId, actingAgent }),
    agentCommand: (personId, clientId, command) => call<ToolData>(env.ACCOUNTS, 'accounts', { action: 'agentCommand', personId, clientId, tool: command.tool, input: command.input }),
    beginAuthorization: (identity, change) => call(env.ACCOUNTS, 'accounts', { action: 'beginAuthorization', subject: identity.subject, clientId: identity.clientId, change }),
    completeAuthorization: (identity, change, assertion) => call(env.ACCOUNTS, 'accounts', { action: 'completeAuthorization', subject: identity.subject, clientId: identity.clientId, change, assertion }),
  };
  return new Backend(accounts, (id): JourneyPort => ({
    requireGuide: (personId, command, actor) => call<void>(env.JOURNEYS, id, { action: 'requireGuide', personId, tool: command.tool, input: command.input, actor }),
    execute: (personId, command, journeyId, actor) => call<ToolData>(env.JOURNEYS, id, { personId, journeyId, tool: command.tool, input: command.input, actor }),
    summary: (personId, actor) => call<ToolData | undefined>(env.JOURNEYS, id, { action: 'summary', personId, actor }),
    inbox: (personId, actor) => call<ToolData>(env.JOURNEYS, id, { action: 'inbox', personId, actor }),
    watchInbox: (personId, actor) => watch(env.JOURNEYS, id, personId, actor),
    task: (personId, method, taskId, actor) => call<ToolData>(env.JOURNEYS, id, { action: 'task', personId, method, taskId, actor }),
  }));
}
