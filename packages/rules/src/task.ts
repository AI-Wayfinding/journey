import {all, any, bool, nat, no, oneOf, rule, same, when, yes} from 'gdp-wired'

// Task: one piece of work in a journey that a person or agent claims and works
// on in rounds. A task is open until someone claims it; the claimant works in
// rounds (in-round) and finishes it (done). It can also end because its time
// ran out or its rounds were used up (expired), or because its creator
// cancelled it. Done, expired and cancelled are final.
//
// Every task ends: it has a fixed number of rounds and a deadline, both set
// when it is made. The rule never reads a clock. The host compares the time
// with the deadline and passes the outcome in (`deadlinePassed`); it also
// checks that the actor is a live journey member (`actorIsLive`) and interns
// people and agents to small integers.
//
// Inputs: `op` what is asked; `actor` who asks; `actorIsLive` and
// `deadlinePassed` the host's checks; `maxRounds` the round cap given at create.
// State: `status`; `creator`; `claimant`; `roundsUsed`; `cap` the round cap.
export const Status = oneOf('none', 'open', 'claimed', 'inRound', 'done', 'expired', 'cancelled')

export type TaskBug =
  | 'starts a round past the cap'
  | 'starts a round after the deadline'
  | 'reopens a finished task'
  | 'counts a round twice'
  | 'gives back a round'
  | 'lets another member work a claimed task'
  | 'lets anyone cancel'
  | 'expires a task before its time'
  | 'changes the round cap'
  | 'creates with rounds already used'
  | 'enters a round from an open task'
  | 'starts a round without counting it'
  | 'writes the cap on a refused create'
  | 'records the wrong cap'
  | 'refuses every claim'
  | 'refuses every round'
  | 'refuses to expire'
  | 'refuses to cancel'

// The rule, or with `bug` one of its broken variants (kept for the tests).
export const taskRule = (bug?: TaskBug) => rule('task')
  .inputs({op: oneOf('create', 'claim', 'startRound', 'endRound', 'finish', 'cancel', 'expire'), actor: nat, actorIsLive: bool, deadlinePassed: bool, maxRounds: nat})
  .state({status: Status.from('none'), creator: 0, claimant: 0, roundsUsed: 0, cap: 0})
  .flags(({op, actor, actorIsLive, deadlinePassed, status, creator, claimant, roundsUsed, cap}) => {
    const active = any(status.is('open'), status.is('claimed'), status.is('inRound'))
    const isClaimant = bug === 'lets another member work a claimed task' ? actorIsLive : actor.eq(claimant).and(actorIsLive)
    const inTime = bug === 'starts a round after the deadline' ? yes : deadlinePassed.not()
    const roundsLeft = bug === 'starts a round past the cap' ? yes : roundsUsed.lt(cap)
    return {
      creates: all(op.is('create'), status.is('none'), actorIsLive),
      claims: bug === 'refuses every claim' ? no : all(op.is('claim'), status.is('open'), actorIsLive, deadlinePassed.not()),
      starts: bug === 'refuses every round' ? no : all(op.is('startRound'),
        bug === 'enters a round from an open task' ? status.is('claimed').or(status.is('open')) : status.is('claimed'),
        isClaimant, roundsLeft, inTime),
      ends: all(op.is('endRound'), status.is('inRound'), isClaimant),
      finishes: all(op.is('finish'), status.is('claimed').or(status.is('inRound')), isClaimant, deadlinePassed.not()),
      cancels: bug === 'refuses to cancel' ? no : all(op.is('cancel'), active,
        bug === 'lets anyone cancel' ? yes : actor.eq(creator).and(actorIsLive)),
      expires: bug === 'refuses to expire' ? no : all(op.is('expire'), active,
        bug === 'expires a task before its time' ? yes : deadlinePassed.or(status.is('inRound').not().and(roundsUsed.atLeast(cap)))),
      reopens: bug === 'reopens a finished task' ? op.is('claim').and(status.is('done')) : no,
    }
  })
  .step(({op, actor, maxRounds, status, creator, claimant, roundsUsed, cap, creates, claims, starts, ends, finishes, cancels, expires, reopens}) => ({
    status: when(creates.or(reopens), 'open', when(claims, 'claimed', when(starts, 'inRound', when(ends, 'claimed',
      when(finishes, 'done', when(cancels, 'cancelled', when(expires, 'expired', status))))))),
    creator: when(creates, actor, creator),
    claimant: when(claims, actor, claimant),
    roundsUsed: when(creates, bug === 'creates with rounds already used' ? 1 : 0,
      when(starts, roundsUsed.plus(bug === 'counts a round twice' ? 2 : bug === 'starts a round without counting it' ? 0 : 1),
        when(ends.and(bug === 'gives back a round' ? yes : no), roundsUsed.minus(1), roundsUsed))),
    cap: when(bug === 'writes the cap on a refused create' ? op.is('create') : creates, bug === 'records the wrong cap' ? maxRounds.plus(1) : maxRounds, when(starts.and(bug === 'changes the round cap' ? yes : no), cap.plus(1), cap)),
  }))

