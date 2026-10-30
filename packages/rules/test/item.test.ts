import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded} from 'gdp-wired/machine'
import * as generated from '../generated/item.js'
import {brokenVariants, laws, item, itemRule, itemLaws, itemStepLaws, stepLaws} from '../src/item.ts'

test('every law of item is proven from any stored state', () => {
  const v = proveSteps(item, laws, stepLaws, {from: 'any'})
  assert.equal(v.proven, true, `not proven: ${v.goal} (${v.stuck})`)
  assert.equal(v.checked, true)
  assert.equal(v.assumes, undefined)
})

test('each item step law is proven on its own from any stored state', () => {
  assert.ok(stepLaws.length > 0, 'step laws must not be empty')
  for (const law of stepLaws) {
    const v = proveSteps(item, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, law.name)
  }
})

test('every item broken variant is refused at the law it breaks', () => {
  assert.ok(brokenVariants.length > 0, 'negative controls must not be empty')
  for (const {bug, breaks} of brokenVariants) {
    const r = itemRule(bug)
    const rLaws = itemLaws(r), rSteps = itemStepLaws(r)
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

test('every item law and step law has a broken variant', () => {
  assert.ok(laws.length > 0 && stepLaws.length > 0, 'law coverage must not be empty')
  const broken = new Set(brokenVariants.flatMap(b => b.breaks))
  for (const law of [...laws, ...stepLaws]) assert.ok(broken.has(law.name), `no broken variant for: ${law.name}`)
})

test('item crossCheck agrees with the proven expressions', () => {
  const r = item.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

test('the generated item module steps to the same states as the interpreter', () => {
  const rand = seeded(11)
  const run = item.interpreter()
  const params = item.encodeParams({})
  const ops = ['create', 'version', 'update', 'visibility', 'delete', 'read'] as const
  const kinds = ['markdown', 'html', 'pdf', 'code', 'image', 'video', 'audio', 'data', 'link', 'skill', 'prompt', 'agent', 'applet', 'other'] as const
  const draw = () => ({op: ops[rand(6)]!, actor: rand(4), canWrite: rand(2) > 0, canRead: rand(2) > 0, guide: rand(2) > 0, ownerAgent: rand(2) > 0, newKind: kinds[rand(14)]!, newVisibility: rand(2) ? 'members' : 'private', newProject: rand(4), baseVersion: rand(5)})
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    let ours = generated.init(params), theirs = run.init(params)
    assert.deepEqual(item.decode(ours), item.decode(theirs))
    for (let d = 0; d < 30; d++) {
      const input = item.encodeInput(draw())
      ours = generated.step(params, ours, input)
      theirs = run.step(params, theirs, input)
      assert.deepEqual(item.decode(ours), item.decode(theirs))
      steps++
    }
  }
  assert.equal(steps, 9000)
})

test('the generated item module refuses values at 2^53', () => {
  const rand = seeded(11)
  const params = item.encodeParams({})
  const ops = ['create', 'version', 'update', 'visibility', 'delete', 'read'] as const
  const kinds = ['markdown', 'html', 'pdf', 'code', 'image', 'video', 'audio', 'data', 'link', 'skill', 'prompt', 'agent', 'applet', 'other'] as const
  const draw = () => ({op: ops[rand(6)]!, actor: rand(4), canWrite: rand(2) > 0, canRead: rand(2) > 0, guide: rand(2) > 0, ownerAgent: rand(2) > 0, newKind: kinds[rand(14)]!, newVisibility: rand(2) ? 'members' : 'private', newProject: rand(4), baseVersion: rand(5)})
  const input = item.encodeInput(draw())
  assert.throws(() => generated.step(params, generated.init(params), {...input, actor: 2 ** 53}), RangeError)
})

test('item protects private reads, versions and owner-only visibility and deletion', () => {
  const p = item.encodeParams({})
  let s = generated.init(p)
  const request = {op: 'read', actor: 1, canWrite: true, canRead: true, guide: false, ownerAgent: false, newKind: 'markdown', newVisibility: 'private', newProject: 4, baseVersion: 1}
  const step = (changes: Partial<typeof request>) => {s = generated.step(p, s, item.encodeInput({...request, ...changes})); return item.decode(s)}
  assert.equal(step({op: 'create'}).version, 1)
  assert.equal(step({actor: 2}).allowed, false)
  assert.equal(step({actor: 2, ownerAgent: true}).allowed, true)
  assert.equal(step({actor: 2, guide: true}).allowed, false)
  assert.equal(step({op: 'visibility', actor: 2, newVisibility: 'members'}).visibility, 'private')
  assert.equal(step({op: 'version', actor: 2, baseVersion: 0}).version, 1)
  assert.equal(step({op: 'version', actor: 2}).version, 2)
  assert.equal(step({op: 'version', actor: 2}).version, 2)
  assert.equal(step({op: 'delete', actor: 2}).at, 'live')
  assert.equal(step({op: 'delete', actor: 2, guide: true}).at, 'deleted')
  assert.equal(step({op: 'create'}).at, 'deleted')
})
