import { asBuffer, decode, encode, text, utf8 } from './codec.js';
import type { JourneyKey } from './teamKey.js';
import type { ProtocolRecord } from './types.js';
export interface OuterMeta { v: 1; id: string; journey: string; seq?: number; epoch: number; size: number; createdAt: string }
export interface Envelope { outside: OuterMeta; nonce: string; ciphertext: string }
const fields = ['createdAt', 'epoch', 'id', 'journey', 'seq', 'size', 'v'];
function aad(outside: OuterMeta): Uint8Array {
  if (Object.keys(outside).some(k => !fields.includes(k))) throw new Error('Unexpected outside field');
  return utf8(JSON.stringify(fields.map(k => [k, Object.hasOwn(outside, k) ? outside[k as keyof OuterMeta] : null])));
}
function checkKey(key: JourneyKey, epoch: number): void {
  if (key.epoch !== epoch || key.key.length !== 32) throw new Error('Wrong journey key epoch');
}
export async function seal(inner: ProtocolRecord, outerMeta: Omit<OuterMeta, 'v' | 'size'>, journeyKey: JourneyKey): Promise<Envelope> {
  checkKey(journeyKey, outerMeta.epoch);
  const plaintext = utf8(JSON.stringify(inner));
  const outside: OuterMeta = { v: 1, id: outerMeta.id, journey: outerMeta.journey, ...(outerMeta.seq === undefined ? {} : { seq: outerMeta.seq }), epoch: outerMeta.epoch, size: plaintext.length, createdAt: outerMeta.createdAt };
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', asBuffer(journeyKey.key), 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(nonce), additionalData: asBuffer(aad(outside)) }, key, asBuffer(plaintext));
  return { outside, nonce: encode(nonce), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function open(envelope: Envelope, journeyKey: JourneyKey): Promise<ProtocolRecord> {
  checkKey(journeyKey, envelope.outside.epoch);
  const nonce = decode(envelope.nonce);
  if (nonce.length !== 12) throw new Error('Invalid nonce');
  const key = await crypto.subtle.importKey('raw', asBuffer(journeyKey.key), 'AES-GCM', false, ['decrypt']);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(nonce), additionalData: asBuffer(aad(envelope.outside)) }, key, asBuffer(decode(envelope.ciphertext))));
  if (plaintext.length !== envelope.outside.size) throw new Error('Invalid size');
  const record: unknown = JSON.parse(text(plaintext));
  if (!record || typeof record !== 'object' || Array.isArray(record) || typeof (record as ProtocolRecord).type !== 'string' || !Number.isSafeInteger((record as ProtocolRecord).typeVersion) || !((record as ProtocolRecord).body && typeof (record as ProtocolRecord).body === 'object' && !Array.isArray((record as ProtocolRecord).body))) throw new Error('Invalid record');
  return record as ProtocolRecord;
}
