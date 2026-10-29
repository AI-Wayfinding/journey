import assert from 'node:assert/strict'
import {test} from 'node:test'
import {proveSteps} from 'gdp-wired'
import {seeded, type State} from 'gdp-wired/machine'
import * as generated from '../generated/journey.js'
import {brokenVariants, journey, journeyRule, laws, stepLaws} from '../src/journey.ts'

const OPS = ['found', 'policy', 'invite', 'request', 'join', 'admit', 'refuse', 'role', 'guide', 'unguide', 'addAgent', 'remove', 'leave', 'check'] as const
const ROLES = ['read', 'write'] as const
const POLICIES = ['request', 'open', 'invite'] as const
const NEEDS = ['read', 'write', 'guide'] as const

const params = journey.encodeParams({slots: 8})
type Req = {op: (typeof OPS)[number], actor: number, subject?: number, role?: 'read' | 'write', newPolicy?: 'request' | 'open' | 'invite', need?: 'read' | 'write' | 'guide'}
const req = ({op, actor, subject = actor, role = 'read', newPolicy = 'request', need = 'read'}: Req) =>
  journey.encodeInput({op, actor, subject, role, newPolicy, need})
const run = (...reqs: Req[]) => reqs.reduce((st, r) => generated.step(params, st, req(r)), generated.init(params))
const view = (st: State) => journey.decode(st) as {
  founded: boolean, policy: string, defaultRole: string, allowed: boolean,
  Members: Record<string, string>, Roles: Record<string, string>, Pending: Record<string, string>,
}
// decode() leaves out plain number maps, so the guide marks and adding persons are read from the state's maps.
const guideOf = (st: State, id: number) => st.maps.Guides?.get(id) ?? 0
const addedBy = (st: State, id: number) => st.maps.AddedBy?.get(id) ?? 0
const kind = (st: State, id: number) => view(st).Members[id] ?? 'none'
const allowed = (st: State, actor: number, need: 'read' | 'write' | 'guide') => view(generated.step(params, st, req({op: 'check', actor, need}))).allowed

// Person 0 founds an open journey whose newcomers read only.
const founded: Req = {op: 'found', actor: 0, newPolicy: 'open', role: 'read'}

test('every journey law is proven from any stored state', () => {
  const v = proveSteps(journey, laws, stepLaws, {from: 'any'})
  assert.ok(v.proven && v.checked && !v.assumes, JSON.stringify(v))
})
for (const law of stepLaws) {
  test(`journey proves separately: ${law.name}`, () => {
    const v = proveSteps(journey, laws, [law], {from: 'any'})
    assert.ok(v.proven && v.checked && !v.assumes, JSON.stringify(v))
  })
}

test('broken variants cover every journey law and step law', () => {
  assert.deepEqual(new Set(brokenVariants.flatMap(v => v.breaks)), new Set([...laws, ...stepLaws].map(l => l.name)))
})
for (const variant of brokenVariants) {
  for (const name of variant.breaks) {
    test(`broken journey ${variant.bug} is refused for: ${name}`, () => {
      const invariant = laws.filter(l => l.name === name)
      const steps = stepLaws.filter(l => l.name === name)
      assert.equal(invariant.length + steps.length, 1)
      // A step law is checked beside the laws this variant does not also break,
      // so the refusal names the step law itself.
      const context = steps.length ? laws.filter(l => !variant.breaks.includes(l.name)) : invariant
      const v = proveSteps(journeyRule(variant.bug), context, steps, {from: 'any', search: false})
      assert.equal(v.proven, false, name)
      assert.equal(v.stuck, 'sat', JSON.stringify(v))
      assert.ok(v.goal?.includes(name), JSON.stringify(v))
    })
  }
}

test('journey crossCheck agrees with every law and update', () => {
  const r = journey.crossCheck(laws, stepLaws)
  assert.equal(r.failure, undefined)
  assert.ok(r.checked > 0)
})

