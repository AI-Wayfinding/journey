import {all, forall, nat, no, oneOf, rule, same, when, yes} from 'gdp-wired'

// The host authenticates and authorizes membership changes, verifies signed
// device/agent registrations, and interns identities into [0, slots). This rule
// checks admission only, never artifact content. `belongsTo` is the verified
// owning person, not a claim accepted from the caller. The owner is added during
// group creation; after that they cannot be removed. Other members may leave.
export const Kind = oneOf('none', 'person', 'device', 'agent')
export type PersonalGroupBug =
  | 'admits another person'
  | "admits someone else's device or agent"
  | 'ignores slot bound'
  | 'removes the owner'
  | 'turns a member into another kind'
  | 'refuses every add'
  | 'refuses every removal'

export const personalGroupRule = (bug?: PersonalGroupBug) => rule('personalGroup')
  .params({owner: nat, slots: nat})
  .pre(({owner, slots}) => owner.lt(slots))
  .inputs({op: oneOf('add', 'remove'), subject: nat, kind: Kind, belongsTo: nat})
  // Generated init checks number ranges; every step also checks this relation.
  .assume(({owner, slots}) => owner.lt(slots))
  .maps({Members: Kind.from('none'), Belongs: 0})
  .flags(({op, subject, kind, belongsTo, owner, slots, Members}) => {
    const inRange = bug === 'ignores slot bound' ? yes : subject.lt(slots)
    const owned = bug === "admits someone else's device or agent" ? yes : belongsTo.eq(owner)
    const fits = kind.is('person').and(bug === 'admits another person' ? yes : subject.eq(owner))
      .or(kind.is('device').or(kind.is('agent')).and(subject.eq(owner).not()))
    const absent = bug === 'turns a member into another kind' ? yes : Members.at(subject).is('none')
    const removable = bug === 'removes the owner'
      ? Members.at(subject).is('none').not()
      : Members.at(subject).is('device').or(Members.at(subject).is('agent'))
    return {
      adds: bug === 'refuses every add' ? no : all(op.is('add'), inRange, owned, fits, absent),
      removes: bug === 'refuses every removal' ? no : all(op.is('remove'), inRange, removable),
    }
  })
  .step(({subject, kind, belongsTo, adds, removes, owner, Members, Belongs}) => {
    // Even a no-op set allocates a map cell. Refused requests touch only the
    // owner's allocated slot, never an unbounded caller-supplied identity.
    const key = when(adds.or(removes), subject, owner)
    return {
      Members: Members.set(key, when(adds, kind, when(removes, 'none', Members.at(key)))),
      Belongs: Belongs.set(key, when(adds, belongsTo, Belongs.at(key))),
    }
  })

export const personalGroup = personalGroupRule()
type PersonalGroup = ReturnType<typeof personalGroupRule>

export const personalGroupLaws = (r: PersonalGroup = personalGroup) => [
  // Only the owning person can be a person member of this group.
  r.law('the only person in the group is its owner', ({Members, owner}) =>
    forall(k => Members.at(k).is('person').implies(k.eq(owner)))),
  // Every admitted device and agent, and the person, belongs to the owner.
  r.law('every member belongs to the owner', ({Members, Belongs, owner}) =>
    forall(k => Members.at(k).is('none').not().implies(Belongs.at(k).eq(owner)))),
  // Only the host's allocated identity slots can contain members.
  r.law('every member has an allocated slot', ({Members, slots}) =>
    forall(k => Members.at(k).is('none').not().implies(k.lt(slots)))),
]

export const personalGroupStepLaws = (r: PersonalGroup = personalGroup) => [
  // No later request can take the owner out once group creation has added them.
  r.stepLaw('the owner is never taken out of their group',
    ({owner}, after) => after.Members.at(owner).is('person'),
    ({owner, Members}) => Members.at(owner).is('person')),
  // An existing member can stay or leave, but cannot change identity kind.
  r.stepLaw('a member never turns into another kind of member',
    ({Members}, after) => forall(k => Members.at(k).is('none').not().implies(
      same(after.Members.at(k), Members.at(k)).or(after.Members.at(k).is('none'))))),
  // Group creation can always admit the owning person into their empty slot.
  r.stepLaw('the owner can join their own group',
    ({owner}, after) => after.Members.at(owner).is('person'),
    ({op, subject, kind, belongsTo, owner, Members}) =>
      all(op.is('add'), subject.eq(owner), kind.is('person'), belongsTo.eq(owner), Members.at(owner).is('none'))),
  // An eligible device or agent can join an empty allocated slot.
  r.stepLaw('the owner can add their own device or agent',
    ({subject, kind}, after) => same(after.Members.at(subject), kind),
    ({op, subject, kind, belongsTo, owner, slots, Members}) =>
      all(op.is('add'), subject.lt(slots), kind.is('device').or(kind.is('agent')),
        belongsTo.eq(owner), subject.eq(owner).not(), Members.at(subject).is('none'))),
  // Devices and agents can be removed without removing the owning person.
  r.stepLaw('a device or agent can leave the group',
    ({subject}, after) => after.Members.at(subject).is('none'),
    ({op, subject, slots, Members}) => all(op.is('remove'), subject.lt(slots),
      Members.at(subject).is('device').or(Members.at(subject).is('agent')))),
]

export const laws = personalGroupLaws()
export const stepLaws = personalGroupStepLaws()

// The test suite proves each named law rejects its corresponding wrong rule.
export const brokenVariants: {bug: PersonalGroupBug, breaks: string[]}[] = [
  {bug: 'admits another person', breaks: ['the only person in the group is its owner']},
  {bug: "admits someone else's device or agent", breaks: ['every member belongs to the owner']},
  {bug: 'ignores slot bound', breaks: ['every member has an allocated slot']},
  {bug: 'removes the owner', breaks: ['the owner is never taken out of their group']},
  {bug: 'turns a member into another kind', breaks: ['a member never turns into another kind of member']},
  {bug: 'refuses every add', breaks: ['the owner can join their own group', 'the owner can add their own device or agent']},
  {bug: 'refuses every removal', breaks: ['a device or agent can leave the group']},
]
