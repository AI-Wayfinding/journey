import * as z from 'zod';
import { AccountsHost, type Account, type Profiles } from './accounts.ts';
import { Refused, parseCommand, isRelay, type Command, type CoordinationBackend, type TaskMethod, type ToolData } from './commands.ts';
import { allows, requireAccountCapability, type Actor, type ClientIdentity, type CardChange, type PasskeyVerifier } from './agents.ts';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { JourneyHost } from './journey.ts';
import { MemoryStorage } from './storage.ts';
import { MemoryBlobs, encodeBytes } from './relay.ts';

const namedState = z.object({
  members: z.array(z.object({ memberId: z.string(), name: z.string(), kind: z.enum(['person', 'agent']), role: z.enum(['read', 'write']), guide: z.boolean(), owner: z.string().optional() }).strict()),
  pending: z.array(z.object({ personId: z.string(), name: z.string(), status: z.string() }).strict()),
});
export interface AccountsPort {
  provision(subject: string): Promise<Account>;
  lookup(subject: string): Promise<Account | undefined>;
  update(personId: string, nickname: string): Promise<Account>;
  names(personIds: string[]): Promise<Record<string, string>>;
  personIdByEmail(email: string): Promise<string | undefined>;
  directory(add?: string): Promise<string[]>;
  group(personId: string, command: Command): Promise<ToolData>;
  observeClient(personId: string, clientId: string): Promise<void>;
  resolveActor(personId: string, clientId: string, actingAgent?: string): Promise<Actor>;
  agentCommand(personId: string, clientId: string, command: Command): Promise<ToolData>;
  beginAuthorization(identity: ClientIdentity, change: CardChange): Promise<{ challenge: string }>;
  completeAuthorization(identity: ClientIdentity, change: CardChange, assertion: AuthenticationResponseJSON | undefined): Promise<ToolData>;
}
export interface JourneyPort {
  requireGuide(personId: string, command: Command, actor?: Actor): Promise<void>;
  execute(personId: string, command: Command, journeyId?: string, actor?: Actor): Promise<ToolData>;
  summary(personId: string, actor?: Actor): Promise<ToolData | undefined>;
  inbox(personId: string, actor?: Actor): Promise<ToolData>;
  watchInbox(personId: string, actor?: Actor): Promise<ReadableStream<Uint8Array>>;
  task(personId: string, method: TaskMethod, taskId: string, actor?: Actor): Promise<ToolData>;
}

