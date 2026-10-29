import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { app, bridge, keyPair, RESOURCE, token } from './helpers.ts';
import { MemoryBackend } from '../src/backend.ts';
import { AppsHost } from './apps-host.ts';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { registerViewResources } from '../src/apps.ts';
import { releasedViews } from '@ai-wayfinding/apps/views';
import { createApp } from '../src/app.ts';

const signer = await keyPair('apps');
async function fixture(t: TestContext) {
  const backend = new MemoryBackend({ async get(subject) { return { name: subject, email: `${subject}@example.test` }; } });
  async function connect(sub: string) {
    const client = new Client({ name: 'apps-host', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(RESOURCE, {
      fetch: bridge(app(signer, backend)), requestInit: { headers: { authorization: `Bearer ${await token(signer, { sub })}` } },
    }));
    t.after(() => client.close());
    return client;
  }
  const client = await connect('alice');
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent as Record<string, unknown>;
  }
  const journey = await call('journey_create', { name: 'Test journey' });
  const journeyId = journey.journeyId as string;
  const created = await call('project_create', { journeyId, name: 'First project', purpose: 'Test coordination' });
  const projectId = (created.projects as { projectId: string }[])[0]!.projectId;
  const artifact = await call('artifact_create', { journeyId, name: 'Notes', type: 'text/plain', size: 12 });
  const artifactId = (artifact.artifacts as { artifactId: string }[])[0]!.artifactId;
  return { client, call, journeyId, projectId, artifactId, backend, connect };
}

test('apps: versioned resources and app-only tools use official metadata', async (t) => {
  const { client } = await fixture(t);
  const resources = (await client.listResources()).resources;
  assert.deepEqual(resources.map((r) => [r.uri, r.mimeType]).sort(), [
    ['ui://wayfinding/v1/artifacts.html', 'text/html;profile=mcp-app'],
    ['ui://wayfinding/v1/journey.html', 'text/html;profile=mcp-app'],
    ['ui://wayfinding/v1/project.html', 'text/html;profile=mcp-app'],
  ]);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.filter((tool) => tool.name.startsWith('apps_')).map((tool) => [tool.name, (tool._meta?.ui as { visibility: string[] }).visibility]).sort(), [
    ['apps_artifact_rename', ['app']], ['apps_artifacts_refresh', ['app']],
    ['apps_journey_invite', ['app']], ['apps_journey_policy', ['app']], ['apps_journey_refresh', ['app']],
    ['apps_project_refresh', ['app']], ['apps_project_update', ['app']],
  ]);
  assert.equal((tools.find((tool) => tool.name === 'journey_view')!._meta?.ui as { resourceUri: string }).resourceUri, 'ui://wayfinding/v1/journey.html');
  const view = await client.readResource({ uri: 'ui://wayfinding/v1/journey.html' });
  const content = view.contents[0]!;
  assert.ok('text' in content);
  assert.match(content.text, /Your conversation goes to your AI provider/);
});

test('apps: tools apply real mutations, recheck authority and reject injected fields', async (t) => {
  const f = await fixture(t);
  await f.call('apps_journey_policy', { journeyId: f.journeyId, policy: 'open', defaultRole: 'read' });
  assert.equal((await f.call('journey_read', { journeyId: f.journeyId })).policy, 'open');
  await f.call('apps_project_update', { journeyId: f.journeyId, projectId: f.projectId, status: 'active' });
  assert.equal((await f.call('project_view', { journeyId: f.journeyId, projectId: f.projectId })).view, 'project');
  assert.equal(((await f.call('journey_read', { journeyId: f.journeyId })).projects as { status: string }[])[0]!.status, 'active');
  await f.call('apps_artifact_rename', { journeyId: f.journeyId, artifactId: f.artifactId, name: 'Renamed notes' });
  assert.deepEqual((await f.call('artifact_list_view', { journeyId: f.journeyId })).artifacts, [{ artifactId: f.artifactId, name: 'Renamed notes', size: 12, version: 1 }]);
  const bob = await f.connect('bob');
  await bob.callTool({ name: 'account_read', arguments: {} });
  const before = f.backend.snapshot();
  assert.equal((await bob.callTool({ name: 'apps_journey_policy', arguments: { journeyId: f.journeyId, policy: 'invite', defaultRole: 'write' } })).isError, true);
  assert.equal((await f.client.callTool({ name: 'apps_artifact_rename', arguments: { journeyId: f.journeyId, artifactId: f.artifactId, name: 'Bad', content: 'SECRET', subject: 'bob' } })).isError, true);
  assert.equal(f.backend.snapshot(), before);
});

