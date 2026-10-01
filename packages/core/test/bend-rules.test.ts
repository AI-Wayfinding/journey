import { describe, expect, it } from 'vitest';
import rules from '@ai-wayfinding/rules';
import type { Member as RuleMember } from '@ai-wayfinding/rules';
import { canControl, canReadContent, canWriteContent, effectiveScope, normalizedMembers, projectMembers, replayControl, ruleList, ruleValues } from '../src/rules.js';
import type { LogState, Member } from '../src/log.js';

const person = (id: bigint, guide = false, role: RuleMember['role']['$'] = 'ReadWrite'): RuleMember => ({ $: 'Member', id, kind: { $: 'Person' }, role: { $: role }, guide, owner: 0n, support: false, live: true });
const agent = (id: bigint, owner: bigint): RuleMember => ({ ...person(id), kind: { $: 'Agent' }, owner });
const hostMember = (id: string, kind: Member['kind'] = 'person', scope?: Member['scope'], addedBy?: string): Member => ({ id, kind, recipient: 'age-recipient', signingKey: 'signing-key', ...(scope ? { scope } : {}), ...(addedBy ? { addedBy } : {}) });
function state(): LogState {
  return { journey: 'journey', members: {
    guide: { member: hostMember('guide'), grants: ['members.manage'] },
    person: { member: hostMember('person', 'person', 'read'), grants: [], profile: { name: 'Person' } },
    agent: { member: hostMember('agent', 'agent', 'readwrite', 'person'), grants: [] },
    reader: { member: hostMember('reader', 'agent', 'read', 'person'), grants: [] },
  }, grants: { guide: ['members.manage'], person: [], agent: [], reader: [] }, currentEpoch: 1, minClientVersion: '0.1.0', lastSeq: 0, lastHash: null };
}

describe('production Bend transitions and adapters', () => {
  it('keeps content roles separate from guide and personal authority', () => {
    const current = state();
    current.members.guide!.member.scope = 'read';
    expect(canWriteContent(current, 'guide')).toBe(false);
    expect(canControl(current, 'guide', 'Settings')).toBe(true);
    expect(canControl(current, 'person', 'Settings')).toBe(false);
    expect(canControl(current, 'person', 'Profile', 'person')).toBe(true);
    expect(canControl(current, 'guide', 'Profile', 'person')).toBe(false);
    expect(canControl(current, 'agent', 'Profile', 'agent')).toBe(false);
    expect(canControl(current, 'guide', 'Guide', 'agent', true)).toBe(false);
    expect(canControl(current, 'guide', 'Remove', 'guide')).toBe(false);
    expect(canControl(current, 'guide', 'Guide', 'guide', false)).toBe(false);
    expect(canControl(current, 'person', 'Remove', 'agent')).toBe(true);
    expect(canControl(current, 'person', 'Remove', 'guide')).toBe(false);
    expect(canControl(current, 'person', 'Rotate')).toBe(false);
  });

  it('rechecks the adding person and original agent limit after a role change', () => {
    const current = state();
    expect(effectiveScope(current, 'agent')).toBe('read');
    expect(canWriteContent(current, 'agent')).toBe(false);
    const denied = replayControl(current, 'person', 'RoleChange', 'person', undefined, false, { $: 'ReadWrite' });
    expect(denied.transition.$).toBe('Denied');
    const changed = replayControl(current, 'guide', 'RoleChange', 'person', undefined, false, { $: 'ReadWrite' });
    expect(changed.transition.$).toBe('Accepted');
    if (changed.transition.$ !== 'Accepted') throw Error('Role change rejected');
    projectMembers(current, changed.transition, changed.model);
    expect(current.members.person!.profile).toEqual({ name: 'Person' });
    expect(current.members.person!.member.scope).toBe('readwrite');
    expect(canWriteContent(current, 'agent')).toBe(true);
    expect(canWriteContent(current, 'reader')).toBe(false);
    current.members.person!.member.expiresAt = '2000-01-01T00:00:00.000Z';
    expect(canReadContent(current, 'agent')).toBe(false);
    delete current.members.person;
    expect(canReadContent(current, 'reader')).toBe(false);
    expect(canWriteContent(current, 'agent')).toBe(false);
  });

  it('removes all owned agents wherever they occur and rotates only to survivors', () => {
    const population = ruleList([person(1n, true), agent(5n, 2n), person(2n), agent(6n, 1n), agent(7n, 2n), person(8n)]);
    const removed = rules.apply(population, { $: 'Remove', actor: 2n, target: 2n });
    expect(removed.$).toBe('Accepted');
    if (removed.$ !== 'Accepted') throw Error('Self leave rejected');
    expect(ruleValues(removed.members).map(member => member.id)).toEqual([1n, 6n, 8n]);
    expect(rules.all_survive(2n, true, removed.members)).toBe(true);
    expect(ruleValues(rules.remove_and_rotate(population, 2n, true, 4n))).toEqual([
      { $: 'Holding', principal: 1n, epoch: 4n }, { $: 'Holding', principal: 6n, epoch: 4n }, { $: 'Holding', principal: 8n, epoch: 4n },
    ]);
    for (const candidate of [person(2n), agent(5n, 2n), agent(7n, 2n)]) expect(rules.next_holding(2n, true, candidate, 4n)).toEqual({ $: 'None' });
    expect(rules.apply(ruleList([person(1n, true)]), { $: 'Remove', actor: 1n, target: 1n }).$).toBe('LastGuide');
  });

  it('replays controls in order and stops at an unauthorized entry', () => {
    const initial = ruleList([person(1n, true), person(2n)]);
    const controls = ruleList([
      { $: 'Add' as const, actor: 2n, member: agent(3n, 2n) },
      { $: 'Guide' as const, actor: 2n, target: 2n, guide: true },
      { $: 'Remove' as const, actor: 1n, target: 2n },
    ]);
    expect(rules.replay(controls, { $: 'Accepted', members: initial })).toEqual({ $: 'Denied' });
    expect(rules.apply(initial, { $: 'Add', actor: 2n, member: { ...agent(3n, 2n), guide: true } }).$).toBe('Denied');
    expect(rules.apply(initial, { $: 'Add', actor: 2n, member: agent(3n, 1n) }).$).toBe('Denied');
  });

  it('does not carry unnamed caller fields across normalization or projection', () => {
    const current = state();
    const addition = { ...hostMember('added', 'agent', 'read', 'person'), secret: 'do-not-store' };
    const next = replayControl(current, 'person', 'Add', undefined, addition);
    expect(next.transition.$).toBe('Accepted');
    expect(JSON.stringify(normalizedMembers(current).members, (_, value) => typeof value === 'bigint' ? String(value) : value)).not.toContain('do-not-store');
    if (next.transition.$ !== 'Accepted') throw Error('Agent addition rejected');
    projectMembers(current, next.transition, next.model, addition);
    expect(JSON.stringify(current)).not.toContain('do-not-store');
  });
});
