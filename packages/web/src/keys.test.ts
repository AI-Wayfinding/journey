import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgeIdentity } from '@ai-wayfinding/core';
import { clearPersonKeys, getPersonKeys, onPersonKeysCleared, rememberJourneyKey, sealPersonKeys, unlockPersonKeys } from './keys.js';

afterEach(() => { clearPersonKeys(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('passkey-sealed person keys', () => {
  it('seals both private keys to a fake passkey (age X25519 stand-in) and unseals only on a tap', async () => {
    const passkey = await createAgeIdentity();
    const generated = await sealPersonKeys(passkey.recipient);
    expect(generated.sealed.identity).not.toContain(generated.public.recipient);
    expect(generated.sealed.signing).not.toContain(generated.public.signingKey);
    expect(getPersonKeys()).toBeNull();
    await expect(unlockPersonKeys(generated.sealed, (await createAgeIdentity()).identity)).rejects.toThrow();
    const keys = await unlockPersonKeys(generated.sealed, passkey.identity);
    expect(keys.recipient).toBe(generated.public.recipient);
    expect(keys.signingKey).toBe(generated.public.signingKey);
    expect(getPersonKeys()).toBe(keys);
    clearPersonKeys();
    expect(getPersonKeys()).toBeNull();
    expect(() => keys.identity).toThrow('Your keys are locked');
    expect(() => keys.signingPrivateKey).toThrow('Your keys are locked');
  });

  it('forgets usable keys after 30 minutes without activity', async () => {
    const passkey = await createAgeIdentity();
    const generated = await sealPersonKeys(passkey.recipient);
    vi.useFakeTimers();
    const staleReference = await unlockPersonKeys(generated.sealed, passkey.identity);
    const epoch = { epoch: 1, key: new Uint8Array(32).fill(127) };
    rememberJourneyKey(epoch);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(getPersonKeys()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(getPersonKeys()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(getPersonKeys()).toBeNull();
    expect(() => staleReference.identity).toThrow('Your keys are locked');
    expect(epoch.key).toEqual(new Uint8Array(32));
  });

  it('notifies the UI to clear decrypted content and the recovery identity on idle wipe', async () => {
    const clearUi = vi.fn(); onPersonKeysCleared(clearUi);
    const passkey = await createAgeIdentity();
    const generated = await sealPersonKeys(passkey.recipient);
    vi.useFakeTimers();
    await unlockPersonKeys(generated.sealed, passkey.identity);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(clearUi).toHaveBeenCalledTimes(1);
    expect(getPersonKeys()).toBeNull();
    onPersonKeysCleared(null);
  });

  it('never touches localStorage, sessionStorage, indexedDB, or cookies', async () => {
    const touched: string[] = [];
    for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) vi.stubGlobal(name, new Proxy({}, { get: () => { touched.push(name); throw new Error(name); }, set: () => { touched.push(name); throw new Error(name); } }));
    vi.stubGlobal('document', Object.defineProperty({}, 'cookie', { get: () => { touched.push('cookie'); throw new Error('cookie'); }, set: () => { touched.push('cookie'); throw new Error('cookie'); } }));
    const passkey = await createAgeIdentity();
    const generated = await sealPersonKeys(passkey.recipient);
    await unlockPersonKeys(generated.sealed, passkey.identity);
    clearPersonKeys();
    expect(touched).toEqual([]);
  });
});