test('apps: signin GET redirects to configured AuthKit and ignores caller redirects', async () => {
  const target = app(signer);
  const response = await target.fetch(new Request('https://poc.wayfinding.support/signin?redirect_uri=https://evil.test'));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://welcoming-folk-53-staging.authkit.app/oauth2/authorize');
  assert.equal((await target.fetch(new Request('https://poc.wayfinding.support/signin', { method: 'POST' }))).status, 405);
});

const scenarios: { kind: string; tool: string; refresh: string; form: string; action: string; values: Record<string, string>; expected: string }[] = [
  { kind: 'journey', tool: 'journey_view', refresh: 'apps_journey_refresh', form: 'policy', action: 'apps_journey_policy', values: { policy: 'open', defaultRole: 'read' }, expected: 'open; default role: read' },
  { kind: 'project', tool: 'project_view', refresh: 'apps_project_refresh', form: 'project', action: 'apps_project_update', values: { purpose: 'Updated purpose', status: 'active' }, expected: 'Updated purpose' },
  { kind: 'artifacts', tool: 'artifact_list_view', refresh: 'apps_artifacts_refresh', form: 'rename', action: 'apps_artifact_rename', values: { name: 'Host renamed' }, expected: 'Host renamed' },
];
for (const scenario of scenarios) test(`apps: ${scenario.kind} bundled App renders and acts through host tools only`, async (t) => {
  const f = await fixture(t);
  const args = { journeyId: f.journeyId, ...(scenario.kind === 'project' ? { projectId: f.projectId } : {}) };
  const resource = (await f.client.readResource({ uri: `ui://wayfinding/v1/${scenario.kind}.html` })).contents[0]!;
  assert.ok('text' in resource);
  assert.match(resource.text, /Your conversation goes to your AI provider/);
  assert.doesNotMatch(resource.text, /<(?:script|link)[^>]+(?:src|href)=/i);
  const host = new AppsHost(resource.text, f.client);
  t.after(() => host.dispose());
  await host.until(() => host.nodes.get('status')!.textContent === 'Connected.');
  host.notify('ui/notifications/tool-input', { arguments: { ...args, content: 'SECRET', subject: 'bob' } });
  host.notify('ui/notifications/tool-result', await f.client.callTool({ name: scenario.tool, arguments: args }));
  await host.until(() => host.nodes.get('status')!.textContent === 'Up to date.');
  assert.match(host.text, scenario.kind === 'artifacts' ? /Notes.*12 bytes; version 1/ : scenario.kind === 'project' ? /Test coordination/ : /Members and roles.*write, guide.*Agents.*Projects.*First project.*Invites and requests/);
  const before = f.backend.snapshot();
  host.click('refresh');
  await host.until(() => host.messages.some((m) => m.method === 'tools/call') && host.nodes.get('status')!.textContent === 'Up to date.');
  const refresh = host.messages.find((m) => m.method === 'tools/call')!;
  assert.deepEqual(JSON.parse(JSON.stringify(refresh.params)), { name: scenario.refresh, arguments: args, _meta: { progressToken: 1 } });
  assert.equal(f.backend.snapshot(), before);
  host.submit(scenario.form, { ...scenario.values, ...(scenario.kind === 'artifacts' ? { artifactId: f.artifactId } : {}) });
  await host.until(() => host.text.includes(scenario.expected));
  assert.equal(host.messages.filter((m) => m.method === 'tools/call')[1]!.params!.name, scenario.action);
  assert.doesNotMatch(host.text, /SECRET/);
  host.click('signin');
  await host.until(() => host.opened.length === 1);
  assert.deepEqual(host.opened, ['https://poc.wayfinding.support/signin']);
  assert.deepEqual([...new Set(host.messages.map((m) => m.method))].sort(), ['tools/call', 'ui/initialize', 'ui/notifications/initialized', 'ui/open-link']);
  host.notify('ui/notifications/tool-result', { isError: true, content: [{ type: 'text', text: 'SECRET' }] });
  await host.until(() => host.nodes.get('status')!.textContent.includes('refused'));
  assert.doesNotMatch(host.nodes.get('status')!.textContent, /SECRET/);
});

