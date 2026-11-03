import assert from 'node:assert/strict'
import {test} from 'node:test'
import {capabilities, capabilityCount, neverAssignable} from '../src/capabilities.ts'

test('the catalogue has exactly the decided account and journey capabilities with stable ids', () => {
  assert.deepEqual(capabilities.map(c => c.id), Array.from({length: 20}, (_, i) => i))
  assert.equal(capabilityCount, 20)
  assert.deepEqual(capabilities.filter(c => c.scope === 'account').map(c => c.name), ['journey.create', 'account.nickname', 'agent.remove'])
  assert.deepEqual(capabilities.filter(c => c.scope === 'journey').map(c => c.name), [
    'read', 'artifact.write', 'artifact.delete', 'post', 'topic.create', 'board.manage', 'project.create', 'project.edit',
    'task.manage', 'round.create', 'round.run', 'round.contribute', 'member.invite', 'member.admit', 'member.remove', 'journey.policy', 'grant.issue',
  ])
  assert.deepEqual(capabilities.map(c => c.authority), [
    'member', 'member', 'member', 'member', 'write', 'owner', 'member', 'member', 'guide', 'write',
    'lead', 'write', 'write', 'facilitator', 'member', 'guide', 'guide', 'guide', 'guide', 'member',
  ])
})

test('console-only operations have no assignable capability id', () => {
  assert.deepEqual(neverAssignable, ['agent.add', 'client.bind', 'card.change', 'passkey.manage'])
  const names: readonly string[] = capabilities.map(c => c.name)
  for (const name of neverAssignable) assert.equal(names.includes(name), false)
})
