import {all, any, bool, nat, no, oneOf, rule, same, when, yes} from 'gdp-wired'

// Task: one piece of journey work. An open task can be claimed immediately;
// a held offer request waits in requested with its intended agent as claimant.
// A live decider approves it into claimed or declines it. The claimant works
// in rounds and finishes it. Done, expired, cancelled and declined are final.
//
// Every task has a fixed round budget and a deadline. The host computes
// `deadlinePassed` and live journey membership (`actorIsLive`), and interns
// people and agents to small integers. Held requests expire only at the
// deadline, not at the round cap, since they cannot consume rounds yet.
//
// Inputs: `op` what is asked; `actor` who asks; `actorIsLive` and
// `deadlinePassed` the host's checks; `maxRounds` the cap at create/request;
// `agent` the intended claimant at request; `isDecider` the host's check that
// the actor owns the offered agent or holds offer.decide.
// State: `status`; `creator`; `claimant`; `roundsUsed`; `cap` the round cap.
export const Status = oneOf('none', 'open', 'claimed', 'inRound', 'done', 'expired', 'cancelled', 'requested', 'declined', 'needsInput', 'failed')

export type TaskBug =
  | 'lets anyone ask'
  | 'lets anyone answer'
  | 'lets anyone fail'
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
  | 'requests with rounds already used'
  | 'records the wrong requested agent'
  | 'lets a removed member request'
  | 'refuses every request'
  | 'lets a non-decider approve'
  | 'lets a removed decider approve'
  | 'approves after the deadline'
  | 'approves on claim'
  | 'assigns approval to the decider'
  | 'counts a round on approve'
  | 'refuses every approval'
  | 'lets a non-decider decline'
  | 'lets a removed decider decline'
  | 'refuses every decline'
  | 'reopens a declined task'
  | 'expires a request at the round cap'