test('apps: adding a later release still serves and executes the original v1 URI', async (t) => {
  const target = createMcpHandler(() => {
    const server = new McpServer({ name: 'release-test', version: '2.0.0' });
    registerViewResources(server, [...releasedViews, { uri: 'ui://wayfinding/v2/journey.html', kind: 'journey', html: '<p>New version</p>' }]);
    return server;
  });
  const client = new Client({ name: 'release-host', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: bridge(target) }));
  t.after(() => client.close());
  assert.equal((await client.listResources()).resources.length, 4);
  const v1 = (await client.readResource({ uri: 'ui://wayfinding/v1/journey.html' })).contents[0]!;
  const v2 = (await client.readResource({ uri: 'ui://wayfinding/v2/journey.html' })).contents[0]!;
  assert.ok('text' in v1 && 'text' in v2);
  assert.equal(v2.text, '<p>New version</p>');
  const host = new AppsHost(v1.text, client);
  t.after(() => host.dispose());
  await host.until(() => host.nodes.get('status')!.textContent === 'Connected.');
  host.click('signin');
  await host.until(() => host.opened.length === 1);
  assert.deepEqual(host.opened, ['https://poc.wayfinding.support/signin']);
});

test('apps: nested output projections strip artifact content and access locations', async (t) => {
  // Deliberately hostile storage-boundary response proves the Apps boundary does
  // more than trust the current metadata-only storage implementation.
  const contaminated = app(signer, { async execute() { return {
    journeyId: 'j', content: 'SECRET', artifacts: [
      { artifactId: 'a', name: 'Safe', size: 3, version: 2, deleted: false, content: 'SECRET', url: 'https://evil.test' },
      { artifactId: 'b', name: 'Deleted', size: 3, version: 1, deleted: true },
    ],
  }; } });
  const client = new Client({ name: 'projection-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(RESOURCE, { fetch: bridge(contaminated), requestInit: { headers: { authorization: `Bearer ${await token(signer)}` } } }));
  t.after(() => client.close());
  const result = await client.callTool({ name: 'artifact_list_view', arguments: { journeyId: 'j' } });
  assert.deepEqual(result.structuredContent, { view: 'artifacts', journeyId: 'j', artifacts: [{ artifactId: 'a', name: 'Safe', size: 3, version: 2 }] });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|evil[.]test|Deleted/);
});

test('apps: signin target is configuration, not the issuer or request query', async () => {
  const target = createApp({ resource: RESOURCE, issuer: 'https://issuer.example.test', allowedHosts: ['poc.wayfinding.support'],
    verifier: { async verifyAccessToken() { throw new Error('unused'); } }, signinUrl: 'https://login.example.test/authorize?client_id=test' });
  const response = await target.fetch(new Request('https://poc.wayfinding.support/signin?url=https://evil.test'));
  assert.equal(response.headers.get('location'), 'https://login.example.test/authorize?client_id=test');
});
