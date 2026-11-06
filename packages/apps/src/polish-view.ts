import { App } from '@modelcontextprotocol/ext-apps';
import { v2View, CONSOLE_URL, type V2View } from './v2-contract.ts';
import { kindPath, roundStages } from './presentation.ts';
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
// Metadata stays text, never HTML. Icons are constructed from fixed local SVG paths.
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); e.textContent = text; e.className = className; return e;
}
function icon(kind: string) {
  const e = el('span', '', 'wf-kind-icon'), ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'), path = document.createElementNS(ns, 'path');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '28', height: '28', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  path.setAttribute('d', kindPath(kind)); svg.append(path); e.append(svg); return e;
}
function chip(text: string, accent = false) { return el('span', text, `wf-chip${accent ? ' wf-chip-accent' : ''}`); }
function avatar(name: string) { return el('span', name.trim().slice(0, 2).toUpperCase() || '?', 'wf-avatar'); }
function action(label: string, run: () => void) { const b = el('button', label, 'wf-card-open'); b.type = 'button'; b.addEventListener('click', run); return b; }
function empty(title: string, hint: string) { const e = el('div', '', 'wf-empty'); e.append(el('h3', title), el('p', hint)); return e; }
function panel(title: string, text?: string, className = '') { const p = el('section', '', `wf-panel ${className}`); p.append(el('h2', title)); if (text) p.append(el('p', text)); return p; }
function section(title: string, rows: string[]) { const p = panel(title); for (const text of rows) p.append(el('p', text)); overview.append(p); }
function hero(label: string, title: string, hint: string) { const h = el('section', '', 'wf-hero'); h.append(el('span', label, 'wf-eyebrow'), el('h2', title), el('p', hint, 'wf-muted')); overview.append(h); return h; }
function options(id: string, rows: { id: string; name: string }[]) {
  const select = node(id); select.replaceChildren();
  for (const row of rows) { const option = el('option', row.name); option.value = row.id; select.append(option); }
}
function date(value: number) { return new Date(value).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
function thread(topic: NonNullable<Extract<V2View, { view: 'forum' }>['topic']> | null | undefined) {
  const p = panel('Conversation');
  if (!topic?.posts.length) p.append(empty('A conversation starts here', 'Bring a question, connect an idea, or add a reply below.'));
  if (topic) {
    const summary = el('div', '', 'wf-chips'); summary.append(chip(`${topic.replyCount} replies`)); if (topic.locked) summary.append(chip('Locked')); p.append(summary);
    for (const post of topic.posts) {
      const article = el('article', '', 'wf-post'), body = el('div'), header = el('header');
      header.append(el('strong', post.authorName), chip(`[${post.authorKind}]`, post.authorKind === 'agent'), el('span', date(post.createdAt), 'wf-muted'));
      body.append(header);
      if (post.replyTo) body.append(el('blockquote', `Reply to ${post.replyTo}`));
      body.append(el('div', post.hidden ? '[Hidden by a guide]' : post.body ?? '', 'wf-post-body'), el('span', `${post.postId}${post.edited ? ' · edited' : ''}`, 'wf-muted'));
      article.append(avatar(post.authorName), body); p.append(article);
    }
  }
  overview.append(p); node('reply').hidden = !!topic?.locked;
  if (topic?.locked) p.append(el('p', 'This conversation is locked. Replies are closed.', 'wf-muted'));
}
type Item = Extract<V2View, { view: 'library' }>['items'][number];
function itemCard(i: Item) {
  const card = el('article', '', 'wf-card'); card.dataset.kind = i.kind;
  const top = el('div', '', 'wf-card-top'); top.append(icon(i.kind), chip(i.kind));
  const preview = el('div', '', 'wf-preview'); preview.append(icon(i.kind), el('span', `${i.kind} · v${i.version}`));
  const labels = el('div', '', 'wf-chips'); for (const label of i.labels) labels.append(chip(label)); labels.append(chip(i.visibility));
  card.append(top, preview, el('h3', i.name), el('p', i.description || 'No description yet.'), labels, el('p', `${i.size.toLocaleString('en')} bytes · ${i.storage}`, 'wf-muted'), action('View details →', () => { void call('apps_v2_library', { journeyId, itemId: i.itemId }); }));
  return card;
}
let layout: 'grid' | 'list' = 'grid';
function render(data: V2View) {
  current = data.view; journeyId = data.journeyId;
  itemId = undefined; roundId = undefined; topicId = undefined; documentId = undefined;
  overview.replaceChildren(); field('interview', 'text').value = '';
  for (const id of ['filters', 'item', 'board', 'thread', 'newtopic', 'reply', 'round', 'interview', 'contribute', 'my-interview', 'share', 'share-note', 'document', 'layout-controls']) node(id).hidden = true;
  node('title').textContent = data.view === 'agents' ? 'Your agent team' : data.view === 'round' ? 'Sensemaking studio' : data.view === 'library' ? 'The library' : 'The forum';
  node('subtitle').textContent = data.view === 'library' ? 'Collect the useful. Connect the unexpected.' : data.view === 'round' ? 'Many perspectives. A clearer way forward.' : data.view === 'forum' ? 'Good questions become shared understanding.' : 'Small cards. Deliberate capabilities.';
  for (const kind of ['library', 'forum', 'round', 'agents']) node(`nav-${kind}`).ariaCurrent = kind === data.view ? 'page' : null;
  if (data.view === 'library') {
    node('filters').hidden = false; node('item').hidden = !data.items.length; node('layout-controls').hidden = !!data.item;
    if (!data.item) {
      hero('Knowledge collection', `${data.items.length} artifacts to explore`, 'Browse by kind, label or project. These are metadata previews; content stays outside this view.');
      const grid = el('div', '', `wf-grid${layout === 'list' ? ' wf-list' : ''}`); grid.id = 'library-grid';
      for (const i of data.items) grid.append(itemCard(i));
      if (!data.items.length) grid.append(empty('Make room for the next useful idea', 'No artifacts match these filters. Clear your search, or ask your agent to add a source with library_add.'));
      overview.append(grid);
    }
    options('item-options', data.items.map(i => ({ id: i.itemId, name: i.name })));
    if (data.item) {
      const i = data.item; itemId = i.itemId; node('title').textContent = i.name;
      const detail = hero('Library artifact', i.name, i.description || 'No description yet.'); detail.prepend(icon(i.kind));
      const labels = el('div', '', 'wf-chips'); for (const label of [i.kind, ...i.labels, i.visibility, `version ${i.version}`]) labels.append(chip(label)); detail.append(labels);
      section('Artifact details', [`Owner: ${i.owner}`, `${i.storage} · ${i.size} bytes · Project: ${i.projectId ?? 'None'}`, 'Content stays outside this metadata view. Ask your agent to read the artifact through library_get.']);
      thread(data.conversation?.topic); node('reply').hidden = !!data.conversation?.topic?.locked;
    }
  } else if (data.view === 'forum') {
    node('board').hidden = false;
    if (data.boards) {
      boardId = undefined;
      hero('Journey conversations', 'A place to think together', 'Browse a board, open a topic, and bring your perspective. Posts are attributed to people and agents.');
      const layout = el('div', '', 'wf-forum-layout'), sidebar = el('aside', '', 'wf-sidebar'); sidebar.ariaLabel = 'Forum boards'; sidebar.append(el('h2', 'Boards'));
      for (const b of data.boards) { const button = action(b.name, () => { boardId = b.boardId; void call('apps_v2_forum', { journeyId, boardId }); }); button.className = 'wf-board'; sidebar.append(button, el('p', b.description, 'wf-muted')); if (b.archived) sidebar.append(chip('Archived')); }
      const welcome = panel('Pick a conversation space', 'Choose a board to see its latest topics. Open a thread to read attributed posts and replies.'); welcome.prepend(icon('prompt')); welcome.append(el('p', 'A good topic starts with a clear question and a little context.', 'wf-muted'));
      layout.append(sidebar, welcome);
      if (!data.boards.length) layout.append(empty('Your forum is ready for its first board', 'Ask a guide to create a board, then start with a question worth exploring.'));
      overview.append(layout); options('board-options', data.boards.map(b => ({ id: b.boardId, name: b.name })));
    }
    if (data.topics) {
      hero('Board activity', 'Topics', 'Read what others are exploring, or start a new conversation below.');
      overview.append(action('← All boards', () => { boardId = undefined; void call('apps_v2_forum', { journeyId }); }));
      const list = el('div', '', 'wf-topics');
      for (const t of data.topics) {
        const row = el('article', '', 'wf-topic'), body = el('div', '', 'wf-topic-main'), count = el('div', '', 'wf-topic-count');
        body.append(el('h3', t.title), el('span', `${t.authorName} [${t.authorKind}] · ${date(t.lastActivity)}`, 'wf-muted')); if (t.locked) body.append(chip('Locked'));
        body.append(action('Read topic →', () => { void call('apps_v2_forum', { journeyId, topicId: t.topicId }); })); count.append(el('strong', String(t.replyCount)), el('span', 'replies')); row.append(avatar(t.authorName), body, count); list.append(row);
      }
      if (!data.topics.length) list.append(empty('Ask the first question', 'Start a topic below. Give it a clear title and a little context.'));
      overview.append(list); options('topic-options', data.topics.map(t => ({ id: t.topicId, name: t.title }))); node('thread').hidden = !data.topics.length; node('newtopic').hidden = !boardId;
    }
    if (data.topic) { topicId = data.topic.topicId; boardId = data.topic.boardId; node('title').textContent = data.topic.title; thread(data.topic); }
  } else if (data.view === 'round') {
    node('round').hidden = !data.rounds.length;
    if (!data.round) {
      hero('Sensemaking rounds', 'Listen. Connect. Make sense.', 'Private reflection first, shared understanding next. Choose a round to see where the group is heading.');
      const grid = el('div', '', 'wf-grid');
      for (const r of data.rounds) { const card = el('article', '', 'wf-card'); card.append(icon('skill'), chip(r.status, true), el('h3', r.title), el('p', r.goal), el('p', `${r.contributions} contributions · ${r.format}`, 'wf-muted'), action('Explore round →', () => { void call('apps_v2_round', { journeyId, roundId: r.roundId }); })); grid.append(card); }
      if (!data.rounds.length) grid.append(empty('Start with a shared question', 'Ask a facilitator to create a round with round_create. Each participant gets space for a private interview.'));
      overview.append(grid);
    }
    options('round-options', data.rounds.map(r => ({ id: r.roundId, name: r.title })));
    if (data.round) {
      const r = data.round; roundId = r.roundId; node('title').textContent = r.title;
      const head = hero('Round workspace', r.title, r.goal); head.append(el('p', `Facilitator: ${r.facilitator} · ${r.format}`, 'wf-muted'));
      const steps = el('ol', '', 'wf-stepper'); steps.ariaLabel = 'Round lifecycle';
      for (const stage of roundStages) { const li = el('li', stage, roundStages.indexOf(stage) < roundStages.indexOf(r.status) ? 'wf-complete' : ''); if (stage === r.status) li.ariaCurrent = 'step'; steps.append(li); } head.append(steps);
      const split = el('div', '', 'wf-split'), participants = panel('Participants'), document = panel('Sensemaking document', r.document?.name ?? 'No synthesis document yet.');
      for (const p of r.participants) {
        const row = el('div', '', 'wf-participant'), body = el('div', '', 'wf-participant-main'), count = r.contributionSummary.find(c => c.personId === p.personId)?.count ?? 0;
        body.append(el('strong', p.personId), el('p', `${p.live ? 'Member' : 'Departed'} · interview ${p.interviewShared ? 'shared' : 'private'} · ${count} contributions`, 'wf-muted'));
        const progress = el('progress'); progress.max = Math.max(r.contributions, 1); progress.value = count; progress.ariaLabel = `${p.personId}: ${count} of ${r.contributions} contributions`; body.append(progress); row.append(avatar(p.personId), body); participants.append(row);
      }
      if (!r.participants.length) participants.append(el('p', 'No participants yet.', 'wf-muted'));
      document.append(chip(`${r.contributions} contributions`, true), el('p', 'Contributions are credited to people, including work helped by their agents.', 'wf-muted')); split.append(participants, document); overview.append(split);
      section('Guidance', [r.guidance?.name ?? 'Unavailable', 'Ask your agent to read the guidance artifact before starting your interview.']);
      if (r.related.length) section('Related artifacts', r.related.map(i => i.name));
      if (r.status === 'closed') section('Continue the journey', ['Ask your facilitator to use round_next to carry this synthesis into a new round.']);
      documentId = r.document?.itemId; node('document').hidden = !documentId; node('my-interview').hidden = false;
      node('contribute').hidden = r.status !== 'open' && r.status !== 'synthesising';
      thread(data.conversation?.topic);
      if (data.interview) {
        const interview = data.interview, p = panel('My interview', interview.label, 'wf-private'); p.append(chip(interview.shared ? 'Shared with the round' : 'Private to you and your agents', true), el('p', `Belongs to ${interview.personId}`, 'wf-muted'), el('pre', interview.text)); if (interview.shared) p.append(el('p', 'Future edits are shared too.')); overview.append(p);
        field('interview', 'text').value = interview.text; node('interview').hidden = false; node('share').hidden = interview.shared; node('share-note').hidden = interview.shared;
      }
    }
  } else {
    hero('Capability cards', 'Meet your agent team', 'Capabilities narrow a person’s live authority. These cards show permission state, not connection or presence.');
    const grid = el('div', '', 'wf-grid');
    for (const agent of data.agents) {
      const card = el('article', '', 'wf-card wf-agent'), top = el('div', '', 'wf-card-top'); top.append(avatar(agent.name), el('span', agent.live ? 'Live agent' : 'Removed agent', `wf-chip${agent.live ? ' wf-live' : ''}`)); card.append(top, el('h2', agent.name), el('p', agent.agentId, 'wf-muted'));
      for (const scope of ['account', 'journey']) { card.append(el('h3', scope === 'account' ? 'Account capabilities' : 'Journey capabilities')); const chips = el('div', '', 'wf-chips'); for (const c of capabilities.filter(c => c.scope === scope && agent.capabilities.includes(c.name))) { const tag = chip(c.name, true); tag.title = `Requires ${c.authority}`; chips.append(tag); } if (!chips.children.length) chips.append(chip('No capabilities')); card.append(chips); }
      card.append(el('p', 'Person owner details are not included in this view. Open the console to manage this card.', 'wf-muted')); grid.append(card);
    }
    if (!data.agents.length) grid.append(empty('Your next collaborator starts here', 'Create an agent in the console, then choose only the capabilities it needs.'));
    overview.append(grid); section('Manage permissions', ['Open your console to change cards. Widening requires your passkey. Agents never issue grants.']);
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
  if (kind === 'agents' || journeyId) { boardId = undefined; filters = {}; void call(`apps_v2_${kind}`, { journeyId }); }
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
for (const choice of ['grid', 'list'] as const) node(`layout-${choice}`).addEventListener('click', () => {
  layout = choice; const grid = document.getElementById('library-grid'); if (grid) grid.className = `wf-grid${choice === 'list' ? ' wf-list' : ''}`;
  node('layout-grid').ariaPressed = String(choice === 'grid'); node('layout-list').ariaPressed = String(choice === 'list');
});