// The rule, or with `bug` one of its broken variants (kept for the tests).
export const taskRule = (bug?: TaskBug) => rule('task')
  .inputs({op: oneOf('create', 'claim', 'startRound', 'endRound', 'finish', 'cancel', 'expire', 'request', 'approve', 'decline', 'askInput', 'answer', 'fail'), actor: nat, actorIsLive: bool, deadlinePassed: bool, maxRounds: nat, isDecider: bool, agent: nat})
  .state({status: Status.from('none'), creator: 0, claimant: 0, roundsUsed: 0, cap: 0})
  .flags(({op, actor, actorIsLive, isDecider, deadlinePassed, status, creator, claimant, roundsUsed, cap}) => {
    const active = any(status.is('open'), status.is('claimed'), status.is('inRound'), status.is('requested'), status.is('needsInput'))
    const isClaimant = bug === 'lets another member work a claimed task' ? actorIsLive : actor.eq(claimant).and(actorIsLive)
    const inTime = bug === 'starts a round after the deadline' ? yes : deadlinePassed.not()
    const roundsLeft = bug === 'starts a round past the cap' ? yes : roundsUsed.lt(cap)
    return {
      asks: all(op.is('askInput'), status.is('claimed'), bug === 'lets anyone ask' ? actorIsLive : isClaimant, deadlinePassed.not()),
      answers: all(op.is('answer'), status.is('needsInput'), bug === 'lets anyone answer' ? actorIsLive : actor.eq(creator).and(actorIsLive), deadlinePassed.not()),
      fails: all(op.is('fail'), any(status.is('claimed'),status.is('inRound'),status.is('needsInput')), bug === 'lets anyone fail' ? actorIsLive : isClaimant, deadlinePassed.not()),
      creates: all(op.is('create'), status.is('none'), actorIsLive),
      requests: bug === 'refuses every request' ? no : all(op.is('request'), status.is('none'), bug === 'lets a removed member request' ? yes : actorIsLive),
      approves: bug === 'refuses every approval' ? no : all(
        bug === 'approves on claim' ? op.is('claim') : op.is('approve'), status.is('requested'),
        bug === 'lets a non-decider approve' ? yes : isDecider,
        bug === 'lets a removed decider approve' ? yes : actorIsLive,
        bug === 'approves after the deadline' ? yes : deadlinePassed.not()),
      declines: bug === 'refuses every decline' ? no : all(op.is('decline'), status.is('requested'),
        bug === 'lets a non-decider decline' ? yes : isDecider,
        bug === 'lets a removed decider decline' ? yes : actorIsLive),
      claims: bug === 'refuses every claim' ? no : all(op.is('claim'), status.is('open'), actorIsLive, deadlinePassed.not()),
      starts: bug === 'refuses every round' ? no : all(op.is('startRound'),
        bug === 'enters a round from an open task' ? status.is('claimed').or(status.is('open')) : status.is('claimed'),
        isClaimant, roundsLeft, inTime),
      ends: all(op.is('endRound'), status.is('inRound'), isClaimant),
      finishes: all(op.is('finish'), status.is('claimed').or(status.is('inRound')), isClaimant, deadlinePassed.not()),
      cancels: bug === 'refuses to cancel' ? no : all(op.is('cancel'), active,
        bug === 'lets anyone cancel' ? yes : actor.eq(creator).and(actorIsLive)),
      expires: bug === 'refuses to expire' ? no : all(op.is('expire'), active,
        bug === 'expires a task before its time' ? yes : deadlinePassed.or(all(bug === 'expires a request at the round cap' ? yes : status.is('requested').not(), status.is('needsInput').not(), status.is('inRound').not(), roundsUsed.atLeast(cap)))),
      reopens: bug === 'reopens a finished task' ? op.is('claim').and(status.is('done')) : bug === 'reopens a declined task' ? op.is('claim').and(status.is('declined')) : no,
    }
  })
  .step(({op, actor, agent, maxRounds, status, creator, claimant, roundsUsed, cap, creates, requests, approves, declines, claims, starts, ends, finishes, cancels, expires, reopens, asks, answers, fails}) => ({
    status: when(asks, 'needsInput', when(answers, 'claimed', when(fails, 'failed', when(requests, 'requested', when(creates.or(reopens), when(reopens, status.of('claimed'), status.of('open')), when(claims.or(approves), 'claimed', when(starts, 'inRound', when(ends, 'claimed',
      when(finishes, 'done', when(cancels, 'cancelled', when(expires, 'expired', when(declines, 'declined', status)))))))))))),
    creator: when(creates.or(requests), actor, creator),
    claimant: when(requests, bug === 'records the wrong requested agent' ? actor : agent,
      when(claims.or(approves.and(bug === 'assigns approval to the decider' ? yes : no)), actor, claimant)),
    roundsUsed: when(approves.and(bug === 'counts a round on approve' ? yes : no), roundsUsed.plus(1),
      when(requests, bug === 'requests with rounds already used' ? 1 : 0, when(creates, bug === 'creates with rounds already used' ? 1 : 0,
      when(starts, roundsUsed.plus(bug === 'counts a round twice' ? 2 : bug === 'starts a round without counting it' ? 0 : 1),
        when(ends.and(bug === 'gives back a round' ? yes : no), roundsUsed.minus(1), roundsUsed))))),
    cap: when(requests, maxRounds, when(bug === 'writes the cap on a refused create' ? op.is('create') : creates, bug === 'records the wrong cap' ? maxRounds.plus(1) : maxRounds, when(starts.and(bug === 'changes the round cap' ? yes : no), cap.plus(1), cap))),
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
  // Law: waiting for an admission decision never consumes a round.
  r.law('a requested task has used no rounds', ({status, roundsUsed}) => status.is('requested').implies(roundsUsed.eq(0))),
  // Law: a task in a round has used at least that round.
  r.law('a task in a round has used at least one round', ({status, roundsUsed}) => status.is('inRound').implies(roundsUsed.atLeast(1))),
]

export const taskStepLaws = (r: Task = task) => [
  // Questions are claimant-only, and preserve the round counter.
  r.stepLaw('only the live claimant asks without a round', ({status,actor,claimant,actorIsLive,roundsUsed},after) => status.is('needsInput').not().and(after.status.is('needsInput')).implies(all(status.is('claimed'),actor.eq(claimant),actorIsLive,after.roundsUsed.eq(roundsUsed)))),
  // Answers come only from the authenticated creator, not another member.
  r.stepLaw('only the live creator answers', ({op,status,actor,creator,actorIsLive,roundsUsed},after) => status.is('needsInput').and(after.status.is('claimed')).implies(all(op.is('answer'),actor.eq(creator),actorIsLive,after.roundsUsed.eq(roundsUsed)))),
  // Failure is a claimant operation, never a substitute for decline or expiry.
  r.stepLaw('only the live claimant fails', ({op,status,actor,claimant,actorIsLive},after) => status.is('failed').not().and(after.status.is('failed')).implies(all(op.is('fail'),actor.eq(claimant),actorIsLive))),
  // Step law: a live requester records the intended agent and the fixed budget.
  r.stepLaw('a new request records its creator agent and cap without rounds', ({actor, agent, maxRounds}, after) =>
    all(after.status.is('requested'), after.creator.eq(actor), after.claimant.eq(agent), after.cap.eq(maxRounds), after.roundsUsed.eq(0)),
    ({op, status, actorIsLive}) => all(op.is('request'), status.is('none'), actorIsLive)),
  // Step law: a held request can only be made by a live member.
  r.stepLaw('only a live requester makes a held request', ({op, status, actorIsLive}, after) =>
    status.is('requested').not().and(after.status.is('requested')).implies(all(op.is('request'), status.is('none'), actorIsLive))),
  // Step law: approval needs a live decider, in time, and keeps the intended agent.
  r.stepLaw('only a live decider approves a request in time for its intended agent', ({op, status, isDecider, actorIsLive, deadlinePassed, claimant}, after) =>
    status.is('requested').and(after.status.is('claimed')).implies(all(op.is('approve'), isDecider, actorIsLive, deadlinePassed.not(), after.claimant.eq(claimant)))),
  // Step law: a permitted approval must work, not merely refuse every request.
  r.stepLaw('a live decider can approve a request in time', ({claimant, roundsUsed}, after) =>
    all(after.status.is('claimed'), after.claimant.eq(claimant), after.roundsUsed.eq(roundsUsed)),
    ({op, status, isDecider, actorIsLive, deadlinePassed}) => all(op.is('approve'), status.is('requested'), isDecider, actorIsLive, deadlinePassed.not())),
  // Step law: only a live decider can decline a request.
  r.stepLaw('only a live decider declines a request', ({op, status, isDecider, actorIsLive}, after) =>
    status.is('declined').not().and(after.status.is('declined')).implies(all(op.is('decline'), status.is('requested'), isDecider, actorIsLive))),
  // Step law: a live decider can decline even after the deadline has passed.
  r.stepLaw('a live decider can decline a request', (_, after) => after.status.is('declined'),
    ({op, status, isDecider, actorIsLive}) => all(op.is('decline'), status.is('requested'), isDecider, actorIsLive)),
  // Step law: leaving a held request needs its live creator or a live decider,
  // except for deadline expiry, which needs no actor authority.
  r.stepLaw('only the creator or a decider leaves requested except expiry', ({op, status, creator, actor, isDecider, actorIsLive, deadlinePassed}, after) =>
    status.is('requested').and(after.status.is('requested').not()).implies(any(
      all(op.is('expire'), after.status.is('expired'), deadlinePassed),
      actorIsLive.and(any(actor.eq(creator), isDecider))))),
  // Step law: done, expired, cancelled and declined are final: nothing about such a task
  // ever changes again.
  r.stepLaw('a finished task never changes', ({status, creator, claimant, roundsUsed, cap}, after) =>
    all(same(after.status, status), after.creator.eq(creator), after.claimant.eq(claimant), after.roundsUsed.eq(roundsUsed), after.cap.eq(cap)),
    ({status}) => any(status.is('done'), status.is('expired'), status.is('cancelled'), status.is('declined'), status.is('failed'))),
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
    status.is('expired').not().and(after.status.is('expired')).implies(deadlinePassed.or(all(status.is('requested').not(), status.is('needsInput').not(), status.is('inRound').not(), roundsUsed.atLeast(cap))))),
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
    ({op, status, deadlinePassed}) => all(op.is('expire'), any(status.is('open'), status.is('claimed'), status.is('inRound'), status.is('requested')), deadlinePassed)),
  // Step law: the live creator can cancel a task that is still going.
  r.stepLaw('the live creator can cancel a task still going', (_, after) => after.status.is('cancelled'),
    ({op, status, actor, creator, actorIsLive}) => all(op.is('cancel'), any(status.is('open'), status.is('claimed'), status.is('inRound'), status.is('requested')), actor.eq(creator), actorIsLive)),
]

