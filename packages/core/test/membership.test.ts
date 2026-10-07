import { describe, expect, it } from 'vitest';
import rules from '@ai-wayfinding/rules';
import type { ProjectIndex, PrivateCredential } from '@ai-wayfinding/rules';
import { addingPerson } from '../src/membership.js';
import { canControl, canReadContent, canWriteContent, isPersonGuide, normalizedMembers, replayControl, replayProject, ruleList, ruleValues } from '../src/rules.js';
import type { LogState } from '../src/log.js';

const now = Date.parse('2027-01-01T00:00:00Z');
function state(): LogState {
  const member = (id: string, kind: 'person' | 'agent', addedBy?: string) => ({ id, kind, recipient: `${id}-recipient`, signingKey: `${id}-signing`, scope: 'read' as const, ...(addedBy ? { addedBy } : {}) });
  return { journey: 'journey', members: {
    person: { member: { ...member('person', 'person'), scope: 'readwrite' }, grants: ['members.manage'] },
    other: { member: member('other', 'person'), grants: ['members.manage'] },
    agent: { member: member('agent', 'agent', 'person'), grants: [] },
    sibling: { member: member('sibling', 'agent', 'person'), grants: [] },
    foreign: { member: member('foreign', 'agent', 'other'), grants: [] },
  }, grants: { person: ['members.manage'], other: ['members.manage'], agent: [], sibling: [], foreign: [] }, currentEpoch: 1, minClientVersion: '0.1.7', lastSeq: 0, lastHash: null };
}
const credential = (kind: 'Person' | 'Agent'): PrivateCredential => ({ $: kind === 'Person' ? 'PrivatePersonCredential' : 'PrivateAuthenticatedAgent' });

