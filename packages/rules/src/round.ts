import {all, bool, forall, nat, no, oneOf, rule, same, when, yes} from 'gdp-wired'

// One round. actor is ALWAYS the authenticated person behind an agent, so
// contributions are attributed to the person in Contributions and lastContributor.
// Host checks canCreate/canRun/canContribute live (membership + card), and
// subjectLive for participant changes. Host supplies default-all with add steps,
// keeps interviews/artifact assignments, and exposes an interview only to its
// person/agents or when Shared is true. Only that participant can share it.
// closed freezes status, not participant management; round_next is a new rule.
export const Status = oneOf('planned', 'open', 'synthesising', 'closed')
export type RoundBug = 'before create' | 'facilitator' | 'status authority' | 'transition' | 'reopen closed' | 'participants' | 'share' | 'unshare' | 'contribute' | 'attribution' | 'refuse create' | 'refuse move' | 'refuse remove' | 'refuse add' | 'refuse share' | 'refuse contribution'
export const roundRule = (bug?: RoundBug) => rule('round')
  .inputs({op: oneOf('create', 'status', 'add', 'remove', 'share', 'contribute'), actor: nat, subject: nat,
    to: Status, canCreate: bool, canRun: bool, canContribute: bool, subjectLive: bool})
  .state({exists: bool.from(false), facilitator: 0, status: Status.from('planned'), contributions: 0, lastContributor: 0})
  .maps({Participants: bool.from(false), Shared: bool.from(false), Contributions: 0})
  .flags(({op, actor, subject, to, canCreate, canRun, canContribute, subjectLive, exists, facilitator, status, Participants}) => {
    const facilitates = all(canRun, bug === 'status authority' ? yes : actor.eq(facilitator))
    const transition = status.is('planned').and(to.is('open')).or(
      status.is('open').and(to.is('synthesising')),
      status.is('synthesising').and(to.is('open').or(to.is('closed'))))
    return {
      creates: bug === 'refuse create' ? no : all(op.is('create'), exists.not(), canCreate),
      moves: bug === 'refuse move' ? no : all(op.is('status'), exists, facilitates,
        bug === 'transition' ? status.is('closed').not() : bug === 'reopen closed' ? yes : transition),
      adds: bug === 'refuse add' ? no : all(op.is('add'), bug === 'before create' ? yes : exists, canRun, subjectLive, bug === 'participants' ? yes : actor.eq(facilitator)),
      removes: all(op.is('remove'), bug === 'refuse remove' ? no : yes, exists, canRun, bug === 'participants' ? yes : actor.eq(facilitator)),
      shares: bug === 'refuse share' ? no : all(op.is('share'), exists, canContribute, Participants.at(subject), bug === 'share' ? yes : actor.eq(subject)),
      contributes: bug === 'refuse contribution' ? no : all(op.is('contribute'), exists, canContribute,
        bug === 'contribute' ? yes : Participants.at(actor).and(status.is('open').or(status.is('synthesising')))),
    }
  })
  .step(({actor, subject, to, exists, facilitator, status, contributions, lastContributor, Participants, Shared, Contributions,
    creates, moves, adds, removes, shares, contributes}) => ({
    exists: exists.or(creates),
    facilitator: when(creates.or(bug === 'facilitator' ? contributes : no), actor, facilitator),
    status: when(moves, to, status),
    Participants: Participants.set(subject, when(adds, yes, when(removes, no, Participants.at(subject)))),
    Shared: Shared.set(subject, bug === 'unshare' ? when(removes, no, Shared.at(subject).or(shares)) : Shared.at(subject).or(shares)),
    contributions: when(contributes, contributions.plus(1), contributions),
    lastContributor: when(contributes, bug === 'attribution' ? subject : actor, lastContributor),
    Contributions: Contributions.bump(bug === 'attribution' ? subject : actor, contributes),
  }))