export const laws = taskLaws()
export const stepLaws = taskStepLaws()

// Each broken variant and the laws it must break. The tests assert every one
// is refused, and that every law above is broken by at least one of them.
export const brokenVariants: {bug: TaskBug, breaks: string[]}[] = [
  {bug: 'lets anyone ask', breaks: ['only the live claimant asks without a round']},
  {bug: 'lets anyone answer', breaks: ['only the live creator answers']},
  {bug: 'lets anyone fail', breaks: ['only the live claimant fails']},
  {bug: 'requests with rounds already used', breaks: ['a requested task has used no rounds']},
  {bug: 'records the wrong requested agent', breaks: ['a new request records its creator agent and cap without rounds']},
  {bug: 'lets a removed member request', breaks: ['only a live requester makes a held request']},
  {bug: 'refuses every request', breaks: ['a new request records its creator agent and cap without rounds']},
  {bug: 'lets a non-decider approve', breaks: ['only a live decider approves a request in time for its intended agent', 'only the creator or a decider leaves requested except expiry']},
  {bug: 'lets a removed decider approve', breaks: ['only a live decider approves a request in time for its intended agent']},
  {bug: 'approves after the deadline', breaks: ['only a live decider approves a request in time for its intended agent']},
  {bug: 'approves on claim', breaks: ['only a live decider approves a request in time for its intended agent']},
  {bug: 'assigns approval to the decider', breaks: ['only a live decider approves a request in time for its intended agent']},
  {bug: 'counts a round on approve', breaks: ['rounds used never pass the cap']},
  {bug: 'refuses every approval', breaks: ['a live decider can approve a request in time']},
  {bug: 'lets a non-decider decline', breaks: ['only a live decider declines a request']},
  {bug: 'lets a removed decider decline', breaks: ['only a live decider declines a request']},
  {bug: 'refuses every decline', breaks: ['a live decider can decline a request']},
  {bug: 'reopens a declined task', breaks: ['a finished task never changes']},
  {bug: 'expires a request at the round cap', breaks: ['a task expires only at its deadline or round cap']},
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
