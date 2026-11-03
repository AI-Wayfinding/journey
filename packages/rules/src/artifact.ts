import {all, bool, nat, no, oneOf, rule, same, when, yes} from 'gdp-wired'

// Artifact: the coordination record of one shared artifact in a journey. It
// holds metadata only: whether the artifact exists, who created it, its type,
// its version number and how many times it was renamed. The rule never reads
// the artifact's content or its name; the host keeps both (content encrypted,
// in stage 3) and steps this rule before writing them.
//
// The host interns people, agents and artifact types to small integers and
// checks that the actor is a live journey member with write authority
// (`actorHasWrite`) before stepping. A new version names the version it was
// written on top of (`baseVersion`), so two writers cannot both build on the
// same version and lose one of the edits.
//
// Inputs: `op` what is asked; `actor` who asks; `actorHasWrite` the host's
// check; `type` the type given at create; `baseVersion` the version a new
// version builds on.
// State: `at` none (not created yet), live or deleted; `creator`;
// `artifactType`; `version` (1 at create); `renames` accepted renames.
export const At = oneOf('none', 'live', 'deleted')

export type ArtifactBug =
  | 'starts at version 0'
  | 'versions an artifact never created'
  | 'lets a new version change the creator'
  | 'lets a new version change the type'
  | 'restarts the version number on rename'
  | 'skips version numbers'
  | 'builds on an old version'
  | 'undeletes an artifact'
  | 'lets a reader write'
  | 'records someone else as creator'
  | 'bumps the version on rename'
  | 'refuses every create'
  | 'refuses every new version'
  | 'refuses every rename'
  | 'refuses every delete'

// The rule, or with `bug` one of its broken variants (kept for the tests).
export const artifactRule = (bug?: ArtifactBug) => rule('artifact')
  .inputs({op: oneOf('create', 'version', 'rename', 'delete'), actor: nat, actorHasWrite: bool, type: nat, baseVersion: nat})
  .state({at: At.from('none'), creator: 0, artifactType: 0, version: 0, renames: 0})
  .flags(({op, actorHasWrite, baseVersion, at, version}) => {
    const writer = bug === 'lets a reader write' ? yes : actorHasWrite
    return {
      creates: bug === 'refuses every create' ? no : all(op.is('create'), at.is('none'), writer),
      versions: bug === 'refuses every new version' ? no : all(op.is('version'),
        bug === 'versions an artifact never created' ? at.is('deleted').not() : at.is('live'), writer,
        bug === 'builds on an old version' ? baseVersion.atMost(version) : baseVersion.eq(version)),
      renamed: bug === 'refuses every rename' ? no : all(op.is('rename'), at.is('live'), writer),
      deletes: bug === 'refuses every delete' ? no : all(op.is('delete'), at.is('live'), writer),
      undeletes: bug === 'undeletes an artifact' ? op.is('create').and(at.is('deleted'), writer) : no,
    }
  })
  .step(({actor, type, at, creator, artifactType, version, renames, creates, versions, renamed, deletes, undeletes}) => ({
    at: when(creates.or(undeletes), 'live', when(deletes, 'deleted', at)),
    creator: when(creates, bug === 'records someone else as creator' ? actor.plus(1) : actor,
      when(versions.and(bug === 'lets a new version change the creator' ? yes : no), actor, creator)),
    artifactType: when(creates, type, when(versions.and(bug === 'lets a new version change the type' ? yes : no), type, artifactType)),
    version: when(creates, bug === 'starts at version 0' ? 0 : 1,
      when(versions, bug === 'skips version numbers' ? version.plus(2) : version.plus(1),
        when(renamed.and(bug === 'bumps the version on rename' ? yes : no), version.plus(1),
          when(renamed.and(bug === 'restarts the version number on rename' ? yes : no), 1, version)))),
    renames: when(renamed, renames.plus(1), renames),
  }))

export const artifact = artifactRule()
type Artifact = ReturnType<typeof artifactRule>

export const artifactLaws = (r: Artifact = artifact) => [
  // Law: an artifact that has not been created yet has no creator, no type, no
  // versions and no renames.
  r.law('an artifact not yet created has no history', ({at, creator, artifactType, version, renames}) =>
    at.is('none').implies(all(creator.eq(0), artifactType.eq(0), version.eq(0), renames.eq(0)))),
  // Law: an artifact that was created has at least its first version, number 1.
  r.law('a created artifact has at least version 1', ({at, version}) => at.is('none').not().implies(version.atLeast(1))),
]

