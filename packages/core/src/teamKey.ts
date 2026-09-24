import type { AgeIdentity, AgeRecipient } from './keys.js';
import { decode, encode } from './codec.js';
import { openIdentity, sealIdentity } from './keys.js';
export interface JourneyKey { epoch: number; key: Uint8Array }
export interface KeyWrap { epoch: number; recipient: string; ciphertext: string }
export function generateJourneyKey(epoch = 1): JourneyKey {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Invalid epoch');
  return { epoch, key: crypto.getRandomValues(new Uint8Array(32)) };
}
export async function wrapJourneyKey(key: JourneyKey, recipients: { id: string; recipient: AgeRecipient }[]): Promise<KeyWrap[]> {
  if (key.key.length !== 32) throw new Error('Journey key must be 256 bits');
  if (new Set(recipients.map(r => r.id)).size !== recipients.length) throw new Error('Duplicate recipient');
  return Promise.all(recipients.map(async ({ id, recipient }) => ({ epoch: key.epoch, recipient: id, ciphertext: await sealIdentity(encode(key.key), [recipient]) })));
}
export async function unwrapJourneyKey(wrap: KeyWrap, identity: AgeIdentity): Promise<JourneyKey> {
  const key = decode(await openIdentity(wrap.ciphertext, [identity]));
  if (key.length !== 32) throw new Error('Invalid journey key');
  return { epoch: wrap.epoch, key };
}
export async function rotateJourneyKey(current: JourneyKey, recipients: { id: string; recipient: AgeRecipient }[]): Promise<{ key: JourneyKey; wraps: KeyWrap[] }> {
  const key = generateJourneyKey(current.epoch + 1);
  return { key, wraps: await wrapJourneyKey(key, recipients) };
}
