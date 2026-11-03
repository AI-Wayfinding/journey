import {all, bool, forall, no, oneOf, rule, same, when, yes, nat} from 'gdp-wired'

// Project: one project inside a journey. Journey members join a project to
// work on it together; project members edit its purpose and move it between
// the states getting started, active, looking for others and archived. An
// archived project is closed to new members and purpose edits until one of its
// members reopens it.
//
// The rule reads only coordination state. The host interns every person and
// agent to a small integer, checks that the actor is a live member of the
// journey (`actorIsLive`), and keeps the purpose text itself; the rule counts
// accepted purpose edits (`purposeEdits`) so the host can tell an accepted edit
// from a refused one.
//
// Inputs: `op` what is asked; `actor` who asks; `actorIsLive` whether the host
// found the actor a live journey member; `to` the state asked for by setStatus.
// State: `exists` whether the project was created; `status` its state;
// `purposeEdits` accepted purpose edits; `Members` who is in the project.
export const Status = oneOf('gettingStarted', 'active', 'lookingForOthers', 'archived')

export type ProjectBug =
  | 'lets people join before the project exists'
  | 'lets the last member leave'
  | 'lets a non-member edit the purpose'
  | 'lets a non-member change the state'
  | 'edits an archived project'
  | 'changes another person\'s membership'
  | 'lets someone who is not live join'
  | 'uncreates a project'
  | 'counts a purpose edit twice'
  | 'keeps archived projects closed for good'
  | 'refuses every join'
  | 'refuses every leave'
  | 'refuses to create'

// The rule, or with `bug` one of its broken variants (kept for the tests).
export const projectRule = (bug?: ProjectBug) => rule('project')
  .inputs({op: oneOf('create', 'join', 'leave', 'setPurpose', 'setStatus'), actor: nat, actorIsLive: bool, to: Status})
  .state({exists: bool.from(false), status: Status.from('gettingStarted'), purposeEdits: 0})
  .maps({Members: bool.from(false)})
  .flags(({op, actor, actorIsLive, to, exists, status, Members}) => {
    const member = Members.at(actor)
    const open = status.is('archived').not()
    const headcount = Members.sum(c => when(c, 1, 0))
    return {
      creates: bug === 'refuses to create' ? no : all(op.is('create'), exists.not(), actorIsLive),
      joins: bug === 'refuses every join' ? no : all(op.is('join'),
        bug === 'lets people join before the project exists' ? yes : exists,
        bug === 'lets someone who is not live join' ? yes : actorIsLive,
        member.not(), open),
      leaves: bug === 'refuses every leave' ? no : all(op.is('leave'), exists, member,
        bug === 'lets the last member leave' ? yes : headcount.gt(1)),
      edits: all(op.is('setPurpose'), exists, actorIsLive,
        bug === 'lets a non-member edit the purpose' ? yes : member,
        bug === 'edits an archived project' ? yes : open),
      moves: all(op.is('setStatus'), exists, actorIsLive,
        bug === 'lets a non-member change the state' ? yes : member,
        bug === 'keeps archived projects closed for good' ? open : yes),
      uncreates: bug === 'uncreates a project' ? op.is('leave').and(exists, member, headcount.atMost(1)) : no,
    }
  })
  .step(({actor, to, exists, status, purposeEdits, Members, creates, joins, leaves, edits, moves, uncreates}) => ({
    exists: when(uncreates, no, exists.or(creates)),
    status: when(creates, 'gettingStarted', when(moves, to, status)),
    purposeEdits: when(edits, purposeEdits.plus(bug === 'counts a purpose edit twice' ? 2 : 1), purposeEdits),
    Members: bug === 'changes another person\'s membership'
      ? Members.each(k => when(k.eq(actor), when(creates.or(joins), yes, when(leaves.or(uncreates), no, Members.at(actor))), when(leaves, no, Members.at(k))))
      : Members.set(actor, when(creates.or(joins), yes, when(leaves.or(uncreates), no, Members.at(actor)))),
  }))

export const project = projectRule()
type Project = ReturnType<typeof projectRule>

const headcount = (Members: Parameters<Parameters<Project['law']>[1]>[0]['Members']) => Members.sum(c => when(c, 1, 0))

export const projectLaws = (r: Project = project) => [
  // Law: before a project is created nobody is in it, nobody has edited its
  // purpose, and it is getting started.
  r.law('a project not yet created is empty and getting started', ({exists, status, purposeEdits, Members}) =>
    forall(k => exists.not().implies(all(Members.at(k).not(), purposeEdits.eq(0), status.is('gettingStarted'))))),
  // Law: a project that exists always has at least one member, so someone can
  // always edit or reopen it.
  r.law('a created project always has a member', ({exists, Members}) =>
    exists.implies(headcount(Members).atLeast(1))),
]

