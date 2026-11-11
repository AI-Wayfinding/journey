import { Refused, type Command, type ToolData } from './commands.ts';
import { requireAccountCapability, type Actor, type AccountAgent } from './agents.ts';
import { DEFAULT_SETTINGS, clampAdmission, clampJourneyLimits, editJourneySettings, isRaisingCeiling, offerView, presetPolicy, type Offer, type OfferDefinition } from './offers.ts';

export function accountOfferCommand(actor: Actor, agent: AccountAgent, command: Command, now: number): { data: ToolData; changed: boolean } {
  const settings = agent.offerSettings ?? DEFAULT_SETTINGS;
  const view = () => ({ agentId: agent.id, offers: (agent.offers ?? []).map(offerView), settings });
  if (actor.agent && actor.agent.id !== agent.id) throw new Refused('An agent may only manage its own offers');
  if (command.tool === 'offer_list') return { data: view(), changed: false };
  if (command.tool === 'offer_settings') {
    if (actor.agent) throw new Refused('Only the owner sets offer ceilings');
    const proposed = { publishWithoutReview: command.input.publishWithoutReview ?? settings.publishWithoutReview, maxAdmission: command.input.maxAdmission ?? settings.maxAdmission, maxRequestsPerDay: command.input.maxRequestsPerDay ?? settings.maxRequestsPerDay };
    if (isRaisingCeiling(settings, proposed)) throw new Refused('Raising offer permissions requires a passkey');
    const changed = JSON.stringify(proposed) !== JSON.stringify(settings);
    agent.offerSettings = proposed;
    clampJourneyLimits(agent.offers ?? [], proposed, now);
    return { data: { agentId: agent.id, settings: proposed }, changed };
  }
  if (actor.agent) requireAccountCapability(actor, 'offer.manage');
  if (command.tool === 'offer_journey_set') {
    const input = command.input, offer = agent.offers?.find(o => o.id === input.offerId);
    if (!offer) throw new Refused('Offer not found');
    if (offer.version !== input.expectedVersion) throw new Refused('Offer changed; reload before editing');
    const next = editJourneySettings(offer.journeySettings, { [input.journeyId]: { enabled: input.enabled, maxRequestsPerDay: input.maxRequestsPerDay } }, settings, !!actor.agent);
    if (input.clearLimit) {
      if (actor.agent && offer.journeySettings[input.journeyId]?.maxRequestsPerDay !== undefined) throw new Refused('Agents may only narrow or disable offer journeys');
      delete next[input.journeyId]!.maxRequestsPerDay;
    }
    offer.journeySettings = next; offer.version++; offer.updatedAt = now;
    return { data: { agentId: agent.id, offer: offerView(offer) }, changed: true };
  }
  if (command.tool === 'offer_set') {
    const input: OfferDefinition = command.input.offer, previous = agent.offers?.find(o => o.id === input.id);
    if (command.input.expectedVersion !== undefined && previous?.version !== command.input.expectedVersion) throw new Refused('Offer changed; reload before editing');
    if (input.preset === 'Custom' && !input.admission) throw new Refused('Custom admission requires rules');
    if (!previous && (agent.offers?.length ?? 0) >= 50) throw new Refused('Offer capacity reached');
    const policy = input.admission ?? presetPolicy(input.preset);
    const content = { name: input.name, description: input.description, tags: input.tags, examples: input.examples, inputSchema: input.inputSchema, outputSchema: input.outputSchema, resource: input.resource, instructions: input.instructions };
    const journeySettings = editJourneySettings(previous?.journeySettings ?? {}, input.journeySettings ?? {}, settings, !!actor.agent);
    const contentChanged = !previous || JSON.stringify(content) !== JSON.stringify(previous.content);
    const offer: Offer = { id: input.id, content, contentRevision: (previous?.contentRevision ?? 0) + +contentChanged, journeySettings, admission: actor.agent ? clampAdmission(policy, settings) : policy,
      status: actor.agent ? settings.publishWithoutReview ? 'published' : 'draft' : previous?.status === 'published' ? 'published' : 'draft', agentDefined: !!actor.agent, version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
    agent.offers = [...(agent.offers ?? []).filter(o => o.id !== input.id), offer];
    return { data: { agentId: agent.id, offer: offerView(offer) }, changed: true };
  }
  if (command.tool === 'offer_publish' || command.tool === 'offer_retire') {
    if (actor.agent && command.tool === 'offer_publish') throw new Refused('Only the owner publishes a reviewed offer');
    const offer = agent.offers?.find(o => o.id === command.input.offerId);
    if (!offer) throw new Refused('Offer not found');
    if (command.tool === 'offer_publish' && offer.status !== 'draft') throw new Refused('Only draft offers may be published');
    offer.status = command.tool === 'offer_publish' ? 'published' : 'retired';
    offer.version++; offer.updatedAt = now;
    return { data: { agentId: agent.id, offer: offerView(offer) }, changed: true };
  }
  throw new Refused('Invalid offer command');
}
