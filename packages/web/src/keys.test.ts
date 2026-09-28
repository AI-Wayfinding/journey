import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPersonKeys, getPersonKeys, lockPersonKeys, onPersonKeysCleared, rememberJourneyKey, restorePersonKeys, sealPersonKeys, unlockPersonKeys } from './keys.js';

const prf = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1);
afterEach(async () => { await clearPersonKeys(); onPersonKeysCleared(null); vi.unstubAllGlobals(); });

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
    await clearPersonKeys();
    expect(getPersonKeys()).toBeNull();
    expect(() => keys.identity).toThrow('Your keys are locked');
    expect(() => keys.signingPrivateKey).toThrow('Your keys are locked');
  });

  it('persists encrypted keys under a non-extractable wrapping key until sign out', async () => {
    const generated = await sealPersonKeys(prf());
    const keys = await unlockPersonKeys(generated.sealed, prf());
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('wayfinding-person-keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const saved = await new Promise<{ key: CryptoKey; sealed: { identity: string; signing: string } }>((resolve, reject) => {
      const request = database.transaction('person').objectStore('person').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    expect(saved.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', saved.key)).rejects.toThrow();
    expect(JSON.stringify(saved.sealed)).not.toContain(keys.identity);
    expect(JSON.stringify(saved.sealed)).not.toContain(keys.signingKey);
    lockPersonKeys(); // A reload clears memory, not browser storage.
    expect(getPersonKeys()).toBeNull();
    expect(() => keys.identity).toThrow('Your keys are locked');
    const restored = await restorePersonKeys();
    expect(restored?.recipient).toBe(generated.public.recipient);
    expect(restored?.signingKey).toBe(generated.public.signingKey);
    const epoch = { epoch: 1, key: new Uint8Array(32).fill(127) };
    rememberJourneyKey(epoch);
    await clearPersonKeys();
    expect(epoch.key).toEqual(new Uint8Array(32));
    expect(await restorePersonKeys()).toBeNull();
  });

  it('replaces saved keys on a new unlock without wiping the replacement', async () => {
    const first = await sealPersonKeys(prf());
    const original = await unlockPersonKeys(first.sealed, prf());
    const second = await sealPersonKeys(new Uint8Array(32).fill(4));
    const next = await unlockPersonKeys(second.sealed, new Uint8Array(32).fill(4));
    expect(() => original.identity).toThrow('Your keys are locked');
    expect(next.recipient).toBe(second.public.recipient);
    lockPersonKeys();
    expect((await restorePersonKeys())?.recipient).toBe(second.public.recipient);
  });

  it('notifies the UI when in-memory keys and journey keys are cleared', async () => {
    const clearUi = vi.fn(); onPersonKeysCleared(clearUi);
    const generated = await sealPersonKeys(prf());
    await unlockPersonKeys(generated.sealed, prf());
    lockPersonKeys();
    expect(clearUi).toHaveBeenCalledTimes(1);
    expect(getPersonKeys()).toBeNull();
    expect(await restorePersonKeys()).not.toBeNull();
  });
});
