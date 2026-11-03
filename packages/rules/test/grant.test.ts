import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded, type State} from 'gdp-wired/machine'
import * as generated from '../generated/grant.js'
import {brokenVariants, grant, grantRule, laws, stepLaws} from '../src/grant.ts'

const OPS = ['issue', 'use', 'revoke', 'end'] as const

const params = grant.encodeParams({})
type Req = {
  op: (typeof OPS)[number], actor: number, grantee?: number, command?: number, resource?: number, uses?: number,
  actorLive?: boolean, actorIsAgent?: boolean, actorIsGuide?: boolean, grantorHolds?: boolean, fromGrant?: boolean,
  grantorLive?: boolean, granteeLive?: boolean, expired?: boolean,
}
const req = ({op, actor, grantee = 0, command = 1, resource = 2, uses = 0, actorLive = true, actorIsAgent = false, actorIsGuide = false,
  grantorHolds = true, fromGrant = false, grantorLive = true, granteeLive = true, expired = false}: Req) =>
  grant.encodeInput({op, actor, grantee, command, resource, uses, actorLive, actorIsAgent, actorIsGuide, grantorHolds, fromGrant, grantorLive, granteeLive, expired})
const run = (...reqs: Req[]) => reqs.reduce((st, r) => generated.step(params, st, req(r)), generated.init(params))
const view = (st: State) => grant.decode(st) as {
  status: string, grantor: number, to: number, forCommand: number, forResource: number, usesLeft: number, used: boolean,
}
const at = (st: State, r: Req) => view(generated.step(params, generated.fork(st), req(r)))

// Person 1 grants person 3 two uses of command 1 on resource 2.
const issued: Req = {op: 'issue', actor: 1, grantee: 3, uses: 2}
const use: Req = {op: 'use', actor: 3}

test('every grant law is proven from any stored state', () => {
  const v = proveSteps(grant, laws, stepLaws, {from: 'any'})
  assert.ok(v.proven && v.checked && !v.assumes, JSON.stringify(v))
})
for (const law of stepLaws) {
  test(`grant proves separately: ${law.name}`, () => {
    const v = proveSteps(grant, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, JSON.stringify(v))
  })
}

test('broken variants cover every grant law and step law', () => {
  assert.deepEqual(new Set(brokenVariants.flatMap(v => v.breaks)), new Set([...laws, ...stepLaws].map(l => l.name)))
})
for (const variant of brokenVariants) {
  for (const name of variant.breaks) {
    test(`broken grant ${variant.bug} is refused for: ${name}`, () => {
      const invariant = laws.filter(l => l.name === name)
      const steps = stepLaws.filter(l => l.name === name)
      assert.equal(invariant.length + steps.length, 1)
      const context = steps.length ? laws.filter(l => !variant.breaks.includes(l.name)) : invariant
      const v = proveSteps(grantRule(variant.bug), context, steps, {from: 'any', search: false})
      assert.equal(v.proven, false, name)
      assert.equal(v.stuck, 'sat', JSON.stringify(v))
      assert.ok(v.goal?.includes(name), JSON.stringify(v))
    })
  }
}

test('grant crossCheck agrees with every law and update', () => {
  const r = grant.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

test('the generated grant module steps to the same states as the interpreter', () => {
  const rand = seeded(7)
  const interp = grant.interpreter()
  const flip = () => rand(4) > 0
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    let ours = generated.init(params)
    let theirs = interp.init(params)
    for (let d = 0; d < 20; d++) {
      const input = grant.encodeInput({
        op: OPS[rand(OPS.length)]!, actor: rand(4), grantee: rand(4), command: rand(3), resource: rand(3), uses: rand(4),
        actorLive: flip(), actorIsAgent: !flip(), actorIsGuide: !flip(), grantorHolds: flip(), fromGrant: !flip(),
        grantorLive: flip(), granteeLive: flip(), expired: !flip(),
      })
      ours = generated.step(params, ours, input)
      theirs = interp.step(params, theirs, input)
      assert.deepEqual(grant.decode(ours), grant.decode(theirs))
      assert.deepEqual(ours.scalars, theirs.scalars)
      steps++
    }
  }
  assert.equal(steps, 6000)
})

test('the generated grant module refuses values at 2^53', () => {
  const input = req(issued) as Record<string, number>
  assert.throws(() => generated.step(params, generated.init(params), {...input, actor: 2 ** 53}), RangeError)
  assert.throws(() => generated.step(params, generated.init(params), {...input, uses: 2 ** 53}), RangeError)
  assert.throws(() => grant.encodeInput({op: 'issue', actor: 1, grantee: 3, command: 1, resource: 2 ** 53, uses: 2, actorLive: true,
    actorIsAgent: false, actorIsGuide: false, grantorHolds: true, fromGrant: false, grantorLive: true, granteeLive: true, expired: false}), RangeError)
})

test('a live person who holds the capability issues a grant', () => {
  assert.deepEqual(view(run(issued)), {status: 'live', grantor: 1, to: 3, forCommand: 1, forResource: 2, usesLeft: 2, used: false})
})

test('a grant is not issued by an agent, a non-holder, a member who left, to oneself, or with no uses', () => {
  for (const bad of [
    {actorIsAgent: true}, {grantorHolds: false}, {actorLive: false}, {grantee: 1}, {uses: 0},
  ] as Partial<Req>[]) {
    assert.equal(view(run({...issued, ...bad})).status, 'unissued', JSON.stringify(bad))
  }
})

test('a capability held only through a grant cannot be granted on', () => {
  assert.equal(view(run({...issued, fromGrant: true})).status, 'unissued')
})

test('the grantee uses the grant on its command and resource until the uses run out', () => {
  const once = run(issued, use)
  assert.deepEqual([view(once).used, view(once).usesLeft], [true, 1])
  const twice = run(issued, use, use)
  assert.deepEqual([view(twice).used, view(twice).usesLeft], [true, 0])
  const thrice = run(issued, use, use, use)
  assert.deepEqual([view(thrice).used, view(thrice).usesLeft], [false, 0])
})

test('a use is refused when expired, by someone else, elsewhere, or after the grantor stops holding the capability', () => {
  const st = run(issued)
  for (const bad of [
    {expired: true}, {actor: 4}, {command: 9}, {resource: 9}, {grantorHolds: false}, {grantorLive: false}, {granteeLive: false},
  ] as Partial<Req>[]) {
    const after = at(st, {...use, ...bad})
    assert.deepEqual([after.used, after.usesLeft], [false, 2], JSON.stringify(bad))
  }
})

test('the grantor or a guide revokes, and revocation is final', () => {
  const st = run(issued)
  assert.equal(at(st, {op: 'revoke', actor: 3}).status, 'live', 'the grantee cannot revoke')
  assert.equal(at(st, {op: 'revoke', actor: 5, actorIsGuide: true}).status, 'revoked')
  const revoked = run(issued, {op: 'revoke', actor: 1})
  assert.deepEqual([view(revoked).status, view(revoked).usesLeft], ['revoked', 0])
  assert.equal(at(revoked, use).used, false)
  assert.equal(at(revoked, issued).status, 'revoked')
})

test('a grant ends when its grantor or grantee leaves', () => {
  const st = run(issued)
  assert.equal(at(st, {op: 'end', actor: 0}).status, 'live', 'both still members')
  const ended = run(issued, {op: 'end', actor: 0, grantorLive: false})
  assert.deepEqual([view(ended).status, view(ended).usesLeft], ['ended', 0])
  assert.equal(at(st, {op: 'end', actor: 0, granteeLive: false}).status, 'ended')
  assert.equal(at(ended, use).used, false)
})
