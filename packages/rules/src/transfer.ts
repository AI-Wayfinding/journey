import {all, bool, no, oneOf, rule, same, when, yes} from 'gdp-wired'

// Transfer: copying or moving one artifact between two groups (a personal
// group and a journey, or two journeys). The local proxy does the work:
// decrypt with the source group's key, re-encrypt for the destination, and for
// a move delete the source. Before it starts, it keeps one transfer record and
// steps it once with this rule; the outcome says what it may do.
//
// The host works out each fact from the other rules and passes it in:
// `liveInSource` and `liveInDestination` (the actor is a live member of each
// group), `readsSource` (the actor may read in the source), `writesDestination`
// (the actor may write in the destination) and `deletesSource` (the actor may
// delete this artifact in the source). The rule never reads artifact content.
//
// State: `outcome` is pending until the request is decided, then copied,
// moved or refused for good.
export const Outcome = oneOf('pending', 'copied', 'moved', 'refused')

export type TransferBug =
  | 'skips liveness in the source'
  | 'skips the write check'
  | 'skips liveness in the destination'
  | 'skips the read check'
  | 'moves without delete permission'
  | 'turns a refused move into a copy'
  | 'carries out a copy as a move'
  | 'decides again'
  | 'refuses every copy'
  | 'refuses every move'

// The rule, or with `bug` one of its broken variants (kept for the tests).
export const transferRule = (bug?: TransferBug) => rule('transfer')
  .inputs({
    op: oneOf('copy', 'move'),
    liveInSource: bool,
    liveInDestination: bool,
    readsSource: bool,
    writesDestination: bool,
    deletesSource: bool,
  })
  .state({outcome: Outcome.from('pending')})
  .flags(({op, outcome, liveInSource, liveInDestination, readsSource, writesDestination, deletesSource}) => {
    // A copy needs the actor live in both groups, read in the source and write in the destination.
    const copyOk = all(
      bug === 'skips liveness in the source' ? yes : liveInSource,
      bug === 'skips liveness in the destination' ? yes : liveInDestination,
      bug === 'skips the read check' ? yes : readsSource,
      bug === 'skips the write check' ? yes : writesDestination,
    )
    // A move is a copy that may also delete from the source.
    const moveOk = copyOk.and(bug === 'moves without delete permission' ? yes : deletesSource)
    const deciding = bug === 'decides again' ? yes : outcome.is('pending')
    return {
      deciding,
      copies: deciding.and(
        op.is('copy').and(bug === 'refuses every copy' ? no : copyOk)
          .or(bug === 'turns a refused move into a copy' ? op.is('move').and(copyOk, deletesSource.not()) : no),
      ),
      moves: deciding.and(
        op.is('move').and(bug === 'refuses every move' ? no : moveOk)
          .or(bug === 'carries out a copy as a move' ? op.is('copy').and(copyOk) : no),
      ),
    }
  })
  .step(({deciding, copies, moves, outcome}) => ({
    outcome: when(moves, 'moved', when(copies, 'copied', when(deciding, 'refused', outcome))),
  }))

export const transfer = transferRule()
type Transfer = ReturnType<typeof transferRule>

// Transfer keeps no invariant beyond its outcome being one of the four, which
// gdp-wired proves on its own (the kind's law). Everything else is a step law.
export const transferLaws = (_r: Transfer = transfer) => []

export const transferStepLaws = (r: Transfer = transfer) => [
  // Step law: a copy or move goes through only when the actor is a live member
  // of both the source and the destination group.
  r.stepLaw('a transfer goes through only when the actor is live in both groups',
    ({liveInSource, liveInDestination}, after) =>
      after.outcome.is('copied').or(after.outcome.is('moved')).implies(liveInSource.and(liveInDestination)),
    ({outcome}) => outcome.is('pending')),
  // Step law: a copy or move goes through only when the actor may read in the
  // source and write in the destination.
  r.stepLaw('a transfer goes through only with read in the source and write in the destination',
    ({readsSource, writesDestination}, after) =>
      after.outcome.is('copied').or(after.outcome.is('moved')).implies(readsSource.and(writesDestination)),
    ({outcome}) => outcome.is('pending')),
  // Step law: a move goes through only when the actor may delete the artifact in the source.
  r.stepLaw('a move goes through only when deleting from the source is allowed',
    ({deletesSource}, after) => after.outcome.is('moved').implies(deletesSource),
    ({outcome}) => outcome.is('pending')),
  // Step law: a move the actor may not finish (no delete in the source) is
  // refused outright; it is never quietly done as a copy instead.
  r.stepLaw('a move that may not delete from the source is refused, not turned into a copy',
    (_, after) => after.outcome.is('refused'),
    ({op, outcome, deletesSource}) => all(outcome.is('pending'), op.is('move'), deletesSource.not())),
  // Step law: asking for a copy never deletes the source.
  r.stepLaw('a copy is never carried out as a move',
    (_, after) => after.outcome.is('moved').not(),
    ({op, outcome}) => outcome.is('pending').and(op.is('copy'))),
  // Step law: once a transfer is decided (copied, moved or refused), it never changes.
  r.stepLaw('a decided transfer never changes',
    ({outcome}, after) => same(after.outcome, outcome),
    ({outcome}) => outcome.is('pending').not()),
  // Step law: a copy that meets every condition goes through.
  r.stepLaw('a copy that meets every condition goes through',
    (_, after) => after.outcome.is('copied'),
    ({op, outcome, liveInSource, liveInDestination, readsSource, writesDestination}) =>
      all(outcome.is('pending'), op.is('copy'), liveInSource, liveInDestination, readsSource, writesDestination)),
  // Step law: a move that meets every condition goes through.
  r.stepLaw('a move that meets every condition goes through',
    (_, after) => after.outcome.is('moved'),
    ({op, outcome, liveInSource, liveInDestination, readsSource, writesDestination, deletesSource}) =>
      all(outcome.is('pending'), op.is('move'), liveInSource, liveInDestination, readsSource, writesDestination, deletesSource)),
]

export const laws = transferLaws()
export const stepLaws = transferStepLaws()

// Each broken variant and the laws it must break. The tests assert every one
// is refused, and that every law above is broken by at least one of them.
export const brokenVariants: {bug: TransferBug, breaks: string[]}[] = [
  {bug: 'skips liveness in the source', breaks: ['a transfer goes through only when the actor is live in both groups']},
  {bug: 'skips the write check', breaks: ['a transfer goes through only with read in the source and write in the destination']},
  {bug: 'skips liveness in the destination', breaks: ['a transfer goes through only when the actor is live in both groups']},
  {bug: 'skips the read check', breaks: ['a transfer goes through only with read in the source and write in the destination']},
  {bug: 'moves without delete permission', breaks: ['a move goes through only when deleting from the source is allowed', 'a move that may not delete from the source is refused, not turned into a copy']},
  {bug: 'turns a refused move into a copy', breaks: ['a move that may not delete from the source is refused, not turned into a copy']},
  {bug: 'carries out a copy as a move', breaks: ['a copy is never carried out as a move']},
  {bug: 'decides again', breaks: ['a decided transfer never changes']},
  {bug: 'refuses every copy', breaks: ['a copy that meets every condition goes through']},
  {bug: 'refuses every move', breaks: ['a move that meets every condition goes through']},
]
