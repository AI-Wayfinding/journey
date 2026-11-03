import {all, bool, nat, no, oneOf, rule, same, when, yes} from 'gdp-wired'

// One library item. Text, labels, description, URLs and storage stay in the
// host. actor is the authenticated person even when their agent acts;
// ownerAgent is the host's live ownership check. canWrite/canRead/guide already
// include live membership and the acting agent's effective capability.
export const Kind = oneOf('markdown', 'html', 'pdf', 'code', 'image', 'video', 'audio', 'data', 'link', 'skill', 'prompt', 'agent', 'applet', 'other')
export const Visibility = oneOf('members', 'private')
export const At = oneOf('none', 'live', 'deleted')
export type ItemBug = 'version zero' | 'owner' | 'kind' | 'base' | 'writer' | 'delete' | 'visibility' | 'privacy' | 'revive' | 'refuse create' | 'refuse version' | 'refuse delete' | 'refuse visibility' | 'refuse update' | 'metadata'
export const itemRule = (bug?: ItemBug) => rule('item')
  .inputs({op: oneOf('create', 'version', 'update', 'visibility', 'delete', 'read'), actor: nat,
    canWrite: bool, canRead: bool, guide: bool, ownerAgent: bool, newKind: Kind,
    newVisibility: Visibility, newProject: nat, baseVersion: nat})
  .state({at: At.from('none'), owner: 0, kind: Kind.from('other'), visibility: Visibility.from('members'), project: 0, version: 0, edits: 0, allowed: bool.from(false)})
  .flags(({op, at, actor, owner, ownerAgent, canWrite, canRead, guide, baseVersion, version, visibility}) => {
    const owns = actor.eq(owner).or(ownerAgent)
    const live = at.is('live')
    return {
      creates: bug === 'refuse create' ? no : all(op.is('create'), bug === 'revive' ? at.is('live').not() : at.is('none'), canWrite),
      versions: bug === 'refuse version' ? no : all(op.is('version'), live, bug === 'writer' ? yes : canWrite, bug === 'base' ? yes : baseVersion.eq(version)),
      updates: all(op.is('update'), bug === 'refuse update' ? no : yes, live, bug === 'metadata' ? yes : canWrite),
      setsVisibility: bug === 'refuse visibility' ? no : all(op.is('visibility'), live, canRead, bug === 'visibility' ? yes : owns),
      deletes: bug === 'refuse delete' ? no : all(op.is('delete'), live, canRead, bug === 'delete' ? yes : owns.or(guide)),
      reads: all(op.is('read'), live, canRead, bug === 'privacy' ? yes : visibility.is('members').or(owns)),
    }
  })
  .step(({actor, newKind, newVisibility, newProject, at, owner, kind, visibility, project, version, edits,
    creates, versions, updates, setsVisibility, deletes, reads}) => ({
    at: when(creates, 'live', when(deletes, 'deleted', at)),
    owner: when(creates.or(bug === 'owner' ? versions : no), actor, owner),
    kind: when(creates.or(bug === 'kind' ? versions : no), newKind, kind),
    visibility: when(creates.or(setsVisibility), newVisibility, visibility),
    project: when(creates.or(updates), newProject, project),
    version: when(creates, bug === 'version zero' ? 0 : 1, when(versions, version.plus(1), version)),
    edits: when(updates, edits.plus(1), edits),
    allowed: reads,
  }))