export const artifactStepLaws = (r: Artifact = artifact) => [
  // Step law: whoever created an artifact stays its creator; no later action
  // changes it.
  r.stepLaw('the creator never changes', ({at, creator}, after) => at.is('none').not().implies(after.creator.eq(creator))),
  // Step law: an artifact keeps the type it was created with.
  r.stepLaw('the type never changes', ({at, artifactType}, after) => at.is('none').not().implies(after.artifactType.eq(artifactType))),
  // Step law: version numbers only go up, and by one at a time, so every
  // version has a number and no number is skipped.
  r.stepLaw('version numbers only go up, one at a time', ({version}, after) =>
    after.version.atLeast(version).and(after.version.atMost(version.plus(1)))),
  // Step law: a new version is accepted only when it was written on top of the
  // latest version, so no one's edit is silently lost.
  r.stepLaw('a new version builds on the latest one', ({at, version, baseVersion}, after) =>
    at.is('live').and(after.version.gt(version)).implies(baseVersion.eq(version))),
  // Step law: a deleted artifact stays deleted, and nothing about it changes.
  r.stepLaw('a deleted artifact stays deleted and unchanged', ({at, creator, artifactType, version, renames}, after) =>
    at.is('deleted').implies(all(after.at.is('deleted'), after.creator.eq(creator), after.artifactType.eq(artifactType),
      after.version.eq(version), after.renames.eq(renames)))),
  // Step law: someone without write authority changes nothing.
  r.stepLaw('only a member with write authority changes an artifact', ({at, creator, artifactType, version, renames}, after) =>
    all(same(after.at, at), after.creator.eq(creator), after.artifactType.eq(artifactType), after.version.eq(version), after.renames.eq(renames)),
    ({actorHasWrite}) => actorHasWrite.not()),
  // Step law: creating an artifact records the person or agent who created it,
  // the type they gave, and version 1.
  r.stepLaw('creating records the creator, the type and version 1', ({actor, type}, after) =>
    all(after.at.is('live'), after.creator.eq(actor), after.artifactType.eq(type), after.version.eq(1)),
    ({op, at, actorHasWrite}) => all(op.is('create'), at.is('none'), actorHasWrite)),
  // Step law: a rename changes the name only, never the version.
  r.stepLaw('a rename does not change the version', ({version}, after) => after.version.eq(version), ({op}) => op.is('rename')),
  // Step law: a member with write authority can add a new version on top of the
  // latest one.
  r.stepLaw('a writer can add a version on top of the latest', ({version}, after) => after.version.eq(version.plus(1)),
    ({op, at, actorHasWrite, baseVersion, version}) => all(op.is('version'), at.is('live'), actorHasWrite, baseVersion.eq(version))),
  // Step law: a member with write authority can rename a live artifact.
  r.stepLaw('a writer can rename a live artifact', ({renames}, after) => after.renames.eq(renames.plus(1)),
    ({op, at, actorHasWrite}) => all(op.is('rename'), at.is('live'), actorHasWrite)),
  // Step law: a member with write authority can delete a live artifact.
  r.stepLaw('a writer can delete a live artifact', (_, after) => after.at.is('deleted'),
    ({op, at, actorHasWrite}) => all(op.is('delete'), at.is('live'), actorHasWrite)),
]

export const laws = artifactLaws()
export const stepLaws = artifactStepLaws()

// Each broken variant and the laws it must break. The tests assert every one
// is refused, and that every law above is broken by at least one of them.
export const brokenVariants: {bug: ArtifactBug, breaks: string[]}[] = [
  {bug: 'versions an artifact never created', breaks: ['an artifact not yet created has no history']},
  {bug: 'starts at version 0', breaks: ['a created artifact has at least version 1']},
  {bug: 'lets a new version change the creator', breaks: ['the creator never changes']},
  {bug: 'lets a new version change the type', breaks: ['the type never changes']},
  {bug: 'restarts the version number on rename', breaks: ['version numbers only go up, one at a time']},
  {bug: 'skips version numbers', breaks: ['version numbers only go up, one at a time']},
  {bug: 'builds on an old version', breaks: ['a new version builds on the latest one']},
  {bug: 'undeletes an artifact', breaks: ['a deleted artifact stays deleted and unchanged']},
  {bug: 'lets a reader write', breaks: ['only a member with write authority changes an artifact']},
  {bug: 'records someone else as creator', breaks: ['creating records the creator, the type and version 1']},
  {bug: 'bumps the version on rename', breaks: ['a rename does not change the version']},
  {bug: 'refuses every new version', breaks: ['a writer can add a version on top of the latest']},
  {bug: 'refuses every rename', breaks: ['a writer can rename a live artifact']},
  {bug: 'refuses every delete', breaks: ['a writer can delete a live artifact']},
  {bug: 'refuses every create', breaks: ['creating records the creator, the type and version 1']},
]