/** Resolve every request from verified (subject, client_id), never a supplied identity. */
export class Backend implements CoordinationBackend {
  private readonly accounts: AccountsPort;
  private readonly journey: (id: string) => JourneyPort;
  constructor(accounts: AccountsPort, journey: (id: string) => JourneyPort) { this.accounts = accounts; this.journey = journey; }
  beginAuthorization(identity: ClientIdentity, change: CardChange) { return this.accounts.beginAuthorization(identity, change); }
  completeAuthorization(identity: ClientIdentity, change: CardChange, assertion: AuthenticationResponseJSON | undefined) { return this.accounts.completeAuthorization(identity, change, assertion); }
  private async named(data: ToolData): Promise<ToolData> {
    if (!('members' in data) || !('pending' in data)) return data;
    const { members, pending } = namedState.parse(data);
    const names = await this.accounts.names([...members.filter(m => m.kind === 'person').map(m => m.memberId), ...pending.map(p => p.personId)]);
    const agents: ToolData[] = [];
    for (const member of members.filter(m => m.kind === 'agent' && m.owner)) {
      const owner = member.owner!;
      let identity: Actor;
      try { identity = await this.accounts.resolveActor(owner, 'trusted-host', member.memberId); }
      catch { agents.push({ agentId: member.memberId, owner, signed: false, read: false, write: false, grant: false }); continue; }
      agents.push({ agentId: member.memberId, owner, signed: identity.agent?.card.scalars.signed === 1,
        read: allows(identity, 'read', true), write: allows(identity, 'artifact.write', member.role === 'write'), grant: false });
    }
    return { ...data, agents, members: members.map(m => ({ ...m, name: m.kind === 'person' ? names[m.memberId] ?? 'Wayfinding member' : m.name })),
      pending: pending.map(p => ({ ...p, name: names[p.personId] ?? 'Wayfinding member' })) };
  }
  private accountView(account: Account): ToolData {
    return { personId: account.personId, personalGroupId: `personal_${account.personId}`, subject: account.subject, name: account.name, nickname: account.nickname, email: account.email };
  }
  async execute(subject: string, supplied: Command, clientId = 'trusted-host'): Promise<ToolData> {
    const result = await this.executeCommand(subject, supplied, clientId);
    const account = await this.accounts.lookup(subject);
    if (account) await this.accounts.observeClient(account.personId, clientId);
    return result;
  }
  private async executeCommand(subject: string, supplied: Command, clientId: string): Promise<ToolData> {
    const command = parseCommand(supplied.tool, supplied.input);
    const relayCommand = isRelay(command) || command.tool === 'mls_key_package_publish' || command.tool === 'mls_key_package_fetch';
    const account = relayCommand || command.tool === 'journey_invite' ? await this.accounts.lookup(subject) : await this.accounts.provision(subject);
    if (!account) throw new Refused(command.tool === 'journey_invite' ? 'Only guides may invite' : 'Account not provisioned; call account_read first');
    let actor: Actor;
    try { actor = await this.accounts.resolveActor(account.personId, clientId, 'actingAgent' in command.input ? command.input.actingAgent : undefined); }
    catch (error) { if (command.tool === 'journey_invite') throw new Refused('Only guides may invite'); throw error; }
    if (command.tool === 'mls_key_package_publish' || command.tool === 'mls_key_package_fetch') {
      if (actor.agent) throw new Refused('Only a person manages device key packages');
      return this.accounts.group(account.personId, command);
    }
    if (isRelay(command)) {
      if (command.input.groupId.startsWith('personal_')) {
        if (actor.agent) throw new Refused('Personal relay requires a person connection');
        return this.accounts.group(account.personId, command);
      }
      return this.journey(command.input.groupId).execute(account.personId, command, undefined, actor);
    }
    switch (command.tool) {
      case 'account_read':
        if (actor.agent) throw new Refused('Only a person reads the private account profile');
        return this.accountView(account);
      case 'account_update': {
        requireAccountCapability(actor, 'account.nickname');
        const updated = await this.accounts.update(account.personId, command.input.nickname);
        return actor.agent ? { nickname: updated.nickname, actingAgent: actor.agent.id } : this.accountView(updated);
      }
      case 'agent_create': case 'agent_list': case 'agent_narrow': case 'agent_remove': case 'agent_card': case 'client_list':
        return this.accounts.agentCommand(account.personId, clientId, command);
      case 'agent_capabilities': {
        const data = await this.accounts.agentCommand(account.personId, clientId, command);
        if (!command.input.journeyId) return data;
        const target = await this.accounts.resolveActor(account.personId, 'trusted-host', command.input.agentId);
        return this.journey(command.input.journeyId).execute(account.personId, command, undefined, target);
      }
      case 'journey_create': {
        requireAccountCapability(actor, 'journey.create');
        const id = `journey_${crypto.randomUUID()}`;
        await this.accounts.directory(id);
        return this.named(await this.journey(id).execute(account.personId, command, id, actor));
      }
      case 'journey_list': {
        if (!allows(actor, 'read', true)) throw new Refused('Reading journeys refused');
        const ids = await this.accounts.directory();
        const summaries = await Promise.all(ids.map(id => this.journey(id).summary(account.personId, actor)));
        return { journeys: summaries.filter(s => s !== undefined) };
      }
      case 'personal_group_add': case 'personal_group_read': case 'personal_group_remove':
        if (actor.agent) throw new Refused('Only a person manages personal group identities');
        return this.accounts.group(account.personId, command);
      case 'journey_invite': {
        const journey = this.journey(command.input.journeyId);
        if (command.input.email === undefined) return this.named(await journey.execute(account.personId, command, undefined, actor));
        await journey.requireGuide(account.personId, command, actor);
        const personId = await this.accounts.personIdByEmail(command.input.email);
        if (!personId) throw new Refused('No Wayfinding account uses that email yet; ask them to sign in once, then invite again');
        const resolved = parseCommand('journey_invite', { journeyId: command.input.journeyId, actingAgent: actor.agent?.id, personId });
        return this.named(await journey.execute(account.personId, resolved, undefined, actor));
      }
      default:
        if (!('journeyId' in command.input)) throw new Refused('Journey id required');
        if (command.tool === 'agent_add') {
          if (actor.agent) throw new Refused('Only a person adds agents');
          const target = await this.accounts.resolveActor(account.personId, 'trusted-host', command.input.agentId);
          return this.named(await this.journey(command.input.journeyId).execute(account.personId, command, undefined, target));
        }
        return this.named(await this.journey(command.input.journeyId).execute(account.personId, command, undefined, actor));
    }
  }
  private async actor(subject: string, clientId: string): Promise<Actor> {
    const account = await this.accounts.provision(subject);
    return this.accounts.resolveActor(account.personId, clientId);
  }
  async inbox(subject: string, journeyId: string, clientId = 'trusted-host'): Promise<ToolData> {
    const actor = await this.actor(subject, clientId); return this.journey(journeyId).inbox(actor.personId, actor);
  }
  async watchInbox(subject: string, journeyId: string, clientId = 'trusted-host'): Promise<ReadableStream<Uint8Array>> {
    const actor = await this.actor(subject, clientId); return this.journey(journeyId).watchInbox(actor.personId, actor);
  }
  async task(subject: string, method: TaskMethod, taskId: string, clientId = 'trusted-host'): Promise<ToolData> {
    const match = /^task_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(taskId);
    if (!match) throw new Refused('Invalid task id');
    const actor = await this.actor(subject, clientId); return this.journey(`journey_${match[1]}`).task(actor.personId, method, taskId, actor);
  }
}
export class MemoryBackend extends Backend {
  readonly accountStorage: MemoryStorage;
  readonly journeyStores: Map<string, MemoryStorage>;
  readonly blobs: MemoryBlobs;
  readonly accountsHost: AccountsHost;
  constructor(profiles: Profiles, now: () => number = Date.now, verifier?: PasskeyVerifier) {
    const storage = new MemoryStorage(), stores = new Map<string, MemoryStorage>(), hosts = new Map<string, JourneyHost>(), blobs = new MemoryBlobs();
    const accounts = new AccountsHost(storage, profiles, blobs, verifier, now);
    super(accounts, id => {
      let host = hosts.get(id);
      if (!host) { const store = new MemoryStorage(); stores.set(id, store); host = new JourneyHost(store, now, blobs); hosts.set(id, host); }
      return host;
    });
    this.accountsHost = accounts; this.accountStorage = storage; this.journeyStores = stores; this.blobs = blobs;
  }
  snapshot(): string {
    return JSON.stringify({ accounts: [...this.accountStorage.data], journeys: [...this.journeyStores].filter(([, s]) => s.data.size !== 0).map(([id, s]) => [id, [...s.data]]), blobs: [...this.blobs.data].map(([key, value]) => [key, encodeBytes(value)]) });
  }
}
