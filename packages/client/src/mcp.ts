import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { importMarkdown } from './import.js';
import type { ArtifactInput } from './artifacts.js';
import { observedRevision } from './projects.js';
import type { JourneyClient } from './journey.js';

const text = { type: 'string' as const };
const schema = (properties: Record<string, object>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const artifactFields = { type: text, title: text, body: text, tags: { type: 'array', items: text }, files: { type: 'array', maxItems: 8, items: schema({ path: text, packagePath: text, mime: text }, ['path']) }, format: { type: 'string', enum: ['json','csv','toml','yaml','sqlite'] }, url: text, summary: text, notes: text };
const predecessor = { type: ['integer', 'null'], minimum: 0 };
const tools = [
  { name: 'project_list', description: 'List all projects, including empty and archived projects, after approval.', inputSchema: schema({}) },
  { name: 'project_show', description: 'Read purpose, state, observed revision, signed history and effective participants. Projects do not restrict artifact reads.', inputSchema: schema({ id: text }, ['id']) },
  { name: 'project_create', description: 'Create an empty getting-started project under current content-write authority. Creation does not join anyone.', inputSchema: schema({ purpose: text }, ['purpose']) },
  { name: 'project_join', description: 'Join the project for the adding person under their current participation authority.', inputSchema: schema({ id: text }, ['id']) },
  { name: 'project_leave', description: 'Leave the project for the adding person under their current participation authority.', inputSchema: schema({ id: text }, ['id']) },
  { name: 'project_purpose', description: 'Change purpose using an observed predecessor. Participating agents can edit metadata even when read-only; stale changes require rereading.', inputSchema: schema({ id: text, purpose: text, predecessor }, ['id', 'purpose', 'predecessor']) },
  { name: 'project_state', description: 'Set an explicit state, archive or reopen using an observed predecessor and inherited participation. Archives remain readable.', inputSchema: schema({ id: text, state: { type: 'string', enum: ['getting-started','active','looking-for-others','archived'] }, predecessor }, ['id', 'state', 'predecessor']) },
  { name: 'artifact_project', description: 'Assign, move or clear a saved artifact using current content-write authority, not project metadata access. Supply null project to clear and the observed placement predecessor (initially null).', inputSchema: schema({ id: text, project: { type: ['string','null'] }, predecessor }, ['id','project','predecessor']) },
  { name: 'add', description: 'Create an artifact after read-write approval. Files are explicit local paths; URLs are never fetched. Attribution comes from signed controls.', inputSchema: schema(artifactFields, ['type', 'title']) },
  { name: 'edit', description: 'Append a version using the observed predecessor. Omitting files retains attachments; supplying files replaces them. Bend checks current access and artifact authority.', inputSchema: schema({ ...artifactFields, id: text, predecessor: text }, ['id', 'predecessor', 'type', 'title']) },
  { name: 'versions', description: 'Inspect signed artifact versions.', inputSchema: schema({ id: text }, ['id']) },
  { name: 'delete', description: 'Hide the whole artifact. Retained metadata history is not secure erasure; downloaded copies cannot be recalled.', inputSchema: schema({ id: text }, ['id']) },
  { name: 'download', description: 'Decrypt an attachment to an explicit new local output path. Never fetch remote URLs or use filenames as host paths.', inputSchema: schema({ id: text, blob: text, path: text, version: text }, ['id', 'blob', 'path']) },
  { name: 'import_skill', description: 'Create a skill from an explicit local folder with SKILL.md and at most eight package files.', inputSchema: schema({ path: text, title: text, tags: { type: 'array', items: text } }, ['path', 'title']) },
  { name: 'import', description: 'Create artifacts from explicit local Markdown files; categories become document tags.', inputSchema: schema({ path: text }, ['path']) },
  { name: 'list', description: 'List main (unassigned) artifacts by default, or select a project ID or all, intersected with type/tag filters after approval.', inputSchema: schema({ type: text, tag: text, project: text }) },
  { name: 'search', description: 'Search main artifacts by default, or select a project ID or all, intersected with type/tag filters after approval.', inputSchema: schema({ text: text, project: text, type: text, tag: text }, ['text']) },
  { name: 'show', description: 'Read an artifact and its versions/comments after approval.', inputSchema: schema({ id: text }, ['id']) },
  { name: 'comment', description: 'Comment on the whole artifact, optionally identifying an existing version.', inputSchema: schema({ id: text, text: text, onVersion: text }, ['id', 'text']) },
  { name: 'comments', description: 'Read whole-artifact comments after approval.', inputSchema: schema({ id: text }, ['id']) },
  { name: 'status', description: 'Check this journey and your current effective scope.', inputSchema: schema({}) },
  { name: 'connect_status', description: 'Check approval status; never grants access.', inputSchema: schema({}) }
];
function tags(args: Record<string, unknown>): string[] {
  if (args.tags !== undefined && (!Array.isArray(args.tags) || !args.tags.every(tag => typeof tag === 'string'))) throw new Error('Journey tags must be text.');
  return args.tags === undefined ? [] : [...args.tags as string[]];
}
/** Copy named input fields only, never caller attribution, grants or control actions. */
function input(args: Record<string, unknown>): ArtifactInput {
  if (args.files !== undefined && (!Array.isArray(args.files) || args.files.length > 8)) throw new Error('Files must be an array of at most eight local paths.');
  const files = (args.files as unknown[] | undefined)?.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose an explicit local path.');
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(k => !['path','packagePath','mime'].includes(k))) throw new Error('Unknown attachment field.');
    return { path: field(row, 'path'), ...(row.packagePath === undefined ? {} : { packagePath: field(row, 'packagePath') }), ...(row.mime === undefined ? {} : { mime: field(row, 'mime') }) };
  });
  if (args.format !== undefined && !['json','csv','toml','yaml','sqlite'].includes(String(args.format))) throw new Error('Unsupported data format.');
  for (const name of ['body','url','summary','notes']) if (args[name] !== undefined && typeof args[name] !== 'string') throw new Error(name + ' must be text.');
  return { type: field(args, 'type'), title: field(args, 'title'), tags: tags(args), files, format: args.format as ArtifactInput['format'], body: args.body as string | undefined, url: args.url as string | undefined, summary: args.summary as string | undefined, notes: args.notes as string | undefined };
}
function field(args: Record<string, unknown>, name: string): string {
  if (typeof args[name] !== 'string' || !args[name]) throw new Error(name + ' must be text.');
  return args[name];
}
function optionalField(args: Record<string, unknown>, name: string): string | undefined { return args[name] === undefined ? undefined : field(args, name); }
export function createWayfindingServer(getClient: () => Promise<JourneyClient>): Server {
  const server = new Server({ name: 'wayfinding', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = request.params.arguments ?? {};
    try {
      let result: unknown;
      if (request.params.name === 'connect_status') {
        try { const client = await getClient(); result = await client.status(); }
        catch (error) { result = { connected: false, message: error instanceof Error ? error.message : String(error) }; }
      } else {
        const client = await getClient();
        switch (request.params.name) {
          case 'project_list': result = await client.projectList(); break;
          case 'project_show': result = await client.projectShow(field(args, 'id')); break;
          case 'project_create': result = await client.projectCreate(field(args, 'purpose')); break;
          case 'project_join': case 'project_leave': result = await client.projectParticipation(field(args, 'id'), request.params.name === 'project_join' ? 'join' : 'leave'); break;
          case 'project_purpose': result = await client.projectPurpose(field(args, 'id'), field(args, 'purpose'), observedRevision(args.predecessor)); break;
          case 'project_state': result = await client.projectState(field(args, 'id'), field(args, 'state'), observedRevision(args.predecessor)); break;
          case 'artifact_project': result = await client.artifactProject(field(args, 'id'), args.project === null ? null : field(args, 'project'), observedRevision(args.predecessor)); break;
          case 'add': result = await client.add(input(args)); break;
          case 'edit': result = await client.edit(field(args, 'id'), field(args, 'predecessor'), input(args)); break;
          case 'versions': result = await client.versions(field(args, 'id')); break;
          case 'delete': result = await client.delete(field(args, 'id')); break;
          case 'download': result = await client.download(field(args, 'id'), field(args, 'blob'), field(args, 'path'), typeof args.version === 'string' ? args.version : undefined); break;
          case 'import_skill': result = await client.importSkill(field(args, 'path'), field(args, 'title'), tags(args)); break;
          case 'import': result = await importMarkdown(client, field(args, 'path')); break;
          case 'list': result = await client.list(optionalField(args, 'type'), optionalField(args, 'tag'), optionalField(args, 'project')); break;
          case 'search': result = await client.search(field(args, 'text'), optionalField(args, 'project'), optionalField(args, 'type'), optionalField(args, 'tag')); break;
          case 'show': result = await client.show(field(args, 'id')); break;
          case 'comment': result = await client.comment(field(args, 'id'), field(args, 'text'), typeof args.onVersion === 'string' ? args.onVersion : undefined); break;
          case 'comments': result = await client.comments(field(args, 'id')); break;
          case 'status': result = await client.status(); break;
          default: throw new Error('Unknown journey tool: ' + request.params.name);
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  return server;
}
export async function runMcp(getClient: () => Promise<JourneyClient>): Promise<void> {
  await createWayfindingServer(getClient).connect(new StdioServerTransport());
}
