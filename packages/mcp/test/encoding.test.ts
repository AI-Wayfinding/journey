import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journey } from '../../rules/src/journey.ts';
import { project } from '../../rules/src/project.ts';
import { agentCard } from '../../rules/src/agentCard.ts';
import { grant } from '../../rules/src/grant.ts';
import { JOURNEY, PROJECT, AGENT_CARD, GRANT, encodeJourney, encodeProject, encodeAgentCard, encodeGrant } from '../../rules/src/encode.ts';

test('coordination: runtime encoders match every model choice and host flag', () => {
  assert.deepEqual([JOURNEY.op.length, JOURNEY.role.length, JOURNEY.policy.length, JOURNEY.need.length, PROJECT.op.length, PROJECT.status.length, AGENT_CARD.op.length, AGENT_CARD.need.length, GRANT.op.length], [14, 2, 3, 3, 5, 4, 4, 3, 4]);
  for (const op of JOURNEY.op) for (const role of JOURNEY.role) for (const newPolicy of JOURNEY.policy) for (const need of JOURNEY.need) {
    const input = { op, actor: 3, subject: 5, role, newPolicy, need };
    assert.deepEqual(encodeJourney(input), journey.encodeInput(input));
  }
  for (const op of PROJECT.op) for (const to of PROJECT.status) for (const actorIsLive of [false, true]) {
    const input = { op, actor: 3, actorIsLive, to };
    assert.deepEqual(encodeProject(input), project.encodeInput(input));
  }
  // Every boolean combination, including a signed card whose person has left.
  for (const op of AGENT_CARD.op) for (const need of AGENT_CARD.need) for (let bits = 0; bits < 128; bits++) {
    const input = { op, need, newRead: !!(bits & 1), newWrite: !!(bits & 2), newGrant: !!(bits & 4), personSigned: !!(bits & 8), personHas: !!(bits & 16), personLive: !!(bits & 32), agentLive: !!(bits & 64) };
    assert.deepEqual(encodeAgentCard(input), agentCard.encodeInput(input));
  }
  for (const op of GRANT.op) for (let bits = 0; bits < 256; bits++) {
    const input = { op, actor: 3, grantee: 5, command: 2, resource: 7, uses: 9, actorLive: !!(bits & 1), actorIsAgent: !!(bits & 2), actorIsGuide: !!(bits & 4), grantorHolds: !!(bits & 8), fromGrant: !!(bits & 16), grantorLive: !!(bits & 32), granteeLive: !!(bits & 64), expired: !!(bits & 128) };
    assert.deepEqual(encodeGrant(input), grant.encodeInput(input));
  }
});

test('coordination: encoders reject unsafe naturals before rule execution', () => {
  for (const value of [-1, 0.5, NaN, Infinity, 2 ** 53]) {
    assert.throws(() => encodeJourney({ op: 'join', actor: value }), RangeError);
    assert.throws(() => encodeJourney({ op: 'invite', actor: 1, subject: value }), RangeError);
    assert.throws(() => encodeProject({ op: 'join', actor: value, actorIsLive: true }), RangeError);
    for (const field of ['actor', 'grantee', 'command', 'resource', 'uses']) {
      assert.throws(() => encodeGrant({ op: 'issue', actor: 1, [field]: value }), RangeError);
    }
  }
  assert.equal(encodeGrant({ op: 'issue', actor: 1, uses: Number.MAX_SAFE_INTEGER }).uses, Number.MAX_SAFE_INTEGER);
});
