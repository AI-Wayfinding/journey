import { createAgeIdentity, createSigningIdentity, deriveRecipient, importSigningKey, openIdentity, sealIdentity } from '@ai-wayfinding/core';
import type { AgeIdentity, AgeRecipient, JourneyKey } from '@ai-wayfinding/core';

export interface SealedPersonKeys { identity: string; signing: string }
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

/** The recipient can be a WebAuthnRecipient. Tests use an age X25519 recipient. */
export async function sealPersonKeys(passkey: AgeRecipient): Promise<{ sealed: SealedPersonKeys; public: { recipient: string; signingKey: string } }> {
  const age = await createAgeIdentity();
  const signing = await createSigningIdentity();
  return {
    sealed: {
      identity: await sealIdentity(age.identity, [passkey]),
      signing: await sealIdentity(JSON.stringify(signing), [passkey]),
    },
    public: { recipient: age.recipient, signingKey: signing.publicKey },
  };
}

/** Decrypt only after a deliberate passkey tap; retain usable keys in module memory. */
export async function unlockPersonKeys(sealed: SealedPersonKeys, passkey: AgeIdentity): Promise<PersonKeys> {
  const identity = await openIdentity(sealed.identity, [passkey]);
  const signing: unknown = JSON.parse(await openIdentity(sealed.signing, [passkey]));
  if (!signing || typeof signing !== 'object' || !('publicKey' in signing) || !('privateKey' in signing) || typeof signing.publicKey !== 'string' || typeof signing.privateKey !== 'string') throw new Error('Invalid sealed signing key');
  const next = new UnlockedPersonKeys(identity, await deriveRecipient(identity), signing.publicKey, await importSigningKey(signing.privateKey));
  clearPersonKeys();
  unlocked = next;
  idleTimer = setTimeout(clearPersonKeys, IDLE_MS);
  return next;
}
