import { AccountsHost, type Account, type Profiles } from './accounts.ts';
import { Refused, parseCommand, isRelay, type Command, type CoordinationBackend, type ToolData } from './commands.ts';
import { JourneyHost } from './journey.ts';
import { MemoryStorage } from './storage.ts';
import { MemoryBlobs, encodeBytes } from './relay.ts';

export interface AccountsPort {
  provision(subject: string): Promise<Account>;
  lookup(subject: string): Promise<Account | undefined>;
  directory(add?: string): Promise<string[]>;
  group(personId: string, command: Command): Promise<ToolData>;
}
export interface JourneyPort {
  execute(personId: string, command: Command, journeyId?: string): Promise<ToolData>;
  summary(personId: string): Promise<ToolData | undefined>;
}

/** Authenticated people, never caller-supplied ids, select the acting account. */
export class Backend implements CoordinationBackend {
  private readonly accounts: AccountsPort;
  private readonly journey: (id: string) => JourneyPort;
  constructor(accounts: AccountsPort, journey: (id: string) => JourneyPort) { this.accounts = accounts; this.journey = journey; }
  async execute(subject: string, supplied: Command): Promise<ToolData> {
    const command = parseCommand(supplied.tool, supplied.input);
    // Relay refusals must not provision an account or otherwise write storage.
    const relayCommand = isRelay(command) || command.tool === 'mls_key_package_publish' || command.tool === 'mls_key_package_fetch';
    const account = relayCommand ? await this.accounts.lookup(subject) : await this.accounts.provision(subject);
    if (!account) throw new Refused('Account not provisioned; call account_read first');
    if (command.tool === 'mls_key_package_publish' || command.tool === 'mls_key_package_fetch') return this.accounts.group(account.personId, command);
    if (isRelay(command)) {
      if (command.input.groupId.startsWith('personal_')) return this.accounts.group(account.personId, command);
      return this.journey(command.input.groupId).execute(account.personId, command);
    }
    switch (command.tool) {
      case 'account_read': return { personId: account.personId, personalGroupId: `personal_${account.personId}`, subject: account.subject, name: account.name, email: account.email };
      case 'journey_create': {
        const id = `journey_${crypto.randomUUID()}`;
        // Reserve in the durable directory first. An interrupted create leaves
        // an empty entry, not an unreachable journey; summaries skip empty entries.
        await this.accounts.directory(id);
        return this.journey(id).execute(account.personId, command, id);
      }
      case 'journey_list': {
        const ids = await this.accounts.directory();
        const summaries = await Promise.all(ids.map((id) => this.journey(id).summary(account.personId)));
        return { journeys: summaries.filter((s) => s !== undefined) };
      }
      case 'personal_group_add': case 'personal_group_read': case 'personal_group_remove':
        return this.accounts.group(account.personId, command);
      default:
        if (!('journeyId' in command.input)) throw new Refused('Journey id required');
        return this.journey(command.input.journeyId).execute(account.personId, command);
    }
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
