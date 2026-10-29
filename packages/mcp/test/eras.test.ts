import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { app, bridge, keyPair, RESOURCE, token } from './helpers.ts';
import { TOOL_NAMES } from '../src/commands.ts';

const authkit = await keyPair('authkit-key');
const send = bridge(app(authkit));

async function connect(mode: 'legacy' | 'auto', sub: string): Promise<Client> {
  const bearer = await token(authkit, { sub });
  const client = new Client({ name: 'era-test', version: '1.0.0' }, { versionNegotiation: { mode } });
  await client.connect(
    new StreamableHTTPClientTransport(RESOURCE, { fetch: send, requestInit: { headers: { authorization: `Bearer ${bearer}` } } }),
  );
  return client;
}

async function listAndCall(client: Client, sub: string, era: 'legacy' | 'modern'): Promise<void> {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ['whoami', ...TOOL_NAMES,
      'journey_view', 'project_view', 'artifact_list_view',
      'apps_journey_refresh', 'apps_project_refresh', 'apps_artifacts_refresh',
      'apps_journey_policy', 'apps_journey_invite', 'apps_project_update', 'apps_artifact_rename'],
  );
  const result = await client.callTool({ name: 'whoami', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { subject: sub, era });
}

test('era 2026-07-28: a negotiating client lists tools and calls whoami', async () => {
  const client = await connect('auto', 'user_01MODERN');
  try {
    assert.equal(client.getProtocolEra(), 'modern');
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    await listAndCall(client, 'user_01MODERN', 'modern');
  } finally {
    await client.close();
  }
});

test('era 2025-11-25: a stateless initialize client lists tools and calls whoami', async () => {
  const client = await connect('legacy', 'user_01LEGACY');
  try {
    assert.equal(client.getProtocolEra(), 'legacy');
    assert.equal(client.getNegotiatedProtocolVersion(), '2025-11-25');
    await listAndCall(client, 'user_01LEGACY', 'legacy');
  } finally {
    await client.close();
  }
});

test('era 2025-11-25: the legacy leg is stateless and refuses session GET', async () => {
  const bearer = await token(authkit);
  const response = await send(RESOURCE, {
    method: 'GET',
    headers: { authorization: `Bearer ${bearer}`, accept: 'text/event-stream' },
  });
  assert.equal(response.status, 405);
});

test('era: both eras on one handler still require a token', async () => {
  const client = new Client({ name: 'era-test', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
  await assert.rejects(client.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: send })));
});
