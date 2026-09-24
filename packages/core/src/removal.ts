import { hashEntry, recipientsHash, signEntry } from './log.js';
import type { LogEntry, LogState } from './log.js';
import { generateJourneyKey, wrapJourneyKey } from './teamKey.js';
import type { JourneyKey, KeyWrap } from './teamKey.js';
export async function removeAndRotate(state: LogState, target: string, actor: string, signingKey: CryptoKey): Promise<{ entries: [LogEntry, LogEntry]; key: JourneyKey; wraps: KeyWrap[] }> {
  if (state.members[actor]?.member.kind !== 'person' || !state.grants[actor]?.includes('members.manage')) throw new Error('A person with members.manage must act');
  if (target === actor) throw new Error('A remaining acting holder must complete rotation after self-removal');
  const removed = state.members[target];
  if (!removed) throw new Error('Member not found');
  const remaining = Object.fromEntries(Object.entries(state.members).filter(([id, value]) => id !== target && (removed.member.kind !== 'person' || value.member.addedBy !== target)));
  if (!Object.entries(remaining).some(([id, value]) => value.member.kind === 'person' && state.grants[id]?.includes('members.manage'))) throw new Error('Cannot remove last holder');
  const at = new Date().toISOString();
  const first = await signEntry({ v: 1, seq: state.lastSeq + 1, prev: state.lastHash, at, actor, type: 'member.remove', body: { member: target } }, signingKey);
  const key = generateJourneyKey(state.currentEpoch + 1);
  const wraps = await wrapJourneyKey(key, Object.values(remaining).map(({ member }) => ({ id: member.id, recipient: member.recipient })));
  const second = await signEntry({ v: 1, seq: first.seq + 1, prev: await hashEntry(first), at, actor, type: 'key.rotate', body: { epoch: key.epoch, recipientsHash: await recipientsHash(remaining) } }, signingKey);
  return { entries: [first, second], key, wraps };
}
