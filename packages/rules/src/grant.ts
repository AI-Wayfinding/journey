import {all, bool, nat, no, oneOf, rule, same, when, yes} from 'gdp-wired'

// Grant: one person lets another member use one of their capabilities.
//
// A grant names its grantor, its grantee, a command and a resource (all
// interned by the host to small numbers), and how many uses are left. The host
// keeps one record per grant and steps it with this rule. Expiry is a time, so
// the host compares it with the clock and passes the outcome in as `expired`.
// From the journey and agent card rules it passes in: `actorLive` (the actor
// is a live member), `actorIsAgent`, `actorIsGuide`, `grantorHolds` (the
// grantor holds the capability for this command and resource now, through
// their own role), `fromGrant` (the actor would hold it only through a grant),
// and `grantorLive` and `granteeLive`. The rule never reads artifact content.
//
// Each step is one request: 'issue', 'use', 'revoke', or 'end' (the host ends
// every grant of a person who leaves or is removed, in the same write).
// `used` says whether a use went through.
export const Status = oneOf('unissued', 'live', 'revoked', 'ended')
export const Op = oneOf('issue', 'use', 'revoke', 'end')

export type GrantBug =
  | 'keeps uses after revoking'
  | 'grants to the grantor'
  | 'issues without the capability'
  | 'issues from a grantor who left'
  | 'lets agents issue'
  | 're-delegates'
  | 'uses an expired grant'
  | 'uses past the last use'
  | 'uses after the grantor left'
  | 'lets anyone use it'
  | 'uses it for another resource'
  | 'a use costs nothing'
  | 'a revoked grant comes back'
  | 'reissues over a live grant'
  | 'anyone revokes'
  | 'end does nothing'
  | 'refuses every use'

// The rule, or with `bug` one of its broken variants (kept for the tests).
export const grantRule = (bug?: GrantBug) => rule('grant')
  .inputs({
    op: Op,
    actor: nat,
    grantee: nat,
    command: nat,
    resource: nat,
    uses: nat,
    actorLive: bool,
    actorIsAgent: bool,
    actorIsGuide: bool,
    grantorHolds: bool,
    fromGrant: bool,
    grantorLive: bool,
    granteeLive: bool,
    expired: bool,
  })
  .state({
    status: Status.from('unissued'),
    grantor: 0,
    to: 0,
    forCommand: 0,
    forResource: 0,
    usesLeft: 0,
    used: bool.from(false),
  })
  .flags(({op, actor, grantee, command, resource, uses, actorLive, actorIsAgent, actorIsGuide, grantorHolds, fromGrant,
    grantorLive, granteeLive, expired, status, grantor, to, forCommand, forResource, usesLeft}) => ({
    issues: all(op.is('issue'),
      bug === 'reissues over a live grant' ? status.is('unissued').or(status.is('live')) :
        bug === 'a revoked grant comes back' ? status.is('live').not() : status.is('unissued'),
      bug === 'issues from a grantor who left' ? yes : actorLive,
      bug === 'issues without the capability' ? yes : grantorHolds,
      bug === 're-delegates' ? yes : fromGrant.not(),
      bug === 'lets agents issue' ? yes : actorIsAgent.not(),
      bug === 'grants to the grantor' ? yes : grantee.eq(actor).not(),
      uses.gt(0)),
    usesIt: bug === 'refuses every use' ? no : all(op.is('use'), status.is('live'),
      bug === 'uses an expired grant' ? yes : expired.not(),
      bug === 'uses past the last use' ? yes : usesLeft.gt(0),
      bug === 'lets anyone use it' ? yes : actor.eq(to),
      bug === 'uses it for another resource' ? yes : command.eq(forCommand).and(resource.eq(forResource)),
      bug === 'uses after the grantor left' ? yes : grantorLive.and(grantorHolds),
      granteeLive),
    revokes: all(op.is('revoke'), status.is('live'), actorLive,
      bug === 'anyone revokes' ? yes : actor.eq(grantor).or(actorIsGuide)),
    ends: bug === 'end does nothing' ? no : all(op.is('end'), status.is('live'), grantorLive.not().or(granteeLive.not())),
  }))
  .step(({actor, grantee, command, resource, uses, status, grantor, to, forCommand, forResource, usesLeft, issues, usesIt, revokes, ends}) => ({
    status: when(issues, 'live', when(revokes, 'revoked', when(ends, 'ended', status))),
    grantor: when(issues, actor, grantor),
    to: when(issues, grantee, to),
    forCommand: when(issues, command, forCommand),
    forResource: when(issues, resource, forResource),
    usesLeft: when(issues, uses, when(usesIt, bug === 'a use costs nothing' ? usesLeft : usesLeft.minus(1),
      when(revokes.or(ends), bug === 'keeps uses after revoking' ? usesLeft : 0, usesLeft))),
    used: usesIt,
  }))

export const grant = grantRule()
type Grant = ReturnType<typeof grantRule>

export const grantLaws = (r: Grant = grant) => [
  // Law: only a live grant has uses left. A revoked or ended grant can never be
  // used again, and one not yet issued has nothing to use.
  r.law('a grant that is not live has no uses left', ({status, usesLeft}) => status.is('live').not().implies(usesLeft.eq(0))),
  // Law: nobody holds a grant from themselves.
  r.law('a live grant never names its grantor as grantee', ({status, grantor, to}) => status.is('live').implies(to.eq(grantor).not())),
]

