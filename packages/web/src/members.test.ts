import { describe, expect, it } from 'vitest';
import type { DerivedMember, LogState, Member } from '@ai-wayfinding/core';
import { accountAgents, membersSummary } from './members.js';

const entry = (id: string, kind: Member['kind'], details: Partial<Member> = {}, name?: string): DerivedMember => ({
  member: { id, kind, recipient: 'recipient', signingKey: 'signing', ...details }, grants: [], ...(name ? { profile: { name } } : {}),
});

const state = (members: Record<string, DerivedMember>): LogState => ({ members } as unknown as LogState);

describe('account agents', () => {
  it('lists only agents added by this account’s journey principal, preserving grant expiry', () => {
    const members: Record<string, DerivedMember> = {
      me: entry('me', 'person'), other: entry('other', 'person'),
      mine: entry('mine', 'agent', { addedBy: 'me', name: '<My helper>', expiresAt: '2026-10-08T12:00:00Z' }),
      theirs: entry('theirs', 'agent', { addedBy: 'other', name: 'Not mine' }),
      legacy123: entry('legacy123', 'agent', { addedBy: 'me' }),
      expired: entry('expired', 'agent', { addedBy: 'me', expiresAt: '2020-01-01T00:00:00Z' }),
    };
    expect(accountAgents(state(members), 'me')).toEqual([
      { id: 'mine', name: '<My helper>', expiresAt: '2026-10-08T12:00:00Z' },
      { id: 'legacy123', name: 'Agent legacy12' },
      { id: 'expired', name: 'Agent expired', expiresAt: '2020-01-01T00:00:00Z' },
    ]);
    expect(accountAgents(state(members), 'missing')).toEqual([]);
    delete members.mine;
    expect(accountAgents(state(members), 'me').map(agent => agent.id)).not.toContain('mine');
  });
});

describe('journey members summary', () => {
  it('uses a person’s profile name and singular or plural agent counts', () => {
    const members = { me: entry('me', 'person', {}, 'Dan'), helper: entry('helper', 'agent') };
    expect(membersSummary(members)).toBe('Dan and 1 agent');
    expect(membersSummary({ ...members, helper2: entry('helper2', 'agent') })).toBe('Dan and 2 agents');
    expect(membersSummary({ me: members.me })).toBe('Dan');
  });
  it('handles unnamed people, support, and several people without exposing emails or IDs', () => {
    expect(membersSummary({ me: entry('private-id', 'person') })).toBe('Person');
    expect(membersSummary({ support: entry('support', 'person', { support: true }) })).toBe('Wayfinding support (Hypha)');
    expect(membersSummary({ a: entry('a', 'person'), b: entry('b', 'person'), agent: entry('agent', 'agent') })).toBe('2 people and 1 agent');
    expect(membersSummary({})).toBe('0 people');
  });
});
