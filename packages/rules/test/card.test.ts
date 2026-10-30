import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded} from 'gdp-wired/machine'
import * as generated from '../generated/card.js'
import {brokenVariants, laws, card, cardRule, cardLaws, cardStepLaws, stepLaws} from '../src/card.ts'

test('every law of card is proven from any stored state', () => {
  const v = proveSteps(card, laws, stepLaws, {from: 'any'})
  assert.equal(v.proven, true, `not proven: ${v.goal} (${v.stuck})`)
  assert.equal(v.checked, true)
  assert.equal(v.assumes, undefined)
})

test('each card step law is proven on its own from any stored state', () => {
  for (const law of stepLaws) {
    const v = proveSteps(card, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, law.name)
  }
})

test('every card broken variant is refused at the law it breaks', () => {
  for (const {bug, breaks} of brokenVariants) {
    const r = cardRule(bug)
    const rLaws = cardLaws(r), rSteps = cardStepLaws(r)
    assert.equal(proveSteps(r, rLaws, rSteps, {from: 'any'}).proven, false, bug)
    for (const name of breaks) {
      const isLaw = rLaws.some(l => l.name === name)
      assert.ok(isLaw || rSteps.some(l => l.name === name), `${bug}: no law named ${name}`)
      const v = proveSteps(r, rLaws, isLaw ? [] : rSteps.filter(l => l.name === name), {from: 'any'})
      assert.equal(v.proven, false, `${bug} should break ${name}`)
      assert.equal(v.goal, isLaw ? `${name} @step` : `${name} @step law`, bug)
    }
  }
})

test('every card law and step law has a broken variant', () => {
  const broken = new Set(brokenVariants.flatMap(b => b.breaks))
  for (const law of [...laws, ...stepLaws]) assert.ok(broken.has(law.name), `no broken variant for: ${law.name}`)
})

test('card crossCheck agrees with the proven expressions', () => {
  const r = card.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

test('the generated card module steps to the same states as the interpreter', () => {
  const rand = seeded(11)
  const run = card.interpreter()
  const params = card.encodeParams({})
  const ops = ['sign', 'narrow', 'widen', 'withdraw', 'check'] as const
  const draw = () => ({op: ops[rand(5)]!, cap: rand(23), personAsserted: rand(2) > 0,
    personHolds: rand(2) > 0, personLive: rand(2) > 0, agentLive: rand(2) > 0,
    NewCaps: Array.from({length: rand(8)}, () => rand(23))})
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    let ours = generated.init(params), theirs = run.init(params)
    assert.deepEqual(card.decode(ours), card.decode(theirs))
    for (let d = 0; d < 30; d++) {
      const input = card.encodeInput(draw())
      ours = generated.step(params, ours, input)
      theirs = run.step(params, theirs, input)
      assert.deepEqual(card.decode(ours), card.decode(theirs))
      steps++
    }
  }
  assert.equal(steps, 9000)
})

test('the generated card module refuses values at 2^53', () => {
  const rand = seeded(11)
  const params = card.encodeParams({})
  const ops = ['sign', 'narrow', 'widen', 'withdraw', 'check'] as const
  const draw = () => ({op: ops[rand(5)]!, cap: rand(23), personAsserted: rand(2) > 0,
    personHolds: rand(2) > 0, personLive: rand(2) > 0, agentLive: rand(2) > 0,
    NewCaps: Array.from({length: rand(8)}, () => rand(23))})
  const input = card.encodeInput(draw())
  assert.throws(() => generated.step(params, generated.init(params), {...input, cap: 2 ** 53}), RangeError)
})
