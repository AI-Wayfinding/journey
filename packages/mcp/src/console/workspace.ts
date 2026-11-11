import * as z from 'zod';
import { parseCommand, Refused, type ToolData } from '../commands.ts';
import type { ClientIdentity } from '../agents.ts';
import type { ConsoleBackend } from './contract.ts';
import { page, escape, journeyNav } from './pages.ts';
import { kinds, itemMetadata, roundDetail, ownInterview } from '../../../apps/src/v2-contract.ts';
import { kindIcon, roundStages } from '../../../apps/src/presentation.ts';
import { libraryInputs } from '../library-inputs.ts';
import { forumView } from '../../../apps/src/forum-contract.ts';
const rows = (value: unknown) => z.array(z.record(z.string(), z.unknown())).parse(value);
const segment = (id: unknown) => encodeURIComponent(z.string().min(1).max(200).parse(id));
const chip = (text: unknown, accent = false) => `<span class="wf-chip${accent ? ' wf-chip-accent' : ''}">${escape(text)}</span>`;
const avatar = (name: unknown) => `<span class="wf-avatar" aria-hidden="true">${escape(String(name ?? '?').trim().slice(0, 2).toUpperCase())}</span>`;
const date = (value: unknown) => new Date(Number(value)).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const empty = (title: string, hint: string) => `<div class="wf-empty"><h3>${escape(title)}</h3><p>${escape(hint)}</p></div>`;
const hero = (label: string, title: string, hint: string) => `<section class="wf-hero"><span class="wf-eyebrow">${escape(label)}</span><h2>${escape(title)}</h2><p class="wf-muted">${escape(hint)}</p></section>`;
const stepper = (current: string) => `<ol class="wf-stepper" aria-label="Round lifecycle">${roundStages.map((status, index) => `<li${status === current ? ' aria-current="step"' : ''}${index < roundStages.indexOf(current as typeof roundStages[number]) ? ' class="wf-complete"' : ''}>${status}</li>`).join('')}</ol>`;
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
  if(backend.sealedMode)return page('Sealed journey',journeyNav(journeyId)+empty('sealed — open in your client','Forum, Library and Sensemaking content is encrypted. Use your local client; this console has no MLS device.'),csrf);
  const root = `/console/journeys/${segment(journeyId)}`;
  const list = (items: string[]) => `<ul>${items.map(i => `<li>${i}</li>`).join('') || '<li>Nothing here yet.</li>'}</ul>`;
  const link = (route: string, name: unknown, className = '') => `<a class="${className}" href="${route}">${escape(name)}</a>`;
  const check = (data: ToolData) => { if (data.journeyId !== journeyId) throw new Refused('Console journey mismatch'); return data; };
  const thread = (data: ToolData) => {
    if (!data.topic) return `<h2>Conversation</h2>${empty('A conversation starts here', 'Bring a question or ask your agent to start the conversation.')}<p class="wf-muted">Reply through your agent or the forum App.</p>`;
    const topic = forumView.shape.topic.unwrap().parse({ ...z.record(z.string(), z.unknown()).parse(data.topic), posts: data.posts });
    return `<section><h2>Conversation</h2><div class="wf-chips">${chip(`${topic.replyCount} replies`)}${topic.locked ? chip('Locked') : ''}</div>${topic.posts.length ? topic.posts.map(p => `<article class="wf-post">${avatar(p.authorName)}<div><header><strong>${escape(p.authorName)}</strong>${chip(p.authorKind, p.authorKind === 'agent')}<span class="wf-muted">${escape(date(p.createdAt))}</span></header>${p.replyTo ? `<blockquote>Reply to ${escape(p.replyTo)}</blockquote>` : ''}<div class="wf-post-body">${escape(p.hidden ? '[Hidden by a guide]' : p.body)}</div><span class="wf-muted">${escape(p.postId)}${p.edited ? ' · edited' : ''}</span></div></article>`).join('') : empty('No posts yet', 'Start with a question worth exploring.')}<p class="wf-muted">${topic.locked ? 'This conversation is locked. Replies are closed.' : 'Reply through your agent or the forum App.'}</p></section>`;
  };
  const itemCard = (i: z.output<typeof itemMetadata>) => `<article class="wf-card" data-kind="${i.kind}"><div class="wf-card-top"><span class="wf-kind-icon">${kindIcon(i.kind)}</span>${chip(i.kind)}</div><div class="wf-preview" aria-hidden="true">${kindIcon(i.kind)}<span>${escape(i.kind)} · v${i.version}</span></div><h3>${link(`${root}/library/${segment(i.itemId)}`, i.name)}</h3><p>${escape(i.description || 'No description yet.')}</p><div class="wf-chips">${i.labels.map(l => chip(l)).join('')}${chip(i.visibility)}</div><p class="wf-muted">${i.size.toLocaleString('en')} bytes · ${escape(i.storage)}</p>${link(`${root}/library/${segment(i.itemId)}`, 'View details →', 'wf-action wf-card-open')}</article>`;
  let content = '', title = '';
  if (kind === 'library') {
    title = 'Library';
    if (!selected) {
      const input = libraryInputs.library_search.parse({ journeyId, ...Object.fromEntries(['query', 'kind', 'label', 'projectId'].flatMap(key => url.searchParams.has(key) && url.searchParams.get(key) ? [[key, url.searchParams.get(key)]] : [])), includeProjects: url.searchParams.get('includeProjects') === 'true' });
      if (url.searchParams.has('includeProjects') && !['true', 'false'].includes(url.searchParams.get('includeProjects')!)) throw new Refused('Invalid project filter');
      const items = z.array(itemMetadata).parse((await call('library_search', input)).items);
      content = hero('Knowledge collection', `${items.length} artifacts to explore`, 'Collect the useful. Connect the unexpected. These cards show metadata only; content stays outside this view.')
        + `<form class="wf-filters" method="get" action="${root}/library"><h2>Find your next useful idea</h2><label>Search <input type="search" name="query" maxlength="4096" placeholder="Search the collection…" value="${escape(input.query)}"></label><label>Kind <select name="kind"><option value="">All kinds</option>${kinds.map(k => `<option value="${k}"${k === input.kind ? ' selected' : ''}>${k}</option>`).join('')}</select></label><label>Label <input name="label" maxlength="200" value="${escape(input.label)}"></label><label>Project ID <input name="projectId" maxlength="200" value="${escape(input.projectId)}"></label><label>Project artifacts <select name="includeProjects"><option value="false">Hide project artifacts</option><option value="true"${input.includeProjects ? ' selected' : ''}>Include project artifacts</option></select></label><button>Apply filters</button>${link(`${root}/library`, 'Clear filters', 'wf-action')}</form>`
        + `<fieldset class="wf-layout"><legend>Library layout</legend><label><input type="radio" id="wf-grid" name="layout" checked> Grid</label><label><input type="radio" id="wf-list" name="layout"> List</label></fieldset><div class="wf-grid">${items.map(itemCard).join('') || empty('Make room for the next useful idea', 'No artifacts match these filters. Clear your search, or ask your agent to add a source with library_add.')}</div>`;
    } else {
      const item = itemMetadata.parse(check(await call('library_get', { itemId: selected })));
      title = item.name;
      content = hero('Library artifact', item.name, item.description) + `<section class="wf-panel" data-kind="${item.kind}"><span class="wf-kind-icon">${kindIcon(item.kind)}</span><div class="wf-chips">${chip(item.kind)}${item.labels.map(l => chip(l)).join('')}${chip(item.visibility)}${chip(`version ${item.version}`)}</div><dl><dt>Owner</dt><dd>${escape(item.owner)}</dd><dt>Storage</dt><dd>${escape(item.storage)} · ${item.size.toLocaleString('en')} bytes</dd><dt>Project</dt><dd>${escape(item.projectId ?? 'None')}</dd></dl><p class="wf-muted">Content stays outside this metadata view. Ask your agent to read the artifact.</p></section>` + thread(await call('conversation_read', { journeyId, target: { itemId: selected } }));
    }
  } else if (kind === 'forum') {
    title = 'Forum';
    if (!selected) {
      const boards = rows((await call('forum_boards', { journeyId })).boards);
      const topics = rows((await call('topic_list', { journeyId })).topics);
      content = hero('Journey conversations', 'A place to think together', 'Good questions become shared understanding. Read a topic, connect an idea, and bring your perspective.')
        + `<div class="wf-forum-layout"><aside class="wf-sidebar" aria-label="Forum boards"><h2>Boards</h2>${boards.map(b => `<a class="wf-board" href="#board-${segment(b.boardId)}"><strong>${escape(b.name)}</strong><p>${escape(b.description)}</p>${b.archived ? chip('Archived') : ''}</a>`).join('') || '<p>No boards yet. Ask a guide to create one.</p>'}</aside><section><h2>Topics</h2>${topics.length ? '' : empty('Ask the first question', 'Start a topic through your agent or the forum App. Give it a clear title and a little context.')}${[...boards, { boardId: undefined, name: 'Attached conversations' }].map(b => {
          const entries = topics.filter(t => b.boardId === undefined ? !boards.some(known => known.boardId === t.boardId) : t.boardId === b.boardId);
          return `<section id="board-${b.boardId === undefined ? 'attached' : segment(b.boardId)}"><h3>${escape(b.name)}</h3>${entries.length ? `<div class="wf-topics">${entries.map(t => `<article class="wf-topic">${avatar(t.authorName)}<div class="wf-topic-main"><h3>${link(`${root}/forum/${segment(t.topicId)}`, t.title)}</h3><span class="wf-muted">${escape(t.authorName)} · ${escape(date(t.lastActivity))}</span><div class="wf-chips">${chip(t.authorKind, t.authorKind === 'agent')}${t.locked ? chip('Locked') : ''}</div></div><div class="wf-topic-count"><strong>${escape(t.replyCount)}</strong><span>replies</span></div></article>`).join('')}</div>` : '<p class="wf-muted">No topics in this board yet.</p>'}</section>`;
        }).join('')}</section></div>`;
    } else {
      const topic = check(await call('topic_read', { topicId: selected })); title = String(topic.title);
      content = thread({ topic, posts: topic.posts });
    }
  } else {
    title = 'Sensemaking rounds';
    if (!selected) {
      const rounds = rows((await call('round_list', { journeyId })).rounds);
      content = hero('Sensemaking studio', 'Listen. Connect. Make sense.', 'Many perspectives. A clearer way forward. Choose a round to see where the group is heading.') + `<div class="wf-grid">${rounds.map(r => `<article class="wf-card"><div class="wf-card-top"><span class="wf-kind-icon">${kindIcon('skill')}</span>${chip(r.status, true)}</div><h3>${link(`${root}/rounds/${segment(r.roundId)}`, r.title)}</h3><p>${escape(r.goal)}</p><p class="wf-muted">${escape(r.contributions)} contributions · ${escape(r.format)}</p>${link(`${root}/rounds/${segment(r.roundId)}`, 'Explore round →', 'wf-action wf-card-open')}</article>`).join('') || empty('Start with a shared question', 'Ask a facilitator to use round_create. Each participant gets space for a private interview.')}</div>`;
    } else {
      const round = roundDetail.parse(check(await call('round_read', { roundId: selected }))); title = round.title;
      const artifactLink = (item: z.output<typeof itemMetadata> | undefined) => item ? link(`${root}/library/${segment(item.itemId)}`, item.name) : 'Unavailable';
      content = `<section class="wf-hero"><span class="wf-eyebrow">Round workspace</span><h2>${escape(round.title)}</h2><p>${escape(round.goal)}</p>${stepper(round.status)}<p class="wf-muted">Facilitator: ${escape(round.facilitator)} · ${escape(round.format)}</p></section><div class="wf-split"><section class="wf-panel"><h2>Participants</h2>${round.participants.map(p => {
        const count = round.contributionSummary.find(c => c.personId === p.personId)?.count ?? 0;
        return `<div class="wf-participant">${avatar(p.personId)}<div class="wf-participant-main"><strong>${escape(p.personId)}</strong><p class="wf-muted">${p.live ? 'Member' : 'Departed'} · interview ${p.interviewShared ? 'shared' : 'private'} · ${count} contributions</p><progress value="${count}" max="${Math.max(1, round.contributions)}" aria-label="${escape(p.personId)}: ${count} of ${round.contributions} contributions"></progress></div></div>`;
      }).join('') || '<p>No participants yet.</p>'}</section><section class="wf-panel"><span class="wf-eyebrow">Synthesis</span><h2>Sensemaking document</h2><p>${artifactLink(round.document)}</p>${chip(`${round.contributions} contributions`, true)}<p class="wf-muted">Contributions are credited to people, including work helped by their agents.</p><h3>Guidance</h3><p>${artifactLink(round.guidance)}</p><h3>Related artifacts</h3>${list(round.related.map(artifactLink))}</section></div>`;
      content += `<section class="wf-panel wf-private"><h2>Your private reflection</h2><p>Each interview belongs to its person. Your notes stay private to you and your agents until you choose to share them.</p>${link(`${root}/rounds/${segment(selected)}?interview=mine`, 'Read my interview →', 'wf-action')}</section>`;
      if (url.searchParams.has('interview')) {
        if (url.searchParams.get('interview') !== 'mine') throw new Refused('Only your own interview is available here');
        const interview = ownInterview.parse(await call('interview_read', { roundId: selected }));
        content += `<section class="wf-panel wf-private"><h2>My interview</h2><p>${escape(interview.label)}</p>${chip(interview.shared ? 'Shared with the round' : 'Private to you and your agents', true)}<p class="wf-muted">Belongs to ${escape(interview.personId)}</p><pre>${escape(interview.text)}</pre>${interview.shared ? '<p>Future edits are shared too.</p>' : ''}</section>`;
      }
      if (round.status === 'closed') content += `<section class="wf-panel"><h2>Continue the journey</h2><p>Ask your facilitator to use <code>round_next</code> to carry this synthesis into a new round.</p></section>`;
      content += thread(await call('conversation_read', { journeyId, target: { roundId: selected } }));
    }
  }
  const back = selected ? link(`${root}/${kind}`, `← Back to ${kind === 'rounds' ? 'rounds' : kind}`, 'wf-action') : '';
  return page(`${title} · ${journey.name}`, `<div class="wf">${journeyNav(journeyId)}<div class="wf-toolbar">${back}</div>${content}</div>`, csrf);
}
