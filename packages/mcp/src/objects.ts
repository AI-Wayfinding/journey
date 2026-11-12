import * as z from 'zod';
import { writeRequestSchema, writePermitSchema, writeReceiptSchema, type WritePermit, type WriteReceipt } from './write-permits.ts';
import { allowanceRequestSchema, permitRequestSchema, type OfferAgent, type StandingDecision } from './offers.ts';
const standingSchema = z.object({ id: z.string().min(1).max(200), owner: z.string().min(1).max(200), agentId: z.string().min(1).max(200), offerId: z.string().min(1).max(200), journeyId: z.string().min(1).max(200), byAgent: z.boolean(), who: z.union([z.object({ person: z.string().min(1).max(200) }).strict(), z.object({ agent: z.string().min(1).max(200) }).strict()]), decision: z.enum(['allow', 'deny']) }).strict();
import { sealedDescriptor } from './sealed-descriptors.ts';
import { AccountsHost, WorkOSProfiles, type Account } from './accounts.ts';
import { Backend, type AccountsPort, type JourneyPort } from './backend.ts';
import { Refused, parseCommand, type Command, type ToolData } from './commands.ts';
import { JourneyHost } from './journey.ts';
import { actorSchema, assertionSchema, changeSchema, type Actor } from './agents.ts';
import type { KeyValueStorage } from './storage.ts';
import type { BlobStore } from './relay.ts';
import { bindingSchema, type DeviceBinding } from './sealed-contract.ts';

