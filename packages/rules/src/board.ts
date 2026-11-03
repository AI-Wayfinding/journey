import {all, bool, no, oneOf, rule, when, yes, nat} from 'gdp-wired'

// One board. The host keeps names and steps before persisting a rename;
// edits counts accepted renames. guide includes live membership and the
// board.manage card capability. Archived boards can be reopened by a guide.
export type BoardBug = 'authority' | 'before create' | 'refuse create' | 'refuse rename' | 'refuse archive'
export const boardRule = (bug?: BoardBug) => rule('board')
  .inputs({op: oneOf('create', 'rename', 'archive'), actor: nat, guide: bool, newArchived: bool})
  .state({exists: bool.from(false), archived: bool.from(false), edits: 0})
  .flags(({op, guide, exists}) => ({
    creates: bug === 'refuse create' ? no : all(op.is('create'), exists.not(), bug === 'authority' ? yes : guide),
    renames: bug === 'refuse rename' ? no : all(op.is('rename'), bug === 'before create' ? yes : exists, bug === 'authority' ? yes : guide),
    archives: bug === 'refuse archive' ? no : all(op.is('archive'), exists, bug === 'authority' ? yes : guide),
  }))
  .step(({newArchived: requested, exists, archived, edits, creates, renames, archives}) => ({
    exists: exists.or(creates), archived: when(archives, requested, archived), edits: when(renames, edits.plus(1), edits),
  }))
export const board = boardRule()
type Board = ReturnType<typeof boardRule>
export const boardLaws = (r: Board = board) => [
  // A board has no edit history until a guide creates it.
  r.law('an uncreated board has no edits', ({exists, edits}) => exists.not().implies(edits.eq(0))),
]
export const boardStepLaws = (r: Board = board) => [
  // A non-guide cannot create, rename or archive a board.
  r.stepLaw('only guides manage boards', ({exists, archived, edits, guide}, a) => guide.not().implies(
    all(a.exists.iff(exists), a.archived.iff(archived), a.edits.eq(edits)))),
  // An authorized creation succeeds rather than silently doing nothing.
  r.stepLaw('a guide can create a board', (_, a) => a.exists, ({op, exists, guide}) => all(op.is('create'), exists.not(), guide)),
  // An authorized rename yields one receipt for the host's metadata write.
  r.stepLaw('a guide can rename a board', ({edits}, a) => a.edits.eq(edits.plus(1)), ({op, exists, guide}) => all(op.is('rename'), exists, guide)),
  // A guide can archive and reopen a created board.
  r.stepLaw('a guide can choose board archive state', ({newArchived: requested}, a) => a.archived.iff(requested), ({op, exists, guide}) => all(op.is('archive'), exists, guide)),
]
export const laws = boardLaws()
export const stepLaws = boardStepLaws()
export const brokenVariants: {bug: BoardBug, breaks: string[]}[] = [
  {bug: 'before create', breaks: ['an uncreated board has no edits']},
  {bug: 'authority', breaks: ['only guides manage boards']},
  {bug: 'refuse create', breaks: ['a guide can create a board']},
  {bug: 'refuse rename', breaks: ['a guide can rename a board']},
  {bug: 'refuse archive', breaks: ['a guide can choose board archive state']},
]
