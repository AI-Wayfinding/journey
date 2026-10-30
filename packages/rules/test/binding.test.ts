import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded} from 'gdp-wired/machine'
import * as generated from '../generated/binding.js'
import {brokenVariants, laws, binding, bindingRule, bindingLaws, bindingStepLaws, stepLaws} from '../src/binding.ts'

test('every law of binding is proven from any stored state', () => {
  const v = proveSteps(binding, laws, stepLaws, {from: 'any'})
  assert.equal(v.proven, true, `not proven: ${v.goal} (${v.stuck})`)
  assert.equal(v.checked, true)
  assert.equal(v.assumes, undefined)
})

test('each binding step law is proven on its own from any stored state', () => {
  for (const law of stepLaws) {
    const v = proveSteps(binding, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, law.name)
  }
})

test('every binding broken variant is refused at the law it breaks', () => {
  for (const {bug, breaks} of brokenVariants) {
    const r = bindingRule(bug)
    const rLaws = bindingLaws(r), rSteps = bindingStepLaws(r)
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

test('every binding law and step law has a broken variant', () => {
  const broken = new Set(brokenVariants.flatMap(b => b.breaks))
  for (const law of [...laws, ...stepLaws]) assert.ok(broken.has(law.name), `no broken variant for: ${law.name}`)
})

test('binding crossCheck agrees with the proven expressions', () => {
  const r = binding.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

test('the generated binding module steps to the same states as the interpreter', () => {
  const rand = seeded(11)
  const run = binding.interpreter()
  const params = binding.encodeParams({person: 9})
  const ops = ['bind', 'unbind', 'removeAgent', 'act'] as const
  const draw = () => ({op: ops[rand(4)]!, client: rand(4), agent: rand(5), personAsserted: rand(2) > 0,
    agentIsOwnLive: rand(2) > 0, personLive: rand(2) > 0, boundAgentLive: rand(2) > 0})
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    let ours = generated.init(params), theirs = run.init(params)
    assert.deepEqual(binding.decode(ours), binding.decode(theirs))
    for (let d = 0; d < 30; d++) {
      const input = binding.encodeInput(draw())
      ours = generated.step(params, ours, input)
      theirs = run.step(params, theirs, input)
      assert.deepEqual(binding.decode(ours), binding.decode(theirs))
      steps++
    }
  }
  assert.equal(steps, 9000)
})

test('the generated binding module refuses values at 2^53', () => {
  const rand = seeded(11)
  const params = binding.encodeParams({person: 9})
  const ops = ['bind', 'unbind', 'removeAgent', 'act'] as const
  const draw = () => ({op: ops[rand(4)]!, client: rand(4), agent: rand(5), personAsserted: rand(2) > 0,
    agentIsOwnLive: rand(2) > 0, personLive: rand(2) > 0, boundAgentLive: rand(2) > 0})
  const input = binding.encodeInput(draw())
  assert.throws(() => generated.step(params, generated.init(params), {...input, client: 2 ** 53}), RangeError)
})