test('the generated journey module steps to the same states as the interpreter', () => {
  const rand = seeded(7)
  const interp = journey.interpreter()
  let steps = 0
  for (let trial = 0; trial < 300; trial++) {
    const p = journey.encodeParams({slots: 2 + rand(4)})
    let ours = generated.init(p)
    let theirs = interp.init(p)
    // Start most runs from a founded journey so later requests do something.
    if (rand(4) > 0) {
      const f = journey.encodeInput({op: 'found', actor: 0, subject: 0, role: 'write', newPolicy: POLICIES[rand(3)]!, need: 'read'})
      ours = generated.step(p, ours, f)
      theirs = interp.step(p, theirs, f)
    }
    for (let d = 0; d < 20; d++) {
      const n = p.slots!
      const input = journey.encodeInput({
        op: OPS[rand(OPS.length)]!, actor: rand(n), subject: rand(n),
        role: ROLES[rand(2)]!, newPolicy: POLICIES[rand(3)]!, need: NEEDS[rand(3)]!,
      })
      ours = generated.step(p, ours, input)
      theirs = interp.step(p, theirs, input)
      assert.deepEqual(journey.decode(ours), journey.decode(theirs))
      assert.deepEqual(ours.maps, theirs.maps)
      steps++
    }
  }
  assert.equal(steps, 6000)
})

test('the generated journey module refuses ids outside the slots and values at 2^53', () => {
  assert.throws(() => generated.init({slots: 2 ** 53}), RangeError)
  assert.throws(() => generated.step(params, generated.init(params), req({op: 'found', actor: 8})), RangeError)
  assert.throws(() => journey.encodeInput({op: 'join', actor: 2 ** 53, subject: 0, role: 'read', newPolicy: 'open', need: 'read'}), RangeError)
  assert.throws(() => generated.step(params, generated.init(params), {op: 0, actor: 2 ** 53, subject: 0, role: 0, newPolicy: 0, need: 0}), RangeError)
})

test('the founder is a read-write guide and newcomers get the default role', () => {
  const st = run(founded, {op: 'join', actor: 1})
  assert.deepEqual([kind(st, 0), view(st).Roles[0], guideOf(st, 0)], ['person', 'write', 1])
  assert.deepEqual([kind(st, 1), view(st).Roles[1] ?? 'read', guideOf(st, 1)], ['person', 'read', 0])
})

test('nobody joins before the journey is founded', () => {
  assert.equal(kind(run({op: 'join', actor: 1}), 1), 'none')
})

test('under the request policy a person joins only when a guide admits their request', () => {
  const asked = run({op: 'found', actor: 0, newPolicy: 'request', role: 'write'}, {op: 'join', actor: 1}, {op: 'request', actor: 1})
  assert.equal(kind(asked, 1), 'none')
  assert.equal(view(asked).Pending[1], 'requested')
  const byMember = generated.step(params, asked, req({op: 'admit', actor: 1, subject: 1}))
  assert.equal(kind(byMember, 1), 'none')
  const admitted = generated.step(params, asked, req({op: 'admit', actor: 0, subject: 1}))
  assert.equal(kind(admitted, 1), 'person')
  assert.equal(view(admitted).Roles[1], 'write')
  assert.equal(view(admitted).Pending[1] ?? 'none', 'none')
  const refused = generated.step(params, asked, req({op: 'refuse', actor: 0, subject: 1}))
  assert.equal(view(refused).Pending[1] ?? 'none', 'none')
})

test('an invite-only journey admits invited people only, and only guides invite', () => {
  const base = run({op: 'found', actor: 0, newPolicy: 'invite'}, {op: 'join', actor: 1}, {op: 'request', actor: 1})
  assert.equal(kind(base, 1), 'none')
  assert.equal(view(base).Pending[1] ?? 'none', 'none')
  const invited = generated.step(params, base, req({op: 'invite', actor: 0, subject: 1}))
  assert.equal(kind(generated.step(params, invited, req({op: 'join', actor: 1})), 1), 'person')
  const withMember = run({op: 'found', actor: 0, newPolicy: 'open'}, {op: 'join', actor: 2}, {op: 'policy', actor: 0, newPolicy: 'invite'})
  const byMember = generated.step(params, withMember, req({op: 'invite', actor: 2, subject: 3}))
  assert.equal(view(byMember).Pending[3] ?? 'none', 'none')
})