export const grantStepLaws = (r: Grant = grant) => [
  // Step law: a grant is issued only by a live person (not an agent) who holds
  // the capability now through their own role.
  r.stepLaw('a grant is issued only by a live person who holds the capability',
    ({actorLive, actorIsAgent, grantorHolds}, after) => after.status.is('live').implies(all(actorLive, actorIsAgent.not(), grantorHolds)),
    ({status}) => status.is('unissued'),
  ),
  // Step law: re-delegation is not allowed. Someone who holds a capability only
  // through a grant cannot pass it on in a new grant.
  r.stepLaw('a capability held only through a grant is never granted on',
    ({fromGrant}, after) => after.status.is('live').implies(fromGrant.not()),
    ({status}) => status.is('unissued')),
  // Step law: a use goes through only for the grantee, for the grant's own
  // command and resource, before expiry, with a use left, and while the grantor
  // still holds the capability and both people are live.
  r.stepLaw('a use goes through only for the live grantee, on its command and resource, unexpired, with uses left',
    ({actor, command, resource, status, to, forCommand, forResource, usesLeft, expired, grantorLive, grantorHolds, granteeLive}, after) =>
      after.used.implies(all(status.is('live'), actor.eq(to), command.eq(forCommand), resource.eq(forResource),
        expired.not(), usesLeft.gt(0), grantorLive, grantorHolds, granteeLive))),
  // Step law: each use takes exactly one use off the grant.
  r.stepLaw('each use takes exactly one use',
    ({usesLeft}, after) => after.usesLeft.plus(1).eq(usesLeft),
    ({usesIt}) => usesIt,
  ),
  // Step law: revocation and ending are final. A revoked or ended grant never
  // changes again and is never used.
  r.stepLaw('a revoked or ended grant never comes back',
    ({status}, after) => same(after.status, status).and(after.used.not()),
    ({status}) => status.is('revoked').or(status.is('ended'))),
  // Step law: once issued, a grant always names the same grantor, grantee,
  // command and resource.
  r.stepLaw('an issued grant never changes who, what or where',
    ({grantor, to, forCommand, forResource}, after) =>
      all(after.grantor.eq(grantor), after.to.eq(to), after.forCommand.eq(forCommand), after.forResource.eq(forResource)),
    ({status}) => status.is('unissued').not()),
  // Step law: only the live grantor or a live guide revokes a grant.
  r.stepLaw('only the grantor or a guide revokes',
    ({actor, grantor, actorIsGuide, actorLive}, after) => after.status.is('revoked').implies(actorLive.and(actor.eq(grantor).or(actorIsGuide))),
    ({status}) => status.is('live')),
  // Step law: when the grantor or the grantee is no longer a member, the host's
  // 'end' request ends the grant.
  r.stepLaw('a grant ends when its grantor or grantee is gone',
    (_, after) => after.status.is('ended').and(after.usesLeft.eq(0)),
    ({op, status, grantorLive, granteeLive}) => all(op.is('end'), status.is('live'), grantorLive.not().or(granteeLive.not()))),
  // Step law: a use that meets every condition goes through.
  r.stepLaw('a use that meets every condition goes through',
    (_, after) => after.used,
    ({op, actor, command, resource, status, to, forCommand, forResource, usesLeft, expired, grantorLive, grantorHolds, granteeLive}) =>
      all(op.is('use'), status.is('live'), actor.eq(to), command.eq(forCommand), resource.eq(forResource),
        expired.not(), usesLeft.gt(0), grantorLive, grantorHolds, granteeLive)),
]

export const laws = grantLaws()
export const stepLaws = grantStepLaws()

// Each broken variant and the laws it must break. The tests assert every one
// is refused, and that every law above is broken by at least one of them.
const issued = 'a grant is issued only by a live person who holds the capability'
const useOnly = 'a use goes through only for the live grantee, on its command and resource, unexpired, with uses left'
export const brokenVariants: {bug: GrantBug, breaks: string[]}[] = [
  {bug: 'keeps uses after revoking', breaks: ['a grant that is not live has no uses left']},
  {bug: 'grants to the grantor', breaks: ['a live grant never names its grantor as grantee']},
  {bug: 'issues without the capability', breaks: [issued]},
  {bug: 'issues from a grantor who left', breaks: [issued]},
  {bug: 'lets agents issue', breaks: [issued]},
  {bug: 're-delegates', breaks: ['a capability held only through a grant is never granted on']},
  {bug: 'uses an expired grant', breaks: [useOnly]},
  {bug: 'uses past the last use', breaks: [useOnly]},
  {bug: 'uses after the grantor left', breaks: [useOnly]},
  {bug: 'lets anyone use it', breaks: [useOnly]},
  {bug: 'uses it for another resource', breaks: [useOnly]},
  {bug: 'a use costs nothing', breaks: ['each use takes exactly one use']},
  {bug: 'a revoked grant comes back', breaks: ['a revoked or ended grant never comes back']},
  {bug: 'reissues over a live grant', breaks: ['an issued grant never changes who, what or where']},
  {bug: 'anyone revokes', breaks: ['only the grantor or a guide revokes']},
  {bug: 'end does nothing', breaks: ['a grant ends when its grantor or grantee is gone']},
  {bug: 'refuses every use', breaks: ['a use that meets every condition goes through']},
]
