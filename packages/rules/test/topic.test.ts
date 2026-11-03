import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded} from 'gdp-wired/machine'
import * as generated from '../generated/topic.js'
import {brokenVariants, laws, topic, topicRule, topicLaws, topicStepLaws, stepLaws} from '../src/topic.ts'

test('every law of topic is proven from any stored state', () => {
  const v = proveSteps(topic, laws, stepLaws, {from: 'any'})
  assert.equal(v.proven, true, `not proven: ${v.goal} (${v.stuck})`)
  assert.equal(v.checked, true)
  assert.equal(v.assumes, undefined)
})

test('each topic step law is proven on its own from any stored state', () => {
  assert.ok(stepLaws.length > 0, 'step laws must not be empty')
  for (const law of stepLaws) {
    const v = proveSteps(topic, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, law.name)
  }
})

test('every topic broken variant is refused at the law it breaks', () => {
  assert.ok(brokenVariants.length > 0, 'negative controls must not be empty')
  for (const {bug, breaks} of brokenVariants) {
    const r = topicRule(bug)
    const rLaws = topicLaws(r), rSteps = topicStepLaws(r)
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

test('every topic law and step law has a broken variant', () => {
  assert.ok(laws.length > 0 && stepLaws.length > 0, 'law coverage must not be empty')
  const broken = new Set(brokenVariants.flatMap(b => b.breaks))
  for (const law of [...laws, ...stepLaws]) assert.ok(broken.has(law.name), `no broken variant for: ${law.name}`)
})

test('topic crossCheck agrees with the proven expressions', () => {
  const r = topic.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

test('the generated topic module steps to the same states as the interpreter', () => {
  const rand = seeded(11)
  const run = topic.interpreter()
  const params = topic.encodeParams({})
  const ops = ['create', 'attach', 'lock'] as const
  const draw = () => ({op: ops[rand(3)]!, actor: rand(4), slot: rand(7), target: rand(4), canTopic: rand(2) > 0, boardOpen: rand(2) > 0, guide: rand(2) > 0, locked: rand(2) > 0})
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    let ours = generated.init(params), theirs = run.init(params)
    assert.deepEqual(topic.decode(ours), topic.decode(theirs))
    for (let d = 0; d < 30; d++) {
      const input = topic.encodeInput(draw())
      ours = generated.step(params, ours, input)
      theirs = run.step(params, theirs, input)
      assert.deepEqual(topic.decode(ours), topic.decode(theirs))
      steps++
    }
  }
  assert.equal(steps, 9000)
})

test('the generated topic module refuses values at 2^53', () => {
  const rand = seeded(11)
  const params = topic.encodeParams({})
  const ops = ['create', 'attach', 'lock'] as const
  const draw = () => ({op: ops[rand(3)]!, actor: rand(4), slot: rand(7), target: rand(4), canTopic: rand(2) > 0, boardOpen: rand(2) > 0, guide: rand(2) > 0, locked: rand(2) > 0})
  const input = topic.encodeInput(draw())
  assert.throws(() => generated.step(params, generated.init(params), {...input, actor: 2 ** 53}), RangeError)
})

test('topic keeps a single conversation per target and author-only locks', () => {
  const p = topic.encodeParams({})
  let s = generated.init(p)
  const request = {op: 'attach', slot: 1, target: 2, actor: 1, canTopic: true, boardOpen: false, guide: false, locked: false}
  const step = (changes: Partial<typeof request>) => {s = generated.step(p, s, topic.encodeInput({...request, ...changes})); return topic.decode(s)}
  assert.equal(step({op: 'create'}).selected, 0)
  assert.equal(s.maps.Topics!.get(1) ?? 0, 0)
  assert.equal(step({}).selected, 2)
  assert.equal(step({slot: 3}).selected, 2)
  assert.equal(s.maps.Topics!.get(3) ?? 0, 0)
  step({op: 'lock', actor: 2, locked: true})
  assert.equal(s.maps.Locked!.get(1) ?? 0, 0)
  step({op: 'lock', locked: true})
  assert.equal(s.maps.Locked!.get(1), 1)
  step({op: 'lock', actor: 2, guide: true})
  assert.equal(s.maps.Locked!.get(1), 0)
})
