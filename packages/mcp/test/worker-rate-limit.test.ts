import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, { type Env } from '../src/worker.ts';
import { AccountsPartitionedV1 } from '../src/objects.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryBlobs } from '../src/relay.ts';

function env(): Env {
  const storage = new MemoryStorage();
  return { AUTHKIT_ISSUER: 'https://auth.example.test', AUTHKIT_AUTHORIZE_URL: 'https://auth.example.test/authorize', MCP_RESOURCE: 'https://worker.example.test/mcp', WORKOS_API_KEY: 'synthetic', BLOBS: new MemoryBlobs(),
    ACCOUNTS: { getByName() { return { fetch: request => new AccountsPartitionedV1({ storage }, { WORKOS_API_KEY: 'synthetic' }).fetch(request) }; } },
    JOURNEYS: { getByName() { throw Error('Unexpected journey access'); } } };
}
const register = (ip = '192.0.2.1') => new Request('https://worker.example.test/oauth/register', { method: 'POST', headers: { host: 'worker.example.test', 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ client_name: 'Test', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' }) });

test('Worker rate limits: missing limiter bindings fail closed with documented 503', async () => {
  const bindings = env();
  for (const path of ['/oauth/register', '/oauth/authorize', '/oauth/token', '/console/login']) {
    const response = await worker.fetch(new Request(`https://worker.example.test${path}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), bindings);
    assert.equal(response.status, 503, path);
    assert.equal(await response.text(), 'Rate limiter unavailable');
  }
});

test('Worker rate limits: DCR has a separate lower per-IP limit than authorize and refresh', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')) as { ratelimits: { name: string; simple: { limit: number; period: number } }[] };
  const auth = config.ratelimits.find(r => r.name === 'AUTH_RATE_LIMIT')!, dcr = config.ratelimits.find(r => r.name === 'DCR_RATE_LIMIT');
  assert.ok(dcr, 'A separate DCR limiter must ship'); assert.equal(dcr.simple.limit, 5); assert.equal(dcr.simple.period, 60); assert.ok(dcr.simple.limit < auth.simple.limit);
  const bindings = env(), counts = new Map<string, number>(); let authCalls = 0;
  bindings.AUTH_RATE_LIMIT = { async limit() { authCalls++; return { success: true }; } };
  bindings.DCR_RATE_LIMIT = { async limit({ key }) { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return { success: n <= dcr.simple.limit }; } };
  for (let n = 0; n < 5; n++) assert.equal((await worker.fetch(register(), bindings)).status, 201);
  const refused = await worker.fetch(register(), bindings); assert.equal(refused.status, 429); assert.equal(refused.headers.get('retry-after'), '60');
  assert.equal((await worker.fetch(register('192.0.2.2'), bindings)).status, 201); assert.equal(authCalls, 0);
  assert.equal((await worker.fetch(new Request('https://worker.example.test/oauth/token', { method: 'POST', headers: { host: 'worker.example.test', 'cf-connecting-ip': '192.0.2.1' } }), bindings)).status, 400); assert.equal(authCalls, 1);
});
