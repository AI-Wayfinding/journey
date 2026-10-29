import { AccountsHost, type Account, type Profiles } from './accounts.ts';
import { Refused, parseCommand, type Command, type CoordinationBackend, type TaskMethod, type ToolData } from './commands.ts';
import { JourneyHost } from './journey.ts';
import { MemoryStorage } from './storage.ts';

export interface AccountsPort {
  provision(subject: string): Promise<Account>;
  directory(add?: string): Promise<string[]>;
  group(personId: string, command: Command): Promise<ToolData>;
}
export interface JourneyPort {
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
  async execute(subject: string, supplied: Command): Promise<ToolData> {
    const command = parseCommand(supplied.tool, supplied.input);
    const account = await this.accounts.provision(subject);
    switch (command.tool) {
      case 'account_read': return { personId: account.personId, subject: account.subject, name: account.name, email: account.email };
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
  constructor(profiles: Profiles, now: () => number = Date.now) {
    const storage = new MemoryStorage();
    const stores = new Map<string, MemoryStorage>();
    const hosts = new Map<string, JourneyHost>();
    super(new AccountsHost(storage, profiles), (id) => {
      let host = hosts.get(id);
      if (!host) {
        const store = new MemoryStorage();
        stores.set(id, store);
        host = new JourneyHost(store, now);
        hosts.set(id, host);
      }
      return host;
    });
    this.accountStorage = storage;
    this.journeyStores = stores;
  }
  snapshot(): string {
    return JSON.stringify({ accounts: [...this.accountStorage.data], journeys: [...this.journeyStores].filter(([, s]) => s.data.size !== 0).map(([id, s]) => [id, [...s.data]]) });
  }
}
