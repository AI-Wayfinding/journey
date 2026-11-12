import * as z from 'zod';
import { WriteAuthority, WriteStorage, WriteBlobs, WriteReceiver, writeRequestSchema, type WriteRequest, type WritePermit, type WriteReceipt, type WriteDrain } from './write-permits.ts';
import { accountOfferCommand } from './agent-offers.ts';
import { DEFAULT_SETTINGS, offerView, allowanceRequestSchema, permitRequestSchema, journeyEnabled, matchingRule, clampAdmission, clampJourneyLimits, periodMs, type AllowanceRequest, type AllowanceReceipt, type OfferAgent, type StandingDecision, type PermitRequest, type AdmissionPermit, type Offer, type OwnerOfferSettings } from './offers.ts';
import { PRE_OFFERS_CARD_HASH } from './rules.ts';
import { Refused, isRelay, type Command, type KeyPackageCommand, type ToolData } from './commands.ts';
import { personalGroupRule, RULES, sameRules, sameState, cell, SLOTS, type Snapshot, type RulesStamp } from './rules.ts';
import { Serial, type KeyValueStorage } from './storage.ts';
import { relay, encodeBytes, decodeBytes, type BlobStore } from './relay.ts';
import { bindingRule, cardRule, scalar } from './rules.ts';
import { allows, assertionSchema, changeSchema, changeDigest, base64url, cardCaps, stepCard, requireAccountCapability, WebAuthnVerifier, type AgentAccount, type Actor, type ClientIdentity, type CardChange, type PasskeyVerifier } from './agents.ts';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { oauthOperation, type OAuthOperation, type OAuthResult, type OAuthState } from './oauth-contract.ts';
import { oauthStep, tokenHash, randomToken } from './oauth-store.ts';
import { sealedDescriptor, type SealedDescriptor } from './sealed-descriptors.ts';
import { SEALED_NOTICE, bindingSchema, sealedInputs, type DeviceBinding } from './sealed-contract.ts';

import { recordOperation, consoleRecord, passkeyOperation, type RecordOperation, type ConsoleRecord, type PasskeyOperation } from './console/contract.ts';
import { managePasskey } from './console/passkeys.ts';
import { browserEnrollment, type BrowserRegistration } from './console/browser-enrollment.ts';
export interface Profile { name: string; email: string }
export interface Profiles { get(subject: string): Promise<Profile> }
export interface Account extends Profile, AgentAccount { browsers?: { id: string; credentialId: string; devices: string[] }[]; descriptor?:SealedDescriptor; emailIndex?:string; subject: string; personId: string; nickname?: string; group: Snapshot; identities: { id: string; name: string; kind: 'device' | 'agent' }[] }
interface AccountsState { emailKey?:string; rulesHash: RulesStamp; accounts: Account[]; journeys: string[]; oauth?: OAuthState; allowances?: AllowanceReceipt[]; permits?: AdmissionPermit[] }

