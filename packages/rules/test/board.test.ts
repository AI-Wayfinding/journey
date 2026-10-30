import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded} from 'gdp-wired/machine'
import * as generated from '../generated/board.js'
import {brokenVariants, laws, board, boardRule, boardLaws, boardStepLaws, stepLaws} from '../src/board.ts'

test('every law of board is proven from any stored state', () => {
  const v = proveSteps(board, laws, stepLaws, {from: 'any'})
  assert.equal(v.proven, true, `not proven: ${v.goal} (${v.stuck})`)
  assert.equal(v.checked, true)
  assert.equal(v.assumes, undefined)
})

test('each board step law is proven on its own from any stored state', () => {
  assert.ok(stepLaws.length > 0, 'step laws must not be empty')
  for (const law of stepLaws) {
    const v = proveSteps(board, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, law.name)
  }
})

test('every board broken variant is refused at the law it breaks', () => {
  assert.ok(brokenVariants.length > 0, 'negative controls must not be empty')
  for (const {bug, breaks} of brokenVariants) {
    const r = boardRule(bug)
    const rLaws = boardLaws(r), rSteps = boardStepLaws(r)
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

test('every board law and step law has a broken variant', () => {
  assert.ok(laws.length > 0 && stepLaws.length > 0, 'law coverage must not be empty')
  const broken = new Set(brokenVariants.flatMap(b => b.breaks))
  for (const law of [...laws, ...stepLaws]) assert.ok(broken.has(law.name), `no broken variant for: ${law.name}`)
})

test('board crossCheck agrees with the proven expressions', () => {
  const r = board.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

test('the generated board module steps to the same states as the interpreter', () => {
  const rand = seeded(11)
  const run = board.interpreter()
  const params = board.encodeParams({})
  const ops = ['create', 'rename', 'archive'] as const
  const draw = () => ({op: ops[rand(3)]!, actor: rand(4), guide: rand(2) > 0, newArchived: rand(2) > 0})
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    let ours = generated.init(params), theirs = run.init(params)
    assert.deepEqual(board.decode(ours), board.decode(theirs))
    for (let d = 0; d < 30; d++) {
      const input = board.encodeInput(draw())
      ours = generated.step(params, ours, input)
      theirs = run.step(params, theirs, input)
      assert.deepEqual(board.decode(ours), board.decode(theirs))
      steps++
    }
  }
  assert.equal(steps, 9000)
})

test('the generated board module refuses values at 2^53', () => {
  const rand = seeded(11)
  const params = board.encodeParams({})
  const ops = ['create', 'rename', 'archive'] as const
  const draw = () => ({op: ops[rand(3)]!, actor: rand(4), guide: rand(2) > 0, newArchived: rand(2) > 0})
  const input = board.encodeInput(draw())
  assert.throws(() => generated.step(params, generated.init(params), {...input, actor: 2 ** 53}), RangeError)
})

test('board only lets guides create rename archive and reopen', () => {
  const p = board.encodeParams({})
  let s = generated.init(p)
  const request = {op: 'create', actor: 1, guide: false, newArchived: false}
  const step = (changes: Partial<typeof request>) => {s = generated.step(p, s, board.encodeInput({...request, ...changes})); return board.decode(s)}
  assert.equal(step({}).exists, false)
  assert.equal(step({guide: true}).exists, true)
  assert.equal(step({op: 'rename'}).edits, 0)
  assert.equal(step({op: 'rename', guide: true}).edits, 1)
  assert.equal(step({op: 'archive', guide: true, newArchived: true}).archived, true)
  assert.equal(step({op: 'archive', guide: true}).archived, false)
})
