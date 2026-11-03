import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded} from 'gdp-wired/machine'
import * as generated from '../generated/seats.js'
import {brokenSeats, laws, seats, stepLaws} from '../src/seats.ts'

test('every law of seats is proven from any stored state', () => {
  const v = proveSteps(seats, laws, stepLaws, {from: 'any'})
  assert.equal(v.proven, true, `not proven: ${v.goal} (${v.stuck})`)
  assert.equal(v.checked, true)
  assert.equal(v.assumes, undefined)
})

test('each law is proven on its own from any stored state', () => {
  for (const law of stepLaws) {
    const v = proveSteps(seats, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, law.name)
  }
})

test('the broken variant is refused', () => {
  const v = proveSteps(brokenSeats, laws, stepLaws, {from: 'any'})
  assert.equal(v.proven, false)
  assert.equal(v.goal, 'members never exceed the cap @step')
})

test('crossCheck agrees with the proven expressions', () => {
  const r = seats.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

test('the generated module steps to the same states as the interpreter', () => {
  const rand = seeded(7)
  const run = seats.interpreter()
  const ops = ['join', 'leave'] as const
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    const params = seats.encodeParams({cap: rand(6)})
    let ours = generated.init(params)
    let theirs = run.init(params)
    assert.deepEqual(seats.decode(ours), seats.decode(theirs))
    for (let d = 0; d < 20; d++) {
      const input = seats.encodeInput({op: ops[rand(2)]!})
      ours = generated.step(params, ours, input)
      theirs = run.step(params, theirs, input)
      assert.deepEqual(seats.decode(ours), seats.decode(theirs))
      steps++
    }
  }
  assert.equal(steps, 6000)
})

test('the generated module refuses values at 2^53', () => {
  assert.throws(() => generated.init({cap: 2 ** 53}), RangeError)
  const params = {cap: 3}
  assert.throws(() => generated.step(params, generated.init(params), {op: 2 ** 53}), RangeError)
})
