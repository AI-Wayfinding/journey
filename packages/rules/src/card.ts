import {all, bool, forall, nat, no, oneOf, rule, when, yes} from 'gdp-wired'
import {capabilityCount} from './capabilities.ts'

// One account agent's card. NewCaps is the entire proposed set; the host
// authenticates narrowing/withdrawal and verifies personAsserted over the
// digest of exactly NewCaps, not a caller-supplied assertion flag. Creation
// starts empty. Only catalogue ids may be stored; no console-only operation
// has such an id. A narrow request intersects, so careless input cannot widen.
export type CardBug = 'unsigned' | 'catalogue' | 'assertion' | 'narrow' | 'withdraw' | 'effective' | 'refuse sign' | 'refuse widen'
export const cardRule = (bug?: CardBug) => rule('card')
  .inputs({op: oneOf('sign', 'narrow', 'widen', 'withdraw', 'check'), cap: nat,
    personAsserted: bool, personHolds: bool, personLive: bool, agentLive: bool})
  .carries('NewCaps')
  .state({signed: bool.from(false), allowed: bool.from(false)})
  .maps({Caps: bool.from(false)})
  .flags(({op, signed, personAsserted, personHolds, personLive, agentLive, cap, Caps}) => ({
    signs: bug === 'refuse sign' ? no : all(op.is('sign'), signed.not(), bug === 'assertion' ? yes : personAsserted),
    widens: bug === 'refuse widen' ? no : all(op.is('widen'), signed, bug === 'assertion' ? yes : personAsserted),
    narrows: all(op.is('narrow'), signed),
    withdraws: op.is('withdraw'),
    checks: all(op.is('check'), signed, personHolds, personLive, agentLive, bug === 'effective' ? yes : Caps.at(cap)),
  }))
  .step(({signed, Caps, NewCaps, signs, widens, narrows, withdraws, checks}) => ({
    signed: when(withdraws, bug === 'withdraw' ? signed : no, signed.or(signs)),
    allowed: checks,
    Caps: Caps.each(k => when(withdraws, bug === 'unsigned' ? Caps.at(k) : no,
      when(signs.or(widens), NewCaps.has(k).and(bug === 'catalogue' ? yes : k.lt(capabilityCount)),
        when(narrows, NewCaps.has(k).and(bug === 'narrow' ? yes : Caps.at(k)), Caps.at(k))))),
  }))
export const card = cardRule()
type Card = ReturnType<typeof cardRule>
export const cardLaws = (r: Card = card) => [
  // An unsigned or withdrawn card contains no permissions.
  r.law('an unsigned card is empty', ({signed, Caps}) => forall(k => signed.not().implies(Caps.at(k).not()))),
  // Unknown ids, including console-only operations, never enter the card.
  r.law('only catalogue capabilities are assigned', ({Caps}) => forall(k => Caps.at(k).implies(k.lt(capabilityCount)))),
]
export const cardStepLaws = (r: Card = card) => [
  // Signing or gaining any permission needs the person's verified assertion.
  r.stepLaw('signing and widening require the person assertion', ({signed, Caps, personAsserted}, after) =>
    forall(k => signed.not().and(after.signed).or(Caps.at(k).not().and(after.Caps.at(k))).implies(personAsserted))),
  // A narrowing applies the intersection immediately, even without an assertion.
  r.stepLaw('narrowing only removes and needs no assertion', ({Caps, NewCaps}, after) =>
    forall(k => after.Caps.at(k).iff(Caps.at(k).and(NewCaps.has(k)))), ({op, signed}) => op.is('narrow').and(signed)),
  // Withdrawal clears the signature and every permission.
  r.stepLaw('withdrawal clears the card', (_, after) => forall(k => after.signed.not().and(after.Caps.at(k).not())), ({op}) => op.is('withdraw')),
  // A check is exactly the intersection of the signed card and live authority.
  r.stepLaw('a check intersects signed card and live person authority', ({signed, Caps, cap, personHolds, personLive, agentLive}, after) =>
    after.allowed.iff(all(signed, Caps.at(cap), personHolds, personLive, agentLive)), ({op}) => op.is('check')),
  // A valid first signature installs the proposed assignable capabilities.
  r.stepLaw('an asserted first signature installs the card', ({NewCaps}, after) =>
    forall(k => after.signed.and(after.Caps.at(k).iff(NewCaps.has(k).and(k.lt(capabilityCount))))),
    ({op, signed, personAsserted}) => all(op.is('sign'), signed.not(), personAsserted)),
  // An asserted replacement installs exactly the assignable proposed set.
  r.stepLaw('an asserted widening installs the new card', ({NewCaps}, after) =>
    forall(k => after.Caps.at(k).iff(NewCaps.has(k).and(k.lt(capabilityCount)))),
    ({op, signed, personAsserted}) => all(op.is('widen'), signed, personAsserted)),
]
export const laws = cardLaws()
export const stepLaws = cardStepLaws()
export const brokenVariants: {bug: CardBug, breaks: string[]}[] = [
  {bug: 'unsigned', breaks: ['an unsigned card is empty']},
  {bug: 'catalogue', breaks: ['only catalogue capabilities are assigned']},
  {bug: 'assertion', breaks: ['signing and widening require the person assertion']},
  {bug: 'narrow', breaks: ['narrowing only removes and needs no assertion']},
  {bug: 'withdraw', breaks: ['withdrawal clears the card']},
  {bug: 'effective', breaks: ['a check intersects signed card and live person authority']},
  {bug: 'refuse sign', breaks: ['an asserted first signature installs the card']},
  {bug: 'refuse widen', breaks: ['an asserted widening installs the new card']},
]
