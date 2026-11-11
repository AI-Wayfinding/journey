import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkOSProfiles } from '../src/accounts.ts';
import { Accounts } from '../src/objects.ts';
import { MemoryStorage } from '../src/storage.ts';

const configurationError = 'Server configuration error: WORKOS_API_KEY is required for account profiles';

for (const apiKey of [undefined, '', '   ']) {
  test(`account configuration rejects ${JSON.stringify(apiKey)} WorkOS key before profile lookup`, async () => {
    let requests = 0;
    const profiles = new WorkOSProfiles(apiKey, async () => {
      requests += 1;
      return Response.json({ id: 'user_synthetic', email: 'synthetic@test.wayfinding.support' });
    });
    await assert.rejects(profiles.get('user_synthetic'), { message: configurationError });
    assert.equal(requests, 0, 'Missing configuration must never send a bearer credential');
  });
}

test('account configuration error survives the Durable Object boundary without account writes', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return Response.json({ id: 'user_synthetic', email: 'synthetic@test.wayfinding.support' });
  });
  const storage = new MemoryStorage();
  const accounts = new Accounts({ storage }, { WORKOS_API_KEY: '' });
  const response = await accounts.fetch(new Request('https://coordination.internal/', {
    method: 'POST', body: JSON.stringify({ action: 'provision', subject: 'user_synthetic' }),
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: configurationError });
  assert.equal(storage.writes, 0);
  assert.equal(requests, 0, 'Missing configuration must not call WorkOS');
});

test('account profile lookup with a configured key still validates upstream responses without leaking credentials', async () => {
  const key = 'synthetic-secret-not-a-real-key';
  const failed = new WorkOSProfiles(key, async () => new Response(key, { status: 401 }));
  await assert.rejects(failed.get('user_synthetic'), { message: 'Account profile lookup failed' });
  const foreign = new WorkOSProfiles(key, async () => Response.json({ id: 'user_other', email: 'other@test.wayfinding.support' }));
  await assert.rejects(foreign.get('user_synthetic'), { message: 'Account profile is invalid' });
});

// This covers credential configuration, not WorkOS availability or deployed bindings.

test('account profile lookup calls the default fetch without a foreign this (workerd Illegal invocation)', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  // workerd rejects fetch invoked with a `this` other than the global scope; emulate that check.
  globalThis.fetch = async function (this: unknown, input: string | URL | Request) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    assert.match(String(input), /user_management\/users\/user_synthetic$/);
    return Response.json({ id: 'user_synthetic', email: 'synthetic@test.wayfinding.support' });
  } as typeof fetch;
  const profile = await new WorkOSProfiles('sk_test_synthetic').get('user_synthetic');
  assert.equal(profile.email, 'synthetic@test.wayfinding.support');
});

test('account profile lookup uses a Workers-supported redirect mode and refuses redirects', async () => {
  const modes: unknown[] = [];
  const redirected = new WorkOSProfiles('sk_test_synthetic', async (_input, init) => {
    modes.push(init?.redirect);
    // workerd rejects any mode other than follow or manual before sending.
    if (init?.redirect !== 'follow' && init?.redirect !== 'manual') throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    return new Response(null, { status: 302, headers: { location: 'https://attacker.test/' } });
  });
  await assert.rejects(redirected.get('user_synthetic'), { message: 'Account profile lookup failed' });
  assert.deepEqual(modes, ['manual']);
});

test('worker source never asks fetch for the unsupported error redirect mode', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const root = new URL('../src/', import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length > 10, 'source scan must see the worker sources');
  const offenders = [];
  for (const name of files) if (/redirect\s*:\s*['"]error['"]/.test(await readFile(new URL(name, root), 'utf8'))) offenders.push(name);
  assert.deepEqual(offenders, []);
});

