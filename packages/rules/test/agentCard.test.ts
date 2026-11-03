import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded, type State} from 'gdp-wired/machine'
import * as generated from '../generated/agentCard.js'
import {agentCard, agentCardRule, brokenVariants, laws, stepLaws} from '../src/agentCard.ts'

const OPS = ['sign', 'edit', 'withdraw', 'check'] as const
const NEEDS = ['read', 'write', 'grant'] as const

const params = agentCard.encodeParams({})
type Req = {
  op: (typeof OPS)[number], newRead?: boolean, newWrite?: boolean, newGrant?: boolean, personSigned?: boolean,
  need?: (typeof NEEDS)[number], personHas?: boolean, personLive?: boolean, agentLive?: boolean,
}
const req = ({op, newRead = false, newWrite = false, newGrant = false, personSigned = false, need = 'read', personHas = true, personLive = true, agentLive = true}: Req) =>
  agentCard.encodeInput({op, newRead, newWrite, newGrant, personSigned, need, personHas, personLive, agentLive})
const run = (...reqs: Req[]) => reqs.reduce((st, r) => generated.step(params, st, req(r)), generated.init(params))
const view = (st: State) => agentCard.decode(st) as {signed: boolean, mayRead: boolean, mayWrite: boolean, mayGrant: boolean, allowed: boolean}
const check = (st: State, need: Req['need'], live: Partial<Req> = {}) => view(generated.step(params, st, req({op: 'check', need, ...live}))).allowed

// The person signs a card that lets the agent read and write, but not grant.
const signed: Req = {op: 'sign', newRead: true, newWrite: true, personSigned: true}

test('every agent card law is proven from any stored state', () => {
  const v = proveSteps(agentCard, laws, stepLaws, {from: 'any'})
  assert.ok(v.proven && v.checked && !v.assumes, JSON.stringify(v))
})
for (const law of stepLaws) {
  test(`agent card proves separately: ${law.name}`, () => {
    const v = proveSteps(agentCard, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, JSON.stringify(v))
  })
}

test('broken variants cover every agent card law and step law', () => {
  assert.deepEqual(new Set(brokenVariants.flatMap(v => v.breaks)), new Set([...laws, ...stepLaws].map(l => l.name)))
})
for (const variant of brokenVariants) {
  for (const name of variant.breaks) {
    test(`broken agent card ${variant.bug} is refused for: ${name}`, () => {
      const invariant = laws.filter(l => l.name === name)
      const steps = stepLaws.filter(l => l.name === name)
      assert.equal(invariant.length + steps.length, 1)
      const context = steps.length ? laws.filter(l => !variant.breaks.includes(l.name)) : invariant
      const v = proveSteps(agentCardRule(variant.bug), context, steps, {from: 'any', search: false})
      assert.equal(v.proven, false, name)
      assert.equal(v.stuck, 'sat', JSON.stringify(v))
      assert.ok(v.goal?.includes(name), JSON.stringify(v))
    })
  }
}

test('agent card crossCheck agrees with every law and update', () => {
  const r = agentCard.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

test('the generated agent card module steps to the same states as the interpreter', () => {
  const rand = seeded(7)
  const interp = agentCard.interpreter()
  const flip = () => rand(2) === 1
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    let ours = generated.init(params)
    let theirs = interp.init(params)
    for (let d = 0; d < 20; d++) {
      const input = agentCard.encodeInput({
        op: OPS[rand(OPS.length)]!, newRead: flip(), newWrite: flip(), newGrant: flip(), personSigned: flip(),
        need: NEEDS[rand(3)]!, personHas: flip(), personLive: flip(), agentLive: flip(),
      })
      ours = generated.step(params, ours, input)
      theirs = interp.step(params, theirs, input)
      assert.deepEqual(agentCard.decode(ours), agentCard.decode(theirs))
      assert.deepEqual(ours.scalars, theirs.scalars)
      steps++
    }
  }
  assert.equal(steps, 6000)
})

test('the generated agent card module refuses values at 2^53', () => {
  const input = req({op: 'check'}) as Record<string, number>
  assert.throws(() => generated.step(params, generated.init(params), {...input, op: 2 ** 53}), RangeError)
  assert.throws(() => generated.step(params, generated.init(params), {...input, personHas: 2 ** 53}), RangeError)
})

test('a card takes effect only once its person signs it', () => {
  assert.equal(view(run({...signed, personSigned: false})).signed, false)
  assert.equal(check(run({...signed, personSigned: false}), 'read'), false)
  const st = run(signed)
  assert.deepEqual(view(st), {signed: true, mayRead: true, mayWrite: true, mayGrant: false, allowed: false})
})

test('once signed, the agent acts without the person signing again', () => {
  const st = run(signed, {op: 'check', need: 'read'}, {op: 'check', need: 'write'})
  assert.equal(view(st).signed, true)
  assert.equal(check(st, 'read'), true)
  assert.equal(check(st, 'write'), true)
})

test('the agent never has more than its person or its card allows', () => {
  const st = run(signed)
  assert.equal(check(st, 'grant'), false, 'the card does not allow grants')
  assert.equal(check(st, 'write', {personHas: false}), false, 'the person cannot write')
  assert.equal(check(st, 'read', {personLive: false}), false, 'the person left')
  assert.equal(check(st, 'read', {agentLive: false}), false, 'the agent was removed')
  assert.equal(check(generated.init(params), 'read'), false, 'no card')
})

test('widening a card needs a new person signature; narrowing does not', () => {
  const st = run(signed)
  const widened = generated.step(params, generated.fork(st), req({op: 'edit', newRead: true, newWrite: true, newGrant: true}))
  assert.equal(view(widened).mayGrant, false)
  assert.equal(check(widened, 'grant'), false)
  const signedWide = generated.step(params, generated.fork(st), req({op: 'edit', newRead: true, newWrite: true, newGrant: true, personSigned: true}))
  assert.equal(check(signedWide, 'grant'), true)
  const narrowed = generated.step(params, generated.fork(st), req({op: 'edit', newRead: true}))
  assert.deepEqual([view(narrowed).mayRead, view(narrowed).mayWrite], [true, false])
  assert.equal(check(narrowed, 'write'), false)
})

test('a withdrawn card allows nothing and must be signed again', () => {
  const st = run(signed, {op: 'withdraw'})
  assert.deepEqual(view(st), {signed: false, mayRead: false, mayWrite: false, mayGrant: false, allowed: false})
  assert.equal(check(st, 'read'), false)
  assert.equal(view(generated.step(params, st, req({op: 'edit', newRead: true, personSigned: true}))).signed, false)
})
