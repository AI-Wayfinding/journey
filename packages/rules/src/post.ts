import {all, bool, nat, no, oneOf, rule, same, when, yes} from 'gdp-wired'

// One post, with its immutable author slot and kind. The host interns person
// and agent authors separately, verifies canPost/guide live, validates replyTo
// as a post in this topic, and stores the body only on an accepted edit/create.
// Topic existence/lock are read live by the host before each request.
export const AuthorKind = oneOf('person', 'agent')
export type PostBug = 'uncreated edit' | 'canPost' | 'locked' | 'author' | 'edit' | 'hide' | 'refuse create' | 'refuse edit' | 'refuse hide'
export const postRule = (bug?: PostBug) => rule('post')
  .inputs({op: oneOf('create', 'edit', 'hide'), actor: nat, actorKind: AuthorKind, canPost: bool,
    topicOpen: bool, guide: bool, newHidden: bool, newReplyTo: nat})
  .state({exists: bool.from(false), author: 0, authorKind: AuthorKind.from('person'), replyTo: 0, edits: 0, hidden: bool.from(false)})
  .flags(({op, exists, actor, author, actorKind, authorKind, canPost, topicOpen, guide}) => ({
    creates: bug === 'refuse create' ? no : all(op.is('create'), exists.not(), bug === 'canPost' ? yes : canPost, bug === 'locked' ? yes : topicOpen),
    editsPost: bug === 'refuse edit' ? no : all(op.is('edit'), bug === 'uncreated edit' ? yes : exists, canPost,
      bug === 'edit' ? yes : actor.eq(author).and(same(actorKind, authorKind))),
    hides: bug === 'refuse hide' ? no : all(op.is('hide'), exists, bug === 'hide' ? yes : guide),
  }))
  .step(({actor, actorKind, newReplyTo, newHidden, exists, author, authorKind, replyTo, edits, hidden, creates, editsPost, hides}) => ({
    exists: exists.or(creates),
    author: when(creates.or(bug === 'author' ? editsPost : no), actor, author),
    authorKind: when(creates.or(bug === 'author' ? hides : no), actorKind, authorKind),
    replyTo: when(creates, newReplyTo, replyTo),
    edits: when(editsPost, edits.plus(1), edits),
    hidden: when(hides, newHidden, hidden),
  }))
export const post = postRule()
type Post = ReturnType<typeof postRule>
export const postLaws = (r: Post = post) => [
  // An absent post cannot have an edit history.
  r.law('an uncreated post has no edits', ({exists, edits}) => exists.not().implies(edits.eq(0))),
]
export const postStepLaws = (r: Post = post) => [
  // Creating a post always needs the host-checked post capability.
  r.stepLaw('creating a post requires canPost', ({exists, canPost}, a) => exists.not().and(a.exists).implies(canPost)),
  // A closed, missing or locked topic cannot accept a new post.
  r.stepLaw('new posts require an unlocked topic', ({exists, topicOpen}, a) => exists.not().and(a.exists).implies(topicOpen)),
  // Later edits and moderation cannot change attribution or the quoted post.
  r.stepLaw('post author kind and reply never change', ({exists, author, authorKind, replyTo}, a) => exists.implies(all(a.author.eq(author), same(a.authorKind, authorKind), a.replyTo.eq(replyTo)))),
  // Even a guide cannot edit someone else's words; kind is part of identity.
  r.stepLaw('only the author edits a post', ({edits, actor, author, actorKind, authorKind}, a) => a.edits.ne(edits).implies(actor.eq(author).and(same(actorKind, authorKind)))),
  // Only guides can hide or unhide a post.
  r.stepLaw('only guides change hidden state', ({hidden, guide}, a) => a.hidden.iff(hidden).not().implies(guide)),
  // Authorized posting records attribution and the host-validated reply id.
  r.stepLaw('an authorized member can create an attributed post', ({actor, actorKind, newReplyTo}, a) => all(a.exists, a.author.eq(actor), same(a.authorKind, actorKind), a.replyTo.eq(newReplyTo)),
    ({op, exists, canPost, topicOpen}) => all(op.is('create'), exists.not(), canPost, topicOpen)),
  // An author with post authority can update their words exactly once per step.
  r.stepLaw('an author can edit their post', ({edits}, a) => a.edits.eq(edits.plus(1)),
    ({op, exists, canPost, actor, author, actorKind, authorKind}) => all(op.is('edit'), exists, canPost, actor.eq(author), same(actorKind, authorKind))),
  // Moderation can both hide and restore visibility.
  r.stepLaw('a guide can hide or unhide a post', ({newHidden}, a) => a.hidden.iff(newHidden), ({op, exists, guide}) => all(op.is('hide'), exists, guide)),
]
export const laws = postLaws()
export const stepLaws = postStepLaws()
export const brokenVariants: {bug: PostBug, breaks: string[]}[] = [
  {bug: 'uncreated edit', breaks: ['an uncreated post has no edits']},
  {bug: 'canPost', breaks: ['creating a post requires canPost']},
  {bug: 'locked', breaks: ['new posts require an unlocked topic']},
  {bug: 'author', breaks: ['post author kind and reply never change']},
  {bug: 'edit', breaks: ['only the author edits a post']},
  {bug: 'hide', breaks: ['only guides change hidden state']},
  {bug: 'refuse create', breaks: ['an authorized member can create an attributed post']},
  {bug: 'refuse edit', breaks: ['an author can edit their post']},
  {bug: 'refuse hide', breaks: ['a guide can hide or unhide a post']},
]