export const task = taskRule()
type Task = ReturnType<typeof taskRule>

export const taskLaws = (r: Task = task) => [
  // Law: a task never uses more rounds than its cap.
  r.law('rounds used never pass the cap', ({roundsUsed, cap}) => roundsUsed.atMost(cap)),
  // Law: a task that has not been made yet has no creator, claimant, rounds or cap.
  r.law('a task not yet made is empty', ({status, creator, claimant, roundsUsed, cap}) =>
    status.is('none').implies(all(creator.eq(0), claimant.eq(0), roundsUsed.eq(0), cap.eq(0)))),
  // Law: an open task has not used any rounds yet.
  r.law('an open task has used no rounds', ({status, roundsUsed}) => status.is('open').implies(roundsUsed.eq(0))),
  // Law: a task in a round has used at least that round.
  r.law('a task in a round has used at least one round', ({status, roundsUsed}) => status.is('inRound').implies(roundsUsed.atLeast(1))),
]

export const taskStepLaws = (r: Task = task) => [
  // Step law: done, expired and cancelled are final: nothing about such a task
  // ever changes again.
  r.stepLaw('a finished task never changes', ({status, creator, claimant, roundsUsed, cap}, after) =>
    all(same(after.status, status), after.creator.eq(creator), after.claimant.eq(claimant), after.roundsUsed.eq(roundsUsed), after.cap.eq(cap)),
    ({status}) => any(status.is('done'), status.is('expired'), status.is('cancelled'))),
  // Step law: a round starts only while rounds used are below the cap and the
  // deadline has not passed.
  r.stepLaw('a round starts only within the cap and before the deadline', ({status, roundsUsed, cap, deadlinePassed}, after) =>
    status.is('inRound').not().and(after.status.is('inRound')).implies(roundsUsed.lt(cap).and(deadlinePassed.not()))),
  // Step law: rounds used never go down, and go up by one only when a round starts.
  r.stepLaw('rounds used go up only by one, when a round starts', ({status, roundsUsed}, after) =>
    any(after.roundsUsed.eq(roundsUsed), all(after.roundsUsed.eq(roundsUsed.plus(1)), status.is('claimed'), after.status.is('inRound'))),
    ({status}) => status.is('none').not()),
  // Step law: the round cap and the creator are fixed once the task is made.
  r.stepLaw('the cap and the creator never change once made', ({status, cap, creator}, after) =>
    status.is('none').not().implies(after.cap.eq(cap).and(after.creator.eq(creator)))),
  // Step law: making a task records its creator and cap and starts with no rounds used.
  r.stepLaw('a new task starts open with no rounds used', ({actor, maxRounds}, after) =>
    all(after.status.is('open'), after.creator.eq(actor), after.cap.eq(maxRounds), after.roundsUsed.eq(0)),
    ({op, status, actorIsLive}) => all(op.is('create'), status.is('none'), actorIsLive)),
  // Step law: only the live claimant works on a claimed task: starts or ends a
  // round, or finishes it.
  r.stepLaw('only the live claimant works on a claimed task', ({status, claimant, actor, actorIsLive}, after) =>
    any(status.is('claimed'), status.is('inRound')).and(any(after.status.is('claimed'), after.status.is('inRound'), after.status.is('done')))
      .and(same(after.status, status).not()).implies(actor.eq(claimant).and(actorIsLive))),
  // Step law: only the task's live creator cancels it.
  r.stepLaw('only the live creator cancels a task', ({status, creator, actor, actorIsLive}, after) =>
    status.is('cancelled').not().and(after.status.is('cancelled')).implies(actor.eq(creator).and(actorIsLive))),
  // Step law: a task expires only once its deadline has passed or its rounds are
  // used up outside a round.
  r.stepLaw('a task expires only at its deadline or round cap', ({status, roundsUsed, cap, deadlinePassed}, after) =>
    status.is('expired').not().and(after.status.is('expired')).implies(deadlinePassed.or(status.is('inRound').not().and(roundsUsed.atLeast(cap))))),
  // Step law: a live member can claim an open task before its deadline.
  r.stepLaw('a live member can claim an open task in time', ({actor}, after) => after.status.is('claimed').and(after.claimant.eq(actor)),
    ({op, status, actorIsLive, deadlinePassed}) => all(op.is('claim'), status.is('open'), actorIsLive, deadlinePassed.not())),
  // Step law: the claimant can start a round while rounds are left and the
  // deadline has not passed.
  r.stepLaw('the claimant can start a round within the cap and in time', ({roundsUsed}, after) =>
    after.status.is('inRound').and(after.roundsUsed.eq(roundsUsed.plus(1))),
    ({op, status, actor, claimant, actorIsLive, roundsUsed, cap, deadlinePassed}) =>
      all(op.is('startRound'), status.is('claimed'), actor.eq(claimant), actorIsLive, roundsUsed.lt(cap), deadlinePassed.not())),
  // Step law: once the deadline has passed, any task that is still going can be
  // expired, so every task reaches an end.
  r.stepLaw('a task still going can be expired once its deadline passes', (_, after) => after.status.is('expired'),
    ({op, status, deadlinePassed}) => all(op.is('expire'), any(status.is('open'), status.is('claimed'), status.is('inRound')), deadlinePassed)),
  // Step law: the live creator can cancel a task that is still going.
  r.stepLaw('the live creator can cancel a task still going', (_, after) => after.status.is('cancelled'),
    ({op, status, actor, creator, actorIsLive}) => all(op.is('cancel'), any(status.is('open'), status.is('claimed'), status.is('inRound')), actor.eq(creator), actorIsLive)),
]