test('only a guide changes the policy, roles and guide marks', () => {
  const st = run(founded, {op: 'join', actor: 1}, {op: 'join', actor: 2})
  const tries = [
    req({op: 'policy', actor: 1, newPolicy: 'invite', role: 'write'}),
    req({op: 'role', actor: 1, subject: 2, role: 'write'}),
    req({op: 'guide', actor: 1, subject: 1}),
  ]
  for (const t of tries) assert.deepEqual(journey.decode(generated.step(params, st, t)), {...journey.decode(st), allowed: false})
  const byGuide = [
    req({op: 'role', actor: 0, subject: 2, role: 'write'}),
    req({op: 'guide', actor: 0, subject: 1}),
  ].reduce((s, t) => generated.step(params, s, t), st)
  assert.equal(view(byGuide).Roles[2], 'write')
  assert.equal(guideOf(byGuide, 1), 1)
})

test('the last guide can neither leave, be removed nor give up the mark, until another guide exists', () => {
  const st = run(founded, {op: 'join', actor: 1})
  assert.equal(kind(generated.step(params, st, req({op: 'leave', actor: 0})), 0), 'person')
  assert.equal(guideOf(generated.step(params, st, req({op: 'unguide', actor: 0, subject: 0})), 0), 1)
  assert.equal(kind(generated.step(params, st, req({op: 'remove', actor: 0, subject: 0})), 0), 'person')
  const two = generated.step(params, st, req({op: 'guide', actor: 0, subject: 1}))
  const left = generated.step(params, two, req({op: 'leave', actor: 0}))
  assert.equal(kind(left, 0), 'none')
  assert.equal(guideOf(left, 1), 1)
})

test('an agent acts with its live person\'s authority, never its own', () => {
  // Person 1 reads only; their agent 3 cannot write. Person 0 writes and guides; agent 4 can do both.
  const st = run(founded, {op: 'join', actor: 1}, {op: 'addAgent', actor: 1, subject: 3}, {op: 'addAgent', actor: 0, subject: 4})
  assert.deepEqual([kind(st, 3), addedBy(st, 3)], ['agent', 1])
  assert.deepEqual([allowed(st, 3, 'read'), allowed(st, 3, 'write'), allowed(st, 3, 'guide')], [true, false, false])
  assert.deepEqual([allowed(st, 4, 'read'), allowed(st, 4, 'write'), allowed(st, 4, 'guide')], [true, true, true])
  // Raising the person's role raises the agent's at once.
  const raised = generated.step(params, st, req({op: 'role', actor: 0, subject: 1, role: 'write'}))
  assert.equal(allowed(raised, 3, 'write'), true)
  // An agent cannot add agents, and nobody outside the journey has any authority.
  assert.equal(kind(generated.step(params, st, req({op: 'addAgent', actor: 3, subject: 5})), 5), 'none')
  assert.deepEqual([allowed(st, 6, 'read'), allowed(st, 6, 'write')], [false, false])
})

test('removing or losing a person removes their agents in the same step', () => {
  const st = run(founded, {op: 'join', actor: 1}, {op: 'addAgent', actor: 1, subject: 3}, {op: 'addAgent', actor: 1, subject: 4}, {op: 'addAgent', actor: 0, subject: 5})
  for (const gone of [generated.step(params, st, req({op: 'remove', actor: 0, subject: 1})), generated.step(params, st, req({op: 'leave', actor: 1}))]) {
    assert.deepEqual([1, 3, 4, 5].map(id => kind(gone, id)), ['none', 'none', 'none', 'agent'])
    assert.equal(allowed(gone, 3, 'read'), false)
  }
  // A person may remove their own agent; another non-guide member may not.
  const own = generated.step(params, st, req({op: 'remove', actor: 1, subject: 3}))
  assert.equal(kind(own, 3), 'none')
  const other = generated.step(params, st, req({op: 'remove', actor: 1, subject: 5}))
  assert.equal(kind(other, 5), 'agent')
})

test('an agent is not turned into a person or moved to another person', () => {
  const st = run(founded, {op: 'join', actor: 1}, {op: 'addAgent', actor: 1, subject: 3})
  assert.equal(kind(generated.step(params, st, req({op: 'join', actor: 3})), 3), 'agent')
  const again = generated.step(params, st, req({op: 'addAgent', actor: 0, subject: 3}))
  assert.equal(addedBy(again, 3), 1)
})
