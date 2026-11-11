import * as z from 'zod';
import { verifyDescriptor } from './sealed-identities.ts';
import { internalDefinition, verifyDefinition } from './sealed-offers.ts';
import { sealedDescriptor, type SealedDescriptor, sealedOfferDefinition, type DefinitionRef } from './sealed-descriptors.ts';
import type { OfferAgent, StandingDecision } from './offers.ts';
import type { WritePort, WritePermit, WriteReceipt, WriteDrain } from './write-permits.ts';
import { AccountsHost, type Account, type Profiles } from './accounts.ts';
import { Refused, parseCommand, isRelay, type Command, type CoordinationBackend, type TaskMethod, type ToolData } from './commands.ts';
import { assertionSchema, allows, requireAccountCapability, type Actor, type ClientIdentity, type CardChange, type PasskeyVerifier } from './agents.ts';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { JourneyHost } from './journey.ts';
import { itemJourney } from './library.ts';
import { isForumCommand, forumCommandJourney } from './forum.ts';
import { isRoundCommand, roundJourney } from './rounds.ts';
import { MemoryStorage } from './storage.ts';
import { MemoryBlobs, encodeBytes } from './relay.ts';
import { sealedInputs, sealedRouting, SEALED_NOTICE, type DeviceBinding } from './sealed-contract.ts';
import type { SealedAuthority } from './sealed-content.ts';

