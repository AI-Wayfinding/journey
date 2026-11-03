import { App } from '@modelcontextprotocol/ext-apps';
import { refreshTools, SIGNIN_URL, viewData, type ViewData, type ViewKind } from './contract.ts';

const kind = document.body.dataset.view as ViewKind;
const app = new App({ name: `wayfinding-${kind}`, version: '1.0.0' }, {}, { autoResize: false });
const status = document.getElementById('status')!;
const overview = document.getElementById('overview')!;
let context: { journeyId: string; projectId?: string } | undefined;
let ready = false;
function message(text: string) { status.textContent = text; }
function controls(enabled: boolean) { document.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = !enabled; }); }
function section(title: string, rows: string[]) {
  const heading = document.createElement('h2'); heading.textContent = title;
  const list = document.createElement('ul');
  for (const row of rows.length ? rows : ['None']) { const item = document.createElement('li'); item.textContent = row; list.append(item); }
  overview.append(heading, list);
}
function render(data: ViewData) {
  if (data.view !== kind) { message('This result belongs to another view.'); return; }
  context = { journeyId: data.journeyId };
  overview.replaceChildren();
  switch (data.view) {
    case 'journey':
      document.getElementById('title')!.textContent = data.name;
      section('Joining policy', [`${data.policy}; default role: ${data.defaultRole}`]);
      section('Members and roles', data.members.map((m) => `${m.memberId}: ${m.kind}, ${m.role}${m.guide ? ', guide' : ''}${m.owner ? `; owner ${m.owner}` : ''}`));
      section('Agents', data.agents.map((a) => `${a.agentId}: owner ${a.owner}; ${a.signed ? 'signed' : 'unsigned'}; read ${a.read}, write ${a.write}, grant ${a.grant}`));
      section('Projects', data.projects.map((p) => `${p.name} (${p.projectId}): ${p.purpose}; ${p.status}`));
      section('Invites and requests', data.pending.map((p) => `${p.personId}: ${p.status}`));
      field('policy', 'policy').value = data.policy; field('policy', 'defaultRole').value = data.defaultRole;
      break;
    case 'project':
      context.projectId = data.project.projectId;
      document.getElementById('title')!.textContent = data.project.name;
      section('Project', [data.project.purpose, data.project.status]);
      section('Members', data.project.members);
      field('project', 'purpose').value = data.project.purpose; field('project', 'status').value = data.project.status;
      break;
    case 'artifacts':
      section('Names, sizes and versions', data.artifacts.map((a) => `${a.name} (${a.artifactId}): ${a.size} bytes; version ${a.version}`));
      break;
  }
  controls(ready); message('Up to date.');
}
function result(value: { isError?: boolean; structuredContent?: unknown }) {
  if (value.isError) { message('The operation was refused. Check your permissions and refresh.'); return; }
  const parsed = viewData.safeParse(value.structuredContent);
  if (!parsed.success) { message('The host returned invalid view data.'); return; }
  render(parsed.data);
}
async function call(name: string, args: Record<string, unknown>) {
  if (!ready) return;
  controls(false); message('Working…');
  try { result(await app.callServerTool({ name, arguments: args })); }
  catch { message('Could not reach the tool. Refresh to try again.'); }
  finally { controls(ready); }
}
function field(form: string, name: string): HTMLInputElement | HTMLSelectElement {
  return document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${form} [name="${name}"]`)!;
}
function form(id: string, action: () => Promise<void>) {
  document.getElementById(id)?.addEventListener('submit', (event) => { event.preventDefault(); if (ready && context) void action(); });
}
app.ontoolinput = ({ arguments: args }) => {
  // Never forward a host-supplied object: refresh accepts these two identifiers only.
  if (args && typeof args.journeyId === 'string') {
    context = { journeyId: args.journeyId };
    if (kind === 'project' && typeof args.projectId === 'string') context.projectId = args.projectId;
  }
};
app.ontoolresult = result;
document.getElementById('refresh')!.addEventListener('click', () => { if (context) void call(refreshTools[kind], { journeyId: context.journeyId, ...(kind === 'project' ? { projectId: context.projectId } : {}) }); });
document.getElementById('signin')!.addEventListener('click', () => {
  if (ready) void app.openLink({ url: SIGNIN_URL }).then((r) => { if (r.isError) message('The host could not open sign-in.'); }).catch(() => message('The host could not open sign-in.'));
});
form('policy', async () => { await call('apps_journey_policy', { journeyId: context!.journeyId, policy: field('policy', 'policy').value, defaultRole: field('policy', 'defaultRole').value }); });
form('invite', async () => { await call('apps_journey_invite', { journeyId: context!.journeyId, personId: field('invite', 'personId').value }); });
form('project', async () => { await call('apps_project_update', { journeyId: context!.journeyId, projectId: context!.projectId, purpose: field('project', 'purpose').value, status: field('project', 'status').value }); });
form('rename', async () => { await call('apps_artifact_rename', { journeyId: context!.journeyId, artifactId: field('rename', 'artifactId').value, name: field('rename', 'name').value }); });
void app.connect().then(() => { ready = true; controls(true); message('Connected.'); }).catch(() => message('This view needs an MCP Apps-capable host.'));
