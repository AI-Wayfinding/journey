import { Refused, type Command } from './commands.ts';
import { taskRule, scalar, sameState, type Snapshot } from './rules.ts';
import { boundedJson, matchingRule, periodMs, validateData, clampAdmission, type OfferPort, type OfferAgent, type StandingDecision } from './offers.ts';

export interface JourneyTask {
  id: string; name: string; assignee?: string; deadline: number; createdAt: number; updatedAt: number; rule: Snapshot;
  offer?: { id: string; version: number; agentId: string; owner: string; requesterPersonId: string; requesterIsAgent: boolean; agentDefined: boolean; admitted?: boolean };
  content?: { input: unknown; output?: unknown; reason?: string; outputSchema?: Record<string, unknown>; resource?: string };
}
export interface TaskAccess {
  actor: number; personId: string; actorId: string; isAgent: boolean; now: number; guide: boolean;
  creatorId(task: JourneyTask): string; live(id: string): boolean; slot(id: string): number; decider(task: JourneyTask): boolean; runnable(agent: OfferAgent): boolean;
}
export interface TaskState { id: string; tasks: JourneyTask[]; offerOutbox?: StandingDecision[] }
export function taskInput(op: number, actor = 0, actorIsLive = false, deadlinePassed = false, maxRounds = 0, isDecider = false, agent = 0) {
  return { op, actor, actorIsLive: +actorIsLive, deadlinePassed: +deadlinePassed, maxRounds, isDecider: +isDecider, agent };
}
export async function changeTask(state: TaskState, command: Extract<Command, { tool: 'task_create' | 'task_step' }>, access: TaskAccess, port?: OfferPort): Promise<void> {
  const a = access, now = a.now;
  if (command.tool === 'task_create') {
    const input = command.input;
    if (input.deadline <= now) throw new Refused('Task deadline must be in the future');
    let assignee = input.assignee;
    let offerRecord: JourneyTask['offer'], content: JourneyTask['content'];
    let rule: Snapshot;
    if (input.agentId !== undefined && input.offerId !== undefined) {
      const agent = (await port?.directory())?.find(g => g.id === input.agentId);
      const offer = agent?.offers.find(o => o.id === input.offerId);
      if (!agent || !offer || offer.status !== 'published' || !a.runnable(agent) || offer.journeys !== 'all' && !offer.journeys.includes(state.id)) throw new Refused('Offer is not available');
      validateData(input.input, offer.content.inputSchema, 'Input');
      const policy = offer.agentDefined ? clampAdmission(offer.admission, agent.settings) : offer.admission;
      const matched = matchingRule(policy, { requesterId: a.actorId, requesterPersonId: a.personId, isAgent: a.isAgent, owner: agent.owner, isGuide: a.guide, journeyId: state.id });
      let decision = matched?.decision ?? policy.default;
      if (decision === 'deny') throw new Refused('Not accepted');
      if (decision === 'allow' && matched?.limit) {
        const since = now - periodMs(matched.limit.per);
        const count = state.tasks.filter(t => t.offer?.agentId === agent.id && t.offer.id === offer.id && scalar(t.rule, 'creator') === a.actor && t.createdAt > since).length;
        if (count >= matched.limit.count) decision = 'hold';
      }
      if (agent.settings.maxRequestsPerDay && state.tasks.filter(t => t.offer?.agentId === agent.id && t.createdAt > now - 86_400_000).length >= agent.settings.maxRequestsPerDay) decision = 'hold';
      assignee = agent.id;
      rule = taskRule.step(taskRule.init(), taskInput(7, a.actor, true, false, input.maxRounds, false, a.slot(agent.id)));
      if (decision === 'allow') rule = taskRule.step(rule, taskInput(8, a.actor, true, false, 0, true));
      offerRecord = { id: offer.id, version: offer.version, agentId: agent.id, owner: agent.owner, requesterPersonId: a.personId, requesterIsAgent: a.isAgent, agentDefined: !!offer.agentDefined, admitted: decision === 'allow' };
      content = { input: input.input, outputSchema: offer.content.outputSchema, resource: offer.content.resource };
    } else {
      if (assignee !== undefined && !a.live(assignee)) throw new Refused('Task assignee is not a live member');
      rule = taskRule.step(taskRule.init(), taskInput(0, a.actor, true, false, input.maxRounds));
    }
    state.tasks.push({ id: `task_${state.id.slice('journey_'.length)}_${crypto.randomUUID()}`, name: input.name, assignee, deadline: input.deadline, createdAt: now, updatedAt: now, rule, offer: offerRecord, content });
    return;
  }
  const step = command.input, task = state.tasks.find(t => t.id === step.taskId);
  if (!task) throw new Refused('Task not found');
  if (step.action === 'claim' && task.assignee !== undefined && a.slot(task.assignee) !== a.actor) throw new Refused('Only the task assignee may claim it');
  const deadlinePassed = now >= task.deadline;
  if (deadlinePassed && step.action !== 'expire' && step.action !== 'decline') throw new Refused('Task change refused: deadline passed');
  const isDecider = a.decider(task);
  if ((step.action === 'approve' || step.action === 'decline') && !isDecider) throw new Refused('Offer decision refused');
  if (step.action === 'approve' && task.offer) {
    const agent = (await port?.directory())?.find(g => g.id === task.offer!.agentId);
    if (!agent || !a.runnable(agent)) throw new Refused('Offering agent is no longer available');
  }
  if (step.output !== undefined && !task.offer) throw new Refused('Only offer tasks accept output');
  if (step.action === 'finish' && task.content?.outputSchema) validateData(step.output, task.content.outputSchema, 'Output');
  else if (step.output !== undefined) boundedJson(step.output, 'Output');
  const next = taskRule.step(task.rule, taskInput(['create', 'claim', 'startRound', 'endRound', 'finish', 'cancel', 'expire', 'request', 'approve', 'decline'].indexOf(step.action), a.actor, a.live(a.actorId), deadlinePassed, 0, isDecider));
  if (sameState(task.rule, next)) throw new Refused('Task change refused by coordination rules');
  if (step.standing && task.offer) {
    const creatorId = task.offer.requesterIsAgent ? a.creatorId(task) : task.offer.requesterPersonId;
    (state.offerOutbox ??= []).push({ id: task.id, owner: task.offer.owner, agentId: task.offer.agentId, offerId: task.offer.id, who: task.offer.requesterIsAgent ? { agent: creatorId } : { person: creatorId }, decision: step.standing === 'always_allow' ? 'allow' : 'deny' });
  }
  if (step.action === 'approve' && task.offer) task.offer.admitted = true;
  task.rule = taskRule.step(next, taskInput(6, 0, false, deadlinePassed));
  if (task.content) { if (step.output !== undefined) task.content.output = step.output; if (step.reason !== undefined) task.content.reason = step.reason; }
  task.updatedAt = now;
}