export const projectStepLaws = (r: Project = project) => [
  // Step law: once a project is created it stays created.
  r.stepLaw('a created project stays created', ({exists}, after) => exists.implies(after.exists)),
  // Step law: the purpose changes only when a live member of the project edits it.
  r.stepLaw('only a live project member edits the purpose', ({purposeEdits, actorIsLive, actor, Members}, after) =>
    after.purposeEdits.eq(purposeEdits).or(actorIsLive.and(Members.at(actor)))),
  // Step law: each accepted purpose edit counts once.
  r.stepLaw('a purpose edit counts once', ({purposeEdits}, after) =>
    after.purposeEdits.atLeast(purposeEdits).and(after.purposeEdits.atMost(purposeEdits.plus(1)))),
  // Step law: the state of a created project changes only when a live member of
  // the project changes it.
  r.stepLaw('only a live project member changes the state', ({exists, status, actorIsLive, actor, Members}, after) =>
    exists.implies(same(after.status, status).or(actorIsLive.and(Members.at(actor))))),
  // Step law: while a project is archived its purpose is not edited and nobody
  // new joins it.
  r.stepLaw('an archived project takes no purpose edits and no new members', ({status, purposeEdits, Members}, after) =>
    forall(k => status.is('archived').implies(after.purposeEdits.eq(purposeEdits).and(after.Members.at(k).implies(Members.at(k)))))),
  // Step law: a request changes only the asking person's own membership; nobody
  // adds or removes someone else.
  r.stepLaw('only the actor\'s own membership changes', ({actor, Members}, after) =>
    forall(k => k.eq(actor).not().implies(same(after.Members.at(k), Members.at(k))))),
  // Step law: only a live journey member joins a project.
  r.stepLaw('only a live journey member joins', ({actor, actorIsLive, Members}, after) =>
    Members.at(actor).not().and(after.Members.at(actor)).implies(actorIsLive)),
  // Step law: a live journey member can join a created project that is not archived.
  r.stepLaw('a live journey member can join an open project', ({actor}, after) => after.Members.at(actor),
    ({op, exists, status, actorIsLive}) => all(op.is('join'), exists, actorIsLive, status.is('archived').not())),
  // Step law: a member can leave while someone else stays in the project.
  r.stepLaw('a member can leave while others stay', ({actor}, after) => after.Members.at(actor).not(),
    ({op, exists, actor, Members}) => all(op.is('leave'), exists, Members.at(actor), headcount(Members).gt(1))),
  // Step law: a live journey member can create a project that does not exist yet,
  // and becomes its first member.
  r.stepLaw('creating a project makes the creator its first member', ({actor}, after) =>
    all(after.exists, after.Members.at(actor), after.status.is('gettingStarted')),
    ({op, exists, actorIsLive}) => all(op.is('create'), exists.not(), actorIsLive)),
  // Step law: a live member can reopen an archived project by moving it to any
  // other state.
  r.stepLaw('a live member can reopen an archived project', ({to}, after) => same(after.status, to),
    ({op, exists, actorIsLive, actor, Members, status, to}) =>
      all(op.is('setStatus'), exists, actorIsLive, Members.at(actor), status.is('archived'), to.is('archived').not())),
]

export const laws = projectLaws()
export const stepLaws = projectStepLaws()

// Each broken variant and the laws it must break. The tests assert every one
// is refused, and that every law above is broken by at least one of them.
export const brokenVariants: {bug: ProjectBug, breaks: string[]}[] = [
  {bug: 'lets people join before the project exists', breaks: ['a project not yet created is empty and getting started']},
  {bug: 'lets the last member leave', breaks: ['a created project always has a member']},
  {bug: 'uncreates a project', breaks: ['a created project stays created']},
  {bug: 'lets a non-member edit the purpose', breaks: ['only a live project member edits the purpose']},
  {bug: 'counts a purpose edit twice', breaks: ['a purpose edit counts once']},
  {bug: 'lets a non-member change the state', breaks: ['only a live project member changes the state']},
  {bug: 'edits an archived project', breaks: ['an archived project takes no purpose edits and no new members']},
  {bug: 'changes another person\'s membership', breaks: ['only the actor\'s own membership changes']},
  {bug: 'lets someone who is not live join', breaks: ['only a live journey member joins']},
  {bug: 'refuses every join', breaks: ['a live journey member can join an open project']},
  {bug: 'refuses every leave', breaks: ['a member can leave while others stay']},
  {bug: 'refuses to create', breaks: ['creating a project makes the creator its first member']},
  {bug: 'keeps archived projects closed for good', breaks: ['a live member can reopen an archived project']},
]
