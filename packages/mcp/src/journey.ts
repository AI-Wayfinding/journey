import { encodeJourney, encodeProject, encodeAgentCard, encodeGrant, JOURNEY, PROJECT, decodeChoice, type JourneyNeed, type JourneyOp } from '../../rules/src/encode.ts';
import { agentCardRule, artifactRule, grantRule, journeyRule, projectRule, taskRule, RULES, SLOTS, sameRules, sameState, scalar, cell, type Snapshot, type RulesStamp } from './rules.ts';
import { Refused, isRelay, type Command, type ToolData } from './commands.ts';
import { Serial, type KeyValueStorage } from './storage.ts';
import { relay, type BlobStore } from './relay.ts';

interface Identity { id: string; name: string }
interface Project { id: string; name: string; purpose: string; rule: Snapshot }
interface Agent { id: string; owner: string; card: Snapshot }
interface Grant { id: string; need: JourneyNeed; resource: string; expiresAt: number; rule: Snapshot }
interface Artifact { id: string; name: string; type: string; size: number; rule: Snapshot }
interface Task { id: string; name: string; deadline: number; rule: Snapshot }
export interface JourneyState {
  id: string; name: string; rulesHash: RulesStamp; identities: Identity[]; membership: Snapshot;
  projects: Project[]; agents: Agent[]; grants: Grant[]; artifacts: Artifact[]; tasks: Task[];
}

function requireChange(before: Snapshot, after: Snapshot, what: string, ignore: string[] = []): Snapshot {
  if (sameState(before, after, ignore)) throw new Refused(`${what} refused by coordination rules`);
  return after;
}

