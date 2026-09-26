import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPersonKeys, getPersonKeys, onPersonKeysCleared, rememberJourneyKey, resealPersonKeys, sealPersonKeys, unlockPersonKeys } from './keys.js';

const prf = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1);
afterEach(() => { clearPersonKeys(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('passkey-sealed person keys', () => {
  it('seals and opens both private keys with a fixed PRF output, not another output', async () => {
    const firstOutput = prf();
    const generated = await sealPersonKeys(firstOutput);
    expect(firstOutput).toEqual(new Uint8Array(32));
    expect(generated.sealed.version).toBe(1);
    expect(generated.sealed.identity).not.toContain(generated.public.recipient);
    expect(generated.sealed.signing).not.toContain(generated.public.signingKey);
    expect(getPersonKeys()).toBeNull();
    const wrongOutput = new Uint8Array(32).fill(42);
    await expect(unlockPersonKeys(generated.sealed, wrongOutput)).rejects.toThrow();
    expect(wrongOutput).toEqual(new Uint8Array(32));
    const secondOutput = prf();
    const keys = await unlockPersonKeys(generated.sealed, secondOutput);
    expect(secondOutput).toEqual(new Uint8Array(32));
    expect(keys.recipient).toBe(generated.public.recipient);
    expect(keys.signingKey).toBe(generated.public.signingKey);
    expect(getPersonKeys()).toBe(keys);
    clearPersonKeys();
    expect(getPersonKeys()).toBeNull();
    expect(() => keys.identity).toThrow('Your keys are locked');
    expect(() => keys.signingPrivateKey).toThrow('Your keys are locked');
  });

  it('reseals an old account with the new PRF output without changing its keys', async () => {
    const original = await sealPersonKeys(prf());
    const updated = await resealPersonKeys(original.sealed, prf(), new Uint8Array(32).fill(9));
    await expect(unlockPersonKeys(updated, prf())).rejects.toThrow();
    const keys = await unlockPersonKeys(updated, new Uint8Array(32).fill(9));
    expect(keys.recipient).toBe(original.public.recipient);
    expect(keys.signingKey).toBe(original.public.signingKey);
  });
  it('forgets usable keys after 30 minutes without activity', async () => {
    const generated = await sealPersonKeys(prf());
    vi.useFakeTimers();
    const staleReference = await unlockPersonKeys(generated.sealed, prf());
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
    const generated = await sealPersonKeys(prf());
    vi.useFakeTimers();
    await unlockPersonKeys(generated.sealed, prf());
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(clearUi).toHaveBeenCalledTimes(1);
    expect(getPersonKeys()).toBeNull();
    onPersonKeysCleared(null);
  });

  it('never touches localStorage, sessionStorage, indexedDB, or cookies', async () => {
    const touched: string[] = [];
    for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) vi.stubGlobal(name, new Proxy({}, { get: () => { touched.push(name); throw new Error(name); }, set: () => { touched.push(name); throw new Error(name); } }));
    vi.stubGlobal('document', Object.defineProperty({}, 'cookie', { get: () => { touched.push('cookie'); throw new Error('cookie'); }, set: () => { touched.push('cookie'); throw new Error('cookie'); } }));
    const generated = await sealPersonKeys(prf());
    await unlockPersonKeys(generated.sealed, prf());
    clearPersonKeys();
    expect(touched).toEqual([]);
  });
});
