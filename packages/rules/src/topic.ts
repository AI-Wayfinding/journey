import {all, bool, forall, nat, no, oneOf, rule, when, yes} from 'gdp-wired'

// Journey-wide topic registry: slots are unique topic ids, targets are interned
// (kind,id) pairs so project 1 and artifact 1 are different keys. TargetTopics
// uses slot+1; zero means no attached conversation. Attach creates on first
// post (host must check canPost as well); repeats return the original slot in
// selected, never a second topic. There is no delete/reassign operation.
// boardOpen and canTopic are live host checks, not client-supplied claims.
export type TopicBug = 'dangling attachment' | 'duplicate attachment' | 'authority' | 'archive' | 'author' | 'lock' | 'refuse create' | 'refuse attach' | 'refuse lock'
export const topicRule = (bug?: TopicBug) => rule('topic')
  .inputs({op: oneOf('create', 'attach', 'lock'), slot: nat, target: nat, actor: nat,
    canTopic: bool, boardOpen: bool, guide: bool, locked: bool})
  .state({selected: 0})
  .maps({Topics: bool.from(false), Authors: 0, Locked: bool.from(false), TargetTopics: 0})
  .flags(({op, slot, target, Topics, TargetTopics, canTopic, boardOpen, guide, Authors, actor}) => ({
    creates: all(op.is('create'), bug === 'refuse create' ? no : yes, Topics.at(slot).not(), bug === 'authority' ? yes : canTopic, bug === 'archive' ? yes : boardOpen),
    attaches: all(op.is('attach'), bug === 'refuse attach' ? no : yes, Topics.at(slot).not(), canTopic,
      bug === 'duplicate attachment' ? yes : TargetTopics.at(target).eq(0)),
    locks: all(op.is('lock'), bug === 'refuse lock' ? no : yes, Topics.at(slot), bug === 'lock' ? yes : guide.or(Authors.at(slot).eq(actor))),
  }))
  .step(({slot, target, actor, locked, Topics, Authors, Locked, TargetTopics, creates, attaches, locks}) => ({
    selected: when(attaches, slot.plus(1), TargetTopics.at(target)),
    Topics: Topics.set(slot, Topics.at(slot).or(creates, bug === 'dangling attachment' ? no : attaches)),
    Authors: Authors.set(slot, when(creates.or(attaches, bug === 'author' ? locks : no), actor, Authors.at(slot))),
    Locked: Locked.set(slot, when(locks, locked, Locked.at(slot))),
    TargetTopics: TargetTopics.set(target, when(attaches, slot.plus(1), TargetTopics.at(target))),
  }))
export const topic = topicRule()
type Topic = ReturnType<typeof topicRule>
export const topicLaws = (r: Topic = topic) => [
  // Every attachment points to a created topic (slot+1 avoids a zero sentinel).
  r.law('every attachment names an existing topic', ({TargetTopics, Topics}) => forall(k => TargetTopics.at(k).gt(0).implies(Topics.at(TargetTopics.at(k).minus(1))))),
]
export const topicStepLaws = (r: Topic = topic) => [
  // A target with a conversation never acquires a different conversation.
  r.stepLaw('each target keeps its single attached topic', ({TargetTopics}, a) => forall(k => TargetTopics.at(k).gt(0).implies(a.TargetTopics.at(k).eq(TargetTopics.at(k))))),
  // Only an authorized member creates any topic or conversation.
  r.stepLaw('creating a topic requires canTopic', ({Topics, canTopic}, a) => forall(k => Topics.at(k).not().and(a.Topics.at(k)).implies(canTopic))),
  // Board topics cannot be created in archived boards.
  r.stepLaw('board topics require an open board', ({Topics, boardOpen}, a) => forall(k => Topics.at(k).not().and(a.Topics.at(k)).implies(boardOpen)), ({op}) => op.is('create')),
  // Topic authors are fixed after creation.
  r.stepLaw('a topic author never changes', ({Topics, Authors}, a) => forall(k => Topics.at(k).implies(a.Authors.at(k).eq(Authors.at(k))))),
  // Only the author or a guide may change a topic's lock.
  r.stepLaw('only author or guide changes topic lock', ({Locked, Authors, actor, guide}, a) => forall(k => a.Locked.at(k).iff(Locked.at(k)).not().implies(guide.or(Authors.at(k).eq(actor))))),
  // Board topic creation records its author and topic slot.
  r.stepLaw('an authorized member can create a board topic', ({slot, actor}, a) => a.Topics.at(slot).and(a.Authors.at(slot).eq(actor)),
    ({op, Topics, slot, canTopic, boardOpen}) => all(op.is('create'), Topics.at(slot).not(), canTopic, boardOpen)),
  // A new target receives a topic, with the creator fixed as its author.
  r.stepLaw('first attachment creates and selects a conversation', ({slot, target, actor}, a) => all(a.TargetTopics.at(target).eq(slot.plus(1)), a.selected.eq(slot.plus(1)), a.Topics.at(slot), a.Authors.at(slot).eq(actor)),
    ({op, Topics, slot, canTopic, TargetTopics, target}) => all(op.is('attach'), Topics.at(slot).not(), canTopic, TargetTopics.at(target).eq(0))),
  // The author or guide can both lock and unlock a topic.
  r.stepLaw('an authorized topic lock takes effect', ({slot, locked}, a) => a.Locked.at(slot).iff(locked),
    ({op, slot, Topics, Authors, actor, guide}) => all(op.is('lock'), Topics.at(slot), guide.or(Authors.at(slot).eq(actor)))),
]
export const laws = topicLaws()
export const stepLaws = topicStepLaws()
export const brokenVariants: {bug: TopicBug, breaks: string[]}[] = [
  {bug: 'dangling attachment', breaks: ['every attachment names an existing topic']},
  {bug: 'duplicate attachment', breaks: ['each target keeps its single attached topic']},
  {bug: 'authority', breaks: ['creating a topic requires canTopic']},
  {bug: 'archive', breaks: ['board topics require an open board']},
  {bug: 'author', breaks: ['a topic author never changes']},
  {bug: 'lock', breaks: ['only author or guide changes topic lock']},
  {bug: 'refuse create', breaks: ['an authorized member can create a board topic']},
  {bug: 'refuse attach', breaks: ['first attachment creates and selects a conversation']},
  {bug: 'refuse lock', breaks: ['an authorized topic lock takes effect']},
]
