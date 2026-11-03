import * as z from 'zod';
import { parseCommand, Refused, type ToolData } from '../commands.ts';
import type { ClientIdentity } from '../agents.ts';
import type { ConsoleBackend } from './contract.ts';
import { page, escape, journeyNav } from './pages.ts';
import { kinds, itemMetadata, roundDetail, ownInterview } from '../../../apps/src/v2-contract.ts';
import { libraryInputs } from '../library-inputs.ts';
import { forumView } from '../../../apps/src/forum-contract.ts';
const rows = (value: unknown) => z.array(z.record(z.string(), z.unknown())).parse(value);
const segment = (id: unknown) => encodeURIComponent(z.string().min(1).max(200).parse(id));
export async function workspacePage(backend: ConsoleBackend, identity: ClientIdentity, url: URL, csrf: string): Promise<string | undefined> {
  const parts = url.pathname.split('/');
  if (parts.length < 5 || parts.length > 6 || parts[1] !== 'console' || parts[2] !== 'journeys') return undefined;
  const decode = (part: string) => { const id = decodeURIComponent(part); if (!id || id.includes('/') || id.length > 200) throw new Refused('Invalid console target'); return id; };
  const journeyId = decode(parts[3]!), kind = parts[4], selected = parts[5] ? decode(parts[5]) : undefined;
  if (!['library', 'forum', 'rounds'].includes(kind ?? '')) return undefined;
  const allowed = kind === 'library' && !selected ? ['query', 'kind', 'label', 'projectId', 'includeProjects'] : kind === 'rounds' && selected ? ['interview'] : [];
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new Refused('Invalid view filter');
  const call = (tool: Parameters<typeof parseCommand>[0], input: Record<string, unknown>) => backend.execute(identity.subject, parseCommand(tool, input), identity.clientId);
  const journey = await call('journey_read', { journeyId });
  const root = `/console/journeys/${segment(journeyId)}`;
  const list = (items: string[]) => `<ul>${items.map(i => `<li>${i}</li>`).join('') || '<li>Nothing here yet.</li>'}</ul>`;
  const link = (route: string, name: unknown) => `<a href="${route}">${escape(name)}</a>`;
  const check = (data: ToolData) => { if (data.journeyId !== journeyId) throw new Refused('Console journey mismatch'); return data; };
  const thread = (data: ToolData) => {
    if (!data.topic) return '<h2>Conversation</h2><p>No posts yet. Use your agent to start the conversation.</p>';
    const topic = forumView.shape.topic.unwrap().parse({ ...z.record(z.string(), z.unknown()).parse(data.topic), posts: data.posts });
    return `<h2>Conversation${topic.locked ? ' · locked' : ''}</h2>${list(topic.posts.map(p => `<p>${escape(p.authorName)} <strong>${escape(p.authorKind)}</strong> · ${escape(new Date(p.createdAt).toISOString())}${p.replyTo ? ` · quoting ${escape(p.replyTo)}` : ''}</p><pre>${escape(p.hidden ? '[Hidden by a guide]' : p.body)}</pre>`))}<p>Reply through your agent or the forum App.</p>`;
  };
  let content = '', title = '';
  if (kind === 'library') {
    title = 'Library';
    if (!selected) {
      const input = libraryInputs.library_search.parse({ journeyId, ...Object.fromEntries(['query', 'kind', 'label', 'projectId'].flatMap(key => url.searchParams.has(key) && url.searchParams.get(key) ? [[key, url.searchParams.get(key)]] : [])), includeProjects: url.searchParams.get('includeProjects') === 'true' });
      if (url.searchParams.has('includeProjects') && !['true', 'false'].includes(url.searchParams.get('includeProjects')!)) throw new Refused('Invalid project filter');
      const items = z.array(itemMetadata).parse((await call('library_search', input)).items);
      content = `<form method="get" action="${root}/library"><label>Search <input type="search" name="query" maxlength="4096" value="${escape(input.query)}"></label><label>Kind <select name="kind"><option value="">All kinds</option>${kinds.map(k => `<option value="${k}"${k === input.kind ? ' selected' : ''}>${k}</option>`).join('')}</select></label><label>Label <input name="label" maxlength="200" value="${escape(input.label)}"></label><label>Project ID <input name="projectId" maxlength="200" value="${escape(input.projectId)}"></label><label>Project artifacts <select name="includeProjects"><option value="false">Hide project artifacts</option><option value="true"${input.includeProjects ? ' selected' : ''}>Include project artifacts</option></select></label><button>Apply filters</button></form>`
        + list(items.map(i => `${link(`${root}/library/${segment(i.itemId)}`, i.name)} · ${escape(i.kind)} · ${escape(i.labels.join(', '))} · ${escape(i.visibility)} · version ${i.version}`));
    } else {
      const item = itemMetadata.parse(check(await call('library_get', { itemId: selected })));
      title = item.name;
      content = `<p>${escape(item.description)}</p><dl><dt>Kind</dt><dd>${escape(item.kind)}</dd><dt>Owner</dt><dd>${escape(item.owner)}</dd><dt>Labels</dt><dd>${escape(item.labels.join(', '))}</dd><dt>Visibility</dt><dd>${escape(item.visibility)}</dd><dt>Version</dt><dd>${item.version}</dd></dl><p>Content stays outside this metadata view. Ask your agent to read the artifact.</p>` + thread(await call('conversation_read', { journeyId, target: { itemId: selected } }));
    }
  } else if (kind === 'forum') {
    title = 'Forum';
    if (!selected) {
      const boards = (await call('forum_boards', { journeyId })).boards;
      content = '<h2>Boards</h2>' + list(rows(boards).map(b => `${escape(b.name)} · ${escape(b.description)}${b.archived ? ' · archived' : ''}`));
      const topics = (await call('topic_list', { journeyId })).topics;
      content += '<h2>Topics</h2>' + list(rows(topics).map(t => `${link(`${root}/forum/${segment(t.topicId)}`, t.title)} · ${escape(t.replyCount)} replies · ${escape(new Date(Number(t.lastActivity)).toISOString())}`));
    } else {
      const topic = check(await call('topic_read', { topicId: selected })); title = String(topic.title);
      content = thread({ topic, posts: topic.posts });
    }
  } else {
    title = 'Sensemaking rounds';
    if (!selected) content = list(rows((await call('round_list', { journeyId })).rounds).map(r => `${link(`${root}/rounds/${segment(r.roundId)}`, r.title)} · ${escape(r.goal)} · ${escape(r.status)}`));
    else {
      const round = roundDetail.parse(check(await call('round_read', { roundId: selected }))); title = round.title;
      const artifactLink = (item: z.output<typeof itemMetadata> | undefined) => item ? link(`${root}/library/${segment(item.itemId)}`, item.name) : 'Unavailable';
      content = `<h2>Goal</h2><p>${escape(round.goal)}</p><h2>Status</h2><ol aria-label="Round lifecycle">${['planned', 'open', 'synthesising', 'closed'].map(status => `<li${status === round.status ? ' aria-current="step"' : ''}>${status}</li>`).join('')}</ol><p>Facilitator: ${escape(round.facilitator)}</p><h2>Guidance</h2><p>${artifactLink(round.guidance)}</p><h2>Sensemaking document</h2><p>${artifactLink(round.document)}</p><h2>Related artifacts</h2>${list(round.related.map(artifactLink))}<h2>Participants</h2>${list(round.participants.map(p => `${escape(p.personId)} · interview ${p.interviewShared ? 'shared' : 'private'}${p.live ? '' : ' · departed'}`))}<h2>Contributions</h2><p>${round.contributions} contributions</p>${list(round.contributionSummary.map(c => `${escape(c.personId)}: ${c.count}`))}`;
      content += `<p>${link(`${root}/rounds/${segment(selected)}?interview=mine`, 'Read my interview')}</p>`;
      if (url.searchParams.has('interview')) {
        if (url.searchParams.get('interview') !== 'mine') throw new Refused('Only your own interview is available here');
        const interview = ownInterview.parse(await call('interview_read', { roundId: selected }));
        content += `<h2>My interview</h2><p>${escape(interview.label)} · ${interview.shared ? 'Shared with the round' : 'Private to you and your agents'}</p><pre>${escape(interview.text)}</pre>`;
      }
      content += thread(await call('conversation_read', { journeyId, target: { roundId: selected } }));
    }
  }
  return page(`${title} · ${journey.name}`, journeyNav(journeyId) + content, csrf);
}
