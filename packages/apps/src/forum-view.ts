import { App } from '@modelcontextprotocol/ext-apps';
import { forumView, type ForumView } from './forum-contract.ts';
import { SIGNIN_URL } from './contract.ts';
const app = new App({ name: 'wayfinding-forum', version: '2.0.0' }, {}, { autoResize: false });
const overview = document.getElementById('overview')!, status = document.getElementById('status')!;
let journeyId: string | undefined, boardId: string | undefined, topicId: string | undefined, actingAgent: string | undefined, ready = false, busy = false;
const message = (text: string) => { status.textContent = text; };
function controls() { document.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = !ready || busy; }); }
function field(form: string, name: string): HTMLInputElement { return document.querySelector<HTMLInputElement>(`#${form} [name="${name}"]`)!; }
function section(title: string, rows: string[]) {
  const h = document.createElement('h2'); h.textContent = title;
  const list = document.createElement('ul');
  for (const text of rows.length ? rows : ['Nothing here yet.']) { const li = document.createElement('li'); li.textContent = text; list.append(li); }
  overview.append(h, list);
}
function options(id: string, rows: { id: string; name: string }[]) {
  const select = document.getElementById(id)!; select.replaceChildren();
  for (const row of rows) { const option = document.createElement('option'); option.value = row.id; option.textContent = row.name; select.append(option); }
}
function render(data: ForumView) {
  journeyId = data.journeyId; overview.replaceChildren();
  if (data.boards) {
    boardId = undefined; topicId = undefined;
    document.getElementById('title')!.textContent = 'Journey forum';
    section('Boards', data.boards.map(b => `${b.name}${b.archived ? ' · archived' : ''} — ${b.description}`));
    options('board-options', data.boards.map(b => ({ id: b.boardId, name: `${b.name}${b.archived ? ' (archived)' : ''}` })));
    options('topic-options', []);
  }
  if (data.topics) {
    topicId = undefined;
    section('Topics', data.topics.map(t => `${t.title} · ${t.replyCount} replies · ${t.authorName} [${t.authorKind}] · ${new Date(t.lastActivity).toISOString()}${t.locked ? ' · locked' : ''}`));
    options('topic-options', data.topics.map(t => ({ id: t.topicId, name: t.title })));
  }
  if (data.topic) {
    const t = data.topic; topicId = t.topicId; boardId = t.boardId;
    document.getElementById('title')!.textContent = t.title;
    section(t.locked ? 'Thread · locked' : 'Thread', t.posts.map(p => `${p.authorName} [${p.authorKind}]${p.edited ? ' · edited' : ''} · ${new Date(p.createdAt).toISOString()} · ${p.postId}${p.replyTo ? ` · quoting ${p.replyTo}` : ''}\n${p.hidden ? '[Hidden by a guide]' : p.body ?? ''}`));
  }
  message('Up to date.');
}
function result(value: { isError?: boolean; structuredContent?: unknown }) {
  if (value.isError) { message('The operation was refused. Check permissions and refresh.'); return; }
  const parsed = forumView.safeParse(value.structuredContent);
  if (!parsed.success) { message('The host returned invalid forum data.'); return; }
  render(parsed.data);
}
async function call(name: string, args: Record<string, unknown>) {
  if (!ready || busy) return;
  busy = true; controls(); message('Working…');
  try { result(await app.callServerTool({ name, arguments: { ...args, ...(actingAgent ? { actingAgent } : {}) } })); }
  catch { message('Could not reach the tool. Refresh to try again.'); }
  finally { busy = false; controls(); }
}
function form(id: string, action: () => Promise<void>) {
  document.getElementById(id)!.addEventListener('submit', e => { e.preventDefault(); if (ready && !busy && journeyId) void action(); });
}
app.ontoolinput = ({ arguments: args }) => {
  if (!args) return;
  if (typeof args.journeyId === 'string') journeyId = args.journeyId;
  boardId = typeof args.boardId === 'string' ? args.boardId : undefined;
  topicId = typeof args.topicId === 'string' ? args.topicId : undefined;
  actingAgent = typeof args.actingAgent === 'string' ? args.actingAgent : undefined;
};
app.ontoolresult = result;
document.getElementById('allboards')!.addEventListener('click', () => { if (journeyId) void call('forum_view', { journeyId }); });
document.getElementById('refresh')!.addEventListener('click', () => { if (journeyId) void call('forum_view', { journeyId, ...(topicId ? { topicId } : boardId ? { boardId } : {}) }); });
document.getElementById('signin')!.addEventListener('click', () => { if (ready) void app.openLink({ url: SIGNIN_URL }).catch(() => message('Could not open sign-in.')); });
form('board', async () => { boardId = field('board', 'boardId').value; await call('forum_view', { journeyId, boardId }); });
form('thread', async () => { topicId = field('thread', 'topicId').value; await call('forum_view', { journeyId, topicId }); });
form('newtopic', async () => { if (boardId) await call('forum_topic_create_view', { boardId, title: field('newtopic', 'title').value, body: field('newtopic', 'body').value }); });
form('reply', async () => { if (topicId) { const replyTo = field('reply', 'replyTo').value; await call('forum_post_create_view', { topicId, body: field('reply', 'body').value, ...(replyTo ? { replyTo } : {}) }); } });
void app.connect().then(() => { ready = true; controls(); message('Connected.'); }).catch(() => message('This view needs an MCP Apps-capable host.'));