function parseDevice(raw:string):DeviceBinding{try{return bindingSchema.parse(JSON.parse(raw));}catch{throw new Refused('Invalid stored authenticated device binding');}}
// The Accounts serial is the admission linearisation point for every journey.
function issuePermit(state: AccountsState, request: PermitRequest, offer: Offer, settings: OwnerOfferSettings, now: number): 'allow' | 'hold' {
  const permits = (state.permits ?? []).filter(p => p.issuedAt > now - periodMs('week'));
  state.permits = permits;
  const previous = permits.find(p => p.taskId === request.taskId);
  if (previous) {
    if (previous.agentId !== request.agentId || previous.offerId !== request.offerId || previous.journeyId !== request.journeyId) throw new Refused('Admission permit mismatch');
    return 'allow';
  }
  const daily = permits.filter(p => p.agentId === request.agentId && p.issuedAt > now - periodMs('day'));
  const limit = offer.journeySettings[request.journeyId]?.maxRequestsPerDay;
  if (settings.maxRequestsPerDay && daily.length >= settings.maxRequestsPerDay || limit !== undefined && daily.filter(p => p.offerId === request.offerId && p.journeyId === request.journeyId).length >= limit) return 'hold';
  permits.push({ taskId: request.taskId, agentId: request.agentId, offerId: request.offerId, journeyId: request.journeyId, issuedAt: now });
  return 'allow';
}
export class AccountsHost {
  private readonly serial = new Serial();
  private readonly storage: WriteStorage;
  private readonly groupReceiver: WriteReceiver;
  private readonly profiles: Profiles;
  private readonly blobs: WriteBlobs | undefined;
  private readonly verifier: PasskeyVerifier;
  private readonly now: () => number;
  private readonly sealedMode:boolean;
  constructor(storage: KeyValueStorage, profiles: Profiles, blobs?: BlobStore, verifier: PasskeyVerifier = new WebAuthnVerifier(), now: () => number = Date.now, sealedMode=false) { this.sealedMode=sealedMode;this.storage = new WriteStorage(storage); this.profiles = profiles; this.blobs = blobs ? new WriteBlobs(blobs) : undefined; this.verifier = verifier; this.now = now; this.groupReceiver = new WriteReceiver(this.storage, this.blobs, now); }
  private async load(): Promise<AccountsState> {
    const raw = await this.storage.get('accounts');
    if (raw === undefined) return { rulesHash: RULES, accounts: [], journeys: [] };
    if (typeof raw !== 'string') throw new Refused('Invalid stored accounts');
    let state: AccountsState;
    try { state = JSON.parse(raw) as AccountsState; } catch { throw new Refused('Invalid stored accounts'); }
    if (!sameRules(state.rulesHash)) throw new Refused('Stored accounts use different rules');
    if (state.rulesHash.card !== RULES.card) {
      // Preserve every old capability, including sparse defaults, without inheriting new device authority.
      for (const agent of state.accounts.flatMap(a => a.agents)) {
        agent.card.maps.Caps = Array.from({ length: state.rulesHash.card === PRE_OFFERS_CARD_HASH ? 21 : 20 }, (_, id): [number, number] => [id, cell(agent.card, 'Caps', id)]);
        if (agent.card.defaults) delete agent.card.defaults.Caps;
      }
    }
    if(this.sealedMode&&state.accounts.some(a=>a.name!==a.personId||a.email!==''||a.nickname!==undefined||a.identities.some(i=>i.name!==i.id)||a.agents.some(g=>g.name!==g.id||g.clientName!==undefined)||a.passkeys.some(k=>k.name!==undefined||k.aaguid!==undefined)))throw new Refused('Unsealed account state refused; no implicit migration or deletion');
    state.rulesHash = RULES;
    let migrated = false;
    for (const agent of state.accounts.flatMap(a => a.agents)) for (const offer of agent.offers ?? []) {
      const legacy = offer as Offer & { journeys?: 'all' | string[] };
      if (legacy.journeys !== undefined) {
        // Synthetic PoC migration: preserve explicit scope hints, but require owner re-enablement.
        const ids = legacy.journeys === 'all' ? agent.journeys ?? [] : legacy.journeys;
        offer.journeySettings = Object.fromEntries(ids.slice(0, 128).map(id => [id, { enabled: false }]));
        offer.contentRevision = 1; offer.version++; delete legacy.journeys; migrated = true;
      }
    }
    if (state.permits === undefined) {
      // Old approvals were not recorded: reserve all retained receipts conservatively for a day.
      const now = this.now();
      state.permits = (state.allowances ?? []).filter(r => r.createdAt > now - periodMs('week')).map(r => ({ taskId: r.taskId, agentId: r.agentId, offerId: r.offerId, journeyId: r.journeyId, issuedAt: now }));
      migrated = true;
    }
    if (migrated) await this.save(state);
    return state;
  }
  /** Host-only bounded session registry; a single replacement makes take/delete atomic. */
  consoleRecord(supplied: RecordOperation): Promise<ConsoleRecord | undefined> {
    return this.serial.run(async () => {
      const operation = recordOperation.parse(supplied), raw = await this.storage.get('console:records');
      let records: Record<string, ConsoleRecord> = {};
      // Drop records that no longer match the schema (e.g. written by an older deploy) one by one; one bad record must not lock everyone out.
      try {
        const stored = raw === undefined ? {} : z.record(z.string(), z.unknown()).parse(JSON.parse(String(raw)));
        for (const [id, value] of Object.entries(stored)) { const parsed = consoleRecord.safeParse(value); if (parsed.success) records[id] = parsed.data; }
      } catch { records = {}; }
      const active = Object.fromEntries(Object.entries(records).filter(([, record]) => record.expiresAt > this.now()));
      const previous = active[operation.id];
      if (operation.op === 'put') {
        if (previous || Object.keys(active).length >= 128) throw new Refused('Console session capacity reached');
        active[operation.id] = operation.record;
      } else if (operation.op !== 'read') delete active[operation.id];
      if (operation.op !== 'read' || Object.keys(active).length !== Object.keys(records).length) await this.storage.put('console:records', JSON.stringify(active));
      return operation.op === 'read' || operation.op === 'take' ? previous : undefined;
    });
  }
  oauth(supplied: OAuthOperation): Promise<OAuthResult> {
    return this.serial.run(async () => {
      const operation = oauthOperation.parse(supplied), state = await this.load();
      if(this.sealedMode&&(operation.op==='consent-options'||operation.op==='consent')){const request=state.oauth?.requests.find(r=>r.id===operation.id)?.request;if(!request||operation.consent.name!=='MCP client')throw new Refused('Names must be sealed by an enrolled proxy; consent uses client id only');}
      if(this.sealedMode&&operation.op==='manage'&&operation.name!==undefined&&operation.name!==operation.agentId)throw new Refused('Agent names must be sealed by an enrolled proxy');
      let deviceAsserted = false;
      if ((operation.op === 'consent-options' || operation.op === 'consent') && operation.consent.capabilities.includes('device.keys')) {
        const account = state.accounts.find(a => a.subject === operation.subject && a.live);
        const request = state.oauth?.requests.find(r => r.id === operation.id && r.request.expiresAt > this.now());
        if (!account || !request) throw new Refused('Fresh authorization and account required');
        // Domain-separated digest binds this person's exact pending OAuth request and proposed card.
        const digest = await tokenHash(JSON.stringify(['device-consent', account.personId, request.id, request.request,
          operation.consent.name, [...new Set(operation.consent.capabilities)].sort(), [...new Set(operation.consent.journeys)].sort()]));
        if (operation.op === 'consent-options') {
          if (!account.passkeys.length) throw new Refused('Register a passkey before authorizing device keys');
          const challenge = randomToken();
          account.assertions = account.assertions.filter(a => a.expiresAt > this.now() && a.digest !== digest).slice(-15);
          account.assertions.push({ challenge, digest, expiresAt: Math.min(this.now() + 300_000, request.request.expiresAt) });
          await this.save(state);
          return { kind: 'assertion', challenge, credentials: account.passkeys.map(c => c.id) };
        }
        const pending = account.assertions.find(a => a.digest === digest && a.expiresAt > this.now());
        if (!pending || !operation.assertion) throw new Refused('Device keys require a fresh passkey assertion over this consent');
        const verified = await this.verifier.verify(operation.assertion, pending.challenge, account.passkeys);
        const credential = account.passkeys.find(c => c.id === verified.credentialId);
        if (!credential) throw new Refused('Unknown passkey');
        credential.counter = verified.counter; credential.lastUsedAt = this.now();
        account.assertions = account.assertions.filter(a => a !== pending);
        deviceAsserted = true;
      }
      const result = await oauthStep(state, operation, this.now(), deviceAsserted, this.sealedMode);
      // Persist errors too: refresh reuse must revoke before the error is returned.
      if (operation.op !== 'client' && !(operation.op === 'request' && !operation.request)) await this.save(state);
      return result;
    });
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
      const personId=`person_${crypto.randomUUID()}`;
      const account: Account = { subject, personId, name: this.sealedMode?personId:profile.name, email: this.sealedMode?'':profile.email,...(this.sealedMode?{emailIndex:await this.emailIndex(state,profile.email)}:{}), group, identities: [], agents: [], clients: [], bindings: bindingRule.init(), passkeys: [], assertions: [], live: true };
      state.accounts.push(account);
      await this.save(state);
      return account;
    });
  }
  directory(add?: string): Promise<string[]> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (add !== undefined && !state.journeys.includes(add)) {
        state.journeys.push(add);
        await this.save(state);
      }
      return state.journeys;
    });
  }
  update(personId: string, nickname: string): Promise<Account> {
    return this.serial.run(async () => {
      const state = await this.load();
      const account = state.accounts.find(a => a.personId === personId);
      if (!account) throw new Refused('Account not found');
      if(this.sealedMode)throw new Refused('Profile names must be sealed by an enrolled proxy');
      account.nickname = nickname;
      await this.save(state);
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
    return this.serial.run(async () => {const state=await this.load();if(!this.sealedMode)return state.accounts.find(a=>a.email.toLowerCase()===email.toLowerCase())?.personId;const index=await this.emailIndex(state,email);return state.accounts.find(a=>a.emailIndex===index)?.personId;});
  }
  private async emailIndex(state:AccountsState,email:string):Promise<string>{
    state.emailKey??=encodeBytes(crypto.getRandomValues(new Uint8Array(32)));const key=await crypto.subtle.importKey('raw',decodeBytes(state.emailKey,32),{name:'HMAC',hash:'SHA-256'},false,['sign']);return encodeBytes(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(email.trim().toLowerCase()))));
  }
  publishedDescriptors(journeyId:string,ids:string[]):Promise<ToolData>{return this.serial.run(async()=>{const state=await this.load(),descriptors:Record<string,import('./sealed-descriptors.ts').DefinitionRef>={};for(const a of state.accounts.filter(a=>a.live)){if(ids.includes(a.personId)&&a.descriptor?.publications[journeyId])descriptors[a.personId]=a.descriptor.publications[journeyId]!;for(const agent of a.agents.filter(g=>g.live))if(ids.includes(agent.id)&&agent.descriptor?.publications[journeyId])descriptors[agent.id]=agent.descriptor.publications[journeyId]!;}return {descriptors};});}
  setDescriptor(personId:string,clientId:string,agentId:string|undefined,supplied:SealedDescriptor):Promise<ToolData>{return this.serial.run(async()=>{
    if(!this.sealedMode)throw new Refused('Sealed generation required');const state=await this.load(),account=state.accounts.find(a=>a.personId===personId&&a.live);if(!account)throw new Refused('Live account required');const actor=this.resolve(account,clientId);if(!allows(actor,'read',true)||!allows(actor,'device.keys',true))throw new Refused('Sealed descriptors need read + device.keys; ask the owner to grant both explicitly');
    const agent=agentId?account.agents.find(a=>a.id===agentId&&a.live):undefined;if(agentId&&(!agent||actor.agent&&actor.agent.id!==agentId))throw new Refused('Only owned live agent descriptor');if(!agentId)requireAccountCapability(actor,'account.nickname');const target=agent??account,value=sealedDescriptor.parse(supplied);if(value.contentRevision!==(target.descriptor?.contentRevision??0)+1)throw new Refused('Descriptor revision changed');target.descriptor=value;await this.save(state);return {descriptor:value};
  });}
  private resolve(account: Account, clientId: string, actingAgent?: string): Actor {
    const client = account.clients.indexOf(clientId) + 1;
    const bound = account.agents[cell(account.bindings, 'Agents', client) - 2];
    const next = bindingRule.step(account.bindings, { op: 3, client, agent: 0, personAsserted: 0, agentIsOwnLive: 0, personLive: +account.live, boundAgentLive: +(bound?.live ?? false) });
    if (scalar(next, 'allowed') !== 1) throw new Refused('Client or person is no longer live');
    if (scalar(next, 'asAgent') === 1 && actingAgent !== undefined && actingAgent !== bound?.id) throw new Refused('Bound client cannot replace its agent');
    const agentId = scalar(next, 'asAgent') === 1 ? bound?.id : actingAgent;
    const agent = agentId === undefined ? undefined : account.agents.find(a => a.id === agentId && a.live);
    if (agentId !== undefined && !agent) throw new Refused('Only your own live agent may act');
    return { personId: account.personId, clientId, ...(agent ? { agent } : {}) };
  }
  observeClient(personId: string, clientId: string): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load(), account = state.accounts.find(a => a.personId === personId);
      if (!account || !account.live) throw new Refused('Live account required');
      if (!account.clients.includes(clientId)) {
        account.clients.push(clientId);
        await this.save(state);
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
      await this.save(state);
    });
  }
  private save(state: AccountsState): Promise<void> {
    return new WriteAuthority(this.storage, this.now).saveAccounts(JSON.stringify(state), state.accounts);
  }
  private async sealedBinding(state:AccountsState,deviceId:string):Promise<DeviceBinding>{
    const raw=await this.storage.get(`sealed:device:${deviceId}`);if(typeof raw!=='string')throw new Refused('Unknown authenticated device');
    const b=parseDevice(raw),account=state.accounts.find(a=>a.personId===b.personId&&a.live);if(!account)throw new Refused('Device owner is not live');
    this.requireIdentity(account,b.deviceId);const agent=b.agentId?account.agents.find(a=>a.id===b.agentId&&a.live):undefined;
    if(b.agentId&&(!agent||!cardCaps(agent.card).includes('read')||!cardCaps(agent.card).includes('device.keys')))throw new Refused('Device needs explicit read + device.keys');
    return b;
  }
  deviceBinding(deviceId:string):Promise<DeviceBinding>{return this.serial.run(async()=>this.sealedBinding(await this.load(),deviceId));}
  reserveDevice(expected:DeviceBinding,groupId:string):Promise<DeviceBinding>{return this.serial.run(async()=>{
    // Recheck the exact binding authorized by the journey and consume its package in one Accounts turn.
    const authorized=bindingSchema.parse(expected),b=await this.sealedBinding(await this.load(),authorized.deviceId);
    if(JSON.stringify(b)!==JSON.stringify(authorized))throw new Refused('Authorized device binding changed');
    const key=`sealed:reservation:${b.deviceId}`,old=await this.storage.get(key);
    if(old!==undefined&&old!==groupId)throw new Refused('Key package already reserved for another audience');await this.storage.put(key,groupId);return b;
  });}
  private async registerDevice(account:Account,actor:Actor,input:BrowserRegistration):Promise<DeviceBinding>{
    const {deviceId,verificationKey,data}=input;
    if(await this.storage.get(`sealed:device:${deviceId}`)!==undefined)throw new Refused('Device id already bound');
    decodeBytes(data,64*1024);if(decodeBytes(verificationKey,64).length!==32)throw new Refused('Ed25519 verification key required');
    const slot=account.identities.length+2;if(slot>=SLOTS)throw new Refused('Device capacity reached');
    account.group=personalGroupRule(1).step(account.group,{op:0,subject:slot,kind:actor.agent?3:2,belongsTo:1});
    account.identities.push({id:deviceId,name:deviceId,kind:actor.agent?'agent':'device'});
    const binding:DeviceBinding={deviceId,personId:account.personId,agentId:actor.agent?.id,verificationKey,data,hash:await tokenHash(data),createdAt:this.now()};
    await this.storage.put(`sealed:device:${deviceId}`,JSON.stringify(binding));return binding;
  }
  sealedDevice(personId:string,clientId:string,tool:string,supplied:unknown):Promise<ToolData>{return this.serial.run(async()=>{
    const input=sealedInputs[tool]?.parse(supplied) as Record<string,unknown>|undefined;if(!input)throw new Refused('Unknown device operation');
    const state=await this.load(),account=state.accounts.find(a=>a.personId===personId);if(!account)throw new Refused('Unknown account');const actor=this.resolve(account,clientId);if(!allows(actor,'read',true)||!allows(actor,'device.keys',true))throw new Refused('Sealed content refused: needs read + device.keys; ask the owner to grant both explicitly');
    if(tool==='sealed_device_binding'){const raw=await this.storage.get(`sealed:device:${String(input.deviceId)}`);if(typeof raw!=='string')throw new Refused('Unknown authenticated device');return parseDevice(raw);}
    if(tool!=='sealed_device_register')throw new Refused('Unknown device operation');
    return this.storage.transaction(async()=>{const binding=await this.registerDevice(account,actor,{deviceId:String(input.deviceId),verificationKey:String(input.verificationKey),data:String(input.data)});await this.save(state);return binding;});
  });}
  issueWrite(supplied: WriteRequest): Promise<WritePermit> {
    return this.serial.run(async () => {
      const request = writeRequestSchema.parse(supplied), state = await this.load();
      const account = state.accounts.find(a => a.personId === request.actor.personId);
      if (!account || !request.actor.clientId) throw new Refused('Authenticated write identity required');
      const current = this.resolve(account, request.actor.clientId, request.actor.agent?.id);
      const audiencePersonIds:string[]=[];
      for(const id of request.deviceIds??[]){const binding=await this.sealedBinding(state,id);audiencePersonIds.push(binding.personId);}
      return new WriteAuthority(this.storage, this.now).issue({...request,audiencePersonIds}, state.accounts, current);
    });
  }
  redeemWrite(permit: WritePermit): Promise<void> { return this.serial.run(() => new WriteAuthority(this.storage, this.now).redeem(permit)); }
  settleWrite(receipt: WriteReceipt): Promise<void> { return this.serial.run(() => new WriteAuthority(this.storage, this.now).settle(receipt)); }
  drainWrites(personId?: string): Promise<WriteDrain> { return this.serial.run(() => new WriteAuthority(this.storage, this.now).drain(personId, true)); }
  resolveActor(personId: string, clientId: string, actingAgent?: string): Promise<Actor> {
    return this.serial.run(async () => {
      const account = (await this.load()).accounts.find(a => a.personId === personId);
      if (!account) throw new Refused('Account not found');
      return this.resolve(account, clientId, actingAgent);
    });
  }
  /** Internal inventory only: never exposed as a caller-supplied authority flag. */
  offerDirectory(): Promise<OfferAgent[]> {
    return this.serial.run(async () => (await this.load()).accounts.filter(a => a.live).flatMap(a => a.agents.filter(g => g.live).map(g => ({ id: g.id, name: g.name, owner: a.personId, card: g.card, offers: g.offers ?? [], settings: g.offerSettings ?? DEFAULT_SETTINGS }))));
  }
  /** Reserve across all journeys under the same serial authority as offer edits. */
  reserveAllowance(supplied: AllowanceRequest): Promise<'allow' | 'hold'> {
    return this.serial.run(async () => {
      const request = allowanceRequestSchema.parse(supplied), state = await this.load(), now = this.now();
      const previous = state.allowances?.find(r => r.taskId === request.taskId);
      if (previous) {
        for (const key of Object.keys(request) as (keyof AllowanceRequest)[]) if (request[key] !== previous[key]) throw new Refused('Allowance reservation mismatch');
        return previous.decision;
      }
      const account = state.accounts.find(a => a.live && a.agents.some(g => g.id === request.agentId && g.live));
      const agent = account?.agents.find(g => g.id === request.agentId);
      const offer = agent?.offers?.find(o => o.id === request.offerId);
      if (!account || !agent || !offer || offer.status !== 'published' || offer.version !== request.version || !journeyEnabled(offer, request.journeyId)) throw new Refused('Offer changed; reload before requesting');
      const settings = agent.offerSettings ?? DEFAULT_SETTINGS;
      const policy = offer.agentDefined ? clampAdmission(offer.admission, settings) : offer.admission;
      const matched = matchingRule(policy, { requesterId: request.requesterId, requesterPersonId: request.requesterPersonId, isAgent: request.isAgent, isGuide: request.isGuide, journeyId: request.journeyId, owner: account.personId });
      let decision = matched?.decision ?? policy.default;
      if (decision === 'deny') throw new Refused('Not accepted');
      // Count requests, including held ones. Keep a week so later policy edits cannot reset usage.
      const receipts = (state.allowances ?? []).filter(r => r.createdAt > now - periodMs('week'));
      const agentReceipts = receipts.filter(r => r.agentId === agent.id);
      const limit = matched?.limit;
      if (decision === 'allow' && limit && agentReceipts.filter(r => r.offerId === offer.id && r.requesterId === request.requesterId && r.isAgent === request.isAgent && r.createdAt > now - periodMs(limit.per)).length >= limit.count) decision = 'hold';
      if (decision === 'allow') decision = issuePermit(state, request, offer, settings, now);
      receipts.push({ taskId: request.taskId, agentId: agent.id, offerId: offer.id, version: offer.version, journeyId: request.journeyId, requesterId: request.requesterId, requesterPersonId: request.requesterPersonId, isAgent: request.isAgent, isGuide: request.isGuide, createdAt: now, decision });
      state.allowances = receipts;
      await this.save(state);
      return decision;
    });
  }
  /** Host-only approval: identity stays bound to the original created-request receipt. */
  approveAllowance(supplied: PermitRequest): Promise<'allow' | 'hold'> {
    return this.serial.run(async () => {
      const request = permitRequestSchema.parse(supplied), state = await this.load(), now = this.now();
      const receipt = state.allowances?.find(r => r.taskId === request.taskId && r.createdAt > now - periodMs('week'));
      if (!receipt || receipt.agentId !== request.agentId || receipt.offerId !== request.offerId || receipt.journeyId !== request.journeyId) throw new Refused('Approval receipt mismatch or expired');
      const account = state.accounts.find(a => a.live && a.agents.some(g => g.id === request.agentId && g.live));
      const agent = account?.agents.find(g => g.id === request.agentId), offer = agent?.offers?.find(o => o.id === request.offerId);
      if (!agent || !offer || offer.status !== 'published' || !journeyEnabled(offer, request.journeyId)) throw new Refused('Offer is disabled or not available');
      const decision = issuePermit(state, request, offer, agent.offerSettings ?? DEFAULT_SETTINGS, now);
      await this.save(state);
      return decision;
    });
  }
  /** Only the creating journey releases, after a definite failure before its task commit. */
  releaseAllowance(taskId: string, permitOnly = false): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load();
      state.permits = state.permits?.filter(p => p.taskId !== taskId);
      if (!permitOnly) state.allowances = state.allowances?.filter(r => r.taskId !== taskId);
      if (!state.allowances?.length) delete state.allowances;
      await this.save(state);
    });
  }
  /** Idempotent delivery of a decision already committed by the journey. */
  standingDecision(decision: StandingDecision): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load(), account = state.accounts.find(a => a.personId === decision.owner && a.live);
      const agent = account?.agents.find(a => a.id === decision.agentId && a.live);
      if (!agent || agent.standingReceipts?.includes(decision.id)) return;
      const offer = agent.offers?.find(o => o.id === decision.offerId);
      if (!offer) return;
      const who = 'person' in decision.who ? { person: decision.who.person } : { agent: decision.who.agent };
      offer.admission.rules = [{ who, decision: decision.decision }, ...offer.admission.rules.filter(r => JSON.stringify(r.who) !== JSON.stringify(who))].slice(0, 50);
      offer.version++; offer.updatedAt = this.now();
      agent.standingReceipts = [...(agent.standingReceipts ?? []), decision.id];
      await this.save(state);
    });
  }
  agentCommand(personId: string, clientId: string, command: Command): Promise<ToolData> {
    return this.serial.run(async () => {
      const state = await this.load(), account = state.accounts.find(a => a.personId === personId);
      if (!account) throw new Refused('Account not found');
      const actor = this.resolve(account, clientId, 'actingAgent' in command.input ? command.input.actingAgent : undefined);
      const view = (a: Account['agents'][number]) => ({ agentId: a.id, name: a.name, descriptor:a.descriptor, live: a.live, signed: scalar(a.card, 'signed') === 1, capabilities: cardCaps(a.card), offers: !actor.agent || actor.agent.id === a.id ? (a.offers ?? []).map(offerView) : undefined, clientId: a.clientId, clientName: a.clientName, createdAt: a.createdAt, lastUsedAt: a.lastUsedAt, journeys: a.journeys ?? [] });
      switch (command.tool) {
        case 'offer_journey_set': case 'offer_set': case 'offer_list': case 'offer_publish': case 'offer_retire': case 'offer_settings': {
          const agent = account.agents.find(a => a.id === command.input.agentId && a.live);
          if (!agent) throw new Refused('Only a live agent owner may manage offers');
          const result = accountOfferCommand(actor, agent, command, this.now());
          if (result.changed) await this.save(state);
          const permits = (state.permits ?? []).filter(p => p.agentId === agent.id && p.issuedAt > this.now() - periodMs('day'));
          return { ...result.data, usage: { admitted24h: permits.length, journeys: (agent.offers ?? []).flatMap(o => Object.keys(o.journeySettings).map(journeyId => ({ offerId: o.id, journeyId, admitted24h: permits.filter(p => p.offerId === o.id && p.journeyId === journeyId).length }))) } };
        }
        case 'client_list': return { clientId, actingAgent: actor.agent?.id, clients: account.clients.map((id, i) => ({ clientId: id, agentId: cell(account.bindings, 'Bound', i + 1) || cell(account.bindings, 'Revoked', i + 1) ? account.agents[cell(account.bindings, 'Agents', i + 1) - 2]?.id : undefined, bound: cell(account.bindings, 'Bound', i + 1) === 1, revoked: cell(account.bindings, 'Revoked', i + 1) === 1 })) };
        case 'agent_list': return { agents: account.agents.filter(a => !actor.agent || a.id === actor.agent.id).map(view) };
        case 'agent_create': {
          if (actor.agent) throw new Refused('Only a person adds agents');
          if(this.sealedMode&&command.input.name!==SEALED_NOTICE)throw new Refused('Agent names must be sealed');const id=`agent_${crypto.randomUUID()}`;
          const agent = { id, name: this.sealedMode?id:command.input.name, live: true, card: cardRule.init() };
          account.agents.push(agent); await this.save(state); return view(agent);
        }
        case 'agent_capabilities': case 'agent_narrow': case 'agent_card': case 'agent_remove': {
          const agent = account.agents.find(a => a.id === command.input.agentId && a.live);
          if (!agent || actor.agent && actor.agent.id !== agent.id) throw new Refused('Only your own live agent card may be used');
          if (command.tool === 'agent_capabilities') return view(agent);
          if (command.tool === 'agent_remove') {
            requireAccountCapability(actor, 'agent.remove'); agent.live = false; agent.card = stepCard(agent.card, 'withdraw');
            if (state.oauth) {
              state.oauth.access = state.oauth.access.filter(t => t.agentId !== agent.id);
              state.oauth.refresh = state.oauth.refresh.filter(t => t.agentId !== agent.id);
              state.oauth.codes = state.oauth.codes.filter(t => t.agentId !== agent.id);
            }
            account.bindings = bindingRule.step(account.bindings, { op: 2, client: 0, agent: account.agents.indexOf(agent) + 2, personAsserted: 0, agentIsOwnLive: 0, personLive: +account.live, boundAgentLive: 0 });
          } else {
            const keep = command.tool === 'agent_card' ? [] : cardCaps(agent.card).filter(c => !command.input.remove.includes(c));
            agent.card = stepCard(agent.card, command.tool === 'agent_card' ? 'withdraw' : 'narrow', keep);
          }
          await this.save(state); return view(agent);
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
      await this.save(state); return { challenge };
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
      else if (change.kind === 'offer_settings') {
        const current = agent.offerSettings ?? DEFAULT_SETTINGS;
        agent.offerSettings = { publishWithoutReview: change.settings.publishWithoutReview ?? current.publishWithoutReview, maxAdmission: change.settings.maxAdmission ?? current.maxAdmission, maxRequestsPerDay: change.settings.maxRequestsPerDay ?? current.maxRequestsPerDay };
        clampJourneyLimits(agent.offers ?? [], agent.offerSettings, this.now());
      }
      else {
        let client = account.clients.indexOf(change.clientId) + 1;
        if (!client) { account.clients.push(change.clientId); client = account.clients.length; }
        account.bindings = bindingRule.step(account.bindings, { op: change.kind === 'bind' ? 0 : 1, client, agent: account.agents.indexOf(agent) + 2, personAsserted: 1, agentIsOwnLive: 1, personLive: +account.live, boundAgentLive: +agent.live });
      }
      const credential = account.passkeys.find(c => c.id === verified.credentialId);
      if (credential) { credential.counter = verified.counter; credential.lastUsedAt = this.now(); }
      account.assertions = account.assertions.filter(a => a !== pending);
      await this.save(state); return { accepted: true };
    });
  }
  passkey(identity: ClientIdentity, supplied: PasskeyOperation): Promise<ToolData> {
    return this.serial.run(async () => {
      const state = await this.load(), account = state.accounts.find(a => a.subject === identity.subject);
      if (!account || this.resolve(account, identity.clientId).agent) throw new Refused('Only a live person manages passkeys');
      const operation = passkeyOperation.parse(supplied);
      if(operation.op.startsWith('browser_'))return this.storage.transaction(async()=>{
        const result=await browserEnrollment(account,this.storage,this.verifier,identity,operation,this.now(),input=>this.registerDevice(account,{personId:account.personId,clientId:identity.clientId},input));
        await this.save(state);return result;
      });
      if(operation.op==='delete'&&(account.browsers??[]).some(b=>b.credentialId===operation.id&&b.devices.some(d=>{const i=account.identities.findIndex(x=>x.id===d);return i>=0&&cell(account.group,'Members',i+2)!==0;})))throw new Refused('Revoke browser devices before removing their wrapping passkey');
      const result = await managePasskey(account, state.accounts, this.storage, operation, this.now(),this.sealedMode);
      if (operation.op === 'finish' || operation.op === 'delete' || operation.op === 'rename') await this.save(state);
      return result;
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
    let data: string | null = null;
    try { if (typeof raw === 'string') data = z.string().nullable().parse(JSON.parse(raw)); } catch { throw new Refused('Invalid stored key package'); }
    if (data !== null) await this.storage.put(key, 'null');
    return { personId: account.personId, deviceId, data };
  }
  group(personId: string, command: Command, resolved?: Actor): Promise<ToolData> {
    return this.serial.run(async () => {
      const state = await this.load();
      const account = state.accounts.find((a) => a.personId === personId);
      if (!account) throw new Refused('Account not found');
      const current = this.resolve(account, resolved?.clientId ?? 'trusted-host', resolved?.agent?.id);
      requireAccountCapability(current, 'device.keys');
      const digest = await tokenHash(JSON.stringify([personId, current.agent?.id ?? null, command]));
      const result = await this.groupReceiver.run({ personId }, `personal_${personId}`, digest, async () => {
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
        if(this.sealedMode)throw new Refused('Use authenticated device enrollment; seal labels in the private profile');
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
      if (command.tool !== 'personal_group_read') await this.save(state);
      return { owner: personId, members: [{ id: personId, kind: 'person' }, ...account.identities.filter((_, i) => cell(account.group, 'Members', i + 2) !== 0)] };
      });
      return result.value;
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
    let url: URL;
    try { url = new URL('https://api.workos.com/user_management/users/'); } catch { throw new Refused('Account profile URL invalid'); }
    url.pathname += encodeURIComponent(subject);
    if (url.origin !== 'https://api.workos.com' || !url.pathname.startsWith('/user_management/users/')) throw new Refused('Account profile origin refused');
    const response = await this.send(url, {
      redirect: 'manual',
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
