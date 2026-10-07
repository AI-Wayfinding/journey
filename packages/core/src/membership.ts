import type { LogState, Member } from './log.js';

/** Resolve authority only. Writers, signatures and recipients keep their own ID. */
export function addingPerson(state: LogState, principal: string, now?: number): Member | null {
  const member = state.members[principal]?.member;
  const live = (value: Member | undefined): value is Member => value !== undefined &&
    (now === undefined || value.expiresAt === undefined || Date.parse(value.expiresAt) > now);
  if (!live(member)) return null;
  if (member.kind === 'person') return member;
  const person = member.addedBy === undefined ? undefined : state.members[member.addedBy]?.member;
  return live(person) && person.kind === 'person' ? person : null;
}
