import { asBuffer, decode, encode, utf8 } from './codec.js';
import { copyBlobDescriptor, MAX_BLOB_BYTES, validateBlobDescriptor } from './artifacts.js';
import type { BlobDescriptor } from './artifacts.js';
import { isId } from './ids.js';
import { canonical } from './log.js';
import type { JourneyKey } from './teamKey.js';

export interface BlobMeta { journey: string; id: string; epoch: number }
export interface EncryptedBlob { descriptor: BlobDescriptor; ciphertext: Uint8Array }

function aad(descriptor: BlobDescriptor): ArrayBuffer {
  return asBuffer(utf8(canonical({ v: 1, journey: descriptor.journey, id: descriptor.id, epoch: descriptor.epoch, size: descriptor.size })));
}
function checkKey(key: JourneyKey, epoch: number): void {
  if (key.epoch !== epoch || key.key.length !== 32) throw new Error('Wrong journey key epoch');
}
async function digest(bytes: Uint8Array): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(bytes))));
}
function checkedDescriptor(ciphertext: Uint8Array, value: unknown): BlobDescriptor {
  if (!validateBlobDescriptor(value)) throw new Error('Invalid blob descriptor');
  const descriptor = copyBlobDescriptor(value);
  if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength !== descriptor.ciphertextSize) throw new Error('Invalid blob ciphertext size');
  return descriptor;
}

/** Checks complete binary upload bytes, not Content-Length. Does not grant access. */
export async function verifyBlob(ciphertext: Uint8Array, value: unknown): Promise<BlobDescriptor> {
  const descriptor = checkedDescriptor(ciphertext, value);
  const bytes = Uint8Array.from(ciphertext);
  if (await digest(bytes) !== descriptor.digest) throw new Error('Invalid blob ciphertext digest');
  return descriptor;
}

/** Encrypts only this byte view; private filenames and MIME types belong in artifact payloads. */
export async function sealBlob(bytes: Uint8Array, meta: BlobMeta, journeyKey: JourneyKey): Promise<EncryptedBlob> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BLOB_BYTES) throw new Error('Invalid blob raw size');
  if (!meta || Object.keys(meta).length !== 3 || !Object.hasOwn(meta, 'journey') || !Object.hasOwn(meta, 'id') || !Object.hasOwn(meta, 'epoch') || !isId(meta.journey) || !isId(meta.id) || !Number.isSafeInteger(meta.epoch) || meta.epoch < 1) throw new Error('Invalid blob metadata');
  checkKey(journeyKey, meta.epoch);
  const plaintext = asBuffer(bytes);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const descriptor: BlobDescriptor = { v: 1, journey: meta.journey, id: meta.id, epoch: meta.epoch, size: bytes.byteLength, ciphertextSize: bytes.byteLength + 16, nonce: encode(nonce), digest: '' };
  const key = await crypto.subtle.importKey('raw', asBuffer(journeyKey.key), 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(nonce), additionalData: aad(descriptor), tagLength: 128 }, key, plaintext));
  descriptor.digest = await digest(ciphertext);
  return { descriptor, ciphertext };
}

/** Verifies digest and byte counts before authenticating journey/blob/epoch/size with AES-GCM. */
export async function openBlob(ciphertext: Uint8Array, value: unknown, journeyKey: JourneyKey): Promise<Uint8Array> {
  const descriptor = checkedDescriptor(ciphertext, value);
  checkKey(journeyKey, descriptor.epoch);
  const bytes = Uint8Array.from(ciphertext);
  const keyBytes = asBuffer(journeyKey.key);
  if (await digest(bytes) !== descriptor.digest) throw new Error('Invalid blob ciphertext digest');
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  // Descriptor validation guarantees a canonical 12-byte nonce.
  const nonce = decode(descriptor.nonce);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(nonce), additionalData: aad(descriptor), tagLength: 128 }, key, asBuffer(bytes)));
  if (plaintext.byteLength !== descriptor.size) throw new Error('Invalid blob raw size');
  return plaintext;
}
