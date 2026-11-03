import {nat, oneOf, rule, when} from 'gdp-wired'

// Seats: a journey has at most `cap` members. A join is admitted only while a
// seat is free; a leave frees one seat. This is the pipeline's example rule;
// the real coordination rules arrive in stage 1.
export const seats = rule('seats')
  .params({cap: nat})
  .inputs({op: oneOf('join', 'leave')})
  .state({members: 0})
  .flags(({op, members, cap}) => ({
    admitted: op.is('join').and(members.lt(cap)),
    left: op.is('leave').and(members.gt(0)),
  }))
  .step(({members, admitted, left}) => ({
    members: when(admitted, members.plus(1), when(left, members.minus(1), members)),
  }))

// Law: the member count never passes the cap.
export const withinCap = seats.law('members never exceed the cap', ({members, cap}) => members.atMost(cap))

export const laws = [withinCap]

export const stepLaws = [
  // A join is admitted only with a free seat, and then adds exactly one member.
  seats.stepLaw('an admitted join adds one member', ({members}, after) => after.members.eq(members.plus(1)), ({admitted}) => admitted),
  // A refused join leaves the count as it was.
  seats.stepLaw('a refused join changes nothing', ({members}, after) => after.members.eq(members), ({op, admitted}) => op.is('join').and(admitted.not())),
  // A leave never adds a member.
  seats.stepLaw('a leave never adds a member', ({members}, after) => after.members.atMost(members), ({op}) => op.is('leave')),
]

// Broken variant: admits every join, so the cap can be passed. Tests assert
// that the laws above are refused for it.
export const brokenSeats = seats.step(({members, op, left}) => ({
  members: when(op.is('join'), members.plus(1), when(left, members.minus(1), members)),
}))
