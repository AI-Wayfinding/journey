import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded} from 'gdp-wired/machine'
import * as generated from '../generated/artifact.js'
import {brokenVariants, laws, artifact, artifactLaws, artifactRule, artifactStepLaws, stepLaws} from '../src/artifact.ts'

test('every law of artifact is proven from any stored state', () => {
  const v = proveSteps(artifact, laws, stepLaws, {from: 'any'})
  assert.equal(v.proven, true, `not proven: ${v.goal} (${v.stuck})`)
  assert.equal(v.checked, true)
  assert.equal(v.assumes, undefined)
})

test('each step law is proven on its own from any stored state', () => {
  for (const law of stepLaws) {
    const v = proveSteps(artifact, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, law.name)
  }
})

test('every broken variant is refused at the law it breaks', () => {
  for (const {bug, breaks} of brokenVariants) {
    const r = artifactRule(bug)
    const rLaws = artifactLaws(r), rSteps = artifactStepLaws(r)
    // The whole set is refused for the broken variant.
    assert.equal(proveSteps(r, rLaws, rSteps, {from: 'any'}).proven, false, bug)
    for (const name of breaks) {
      const isLaw = rLaws.some((l) => l.name === name)
      assert.ok(isLaw || rSteps.some((l) => l.name === name), `${bug}: no law named ${name}`)
      const v = proveSteps(r, rLaws, isLaw ? [] : rSteps.filter((l) => l.name === name), {from: 'any'})
      assert.equal(v.proven, false, `${bug} should break ${name}`)
      assert.equal(v.goal, isLaw ? `${name} @step` : `${name} @step law`, bug)
    }
  }
})

test('every law and step law is broken by at least one broken variant', () => {
  const broken = new Set(brokenVariants.flatMap((b) => b.breaks))
  for (const law of [...laws, ...stepLaws]) assert.ok(broken.has(law.name), `no broken variant for: ${law.name}`)
})

test('crossCheck agrees with the proven expressions', () => {
  const r = artifact.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

test('the generated module steps to the same states as the interpreter', () => {
  const rand = seeded(11)
  const run = artifact.interpreter()
  const ops = ['create', 'version', 'rename', 'delete'] as const
  const draw = () => ({op: ops[rand(4)]!, actor: rand(4), actorHasWrite: rand(4) > 0, type: rand(3), baseVersion: rand(6)})
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    const params = artifact.encodeParams({})
    let ours = generated.init(params)
    let theirs = run.init(params)
    assert.deepEqual(artifact.decode(ours), artifact.decode(theirs))
    for (let d = 0; d < 30; d++) {
      const input = artifact.encodeInput(draw())
      ours = generated.step(params, ours, input)
      theirs = run.step(params, theirs, input)
      assert.deepEqual(artifact.decode(ours), artifact.decode(theirs))
      steps++
    }
  }
  assert.equal(steps, 9000)
})

test('the generated module refuses values at 2^53', () => {
  const params = artifact.encodeParams({})
  const input = artifact.encodeInput({op: 'create', actor: 1, actorHasWrite: true, type: 1, baseVersion: 0})
  assert.throws(() => generated.step(params, generated.init(params), {...input, actor: 2 ** 53}), RangeError)
})
