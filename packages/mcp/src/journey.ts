import { encodeJourney, encodeProject, encodeGrant, JOURNEY, PROJECT, decodeChoice, type JourneyNeed, type JourneyOp } from '../../rules/src/encode.ts';
import { artifactRule, grantRule, journeyRule, projectRule, taskRule, topicRule, RULES, SLOTS, sameRules, sameState, scalar, cell, type Snapshot, type RulesStamp } from './rules.ts';
import { capabilities, type Capability } from '../../rules/src/capabilities.ts';
import { allows, type Actor } from './agents.ts';
import { Refused, isRelay, type Command, type TaskMethod, type ToolData } from './commands.ts';
import { Serial, type KeyValueStorage } from './storage.ts';
import { relay, deleteArtifactBlobs, type BlobStore } from './relay.ts';
import { library, isLibraryCommand, isLibraryArtifact, requireItem, visibleItem, type LibraryArtifact, type LibraryAccess, type LibraryCommand } from './library.ts';
import { forum, isForumCommand, defaultBoard, type Board, type Topic, type Post } from './forum.ts';
import { rounds, isRoundCommand, type SensemakingRound } from './rounds.ts';

interface Identity { id: string; name: string }
interface Project { id: string; name: string; purpose: string; rule: Snapshot }
interface Agent { id: string; owner: string }
interface Grant { id: string; need: JourneyNeed; resource: string; expiresAt: number; rule: Snapshot }
interface Artifact { id: string; name: string; type: string; size: number; rule: Snapshot; storage?: never }
interface Task { id: string; name: string; assignee?: string; deadline: number; createdAt: number; updatedAt: number; rule: Snapshot }
export interface JourneyState {
  id: string; name: string; rulesHash: RulesStamp; identities: Identity[]; membership: Snapshot;
  projects: Project[]; agents: Agent[]; grants: Grant[]; artifacts: (Artifact | LibraryArtifact)[]; tasks: Task[];
  topics: Snapshot; boards: Board[]; topicRecords: Topic[]; targets: import("./forum-inputs.ts").ForumTarget[]; posts: Post[];
  rounds: SensemakingRound[];
}

function requireChange(before: Snapshot, after: Snapshot, what: string, ignore: string[] = []): Snapshot {
  if (sameState(before, after, ignore)) throw new Refused(`${what} refused by coordination rules`);
  return after;
}

