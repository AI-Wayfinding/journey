import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded, type State} from 'gdp-wired/machine'
import * as generated from '../generated/personalGroup.js'
import {brokenVariants, laws, personalGroup, personalGroupRule, stepLaws} from '../src/personalGroup.ts'

// Seams: proof verdicts, generated membership transitions, and interpreter parity.
const params = personalGroup.encodeParams({owner: 1, slots: 8})
const member = (state: State, id: number) => (personalGroup.decode(state).Members as Record<string, string>)[id] ?? 'none'
const request = (op: 'add' | 'remove', subject: number, kind: 'none' | 'person' | 'device' | 'agent', belongsTo = 1) =>
  personalGroup.encodeInput({op, subject, kind, belongsTo})

// Test the full bundle as well as every step law separately: a missing or
// weakened obligation must not be masked by another broken obligation.
test('every personalGroup law is proven from any stored state', () => {
  const v = proveSteps(personalGroup, laws, stepLaws, {from: 'any'})
  assert.ok(v.proven && v.checked && !v.assumes, JSON.stringify(v))
})
for (const law of stepLaws) {
  test(`personalGroup proves separately: ${law.name}`, () => {
    const v = proveSteps(personalGroup, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, JSON.stringify(v))
  })
}

test('broken variants cover every personalGroup law and step law', () => {
  assert.deepEqual(new Set(brokenVariants.flatMap(v => v.breaks)), new Set([...laws, ...stepLaws].map(l => l.name)))
})
for (const variant of brokenVariants) {
  for (const name of variant.breaks) {
    test(`broken personalGroup ${variant.bug} is refused for: ${name}`, () => {
      const broken = personalGroupRule(variant.bug)
      const invariant = laws.filter(l => l.name === name)
      const steps = stepLaws.filter(l => l.name === name)
      assert.equal(invariant.length + steps.length, 1)
      const v = proveSteps(broken, steps.length ? laws : invariant, steps, {from: 'any', search: false})
      assert.equal(v.proven, false, name)
      assert.equal(v.stuck, 'sat', JSON.stringify(v))
      assert.ok(v.goal?.includes(name), JSON.stringify(v))
    })
  }
}

test('personalGroup crossCheck agrees with every law and update', () => {
  const r = personalGroup.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

test('the owner and their devices and agents can join, and only devices and agents can leave', () => {
  let state = generated.init(params)
  state = generated.step(params, state, request('add', 1, 'person'))
  state = generated.step(params, state, request('add', 2, 'device'))
  state = generated.step(params, state, request('add', 3, 'agent'))
  assert.deepEqual([member(state, 1), member(state, 2), member(state, 3)], ['person', 'device', 'agent'])
  state = generated.step(params, state, request('remove', 1, 'person'))
  state = generated.step(params, state, request('remove', 2, 'none'))
  state = generated.step(params, state, request('remove', 3, 'none'))
  assert.deepEqual([member(state, 1), member(state, 2), member(state, 3)], ['person', 'none', 'none'])
})

for (const [subject, kind, belongsTo] of [
  [2, 'person', 1], [2, 'person', 2], [2, 'device', 2], [2, 'agent', 2],
  [1, 'device', 1], [1, 'agent', 1], [2, 'none', 1],
] as const) {
  test(`refuses foreign or misidentified admission ${subject}/${kind}/${belongsTo}`, () => {
    const state = generated.step(params, generated.init(params), request('add', subject, kind, belongsTo))
    assert.equal(member(state, subject), 'none')
    assert.equal(state.maps.Belongs!.get(subject) ?? 0, 0)
  })
}

test('an id at the slot bound is refused even when it belongs to the owner', () => {
  const state = generated.step(params, generated.init(params), request('add', 8, 'device'))
  assert.equal(state.maps.Members!.get(8) ?? 0, 0)
  assert.equal(state.maps.Belongs!.get(8) ?? 0, 0)
})

test('a duplicate add cannot relabel or reassign a member, and removal permits rejoining', () => {
  let state = generated.step(params, generated.init(params), request('add', 2, 'device'))
  state = generated.step(params, state, request('add', 2, 'agent'))
  assert.equal(member(state, 2), 'device')
  state = generated.step(params, state, request('add', 2, 'agent', 2))
  assert.equal(member(state, 2), 'device')
  assert.equal(state.maps.Belongs!.get(2), 1)
  state = generated.step(params, state, request('remove', 2, 'none'))
  state = generated.step(params, state, request('add', 2, 'agent'))
  assert.equal(member(state, 2), 'agent')
})

test('personalGroup generated module and interpreter agree on random requests and maps', () => {
  const rand = seeded(7)
  const run = personalGroup.interpreter()
  const kinds = ['none', 'person', 'device', 'agent'] as const
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    const p = personalGroup.encodeParams({owner: rand(4), slots: 4 + rand(5)})
    let ours = generated.init(p)
    let theirs = run.init(p)
    for (let depth = 0; depth < 20; depth++) {
      const input = personalGroup.encodeInput({op: rand(2) ? 'add' : 'remove', subject: rand(10), kind: kinds[rand(4)]!, belongsTo: rand(4)})
      ours = generated.step(p, ours, input)
      theirs = run.step(p, theirs, input)
      assert.deepEqual(personalGroup.decode(ours), personalGroup.decode(theirs))
      assert.deepEqual(ours.maps, theirs.maps)
      steps++
    }
  }
  assert.equal(steps, 6000)
})

test('personalGroup refuses invalid params and values at 2^53', () => {
  assert.throws(() => generated.step({owner: 1, slots: 1}, generated.init({owner: 1, slots: 1}), request('add', 1, 'person')), RangeError)
  assert.throws(() => generated.init({owner: 0, slots: 2 ** 53}), RangeError)
  assert.throws(() => personalGroup.encodeInput({op: 'add', subject: 2 ** 53, kind: 'device', belongsTo: 1}), RangeError)
  assert.throws(() => generated.step(params, generated.init(params), {op: 0, subject: 2 ** 53, kind: 2, belongsTo: 1}), RangeError)
})

test('refused out-of-range identities cannot grow stored membership maps', () => {
  let state = generated.init(params)
  for (let subject = 8; subject < 40; subject++) {
    state = generated.step(params, state, request('add', subject, 'device'))
  }
  assert.deepEqual([...state.maps.Members!.keys()].filter(k => k >= 8), [])
  assert.deepEqual([...state.maps.Belongs!.keys()].filter(k => k >= 8), [])
})
