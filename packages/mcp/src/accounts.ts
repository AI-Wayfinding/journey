import { Refused, type Command, type ToolData } from './commands.ts';
import { personalGroupRule, RULES, sameRules, sameState, cell, SLOTS, type Snapshot, type RulesStamp } from './rules.ts';
import { Serial, type KeyValueStorage } from './storage.ts';

export interface Profile { name: string; email: string }
export interface Profiles { get(subject: string): Promise<Profile> }
export interface Account extends Profile { subject: string; personId: string; group: Snapshot; identities: { id: string; name: string; kind: 'device' | 'agent' }[] }
interface AccountsState { rulesHash: RulesStamp; accounts: Account[]; journeys: string[] }

export class AccountsHost {
  private readonly serial = new Serial();
  private readonly storage: KeyValueStorage;
  private readonly profiles: Profiles;
  constructor(storage: KeyValueStorage, profiles: Profiles) { this.storage = storage; this.profiles = profiles; }
  private async load(): Promise<AccountsState> {
    const raw = await this.storage.get('accounts');
    if (raw === undefined) return { rulesHash: RULES, accounts: [], journeys: [] };
    if (typeof raw !== 'string') throw new Refused('Invalid stored accounts');
    const state = JSON.parse(raw) as AccountsState;
    if (!sameRules(state.rulesHash)) throw new Refused('Stored accounts use different rules');
    return state;
  }
  provision(subject: string): Promise<Account> {
    return this.serial.run(async () => {
      const state = await this.load();
      const existing = state.accounts.find((a) => a.subject === subject);
      if (existing) return existing;
      const profile = await this.profiles.get(subject);
      const groupRule = personalGroupRule(1);
      const group = groupRule.step(groupRule.init(), { op: 0, subject: 1, kind: 1, belongsTo: 1 });
      const account: Account = { subject, personId: `person_${crypto.randomUUID()}`, name: profile.name, email: profile.email, group, identities: [] };
      state.accounts.push(account);
      await this.storage.put('accounts', JSON.stringify(state));
      return account;
    });
  }
  directory(add?: string): Promise<string[]> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (add !== undefined && !state.journeys.includes(add)) {
        state.journeys.push(add);
        await this.storage.put('accounts', JSON.stringify(state));
      }
      return state.journeys;
    });
  }
  group(personId: string, command: Command): Promise<ToolData> {
    return this.serial.run(async () => {
      const state = await this.load();
      const account = state.accounts.find((a) => a.personId === personId);
      if (!account) throw new Refused('Account not found');
      const machine = personalGroupRule(1);
      if (command.tool === 'personal_group_add') {
        const slot = account.identities.length + 2;
        if (slot >= SLOTS) throw new Refused('Personal group is full');
        const next = machine.step(account.group, { op: 0, subject: slot, kind: command.input.kind === 'device' ? 2 : 3, belongsTo: 1 });
        if (sameState(account.group, next)) throw new Refused('Personal group admission refused');
        account.group = next;
        account.identities.push({ id: `${command.input.kind}_${crypto.randomUUID()}`, name: command.input.name, kind: command.input.kind });
      } else if (command.tool === 'personal_group_remove') {
        const index = account.identities.findIndex((m) => m.id === command.input.memberId);
        if (command.input.memberId !== personId && index < 0) throw new Refused('Unknown personal group member');
        const slot = command.input.memberId === personId ? 1 : index + 2;
        const next = machine.step(account.group, { op: 1, subject: slot, kind: 0, belongsTo: 1 });
        if (sameState(account.group, next)) throw new Refused('Personal group removal refused');
        account.group = next;
      } else if (command.tool !== 'personal_group_read') throw new Refused('Not a personal group command');
      // Reading never writes. Refusals above never put partially changed data.
      if (command.tool !== 'personal_group_read') await this.storage.put('accounts', JSON.stringify(state));
      return { owner: personId, members: [{ id: personId, kind: 'person' }, ...account.identities.filter((_, i) => cell(account.group, 'Members', i + 2) !== 0)] };
    });
  }
}

/** Profile values come only from the authenticated WorkOS management API. */
export class WorkOSProfiles implements Profiles {
  private readonly apiKey: string;
  private readonly send: typeof fetch;
  constructor(apiKey: string, send: typeof fetch = fetch) { this.apiKey = apiKey; this.send = send; }
  async get(subject: string): Promise<Profile> {
    const response = await this.send(`https://api.workos.com/user_management/users/${encodeURIComponent(subject)}`, {
      headers: { authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Refused('Account profile lookup failed');
    const user: unknown = await response.json();
    if (typeof user !== 'object' || user === null || !('id' in user) || user.id !== subject || !('email' in user) || typeof user.email !== 'string') {
      throw new Refused('Account profile is invalid');
    }
    const first = 'first_name' in user && typeof user.first_name === 'string' ? user.first_name : '';
    const last = 'last_name' in user && typeof user.last_name === 'string' ? user.last_name : '';
    return { name: [first, last].filter(Boolean).join(' ') || user.email, email: user.email };
  }
}