import type { RecordOperation, ConsoleRecord, PasskeyOperation } from './console/contract.ts';
const namedState = z.object({
  members: z.array(z.object({ memberId: z.string(), name: z.string(), kind: z.enum(['person', 'agent']), role: z.enum(['read', 'write']), guide: z.boolean(), owner: z.string().optional() }).strict()),
  pending: z.array(z.object({ personId: z.string(), name: z.string(), status: z.string() }).strict()),
});
import type { OAuthPort, OAuthOperation, AgentConsent } from './oauth-contract.ts';
import { agentConsent } from './oauth-contract.ts';
import { cardCaps } from './agents.ts';
export interface AccountsPort extends OAuthPort, WritePort {
  publishedDescriptors?(journeyId:string,ids:string[]):Promise<ToolData>;
  setDescriptor?(personId:string,clientId:string,agentId:string|undefined,descriptor:SealedDescriptor):Promise<ToolData>;
  sealedDevice?(personId:string,clientId:string,tool:string,input:unknown):Promise<ToolData>;
  deviceBinding?(deviceId:string):Promise<DeviceBinding>;
  reserveDevice?(deviceId:string,groupId:string):Promise<DeviceBinding>;
  drainWrites(personId?: string): Promise<WriteDrain>;
  offerDirectory(): Promise<OfferAgent[]>;
  standingDecision(decision: StandingDecision): Promise<void>;
  consoleRecord(operation: RecordOperation): Promise<ConsoleRecord | undefined>;
  passkey(identity: ClientIdentity, operation: PasskeyOperation): Promise<ToolData>;
  provision(subject: string): Promise<Account>;
  lookup(subject: string): Promise<Account | undefined>;
  update(personId: string, nickname: string): Promise<Account>;
  names(personIds: string[]): Promise<Record<string, string>>;
  personIdByEmail(email: string): Promise<string | undefined>;
  directory(add?: string): Promise<string[]>;
  group(personId: string, command: Command, actor?: Actor): Promise<ToolData>;
  observeClient(personId: string, clientId: string): Promise<void>;
  resolveActor(personId: string, clientId: string, actingAgent?: string): Promise<Actor>;
  agentCommand(personId: string, clientId: string, command: Command): Promise<ToolData>;
  beginAuthorization(identity: ClientIdentity, change: CardChange): Promise<{ challenge: string }>;
  completeAuthorization(identity: ClientIdentity, change: CardChange, assertion: AuthenticationResponseJSON | undefined): Promise<ToolData>;
}
export interface JourneyPort {
  sealed?(personId:string,tool:string,input:unknown,actor:Actor,authority:SealedAuthority):Promise<ToolData>;
  cancelWrite(permit: WritePermit): Promise<WriteReceipt>;
  syncAgent(personId: string, agentId: string, name: string, present: boolean): Promise<void>;
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
  readonly sealedMode:boolean;
  constructor(accounts: AccountsPort, journey: (id: string) => JourneyPort, sealedMode=false) { this.accounts = accounts; this.journey = journey;this.sealedMode=sealedMode; }
  async sealedExecute(subject:string,tool:string,input:unknown,clientId='trusted-host'):Promise<ToolData>{
    if(!this.sealedMode)throw new Refused('Sealed generation not enabled');
    if(tool==='task_step')tool='task_exchange';
    const parsed=sealedInputs[tool]?.safeParse(input);if(!parsed?.success)throw new Refused('Invalid sealed fields or unknown format');const named=parsed.data as Record<string,unknown>;
    await this.recoverWrites();const account=await this.accounts.provision(subject),actor=await this.accounts.resolveActor(account.personId,clientId);
    if(actor.agent&&(tool==='content_prepare'||Object.hasOwn(sealedRouting,tool))&&(!allows(actor,'read',true)||!allows(actor,'device.keys',true)))throw new Refused('Sealed content refused: needs read + device.keys; ask the owner to grant both explicitly');
    const read=(ref:DefinitionRef)=>this.sealedExecute(subject,'sealed_record_read',ref,clientId);
    if(tool==='agent_create')return this.executeCommand(subject,parseCommand('agent_create',{name:SEALED_NOTICE}),clientId);
    if(tool==='account_update'||tool==='agent_descriptor_set'){const agentId=tool==='agent_descriptor_set'?String(named.agentId):undefined;const d=sealedDescriptor.parse(named.sealed);if(agentId&&(!account.agents.some(a=>a.id===agentId&&a.live)||actor.agent&&actor.agent.id!==agentId))throw new Refused('Owned live agent required');await verifyDescriptor(d.privateDefinition,account.personId,agentId,d.contentRevision,true,read);for(const [journeyId,ref] of Object.entries(d.publications)){if(ref.journeyId!==journeyId)throw new Refused('Descriptor publication journey mismatch');await verifyDescriptor(ref,account.personId,agentId,d.contentRevision,false,read);}if(!this.accounts.setDescriptor)throw new Refused('Descriptor storage unavailable');return this.accounts.setDescriptor(account.personId,clientId,agentId,d);}
    if(tool==='offer_set'){
      const definition=z.object({id:z.string(),sealed:sealedOfferDefinition,journeySettings:z.record(z.string(),z.unknown()),admission:z.unknown()}).parse(named.offer),agentId=String(named.agentId);
      if(!account.agents.some(a=>a.id===agentId&&a.live)||actor.agent&&actor.agent.id!==agentId)throw new Refused('Owned live agent required');
      const d=definition.sealed;await verifyDefinition(d.privateDefinition,account.personId,agentId,definition.id,d.contentRevision,true,read);
      for(const [journeyId,ref] of Object.entries(d.publications)){if(ref.journeyId!==journeyId)throw new Refused('Offer journey publication mismatch');await verifyDefinition(ref,account.personId,agentId,definition.id,d.contentRevision,false,read);}
      for(const [journeyId,row] of Object.entries(definition.journeySettings))if(z.object({enabled:z.boolean()}).parse(row).enabled&&!d.publications[journeyId])throw new Refused('Enabled journey needs a current sealed publication');
      return this.executeCommand(subject,parseCommand('offer_set',{agentId,expectedVersion:named.expectedVersion,offer:internalDefinition(definition.id,d,definition.journeySettings,definition.admission)}),clientId);
    }
    if(tool==='offer_search'){const result=await this.executeCommand(subject,parseCommand('offer_search',{journeyId:named.journeyId}),clientId);return {journeyId:named.journeyId,offers:z.array(z.record(z.string(),z.unknown())).parse(result.offers).map(o=>({id:o.id,agentId:o.agentId,owner:o.owner,version:o.version,contentRevision:o.contentRevision,status:o.status,admission:o.admission,publication:z.record(z.string(),z.unknown()).parse(o.publications??{})[String(named.journeyId)]}))};}
    if(tool==='journey_create'){requireAccountCapability(actor,'journey.create');return this.executeCommand(subject,parseCommand('journey_create',{name:SEALED_NOTICE,policy:named.policy,defaultRole:named.defaultRole}),clientId);}
    if(tool==='sealed_device_register'||tool==='sealed_device_binding'){if(!this.accounts.sealedDevice)throw new Refused('Device binding storage unavailable');return this.accounts.sealedDevice(account.personId,clientId,tool,named);}
    const journeyId=z.string().min(1).max(200).parse(named.journeyId),port=this.journey(journeyId);if(!port.sealed||!this.accounts.deviceBinding||!this.accounts.reserveDevice)throw new Refused('Sealed storage unavailable');
    const result=await port.sealed(account.personId,tool,named,actor,{binding:id=>this.accounts.deviceBinding!(id),reserve:(id,group)=>this.accounts.reserveDevice!(id,group)});const revocation=await this.recoverWrites(account.personId);if(revocation.state==='pending')result.revocation={state:'pending',retryAt:revocation.retryAt};return result;
  }
  oauth(operation: OAuthOperation) { return this.accounts.oauth(operation); }
  async consentAgent(subject: string, id: string, supplied: AgentConsent, assertion?: AuthenticationResponseJSON): Promise<string> {
    const consent = agentConsent.parse(supplied), account = await this.accounts.lookup(subject);
    if (!account?.live) throw new Refused('Live account required');
    await this.validateJourneys(account.personId, consent.journeys);
    const result = await this.accounts.oauth({ op: 'consent', id, subject, consent, assertion: assertionSchema.optional().parse(assertion) });
    if (result.kind !== 'agent') throw new Refused('Agent consent refused');
    await this.syncAgentJourneys(account.personId, result.agentId, this.sealedMode?result.agentId:consent.name, consent.journeys);
    await this.accounts.oauth({ op: 'manage', subject, agentId: result.agentId, journeys: consent.journeys });
    return result.agentId;
  }
  private async validateJourneys(personId: string, selected: string[]) {
    const ids = await this.accounts.directory();
    for (const id of selected) {
      if (!ids.includes(id)) throw new Refused('Journey membership required');
      const summary = await this.journey(id).summary(personId);
      if (!summary || summary.pending) throw new Refused('Journey membership required');
    }
  }
  private async syncAgentJourneys(personId: string, agentId: string, name: string, selected: string[]) {
    for (const id of await this.accounts.directory()) await this.journey(id).syncAgent(personId, agentId, name, selected.includes(id));
  }
  async manageAgent(identity: ClientIdentity, agentId: string, name: string, journeys: string[]): Promise<void> {
    const account = await this.accounts.lookup(identity.subject);
    if (!account || (await this.accounts.resolveActor(account.personId, identity.clientId)).agent) throw new Refused('Only a person manages agents');
    const own = account.agents.find(a => a.id === agentId && a.live);
    if (!own) throw new Refused('Owned live agent required');
    if(this.sealedMode&&name!==agentId)throw new Refused('Agent names must be sealed by an enrolled proxy');
    const parsed = agentConsent.parse({ name, capabilities: cardCaps(own.card), journeys });
    await this.validateJourneys(account.personId, parsed.journeys);
    await this.syncAgentJourneys(account.personId, agentId, parsed.name, parsed.journeys);
    await this.accounts.oauth({ op: 'manage', subject: identity.subject, agentId, name: parsed.name, journeys: parsed.journeys });
  }
  async whoami(subject: string, clientId: string): Promise<ToolData> {
    const account = await this.accounts.lookup(subject);
    if (!account) throw new Refused('Live account required');
    const actor = await this.accounts.resolveActor(account.personId, clientId);
    return { person: { id: account.personId, name: account.nickname ?? account.name }, agent: actor.agent ? { id: actor.agent.id, name: actor.agent.name, capabilities: cardCaps(actor.agent.card), journeys: await this.agentMemberships(account.personId, actor.agent.id) } : null };
  }
  private async agentMemberships(personId: string, agentId: string): Promise<string[]> {
    const journeys: string[] = [];
    for (const id of await this.accounts.directory()) {
      const summary = await this.journey(id).summary(personId);
      if (!summary || summary.pending) continue;
      const view = await this.journey(id).execute(personId, parseCommand('journey_read', { journeyId: id }));
      if (namedState.shape.members.parse(view.members).some(m => m.memberId === agentId)) journeys.push(id);
    }
    return journeys;
  }
  consoleRecord(operation: RecordOperation) { return this.accounts.consoleRecord(operation); }
  passkey(identity: ClientIdentity, operation: PasskeyOperation) { return this.accounts.passkey(identity, operation); }
  beginAuthorization(identity: ClientIdentity, change: CardChange) { return this.accounts.beginAuthorization(identity, change); }
  async completeAuthorization(identity: ClientIdentity, change: CardChange, assertion: AuthenticationResponseJSON | undefined): Promise<ToolData> {
    const result = await this.accounts.completeAuthorization(identity, change, assertion);
    const account = await this.accounts.lookup(identity.subject), revocation = await this.recoverWrites(account?.personId);
    if (revocation.state === 'pending') result.revocation = { state: revocation.state, retryAt: revocation.retryAt };
    return result;
  }
  private async namedForum(data: ToolData): Promise<ToolData> {
    const row = z.object({ author: z.string(), authorKind: z.enum(['person', 'agent']) }).passthrough();
    const posts = data.posts === undefined ? [] : z.array(row).parse(data.posts);
    const topics = data.topics === undefined ? [] : z.array(row).parse(data.topics);
    const topic = data.topic == null ? undefined : row.parse(data.topic);
    const own = row.safeParse(data);
    const people = [...new Set([...posts, ...topics, ...(topic ? [topic] : []), ...(own.success ? [own.data] : [])].filter(r => r.authorKind === 'person').map(r => r.author))];
    const names: Record<string, string> = {};
    for (let i = 0; i < people.length; i += 128) Object.assign(names, await this.accounts.names(people.slice(i, i + 128)));
    const name = (r: z.output<typeof row>): ToolData => ({ ...r, authorName: r.authorKind === 'person' ? names[r.author] ?? 'Wayfinding member' : r.authorName });
    const result = own.success ? name(own.data) : { ...data };
    if (data.posts !== undefined) result.posts = posts.map(name);
    if (data.topics !== undefined) result.topics = topics.map(name);
    if (topic) result.topic = name(topic);
    return result;
  }
  private async named(data: ToolData): Promise<ToolData> {
    if (!('members' in data) || !('pending' in data)) return data;
    const { members, pending } = namedState.parse(data);
    if(this.sealedMode&&this.accounts.publishedDescriptors&&typeof data.journeyId==='string')data={...data,...await this.accounts.publishedDescriptors(data.journeyId,members.map(m=>m.memberId))};
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
    return { personId: account.personId, personalGroupId: `personal_${account.personId}`, subject: account.subject, name: account.name, nickname: account.nickname, email: account.email,descriptor:account.descriptor, ...(this.sealedMode?{contentFormat:'sealed-v1'}:{}) };
  }
  async execute(subject: string, supplied: Command, clientId = 'trusted-host'): Promise<ToolData> {
    if(this.sealedMode&&(Object.hasOwn(sealedInputs,supplied.tool)||/^(artifact_|mls_|library_|topic_|post_|conversation_|board_|round_|interview_|project_|task_)/.test(supplied.tool)))throw new Refused(SEALED_NOTICE+'; use the sealed client contract');
    await this.recoverWrites();
    const result = await this.executeCommand(subject, supplied, clientId);
    const account = await this.accounts.lookup(subject);
    const revocation = await this.recoverWrites(account?.personId);
    if (revocation.state === 'pending') result.revocation = { state: revocation.state, retryAt: revocation.retryAt };
    if (account) await this.accounts.observeClient(account.personId, clientId);
    return result;
  }
  async recoverWrites(personId?: string): Promise<WriteDrain> {
    const pending = await this.accounts.drainWrites(personId);
    if (!pending.permits.length) return pending;
    // Bound observation, not the write: a timed-out cancellation remains uncertain.
    const drain = Promise.all(pending.permits.map(async permit => {
      try { return await this.accounts.settleWrite(await this.journey(permit.target).cancelWrite(permit)); }
      catch { return; /* Unavailable is pending, never evidence of cancellation. */ }
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([drain, new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    return this.accounts.drainWrites(personId);
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
      requireAccountCapability(actor, 'device.keys');
      return this.accounts.group(account.personId, command, actor);
    }
    if (isRelay(command)) {
      if (command.input.groupId.startsWith('personal_')) {
        requireAccountCapability(actor, 'device.keys');
        return this.accounts.group(account.personId, command, actor);
      }
      return this.journey(command.input.groupId).execute(account.personId, command, undefined, actor);
    }

    if (isRoundCommand(command)) {
      const journeyId = 'journeyId' in command.input ? command.input.journeyId : roundJourney(command.input.roundId);
      return this.journey(journeyId).execute(account.personId, command, undefined, actor);
    }
    switch (command.tool) {
      case 'account_read':
        requireAccountCapability(actor, 'device.keys');
        return this.accountView(account);
      case 'account_update': {
        requireAccountCapability(actor, 'account.nickname');
        const updated = await this.accounts.update(account.personId, command.input.nickname);
        return actor.agent ? { nickname: updated.nickname, actingAgent: actor.agent.id } : this.accountView(updated);
      }
      // Route opaque forum ids only after resolving the authenticated actor.
      case 'forum_boards': case 'board_create': case 'board_update': case 'topic_create': case 'topic_list': case 'topic_read':
      case 'post_create': case 'post_edit': case 'post_hide': case 'post_unhide': case 'topic_lock': case 'topic_unlock': case 'conversation_read': case 'conversation_post':
        if (!isForumCommand(command)) throw new Refused('Invalid forum command');
        return this.namedForum(await this.journey(forumCommandJourney(command)).execute(account.personId, command, undefined, actor));
      case 'library_get': case 'library_version': case 'library_update': case 'library_delete':
        return this.journey(itemJourney(command.input.itemId)).execute(account.personId, command, undefined, actor);
      case 'agent_remove': {
        const result = await this.accounts.agentCommand(account.personId, clientId, command);
        await this.syncAgentJourneys(account.personId, command.input.agentId, '', []);
        return result;
      }
      case 'agent_list': {
        const data = await this.accounts.agentCommand(account.personId, clientId, command);
        const agents = z.array(z.record(z.string(), z.unknown())).parse(data.agents);
        return { agents: await Promise.all(agents.map(async agent => ({ ...agent, journeys: agent.live ? await this.agentMemberships(account.personId, String(agent.agentId)) : [] }))) };
      }
      case 'offer_journey_set': case 'offer_set': case 'offer_list': case 'offer_publish': case 'offer_retire': case 'offer_settings':
        return this.accounts.agentCommand(account.personId, clientId, command);
      case 'agent_create': case 'agent_narrow': case 'agent_card': case 'client_list':
        return this.accounts.agentCommand(account.personId, clientId, command);
      case 'agent_capabilities': {
        const data = await this.accounts.agentCommand(account.personId, clientId, command);
        if (!command.input.journeyId) return { ...data, journeys: await this.agentMemberships(account.personId, command.input.agentId) };
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
        requireAccountCapability(actor, 'device.keys');
        return this.accounts.group(account.personId, command, actor);
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
    if(this.sealedMode&&method==='update')throw new Refused('Task answers must use the sealed task_step answer exchange; plaintext inputResponses refused');
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
  constructor(profiles: Profiles, now: () => number = Date.now, verifier?: PasskeyVerifier, sealedMode=false) {
    const storage = new MemoryStorage(), stores = new Map<string, MemoryStorage>(), hosts = new Map<string, JourneyHost>(), blobs = new MemoryBlobs();
    const accounts = new AccountsHost(storage, profiles, blobs, verifier, now,sealedMode);
    super(accounts, id => {
      let host = hosts.get(id);
      if (!host) { const store = new MemoryStorage(); stores.set(id, store); host = new JourneyHost(store, now, blobs, { directory: () => accounts.offerDirectory(), stand: d => accounts.standingDecision(d), reserve: r => accounts.reserveAllowance(r), approve: r => accounts.approveAllowance(r), release: (id, permitOnly) => accounts.releaseAllowance(id, permitOnly) }, accounts); hosts.set(id, host); }
      return host;
    },sealedMode);
    this.accountsHost = accounts; this.accountStorage = storage; this.journeyStores = stores; this.blobs = blobs;
  }
  snapshot(): string {
    return JSON.stringify({ accounts: [...this.accountStorage.data], journeys: [...this.journeyStores].filter(([, s]) => s.data.size !== 0).map(([id, s]) => [id, [...s.data]]), blobs: [...this.blobs.data].map(([key, value]) => [key, encodeBytes(value)]) });
  }
}
