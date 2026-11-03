import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded} from 'gdp-wired/machine'
import * as generated from '../generated/round.js'
import {brokenVariants, laws, round, roundRule, roundLaws, roundStepLaws, stepLaws} from '../src/round.ts'

test('every law of round is proven from any stored state', () => {
  const v = proveSteps(round, laws, stepLaws, {from: 'any'})
  assert.equal(v.proven, true, `not proven: ${v.goal} (${v.stuck})`)
  assert.equal(v.checked, true)
  assert.equal(v.assumes, undefined)
})

test('each round step law is proven on its own from any stored state', () => {
  assert.ok(stepLaws.length > 0, 'step laws must not be empty')
  for (const law of stepLaws) {
    const v = proveSteps(round, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, law.name)
  }
})

test('every round broken variant is refused at the law it breaks', () => {
  assert.ok(brokenVariants.length > 0, 'negative controls must not be empty')
  for (const {bug, breaks} of brokenVariants) {
    const r = roundRule(bug)
    const rLaws = roundLaws(r), rSteps = roundStepLaws(r)
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

test('every round law and step law has a broken variant', () => {
  assert.ok(laws.length > 0 && stepLaws.length > 0, 'law coverage must not be empty')
  const broken = new Set(brokenVariants.flatMap(b => b.breaks))
  for (const law of [...laws, ...stepLaws]) assert.ok(broken.has(law.name), `no broken variant for: ${law.name}`)
})

test('round crossCheck agrees with the proven expressions', () => {
  const r = round.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

test('the generated round module steps to the same states as the interpreter', () => {
  const rand = seeded(11)
  const run = round.interpreter()
  const params = round.encodeParams({})
  const ops = ['create', 'status', 'add', 'remove', 'share', 'contribute'] as const
  const states = ['planned', 'open', 'synthesising', 'closed'] as const
  const draw = () => ({op: ops[rand(6)]!, actor: rand(4), subject: rand(4), to: states[rand(4)]!, canCreate: rand(2) > 0, canRun: rand(2) > 0, canContribute: rand(2) > 0, subjectLive: rand(2) > 0})
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    let ours = generated.init(params), theirs = run.init(params)
    assert.deepEqual(round.decode(ours), round.decode(theirs))
    for (let d = 0; d < 30; d++) {
      const input = round.encodeInput(draw())
      ours = generated.step(params, ours, input)
      theirs = run.step(params, theirs, input)
      assert.deepEqual(round.decode(ours), round.decode(theirs))
      steps++
    }
  }
  assert.equal(steps, 9000)
})

test('the generated round module refuses values at 2^53', () => {
  const rand = seeded(11)
  const params = round.encodeParams({})
  const ops = ['create', 'status', 'add', 'remove', 'share', 'contribute'] as const
  const states = ['planned', 'open', 'synthesising', 'closed'] as const
  const draw = () => ({op: ops[rand(6)]!, actor: rand(4), subject: rand(4), to: states[rand(4)]!, canCreate: rand(2) > 0, canRun: rand(2) > 0, canContribute: rand(2) > 0, subjectLive: rand(2) > 0})
  const input = round.encodeInput(draw())
  assert.throws(() => generated.step(params, generated.init(params), {...input, actor: 2 ** 53}), RangeError)
})

test('round protects interviews and attributes eligible contributions to the person', () => {
  const p = round.encodeParams({})
  let s = generated.init(p)
  const request = {op: 'create', actor: 1, subject: 2, to: 'open', canCreate: true, canRun: true, canContribute: true, subjectLive: true}
  const step = (changes: Partial<typeof request>) => {s = generated.step(p, s, round.encodeInput({...request, ...changes})); return round.decode(s)}
  assert.equal(step({}).facilitator, 1)
  step({op: 'add'})
  step({op: 'share'})
  assert.equal(s.maps.Shared!.get(2) ?? 0, 0)
  step({op: 'share', actor: 2})
  assert.equal(s.maps.Shared!.get(2), 1)
  assert.equal(step({op: 'contribute', actor: 2}).contributions, 0)
  assert.equal(step({op: 'status', actor: 2}).status, 'planned')
  assert.equal(step({op: 'status'}).status, 'open')
  assert.equal(step({op: 'contribute', actor: 3}).contributions, 0)
  assert.equal(step({op: 'contribute', actor: 2, subject: 7}).contributions, 1)
  assert.equal(round.decode(s).lastContributor, 2)
  assert.equal(s.maps.Contributions!.get(2), 1)
  assert.equal(s.maps.Contributions!.get(7) ?? 0, 0)
  assert.equal(step({op: 'status', to: 'synthesising'}).status, 'synthesising')
  assert.equal(step({op: 'contribute', actor: 2}).contributions, 2)
  assert.equal(step({op: 'status', to: 'closed'}).status, 'closed')
  assert.equal(step({op: 'contribute', actor: 2}).contributions, 2)
  assert.equal(step({op: 'status'}).status, 'closed')
  step({op: 'remove'})
  assert.equal(s.maps.Participants!.get(2), 0)
  assert.equal(s.maps.Shared!.get(2), 1)
  step({op: 'add', subject: 3})
  assert.equal(s.maps.Participants!.get(3), 1)
})