/** One journey's entire record is read, stepped and atomically replaced under a serial turn. */
export class JourneyHost {
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
    const allowed = scalar(journeyRule.step(state.membership, encodeJourney({ op: 'check', actor: slot, need })), 'allowed') === 1;
    if (!allowed || cell(state.membership, 'Members', slot) !== 2) return allowed;
    const agent = state.agents.find((a) => a.id === state.identities[slot - 1]?.id);
    if (!agent) return false;
    const owner = cell(state.membership, 'AddedBy', slot);
    return scalar(agentCardRule.step(agent.card, encodeAgentCard({ op: 'check', need: need === 'guide' ? 'grant' : need,
      personHas: allowed, personLive: this.live(state, owner), agentLive: this.live(state, slot) })), 'allowed') === 1;
  }
  private actor(state: JourneyState, personId: string, command: Command): number {
    const agentId = 'actingAgent' in command.input ? command.input.actingAgent : undefined;
    if (agentId === undefined) return this.slot(state, personId, true);
    const agent = state.agents.find((a) => a.id === agentId && a.owner === personId);
    if (!agent) throw new Refused('Only your own agent may act');
    const actor = this.slot(state, agentId);
    if (!this.live(state, actor)) throw new Refused('Agent is no longer a live member');
    return actor;
  }
  private view(state: JourneyState): ToolData {
    return {
      journeyId: state.id, name: state.name, rulesHash: state.rulesHash,
      policy: decodeChoice(JOURNEY.policy, scalar(state.membership, 'policy'), 'policy'),
      defaultRole: decodeChoice(JOURNEY.role, scalar(state.membership, 'defaultRole'), 'role'),
      members: state.identities.flatMap((m, i) => {
        const slot = i + 1, kind = cell(state.membership, 'Members', slot);
        if (kind === 0) return [];
        const person = kind === 2 ? cell(state.membership, 'AddedBy', slot) : slot;
        return [{ memberId: m.id, kind: kind === 1 ? 'person' : 'agent', role: decodeChoice(JOURNEY.role, cell(state.membership, 'Roles', person), 'role'), guide: kind === 1 && cell(state.membership, 'Guides', slot) === 1, owner: kind === 2 ? state.identities[person - 1]?.id : undefined }];
      }),
      pending: state.identities.flatMap((m, i) => { const p = cell(state.membership, 'Pending', i + 1); return p ? [{ personId: m.id, status: decodeChoice(JOURNEY.pending, p, 'pending') }] : []; }),
      projects: state.projects.map((p) => ({ projectId: p.id, name: p.name, purpose: p.purpose, status: decodeChoice(PROJECT.status, scalar(p.rule, 'status'), 'project status'), members: state.identities.filter((_, i) => cell(p.rule, 'Members', i + 1) === 1).map((m) => m.id) })),
      agents: state.agents.map((a) => ({ agentId: a.id, owner: a.owner, signed: scalar(a.card, 'signed') === 1, read: scalar(a.card, 'mayRead') === 1, write: scalar(a.card, 'mayWrite') === 1, grant: scalar(a.card, 'mayGrant') === 1 })),
      grants: state.grants.map((g) => ({ grantId: g.id, need: g.need, resource: g.resource, expiresAt: g.expiresAt, status: ['unissued', 'live', 'revoked', 'ended'][scalar(g.rule, 'status')], usesLeft: scalar(g.rule, 'usesLeft') })),
      artifacts: state.artifacts.map((a) => ({ artifactId: a.id, name: a.name, type: a.type, size: a.size, version: scalar(a.rule, 'version'), deleted: scalar(a.rule, 'at') === 2 })),
      tasks: state.tasks.map((t) => ({ taskId: t.id, name: t.name, deadline: t.deadline, status: ['none', 'open', 'claimed', 'inRound', 'done', 'expired', 'cancelled'][scalar(t.rule, 'status')], roundsUsed: scalar(t.rule, 'roundsUsed'), maxRounds: scalar(t.rule, 'cap') })),
    };
  }
  /** Used by the account directory, without leaking private journeys to nonmembers. */
  summary(personId: string): Promise<ToolData | undefined> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (!state || !this.has(state, this.slot(state, personId), 'read')) return undefined;
      return { journeyId: state.id, name: state.name };
    });
  }
  execute(personId: string, command: Command, journeyId?: string): Promise<ToolData> {
    return this.serial.run(async () => {
      let state = await this.load();
      if (command.tool === 'journey_create') {
        if (state) throw new Refused('Journey already exists');
        if (!journeyId) throw new Refused('Journey identity missing');
        state = { id: journeyId, name: command.input.name, rulesHash: RULES, identities: [], membership: journeyRule.init(), projects: [], agents: [], grants: [], artifacts: [], tasks: [] };
        const actor = this.slot(state, personId, true);
        state.membership = requireChange(state.membership, journeyRule.step(state.membership, encodeJourney({ op: 'found', actor, newPolicy: command.input.policy, role: command.input.defaultRole })), 'Founding');
      } else {
        if (!state) throw new Refused('Journey not found');
        const actor = this.actor(state, personId, command);
        if (isRelay(command)) {
          if (command.input.groupId !== state.id || command.input.memberId !== undefined) throw new Refused('Invalid journey relay identity');
          if (!this.has(state, actor, 'read')) throw new Refused('A live readable member is required for relay');
          if (command.tool === 'artifact_blob_put' || command.tool === 'artifact_blob_get') {
            const artifact = state.artifacts.find(a => a.id === command.input.artifactId);
            if (!artifact || scalar(artifact.rule, 'at') !== 1 || command.input.version > scalar(artifact.rule, 'version')) throw new Refused('Live artifact version required');
            if (command.tool === 'artifact_blob_put' && !this.has(state, actor, 'write')) throw new Refused('Artifact ciphertext write refused');
          }
          const sender = command.input.actingAgent ?? personId;
          return relay(this.storage, this.blobs, sender, command);
        }
        if (command.tool === 'journey_read') {
          if (!this.has(state, actor, 'read')) throw new Refused('Reading journey refused');
          return this.view(state);
        }
        this.apply(state, actor, personId, command);
      }
      await this.storage.put('journey', JSON.stringify(state));
      // Respond under the acting identity's read limit, never its owner's broader authority.
      const readerId = 'actingAgent' in command.input ? command.input.actingAgent ?? personId : personId;
      if (!this.has(state, this.slot(state, readerId), 'read')) return { journeyId: state.id, accepted: true };
      return this.view(state);
    });
  }
  private apply(state: JourneyState, actor: number, personId: string, command: Command): void {
    const membershipOps: Partial<Record<Command['tool'], JourneyOp>> = {
      journey_policy: 'policy', journey_invite: 'invite', journey_request: 'request', journey_join: 'join', journey_admit: 'admit', journey_refuse: 'refuse', journey_role: 'role', journey_guide: 'guide', journey_unguide: 'unguide', journey_remove: 'remove', journey_leave: 'leave',
    };
    const op = membershipOps[command.tool];
    if (op !== undefined) {
      let subject = actor;
      if ('personId' in command.input) subject = this.slot(state, command.input.personId, true);
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
      // End grants and withdraw every removed agent card BEFORE the single put.
      for (const agent of state.agents) {
        if (!this.live(state, this.slot(state, agent.id)) && scalar(agent.card, 'signed') === 1) {
          agent.card = agentCardRule.step(agent.card, encodeAgentCard({ op: 'withdraw' }));
        }
      }
      for (const grant of state.grants) {
        grant.rule = grantRule.step(grant.rule, encodeGrant({ op: 'end', actor,
          grantorLive: this.live(state, scalar(grant.rule, 'grantor')), granteeLive: this.live(state, scalar(grant.rule, 'to')) }));
      }
      return;
    }
    if (!this.has(state, actor, 'read')) throw new Refused('A live member with a readable card is required');
    switch (command.tool) {
      case 'agent_add': {
        if (cell(state.membership, 'Members', actor) !== 1) throw new Refused('Only a person adds an agent');
        const id = `agent_${crypto.randomUUID()}`, subject = this.slot(state, id, true);
        state.membership = requireChange(state.membership, journeyRule.step(state.membership, encodeJourney({ op: 'addAgent', actor, subject })), 'Add agent', ['allowed']);
        const card = agentCardRule.step(agentCardRule.init(), encodeAgentCard({ op: 'sign', newRead: command.input.read, newWrite: command.input.write, newGrant: command.input.grant, personSigned: true }));
        state.agents.push({ id, owner: personId, card });
        const identity = state.identities[subject - 1]; if (identity) identity.name = command.input.name;
        return;
      }
      case 'agent_card': {
        const agent = state.agents.find((a) => a.id === command.input.agentId && a.owner === personId);
        if (!agent || !this.live(state, this.slot(state, agent.id))) throw new Refused('Only the live agent owner may change its card');
        agent.card = requireChange(agent.card, agentCardRule.step(agent.card, encodeAgentCard({ op: command.input.action, newRead: command.input.read, newWrite: command.input.write, newGrant: command.input.grant, personSigned: true })), 'Agent card', ['allowed']);
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
          actor, actorHasWrite: +this.has(state, actor, 'write'), type: scalar(artifact.rule, 'artifactType'), baseVersion: command.tool === 'artifact_version' ? command.input.baseVersion : 0 }), 'Artifact change');
        if (command.tool === 'artifact_version') artifact.size = command.input.size;
        if (command.tool === 'artifact_rename') artifact.name = command.input.name;
        return;
      }
      case 'task_create': {
        if (command.input.deadline <= this.now()) throw new Refused('Task deadline must be in the future');
        const rule = taskRule.step(taskRule.init(), { op: 0, actor, actorIsLive: +this.live(state, actor), deadlinePassed: 0, maxRounds: command.input.maxRounds });
        if (scalar(rule, 'status') !== 1) throw new Refused('Task create refused');
        state.tasks.push({ id: `task_${crypto.randomUUID()}`, name: command.input.name, deadline: command.input.deadline, rule }); return;
      }
      case 'task_step': {
        const task = state.tasks.find((t) => t.id === command.input.taskId);
        if (!task) throw new Refused('Task not found');
        task.rule = requireChange(task.rule, taskRule.step(task.rule, { op: ['create', 'claim', 'startRound', 'endRound', 'finish', 'cancel', 'expire'].indexOf(command.input.action), actor,
          actorIsLive: +this.live(state, actor), deadlinePassed: +(this.now() >= task.deadline), maxRounds: 0 }), 'Task change'); return;
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
