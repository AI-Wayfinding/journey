import { describe, expect, it } from 'vitest';
import rules from '../../rules/rules.mjs';

describe('compiled pure Bend runtime', () => {
  it('intersects roles without widening an agent or granting guide authority', () => {
    for (const member of ['ReadOnly', 'ReadWrite'] as const) {
      for (const setting of ['ReadOnly', 'ReadWrite'] as const) {
        expect(rules.can_write(rules.agent_access({ $: member }, { $: setting })))
          .toBe(member === 'ReadWrite' && setting === 'ReadWrite');
      }
    }
    expect(rules.person_guide({ $: 'Agent' }, true)).toBe(false);
    expect(rules.person_guide({ $: 'Person' }, true)).toBe(true);
    expect(rules.person_guide({ $: 'Person' }, false)).toBe(false);
    expect(rules.can_write({ $: 'ReadOnly' })).toBe(false);
  });
});
