import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded} from 'gdp-wired/machine'
import * as generated from '../generated/post.js'
import {brokenVariants, laws, post, postRule, postLaws, postStepLaws, stepLaws} from '../src/post.ts'

test('every law of post is proven from any stored state', () => {
  const v = proveSteps(post, laws, stepLaws, {from: 'any'})
  assert.equal(v.proven, true, `not proven: ${v.goal} (${v.stuck})`)
  assert.equal(v.checked, true)
  assert.equal(v.assumes, undefined)
})

test('each post step law is proven on its own from any stored state', () => {
  assert.ok(stepLaws.length > 0, 'step laws must not be empty')
  for (const law of stepLaws) {
    const v = proveSteps(post, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, law.name)
  }
})

test('every post broken variant is refused at the law it breaks', () => {
  assert.ok(brokenVariants.length > 0, 'negative controls must not be empty')
  for (const {bug, breaks} of brokenVariants) {
    const r = postRule(bug)
    const rLaws = postLaws(r), rSteps = postStepLaws(r)
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

test('every post law and step law has a broken variant', () => {
  assert.ok(laws.length > 0 && stepLaws.length > 0, 'law coverage must not be empty')
  const broken = new Set(brokenVariants.flatMap(b => b.breaks))
  for (const law of [...laws, ...stepLaws]) assert.ok(broken.has(law.name), `no broken variant for: ${law.name}`)
})

test('post crossCheck agrees with the proven expressions', () => {
  const r = post.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

test('the generated post module steps to the same states as the interpreter', () => {
  const rand = seeded(11)
  const run = post.interpreter()
  const params = post.encodeParams({})
  const ops = ['create', 'edit', 'hide'] as const
  const draw = () => ({op: ops[rand(3)]!, actor: rand(4), actorKind: rand(2) ? 'person' : 'agent', canPost: rand(2) > 0, topicOpen: rand(2) > 0, guide: rand(2) > 0, newHidden: rand(2) > 0, newReplyTo: rand(7)})
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    let ours = generated.init(params), theirs = run.init(params)
    assert.deepEqual(post.decode(ours), post.decode(theirs))
    for (let d = 0; d < 30; d++) {
      const input = post.encodeInput(draw())
      ours = generated.step(params, ours, input)
      theirs = run.step(params, theirs, input)
      assert.deepEqual(post.decode(ours), post.decode(theirs))
      steps++
    }
  }
  assert.equal(steps, 9000)
})

test('the generated post module refuses values at 2^53', () => {
  const rand = seeded(11)
  const params = post.encodeParams({})
  const ops = ['create', 'edit', 'hide'] as const
  const draw = () => ({op: ops[rand(3)]!, actor: rand(4), actorKind: rand(2) ? 'person' : 'agent', canPost: rand(2) > 0, topicOpen: rand(2) > 0, guide: rand(2) > 0, newHidden: rand(2) > 0, newReplyTo: rand(7)})
  const input = post.encodeInput(draw())
  assert.throws(() => generated.step(params, generated.init(params), {...input, actor: 2 ** 53}), RangeError)
})

test('post preserves agent attribution and refuses foreign edits or non-guide moderation', () => {
  const p = post.encodeParams({})
  let s = generated.init(p)
  const request = {op: 'create', actor: 1, actorKind: 'agent', canPost: true, topicOpen: true, guide: false, newHidden: false, newReplyTo: 7}
  const step = (changes: Partial<typeof request>) => {s = generated.step(p, s, post.encodeInput({...request, ...changes})); return post.decode(s)}
  assert.equal(step({canPost: false}).exists, false)
  assert.equal(step({topicOpen: false}).exists, false)
  assert.equal(step({}).authorKind, 'agent')
  assert.equal(step({op: 'edit', actorKind: 'person'}).edits, 0)
  assert.equal(step({op: 'edit', actor: 2}).edits, 0)
  assert.equal(step({op: 'edit'}).edits, 1)
  assert.equal(step({op: 'hide', newHidden: true}).hidden, false)
  assert.equal(step({op: 'hide', guide: true, newHidden: true, actor: 2, actorKind: 'person'}).hidden, true)
  assert.equal(post.decode(s).author, 1)
  assert.equal(post.decode(s).authorKind, 'agent')
  assert.equal(post.decode(s).replyTo, 7)
})