export const round = roundRule()
type Round = ReturnType<typeof roundRule>
export const roundLaws = (r: Round = round) => [
  // Before creation there are no participants or contributions.
  r.law('an uncreated round has no participants or contributions', ({exists, Participants, contributions, status}) => forall(k => exists.not().implies(Participants.at(k).not().and(contributions.eq(0), status.is('planned'))))),
]
export const roundStepLaws = (r: Round = round) => [
  // The creator becomes facilitator; nobody later replaces them.
  r.stepLaw('the facilitator is fixed after creation', ({exists, facilitator}, a) => exists.implies(a.facilitator.eq(facilitator))),
  // Only the facilitator with current run capability changes status.
  r.stepLaw('only the facilitator runs the round', ({status, actor, facilitator, canRun}, a) => same(a.status, status).not().implies(actor.eq(facilitator).and(canRun))),
  // The only moves are planned->open, open->synthesising and synthesising->open/closed.
  r.stepLaw('status follows the round lifecycle', ({status}, a) => same(a.status, status).or(
    status.is('planned').and(a.status.is('open')), status.is('open').and(a.status.is('synthesising')),
    status.is('synthesising').and(a.status.is('open').or(a.status.is('closed'))))),
  // Closed status is terminal; a successor must be a new round.
  r.stepLaw('closed status is terminal', ({status}, a) => status.is('closed').implies(a.status.is('closed'))),
  // Only the facilitator manages participants, even after closure.
  r.stepLaw('only the facilitator changes participants', ({Participants, actor, facilitator, canRun}, a) => forall(k =>
    a.Participants.at(k).iff(Participants.at(k)).not().implies(actor.eq(facilitator).and(canRun)))),
  // A participant alone may expose their own interview, never someone else's.
  r.stepLaw('only the participant shares their interview', ({Shared, Participants, actor}, a) => forall(k =>
    Shared.at(k).not().and(a.Shared.at(k)).implies(actor.eq(k).and(Participants.at(k))))),
  // No other operation can unshare an interview or erase its sharing record.
  r.stepLaw('shared interviews are never unshared by others', ({Shared}, a) => forall(k => Shared.at(k).implies(a.Shared.at(k)))),
  // Non-participants and planned/closed rounds cannot accept contributions.
  r.stepLaw('only participants contribute while open or synthesising', ({contributions, actor, Participants, status, canContribute}, a) =>
    a.contributions.gt(contributions).implies(all(Participants.at(actor), canContribute, status.is('open').or(status.is('synthesising'))))),
  // Every accepted contribution increments only the authenticated person's count.
  r.stepLaw('contributions are attributed to the acting person', ({actor, contributions, Contributions}, a) => forall(k =>
    all(a.Contributions.at(k).eq(when(k.eq(actor), Contributions.at(k).plus(a.contributions.minus(contributions)), Contributions.at(k))),
      a.contributions.gt(contributions).implies(a.lastContributor.eq(actor))))),
  // A creator starts a fresh planned round as its facilitator.
  r.stepLaw('a creator starts a planned round', ({actor}, a) => all(a.exists, a.facilitator.eq(actor), a.status.is('planned')),
    ({op, exists, canCreate}) => all(op.is('create'), exists.not(), canCreate)),
  // A valid lifecycle request by the facilitator is accepted.
  r.stepLaw('the facilitator can advance or reopen synthesising', ({to}, a) => same(a.status, to),
    ({op, exists, canRun, actor, facilitator, status, to}) => all(op.is('status'), exists, canRun, actor.eq(facilitator),
      status.is('planned').and(to.is('open')).or(status.is('open').and(to.is('synthesising')), status.is('synthesising').and(to.is('open').or(to.is('closed')))))),
  // A live member can be added at any stage, including closed.
  r.stepLaw('the facilitator can add a participant at any time', ({subject}, a) => a.Participants.at(subject),
    ({op, exists, actor, facilitator, canRun, subjectLive}) => all(op.is('add'), exists, actor.eq(facilitator), canRun, subjectLive)),
  // Sharing is an explicit participant action.
  r.stepLaw('a participant can share their own interview', ({subject}, a) => a.Shared.at(subject),
    ({op, exists, actor, subject, Participants, canContribute}) => all(op.is('share'), exists, actor.eq(subject), Participants.at(subject), canContribute)),
  // Accepted contributions count exactly once, not merely no more than once.
  r.stepLaw('an eligible participant can contribute once', ({contributions}, a) => a.contributions.eq(contributions.plus(1)),
    ({op, exists, actor, Participants, canContribute, status}) => all(op.is('contribute'), exists, Participants.at(actor), canContribute, status.is('open').or(status.is('synthesising')))),
  // Participant removal is available at every lifecycle stage as well.
  r.stepLaw('the facilitator can remove a participant at any time', ({subject}, a) => a.Participants.at(subject).not(),
    ({op, exists, actor, facilitator, canRun}) => all(op.is('remove'), exists, actor.eq(facilitator), canRun)),
]
export const laws = roundLaws()
export const stepLaws = roundStepLaws()
export const brokenVariants: {bug: RoundBug, breaks: string[]}[] = [
  {bug: 'before create', breaks: ['an uncreated round has no participants or contributions']},
  {bug: 'facilitator', breaks: ['the facilitator is fixed after creation']},
  {bug: 'status authority', breaks: ['only the facilitator runs the round']},
  {bug: 'transition', breaks: ['status follows the round lifecycle']},
  {bug: 'reopen closed', breaks: ['closed status is terminal']},
  {bug: 'participants', breaks: ['only the facilitator changes participants']},
  {bug: 'share', breaks: ['only the participant shares their interview']},
  {bug: 'unshare', breaks: ['shared interviews are never unshared by others']},
  {bug: 'contribute', breaks: ['only participants contribute while open or synthesising']},
  {bug: 'attribution', breaks: ['contributions are attributed to the acting person']},
  {bug: 'refuse create', breaks: ['a creator starts a planned round']},
  {bug: 'refuse move', breaks: ['the facilitator can advance or reopen synthesising']},
  {bug: 'refuse add', breaks: ['the facilitator can add a participant at any time']},
  {bug: 'refuse share', breaks: ['a participant can share their own interview']},
  {bug: 'refuse contribution', breaks: ['an eligible participant can contribute once']},
  {bug: 'refuse remove', breaks: ['the facilitator can remove a participant at any time']},
]
