import { asBuffer, decode, encode, text, utf8 } from './codec.js';
import { canonical } from './log.js';
import { deriveRecipient, openIdentity, sealIdentity } from './keys.js';
import type { AgeIdentity } from './keys.js';
import { PRIVATE_SLOT_BYTES, privateBytesHash, validPrivateId, copyPrivateIdentity, privateHash, signPrivateMessage, privateObject, privateShape, validatePrivateIdentity } from './private.js';
import type { PrivateIdentity } from './private.js';

export const PRIVATE_CHUNK_BYTES = PRIVATE_SLOT_BYTES - 32;
export const PRIVATE_HEADER_BYTES = 32768;
/** Stable random-looking local namespace, bound to signed admission and member
 * keys, not private operations. The server still uses its authenticated mapping. */
export async function memberVaultId(journey: string, principal: string, signingKey: string, recipient: string): Promise<string> {
  return (await privateBytesHash(utf8(canonical({ domain: 'wayfinding/private/member-v1', journey, principal, signingKey, recipient })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const random = (size: number): Uint8Array => { const bytes = new Uint8Array(size); for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(size, i + 65536))); return bytes; };
export const privateRandomBytes = random;
export function privateEncode(bytes: Uint8Array): string {
  let raw = ''; for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(raw);
}
export function privateDecode(value: string, size?: number): Uint8Array {
  if (typeof value !== 'string') throw new Error('Invalid private ciphertext framing');
  const raw = atob(value), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (btoa(raw) !== value || size !== undefined && bytes.length !== size) throw new Error('Invalid private ciphertext framing');
  return bytes;
}
async function slotKey(root: Uint8Array, vault: string, slot: number): Promise<CryptoKey> {
  if (root.length !== 32 || !validPrivateId(vault) || !Number.isInteger(slot) || slot < 0 || slot >= 64) throw new Error('Invalid private slot binding');
  const key = await crypto.subtle.importKey('raw', asBuffer(root), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: asBuffer(utf8('wayfinding/private/slot/v1')), info: asBuffer(utf8(canonical({ vault, slot }))) }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const aad = (vault: string, slot: number) => asBuffer(utf8(canonical({ domain: 'wayfinding/private/slot/v1', vault, slot })));
export async function sealPrivateSlot(root: Uint8Array, vault: string, slot: number, value: Uint8Array): Promise<string> {
  if (value.length > PRIVATE_CHUNK_BYTES) throw new Error('Private slot capacity exceeded');
  const plain = random(PRIVATE_SLOT_BYTES - 28), nonce = random(12);
  new DataView(plain.buffer).setUint32(0, value.length); plain.set(value, 4);
  try {
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(nonce), additionalData: aad(vault, slot) }, await slotKey(root, vault, slot), asBuffer(plain)));
    const bytes = new Uint8Array(PRIVATE_SLOT_BYTES); bytes.set(nonce); bytes.set(cipher, 12); return privateEncode(bytes);
  } finally { plain.fill(0); }
}
export async function openPrivateSlot(root: Uint8Array, vault: string, slot: number, value: string): Promise<Uint8Array> {
  const bytes = privateDecode(value, PRIVATE_SLOT_BYTES);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(bytes.subarray(0, 12)), additionalData: aad(vault, slot) }, await slotKey(root, vault, slot), asBuffer(bytes.subarray(12))));
  try { const size = new DataView(plain.buffer).getUint32(0); if (size > PRIVATE_CHUNK_BYTES) throw new Error('Invalid private slot length'); return plain.slice(4, 4 + size); }
  finally { plain.fill(0); }
}
/** The complete signed header, root key and private directory are encrypted to
 * exactly the member's existing identity. Journey/recovery recipients never enter. */
