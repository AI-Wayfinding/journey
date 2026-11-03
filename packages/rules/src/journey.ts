import {all, bool, forall, nat, no, oneOf, rule, same, when, yes} from 'gdp-wired'
import type {CellsRef, Choice, MapRef, Term} from 'gdp-wired'

// Journey: who belongs to a journey and what each member may do.
//
// The host (the journey's Durable Object or the local proxy) interns every
// member to a small number below `slots`, checks signatures and sign-in, and
// steps this rule before every membership write. The rule never reads artifact
// content.
//
// Members are people or agents. A person has a content role: read-only
// ('read') or read-write ('write'). Guide authority is a separate mark, held
// only by people. An agent has no role or authority of its own: it acts with
// the authority of the live person who added it (`AddedBy`), looked up each
// time it acts. Agent cards narrow that further (agentCard.ts).
//
// A journey admits people by one of three policies: 'request' (people ask and
// a guide admits them), 'open' (anyone may join) or 'invite' (only invited
// people may join). A guide may invite people under any policy. Newcomers get
// the journey's default role.
//
// Each step is one request: `op` names the action, `actor` who asks and
// `subject` whom it is about. A 'check' asks whether `actor` may act with
// `need` now; `allowed` holds the answer.
export const Kind = oneOf('none', 'person', 'agent')
export const Role = oneOf('read', 'write')
export const Policy = oneOf('request', 'open', 'invite')
export const Pending = oneOf('none', 'invited', 'requested')
export const Op = oneOf('found', 'policy', 'invite', 'request', 'join', 'admit', 'refuse', 'role', 'guide', 'unguide', 'addAgent', 'remove', 'leave', 'check')
export const Need = oneOf('read', 'write', 'guide')

export type JourneyBug =
  | 'makes agents guides'
  | 'marks a guide twice'
  | 'lets the last guide leave'
  | 'adds agents for a non-member'
  | 'admits before founding'
  | 'keeps a pending mark after joining'
  | 'ignores the slot bound'
  | 'lets any member change the policy'
  | 'lets any member invite'
  | 'accepts requests under any policy'
  | 'joins without an invite'
  | 'joins with a fixed role'
  | 'lets any member change roles'
  | 'lets any member make guides'
  | 'lets anyone remove a member'
  | 'reassigns an agent'
  | 'turns an agent into a person'
  | 'removal keeps the agents'
  | 'an agent acts with its own role'
  | 'refuses every check'
  | 'refuses every leave'

type Members = CellsRef<Choice<'none' | 'person' | 'agent'>>

// The person whose authority `actor` uses: itself, or for an agent the person
// who added it. Shared by the rule and its laws so both read authority alike.
export const actingPerson = (actor: Term, Members: Members, AddedBy: MapRef) =>
  when(Members.at(actor).is('agent'), AddedBy.at(actor), actor)
// The actor is a member and the person it acts for is a person member now.
export const isLive = (actor: Term, Members: Members, AddedBy: MapRef) =>
  Members.at(actor).is('none').not().and(Members.at(actingPerson(actor, Members, AddedBy)).is('person'))
// The actor is live and the person it acts for holds the guide mark.
export const isGuide = (actor: Term, Members: Members, AddedBy: MapRef, Guides: MapRef) =>
  isLive(actor, Members, AddedBy).and(Guides.at(actingPerson(actor, Members, AddedBy)).eq(1))

