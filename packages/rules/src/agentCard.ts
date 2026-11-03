import {all, any, bool, forall, no, oneOf, rule, yes} from 'gdp-wired'

// Agent card: the limits a person sets for one of their agents.
//
// The person signs the card's limits once. After that the agent uses the card
// without asking again. The host verifies signatures and passes the outcome in
// as `personSigned` (the request carries a valid signature by the agent's
// person over exactly the new limits). The host also passes in what the
// journey rule says now: `personHas` (the agent's person holds the capability
// that is needed), `personLive` and `agentLive` (both are still members).
//
// A card limits three capabilities: reading, writing and issuing grants.
// Each step is one request: 'sign' sets the first limits, 'edit' changes
// them, 'withdraw' clears the card, and 'check' asks whether the agent may
// act with `need` now; `allowed` holds the answer. The rule never reads
// artifact content.
export const Op = oneOf('sign', 'edit', 'withdraw', 'check')
export const Need = oneOf('read', 'write', 'grant')

export type AgentCardBug =
  | 'signs without the person'
  | 'widens without a signature'
  | 'refuses a narrowing without a signature'
  | 'withdraw keeps the card'
  | 'withdraw keeps the limits'
  | 'ignores the card limit'
  | 'ignores the person capability'
  | 'ignores a person who left'
  | 'ignores an agent that left'
  | 'refuses every check'

// The rule, or with `bug` one of its broken variants (kept for the tests).
export const agentCardRule = (bug?: AgentCardBug) => rule('agentCard')
  .inputs({
    op: Op,
    newRead: bool,
    newWrite: bool,
    newGrant: bool,
    personSigned: bool,
    need: Need,
    personHas: bool,
    personLive: bool,
    agentLive: bool,
  })
  .state({
    signed: bool.from(false),
    mayRead: bool.from(false),
    mayWrite: bool.from(false),
    mayGrant: bool.from(false),
    allowed: bool.from(false),
  })
  .flags(({op, newRead, newWrite, newGrant, personSigned, need, personHas, personLive, agentLive, signed, mayRead, mayWrite, mayGrant}) => {
    // The new limits allow nothing the card does not already allow.
    const narrows = all(newRead.implies(mayRead), newWrite.implies(mayWrite), newGrant.implies(mayGrant))
    const limit = need.match({read: () => mayRead, write: () => mayWrite, grant: () => mayGrant})
    return {
      signs: all(op.is('sign'), signed.not(), bug === 'signs without the person' ? yes : personSigned),
      edits: all(op.is('edit'), signed,
        bug === 'widens without a signature' ? yes : bug === 'refuses a narrowing without a signature' ? personSigned : narrows.or(personSigned)),
      withdraws: all(op.is('withdraw'), signed),
      checks: bug === 'refuses every check' ? no : all(op.is('check'), signed,
        bug === 'ignores the person capability' ? yes : personHas,
        bug === 'ignores the card limit' ? yes : limit,
        bug === 'ignores a person who left' ? yes : personLive,
        bug === 'ignores an agent that left' ? yes : agentLive),
    }
  })
  .step(({newRead, newWrite, newGrant, signed, mayRead, mayWrite, mayGrant, signs, edits, withdraws, checks}) => {
    const sets = signs.or(edits)
    const clears = bug === 'withdraw keeps the limits' ? no : withdraws
    const limit = (now: typeof mayRead, next: typeof newRead) => sets.and(next).or(sets.not().and(clears.not()).and(now))
    return {
      signed: signed.or(signs).and(bug === 'withdraw keeps the card' ? yes : withdraws.not()),
      mayRead: limit(mayRead, newRead),
      mayWrite: limit(mayWrite, newWrite),
      mayGrant: limit(mayGrant, newGrant),
      allowed: checks,
    }
  })

export const agentCard = agentCardRule()
type AgentCard = ReturnType<typeof agentCardRule>

export const agentCardLaws = (r: AgentCard = agentCard) => [
  // Law: a card nobody has signed (or one that was withdrawn) allows nothing.
  r.law('an unsigned card has no limits', ({signed, mayRead, mayWrite, mayGrant}) =>
    forall(() => signed.not().implies(all(mayRead.not(), mayWrite.not(), mayGrant.not())))),
]

export const agentCardStepLaws = (r: AgentCard = agentCard) => [
  // Step law: a card becomes signed only with a valid signature from the
  // agent's own person.
  r.stepLaw('a card is first signed only by its person',
    ({signed, personSigned}, after) => signed.not().and(after.signed).implies(personSigned)),
  // Step law: a card never gains a capability unless the person signs the new
  // limits. Narrowing is always allowed; widening needs a new signature.
  r.stepLaw('a card never widens without a new person signature',
    ({mayRead, mayWrite, mayGrant, personSigned}, after) =>
      any(mayRead.not().and(after.mayRead), mayWrite.not().and(after.mayWrite), mayGrant.not().and(after.mayGrant))
        .implies(personSigned)),
  // Step law: narrowing a signed card takes effect at once, with no new signature.
  r.stepLaw('a narrowing edit needs no new signature',
    ({newRead, newWrite, newGrant}, after) =>
      all(after.mayRead.iff(newRead), after.mayWrite.iff(newWrite), after.mayGrant.iff(newGrant)),
    ({op, signed, newRead, newWrite, newGrant, mayRead, mayWrite, mayGrant}) =>
      all(op.is('edit'), signed, newRead.implies(mayRead), newWrite.implies(mayWrite), newGrant.implies(mayGrant))),
  // Step law: withdrawing a card leaves the agent with no card.
  r.stepLaw('a withdrawn card is no longer signed',
    (_, after) => after.signed.not(),
    ({op}) => op.is('withdraw')),
  // Step law: the agent may act exactly when the card is signed, the person
  // holds the capability, the card allows it, and the person and the agent are
  // both still members. The agent never has more than its person or its card.
  r.stepLaw('the effective capability is the person capability and the card limit, with both live',
    ({need, signed, personHas, personLive, agentLive, mayRead, mayWrite, mayGrant}, after) =>
      after.allowed.iff(all(signed, personHas, personLive, agentLive,
        need.match({read: () => mayRead, write: () => mayWrite, grant: () => mayGrant}))),
    ({op}) => op.is('check')),
]

export const laws = agentCardLaws()
export const stepLaws = agentCardStepLaws()

// Each broken variant and the laws it must break. The tests assert every one
// is refused, and that every law above is broken by at least one of them.
const effective = 'the effective capability is the person capability and the card limit, with both live'
export const brokenVariants: {bug: AgentCardBug, breaks: string[]}[] = [
  {bug: 'signs without the person', breaks: ['a card is first signed only by its person']},
  {bug: 'widens without a signature', breaks: ['a card never widens without a new person signature']},
  {bug: 'refuses a narrowing without a signature', breaks: ['a narrowing edit needs no new signature']},
  {bug: 'withdraw keeps the card', breaks: ['a withdrawn card is no longer signed']},
  {bug: 'withdraw keeps the limits', breaks: ['an unsigned card has no limits']},
  {bug: 'ignores the card limit', breaks: [effective]},
  {bug: 'ignores the person capability', breaks: [effective]},
  {bug: 'ignores a person who left', breaks: [effective]},
  {bug: 'ignores an agent that left', breaks: [effective]},
  {bug: 'refuses every check', breaks: [effective]},
]