export async function sealPrivateFrame(value: unknown, recipient: string, contentRecipient?: string): Promise<string> {
  const encoded = new TextEncoder().encode(canonical(value)), plain = random(20000);
  if (encoded.length > plain.length - 4) throw new Error('Private header capacity exceeded');
  new DataView(plain.buffer).setUint32(0, encoded.length); plain.set(encoded, 4);
  let ciphertext: Uint8Array;
  try { ciphertext = privateDecode(await sealIdentity(encode(plain), contentRecipient ? [recipient, contentRecipient] : [recipient])); } finally { plain.fill(0); }
  if (ciphertext.length > PRIVATE_HEADER_BYTES - 4) throw new Error('Private header capacity exceeded');
  const frame = random(PRIVATE_HEADER_BYTES); new DataView(frame.buffer).setUint32(0, ciphertext.length); frame.set(ciphertext, 4); return privateEncode(frame);
}
export async function openPrivateFrame(value: string, identity: AgeIdentity, recipient: string): Promise<unknown> {
  if (await deriveRecipient(identity) !== recipient) throw new Error('Private identity binding mismatch');
  const frame = privateDecode(value, PRIVATE_HEADER_BYTES), length = new DataView(frame.buffer).getUint32(0);
  if (!length || length > PRIVATE_HEADER_BYTES - 4) throw new Error('Invalid private header framing');
  const plain = privateDecode(await openIdentity(encode(frame.subarray(4, length + 4)), [identity]), 20000);
  try { const size = new DataView(plain.buffer).getUint32(0); if (size > plain.length - 4) throw new Error('Invalid private header content'); return JSON.parse(text(plain.subarray(4, size + 4))); } finally { plain.fill(0); }
}
export async function privateSlotsDigest(hashes: readonly string[]): Promise<string> {
  if (hashes.length !== 64) throw new Error('Invalid private complete contents');
  return privateBytesHash(utf8(canonical(hashes)));
}
export const privatePlainBytes = (value: unknown): Uint8Array => utf8(canonical(value));
export const privatePlainValue = (bytes: Uint8Array): unknown => JSON.parse(text(bytes));


/** Only a dedicated content identity is shared; never a person's identity/signing key. */
export interface VaultAgentBinding { journey: string; person: string; agent: string; vault: string; author: PrivateIdentity; recipient: PrivateIdentity }
function vaultAgentBinding(value: VaultAgentBinding): VaultAgentBinding {
  if (!privateObject(value) || !privateShape(value, ['journey', 'person', 'agent', 'vault', 'author', 'recipient']) || ![value.journey, value.person, value.agent].every(v => typeof v === 'string' && v.length > 0 && v.length <= 128) || !validPrivateId(value.vault) || !validatePrivateIdentity(value.author) || value.author.kind !== 'person' || !validatePrivateIdentity(value.recipient) || value.recipient.kind !== 'agent') throw new Error('Invalid private agent wrap binding');
  return { journey: value.journey, person: value.person, agent: value.agent, vault: value.vault, author: copyPrivateIdentity(value.author), recipient: copyPrivateIdentity(value.recipient) };
}
export async function sealVaultAgentWrap(binding: VaultAgentBinding, contentIdentity: string, signingKey: CryptoKey): Promise<string> {
  const clean = vaultAgentBinding(binding);
  // Check that the shared secret is a real age key and not the person's key.
  if (await deriveRecipient(contentIdentity) === clean.author.recipient) throw new Error('Person identity must never be delegated');
  const message = { domain: 'wayfinding/private/agent-wrap/v1', binding: clean, contentIdentity };
  const sig = await signPrivateMessage(message, signingKey);
  return sealIdentity(canonical({ message, sig }), [clean.recipient.recipient]);
}
export async function openVaultAgentWrap(ciphertext: string, binding: VaultAgentBinding, identity: AgeIdentity): Promise<string> {
  const clean = vaultAgentBinding(binding);
  if (await deriveRecipient(identity) !== clean.recipient.recipient) throw new Error('Private agent identity mismatch');
  const value: unknown = JSON.parse(await openIdentity(ciphertext, [identity]));
  if (!privateObject(value) || !privateShape(value, ['message', 'sig']) || !privateObject(value.message) || !privateShape(value.message, ['domain', 'binding', 'contentIdentity']) || value.message.domain !== 'wayfinding/private/agent-wrap/v1' || canonical(value.message.binding) !== canonical(clean) || typeof value.message.contentIdentity !== 'string' || typeof value.sig !== 'string') throw new Error('Private agent wrap binding mismatch');
  const publicKey = await crypto.subtle.importKey('raw', asBuffer(decode(clean.author.signingKey)), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', publicKey, asBuffer(decode(value.sig)), asBuffer(utf8(canonical(value.message))))) throw new Error('Private agent wrap signature mismatch');
  if (await deriveRecipient(value.message.contentIdentity) === clean.author.recipient) throw new Error('Person identity must never be delegated');
  return value.message.contentIdentity;
}