export const item = itemRule()
type Item = ReturnType<typeof itemRule>
export const itemLaws = (r: Item = item) => [
  // Created items always retain at least their initial version.
  r.law('a created item has a first version', ({at, version}) => at.is('none').not().implies(version.atLeast(1))),
]
export const itemStepLaws = (r: Item = item) => [
  // Ownership and kind are fixed at creation.
  r.stepLaw('owner and kind never change after creation', ({at, owner, kind}, a) => at.is('none').not().implies(a.owner.eq(owner).and(same(a.kind, kind)))),
  // A version requires live write authority and the exact current base.
  r.stepLaw('versions require a writer and the current base', ({at, version, baseVersion, canWrite}, a) => at.is('live').and(a.version.gt(version)).implies(canWrite.and(baseVersion.eq(version)))),
  // An unrelated member cannot delete another person's item.
  r.stepLaw('only owner or guide deletes', ({actor, owner, ownerAgent, guide, at}, a) => at.is('live').and(a.at.is('deleted')).implies(actor.eq(owner).or(ownerAgent, guide))),
  // Only the owner or their authenticated agent sets visibility.
  r.stepLaw('only owner changes visibility', ({at, visibility, actor, owner, ownerAgent}, a) => at.is('none').not().and(same(a.visibility, visibility).not()).implies(actor.eq(owner).or(ownerAgent))),
  // A read check returns the exact visibility decision, including owner agents.
  r.stepLaw('private items are readable only by their owner', ({at, canRead, visibility, actor, owner, ownerAgent}, a) =>
    a.allowed.iff(all(at.is('live'), canRead, visibility.is('members').or(actor.eq(owner), ownerAgent))), ({op}) => op.is('read')),
  // Deletion is permanent and leaves metadata and content history unchanged.
  r.stepLaw('deleted items stay deleted and unchanged', ({at, owner, kind, visibility, project, version, edits}, a) => at.is('deleted').implies(
    all(a.at.is('deleted'), a.owner.eq(owner), same(a.kind, kind), same(a.visibility, visibility), a.project.eq(project), a.version.eq(version), a.edits.eq(edits)))),
  // A writer can create the requested item with themselves as owner.
  r.stepLaw('a writer creates the requested item', ({actor, newKind: kind, newVisibility: visibility, newProject: project}, a) => all(a.at.is('live'), a.owner.eq(actor), same(a.kind, kind), same(a.visibility, visibility), a.project.eq(project), a.version.eq(1)),
    ({op, at, canWrite}) => all(op.is('create'), at.is('none'), canWrite)),
  // A current-base writer can append exactly one version.
  r.stepLaw('a current base writer appends one version', ({version}, a) => a.version.eq(version.plus(1)),
    ({op, at, canWrite, baseVersion, version}) => all(op.is('version'), at.is('live'), canWrite, baseVersion.eq(version))),
  // Authorized deletion always takes effect, even for a guide who is not owner.
  r.stepLaw('an owner or guide can delete', (_, a) => a.at.is('deleted'),
    ({op, at, canRead, actor, owner, ownerAgent, guide}) => all(op.is('delete'), at.is('live'), canRead, actor.eq(owner).or(ownerAgent, guide))),
  // The owner can choose either visibility on a live item.
  r.stepLaw('an owner can set visibility', ({newVisibility: requested}, a) => same(a.visibility, requested),
    ({op, at, canRead, actor, owner, ownerAgent}) => all(op.is('visibility'), at.is('live'), canRead, actor.eq(owner).or(ownerAgent))),
  // Metadata edits require a writer; the host uses edits as its acceptance receipt.
  r.stepLaw('only a writer updates metadata', ({edits, project, canWrite, at}, a) => at.is('live').and(a.edits.ne(edits).or(a.project.ne(project))).implies(canWrite)),
  // A writer can update metadata with one receipt and no content version bump.
  r.stepLaw('a writer can update metadata without changing versions', ({edits, newProject, version}, a) => all(a.edits.eq(edits.plus(1)), a.project.eq(newProject), a.version.eq(version)),
    ({op, at, canWrite}) => all(op.is('update'), at.is('live'), canWrite)),
]
export const laws = itemLaws()
export const stepLaws = itemStepLaws()
export const brokenVariants: {bug: ItemBug, breaks: string[]}[] = [
  {bug: 'version zero', breaks: ['a created item has a first version']},
  {bug: 'owner', breaks: ['owner and kind never change after creation']},
  {bug: 'kind', breaks: ['owner and kind never change after creation']},
  {bug: 'base', breaks: ['versions require a writer and the current base']},
  {bug: 'writer', breaks: ['versions require a writer and the current base']},
  {bug: 'delete', breaks: ['only owner or guide deletes']},
  {bug: 'visibility', breaks: ['only owner changes visibility']},
  {bug: 'privacy', breaks: ['private items are readable only by their owner']},
  {bug: 'revive', breaks: ['deleted items stay deleted and unchanged']},
  {bug: 'refuse create', breaks: ['a writer creates the requested item']},
  {bug: 'refuse version', breaks: ['a current base writer appends one version']},
  {bug: 'refuse delete', breaks: ['an owner or guide can delete']},
  {bug: 'refuse visibility', breaks: ['an owner can set visibility']},
  {bug: 'metadata', breaks: ['only a writer updates metadata']},
  {bug: 'refuse update', breaks: ['a writer can update metadata without changing versions']},
]
