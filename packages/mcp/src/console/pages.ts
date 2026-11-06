import * as z from 'zod';
import { capabilities, type Capability } from '../../../rules/src/capabilities.ts';
import { Refused, parseCommand, type ToolData } from '../commands.ts';
import type { ConsoleBackend } from './contract.ts';
import type { CardChange, ClientIdentity } from '../agents.ts';

export const escape = (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const rows = (value: unknown) => z.array(z.record(z.string(), z.unknown())).parse(value ?? []);
const segment = (id: unknown) => encodeURIComponent(z.string().min(1).max(200).parse(id));
const hidden = (name: string, value: unknown) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;
export const form = (action: string, csrf: string, fields: string, button: string) => `<form method="post" action="${action}">${hidden('csrf', csrf)}${fields}<button type="submit">${escape(button)}</button></form>`;
const labels: Record<Capability, string> = {
  'device.keys': 'Manage device keys and sealed content', 'journey.create': 'Create journeys', 'account.nickname': 'Change your nickname', 'agent.remove': 'Remove your agents',
  read: 'Read journey work', 'artifact.write': 'Add and version artifacts', 'artifact.delete': 'Delete owned artifacts', post: 'Post in the forum',
  'topic.create': 'Create topics', 'board.manage': 'Manage boards', 'project.create': 'Create projects', 'project.edit': 'Edit led projects',
  'task.manage': 'Manage tasks', 'round.create': 'Create sensemaking rounds', 'round.run': 'Facilitate rounds', 'round.contribute': 'Contribute to rounds',
  'member.invite': 'Invite people', 'member.admit': 'Admit people', 'member.remove': 'Remove members', 'journey.policy': 'Manage journey policy', 'grant.issue': 'Issue grants (person only)',
};
export function capabilityFields(assigned: readonly string[]): string {
  return ['account', 'journey'].map(scope => `<fieldset><legend>${scope === 'account' ? 'Account capabilities' : 'Journey capabilities'}</legend>${capabilities.filter(c => c.scope === scope && c.name !== 'grant.issue').map(c => `<label><input type="checkbox" name="capabilities" value="${c.name}"${assigned.includes(c.name) ? ' checked' : ''}> ${escape(labels[c.name])}</label>`).join('')}</fieldset>`).join('');
}
export function page(title: string, content: string, csrf: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Wayfinding</title><link rel="stylesheet" href="/console/style.css"><script src="/console/webauthn.js" defer></script></head><body><a href="#main">Skip to content</a><header class="top"><a class="brand" href="/console">Wayfinding</a><nav aria-label="Console"><a href="/console">Home</a><a href="/console/passkeys">Passkeys</a><a href="/">Getting started</a></nav><details class="account"><summary aria-label="Account menu">Account</summary><div><a href="/console/passkeys">Passkeys</a>${form('/console/logout', csrf, '', 'Sign out')}</div></details></header><main id="main"><h1>${escape(title)}</h1><p role="note">Proof of concept. Use synthetic data only. The server can read forum posts, interview notes and library text.</p>${content}<p id="status" role="status" aria-live="polite"></p><noscript><p>Reading and narrowing work without JavaScript. Registering a passkey or confirming permissions requires JavaScript and a WebAuthn browser.</p></noscript></main></body></html>`;
}
/** A readable name for a client id: the host of a metadata-document URL, or the raw id for registered clients. */
export function clientLabel(id: unknown): string {
  const value = String(id);
  if (value === 'https://poc.wayfinding.support/console/client.json') return 'This console';
  try { const url = new URL(value); return url.protocol === 'https:' ? url.host : value; } catch { return value; }
}
export async function home(backend: ConsoleBackend, identity: ClientIdentity, csrf: string): Promise<string> {
  const call = (name: string) => backend.execute(identity.subject, parseCommand(name, {}), identity.clientId);
  const [journeys, agents] = await Promise.all([call('journey_list'), call('agent_list')]);
  const journeyRows = rows(journeys.journeys);
  const liveAgents = rows(agents.agents).filter(a => a.live);
  return page('Your console', `<section aria-labelledby="journeys"><h2 id="journeys">Journeys</h2><ul>${journeyRows.map(j => j.pending ? `<li><strong>${escape(j.name)}</strong> · ${j.pending === 'invited' ? 'You are invited' : 'Request pending'}${j.pending === 'invited' ? form('/console/journeys/join', csrf, hidden('journeyId', j.journeyId), 'Accept invitation') : ''}</li>` : `<li><a href="/console/journeys/${segment(j.journeyId)}">${escape(j.name)}</a></li>`).join('') || '<li>No journeys yet. Ask a guide to invite you by the email you sign in with.</li>'}</ul></section>
<section aria-labelledby="agents"><h2 id="agents">Agents</h2><p>Each agent acts with your live authority, narrowed by its card and journey membership.</p><ul>${liveAgents.map(a => `<li><a href="/console/agents/${segment(a.agentId)}">${escape(a.name)}</a> · ${escape(a.clientName ?? clientLabel(a.clientId ?? 'Not connected'))}<ul class="chips">${rowsCapabilities(a.capabilities).map(c => `<li>${escape(labels[c])}</li>`).join('')}</ul><p>Journeys: ${journeyRows.filter(j => !j.pending && z.array(z.string()).parse(a.journeys ?? []).includes(String(j.journeyId))).map(j => escape(j.name)).join(', ') || 'None'}</p><p>Created: ${when(a.createdAt)} · Last used: ${when(a.lastUsedAt)}</p></li>`).join('') || '<li>No agents yet.</li>'}</ul></section>
<section aria-labelledby="connect"><h2 id="connect">Connect your agent</h2><ol class="steps"><li>Add the MCP URL <code>${escape(new URL('/mcp', identity.clientId).href)}</code> to your client and sign in.</li><li>Name the agent and choose its capabilities and journeys on the sign-in page.</li><li>Use this console to rename, refine access or delete it. A passkey is needed only to widen capabilities here.</li></ol></section>`, csrf);
}
function when(value: unknown): string { return typeof value === 'number' ? escape(new Date(value).toISOString()) : 'Not recorded'; }
function rowsCapabilities(value: unknown): Capability[] { return z.array(z.enum(capabilities.map(c => c.name))).parse(value); }
export async function agentPage(backend: ConsoleBackend, identity: ClientIdentity, agentId: string, csrf: string): Promise<string> {
  const agent = await backend.execute(identity.subject, parseCommand('agent_capabilities', { agentId }), identity.clientId);
  const assigned = rowsCapabilities(agent.capabilities);
  const journeyRows = rows((await backend.execute(identity.subject, parseCommand('journey_list', {}), identity.clientId)).journeys).filter(j => !j.pending);
  const selected = z.array(z.string()).parse(agent.journeys ?? []);
  const journeyFields = `<fieldset><legend>Journeys</legend>${journeyRows.map(j => `<label><input type="checkbox" name="journeys" value="${escape(j.journeyId)}"${selected.includes(String(j.journeyId)) ? ' checked' : ''}> ${escape(j.name)}</label>`).join('')}</fieldset>`;
  return page(String(agent.name), `<p>Client: ${escape(agent.clientName ?? clientLabel(agent.clientId ?? 'Not connected'))} · Created: ${when(agent.createdAt)} · Last used: ${when(agent.lastUsedAt)}</p><p>Permissions apply only while you and this agent remain live. Journey roles, ownership and facilitator authority still apply. Agents never issue grants.</p><h2>Name and journeys</h2>${form('/console/agents/update', csrf, hidden('agentId', agentId) + `<label>Agent name <input name="name" value="${escape(agent.name)}" maxlength="60" required></label>` + journeyFields, 'Save name and journeys')}<h2>Set capabilities</h2><p>Widening needs your passkey. Removing capabilities below does not.</p>${form('/console/authorize/start', csrf, hidden('kind', 'card') + hidden('agentId', agentId) + capabilityFields(assigned), 'Review and confirm with passkey')}<h2>Remove capabilities now</h2>${form('/console/agents/narrow', csrf, hidden('agentId', agentId) + assigned.map(c => `<label><input type="checkbox" name="capabilities" value="${escape(c)}"> Remove ${escape(labels[c])}</label>`).join(''), 'Remove selected capabilities')}<h2>Delete agent</h2>${form('/console/agents/remove', csrf, hidden('agentId', agentId), 'Delete agent and revoke access')}`, csrf);
}
export async function passkeysPage(backend: ConsoleBackend, identity: ClientIdentity, csrf: string): Promise<string> {
  const keys = rows((await backend.passkey(identity, { op: 'list' })).passkeys);
  const when = (value: unknown) => typeof value === 'number' ? new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : null;
  const item = (k: ToolData) => {
    const facts = [k.name && k.provider ? escape(k.provider) : null, when(k.createdAt) ? `Added ${escape(when(k.createdAt))}` : null, `Last used ${escape(when(k.lastUsedAt) ?? 'never')}`].filter(Boolean).join(' · ');
    const rename = `<details><summary>Rename</summary>${form('/console/passkeys/rename', csrf, hidden('id', k.id) + `<label>Name <input name="name" maxlength="60" value="${escape(k.name ?? '')}" placeholder="${escape(k.provider ?? 'Passkey')}"></label>`, 'Save name')}</details>`;
    return `<li class="passkey"><strong>${escape(k.label)}</strong><span class="meta">${facts}</span>${rename}${form('/console/passkeys/delete', csrf, hidden('id', k.id), 'Delete')}</li>`;
  };
  return page('Passkeys', `<p>A passkey confirms wider agent permissions in this console. Naming an agent and choosing its initial access happens when you connect your client.</p><ul class="passkeys">${keys.map(item).join('') || '<li>No passkeys registered.</li>'}</ul><form method="post" action="/console/passkeys/register" data-ceremony="register" data-options="/console/passkeys/options">${hidden('csrf', csrf)}<button type="submit">Register a passkey</button></form>`, csrf);
}
export function confirmation(change: CardChange, csrf: string, agentName?: string): string {
  return page('Confirm permissions', `<p>Use your passkey to confirm this exact change.</p><dl class="facts"><dt>Action</dt><dd>${escape(change.kind === 'card' ? 'Set agent permissions' : change.kind === 'bind' ? 'Make a client act as this agent' : 'Stop a client acting as this agent')}</dd><dt>Agent</dt><dd>${escape(agentName ?? change.agentId)}</dd>${change.kind === 'card' ? `<dt>Capabilities</dt><dd>${change.capabilities.length ? `<ul class="chips">${change.capabilities.map(c => `<li>${escape(labels[c as Capability] ?? c)}</li>`).join('')}</ul>` : 'None'}</dd>` : `<dt>Client</dt><dd>${escape(change.clientId)}</dd>`}</dl><form method="post" action="/console/authorize/complete" data-ceremony="assert" data-options="/console/authorize/options">${hidden('csrf', csrf)}${hidden('change', JSON.stringify(change))}<button type="submit">Confirm with passkey</button></form><p><a href="/console">Cancel</a></p>`, csrf);
}
export function journeyNav(journeyId: string): string {
  const root = `/console/journeys/${segment(journeyId)}`;
  return `<nav aria-label="Journey"><a href="${root}">Overview</a><a href="${root}/library">Library</a><a href="${root}/forum">Forum</a><a href="${root}/rounds">Sensemaking</a></nav>`;
}
export async function journeyPage(backend: ConsoleBackend, identity: ClientIdentity, journeyId: string, csrf: string): Promise<string> {
  const journey = await backend.execute(identity.subject, parseCommand('journey_read', { journeyId }), identity.clientId);
  const forum = await backend.execute(identity.subject, parseCommand('topic_list', { journeyId }), identity.clientId);
  const rounds = await backend.execute(identity.subject, parseCommand('round_list', { journeyId }), identity.clientId);
  const list = (heading: string, value: unknown, render: (row: ToolData) => string) => `<section><h2>${heading}</h2><ul>${rows(value).map(row => `<li>${render(row)}</li>`).join('') || '<li>Nothing to show in this build.</li>'}</ul></section>`;
  return page(String(journey.name), journeyNav(journeyId) + list('Members', journey.members, m => `${escape(m.name)} · ${escape(m.kind)} · ${escape(m.role)}${m.guide ? ' · guide' : ''}`)
    + list('Library', journey.items ?? journey.artifacts, a => `${escape(a.name)} · ${escape(a.kind ?? a.type)} · version ${escape(a.version)}`)
    + list('Forum topics', forum.topics, t => `${escape(t.title)} · ${escape(t.replyCount)} replies${t.locked ? ' · locked' : ''}`)
    + list('Sensemaking rounds', rounds.rounds, r => `${escape(r.title)} · ${escape(r.goal)} · ${escape(r.status)}`), csrf);
}
export function routeId(path: string, prefix: string): string {
  const id = decodeURIComponent(path.slice(prefix.length));
  if (!id || id.includes('/') || id.length > 200) throw new Refused('Invalid console target');
  return id;
}