describe('agent membership parity', () => {
  it('uses the live person role and guide grant, never stored agent scope or grants', () => {
    const current = state();
    expect(canWriteContent(current, 'agent', now)).toBe(true);
    expect(isPersonGuide(current, 'agent')).toBe(true);
    expect(canControl(current, 'agent', 'Settings')).toBe(true);
    expect(canControl(current, 'agent', 'Profile', 'person')).toBe(true);
    expect(canControl(current, 'agent', 'Remove', 'person')).toBe(true);
    const removed = replayControl(current, 'agent', 'Remove', 'person', undefined, false, undefined, now);
    expect(removed.transition.$).toBe('Accepted');
    if (removed.transition.$ !== 'Accepted') throw Error('Removal denied');
    expect(ruleValues(removed.transition.members).map(m => removed.model.ids[Number(m.id) - 1])).toEqual(['other', 'foreign']);
    current.members.person!.grants = [];
    expect(isPersonGuide(current, 'agent')).toBe(false);
    expect(canControl(current, 'agent', 'Settings')).toBe(false);
    current.members.person!.member.scope = 'read';
    expect(canWriteContent(current, 'agent', now)).toBe(false);
    current.members.agent!.grants = ['members.manage'];
    expect(isPersonGuide(current, 'agent')).toBe(false);
    const model = normalizedMembers(current, [], now);
    expect(model.id('agent')).not.toBe(model.authorityId('agent'));
    expect(current.members.agent!.member.recipient).toBe('agent-recipient');
    expect(current.members.agent!.member.signingKey).toBe('agent-signing');
  });

  it('cannot outlive its person or obtain authority through another agent', () => {
    for (const failure of ['missing', 'expired', 'agent-parent', 'expired-agent'] as const) {
      const current = state();
      if (failure === 'missing') delete current.members.person;
      if (failure === 'expired') current.members.person!.member.expiresAt = '2026-01-01T00:00:00Z';
      if (failure === 'agent-parent') current.members.agent!.member.addedBy = 'sibling';
      if (failure === 'expired-agent') current.members.agent!.member.expiresAt = '2026-01-01T00:00:00Z';
      expect(addingPerson(current, 'agent', now)).toBeNull();
      expect(canReadContent(current, 'agent', now)).toBe(false);
      expect(canWriteContent(current, 'agent', now)).toBe(false);
      expect(replayControl(current, 'agent', 'Settings', undefined, undefined, false, undefined, now).transition.$).toBe('Denied');
    }
  });

  it('adds agents under its person and cannot forge another adding person', () => {
    const current = state();
    const addition = { id: 'new', kind: 'agent' as const, addedBy: 'person', recipient: 'recipient', signingKey: 'key', scope: 'read' as const };
    expect(replayControl(current, 'agent', 'Add', undefined, addition).transition.$).toBe('Accepted');
    expect(replayControl(current, 'agent', 'Add', undefined, { ...addition, addedBy: 'other' }).transition.$).toBe('Denied');
    current.members.other!.grants = [];
    expect(replayControl(current, 'agent', 'Remove', 'person').transition.$).toBe('LastGuide');
  });

  it('joins and leaves only the person participation and requires a live parent', () => {
    const current = state();
    current.projects = { items: { project: { id: 'project', revision: 0, state: 'getting-started' } }, participation: [], placements: {} };
    const joined = replayProject(current, 'project.join', { project: 'project', member: 'agent', predecessor: null }, 'agent', now);
    expect(joined.transition.$).toBe('ProjectAccepted');
    if (joined.transition.$ !== 'ProjectAccepted') throw Error('Join denied');
    expect(ruleValues(joined.transition.index.pairs).map(p => joined.model.ids[Number(p.person) - 1])).toEqual(['person']);
    const model = normalizedMembers(current, [], now);
    const index: ProjectIndex = { $: 'ProjectIndex', items: ruleList([{ $: 'ProjectInfo', id: 99n, revision: 1n, phase: { $: 'GettingStarted' } }]), pairs: ruleList([{ $: 'Participation', project: 99n, person: model.id('person'), revision: 1n, active: true }]), placements: ruleList([]) };
    expect(rules.project_apply(model.members, model.id('agent'), { $: 'Version', major: 0n, minor: 1n, patch: 7n }, false, index, { $: 'ArtifactIndex', items: ruleList([]), used: ruleList([]) }, 2n, { $: 'ProjectLeave', id: 99n, member: model.id('person'), predecessor: 1n }).$).toBe('ProjectAccepted');
    expect(rules.project_apply(model.members, model.id('agent'), { $: 'Version', major: 0n, minor: 1n, patch: 7n }, false, index, { $: 'ArtifactIndex', items: ruleList([]), used: ruleList([]) }, 2n, { $: 'ProjectJoin', id: 99n, member: model.id('agent'), predecessor: 0n }).$).toBe('ProjectDenied');
    delete current.members.person;
    const expired = normalizedMembers(current, [], now);
    expect(rules.project_participant(expired.members, index.pairs, 99n, expired.id('agent'))).toBe(false);
  });

  it('gives agent authors the same-person private audience and wrap delivery', () => {
    const current = state();
    const model = normalizedMembers(current, [], now);
    for (const author of ['person', 'agent', 'sibling']) {
      for (const actor of ['person', 'agent', 'sibling']) {
        const value = credential(actor === 'person' ? 'Person' : 'Agent');
        expect(rules.private_audience(model.members, model.id(author), model.id(actor), value)).toBe(true);
        for (const target of ['person', 'agent', 'sibling']) for (const write of [false, true]) {
          expect(rules.private_wrap_access(model.members, model.id(author), model.id(actor), model.id(target), value, write)).toBe(true);
        }
        expect(rules.private_wrap_access(model.members, model.id(author), model.id(actor), model.id('foreign'), value, true)).toBe(false);
      }
      expect(rules.private_audience(model.members, model.id(author), model.id('foreign'), credential('Agent'))).toBe(false);
      expect(rules.private_audience(model.members, model.id(author), model.id('agent'), { $: 'PrivateLinkCredential' })).toBe(false);
    }
    delete current.members.person;
    const missing = normalizedMembers(current, [], now);
    expect(rules.private_audience(missing.members, missing.id('agent'), missing.id('sibling'), credential('Agent'))).toBe(false);
  });

  it('preserves distinct private author and signing writer and denies a forged writer', () => {
    const action = { $: 'PrivateCreate' as const, artifact: 3n, author: 1n, writer: 2n, journey: 4n, version: 5n, typeHash: 6n, blobs: ruleList<bigint>([]) };
    const result = rules.private_apply(true, { $: 'None' }, 7n, 2n, 8n, 0n, 0n, action, ruleList([]));
    expect(result.$).toBe('PrivateAccepted');
    if (result.$ !== 'PrivateAccepted') throw Error('Create denied');
    expect(result.value.author).toBe(1n);
    expect(ruleValues(result.value.versions)[0]!.writer).toBe(2n);
    expect(rules.private_apply(true, { $: 'None' }, 7n, 2n, 8n, 0n, 0n, { ...action, writer: 9n }, ruleList([])).$).toBe('PrivateConflict');
    expect(rules.private_apply(false, { $: 'None' }, 7n, 2n, 8n, 0n, 0n, action, ruleList([])).$).toBe('PrivateDenied');
    expect(rules.private_bundle_recipient({ $: 'PrivateHandoff' }, { $: 'Person' }, false)).toBe(true);
    expect(rules.private_bundle_recipient({ $: 'PrivateHandoff' }, { $: 'Agent' }, false)).toBe(true);
  });
});
