import { createAgeIdentity, createSigningIdentity, deriveRecipient, importSigningKey } from '@ai-wayfinding/core';
import type { JourneyKey } from '@ai-wayfinding/core';

export interface SealedPersonKeys { version: 1; identity: string; signing: string }
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const label = 'wayfinding/person-keys/v1';
const asBuffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;
const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function withPrfKey<T>(output: Uint8Array, action: (key: CryptoKey) => Promise<T>): Promise<T> {
  try {
    if (output.length !== 32) throw new Error('This passkey did not return a journey key. Try another passkey.');
    const raw = new Uint8Array(output);
    try {
      const input = await crypto.subtle.importKey('raw', raw.buffer, 'HKDF', false, ['deriveBits']);
      const derived = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: asBuffer(encoder.encode(label)), info: asBuffer(encoder.encode('aes-gcm')) }, input, 256));
      try { return await action(await crypto.subtle.importKey('raw', derived.buffer, 'AES-GCM', false, ['encrypt', 'decrypt'])); }
      finally { derived.fill(0); }
    } finally { raw.fill(0); }
  } finally { output.fill(0); }
}
async function encrypt(key: CryptoKey, field: 'identity' | 'signing', value: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(value);
  try {
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(nonce), additionalData: asBuffer(encoder.encode(label + '/' + field)) }, key, plain.buffer));
    const combined = new Uint8Array(nonce.length + sealed.length);
    combined.set(nonce);
    combined.set(sealed, nonce.length);
    return encode(combined);
  } finally { plain.fill(0); }
}
async function decrypt(key: CryptoKey, field: 'identity' | 'signing', value: string): Promise<string> {
  const bytes = decode(value);
  if (bytes.length < 28) throw new Error('Your saved journey keys are damaged.');
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(bytes.slice(0, 12)), additionalData: asBuffer(encoder.encode(label + '/' + field)) }, key, asBuffer(bytes.slice(12))));
  try { return decoder.decode(plain); }
  finally { plain.fill(0); }
}
export interface PersonKeys { readonly identity: string; readonly recipient: string; readonly signingKey: string; readonly signingPrivateKey: CryptoKey }
class UnlockedPersonKeys implements PersonKeys {
  #identity: string;
  #recipient: string;
  #signingKey: string;
  #signingPrivateKey: CryptoKey | null;
  constructor(identity: string, recipient: string, signingKey: string, signingPrivateKey: CryptoKey) {
    this.#identity = identity;
    this.#recipient = recipient;
    this.#signingKey = signingKey;
    this.#signingPrivateKey = signingPrivateKey;
  }
  get identity(): string { if (!this.#identity) throw new Error('Your keys are locked. Sign in again.'); return this.#identity; }
  get recipient(): string { if (!this.#recipient) throw new Error('Your keys are locked. Sign in again.'); return this.#recipient; }
  get signingKey(): string { if (!this.#signingKey) throw new Error('Your keys are locked. Sign in again.'); return this.#signingKey; }
  get signingPrivateKey(): CryptoKey { if (!this.#signingPrivateKey) throw new Error('Your keys are locked. Sign in again.'); return this.#signingPrivateKey; }
  clear(): void { this.#identity = ''; this.#recipient = ''; this.#signingKey = ''; this.#signingPrivateKey = null; }
}
const IDLE_MS = 30 * 60_000;
let unlocked: UnlockedPersonKeys | null = null;
const openJourneyKeys = new Set<JourneyKey>();
/** Retain epoch keys only in memory, and zero their byte arrays when the person locks. */
export function rememberJourneyKey(key: JourneyKey): void { openJourneyKeys.add(key); }
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let onClear: (() => void) | null = null;
/** Let the UI clear decrypted text and any unsaved recovery identity when keys lock. */
export function onPersonKeysCleared(callback: (() => void) | null): void { onClear = callback; }

export function clearPersonKeys(): void {
  const hadKeys = unlocked !== null || openJourneyKeys.size > 0;
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = undefined;
  unlocked?.clear();
  unlocked = null;
  for (const key of openJourneyKeys) key.key.fill(0);
  openJourneyKeys.clear();
  if (hadKeys) onClear?.();
}

export function getPersonKeys(): PersonKeys | null {
  if (unlocked) {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(clearPersonKeys, IDLE_MS);
  }
  return unlocked;
}

export async function sealPersonKeys(prfOutput: Uint8Array): Promise<{ sealed: SealedPersonKeys; public: { recipient: string; signingKey: string } }> {
  return withPrfKey(prfOutput, async key => {
    const age = await createAgeIdentity();
    const signing = await createSigningIdentity();
    return {
      sealed: { version: 1, identity: await encrypt(key, 'identity', age.identity), signing: await encrypt(key, 'signing', JSON.stringify(signing)) },
      public: { recipient: age.recipient, signingKey: signing.publicKey },
    };
  });
}

/** Move existing ciphertext to the app-wide PRF input without changing the private keys. */
export async function resealPersonKeys(sealed: SealedPersonKeys, oldOutput: Uint8Array, newOutput: Uint8Array): Promise<SealedPersonKeys> {
  return withPrfKey(oldOutput, async oldKey => {
    const identity = await decrypt(oldKey, 'identity', sealed.identity);
    const signing = await decrypt(oldKey, 'signing', sealed.signing);
    return withPrfKey(newOutput, async newKey => ({ version: 1, identity: await encrypt(newKey, 'identity', identity), signing: await encrypt(newKey, 'signing', signing) }));
  });
}

/** Decrypt only after one passkey tap; retain usable keys in module memory. */
export async function unlockPersonKeys(sealed: SealedPersonKeys, prfOutput: Uint8Array): Promise<PersonKeys> {
  return withPrfKey(prfOutput, async key => {
    if (sealed.version !== 1) throw new Error('Your saved journey keys need a new sign-up.');
    const identity = await decrypt(key, 'identity', sealed.identity);
    const signing: unknown = JSON.parse(await decrypt(key, 'signing', sealed.signing));
    if (!signing || typeof signing !== 'object' || !('publicKey' in signing) || !('privateKey' in signing) || typeof signing.publicKey !== 'string' || typeof signing.privateKey !== 'string') throw new Error('Invalid sealed signing key');
    const next = new UnlockedPersonKeys(identity, await deriveRecipient(identity), signing.publicKey, await importSigningKey(signing.privateKey));
    clearPersonKeys();
    unlocked = next;
    idleTimer = setTimeout(clearPersonKeys, IDLE_MS);
    return next;
  });
}