// The rule, or with `bug` one of its broken variants (kept for the tests).
export const journeyRule = (bug?: JourneyBug) => rule('journey')
  .params({slots: nat})
  .inputs({op: Op, actor: nat, subject: nat, role: Role, newPolicy: Policy, need: Need})
  // Host encoders refuse ids outside the journey's slots before stepping; the
  // generated module checks it again on every step.
  .assume(({actor, subject, slots}) => (bug === 'ignores the slot bound' ? yes : actor.lt(slots).and(subject.lt(slots))))
  .state({
    founded: bool.from(false),
    policy: Policy.from('request'),
    defaultRole: Role.from('read'),
    allowed: bool.from(false),
  })
  .maps({
    Members: Kind.from('none'),
    Roles: Role.from('read'),
    Guides: 0,
    AddedBy: 0,
    Pending: Pending.from('none'),
  })
  .flags(({op, actor, subject, need, founded, policy, Members, Roles, Guides, AddedBy, Pending}) => {
    const sub = Members.at(subject)
    const principal = actingPerson(actor, Members, AddedBy)
    const live = isLive(actor, Members, AddedBy)
    const guide = isGuide(actor, Members, AddedBy, Guides)
    const member = Members.at(actor).is('none').not()
    // Taking a guide out (removal, leaving or unmarking) needs another guide left.
    const notLast = bug === 'lets the last guide leave' ? yes : Guides.at(subject).eq(0).or(Guides.sum().atLeast(2))
    return {
      founds: all(op.is('found'), founded.not(), subject.eq(actor)),
      setsPolicy: all(op.is('policy'), founded, bug === 'lets any member change the policy' ? member : guide),
      invites: all(op.is('invite'), founded, bug === 'lets any member invite' ? member : guide, sub.is('none')),
      requests: all(op.is('request'), founded, subject.eq(actor), sub.is('none'), Pending.at(subject).is('none'),
        bug === 'accepts requests under any policy' ? yes : policy.is('request')),
      joins: all(op.is('join'), bug === 'admits before founding' ? yes : founded, subject.eq(actor),
        bug === 'turns an agent into a person' ? sub.is('person').not() : sub.is('none'),
        bug === 'joins without an invite' ? yes : policy.is('open').or(Pending.at(subject).is('invited'))),
      admits: all(op.is('admit'), founded, guide, sub.is('none'), Pending.at(subject).is('requested')),
      refuses: all(op.is('refuse'), founded, guide, sub.is('none'), Pending.at(subject).is('none').not()),
      setsRole: all(op.is('role'), founded, bug === 'lets any member change roles' ? member : guide, sub.is('person')),
      makesGuide: all(op.is('guide'), founded, bug === 'lets any member make guides' ? member : guide,
        bug === 'makes agents guides' ? sub.is('none').not() : sub.is('person'),
        bug === 'marks a guide twice' ? yes : Guides.at(subject).eq(0)),
      unguides: all(op.is('unguide'), founded, guide, sub.is('person'), Guides.at(subject).eq(1), notLast),
      // Only a person member adds agents; the agent then acts for that person.
      addsAgent: all(op.is('addAgent'), founded,
        bug === 'adds agents for a non-member' ? yes : Members.at(actor).is('person'),
        bug === 'reassigns an agent' ? sub.is('person').not() : sub.is('none'),
        Pending.at(subject).is('none'), subject.eq(actor).not()),
      removes: all(op.is('remove'), founded, sub.is('none').not(), notLast,
        bug === 'lets anyone remove a member' ? yes : guide.or(all(live, sub.is('agent'), AddedBy.at(subject).eq(principal)))),
      leaves: bug === 'refuses every leave' ? no : all(op.is('leave'), subject.eq(actor), sub.is('none').not(), notLast),
      checks: bug === 'refuses every check' ? no : all(op.is('check'), live, need.match({
        read: () => yes,
        write: () => Roles.at(bug === 'an agent acts with its own role' ? actor : principal).is('write'),
        guide: () => Guides.at(principal).eq(1),
      })),
    }
  })
  .step(({actor, subject, role, newPolicy, founded, policy, defaultRole, Members, Roles, Guides, AddedBy, Pending,
    founds, setsPolicy, invites, requests, joins, admits, refuses, setsRole, makesGuide, unguides, addsAgent, removes, leaves, checks}) => {
    const drops = removes.or(leaves)
    // Removing a person removes every agent that person added, in the same step.
    const dropsAgentsOf = bug === 'removal keeps the agents' ? no : drops.and(Members.at(subject).is('person'))
    const enters = founds.or(joins, admits)
    return {
      founded: founded.or(founds),
      policy: when(founds.or(setsPolicy), newPolicy, policy),
      defaultRole: when(founds.or(setsPolicy), role, defaultRole),
      allowed: checks,
      Members: Members.each(k => when(k.eq(subject),
        when(enters, 'person', when(addsAgent, 'agent', when(drops, 'none', Members.at(k)))),
        when(all(dropsAgentsOf, Members.at(k).is('agent'), AddedBy.at(k).eq(subject)), 'none', Members.at(k)))),
      Roles: Roles.set(subject, when(founds, 'write',
        when(joins.or(admits), bug === 'joins with a fixed role' ? 'write' : defaultRole, when(setsRole, role, Roles.at(subject))))),
      Guides: Guides.set(subject, when(founds, 1,
        when(makesGuide, bug === 'marks a guide twice' ? Guides.at(subject).plus(1) : 1,
          when(unguides.or(drops), 0, Guides.at(subject))))),
      AddedBy: AddedBy.set(subject, when(addsAgent, actor, AddedBy.at(subject))),
      Pending: Pending.set(subject, when(invites, 'invited', when(requests, 'requested',
        when(bug === 'keeps a pending mark after joining' ? refuses : enters.or(refuses), 'none', Pending.at(subject))))),
    }
  })

export const journey = journeyRule()
type Journey = ReturnType<typeof journeyRule>

