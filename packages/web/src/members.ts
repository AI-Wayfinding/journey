import type { DerivedMember } from '@ai-wayfinding/core';

type Roster = Record<string, DerivedMember>;

export function accountAgents(members: Roster, principal: string): { id: string; name: string; expiresAt?: string }[] {
  return Object.values(members).filter(({ member }) => member.kind === 'agent' && member.addedBy === principal).map(({ member }) => ({
    id: member.id,
    name: member.name ?? `Agent ${member.id.slice(0, 8)}`,
    ...(member.expiresAt ? { expiresAt: member.expiresAt } : {}),
  }));
}

export function membersSummary(members: Roster): string {
  const people = Object.values(members).filter(({ member }) => member.kind === 'person');
  const agents = Object.values(members).filter(({ member }) => member.kind === 'agent').length;
  const names = people.map(({ member, profile }) => profile?.name || (member.support ? 'Wayfinding support (Hypha)' : 'Person'));
  const peopleLabel = names.length === 1 ? names[0]! : `${names.length} people`;
  return agents ? `${peopleLabel} and ${agents} ${agents === 1 ? 'agent' : 'agents'}` : peopleLabel;
}
