import { describe, expect, it } from 'vitest';
import rules from '../../rules/rules.mjs';

describe('compiled pure Bend in Cloudflare workerd', () => {
  it('executes the shared rules module, not a host implementation', () => {
    expect(rules.agent_access({ $: 'ReadOnly' }, { $: 'ReadWrite' })).toEqual({ $: 'ReadOnly' });
    expect(rules.agent_access({ $: 'ReadWrite' }, { $: 'ReadOnly' })).toEqual({ $: 'ReadOnly' });
    expect(rules.can_write(rules.agent_access({ $: 'ReadWrite' }, { $: 'ReadWrite' }))).toBe(true);
    expect(rules.person_guide({ $: 'Agent' }, true)).toBe(false);
    expect(rules.person_guide({ $: 'Person' }, true)).toBe(true);
    expect(rules.person_guide({ $: 'Person' }, false)).toBe(false);
    expect(rules.can_write({ $: 'ReadOnly' })).toBe(false);
  });
});