export const journeyLaws = (r: Journey = journey) => [
  // Law: only people hold guide authority; an agent is never a guide.
  r.law('every guide is a person member', ({Members, Guides}) =>
    forall(k => Guides.at(k).gt(0).implies(Members.at(k).is('person')))),
  // Law: the guide mark is a yes or no: a member is a guide once, or not at all.
  r.law('a guide mark is zero or one', ({Guides}) => forall(k => Guides.at(k).atMost(1))),
  // Law: once a journey is founded it always has at least one person who is a guide.
  // The last guide cannot leave, be removed or give up the mark.
  r.law('a founded journey always has a guide', ({founded, Guides}) => founded.implies(Guides.sum().atLeast(1))),
  // Law: every agent was added by a person who is still a member. When a person
  // goes, their agents go with them.
  r.law('every agent belongs to a person member', ({Members, AddedBy}) =>
    forall(k => Members.at(k).is('agent').implies(Members.at(AddedBy.at(k)).is('person')))),
  // Law: before a journey is founded nobody is a member of it.
  r.law('nobody is a member before founding', ({founded, Members}) =>
    forall(k => founded.not().implies(Members.at(k).is('none')))),
  // Law: an open invitation or join request only exists for someone who is not
  // yet a member; joining clears it.
  r.law('only non-members have a pending invite or request', ({Members, Pending}) =>
    forall(k => Pending.at(k).is('none').not().implies(Members.at(k).is('none')))),
  // Law: members only occupy the numbered places the host gave this journey.
  r.law('every member has a slot', ({Members, slots}) =>
    forall(k => Members.at(k).is('none').not().implies(k.lt(slots)))),
]

export const journeyStepLaws = (r: Journey = journey) => [
  // Step law: after founding, only a guide (or an agent of a guide) changes how
  // people join and which role newcomers get.
  r.stepLaw('only a guide changes the joining policy or default role',
    ({actor, policy, defaultRole, Members, AddedBy, Guides}, after) =>
      same(after.policy, policy).and(same(after.defaultRole, defaultRole)).not().implies(isGuide(actor, Members, AddedBy, Guides)),
    ({founded}) => founded),
  // Step law: only a guide invites someone.
  r.stepLaw('only a guide invites',
    ({actor, Members, AddedBy, Guides, Pending}, after) => forall(k =>
      Pending.at(k).is('invited').not().and(after.Pending.at(k).is('invited')).implies(isGuide(actor, Members, AddedBy, Guides)))),
  // Step law: a request to join is recorded only when the journey takes
  // requests, and only from the person asking for themselves.
  r.stepLaw('a join request is recorded only under the request policy',
    ({actor, policy, Pending}, after) => forall(k =>
      Pending.at(k).is('requested').not().and(after.Pending.at(k).is('requested')).implies(policy.is('request').and(actor.eq(k))))),
  // Step law: a person becomes a member only by founding the journey, by
  // joining an open journey, by accepting an invitation, or by a guide
  // admitting their request.
  r.stepLaw('a person joins only by founding, an open journey, an invitation or a guide admitting them',
    ({actor, founded, policy, Members, AddedBy, Guides, Pending}, after) => forall(k =>
      Members.at(k).is('person').not().and(after.Members.at(k).is('person')).implies(
        founded.not().and(actor.eq(k))
          .or(actor.eq(k).and(policy.is('open').or(Pending.at(k).is('invited'))))
          .or(isGuide(actor, Members, AddedBy, Guides).and(Pending.at(k).is('requested')))))),
  // Step law: someone who joins a founded journey gets its default role.
  r.stepLaw('a newcomer gets the default role',
    ({defaultRole, Members}, after) => forall(k =>
      Members.at(k).is('none').and(after.Members.at(k).is('person')).implies(same(after.Roles.at(k), defaultRole))),
    ({founded}) => founded),
  // Step law: only a guide changes a member's role.
  r.stepLaw('only a guide changes a role',
    ({actor, Members, AddedBy, Guides, Roles}, after) => forall(k =>
      all(Members.at(k).is('person'), after.Members.at(k).is('person'), same(after.Roles.at(k), Roles.at(k)).not())
        .implies(isGuide(actor, Members, AddedBy, Guides)))),
  // Step law: after founding, only a guide makes someone else a guide.
  r.stepLaw('only a guide makes a guide',
    ({actor, Members, AddedBy, Guides}, after) => forall(k =>
      Guides.at(k).eq(0).and(after.Guides.at(k).gt(0)).implies(isGuide(actor, Members, AddedBy, Guides))),
    ({founded}) => founded),
  // Step law: a member leaves only by their own choice, by a guide removing
  // them, or (for an agent) by its person removing it or by its person leaving
  // or being removed.
  r.stepLaw('a member is removed only by a guide, by leaving, or with or by its person',
    ({actor, Members, AddedBy, Guides}, after) => forall(k =>
      Members.at(k).is('none').not().and(after.Members.at(k).is('none')).implies(
        isGuide(actor, Members, AddedBy, Guides)
          .or(actor.eq(k))
          .or(Members.at(k).is('agent').and(isLive(actor, Members, AddedBy), AddedBy.at(k).eq(actingPerson(actor, Members, AddedBy))))
          .or(Members.at(k).is('agent').and(after.Members.at(AddedBy.at(k)).is('none')))))),
  // Step law: an agent keeps acting for the person who added it; that never
  // changes while the agent is a member.
  r.stepLaw('an agent always acts for the person who added it',
    ({AddedBy, Members}, after) => forall(k =>
      Members.at(k).is('agent').and(after.Members.at(k).is('agent')).implies(after.AddedBy.at(k).eq(AddedBy.at(k))))),
  // Step law: a person stays a person and an agent stays an agent; either may
  // only stop being a member.
  r.stepLaw('a member never turns into another kind',
    ({Members}, after) => forall(k =>
      Members.at(k).is('none').not().implies(same(after.Members.at(k), Members.at(k)).or(after.Members.at(k).is('none'))))),
  // Step law: when a person stops being a member, every agent they added stops
  // being a member in the same step.
  r.stepLaw('removing a person removes their agents',
    ({Members, AddedBy}, after) => forall(k => all(
      Members.at(AddedBy.at(k)).is('person'), after.Members.at(AddedBy.at(k)).is('none'), Members.at(k).is('agent'),
    ).implies(after.Members.at(k).is('none')))),
  // Step law: a check says yes exactly when the actor is a member, the person it
  // acts for (itself, or an agent's adding person) is a live member, and that
  // person holds what is needed: any member reads, the read-write role writes,
  // and the guide mark guides. An agent never has more than its person.
  r.stepLaw('a check says yes exactly when the acting person is live and holds the need',
    ({actor, need, Members, AddedBy, Roles, Guides}, after) => {
      const person = actingPerson(actor, Members, AddedBy)
      return after.allowed.iff(isLive(actor, Members, AddedBy).and(need.match({
        read: () => yes,
        write: () => Roles.at(person).is('write'),
        guide: () => Guides.at(person).eq(1),
      })))
    },
    ({op}) => op.is('check')),
  // Step law: any member may leave, unless they are the last guide.
  r.stepLaw('a member who is not the last guide can always leave',
    ({actor}, after) => after.Members.at(actor).is('none'),
    ({op, actor, subject, Members, Guides}) =>
      all(op.is('leave'), subject.eq(actor), Members.at(actor).is('none').not(), Guides.at(actor).eq(0).or(Guides.sum().atLeast(2)))),
]

