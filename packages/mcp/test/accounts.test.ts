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
