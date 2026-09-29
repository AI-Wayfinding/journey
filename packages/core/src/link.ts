import { asBuffer, utf8, text } from './codec.js';
import { hashEntry, signEntry } from './log.js';
import type { LogEntry, LogState, Member } from './log.js';

/**
 * Agent link crypto. An agent link is a deliberate exception to end-to-end encryption: the server keeps the
 * agent's private identity sealed under a random secret that only appears in the link itself.
 */
export const LINK_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const salt = utf8('wayfinding/agent-link/v1');
const info = utf8('aes-gcm');

export function base64urlEncode(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function base64urlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid base64url');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
/** A random 256-bit secret as 43 URL-safe characters. */
export function newLinkSecret(): string { return base64urlEncode(crypto.getRandomValues(new Uint8Array(32))); }
/** What the server stores to find a link. It cannot be reversed into the secret. */
export async function linkLookupHash(secret: string): Promise<string> {
  return base64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(utf8(secret)))));
}
async function linkKey(secret: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (!LINK_SECRET_PATTERN.test(secret)) throw new Error('Invalid agent link secret');
  const base = await crypto.subtle.importKey('raw', asBuffer(base64urlDecode(secret)), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: asBuffer(salt), info: asBuffer(info) }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
const aad = (journeyId: string, memberId: string): ArrayBuffer => asBuffer(utf8(`wayfinding/agent-link/v1:${journeyId}:${memberId}`));
/** Encrypts the agent's private age identity with the link secret (AES-GCM, HKDF-derived key). */
export async function sealLinkIdentity(secret: string, identity: string, journeyId: string, memberId: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(nonce), additionalData: aad(journeyId, memberId) }, await linkKey(secret, 'encrypt'), asBuffer(utf8(identity))));
  const blob = new Uint8Array(nonce.length + ciphertext.length);
  blob.set(nonce); blob.set(ciphertext, nonce.length);
  return base64urlEncode(blob);
}
export async function openLinkIdentity(secret: string, blob: string, journeyId: string, memberId: string): Promise<string> {
  const bytes = base64urlDecode(blob);
  if (bytes.length < 12 + 16) throw new Error('Invalid agent link blob');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(bytes.slice(0, 12)), additionalData: aad(journeyId, memberId) }, await linkKey(secret, 'decrypt'), asBuffer(bytes.slice(12)));
  return text(new Uint8Array(plaintext));
}

/**
 * Extends an agent's access without a new entry type, so earlier clients still verify the log: the person who added the
 * agent removes it and adds the same member back with a later expiry. No key rotation follows, because the agent keeps
 * the same key and is never absent from the journey between the two entries.
 */
export async function renewAgentEntries(state: LogState, target: string, actor: string, signingKey: CryptoKey, expiresAt: string): Promise<[LogEntry, LogEntry]> {
  const current = state.members[target]?.member;
  if (!current || current.kind !== 'agent') throw new Error('Agent not found');
  if (current.addedBy !== actor || state.members[actor]?.member.kind !== 'person') throw new Error('Only the person who added an agent can extend it');
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error('Invalid expiry');
  const at = new Date().toISOString();
  const first = await signEntry({ v: 1, seq: state.lastSeq + 1, prev: state.lastHash, at, actor, type: 'member.remove', body: { member: target } }, signingKey);
  const member: Member = { ...current, expiresAt };
  const second = await signEntry({ v: 1, seq: first.seq + 1, prev: await hashEntry(first), at, actor, type: 'member.add', body: { member, grants: [], kind: 'agent' } }, signingKey);
  return [first, second];
}