export const laws = journeyLaws()
export const stepLaws = journeyStepLaws()

// Each broken variant and the laws it must break. The tests assert every one
// is refused, and that every law above is broken by at least one of them.
export const brokenVariants: {bug: JourneyBug, breaks: string[]}[] = [
  {bug: 'makes agents guides', breaks: ['every guide is a person member']},
  {bug: 'marks a guide twice', breaks: ['a guide mark is zero or one']},
  {bug: 'lets the last guide leave', breaks: ['a founded journey always has a guide']},
  {bug: 'adds agents for a non-member', breaks: ['every agent belongs to a person member']},
  {bug: 'admits before founding', breaks: ['nobody is a member before founding']},
  {bug: 'keeps a pending mark after joining', breaks: ['only non-members have a pending invite or request']},
  {bug: 'ignores the slot bound', breaks: ['every member has a slot']},
  {bug: 'lets any member change the policy', breaks: ['only a guide changes the joining policy or default role']},
  {bug: 'lets any member invite', breaks: ['only a guide invites']},
  {bug: 'accepts requests under any policy', breaks: ['a join request is recorded only under the request policy']},
  {bug: 'joins without an invite', breaks: ['a person joins only by founding, an open journey, an invitation or a guide admitting them']},
  {bug: 'joins with a fixed role', breaks: ['a newcomer gets the default role']},
  {bug: 'lets any member change roles', breaks: ['only a guide changes a role']},
  {bug: 'lets any member make guides', breaks: ['only a guide makes a guide']},
  {bug: 'lets anyone remove a member', breaks: ['a member is removed only by a guide, by leaving, or with or by its person']},
  {bug: 'reassigns an agent', breaks: ['an agent always acts for the person who added it']},
  {bug: 'turns an agent into a person', breaks: ['a member never turns into another kind']},
  {bug: 'removal keeps the agents', breaks: ['removing a person removes their agents', 'every agent belongs to a person member']},
  {bug: 'an agent acts with its own role', breaks: ['a check says yes exactly when the acting person is live and holds the need']},
  {bug: 'refuses every check', breaks: ['a check says yes exactly when the acting person is live and holds the need']},
  {bug: 'refuses every leave', breaks: ['a member who is not the last guide can always leave']},
]