/** One journey's entire record is read, stepped and atomically replaced under a serial turn. */
export class JourneyHost {
  private readonly watchers = new Map<ReadableStreamDefaultController<Uint8Array>, string>();
  private readonly serial = new Serial();
  private readonly storage: KeyValueStorage;
  private readonly now: () => number;
  private readonly blobs: BlobStore | undefined;
  constructor(storage: KeyValueStorage, now: () => number = Date.now, blobs?: BlobStore) { this.storage = storage; this.now = now; this.blobs = blobs; }
  private async load(): Promise<JourneyState | undefined> {
    const raw = await this.storage.get('journey');
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') throw new Refused('Invalid stored journey');
    const state = JSON.parse(raw) as JourneyState;
    if (!sameRules(state.rulesHash)) throw new Refused('Stored journey uses different rules');
    return state;
  }
  private slot(state: JourneyState, id: string, allocate = false): number {
    const found = state.identities.findIndex((m) => m.id === id);
    if (found >= 0) return found + 1;
    if (!allocate) return 0;
    if (state.identities.length + 1 >= SLOTS) throw new Refused('Journey identity capacity reached');
    state.identities.push({ id, name: id });
    return state.identities.length;
  }
  private live(state: JourneyState, slot: number): boolean {
    return scalar(journeyRule.step(state.membership, encodeJourney({ op: 'check', actor: slot, need: 'read' })), 'allowed') === 1;
  }
  private has(state: JourneyState, slot: number, need: JourneyNeed): boolean {
    return scalar(journeyRule.step(state.membership, encodeJourney({ op: 'check', actor: slot, need })), 'allowed') === 1;
  }
  private actor(state: JourneyState, personId: string, command: Command, resolved?: Actor): number {
    const agentId = resolved?.agent?.id ?? ('actingAgent' in command.input ? command.input.actingAgent : undefined);
    if (agentId === undefined) return this.slot(state, personId, true);
    if (!resolved?.agent?.live || resolved.personId !== personId || !state.agents.some(a => a.id === agentId && a.owner === personId)) throw new Refused('Only your own live journey agent may act');
    const actor = this.slot(state, agentId);
    if (!this.live(state, actor)) throw new Refused('Agent is no longer a live member');
    return actor;
  }
  private can(state: JourneyState, actor: number, identity: Actor, capability: Capability): boolean {
    const entry = capabilities.find(c => c.name === capability)!;
    const person = this.slot(state, identity.personId);
    const need = entry.authority === 'write' ? 'write' : entry.authority === 'guide' ? 'guide' : 'read';
    return allows(identity, capability, this.has(state, person, need), this.live(state, person), this.live(state, actor));
  }
  private requireCapability(state: JourneyState, actor: number, identity: Actor, capability: Capability): void {
    if (!this.can(state, actor, identity, capability)) throw new Refused(`Journey capability ${capability} refused`);
  }
  private libraryAccess(state: JourneyState, actor: number, identity: Actor): LibraryAccess {
    return { person: this.slot(state, identity.personId), read: this.can(state, actor, identity, 'read'), write: this.can(state, actor, identity, 'artifact.write'),
      delete: this.can(state, actor, identity, 'artifact.delete'), guide: this.has(state, this.slot(state, identity.personId), 'guide') };
  }
  private async executeLibrary(state: JourneyState, command: LibraryCommand, access: LibraryAccess): Promise<ToolData> {
    const result = await library(state, command, access, this.storage);
    if (result.changed) await this.commit(state, result.writes);
    if (result.deleted && this.blobs) await deleteArtifactBlobs(this.storage, this.blobs, state.id, result.deleted);
    return result.data;
  }
  private commandCapability(command: Command): Capability | undefined {
    switch (command.tool) {
      case 'journey_read': case 'project_join': case 'project_leave': case 'grant_use': return 'read';
      case 'journey_policy': case 'journey_role': case 'journey_guide': case 'journey_unguide': return 'journey.policy';
      case 'journey_invite': return 'member.invite';
      case 'journey_admit': case 'journey_refuse': return 'member.admit';
      case 'journey_remove': return 'member.remove';
      case 'journey_leave': return 'read';
      case 'project_create': return 'project.create';
      case 'project_update': return 'project.edit';
      case 'grant_issue': case 'grant_revoke': return 'grant.issue';
      case 'artifact_create': case 'artifact_version': case 'artifact_rename': return 'artifact.write';
      case 'artifact_delete': return 'artifact.delete';
      case 'task_create': return 'task.manage';
      // Claiming/doing a task is member participation; managing/cancelling it is write authority.
      case 'task_step': return command.input.action === 'cancel' ? 'task.manage' : 'read';
      case 'mls_message_fetch': case 'artifact_blob_get': return 'read';
      case 'mls_message_post': return 'read';
      case 'artifact_blob_put': return 'artifact.write';
      case 'artifact_blob_delete': return 'artifact.write';
      default: return undefined;
    }
  }
  private taskView(state: JourneyState, task: Task): ToolData {
    return { taskId: task.id, name: task.name, assignee: task.assignee, deadline: task.deadline,
      creator: state.identities[scalar(task.rule, 'creator') - 1]?.id,
      claimant: state.identities[scalar(task.rule, 'claimant') - 1]?.id,
      status: ['none', 'open', 'claimed', 'inRound', 'done', 'expired', 'cancelled'][scalar(task.rule, 'status')],
      roundsUsed: scalar(task.rule, 'roundsUsed'), maxRounds: scalar(task.rule, 'cap') };
  }
  private view(state: JourneyState, personId: string): ToolData {
    return {
      journeyId: state.id, name: state.name, rulesHash: state.rulesHash,
      policy: decodeChoice(JOURNEY.policy, scalar(state.membership, 'policy'), 'policy'),
      defaultRole: decodeChoice(JOURNEY.role, scalar(state.membership, 'defaultRole'), 'role'),
      members: state.identities.flatMap((m, i) => {
        const slot = i + 1, kind = cell(state.membership, 'Members', slot);
        if (kind === 0) return [];
        const person = kind === 2 ? cell(state.membership, 'AddedBy', slot) : slot;
        return [{ memberId: m.id, name: m.name, kind: kind === 1 ? 'person' : 'agent', role: decodeChoice(JOURNEY.role, cell(state.membership, 'Roles', person), 'role'), guide: kind === 1 && cell(state.membership, 'Guides', slot) === 1, owner: kind === 2 ? state.identities[person - 1]?.id : undefined }];
      }),
      pending: state.identities.flatMap((m, i) => { const p = cell(state.membership, 'Pending', i + 1); return p ? [{ personId: m.id, name: m.name, status: decodeChoice(JOURNEY.pending, p, 'pending') }] : []; }),
      projects: state.projects.map((p) => ({ projectId: p.id, name: p.name, purpose: p.purpose, status: decodeChoice(PROJECT.status, scalar(p.rule, 'status'), 'project status'), members: state.identities.filter((_, i) => cell(p.rule, 'Members', i + 1) === 1).map((m) => m.id) })),
      agents: state.agents.map(a => ({ agentId: a.id, owner: a.owner, signed: false, read: false, write: false, grant: false })),
      grants: state.grants.map((g) => ({ grantId: g.id, need: g.need, resource: g.resource, expiresAt: g.expiresAt, status: ['unissued', 'live', 'revoked', 'ended'][scalar(g.rule, 'status')], usesLeft: scalar(g.rule, 'usesLeft') })),
      artifacts: state.artifacts.filter(a => !isLibraryArtifact(a) || visibleItem(a, this.slot(state, personId))).map((a) => ({ artifactId: a.id, name: a.name, type: a.type, size: a.size, version: scalar(a.rule, 'version'), deleted: scalar(a.rule, 'at') === 2 })),
      tasks: state.tasks.map((t) => this.taskView(state, t)),
    };
  }
  /** A read-free authority probe; final invitation still runs the unchanged rule. */
  requireGuide(personId: string, command: Command, resolved?: Actor): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (!state) throw new Refused('Only guides may invite');
      let actor: number;
      try { actor = this.actor(state, personId, command, resolved); }
      catch (error) { if (error instanceof Refused) throw new Refused('Only guides may invite'); throw error; }
      if (!this.can(state, actor, resolved ?? { personId }, 'member.invite')) throw new Refused('Only guides may invite');
    });
  }
  /** Used by the account directory, without leaking private journeys to nonmembers. */
  summary(personId: string, resolved?: Actor): Promise<ToolData | undefined> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (!state || !this.can(state, this.slot(state, resolved?.agent?.id ?? personId), resolved ?? { personId }, 'read')) return undefined;
      return { journeyId: state.id, name: state.name };
    });
  }
  private inboxView(state: JourneyState, personId: string): ToolData {
    const recipients = new Set([personId, ...state.agents.filter((agent) => agent.owner === personId && this.live(state, this.slot(state, agent.id))).map((agent) => agent.id)]);
    return { journeyId: state.id, tasks: state.tasks.filter((task) => task.assignee === undefined || recipients.has(task.assignee)).map((task) => this.taskView(state, task)) };
  }
  inbox(personId: string, resolved?: Actor): Promise<ToolData> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (!state || !this.can(state, this.slot(state, resolved?.agent?.id ?? personId), resolved ?? { personId }, 'read')) throw new Refused('Inbox reading refused');
      return this.inboxView(state, resolved?.agent?.id ?? personId);
    });
  }
  watchInbox(personId: string, resolved?: Actor): Promise<ReadableStream<Uint8Array>> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (resolved?.agent) throw new Refused('Agents must poll their inbox; live subscription requires a person connection');
      if (!state || !this.has(state, this.slot(state, personId), 'read')) throw new Refused('Inbox subscription refused');
      let controller: ReadableStreamDefaultController<Uint8Array>;
      return new ReadableStream<Uint8Array>({
        start: (value) => { controller = value; this.watchers.set(controller, personId); controller.enqueue(new TextEncoder().encode('\n')); },
        cancel: () => { this.watchers.delete(controller); },
      }, { highWaterMark: 16 });
    });
  }
  private async commit(state: JourneyState, writes: [string, string][] = []): Promise<void> {
    const before = await this.load();
    await this.storage.transaction(async (storage) => {
      await storage.put('journey', JSON.stringify(state));
      for (const [key, value] of writes) await storage.put(key, value);
      await this.schedule(state, storage);
    });
    for (const [controller, personId] of this.watchers) {
      if (!this.has(state, this.slot(state, personId), 'read') || (controller.desiredSize ?? 0) <= 0) {
        this.watchers.delete(controller); controller.close(); continue;
      }
      if (before && JSON.stringify(this.inboxView(before, personId)) === JSON.stringify(this.inboxView(state, personId))) continue;
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ uri: `wayfinding://journey/${state.id}/inbox` })}\n`));
    }
  }
  private async schedule(state: JourneyState, storage: Pick<KeyValueStorage, 'setAlarm' | 'deleteAlarm'> = this.storage): Promise<void> {
    const active = state.tasks.filter((task) => scalar(task.rule, 'status') >= 1 && scalar(task.rule, 'status') <= 3);
    if (active.length) await storage.setAlarm(Math.min(...active.map((task) => task.deadline)));
    else await storage.deleteAlarm();
  }
  alarm(): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (!state) return;
      const now = this.now();
      let changed = false;
      for (const task of state.tasks) {
        const next = taskRule.step(task.rule, { op: 6, actor: 0, actorIsLive: 0, deadlinePassed: +(now >= task.deadline), maxRounds: 0 });
        if (!sameState(task.rule, next)) { task.rule = next; task.updatedAt = now; changed = true; }
      }
      if (changed) await this.commit(state);
      else await this.schedule(state);
    });
  }
  task(personId: string, method: TaskMethod, taskId: string, resolved?: Actor): Promise<ToolData> {
    return this.serial.run(async () => {
      const state = await this.load();
      const actor = state ? this.slot(state, resolved?.agent?.id ?? personId) : 0;
      if (!state || !this.can(state, actor, resolved ?? { personId }, 'read')) throw new Refused('Task access refused');
      const task = state.tasks.find((task) => task.id === taskId);
      if (!task) throw new Refused('Task not found');
      if (method === 'cancel') {
        this.requireCapability(state, actor, resolved ?? { personId }, 'task.manage');
        this.apply(state, actor, personId, { tool: 'task_step', input: { journeyId: state.id, taskId, action: 'cancel' } });
        await this.commit(state);
      }
      if (method !== 'get') return { resultType: 'complete' };
      const status = scalar(task.rule, 'status');
      const result: ToolData = { resultType: 'complete', taskId, status: status === 6 ? 'cancelled' : status >= 4 ? 'completed' : 'working',
        createdAt: new Date(task.createdAt).toISOString(), lastUpdatedAt: new Date(task.updatedAt).toISOString(), ttlMs: null, pollIntervalMs: 1000 };
      if (status === 4 || status === 5) result.result = { content: [{ type: 'text', text: JSON.stringify(this.taskView(state, task)) }], structuredContent: this.taskView(state, task), isError: status === 5 };
      return result;
    });
  }
  execute(personId: string, command: Command, journeyId?: string, resolved?: Actor): Promise<ToolData> {
    return this.serial.run(async () => {
      let state = await this.load();
      if (command.tool === 'journey_create') {
        if (state) throw new Refused('Journey already exists');
        if (!journeyId) throw new Refused('Journey identity missing');
        state = { id: journeyId, name: command.input.name, rulesHash: RULES, identities: [], membership: journeyRule.init(), projects: [], agents: [], grants: [], artifacts: [], tasks: [], rounds: [], topics: topicRule.init(), posts: [], boards: [], topicRecords: [], targets: [] };
        const actor = this.slot(state, personId, true);
        state.membership = requireChange(state.membership, journeyRule.step(state.membership, encodeJourney({ op: 'found', actor, newPolicy: command.input.policy, role: command.input.defaultRole })), 'Founding');
        defaultBoard(state, actor);
        // The live person is always the guide; a delegated creator also joins as
        // their account agent so later calls never need to fall back to the person.
        if (resolved?.agent) {
          const subject = this.slot(state, resolved.agent.id, true);
          state.membership = requireChange(state.membership, journeyRule.step(state.membership, encodeJourney({ op: 'addAgent', actor, subject })), 'Add founding agent', ['allowed']);
          state.agents.push({ id: resolved.agent.id, owner: personId });
          const identity = state.identities[subject - 1]; if (identity) identity.name = resolved.agent.name;
        }
      } else {
        if (!state) throw new Refused('Journey not found');
        const actor = command.tool === 'agent_add' ? this.slot(state, personId) : this.actor(state, personId, command, resolved);
        const identity = resolved ?? { personId };
        if (isLibraryCommand(command)) return this.executeLibrary(state, command, this.libraryAccess(state, actor, resolved ?? { personId }));
        if (isForumCommand(command)) {
          const result = await forum(state, command, { actor, person: this.slot(state, personId), agent: identity.agent !== undefined,
            read: this.can(state, actor, identity, 'read'), post: this.can(state, actor, identity, 'post'),
            topic: this.can(state, actor, identity, 'topic.create'), manage: this.can(state, actor, identity, 'board.manage') }, this.storage, this.now());
          if (result.changed) await this.commit(state, result.writes);
          return result.data;
        }
        if (isRoundCommand(command)) {
          const result = await rounds(state, command, { actor, person: this.slot(state, personId), agent: identity.agent !== undefined,
            read: this.can(state, actor, identity, 'read'), create: this.can(state, actor, identity, 'round.create'),
            run: this.can(state, actor, identity, 'round.run'), contribute: this.can(state, actor, identity, 'round.contribute') }, this.storage, this.now());
          if (result.changed) await this.commit(state, result.writes);
          return result.data;
        }
        if (isRelay(command) && !this.has(state, actor, 'read')) throw new Refused('A live readable member is required for relay');
        const libraryBlobDelete = command.tool === 'artifact_blob_delete' && state.artifacts.some(a => a.id === command.input.artifactId && isLibraryArtifact(a));
        const cap = libraryBlobDelete ? 'artifact.delete' : this.commandCapability(command);
        // Own-agent removal uses its account capability; all other journey
        // operations intersect the catalogue capability with live journey authority.
        const ownRemoval = command.tool === 'journey_remove' && state.agents.some(a => a.id === command.input.memberId && a.owner === personId);
        if (ownRemoval && identity.agent) {
          if (!allows(identity, 'agent.remove', this.has(state, actor, 'read'))) throw new Refused('Agent removal refused');
        }
        if (cap && !ownRemoval) this.requireCapability(state, actor, identity, cap);
        if (isRelay(command)) {
          if (command.input.groupId !== state.id || command.input.memberId !== undefined) throw new Refused('Invalid journey relay identity');
          if (!this.has(state, actor, 'read')) throw new Refused('A live readable member is required for relay');
          if (command.tool === 'artifact_blob_put' || command.tool === 'artifact_blob_get' || command.tool === 'artifact_blob_delete') {
            const artifact = state.artifacts.find(a => a.id === command.input.artifactId);
            if (!artifact || scalar(artifact.rule, 'at') !== 1 || ('version' in command.input && command.input.version > scalar(artifact.rule, 'version'))) throw new Refused('Live artifact version required');
            if (isLibraryArtifact(artifact)) {
              const access = this.libraryAccess(state, actor, identity);
              requireItem(artifact, access.person, access.read || access.write || access.delete);
              if (command.tool === 'artifact_blob_delete' && (scalar(artifact.rule, 'owner') !== access.person && !access.guide)) throw new Refused('Only the artifact owner or guide may delete ciphertext');
              if (artifact.storage !== 'sealed') throw new Refused('Server artifacts do not accept ciphertext');
            }
            if (command.tool !== 'artifact_blob_get' && !libraryBlobDelete && !this.has(state, actor, 'write')) throw new Refused('Artifact ciphertext write refused');
          }
          const sender = resolved?.agent?.id ?? personId;
          return relay(this.storage, this.blobs, sender, command);
        }
        if (command.tool === 'agent_capabilities') {
          const current = state;
          return { journeyId: state.id, agentId: command.input.agentId, capabilities: capabilities.filter(c => c.scope === 'journey' && this.can(current, actor, resolved ?? { personId }, c.name)).map(c => c.name) };
        }
        if (command.tool === 'journey_read') {
          if (!this.has(state, actor, 'read')) throw new Refused('Reading journey refused');
          return this.view(state, personId);
        }
        if (command.tool === 'artifact_version' || command.tool === 'artifact_rename' || command.tool === 'artifact_delete') {
          const artifact = state.artifacts.find(a => a.id === command.input.artifactId);
          if (artifact && isLibraryArtifact(artifact)) {
            const access = this.libraryAccess(state, actor, identity);
            const id = artifact.id;
            const mapped: LibraryCommand = command.tool === 'artifact_version' ? { tool: 'library_version', input: { itemId: id, baseVersion: command.input.baseVersion, size: command.input.size } }
              : command.tool === 'artifact_rename' ? { tool: 'library_update', input: { itemId: id, name: command.input.name } } : { tool: 'library_delete', input: { itemId: id } };
            await this.executeLibrary(state, mapped, access);
            return access.read ? this.view(state, personId) : { journeyId: state.id, accepted: true };
          }
          if (command.tool === 'artifact_delete') {
            const creator = artifact ? scalar(artifact.rule, 'creator') : 0;
            const creatorPerson = cell(state.membership, 'Members', creator) === 2 ? cell(state.membership, 'AddedBy', creator) : creator;
            if (creatorPerson !== this.slot(state, personId) && !this.has(state, actor, 'guide')) throw new Refused('Only the artifact owner or guide may delete');
          }
        }
        this.apply(state, actor, personId, command, resolved);
        if (command.tool === 'artifact_delete' && this.blobs) await deleteArtifactBlobs(this.storage, this.blobs, state.id, command.input.artifactId);
      }
      await this.commit(state);
      // Respond under the acting identity's read limit, never its owner's broader authority.
      const identity = command.tool === 'agent_add' ? { personId } : resolved ?? { personId };
      const readerId = identity.agent?.id ?? personId;
      if (!this.can(state, this.slot(state, readerId), identity, 'read')) return { journeyId: state.id, accepted: true };
      return this.view(state, personId);
    });
  }
  private apply(state: JourneyState, actor: number, personId: string, command: Command, resolved?: Actor): void {
    const membershipOps: Partial<Record<Command['tool'], JourneyOp>> = {
      journey_policy: 'policy', journey_invite: 'invite', journey_request: 'request', journey_join: 'join', journey_admit: 'admit', journey_refuse: 'refuse', journey_role: 'role', journey_guide: 'guide', journey_unguide: 'unguide', journey_remove: 'remove', journey_leave: 'leave',
    };
    const op = membershipOps[command.tool];
    if (op !== undefined) {
      let subject = actor;
      if ('personId' in command.input && command.input.personId !== undefined) subject = this.slot(state, command.input.personId, true);
      if (command.tool === 'journey_invite' && command.input.personId === undefined) throw new Refused('Resolve email before inviting');
      if (command.tool === 'journey_remove') subject = this.slot(state, command.input.memberId);
      const ownAgentRemoval = op === 'remove' && cell(state.membership, 'Members', subject) === 2
        && cell(state.membership, 'AddedBy', subject) === cell(state.membership, 'AddedBy', actor);
      // Leaving or removing a sibling agent needs no guide authority in the journey rule.
      // Every guide action still intersects the agent card with its person's authority.
      if (cell(state.membership, 'Members', actor) === 2 && op !== 'leave' && !ownAgentRemoval && !this.has(state, actor, 'guide')) {
        throw new Refused('Agent card does not allow guide action');
      }
      const before = state.membership;
      const next = journeyRule.step(before, encodeJourney({ op, actor, subject,
        role: 'role' in command.input ? command.input.role : command.tool === 'journey_policy' ? command.input.defaultRole : undefined,
        newPolicy: command.tool === 'journey_policy' ? command.input.policy : undefined }));
      state.membership = requireChange(before, next, op, ['allowed']);
      for (const grant of state.grants) {
        grant.rule = grantRule.step(grant.rule, encodeGrant({ op: 'end', actor,
          grantorLive: this.live(state, scalar(grant.rule, 'grantor')), granteeLive: this.live(state, scalar(grant.rule, 'to')) }));
      }
      return;
    }
    if (!this.live(state, actor)) throw new Refused('A live member is required');
    switch (command.tool) {
      case 'agent_add': {
        const id = command.input.agentId, subject = this.slot(state, id, true);
        state.membership = requireChange(state.membership, journeyRule.step(state.membership, encodeJourney({ op: 'addAgent', actor, subject })), 'Add agent', ['allowed']);
        if (!state.agents.some(a => a.id === id)) state.agents.push({ id, owner: personId });
        const identity = state.identities[subject - 1]; if (identity && resolved?.agent) identity.name = resolved.agent.name;
        return;
      }
      case 'project_create': {
        const rule = projectRule.step(projectRule.init(), encodeProject({ op: 'create', actor, actorIsLive: this.live(state, actor) }));
        if (scalar(rule, 'exists') !== 1) throw new Refused('Project creation refused');
        state.projects.push({ id: `project_${crypto.randomUUID()}`, name: command.input.name, purpose: command.input.purpose, rule }); return;
      }
      case 'project_join': case 'project_leave': case 'project_update': {
        const project = state.projects.find((p) => p.id === command.input.projectId);
        if (!project) throw new Refused('Project not found');
        const step = (op: 'join' | 'leave' | 'setPurpose' | 'setStatus', to?: (typeof PROJECT.status)[number]) => {
          project.rule = requireChange(project.rule, projectRule.step(project.rule, encodeProject({ op, actor, actorIsLive: this.live(state, actor), to })), `Project ${op}`);
        };
        if (command.tool === 'project_join') step('join');
        else if (command.tool === 'project_leave') step('leave');
        else {
          if (command.input.purpose !== undefined) { step('setPurpose'); project.purpose = command.input.purpose; }
          if (command.input.status !== undefined) step('setStatus', command.input.status);
        }
        return;
      }
      case 'grant_issue': {
        if (command.input.expiresAt <= this.now()) throw new Refused('Grant expiry must be in the future');
        const grantee = this.slot(state, command.input.grantee);
        if (!this.live(state, grantee)) throw new Refused('Grantee is not live');
        this.checkResource(state, command.input.resource);
        const need = JOURNEY.need.indexOf(command.input.need);
        const resource = this.resourceSlot(state, command.input.resource);
        const rule = grantRule.step(grantRule.init(), encodeGrant({ op: 'issue', actor, grantee, command: need, resource, uses: command.input.uses,
          actorLive: this.live(state, actor), actorIsAgent: cell(state.membership, 'Members', actor) === 2,
          actorIsGuide: this.has(state, actor, 'guide'), grantorHolds: this.has(state, actor, command.input.need), fromGrant: false }));
        if (scalar(rule, 'status') !== 1) throw new Refused('Grant issue refused');
        state.grants.push({ id: `grant_${crypto.randomUUID()}`, need: command.input.need, resource: command.input.resource, expiresAt: command.input.expiresAt, rule }); return;
      }
      case 'grant_use': case 'grant_revoke': {
        const grant = state.grants.find((g) => g.id === command.input.grantId);
        if (!grant) throw new Refused('Grant not found');
        const use = command.tool === 'grant_use';
        if (use) this.checkResource(state, command.input.resource);
        const next = grantRule.step(grant.rule, encodeGrant({ op: use ? 'use' : 'revoke', actor,
          command: use ? JOURNEY.need.indexOf(command.input.need) : 0,
          resource: use ? this.resourceSlot(state, command.input.resource) : 0,
          actorLive: this.live(state, actor), actorIsAgent: cell(state.membership, 'Members', actor) === 2, actorIsGuide: this.has(state, actor, 'guide'),
          grantorHolds: this.has(state, scalar(grant.rule, 'grantor'), grant.need), grantorLive: this.live(state, scalar(grant.rule, 'grantor')),
          granteeLive: this.has(state, actor, 'read'), expired: this.now() >= grant.expiresAt }));
        if (use ? scalar(next, 'used') !== 1 : scalar(grant.rule, 'status') !== 1 || scalar(next, 'status') !== 2) throw new Refused('Grant operation refused');
        grant.rule = next; return;
      }
      case 'artifact_create': {
        const rule = artifactRule.step(artifactRule.init(), { op: 0, actor, actorHasWrite: +this.has(state, actor, 'write'), type: state.artifacts.length + 1, baseVersion: 0 });
        if (scalar(rule, 'at') !== 1) throw new Refused('Artifact create refused');
        state.artifacts.push({ id: `artifact_${crypto.randomUUID()}`, name: command.input.name, type: command.input.type, size: command.input.size, rule }); return;
      }
      case 'artifact_version': case 'artifact_rename': case 'artifact_delete': {
        const artifact = state.artifacts.find((a) => a.id === command.input.artifactId);
        if (!artifact) throw new Refused('Artifact not found');
        artifact.rule = requireChange(artifact.rule, artifactRule.step(artifact.rule, { op: command.tool === 'artifact_version' ? 1 : command.tool === 'artifact_rename' ? 2 : 3,
          actor, actorHasWrite: command.tool === 'artifact_delete' ? 1 : +this.has(state, actor, 'write'), type: scalar(artifact.rule, 'artifactType'), baseVersion: command.tool === 'artifact_version' ? command.input.baseVersion : 0 }), 'Artifact change');
        if (command.tool === 'artifact_version') artifact.size = command.input.size;
        if (command.tool === 'artifact_rename') artifact.name = command.input.name;
        return;
      }
      case 'task_create': {
        const now = this.now();
        if (command.input.deadline <= now) throw new Refused('Task deadline must be in the future');
        const assignee = command.input.assignee;
        if (assignee !== undefined && !this.live(state, this.slot(state, assignee))) throw new Refused('Task assignee is not a live member');
        const rule = taskRule.step(taskRule.init(), { op: 0, actor, actorIsLive: +this.live(state, actor), deadlinePassed: 0, maxRounds: command.input.maxRounds });
        if (scalar(rule, 'status') !== 1) throw new Refused('Task create refused');
        state.tasks.push({ id: `task_${state.id.slice('journey_'.length)}_${crypto.randomUUID()}`, name: command.input.name,
          ...(assignee === undefined ? {} : { assignee }), deadline: command.input.deadline, createdAt: now, updatedAt: now, rule }); return;
      }
      case 'task_step': {
        const task = state.tasks.find((t) => t.id === command.input.taskId);
        if (!task) throw new Refused('Task not found');
        if (command.input.action === 'claim' && task.assignee !== undefined && this.slot(state, task.assignee) !== actor) throw new Refused('Only the task assignee may claim it');
        const deadlinePassed = +(this.now() >= task.deadline);
        if (deadlinePassed && command.input.action !== 'expire') throw new Refused('Task change refused: deadline passed');
        task.rule = requireChange(task.rule, taskRule.step(task.rule, { op: ['create', 'claim', 'startRound', 'endRound', 'finish', 'cancel', 'expire'].indexOf(command.input.action), actor,
          actorIsLive: +this.live(state, actor), deadlinePassed, maxRounds: 0 }), 'Task change');
        // The generated expire operation also enforces the round cap outside a round.
        task.rule = taskRule.step(task.rule, { op: 6, actor: 0, actorIsLive: 0, deadlinePassed, maxRounds: 0 });
        task.updatedAt = this.now(); return;
      }
      default: throw new Refused('Not a journey command');
    }
  }
  private checkResource(state: JourneyState, resource: string): void {
    if (resource !== state.id && !state.projects.some((p) => p.id === resource) && !state.artifacts.some((a) => a.id === resource)) throw new Refused('Unknown grant resource');
  }
  private resourceSlot(state: JourneyState, resource: string): number {
    if (resource === state.id) return 1;
    const p = state.projects.findIndex((p) => p.id === resource);
    if (p >= 0) return 2 + p * 2;
    return 3 + state.artifacts.findIndex((a) => a.id === resource) * 2;
  }
}