export const laws = taskLaws()
export const stepLaws = taskStepLaws()

// Each broken variant and the laws it must break. The tests assert every one
// is refused, and that every law above is broken by at least one of them.
export const brokenVariants: {bug: TaskBug, breaks: string[]}[] = [
  {bug: 'starts a round past the cap', breaks: ['rounds used never pass the cap']},
  {bug: 'starts a round after the deadline', breaks: ['a round starts only within the cap and before the deadline']},
  {bug: 'reopens a finished task', breaks: ['a finished task never changes']},
  {bug: 'counts a round twice', breaks: ['rounds used never pass the cap']},
  {bug: 'gives back a round', breaks: ['rounds used go up only by one, when a round starts']},
  {bug: 'changes the round cap', breaks: ['the cap and the creator never change once made']},
  {bug: 'creates with rounds already used', breaks: ['an open task has used no rounds']},
  {bug: 'records the wrong cap', breaks: ['a new task starts open with no rounds used']},
  {bug: 'enters a round from an open task', breaks: ['rounds used go up only by one, when a round starts']},
  {bug: 'starts a round without counting it', breaks: ['a task in a round has used at least one round']},
  {bug: 'writes the cap on a refused create', breaks: ['a task not yet made is empty']},
  {bug: 'lets another member work a claimed task', breaks: ['only the live claimant works on a claimed task']},
  {bug: 'lets anyone cancel', breaks: ['only the live creator cancels a task']},
  {bug: 'expires a task before its time', breaks: ['a task expires only at its deadline or round cap']},
  {bug: 'refuses every claim', breaks: ['a live member can claim an open task in time']},
  {bug: 'refuses every round', breaks: ['the claimant can start a round within the cap and in time']},
  {bug: 'refuses to expire', breaks: ['a task still going can be expired once its deadline passes']},
  {bug: 'refuses to cancel', breaks: ['the live creator can cancel a task still going']},
]
