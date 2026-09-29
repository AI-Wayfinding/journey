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
async function encrypt(key: CryptoKey, field: 'identity' | 'signing' | 'name', value: string): Promise<string> {
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
async function decrypt(key: CryptoKey, field: 'identity' | 'signing' | 'name', value: string): Promise<string> {
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
  #signingSecret: string;
  constructor(identity: string, recipient: string, signingKey: string, signingPrivateKey: CryptoKey, signingSecret: string) {
    this.#identity = identity;
    this.#recipient = recipient;
    this.#signingKey = signingKey;
    this.#signingPrivateKey = signingPrivateKey;
    this.#signingSecret = signingSecret;
  }
  get identity(): string { if (!this.#identity) throw new Error('Your keys are locked. Sign in again.'); return this.#identity; }
  get recipient(): string { if (!this.#recipient) throw new Error('Your keys are locked. Sign in again.'); return this.#recipient; }
  get signingKey(): string { if (!this.#signingKey) throw new Error('Your keys are locked. Sign in again.'); return this.#signingKey; }
  get signingPrivateKey(): CryptoKey { if (!this.#signingPrivateKey) throw new Error('Your keys are locked. Sign in again.'); return this.#signingPrivateKey; }
  seal(key: CryptoKey): Promise<SealedPersonKeys> { return Promise.all([encrypt(key, 'identity', this.identity), encrypt(key, 'signing', JSON.stringify({ publicKey: this.signingKey, privateKey: this.#signingSecret }))]).then(([identity, signing]) => ({ version: 1, identity, signing })); }
  clear(): void { this.#identity = ''; this.#recipient = ''; this.#signingKey = ''; this.#signingSecret = ''; this.#signingPrivateKey = null; }
}
let unlocked: UnlockedPersonKeys | null = null;
const openJourneyKeys = new Set<JourneyKey>();
/** Retain epoch keys only in memory, and zero their byte arrays when the person locks. */
export function rememberJourneyKey(key: JourneyKey): void { openJourneyKeys.add(key); }
let onClear: (() => void) | null = null;
/** Let the UI clear decrypted text and any unsaved recovery identity when keys lock. */
export function onPersonKeysCleared(callback: (() => void) | null): void { onClear = callback; }

/** Clear only this page's decrypted material; a reload must not sign the person out. */
export function lockPersonKeys(): void {
  const hadKeys = unlocked !== null || openJourneyKeys.size > 0;
  unlocked?.clear();
  unlocked = null;
  for (const key of openJourneyKeys) key.key.fill(0);
  openJourneyKeys.clear();
  if (hadKeys) onClear?.();
}

const databaseName = 'wayfinding-person-keys';
const storeName = 'person';
type SavedKeys = { key: CryptoKey; sealed: SealedPersonKeys; name?: string };
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(storeName); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function savedKeys(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

/** Sign out removes the persistent wrapping key as well as this page's decrypted keys. */
export async function clearPersonKeys(): Promise<void> {
  lockPersonKeys();
  await savedKeys('readwrite', store => store.delete('current'));
}

export function getPersonKeys(): PersonKeys | null { return unlocked; }

/** Keep the account name private even from the server and from local storage readers. */
export async function getAccountName(): Promise<string | null> {
  if (!unlocked) throw new Error('Unlock your keys with a passkey first.');
  const saved = await savedKeys('readonly', store => store.get('current')) as SavedKeys | undefined;
  return saved?.name ? decrypt(saved.key, 'name', saved.name) : null;
}
export async function setAccountName(name: string): Promise<void> {
  if (!unlocked) throw new Error('Unlock your keys with a passkey first.');
  const saved = await savedKeys('readonly', store => store.get('current')) as SavedKeys | undefined;
  if (!saved) throw new Error('Your saved journey keys are missing. Sign in again.');
  const next: SavedKeys = { key: saved.key, sealed: saved.sealed, name: await encrypt(saved.key, 'name', name) };
  await savedKeys('readwrite', store => store.put(next, 'current'));
}

/** Restore only the keys protected by the non-extractable key in this browser profile. */
export async function restorePersonKeys(): Promise<PersonKeys | null> {
  if (unlocked) return unlocked;
  const saved = await savedKeys('readonly', store => store.get('current')) as SavedKeys | undefined;
  if (!saved) return null;
  const { key, sealed } = saved;
  if (sealed.version !== 1) throw new Error('Your saved journey keys need a new sign-up.');
  const identity = await decrypt(key, 'identity', sealed.identity);
  const signing: unknown = JSON.parse(await decrypt(key, 'signing', sealed.signing));
  if (!signing || typeof signing !== 'object' || !('publicKey' in signing) || !('privateKey' in signing) || typeof signing.publicKey !== 'string' || typeof signing.privateKey !== 'string') throw new Error('Invalid sealed signing key');
  unlocked = new UnlockedPersonKeys(identity, await deriveRecipient(identity), signing.publicKey, await importSigningKey(signing.privateKey), signing.privateKey);
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

export async function sealUnlockedKeys(output: Uint8Array): Promise<SealedPersonKeys> {
  const keys = getPersonKeys(); if (!keys || !unlocked) throw new Error('Unlock your keys with a passkey first.');
  return withPrfKey(output, key => unlocked!.seal(key));
}

export async function backupKey(code: Uint8Array, purpose: 'verifier' | 'wrapping'): Promise<Uint8Array> {
  if (code.length !== 16) throw new Error('Enter a valid backup code.');
  const key = await crypto.subtle.importKey('raw', asBuffer(code), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: asBuffer(encoder.encode('wayfinding/backup/v1')), info: asBuffer(encoder.encode(purpose)) }, key, 256));
}

export function newBackupCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let number = BigInt('0x' + [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''));
  let text = '';
  for (let i = 0; i < 26; i++) { text = alphabet[Number(number & 31n)] + text; number >>= 5n; }
  return text.match(/.{1,4}/g)!.join('-');
}

export function parseBackupCode(value: string): Uint8Array {
  const text = value.toUpperCase().replace(/[-\s]/g, '');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(text)) throw new Error('Enter a valid backup code.');
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let number = 0n;
  for (const letter of text) number = number * 32n + BigInt(alphabet.indexOf(letter));
  if (number >= 1n << 128n) throw new Error('Enter a valid backup code.');
  return Uint8Array.from({ length: 16 }, (_, i) => Number(number >> BigInt((15 - i) * 8) & 255n));
}

/** Decrypt after a passkey tap, then protect a local copy for future visits. */
export async function unlockPersonKeys(sealed: SealedPersonKeys, prfOutput: Uint8Array): Promise<PersonKeys> {
  return withPrfKey(prfOutput, async key => {
    if (sealed.version !== 1) throw new Error('Your saved journey keys need a new sign-up.');
    const identity = await decrypt(key, 'identity', sealed.identity);
    const signing: unknown = JSON.parse(await decrypt(key, 'signing', sealed.signing));
    if (!signing || typeof signing !== 'object' || !('publicKey' in signing) || !('privateKey' in signing) || typeof signing.publicKey !== 'string' || typeof signing.privateKey !== 'string') throw new Error('Invalid sealed signing key');
    const next = new UnlockedPersonKeys(identity, await deriveRecipient(identity), signing.publicKey, await importSigningKey(signing.privateKey), signing.privateKey);
    const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const local = await next.seal(wrappingKey);
    const previous = await savedKeys('readonly', store => store.get('current')) as SavedKeys | undefined;
    let savedName: string | undefined;
    if (previous?.name) {
      try {
        const oldSigning: unknown = JSON.parse(await decrypt(previous.key, 'signing', previous.sealed.signing));
        if (oldSigning && typeof oldSigning === 'object' && 'publicKey' in oldSigning && oldSigning.publicKey === signing.publicKey) savedName = await encrypt(wrappingKey, 'name', await decrypt(previous.key, 'name', previous.name));
      } catch { /* An old or different account must not contribute its name. */ }
    }
    await savedKeys('readwrite', store => store.put({ key: wrappingKey, sealed: local, ...(savedName ? { name: savedName } : {}) }, 'current'));
    lockPersonKeys();
    unlocked = next;
    return next;
  });
}
