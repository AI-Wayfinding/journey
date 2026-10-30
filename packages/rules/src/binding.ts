import {all, bool, forall, nat, no, oneOf, rule, when, yes} from 'gdp-wired'

// One account's client bindings. Slot ids are interned by the host; person is
// the account's person slot. agentIsOwnLive is a host lookup, not caller input.
// removeAgent is an authenticated host event after removal, never a client
// assertion. Revoked is a tombstone: clearing Bound on removal must not turn a
// removed agent's client into an unbound person client. Only asserted binding
// clears that tombstone. The host also rechecks agent/person liveness on act.
export type BindingBug = 'assertion' | 'ownership' | 'remove' | 'person escape' | 'refuse bind' | 'refuse unbind' | 'other client' | 'unasserted unbind' | 'dead act'
export const bindingRule = (bug?: BindingBug) => rule('binding')
  .params({person: nat})
  .inputs({op: oneOf('bind', 'unbind', 'removeAgent', 'act'), client: nat, agent: nat,
    personAsserted: bool, agentIsOwnLive: bool, personLive: bool, boundAgentLive: bool})
  .state({actsAs: 0, asAgent: bool.from(false), allowed: bool.from(false)})
  .maps({Bound: bool.from(false), Agents: 0, Revoked: bool.from(false)})
  .flags(({op, personAsserted, agentIsOwnLive, person, agent}) => ({
    binds: bug === 'refuse bind' ? no : all(op.is('bind'), bug === 'assertion' ? yes : personAsserted,
      bug === 'ownership' ? yes : agentIsOwnLive.and(agent.ne(person))),
    unbinds: bug === 'refuse unbind' ? no : all(op.is('unbind'), bug === 'unasserted unbind' ? yes : personAsserted, agentIsOwnLive, agent.ne(person)),
    removes: op.is('removeAgent'),
  }))
  .step(({op, client, agent, person, personLive, boundAgentLive, Bound, Agents, Revoked, binds, unbinds, removes}) => {
    const drops = unbinds.and(Bound.at(client), Agents.at(client).eq(agent))
    const isAgent = bug === 'person escape' ? no : Bound.at(client).or(Revoked.at(client))
    return {
      actsAs: when(isAgent, Agents.at(client), person),
      asAgent: isAgent,
      allowed: all(op.is('act'), bug === 'dead act' ? yes : personLive, bug === 'dead act' ? yes : Revoked.at(client).not(), bug === 'dead act' ? yes : Bound.at(client).not().or(boundAgentLive)),
      Bound: Bound.each(k => when(removes.and(Agents.at(k).eq(agent)), bug === 'remove' ? Bound.at(k) : no,
        when(k.eq(client), when(binds, yes, when(drops, no, Bound.at(k))), bug === 'other client' ? no : Bound.at(k)))),
      Agents: Agents.set(client, when(binds, agent, Agents.at(client))),
      Revoked: Revoked.each(k => when(removes.and(Bound.at(k), Agents.at(k).eq(agent)), yes,
        when(k.eq(client).and(binds.or(drops)), no, Revoked.at(k)))),
    }
  })
export const binding = bindingRule()
type Binding = ReturnType<typeof bindingRule>
export const bindingLaws = (r: Binding = binding) => [
  // A bound slot always names an agent, never the account person.
  r.law('a bound client never names the person', ({person, Bound, Agents}) => forall(k => Bound.at(k).implies(Agents.at(k).ne(person)))),
]
export const bindingStepLaws = (r: Binding = binding) => [
  // Only a passkey-asserted choice of the person's own live agent binds a client.
  r.stepLaw('binding requires assertion and a live own agent', ({personAsserted, agentIsOwnLive, Bound, Agents}, after) =>
    forall(k => after.Bound.at(k).and(Bound.at(k).not().or(after.Agents.at(k).ne(Agents.at(k)))).implies(personAsserted.and(agentIsOwnLive)))),
  // A legitimate asserted binding is installed on the named client.
  r.stepLaw('an asserted binding takes effect', ({client, agent}, after) => all(after.Bound.at(client), after.Agents.at(client).eq(agent), after.Revoked.at(client).not()),
    ({op, personAsserted, agentIsOwnLive, agent, person}) => all(op.is('bind'), personAsserted, agentIsOwnLive, agent.ne(person))),
  // Unbinding a live binding requires the same person assertion and ownership.
  r.stepLaw('only an asserted unbinding releases a live client', ({client, agent, Bound, Agents, personAsserted, agentIsOwnLive}, after) => after.Bound.at(client).not(),
    ({op, client, agent, Bound, Agents, personAsserted, agentIsOwnLive}) => all(op.is('unbind'), Bound.at(client), Agents.at(client).eq(agent), personAsserted, agentIsOwnLive)),
  // Removing an agent clears every one of its bindings and leaves a tombstone.
  r.stepLaw('removal unbinds and revokes every client of the agent', ({agent, Bound, Agents}, after) =>
    forall(k => Bound.at(k).and(Agents.at(k).eq(agent)).implies(after.Bound.at(k).not().and(after.Revoked.at(k)))), ({op}) => op.is('removeAgent')),
  // A bound or revoked client always reports its fixed agent identity.
  r.stepLaw('a bound client acts only as its agent', ({client, person, Bound, Agents, Revoked}, after) =>
    all(after.asAgent.iff(Bound.at(client).or(Revoked.at(client))), after.actsAs.eq(when(Bound.at(client).or(Revoked.at(client)), Agents.at(client), person))), ({op}) => op.is('act')),
  // Ordinary binding changes never alter a different client's binding.
  r.stepLaw('binding edits only the named client', ({client, Bound}, after) => forall(k => k.ne(client).implies(after.Bound.at(k).iff(Bound.at(k)))),
    ({op}) => op.is('removeAgent').not()),
  // Apart from removal, releasing a binding needs an asserted live-owner action.
  r.stepLaw('unbinding requires assertion and live ownership', ({Bound, personAsserted, agentIsOwnLive}, a) =>
    forall(k => Bound.at(k).and(a.Bound.at(k).not()).implies(personAsserted.and(agentIsOwnLive))), ({op}) => op.is('removeAgent').not()),
  // Revoked clients fail closed rather than falling back to person authority.
  r.stepLaw('acting requires live authority and no removal tombstone', ({client, personLive, boundAgentLive, Bound, Revoked}, a) =>
    a.allowed.iff(all(personLive, Revoked.at(client).not(), Bound.at(client).not().or(boundAgentLive))), ({op}) => op.is('act')),
]
export const laws = bindingLaws()
export const stepLaws = bindingStepLaws()
export const brokenVariants: {bug: BindingBug, breaks: string[]}[] = [
  {bug: 'ownership', breaks: ['a bound client never names the person']},
  {bug: 'assertion', breaks: ['binding requires assertion and a live own agent']},
  {bug: 'refuse bind', breaks: ['an asserted binding takes effect']},
  {bug: 'refuse unbind', breaks: ['only an asserted unbinding releases a live client']},
  {bug: 'remove', breaks: ['removal unbinds and revokes every client of the agent']},
  {bug: 'person escape', breaks: ['a bound client acts only as its agent']},
  {bug: 'other client', breaks: ['binding edits only the named client']},
  {bug: 'unasserted unbind', breaks: ['unbinding requires assertion and live ownership']},
  {bug: 'dead act', breaks: ['acting requires live authority and no removal tombstone']},
]
