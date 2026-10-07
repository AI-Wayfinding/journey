import { describe, expect, it } from 'vitest';
import rules from '../../rules/rules.mjs';

describe('compiled pure Bend in Cloudflare workerd', () => {
  it('executes the shared rules module, not a host implementation', () => {
    for (const role of ['ReadOnly', 'ReadWrite'] as const) for (const historical of ['ReadOnly', 'ReadWrite'] as const) {
      const person = { $: 'Member' as const, id: 1n, kind: { $: 'Person' as const }, role: { $: role }, guide: true, owner: 0n, support: false, live: true };
      const agent = { $: 'Member' as const, id: 2n, kind: { $: 'Agent' as const }, role: { $: historical }, guide: false, owner: 1n, support: false, live: true };
      const members = { $: 'Con' as const, head: person, tail: { $: 'Con' as const, head: agent, tail: { $: 'Nil' as const } } };
      expect(rules.member_access({ $: 'Some', value: agent }, members)).toEqual({ $: 'Some', value: { $: role } });
    }
    expect(rules.person_guide({ $: 'Agent' }, true)).toBe(false);
    expect(rules.person_guide({ $: 'Person' }, true)).toBe(true);
    expect(rules.person_guide({ $: 'Person' }, false)).toBe(false);
    expect(rules.can_write({ $: 'ReadOnly' })).toBe(false);
  });
});
