import { App } from '@modelcontextprotocol/ext-apps';
import { v2View, CONSOLE_URL, type V2View } from './v2-contract.ts';
import { capabilities } from '../../rules/src/capabilities.ts';
const app = new App({ name: 'wayfinding-workspace', version: '2.0.0' }, {}, { autoResize: false });
const overview = document.getElementById('overview')!, status = document.getElementById('status')!;
let ready = false, busy = false;
let journeyId: string | undefined, actingAgent: string | undefined, agentId: string | undefined;
let itemId: string | undefined, roundId: string | undefined, boardId: string | undefined, topicId: string | undefined, documentId: string | undefined;
let current: V2View['view'] = document.body.dataset.view as V2View['view'];
let filters: Record<string, string | boolean> = {};
const node = (id: string) => document.getElementById(id)!;
const field = (form: string, name: string) => document.querySelector<HTMLInputElement>(`#${form} [name="${name}"]`)!;
function controls() { document.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = !ready || busy; }); }
function section(title: string, rows: string[]) {
  const h = document.createElement('h2'); h.textContent = title;
  const list = document.createElement('ul');
  for (const text of rows.length ? rows : ['Nothing here yet.']) { const li = document.createElement('li'); li.textContent = text; list.append(li); }
  overview.append(h, list);
}
function options(id: string, rows: { id: string; name: string }[]) {
  const select = node(id); select.replaceChildren();
  for (const row of rows) { const option = document.createElement('option'); option.value = row.id; option.textContent = row.name; select.append(option); }
}
function thread(topic: NonNullable<Extract<V2View, { view: 'forum' }>['topic']> | null | undefined) {
  section('Conversation', topic ? topic.posts.map(p => `${p.authorName} [${p.authorKind}] · ${new Date(p.createdAt).toISOString()} · ${p.postId}${p.replyTo ? ` · quoting ${p.replyTo}` : ''}${p.edited ? ' · edited' : ''}\n${p.hidden ? '[Hidden by a guide]' : p.body ?? ''}`) : []);
  node('reply').hidden = !!topic?.locked;
  if (topic?.locked) section('Locked', ['This conversation is locked.']);
}
function render(data: V2View) {
  current = data.view; journeyId = data.journeyId;
  itemId = undefined; roundId = undefined; topicId = undefined; documentId = undefined;
  overview.replaceChildren(); field('interview', 'text').value = '';
  for (const id of ['filters', 'item', 'board', 'thread', 'newtopic', 'reply', 'round', 'interview', 'contribute', 'my-interview', 'share', 'document']) node(id).hidden = true;
  node('title').textContent = data.view === 'agents' ? 'Agent capabilities' : `Journey ${data.view === 'round' ? 'sensemaking' : data.view}`;
  if (data.view === 'library') {
    node('filters').hidden = false; node('item').hidden = false;
    section('Library', data.items.map(i => `${i.name} · ${i.kind} · ${i.labels.join(', ')} · ${i.visibility} · version ${i.version}`));
    options('item-options', data.items.map(i => ({ id: i.itemId, name: i.name })));
    if (data.item) {
      const i = data.item; itemId = i.itemId; node('title').textContent = i.name;
      section('Library artifact', [i.name, i.description, `${i.kind} · ${i.storage} · ${i.size} bytes · version ${i.version}`, `Owner: ${i.owner} · ${i.visibility}`, `Labels: ${i.labels.join(', ')}`, `Project: ${i.projectId ?? 'None'}`, 'Content stays outside this metadata view. Ask your agent to read the artifact through library_get.']);
      thread(data.conversation?.topic); node('reply').hidden = !!data.conversation?.topic?.locked;
    }
  } else if (data.view === 'forum') {
    node('board').hidden = false;
    if (data.boards) { boardId = undefined; section('Boards', data.boards.map(b => `${b.name}${b.archived ? ' · archived' : ''} — ${b.description}`)); options('board-options', data.boards.map(b => ({ id: b.boardId, name: b.name }))); }
    if (data.topics) {
      section('Topics', data.topics.map(t => `${t.title} · ${t.replyCount} replies · ${new Date(t.lastActivity).toISOString()} · ${t.authorName} [${t.authorKind}]${t.locked ? ' · locked' : ''}`));
      options('topic-options', data.topics.map(t => ({ id: t.topicId, name: t.title }))); node('thread').hidden = false; node('newtopic').hidden = !boardId;
    }
    if (data.topic) { topicId = data.topic.topicId; boardId = data.topic.boardId; node('title').textContent = data.topic.title; thread(data.topic); }
  } else if (data.view === 'round') {
    node('round').hidden = false;
    section('Rounds', data.rounds.map(r => `${r.title} · ${r.status} · ${r.goal}`)); options('round-options', data.rounds.map(r => ({ id: r.roundId, name: r.title })));
    if (data.round) {
      const r = data.round; roundId = r.roundId; node('title').textContent = r.title;
      section('Goal', [r.goal, `Facilitator: ${r.facilitator} · ${r.format}`]);
      section('Status', ['planned → open → synthesising → closed', `Current: ${r.status}`]);
      section('Participants', r.participants.map(p => `${p.personId} · ${p.live ? 'member' : 'departed'} · interview ${p.interviewShared ? 'shared' : 'private'}`));
      section('Guidance', [r.guidance?.name ?? 'Unavailable', 'Ask your agent to read the guidance artifact before starting your interview.']);
      section('Related artifacts', r.related.map(i => `${i.name} (${i.itemId})`));
      section('Contributions', [`${r.contributions} contributions`, ...r.contributionSummary.map(c => `${c.personId}: ${c.count}`)]);
      documentId = r.document?.itemId; node('document').hidden = !documentId; node('my-interview').hidden = false;
      node('contribute').hidden = r.status !== 'open' && r.status !== 'synthesising';
      thread(data.conversation?.topic);
      if (data.interview) {
        const interview = data.interview; section('My interview', [interview.label, interview.shared ? 'Shared with the round. Future edits are shared too.' : 'Private to you and your agents.', interview.text]);
        field('interview', 'text').value = interview.text; node('interview').hidden = false; node('share').hidden = interview.shared;
      }
    }
  } else {
    for (const agent of data.agents) {
      section(agent.name, [agent.live ? 'Live agent' : 'Removed agent', 'Read-only card. Capabilities narrow the person’s live authority; roles and ownership still apply.']);
      for (const scope of ['account', 'journey']) section(scope === 'account' ? 'Account capabilities' : 'Journey capabilities', capabilities.filter(c => c.scope === scope && agent.capabilities.includes(c.name)).map(c => `${c.name} · requires ${c.authority}`));
    }
    section('Manage permissions', ['Open your console to change cards. Widening requires your passkey. Agents never issue grants.']);
  }
  status.textContent = 'Up to date.';
}
function result(value: { isError?: boolean; structuredContent?: unknown }) {
  // Drop old private text on refusals or malformed results, not just on success.
  if (value.isError) { overview.replaceChildren(); field('interview', 'text').value = ''; status.textContent = 'The operation was refused. Check permissions and refresh.'; return; }
  const parsed = v2View.safeParse(value.structuredContent);
  if (!parsed.success) { overview.replaceChildren(); field('interview', 'text').value = ''; status.textContent = 'The host returned invalid view data.'; return; }
  render(parsed.data);
}
async function call(name: string, args: Record<string, unknown>) {
  if (!ready || busy) return;
  busy = true; controls(); status.textContent = 'Working…';
  try { result(await app.callServerTool({ name, arguments: { ...args, ...(actingAgent ? { actingAgent } : {}) } })); }
  catch { overview.replaceChildren(); field('interview', 'text').value = ''; status.textContent = 'Could not reach the tool. Refresh to try again.'; }
  finally { busy = false; controls(); }
}
function form(id: string, action: () => void) { node(id).addEventListener('submit', e => { e.preventDefault(); if (ready && !busy && journeyId) action(); }); }
function refresh() {
  if (current === 'agents') void call('apps_v2_agents', { agentId, journeyId });
  else if (journeyId) void call(`apps_v2_${current}`, { journeyId, ...(current === 'library' ? { ...filters, itemId } : current === 'round' ? { roundId } : { ...(topicId ? { topicId } : { boardId }) }) });
}
app.ontoolinput = ({ arguments: args }) => {
  overview.replaceChildren(); field('interview', 'text').value = '';
  journeyId = typeof args?.journeyId === 'string' ? args.journeyId : undefined;
  actingAgent = typeof args?.actingAgent === 'string' ? args.actingAgent : undefined;
  agentId = typeof args?.agentId === 'string' ? args.agentId : undefined;
  itemId = undefined; roundId = undefined; topicId = undefined; boardId = undefined;
};
app.ontoolresult = result;
node('refresh').addEventListener('click', refresh);
node('signin').addEventListener('click', () => { if (ready) void app.openLink({ url: CONSOLE_URL }).catch(() => { status.textContent = 'Could not open the console.'; }); });
for (const kind of ['library', 'forum', 'round', 'agents'] as const) node(`nav-${kind}`).addEventListener('click', () => {
  if (kind === 'agents' || journeyId) { boardId = undefined; filters = {}; void call(`apps_v2_${kind}`, kind === 'agents' ? { journeyId } : { journeyId }); }
});
node('my-interview').addEventListener('click', () => { if (roundId) void call('apps_v2_interview_read', { journeyId, roundId }); });
node('share').addEventListener('click', () => { if (roundId) void call('apps_v2_interview_share', { journeyId, roundId }); });
node('document').addEventListener('click', () => { if (documentId) void call('apps_v2_library', { journeyId, itemId: documentId }); });
form('filters', () => {
  filters = { query: field('filters', 'query').value, includeProjects: field('filters', 'includeProjects').value === 'true' };
  for (const key of ['kind', 'label', 'projectId']) if (field('filters', key).value) filters[key] = field('filters', key).value;
  void call('apps_v2_library', { journeyId, ...filters });
});
form('item', () => { void call('apps_v2_library', { journeyId, itemId: field('item', 'itemId').value }); });
form('board', () => { boardId = field('board', 'boardId').value; void call('apps_v2_forum', { journeyId, boardId }); });
form('thread', () => { void call('apps_v2_forum', { journeyId, topicId: field('thread', 'topicId').value }); });
form('newtopic', () => { if (boardId) void call('apps_v2_topic', { boardId, title: field('newtopic', 'title').value, body: field('newtopic', 'body').value }); });
form('round', () => { void call('apps_v2_round', { journeyId, roundId: field('round', 'roundId').value }); });
form('interview', () => { if (roundId) void call('apps_v2_interview_write', { journeyId, roundId, text: field('interview', 'text').value }); });
form('contribute', () => { if (roundId) void call('apps_v2_contribute', { journeyId, roundId, text: field('contribute', 'text').value }); });
form('reply', () => {
  const replyTo = field('reply', 'replyTo').value;
  if (itemId || roundId || topicId) void call('apps_v2_reply', { journeyId, ...(itemId ? { itemId } : roundId ? { roundId } : { topicId }), body: field('reply', 'body').value, ...(replyTo ? { replyTo } : {}) });
});
void app.connect().then(() => { ready = true; controls(); status.textContent = 'Connected.'; }).catch(() => { status.textContent = 'This view needs an MCP Apps-capable host.'; });
