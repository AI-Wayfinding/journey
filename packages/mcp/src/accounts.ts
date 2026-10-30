import { Refused, isRelay, type Command, type KeyPackageCommand, type ToolData } from './commands.ts';
import { personalGroupRule, RULES, sameRules, sameState, cell, SLOTS, type Snapshot, type RulesStamp } from './rules.ts';
import { Serial, type KeyValueStorage } from './storage.ts';
import { relay, decodeBytes, type BlobStore } from './relay.ts';
import { bindingRule, cardRule, scalar } from './rules.ts';
import { assertionSchema, changeSchema, changeDigest, base64url, cardCaps, stepCard, requireAccountCapability, WebAuthnVerifier, type AgentAccount, type Actor, type ClientIdentity, type CardChange, type PasskeyVerifier } from './agents.ts';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

export interface Profile { name: string; email: string }
export interface Profiles { get(subject: string): Promise<Profile> }
export interface Account extends Profile, AgentAccount { subject: string; personId: string; nickname?: string; group: Snapshot; identities: { id: string; name: string; kind: 'device' | 'agent' }[] }
interface AccountsState { rulesHash: RulesStamp; accounts: Account[]; journeys: string[] }

export class AccountsHost {
  private readonly serial = new Serial();
  private readonly storage: KeyValueStorage;
  private readonly profiles: Profiles;
  private readonly blobs: BlobStore | undefined;
  private readonly verifier: PasskeyVerifier;
  private readonly now: () => number;
  constructor(storage: KeyValueStorage, profiles: Profiles, blobs?: BlobStore, verifier: PasskeyVerifier = new WebAuthnVerifier(), now: () => number = Date.now) { this.storage = storage; this.profiles = profiles; this.blobs = blobs; this.verifier = verifier; this.now = now; }
  private async load(): Promise<AccountsState> {
    const raw = await this.storage.get('accounts');
    if (raw === undefined) return { rulesHash: RULES, accounts: [], journeys: [] };
    if (typeof raw !== 'string') throw new Refused('Invalid stored accounts');
    const state = JSON.parse(raw) as AccountsState;
    if (!sameRules(state.rulesHash)) throw new Refused('Stored accounts use different rules');
    return state;
  }
  lookup(subject: string): Promise<Account | undefined> {
    return this.serial.run(async () => (await this.load()).accounts.find(a => a.subject === subject));
  }
  provision(subject: string): Promise<Account> {
    return this.serial.run(async () => {
      const state = await this.load();
      const existing = state.accounts.find((a) => a.subject === subject);
      if (existing) return existing;
      const profile = await this.profiles.get(subject);
      const groupRule = personalGroupRule(1);
      const group = groupRule.step(groupRule.init(), { op: 0, subject: 1, kind: 1, belongsTo: 1 });
      const account: Account = { subject, personId: `person_${crypto.randomUUID()}`, name: profile.name, email: profile.email, group, identities: [], agents: [], clients: [], bindings: bindingRule.init(), passkeys: [], assertions: [], live: true };
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
  update(personId: string, nickname: string): Promise<Account> {
    return this.serial.run(async () => {
      const state = await this.load();
      const account = state.accounts.find(a => a.personId === personId);
      if (!account) throw new Refused('Account not found');
      account.nickname = nickname;
      await this.storage.put('accounts', JSON.stringify(state));
      return account;
    });
  }
  names(personIds: string[]): Promise<Record<string, string>> {
    return this.serial.run(async () => {
      const state = await this.load();
      return Object.fromEntries(state.accounts.filter(a => personIds.includes(a.personId)).map(a => {
        const name = a.nickname ?? a.name;
        // WorkOS uses email as its fallback name; never relay it to other people.
        const safe = a.email && name.toLowerCase().includes(a.email.toLowerCase()) ? 'Wayfinding member' : name;
        return [a.personId, safe];
      }));
    });
  }
  personIdByEmail(email: string): Promise<string | undefined> {
    return this.serial.run(async () => (await this.load()).accounts.find(a => a.email.toLowerCase() === email.toLowerCase())?.personId);
  }
  private resolve(account: Account, clientId: string, actingAgent?: string): Actor {
    const client = account.clients.indexOf(clientId) + 1;
    const bound = account.agents[cell(account.bindings, 'Agents', client) - 2];
    const next = bindingRule.step(account.bindings, { op: 3, client, agent: 0, personAsserted: 0, agentIsOwnLive: 0, personLive: +account.live, boundAgentLive: +(bound?.live ?? false) });
    if (scalar(next, 'allowed') !== 1) throw new Refused('Client or person is no longer live');
    if (scalar(next, 'asAgent') === 1 && actingAgent !== undefined && actingAgent !== bound?.id) throw new Refused('Bound client cannot replace its agent');
    const agentId = scalar(next, 'asAgent') === 1 ? bound?.id : actingAgent;
    const agent = agentId === undefined ? undefined : account.agents.find(a => a.id === agentId && a.live);
    if (agentId !== undefined && !agent) throw new Refused('Only your own live agent may act');
    return { personId: account.personId, ...(agent ? { agent } : {}) };
  }
  observeClient(personId: string, clientId: string): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load(), account = state.accounts.find(a => a.personId === personId);
      if (!account || !account.live) throw new Refused('Live account required');
      if (!account.clients.includes(clientId)) {
        account.clients.push(clientId);
        await this.storage.put('accounts', JSON.stringify(state));
      }
    });
  }
  /** Trusted account-removal event; tombstones prevent later token reprovisioning. */
  removePerson(subject: string): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load(), account = state.accounts.find(a => a.subject === subject);
      if (!account) throw new Refused('Account not found');
      account.live = false;
      for (const [i, agent] of account.agents.entries()) {
        agent.live = false; agent.card = stepCard(agent.card, 'withdraw');
        account.bindings = bindingRule.step(account.bindings, { op: 2, client: 0, agent: i + 2, personAsserted: 0, agentIsOwnLive: 0, personLive: 0, boundAgentLive: 0 });
      }
      account.assertions = [];
      await this.storage.put('accounts', JSON.stringify(state));
    });
  }
  resolveActor(personId: string, clientId: string, actingAgent?: string): Promise<Actor> {
    return this.serial.run(async () => {
      const account = (await this.load()).accounts.find(a => a.personId === personId);
      if (!account) throw new Refused('Account not found');
      return this.resolve(account, clientId, actingAgent);
    });
  }
  agentCommand(personId: string, clientId: string, command: Command): Promise<ToolData> {
    return this.serial.run(async () => {
      const state = await this.load(), account = state.accounts.find(a => a.personId === personId);
      if (!account) throw new Refused('Account not found');
      const actor = this.resolve(account, clientId, 'actingAgent' in command.input ? command.input.actingAgent : undefined);
      const view = (a: Account['agents'][number]) => ({ agentId: a.id, name: a.name, live: a.live, signed: scalar(a.card, 'signed') === 1, capabilities: cardCaps(a.card) });
      switch (command.tool) {
        case 'client_list': return { clientId, actingAgent: actor.agent?.id, clients: account.clients.map((id, i) => ({ clientId: id, agentId: cell(account.bindings, 'Bound', i + 1) || cell(account.bindings, 'Revoked', i + 1) ? account.agents[cell(account.bindings, 'Agents', i + 1) - 2]?.id : undefined, bound: cell(account.bindings, 'Bound', i + 1) === 1, revoked: cell(account.bindings, 'Revoked', i + 1) === 1 })) };
        case 'agent_list': return { agents: account.agents.map(view) };
        case 'agent_create': {
          if (actor.agent) throw new Refused('Only a person adds agents');
          const agent = { id: `agent_${crypto.randomUUID()}`, name: command.input.name, live: true, card: cardRule.init() };
          account.agents.push(agent); await this.storage.put('accounts', JSON.stringify(state)); return view(agent);
        }
        case 'agent_capabilities': case 'agent_narrow': case 'agent_card': case 'agent_remove': {
          const agent = account.agents.find(a => a.id === command.input.agentId && a.live);
          if (!agent) throw new Refused('Only a live agent owner may use its card');
          if (command.tool === 'agent_capabilities') return view(agent);
          if (command.tool === 'agent_remove') {
            requireAccountCapability(actor, 'agent.remove'); agent.live = false; agent.card = stepCard(agent.card, 'withdraw');
            account.bindings = bindingRule.step(account.bindings, { op: 2, client: 0, agent: account.agents.indexOf(agent) + 2, personAsserted: 0, agentIsOwnLive: 0, personLive: +account.live, boundAgentLive: 0 });
          } else {
            const keep = command.tool === 'agent_card' ? [] : cardCaps(agent.card).filter(c => !command.input.remove.includes(c));
            agent.card = stepCard(agent.card, command.tool === 'agent_card' ? 'withdraw' : 'narrow', keep);
          }
          await this.storage.put('accounts', JSON.stringify(state)); return view(agent);
        }
        default: throw new Refused('Not an account agent command');
      }
    });
  }
  beginAuthorization(identity: ClientIdentity, supplied: CardChange): Promise<{ challenge: string }> {
    return this.serial.run(async () => {
      const state = await this.load(), account = state.accounts.find(a => a.subject === identity.subject);
      if (!account || this.resolve(account, identity.clientId).agent) throw new Refused('Only a live person may authorize console changes');
      const change = changeSchema.parse(supplied);
      if (!account.agents.some(a => a.id === change.agentId && a.live)) throw new Refused('Only an owned live agent may be changed');
      const digest = await changeDigest(account.personId, change);
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const challenge = base64url(new TextEncoder().encode(base64url(nonce) + digest));
      account.assertions = account.assertions.filter(a => a.expiresAt > this.now() && a.digest !== digest).slice(-15);
      account.assertions.push({ challenge, digest, expiresAt: this.now() + 300_000 });
      await this.storage.put('accounts', JSON.stringify(state)); return { challenge };
    });
  }
  completeAuthorization(identity: ClientIdentity, supplied: CardChange, assertion: AuthenticationResponseJSON | undefined): Promise<ToolData> {
    return this.serial.run(async () => {
      const state = await this.load(), account = state.accounts.find(a => a.subject === identity.subject);
      if (!account || this.resolve(account, identity.clientId).agent) throw new Refused('Only a live person may authorize console changes');
      const proof = assertionSchema.safeParse(assertion);
      if (!proof.success) throw new Refused('Passkey assertion required');
      const change = changeSchema.parse(supplied), digest = await changeDigest(account.personId, change);
      const pending = account.assertions.find(a => a.digest === digest && a.expiresAt > this.now());
      if (!pending) throw new Refused('Fresh assertion over this exact change required');
      let verified;
      try { verified = await this.verifier.verify(proof.data, pending.challenge, account.passkeys); }
      catch { throw new Refused('Passkey assertion refused'); }
      const agent = account.agents.find(a => a.id === change.agentId && a.live);
      if (!agent) throw new Refused('Only an owned live agent may be changed');
      if (change.kind === 'card') agent.card = stepCard(agent.card, scalar(agent.card, 'signed') ? 'widen' : 'sign', change.capabilities, 'read', false, true, true, true);
      else {
        let client = account.clients.indexOf(change.clientId) + 1;
        if (!client) { account.clients.push(change.clientId); client = account.clients.length; }
        account.bindings = bindingRule.step(account.bindings, { op: change.kind === 'bind' ? 0 : 1, client, agent: account.agents.indexOf(agent) + 2, personAsserted: 1, agentIsOwnLive: 1, personLive: +account.live, boundAgentLive: +agent.live });
      }
      const credential = account.passkeys.find(c => c.id === verified.credentialId);
      if (credential) credential.counter = verified.counter;
      account.assertions = account.assertions.filter(a => a !== pending);
      await this.storage.put('accounts', JSON.stringify(state)); return { accepted: true };
    });
  }
  private requireIdentity(account: Account, memberId: string): void {
    const index = account.identities.findIndex(m => m.id === memberId);
    const slot = memberId === account.personId ? 1 : index < 0 ? 0 : index + 2;
    if (!slot || cell(account.group, 'Members', slot) === 0 || cell(account.group, 'Belongs', slot) !== 1) throw new Refused('Only a live owned personal group identity may relay');
  }
  private async keyPackage(state: AccountsState, caller: Account, command: KeyPackageCommand): Promise<ToolData> {
    const account = command.tool === 'mls_key_package_publish' ? caller : state.accounts.find(a => a.personId === command.input.personId);
    if (!account) throw new Refused('Key package person not found');
    const { deviceId } = command.input;
    if (!account.identities.some(m => m.id === deviceId)) throw new Refused('Registered device or agent required');
    this.requireIdentity(account, deviceId);
    const key = JSON.stringify(['keyPackage', account.personId, deviceId]);
    const raw = await this.storage.get(key);
    if (command.tool === 'mls_key_package_publish') {
      decodeBytes(command.input.data, 64 * 1024);
      if (typeof raw === 'string' && raw !== 'null') throw new Refused('Unconsumed key package already exists');
      await this.storage.put(key, JSON.stringify(command.input.data));
      return { published: true };
    }
    const data = typeof raw === 'string' ? JSON.parse(raw) as string | null : null;
    if (data !== null) await this.storage.put(key, 'null');
    return { personId: account.personId, deviceId, data };
  }
  group(personId: string, command: Command): Promise<ToolData> {
    return this.serial.run(async () => {
      const state = await this.load();
      const account = state.accounts.find((a) => a.personId === personId);
      if (!account) throw new Refused('Account not found');
      if (command.tool === 'mls_key_package_publish' || command.tool === 'mls_key_package_fetch') return this.keyPackage(state, account, command);
      if (isRelay(command)) {
        if (command.input.groupId !== `personal_${personId}`) throw new Refused('Only the personal group owner may relay');
        if (command.input.actingAgent !== undefined) throw new Refused('Use memberId for personal device or agent identity');
        const member = command.input.memberId ?? personId;
        this.requireIdentity(account, member);
        return relay(this.storage, this.blobs, member, command);
      }
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
  private readonly apiKey: string | undefined;
  private readonly send: typeof fetch;
  // Bind the default: workerd throws "Illegal invocation" when fetch runs with another `this`.
  constructor(apiKey: string | undefined, send: typeof fetch = (input, init) => fetch(input, init)) { this.apiKey = apiKey; this.send = send; }
  async get(subject: string): Promise<Profile> {
    if (typeof this.apiKey !== 'string' || this.apiKey.trim().length === 0) {
      throw new Refused('Server configuration error: WORKOS_API_KEY is required for account profiles');
    }
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
