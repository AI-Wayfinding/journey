import { canControl, projectMembers, replayControl } from './rules.js';
import { hashEntry, recipientsHash, signEntry } from './log.js';
import type { LogEntry, LogState } from './log.js';
import { generateJourneyKey, wrapJourneyKey } from './teamKey.js';
import type { JourneyKey, KeyWrap } from './teamKey.js';
export async function removeAndRotate(state: LogState, target: string, actor: string, signingKey: CryptoKey): Promise<{ entries: [LogEntry, LogEntry]; key: JourneyKey; wraps: KeyWrap[] }> {
  if (!canControl(state, actor, 'Rotate')) throw new Error('A person with members.manage must act');
  if (target === actor) throw new Error('A remaining acting holder must complete rotation after self-removal');
  const { transition, model } = replayControl(state, actor, 'Remove', target);
  if (transition.$ !== 'Accepted') throw new Error(transition.$ === 'LastGuide' ? 'Cannot remove last holder' : 'Member not found or removal not authorized');
  const projected: LogState = { ...state };
  projectMembers(projected, transition, model);
  const remaining = projected.members;
  const at = new Date().toISOString();
  const first = await signEntry({ v: 1, seq: state.lastSeq + 1, prev: state.lastHash, at, actor, type: 'member.remove', body: { member: target } }, signingKey);
  const key = generateJourneyKey(state.currentEpoch + 1);
  const wraps = await wrapJourneyKey(key, Object.values(remaining).map(({ member }) => ({ id: member.id, recipient: member.recipient })));
  const second = await signEntry({ v: 1, seq: first.seq + 1, prev: await hashEntry(first), at, actor, type: 'key.rotate', body: { epoch: key.epoch, recipientsHash: await recipientsHash(remaining) } }, signingKey);
  return { entries: [first, second], key, wraps };
}

/** A personal removal does not confer rotation authority. */
export async function removeMemberEntry(state: LogState, target: string, actor: string, signingKey: CryptoKey): Promise<LogEntry> {
  if (!canControl(state, actor, 'Remove', target)) throw new Error('Removal not authorized or last guide');
  return signEntry({ v: 1, seq: state.lastSeq + 1, prev: state.lastHash, at: new Date().toISOString(), actor, type: 'member.remove', body: { member: target } }, signingKey);
}
/** A remaining guide can resume an interrupted removal, with either role. */
export async function completeRotation(state: LogState, actor: string, signingKey: CryptoKey): Promise<{ entry: LogEntry; key: JourneyKey; wraps: KeyWrap[] }> {
  if (!canControl(state, actor, 'Rotate')) throw new Error('A person with members.manage must act');
  const key = generateJourneyKey(state.currentEpoch + 1);
  const wraps = await wrapJourneyKey(key, Object.values(state.members).map(({ member }) => ({ id: member.id, recipient: member.recipient })));
  const entry = await signEntry({ v: 1, seq: state.lastSeq + 1, prev: state.lastHash, at: new Date().toISOString(), actor, type: 'key.rotate', body: { epoch: key.epoch, recipientsHash: await recipientsHash(state.members) } }, signingKey);
  return { entry, key, wraps };
}