import { oauthOperation } from './oauth-contract.ts';
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
  constructor(state: ObjectState, env?: Pick<ObjectBindings, 'BLOBS'> & Partial<Pick<ObjectBindings, 'ACCOUNTS'>>, now: () => number = Date.now) {
    this.host = new JourneyHost(state.storage, now, env?.BLOBS, env?.ACCOUNTS ? {
      directory: () => call<OfferAgent[]>(env.ACCOUNTS!, 'accounts', { action: 'offerDirectory' }),
      stand: decision => call<void>(env.ACCOUNTS!, 'accounts', { action: 'standingDecision', decision }),
      reserve: request => call<'allow' | 'hold'>(env.ACCOUNTS!, 'accounts', { action: 'reserveAllowance', request }),
      approve: request => call<'allow' | 'hold'>(env.ACCOUNTS!, 'accounts', { action: 'approveAllowance', request }),
      release: (taskId, permitOnly = false) => call<void>(env.ACCOUNTS!, 'accounts', { action: 'releaseAllowance', taskId, permitOnly }),
    } : undefined, env?.ACCOUNTS ? {
      issueWrite: request => call<WritePermit>(env.ACCOUNTS!, 'accounts', { action: 'issueWrite', request }),
      redeemWrite: permit => call<void>(env.ACCOUNTS!, 'accounts', { action: 'redeemWrite', permit }),
      settleWrite: receipt => call<void>(env.ACCOUNTS!, 'accounts', { action: 'settleWrite', receipt }),
    } : undefined);
    if(env?.ACCOUNTS)this.authority={binding:id=>call<DeviceBinding>(env.ACCOUNTS!,'accounts',{action:'deviceBinding',deviceId:id}),reserve:(expected,groupId)=>call<DeviceBinding>(env.ACCOUNTS!,'accounts',{action:'reserveDevice',expected,groupId})};
  }
  private authority?:import('./sealed-content.ts').SealedAuthority;
  alarm(): Promise<void> { return this.host.alarm(); }
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== 'POST') throw new Refused('Internal requests must be POST');
      const body = record(await request.json());
      if (body['action'] === 'cancelWrite') return respond(() => this.host.cancelWrite(writePermitSchema.parse(body['permit'])));
      const personId = field(body, 'personId');
      const actor = body['actor'] === undefined ? undefined : actorSchema.parse(body['actor']);
      if (body['action'] === 'watchInbox') return new Response(await this.host.watchInbox(personId, actor), { headers: { 'content-type': 'application/x-ndjson' } });
      return respond(async () => {
        if(body.action==='sealed'){if(!actor||!this.authority)throw new Refused('Sealed authority required');return this.host.sealed(personId,field(body,'tool'),body.input,actor,this.authority);}
        if (body['action'] === 'syncAgent') return this.host.syncAgent(personId, field(body, 'agentId'), z.string().max(60).parse(body['name']), z.boolean().parse(body['present']));
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
  constructor(state: ObjectState, env: Pick<ObjectBindings, 'WORKOS_API_KEY'> & Partial<Pick<ObjectBindings, 'BLOBS'>>, verifier?: import('./agents.ts').PasskeyVerifier,sealedMode=false) { this.host = new AccountsHost(state.storage, new WorkOSProfiles(env.WORKOS_API_KEY), env.BLOBS, verifier,Date.now,sealedMode); }
  async fetch(request: Request): Promise<Response> {
    return respond(async () => {
      if (request.method !== 'POST') throw new Refused('Internal requests must be POST');
      const body = record(await request.json());
      if(body.action==='publishedDescriptors')return this.host.publishedDescriptors(field(body,'journeyId'),z.array(z.string()).max(1024).parse(body.ids));
      if(body.action==='setDescriptor')return this.host.setDescriptor(field(body,'personId'),field(body,'clientId'),typeof body.agentId==='string'?field(body,'agentId'):undefined,sealedDescriptor.parse(body.descriptor));
      if(body.action==='deviceBinding')return this.host.deviceBinding(field(body,'deviceId'));
      if(body.action==='reserveDevice')return this.host.reserveDevice(bindingSchema.parse(body.expected),field(body,'groupId'));
      if(body.action==='sealedDevice')return this.host.sealedDevice(field(body,'personId'),field(body,'clientId'),field(body,'tool'),body.input);
      if (body['action'] === 'issueWrite') return this.host.issueWrite(writeRequestSchema.parse(body['request']));
      if (body['action'] === 'redeemWrite') return this.host.redeemWrite(writePermitSchema.parse(body['permit']));
      if (body['action'] === 'settleWrite') return this.host.settleWrite(writeReceiptSchema.parse(body['receipt']));
      if (body['action'] === 'drainWrites') return this.host.drainWrites(body['personId'] === undefined ? undefined : field(body, 'personId'));
      if (body['action'] === 'offerDirectory') return this.host.offerDirectory();
      if (body['action'] === 'standingDecision') return this.host.standingDecision(standingSchema.parse(body['decision']));
      if (body['action'] === 'reserveAllowance') return this.host.reserveAllowance(allowanceRequestSchema.parse(body['request']));
      if (body['action'] === 'approveAllowance') return this.host.approveAllowance(permitRequestSchema.parse(body['request']));
      if (body['action'] === 'releaseAllowance') return this.host.releaseAllowance(field(body, 'taskId'), z.boolean().optional().parse(body['permitOnly']) ?? false);
      if (body['action'] === 'oauth') return this.host.oauth(oauthOperation.parse(body['operation']));
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
      if (body['action'] === 'group') return this.host.group(field(body, 'personId'), command(body), body['actor'] === undefined ? undefined : actorSchema.parse(body['actor']));
      throw new Refused('Unknown accounts operation');
    });
  }
}

export class AccountsSealedV1 extends Accounts {constructor(state:ObjectState,env:Pick<ObjectBindings,'WORKOS_API_KEY'>&Partial<Pick<ObjectBindings,'BLOBS'>>){super(state,env,undefined,true);}}

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
export function durableBackend(env: ObjectBindings,sealedMode=false): Backend {
  const accounts: AccountsPort = {
    publishedDescriptors:(journeyId,ids)=>call(env.ACCOUNTS,'accounts',{action:'publishedDescriptors',journeyId,ids}),
    setDescriptor:(personId,clientId,agentId,descriptor)=>call(env.ACCOUNTS,'accounts',{action:'setDescriptor',personId,clientId,agentId,descriptor}),
    sealedDevice:(personId,clientId,tool,input)=>call(env.ACCOUNTS,'accounts',{action:'sealedDevice',personId,clientId,tool,input}),
    deviceBinding:deviceId=>call(env.ACCOUNTS,'accounts',{action:'deviceBinding',deviceId}),
    reserveDevice:(expected,groupId)=>call(env.ACCOUNTS,'accounts',{action:'reserveDevice',expected,groupId}),
    issueWrite: request => call(env.ACCOUNTS, 'accounts', { action: 'issueWrite', request }),
    redeemWrite: permit => call(env.ACCOUNTS, 'accounts', { action: 'redeemWrite', permit }),
    settleWrite: receipt => call(env.ACCOUNTS, 'accounts', { action: 'settleWrite', receipt }),
    drainWrites: personId => call(env.ACCOUNTS, 'accounts', { action: 'drainWrites', personId }),
    offerDirectory: () => call<OfferAgent[]>(env.ACCOUNTS, 'accounts', { action: 'offerDirectory' }),
    standingDecision: decision => call<void>(env.ACCOUNTS, 'accounts', { action: 'standingDecision', decision }),
    oauth: operation => call(env.ACCOUNTS, 'accounts', { action: 'oauth', operation }),
    consoleRecord: (operation) => call<ConsoleRecord | undefined>(env.ACCOUNTS, 'accounts', { action: 'consoleRecord', operation }),
    passkey: (identity, operation) => call(env.ACCOUNTS, 'accounts', { action: 'passkey', subject: identity.subject, clientId: identity.clientId, operation }),
    provision: (subject) => call<Account>(env.ACCOUNTS, 'accounts', { action: 'provision', subject }),
    lookup: (subject) => call<Account | undefined>(env.ACCOUNTS, 'accounts', { action: 'lookup', subject }),
    update: (personId, nickname) => call<Account>(env.ACCOUNTS, 'accounts', { action: 'update', personId, tool: 'account_update', input: { nickname } }),
    names: (personIds) => call<Record<string, string>>(env.ACCOUNTS, 'accounts', { action: 'names', personIds }),
    personIdByEmail: (email) => call<string | undefined>(env.ACCOUNTS, 'accounts', { action: 'personIdByEmail', email }),
    directory: (add) => call<string[]>(env.ACCOUNTS, 'accounts', { action: 'directory', add }),
    group: (personId, command, actor) => call<ToolData>(env.ACCOUNTS, 'accounts', { action: 'group', personId, tool: command.tool, input: command.input, actor }),
    observeClient: (personId, clientId) => call<void>(env.ACCOUNTS, 'accounts', { action: 'observeClient', personId, clientId }),
    resolveActor: (personId, clientId, actingAgent) => call<Actor>(env.ACCOUNTS, 'accounts', { action: 'resolveActor', personId, clientId, actingAgent }),
    agentCommand: (personId, clientId, command) => call<ToolData>(env.ACCOUNTS, 'accounts', { action: 'agentCommand', personId, clientId, tool: command.tool, input: command.input }),
    beginAuthorization: (identity, change) => call(env.ACCOUNTS, 'accounts', { action: 'beginAuthorization', subject: identity.subject, clientId: identity.clientId, change }),
    completeAuthorization: (identity, change, assertion) => call(env.ACCOUNTS, 'accounts', { action: 'completeAuthorization', subject: identity.subject, clientId: identity.clientId, change, assertion }),
  };
  async function knownJourney(id: string): Promise<void> { if (!(await accounts.directory()).includes(id)) throw new Refused('Unknown journey'); }
  async function journeyCall<T>(id: string, body: Record<string, unknown>): Promise<T> { await knownJourney(id); return call<T>(env.JOURNEYS, id, body); }
  async function journeyWatch(id: string, personId: string, actor?: Actor): Promise<ReadableStream<Uint8Array>> { await knownJourney(id); return watch(env.JOURNEYS, id, personId, actor); }
  return new Backend(accounts, (id): JourneyPort => ({
    sealed:(personId,tool,input,actor)=>journeyCall(id,{action:'sealed',personId,tool,input,actor}),
    cancelWrite: permit => journeyCall<WriteReceipt>(id, { action: 'cancelWrite', permit }),
    syncAgent: (personId, agentId, name, present) => journeyCall(id, { action: 'syncAgent', personId, agentId, name, present }),
    requireGuide: (personId, command, actor) => journeyCall<void>(id, { action: 'requireGuide', personId, tool: command.tool, input: command.input, actor }),
    execute: (personId, command, journeyId, actor) => journeyCall<ToolData>(id, { personId, journeyId, tool: command.tool, input: command.input, actor }),
    summary: (personId, actor) => journeyCall<ToolData | undefined>(id, { action: 'summary', personId, actor }),
    inbox: (personId, actor) => journeyCall<ToolData>(id, { action: 'inbox', personId, actor }),
    watchInbox: (personId, actor) => journeyWatch(id, personId, actor),
    task: (personId, method, taskId, actor) => journeyCall<ToolData>(id, { action: 'task', personId, method, taskId, actor }),
  }),sealedMode);
}
