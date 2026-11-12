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
  'offer.manage': 'Manage offers', 'offer.decide': 'Decide offer requests',
  'member.invite': 'Invite people', 'member.admit': 'Admit people', 'member.remove': 'Remove members', 'journey.policy': 'Manage journey policy', 'grant.issue': 'Issue grants (person only)',
};
export function capabilityFields(assigned: readonly string[]): string {
  return ['account', 'journey'].map(scope => `<fieldset><legend>${scope === 'account' ? 'Account capabilities' : 'Journey capabilities'}</legend>${capabilities.filter(c => c.scope === scope && c.name !== 'grant.issue').map(c => `<label><input type="checkbox" name="capabilities" value="${c.name}"${assigned.includes(c.name) ? ' checked' : ''}> ${escape(labels[c.name])}</label>`).join('')}</fieldset>`).join('');
}
export const privacyNotice = 'Proof of concept. Use synthetic data only. Your proxy or unlocked browser encrypts forum, library, sensemaking, offer, task, profile and card content. The server cannot read sealed content. Routing metadata remains server-readable. Earlier deployments may retain readable data. The encryption library is unaudited.';
export function page(title: string, content: string, csrf: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Wayfinding</title><link rel="stylesheet" href="/console/style.css"><script src="/console/webauthn.js" defer></script></head><body><a href="#main">Skip to content</a><header class="top"><a class="brand" href="/console">Wayfinding</a><nav aria-label="Console"><a href="/console">Home</a><a href="/console/profile">Profile and account</a><a href="/console/passkeys">Passkeys</a><a href="/">Getting started</a></nav><details class="account"><summary aria-label="Account menu">Account</summary><div><a href="/console/profile">Profile and account</a><a href="/console/passkeys">Passkeys</a>${form('/console/logout', csrf, '', 'Sign out')}</div></details></header><main id="main"><h1>${escape(title)}</h1><p role="note">${privacyNotice}</p>${content}<p id="status" role="status" aria-live="polite"></p><noscript><p>Reading and narrowing work without JavaScript. Registering a passkey or confirming permissions requires JavaScript and a WebAuthn browser.</p></noscript></main></body></html>`;
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
  const browsers=rows((await backend.passkey(identity,{op:'browser_list'})).browsers).filter(b=>b.live);
  return page('Your console', `<section aria-labelledby="journeys"><h2 id="journeys">Journeys</h2><ul>${journeyRows.map(j => j.pending ? `<li><strong>${escape(j.name)}</strong> · ${j.pending === 'invited' ? 'You are invited' : 'Request pending'}${j.pending === 'invited' ? form('/console/journeys/join', csrf, hidden('journeyId', j.journeyId), 'Accept invitation') : ''}</li>` : `<li><a href="/console/journeys/${segment(j.journeyId)}">${escape(j.name)}</a></li>`).join('') || '<li>No journeys yet. Ask a guide to invite you by the email you sign in with.</li>'}</ul></section>
<section aria-labelledby="connections"><h2 id="connections">Your connections</h2><p>Trusted browsers keep your private keys. Trusted agents act with the permissions you choose.</p><table><thead><tr><th>Name</th><th>Kind</th><th>Added</th><th>Last used</th><th>Access</th><th>Remove</th></tr></thead><tbody>${browsers.map(b=>`<tr data-browser-id="${escape(b.id)}"><td>Browser connection ${escape(String(b.id).slice(0,8))}</td><td>Browser</td><td>${when(b.createdAt)}</td><td>${when(b.lastUsedAt)}</td><td data-connection-state>Locked</td><td>${form('/console/connections/remove',csrf,hidden('browserId',b.id),'Remove')}</td></tr>`).join('')}${liveAgents.map(a=>`<tr data-agent-id="${escape(a.agentId)}"><td><a href="/console/agents/${segment(a.agentId)}">${escape(a.name)}</a></td><td>Agent</td><td>${when(a.createdAt)}</td><td>${when(a.lastUsedAt)}</td><td><a href="/console/agents/${segment(a.agentId)}">Manage access</a></td><td>${form('/console/agents/remove',csrf,hidden('agentId',a.agentId),'Remove')}</td></tr>`).join('')}</tbody></table>${!browsers.length&&!liveAgents.length?'<p>No connections yet.</p>':''}<div id="connection-controls"></div><p><a href="/console/recover">Add a browser connection</a> · <a href="/console/passkeys">Manage passkeys</a></p></section>
<section aria-labelledby="connect"><h2 id="connect">Connect your agent</h2><ol class="steps"><li>Add the MCP URL <code>${escape(new URL('/mcp', identity.clientId).href)}</code> to your client and sign in.</li><li>Name the agent and choose its capabilities and journeys on the sign-in page.</li><li>Use this console to rename, refine access or delete it. A passkey is needed only to widen capabilities here.</li></ol></section>`, csrf);
}
function when(value: unknown): string { return typeof value === 'number' ? escape(new Date(value).toISOString()) : 'Not recorded'; }
function rowsCapabilities(value: unknown): Capability[] { return z.array(z.enum(capabilities.map(c => c.name))).parse(value); }
async function agentOffers(backend: ConsoleBackend, identity: ClientIdentity, agentId: string, journeys: ToolData[], csrf: string): Promise<string> {
  const call = (tool: string, input: Record<string, unknown>) => backend.execute(identity.subject, parseCommand(tool, input), identity.clientId);
  const listed = await call('offer_list', { agentId });
  const offers = rows(listed.offers);
  const settings = z.object({ publishWithoutReview: z.boolean(), maxAdmission: z.enum(['hold', 'allow']), maxRequestsPerDay: z.number().int().min(0).max(1000) }).parse(listed.settings);
  const taskGroups = await Promise.all(journeys.map(async journey => {
    const view = await call('journey_read', { journeyId: journey.journeyId });
    return { journey, tasks: rows(view.tasks), agentLive: rows(view.members).some(m => m.memberId === agentId) };
  }));
  const pending = taskGroups.flatMap(({ journey, tasks }) => tasks.filter(t => t.status === 'requested' && (t.assignee === agentId || t.claimant === agentId)).map(task => ({ journey, task })));
  const usage = z.record(z.string(), z.unknown()).parse(listed.usage ?? {});
  const journeyRows = (offer: ToolData) => {
    const entries = z.record(z.string(), z.object({ enabled: z.boolean(), maxRequestsPerDay: z.number().optional() })).parse(offer.journeySettings ?? {});
    return `<table><caption>Journey availability and limits</caption><thead><tr><th>Journey</th><th>Switch and limit</th><th>Admitted in 24h</th><th>Held</th></tr></thead><tbody>${taskGroups.filter(g => g.agentLive).map(({journey, tasks}) => {
      const id = String(journey.journeyId), row = entries[id], used = rows(usage.journeys).find(u => u.offerId === offer.id && u.journeyId === id)?.admitted24h ?? 0;
      const held = tasks.filter(t => t.status === 'requested' && t.offerId === offer.id && (t.assignee === agentId || t.claimant === agentId)).length;
      return `<tr><td>${escape(journey.name)}</td><td><form method="post" action="/console/offers/journey">${hidden('csrf', csrf)}${hidden('agentId', agentId)}${hidden('offerId', offer.id)}${hidden('journeyId', id)}${hidden('expectedVersion', offer.version)}<label>Availability <select name="enabled"><option value="false"${!row?.enabled ? ' selected' : ''}>Off</option><option value="true"${row?.enabled ? ' selected' : ''}>On</option></select></label><label>Limit <select name="limitMode"><option value="inherit"${row?.maxRequestsPerDay === undefined ? ' selected' : ''}>Inherit agent cap</option><option value="limit"${row?.maxRequestsPerDay !== undefined ? ' selected' : ''}>Per-day limit</option></select></label><label>Admitted tasks per rolling 24 hours <input name="maxRequestsPerDay" type="number" min="1" max="${settings.maxRequestsPerDay || 1000}" value="${escape(row?.maxRequestsPerDay ?? '')}"></label><button type="submit">Save journey offer</button></form></td><td>${escape(used)}</td><td>${held}</td></tr>`;
    }).join('')}</tbody></table>`;
  };
  const settingsForm = `<details><summary>Offer settings</summary><p>You set this agent's ceiling. Saving tighter settings needs no passkey. Wider permission requires your passkey.</p><form method="post" action="/console/offers/settings">${hidden('csrf', csrf)}${hidden('agentId', agentId)}${hidden('kind', 'offer_settings')}<label>Publish without review <select name="publishWithoutReview"><option value="false"${!settings.publishWithoutReview ? ' selected' : ''}>Review drafts</option><option value="true"${settings.publishWithoutReview ? ' selected' : ''}>Allowed</option></select></label><label>Agent admission ceiling <select name="maxAdmission"><option value="hold"${settings.maxAdmission === 'hold' ? ' selected' : ''}>Hold or deny</option><option value="allow"${settings.maxAdmission === 'allow' ? ' selected' : ''}>May allow requests</option></select></label><label>Admitted tasks per rolling 24 hours (0 means unlimited) <input name="maxRequestsPerDay" type="number" min="0" max="1000" required value="${settings.maxRequestsPerDay}"></label><button type="submit">Save tighter settings</button><button type="submit" formaction="/console/authorize/start">Review and confirm wider settings</button></form></details>`;
  const offerForms = (offer: ToolData) => {
    const fields = hidden('agentId', agentId) + hidden('offerId', offer.id);
    const standingRules = rows(offer.admission && typeof offer.admission === 'object' ? (offer.admission as ToolData).rules : []);
    const standing = standingRules.flatMap((rule, index) => {
      if (!rule.who || typeof rule.who !== 'object') return [];
      const who = rule.who as ToolData;
      const requester = typeof who.person === 'string' ? `person ${who.person}` : typeof who.agent === 'string' ? `agent ${who.agent}` : undefined;
      if (!requester) return [];
      return [`<li>${escape(rule.decision === 'allow' ? 'Always allowed' : rule.decision === 'deny' ? 'Always denied' : 'Always held')}: ${escape(requester)}${form('/console/offers/rule-remove', csrf, fields + hidden('version', offer.version) + hidden('ruleIndex', index), 'Remove standing rule')}</li>`];
    }).join('');
    return (offer.status === 'draft' ? form('/console/offers/publish', csrf, fields, 'Publish offer') : '')
      + (offer.status === 'published' ? form('/console/offers/retire', csrf, fields, 'Retire offer') : '')
      + journeyRows(offer) + (standing ? `<ul>${standing}</ul>` : '');
  };
  const decision = (journey: ToolData, task: ToolData, action: 'approve' | 'decline') => backend.sealedMode ? '<p>Unlock this browser connection to read and decide this request.</p>' : form('/console/offers/decide', csrf,
    hidden('agentId', agentId) + hidden('journeyId', journey.journeyId) + hidden('taskId', task.taskId) + hidden('action', action)
      + (action === 'decline' ? '<label>Reason (optional) <input name="reason" maxlength="1000"></label>' : '')
      + `<label><input type="checkbox" name="standing" value="${action === 'approve' ? 'always_allow' : 'always_deny'}"> Always ${action === 'approve' ? 'allow' : 'deny'} this requester</label>`,
    action === 'approve' ? 'Approve request' : 'Decline request');
  return `<section><h2>Offers</h2><p>Agent-defined offers stay in draft until you publish them, unless you permit publication without review. Use your proxy or unlocked browser to read sealed offer and request content. Use synthetic data only.</p><p><strong>Agent-wide ceiling:</strong> ${settings.maxRequestsPerDay || 'Unlimited'} admitted tasks per rolling 24 hours across every offer and journey. Used: ${escape(usage.admitted24h ?? 0)}. New offers are Off everywhere. Held requests do not consume permits; approval cannot bypass a full cap.</p>${settingsForm}<ul>${offers.map(o => `<li><h3>${escape(o.name)}</h3><p>${escape(o.description)}</p><p>${escape(o.status)} · Version ${escape(o.version)}</p><ul class="chips">${z.array(z.string()).parse(o.tags ?? []).map(t => `<li>${escape(t)}</li>`).join('')}</ul><details><summary>Input schema</summary><pre>${escape(JSON.stringify(o.inputSchema, null, 2))}</pre></details>${offerForms(o)}</li>`).join('') || '<li>No offers yet. Ask this agent to define one with offer_set.</li>'}</ul></section>
    <section><h2>Pending requests</h2><ul>${pending.map(({journey, task}) => `<li><h3>${escape(task.name)}</h3><p>${escape(journey.name)} · Requester: ${escape(task.creator)} · Offer: ${escape(task.offerId)} · Version ${escape(task.offerVersion)}</p><pre>${escape(JSON.stringify(task.input ?? {}, null, 2))}</pre>${decision(journey, task, 'approve')}${decision(journey, task, 'decline')}</li>`).join('') || '<li>No pending requests.</li>'}</ul></section>`;
}
export async function agentPage(backend: ConsoleBackend, identity: ClientIdentity, agentId: string, csrf: string): Promise<string> {
  const agent = await backend.execute(identity.subject, parseCommand('agent_capabilities', { agentId }), identity.clientId);
  const assigned = rowsCapabilities(agent.capabilities);
  const journeyRows = rows((await backend.execute(identity.subject, parseCommand('journey_list', {}), identity.clientId)).journeys).filter(j => !j.pending);
  const selected = z.array(z.string()).parse(agent.journeys ?? []);
  const journeyFields = `<fieldset><legend>Journeys</legend>${journeyRows.map(j => `<label><input type="checkbox" name="journeys" value="${escape(j.journeyId)}"${selected.includes(String(j.journeyId)) ? ' checked' : ''}> ${escape(j.name)}</label>`).join('')}</fieldset>`;
  const offerSections = await agentOffers(backend, identity, agentId, journeyRows, csrf);
  return page(String(agent.name), `<p>Client: ${escape(agent.clientName ?? clientLabel(agent.clientId ?? 'Not connected'))} · Created: ${when(agent.createdAt)} · Last used: ${when(agent.lastUsedAt)}</p><p>Permissions apply only while you and this agent remain live. Journey roles, ownership and facilitator authority still apply. Agents never issue grants.</p><h2>Name and journeys</h2>${form('/console/agents/update', csrf, hidden('agentId', agentId) + `<label>Agent name <input name="name" value="${escape(agent.name)}" maxlength="60"${backend.sealedMode?' readonly':''} required></label>` + journeyFields, 'Save name and journeys')}<h2>Set capabilities</h2><p>Widening needs your passkey. Removing capabilities below does not.</p>${form('/console/authorize/start', csrf, hidden('kind', 'card') + hidden('agentId', agentId) + capabilityFields(assigned), 'Review and confirm with passkey')}<h2>Remove capabilities now</h2>${form('/console/agents/narrow', csrf, hidden('agentId', agentId) + assigned.map(c => `<label><input type="checkbox" name="capabilities" value="${escape(c)}"> Remove ${escape(labels[c])}</label>`).join(''), 'Remove selected capabilities')}${offerSections}<h2>Delete agent</h2>${form('/console/agents/remove', csrf, hidden('agentId', agentId), 'Delete agent and revoke access')}`, csrf);
}
export async function passkeysPage(backend: ConsoleBackend, identity: ClientIdentity, csrf: string): Promise<string> {
  const keys = rows((await backend.passkey(identity, { op: 'list' })).passkeys);
  const when = (value: unknown) => typeof value === 'number' ? new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : null;
  const item = (k: ToolData) => {
    const facts = [k.name && k.provider ? escape(k.provider) : null, when(k.createdAt) ? `Added ${escape(when(k.createdAt))}` : null, `Last used ${escape(when(k.lastUsedAt) ?? 'never')}`].filter(Boolean).join(' · ');
    const rename = backend.sealedMode?'':`<details><summary>Rename</summary>${form('/console/passkeys/rename', csrf, hidden('id', k.id) + `<label>Name <input name="name" maxlength="60" value="${escape(k.name ?? '')}" placeholder="${escape(k.provider ?? 'Passkey')}"></label>`, 'Save name')}</details>`;
    return `<li class="passkey"><strong>${escape(k.label)}</strong><span class="meta">${facts}</span>${rename}${form('/console/passkeys/delete', csrf, hidden('id', k.id), 'Delete')}</li>`;
  };
  return page('Passkeys', `<p>A passkey confirms wider agent permissions in this console. Naming an agent and choosing its initial access happens when you connect your client.</p><ul class="passkeys">${keys.map(item).join('') || '<li>No passkeys registered.</li>'}</ul><form method="post" action="/console/passkeys/register" data-ceremony="register" data-needs-assertion="${keys.length>0}" data-options="/console/passkeys/options">${hidden('csrf', csrf)}<button type="submit">Register a passkey</button></form>`, csrf);
}
export function confirmation(change: CardChange, csrf: string, agentName?: string): string {
  const action = change.kind === 'card' ? 'Set agent permissions' : change.kind === 'offer_settings' ? 'Set offer permissions' : change.kind === 'bind' ? 'Make a client act as this agent' : 'Stop a client acting as this agent';
  const details = change.kind === 'card' ? `<dt>Capabilities</dt><dd>${change.capabilities.length ? `<ul class="chips">${change.capabilities.map(c => `<li>${escape(labels[c as Capability] ?? c)}</li>`).join('')}</ul>` : 'None'}</dd>`
    : change.kind === 'offer_settings' ? `<dt>Publish without review</dt><dd>${change.settings.publishWithoutReview === undefined ? 'Unchanged' : change.settings.publishWithoutReview ? 'Allowed' : 'Review drafts'}</dd><dt>Agent admission ceiling</dt><dd>${escape(change.settings.maxAdmission ?? 'Unchanged')}</dd><dt>Requests per day</dt><dd>${escape(change.settings.maxRequestsPerDay ?? 'Unchanged')}</dd>`
    : `<dt>Client</dt><dd>${escape(change.clientId)}</dd>`;
  return page('Confirm permissions', `<p>Use your passkey to confirm this exact change.</p><dl class="facts"><dt>Action</dt><dd>${escape(action)}</dd><dt>Agent</dt><dd>${escape(agentName ?? change.agentId)}</dd>${details}</dl><form method="post" action="/console/authorize/complete" data-ceremony="assert" data-options="/console/authorize/options">${hidden('csrf', csrf)}${hidden('change', JSON.stringify(change))}<button type="submit">Confirm with passkey</button></form><p><a href="/console">Cancel</a></p>`, csrf);
}
export function journeyNav(journeyId: string): string {
  const root = `/console/journeys/${segment(journeyId)}`;
  return `<nav aria-label="Journey"><a href="${root}">Overview</a><a href="${root}/library">Library</a><a href="${root}/forum">Forum</a><a href="${root}/rounds">Sensemaking</a></nav>`;
}
export async function journeyPage(backend: ConsoleBackend, identity: ClientIdentity, journeyId: string, csrf: string): Promise<string> {
  const journey = await backend.execute(identity.subject, parseCommand('journey_read', { journeyId }), identity.clientId);
  if (backend.sealedMode) return page('Journey overview', journeyNav(journeyId)
    + `<p>${escape(journey.journeyId)} · ${escape(journey.policy)} · default role ${escape(journey.defaultRole)}</p><section><h2>Members</h2><ul>${rows(journey.members).map(m => `<li>${escape(m.memberId)} · ${escape(m.kind)} · ${escape(m.role)}${m.guide ? ' · guide' : ''}</li>`).join('')}</ul></section><section><h2>Tasks</h2><ul>${rows(journey.tasks).map(t => `<li>${escape(t.taskId)} · ${escape(t.status)}</li>`).join('')}</ul></section><p>Unlock this browser connection to read private journey content.</p>`, csrf);
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
