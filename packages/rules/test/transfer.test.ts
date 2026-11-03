import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded} from 'gdp-wired/machine'
import * as generated from '../generated/transfer.js'
import {brokenVariants, laws, stepLaws, transfer, transferRule} from '../src/transfer.ts'

// Seams: proof verdicts and the generated per-transfer decision. These tests
// check authorization, not host encryption, atomicity or artifact storage.
const params = transfer.encodeParams({})
const permissionNames = ['liveInSource', 'liveInDestination', 'readsSource', 'writesDestination', 'deletesSource'] as const
const allow = {liveInSource: true, liveInDestination: true, readsSource: true, writesDestination: true, deletesSource: true}

test('every transfer law is proven from any stored state', () => {
  const v = proveSteps(transfer, laws, stepLaws, {from: 'any'})
  assert.ok(v.proven && v.checked && !v.assumes, JSON.stringify(v))
})
for (const law of stepLaws) {
  test(`transfer proves separately: ${law.name}`, () => {
    const v = proveSteps(transfer, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, JSON.stringify(v))
  })
}

test('broken variants cover every transfer law and step law', () => {
  assert.deepEqual(new Set(brokenVariants.flatMap(v => v.breaks)), new Set([...laws, ...stepLaws].map(l => l.name)))
})
for (const variant of brokenVariants) {
  for (const name of variant.breaks) {
    test(`broken transfer ${variant.bug} is refused for: ${name}`, () => {
      const selected = stepLaws.filter(l => l.name === name)
      assert.equal(selected.length, 1)
      const v = proveSteps(transferRule(variant.bug), laws, selected, {from: 'any', search: false})
      assert.equal(v.proven, false, name)
      assert.equal(v.stuck, 'sat', JSON.stringify(v))
      assert.ok(v.goal?.includes(name), JSON.stringify(v))
    })
  }
}

test('transfer crossCheck agrees with every law and update', () => {
  const r = transfer.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

// The contract gives a truth table: all four copy permissions and, for move,
// delete permission. Enumerate every row so no missing check can be masked by
// another false permission. Exact allowed masks are independent of the rule.
for (const op of ['copy', 'move'] as const) {
  test(`${op} decides all 32 permission combinations correctly`, () => {
    const acceptedMasks = op === 'copy' ? [15, 31] : [31]
    const allowedOutcome = op === 'copy' ? 'copied' : 'moved'
    for (let mask = 0; mask < 32; mask++) {
      const input = transfer.encodeInput({
        op,
        liveInSource: !!(mask & 1),
        liveInDestination: !!(mask & 2),
        readsSource: !!(mask & 4),
        writesDestination: !!(mask & 8),
        deletesSource: !!(mask & 16),
      })
      const state = generated.step(params, generated.init(params), input)
      assert.equal(transfer.decode(state).outcome, acceptedMasks.includes(mask) ? allowedOutcome : 'refused', `${op} mask ${mask}`)
    }
  })
}

test('a permitted copy does not delete even when deletion would be allowed', () => {
  const input = transfer.encodeInput({op: 'copy', ...allow})
  const state = generated.step(params, generated.init(params), input)
  assert.equal(transfer.decode(state).outcome, 'copied')
})

test('a move without delete permission refuses outright, not as a copy', () => {
  const input = transfer.encodeInput({op: 'move', ...allow, deletesSource: false})
  const state = generated.step(params, generated.init(params), input)
  assert.equal(transfer.decode(state).outcome, 'refused')
})

for (const first of ['copied', 'moved', 'refused'] as const) {
  test(`a ${first} transfer cannot be decided again`, () => {
    const initialRequest = transfer.encodeInput({op: first === 'copied' ? 'copy' : 'move', ...allow, deletesSource: first !== 'refused'})
    let state = generated.step(params, generated.init(params), initialRequest)
    assert.equal(transfer.decode(state).outcome, first)
    for (const op of ['copy', 'move'] as const) {
      state = generated.step(params, state, transfer.encodeInput({op, ...allow}))
      assert.equal(transfer.decode(state).outcome, first)
    }
  })
}

test('transfer generated module and interpreter agree on random requests', () => {
  const rand = seeded(7)
  const run = transfer.interpreter()
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    let ours = generated.init(params)
    let theirs = run.init(params)
    assert.deepEqual(transfer.decode(ours), {outcome: 'pending'})
    for (let depth = 0; depth < 20; depth++) {
      const input = transfer.encodeInput({op: rand(2) ? 'copy' : 'move',
        liveInSource: !!rand(2), liveInDestination: !!rand(2), readsSource: !!rand(2),
        writesDestination: !!rand(2), deletesSource: !!rand(2)})
      ours = generated.step(params, ours, input)
      theirs = run.step(params, theirs, input)
      assert.deepEqual(transfer.decode(ours), transfer.decode(theirs))
      steps++
    }
  }
  assert.equal(steps, 6000)
})

test('transfer rejects values at 2^53 for every encoded request field', () => {
  const valid = transfer.encodeInput({op: 'copy', ...allow})
  for (const field of ['op', ...permissionNames]) {
    assert.throws(() => generated.step(params, generated.init(params), {...valid, [field]: 2 ** 53}), RangeError)
  }
})
