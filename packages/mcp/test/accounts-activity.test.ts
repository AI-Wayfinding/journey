import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountsHost } from '../src/accounts.ts';
import { MemoryStorage } from '../src/storage.ts';
import { PartitionedAccountsStorage } from '../src/accounts-storage.ts';
import { tokenHash } from '../src/oauth-store.ts';

async function credentials(host: AccountsHost, now: number) {
  await host.provision('alice');
  const client = await host.oauth({ op: 'register', client: { client_name: 'Test', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] } });
  if (client.kind !== 'client' || !client.client) throw Error('client');
  const clientId = client.client.client_id, verifier = 'a'.repeat(43);
  await host.oauth({ op: 'request', id: 'request', request: { clientId, clientName: 'Test', redirectUri: 'http://127.0.0.1/callback', challenge: await tokenHash(verifier), expiresAt: now + 600000 } });
  const agent = await host.oauth({ op: 'consent', id: 'request', subject: 'alice', consent: { name: 'Agent', capabilities: ['read'], journeys: [] } });
  if (agent.kind !== 'agent') throw Error('agent');
  const code = await host.oauth({ op: 'code', id: 'request', subject: 'alice', agentId: agent.agentId });
  if (code.kind !== 'code') throw Error('code');
  const issued = await host.oauth({ op: 'exchange', clientId, code: code.code, redirectUri: 'http://127.0.0.1/callback', verifier });
  if (issued.kind !== 'tokens') throw Error('tokens');
  return { clientId, agentId: agent.agentId, ...issued.tokens };
}

for (const partitioned of [false, true]) test(`accounts: agent Last used persists at most hourly, partitioned=${partitioned}`, async () => {
  let now = Date.now(); const base = new MemoryStorage(), storage = partitioned ? new PartitionedAccountsStorage(base) : base;
  const host = () => new AccountsHost(storage, { async get() { return { name: 'Alice', email: 'alice@example.test' }; } }, undefined, undefined, () => now);
  const tokens = await credentials(host(), now), verify = { op: 'verify' as const, token: tokens.access_token };
  assert.equal((await host().oauth(verify)).kind, 'access');
  assert.equal((await host().lookup('alice'))!.agents.find(a => a.id === tokens.agentId)!.lastUsedAt, now);
  const writes = base.writes;
  for (let n = 0; n < 3; n++) { now += 1000; assert.equal((await host().oauth(verify)).kind, 'access'); }
  assert.equal(base.writes, writes, 'Repeated verifies inside the hour are read-only even after eviction');
  now += 3600000;
  const rotated = await host().oauth({ op: 'refresh', clientId: tokens.clientId, token: tokens.refresh_token });
  if (rotated.kind !== 'tokens') throw Error('refresh');
  assert.equal((await host().oauth({ op: 'verify', token: rotated.tokens.access_token })).kind, 'access');
  assert.equal((await host().lookup('alice'))!.agents.find(a => a.id === tokens.agentId)!.lastUsedAt, now);
  const after = base.writes;
  assert.deepEqual(await host().oauth({ op: 'verify', token: 'invalid' }), { kind: 'error', error: 'invalid_token' });
  assert.equal(base.writes, after);
});

test('accounts: slow upstream refresh does not hold the serial turn and rechecks revocation', async () => {
  let blocked = false, started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const now = Date.now(), host = new AccountsHost(new MemoryStorage(), { async get() { if (blocked) { started(); await gate; } return { name: 'Alice', email: 'alice@example.test' }; } });
  const tokens = await credentials(host, now); blocked = true;
  const refresh = host.oauth({ op: 'refresh', clientId: tokens.clientId, token: tokens.refresh_token });
  await entered;
  try {
    assert.equal(await Promise.race([host.lookup('alice').then(() => true), delay(2000, false)]), true, 'Unrelated Accounts reads must finish while WorkOS is blocked');
    await host.oauth({ op: 'revoke', clientId: tokens.clientId, token: tokens.refresh_token });
  } finally { release(); }
  assert.deepEqual(await refresh, { kind: 'error', error: 'invalid_grant' }, 'A delayed upstream success cannot resurrect a revoked family');
});
