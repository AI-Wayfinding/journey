import * as z from 'zod';
import { AccountsHost, type Account, type Profiles } from './accounts.ts';
import { Refused, parseCommand, isRelay, type Command, type CoordinationBackend, type TaskMethod, type ToolData } from './commands.ts';
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
}
export interface JourneyPort {
  requireGuide(personId: string, command: Command): Promise<void>;
  execute(personId: string, command: Command, journeyId?: string): Promise<ToolData>;
  summary(personId: string): Promise<ToolData | undefined>;
  inbox(personId: string): Promise<ToolData>;
  watchInbox(personId: string): Promise<ReadableStream<Uint8Array>>;
  task(personId: string, method: TaskMethod, taskId: string): Promise<ToolData>;
}

/** Authenticated people, never caller-supplied ids, select the acting account. */
export class Backend implements CoordinationBackend {
  private readonly accounts: AccountsPort;
  private readonly journey: (id: string) => JourneyPort;
  constructor(accounts: AccountsPort, journey: (id: string) => JourneyPort) { this.accounts = accounts; this.journey = journey; }
  private async named(data: ToolData): Promise<ToolData> {
    if (!('members' in data) || !('pending' in data)) return data;
    const { members, pending } = namedState.parse(data);
    const ids = [...members.filter(m => m.kind === 'person').map(m => m.memberId), ...pending.map(p => p.personId)];
    const names = await this.accounts.names(ids);
    return { ...data,
      members: members.map(m => ({ ...m, name: m.kind === 'person' ? names[m.memberId] ?? 'Wayfinding member' : m.name })),
      pending: pending.map(p => ({ ...p, name: names[p.personId] ?? 'Wayfinding member' })),
    };
  }
  private accountView(account: Account): ToolData {
    return { personId: account.personId, personalGroupId: `personal_${account.personId}`, subject: account.subject, name: account.name, nickname: account.nickname, email: account.email };
  }
  async execute(subject: string, supplied: Command): Promise<ToolData> {
    const command = parseCommand(supplied.tool, supplied.input);
    // Relay refusals must not provision an account or otherwise write storage.
    const relayCommand = isRelay(command) || command.tool === 'mls_key_package_publish' || command.tool === 'mls_key_package_fetch';
    const account = relayCommand || command.tool === 'journey_invite' ? await this.accounts.lookup(subject) : await this.accounts.provision(subject);
    if (!account) throw new Refused(command.tool === 'journey_invite' ? 'Only guides may invite' : 'Account not provisioned; call account_read first');
    if (command.tool === 'mls_key_package_publish' || command.tool === 'mls_key_package_fetch') return this.accounts.group(account.personId, command);
    if (isRelay(command)) {
      if (command.input.groupId.startsWith('personal_')) return this.accounts.group(account.personId, command);
      return this.journey(command.input.groupId).execute(account.personId, command);
    }
    switch (command.tool) {
      case 'account_read': return this.accountView(account);
      case 'account_update': return this.accountView(await this.accounts.update(account.personId, command.input.nickname));
      case 'journey_create': {
        const id = `journey_${crypto.randomUUID()}`;
        // Reserve in the durable directory first. An interrupted create leaves
        // an empty entry, not an unreachable journey; summaries skip empty entries.
        await this.accounts.directory(id);
        return this.named(await this.journey(id).execute(account.personId, command, id));
      }
      case 'journey_list': {
        const ids = await this.accounts.directory();
        const summaries = await Promise.all(ids.map((id) => this.journey(id).summary(account.personId)));
        return { journeys: summaries.filter((s) => s !== undefined) };
      }
      case 'personal_group_add': case 'personal_group_read': case 'personal_group_remove':
        return this.accounts.group(account.personId, command);
      case 'journey_invite': {
        const journey = this.journey(command.input.journeyId);
        if (command.input.email === undefined) return this.named(await journey.execute(account.personId, command));
        // Use the compiled rule (and agent card) before exposing any lookup result.
        await journey.requireGuide(account.personId, command);
        const personId = await this.accounts.personIdByEmail(command.input.email);
        if (!personId) throw new Refused('No Wayfinding account uses that email yet; ask them to sign in once, then invite again');
        const resolved = parseCommand('journey_invite', { journeyId: command.input.journeyId, actingAgent: command.input.actingAgent, personId });
        return this.named(await journey.execute(account.personId, resolved));
      }
      default:
        if (!('journeyId' in command.input)) throw new Refused('Journey id required');
        return this.named(await this.journey(command.input.journeyId).execute(account.personId, command));
    }
  }
  async inbox(subject: string, journeyId: string): Promise<ToolData> {
    const account = await this.accounts.provision(subject);
    return this.journey(journeyId).inbox(account.personId);
  }
  async watchInbox(subject: string, journeyId: string): Promise<ReadableStream<Uint8Array>> {
    const account = await this.accounts.provision(subject);
    return this.journey(journeyId).watchInbox(account.personId);
  }
  async task(subject: string, method: TaskMethod, taskId: string): Promise<ToolData> {
    const match = /^task_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(taskId);
    if (!match) throw new Refused('Invalid task id');
    const account = await this.accounts.provision(subject);
    return this.journey(`journey_${match[1]}`).task(account.personId, method, taskId);
  }
}

/** In-process DO stand-ins retain the real hosts and real generated rules. */
export class MemoryBackend extends Backend {
  readonly accountStorage: MemoryStorage;
  readonly journeyStores: Map<string, MemoryStorage>;
  readonly blobs: MemoryBlobs;
  constructor(profiles: Profiles, now: () => number = Date.now) {
    const storage = new MemoryStorage();
    const stores = new Map<string, MemoryStorage>();
    const hosts = new Map<string, JourneyHost>();
    const blobs = new MemoryBlobs();
    super(new AccountsHost(storage, profiles, blobs), (id) => {
      let host = hosts.get(id);
      if (!host) {
        const store = new MemoryStorage();
        stores.set(id, store);
        host = new JourneyHost(store, now, blobs);
        hosts.set(id, host);
      }
      return host;
    });
    this.accountStorage = storage;
    this.journeyStores = stores;
    this.blobs = blobs;
  }
  snapshot(): string {
    return JSON.stringify({ accounts: [...this.accountStorage.data], journeys: [...this.journeyStores].filter(([, s]) => s.data.size !== 0).map(([id, s]) => [id, [...s.data]]), blobs: [...this.blobs.data].map(([key, value]) => [key, encodeBytes(value)]) });
  }
}
