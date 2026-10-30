import { Refused, type Command, type ToolData } from './commands.ts';
import { libraryKinds, type LibraryKind } from './library-inputs.ts';
import { itemRule, scalar, sameState, type Snapshot } from './rules.ts';
import type { KeyValueStorage } from './storage.ts';

export interface LibraryArtifact {
  id: string; name: string; type: string; size: number; rule: Snapshot;
  description: string; labels: string[]; storage: 'server' | 'sealed';
  url?: string; summary?: string;
  versions: { version: number; chunks: number }[];
}
interface LegacyArtifact { id: string; name: string; type: string; size: number; rule: Snapshot; storage?: never }
export function isLibraryArtifact(artifact: LegacyArtifact | LibraryArtifact): artifact is LibraryArtifact { return artifact.storage !== undefined; }
export function isLibraryCommand(command: Command): command is LibraryCommand {
  return command.tool === 'library_add' || command.tool === 'library_get' || command.tool === 'library_search' || command.tool === 'library_version' || command.tool === 'library_update' || command.tool === 'library_delete';
}
interface LibraryState {
  id: string; artifacts: (LegacyArtifact | LibraryArtifact)[];
  identities: { id: string }[]; projects: { id: string }[];
}
export interface LibraryAccess { person: number; read: boolean; write: boolean; delete: boolean; guide: boolean }
export type LibraryCommand = Extract<Command, { tool: `library_${string}` }>;
export interface LibraryResult { data: ToolData; writes: [string, string][]; changed: boolean; deleted?: string }
const utf8 = new TextEncoder();
const chunkSize = 8192; // Even JSON-escaped UTF-16 units stay below a DO's 128 KiB value limit.

export function detectKind(name: string, mimeType = ''): LibraryKind {
  const mime = mimeType.toLowerCase().split(';')[0]!.trim();
  const special: Record<string, LibraryKind> = { 'text/markdown': 'markdown', 'text/html': 'html', 'application/pdf': 'pdf', 'application/json': 'data', 'text/csv': 'data', 'application/yaml': 'data', 'application/xml': 'data', 'text/javascript': 'code', 'application/javascript': 'code' };
  if (Object.hasOwn(special, mime)) return special[mime]!;
  for (const prefix of ['image', 'video', 'audio'] as const) if (mime.startsWith(`${prefix}/`)) return prefix;
  const extension = name.toLowerCase().split('.').at(-1)!;
  const groups: [LibraryKind, string[]][] = [
    ['markdown', ['md', 'markdown', 'mdx']], ['html', ['html', 'htm']], ['pdf', ['pdf']],
    ['code', ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'css', 'sh', 'sql', 'rb', 'swift', 'bend']],
    ['image', ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'heic']], ['video', ['mp4', 'webm', 'mov', 'mkv']], ['audio', ['mp3', 'wav', 'ogg', 'm4a', 'flac']],
    ['data', ['json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'parquet', 'xlsx']], ['link', ['url', 'webloc']],
    ['skill', ['skill']], ['prompt', ['prompt']], ['agent', ['agent']], ['applet', ['applet']],
  ];
  return groups.find(([, extensions]) => name.includes('.') && extensions.includes(extension))?.[0] ?? 'other';
}
export function itemJourney(itemId: string): string {
  const match = /^artifact_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(itemId);
  if (!match) throw new Refused('Invalid library item id');
  return `journey_${match[1]}`;
}
function step(artifact: LibraryArtifact, op: number, access: LibraryAccess, extra: Record<string, number> = {}): Snapshot {
  return itemRule.step(artifact.rule, { op, actor: access.person, canWrite: +access.write, canRead: +access.read, guide: +access.guide, ownerAgent: 0,
    newKind: scalar(artifact.rule, 'kind'), newVisibility: scalar(artifact.rule, 'visibility'), newProject: scalar(artifact.rule, 'project'), baseVersion: 0, ...extra });
}
export function readableItem(artifact: LibraryArtifact, person: number, canRead: boolean): boolean {
  return scalar(step(artifact, 5, { person, read: canRead, write: false, delete: false, guide: false }), 'allowed') === 1;
}
export function visibleItem(artifact: LibraryArtifact, person: number): boolean {
  return scalar(artifact.rule, 'visibility') === 0 || scalar(artifact.rule, 'owner') === person;
}
export function requireItem(artifact: LibraryArtifact | undefined, person: number, canRead: boolean): asserts artifact is LibraryArtifact {
  if (!artifact || !readableItem(artifact, person, canRead)) throw new Refused('Library artifact not found or not readable');
}
export function itemMetadata(state: LibraryState, artifact: LibraryArtifact): ToolData {
  return { journeyId: state.id, itemId: artifact.id, artifactId: artifact.id, name: artifact.name, kind: libraryKinds[scalar(artifact.rule, 'kind')],
    description: artifact.description, labels: [...artifact.labels], owner: state.identities[scalar(artifact.rule, 'owner') - 1]?.id,
    projectId: state.projects[scalar(artifact.rule, 'project') - 1]?.id, visibility: scalar(artifact.rule, 'visibility') === 1 ? 'private' : 'members',
    storage: artifact.storage, size: artifact.size, version: scalar(artifact.rule, 'version') };
}
function projectSlot(state: LibraryState, projectId: string | null | undefined): number {
  if (projectId === undefined || projectId === null) return 0;
  const index = state.projects.findIndex(p => p.id === projectId);
  if (index < 0) throw new Refused('Library project not found');
  return index + 1;
}
function contentKey(id: string, version: number, chunk: number): string { return JSON.stringify(['libraryText', id, version, chunk]); }
function textWrites(artifact: LibraryArtifact, text: string): [string, string][] {
  const version = scalar(artifact.rule, 'version'), writes: [string, string][] = [];
  for (let i = 0; i < text.length; i += chunkSize) writes.push([contentKey(artifact.id, version, writes.length), JSON.stringify(text.slice(i, i + chunkSize))]);
  artifact.versions.push({ version, chunks: writes.length });
  artifact.size = utf8.encode(text).length;
  return writes;
}
async function readText(storage: KeyValueStorage, artifact: LibraryArtifact): Promise<string> {
  const version = scalar(artifact.rule, 'version'), record = artifact.versions.find(v => v.version === version);
  if (!record) throw new Refused('Library content version not found');
  let text = '';
  for (let i = 0; i < record.chunks; i++) {
    const raw = await storage.get(contentKey(artifact.id, version, i));
    const chunk: unknown = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    if (typeof chunk !== 'string') throw new Refused('Library content chunk not found');
    text += chunk;
  }
  return text;
}
function applyStep(artifact: LibraryArtifact, op: number, access: LibraryAccess, extra: Record<string, number> = {}): void {
  const before = artifact.rule;
  if ((op === 1 && scalar(before, 'version') >= Number.MAX_SAFE_INTEGER) || (op === 2 && scalar(before, 'edits') >= Number.MAX_SAFE_INTEGER)) throw new Refused('Library counter capacity reached');
  const next = step(artifact, op, access, extra);
  if (sameState(before, next, ['allowed'])) throw new Refused('Library change refused by coordination rules');
  artifact.rule = next;
}
export async function library(state: LibraryState, command: LibraryCommand, access: LibraryAccess, storage: KeyValueStorage): Promise<LibraryResult> {
  const writes: [string, string][] = [];
  if (command.tool === 'library_search') {
    if (!access.read) throw new Refused('Library read capability refused');
    const input = command.input, requested = input.projectId === undefined ? undefined : projectSlot(state, input.projectId);
    const tokens = (input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean), items: ToolData[] = [];
    for (const artifact of state.artifacts) {
      if (!isLibraryArtifact(artifact)) continue;
      if (!readableItem(artifact, access.person, access.read)) continue;
      const project = scalar(artifact.rule, 'project');
      if (requested !== undefined ? project !== requested : project !== 0 && !input.includeProjects) continue;
      if (input.kind !== undefined && libraryKinds[scalar(artifact.rule, 'kind')] !== input.kind) continue;
      if (input.label !== undefined && !artifact.labels.includes(input.label)) continue;
      const text = tokens.length && artifact.storage === 'server' ? await readText(storage, artifact) : '';
      const haystack = [artifact.name, artifact.description, ...artifact.labels, text].join(' ').toLowerCase();
      if (tokens.every(token => haystack.includes(token))) items.push(itemMetadata(state, artifact));
    }
    return { data: { journeyId: state.id, items }, writes, changed: false };
  }
  if (command.tool === 'library_add') {
    const i = command.input, kind = i.kind ?? (i.url !== undefined ? 'link' : detectKind(i.name, i.mimeType));
    if (kind === 'link' && (i.url === undefined || i.summary === undefined)) throw new Refused('Links require URL and summary');
    const artifact: LibraryArtifact = { id: `artifact_${state.id.slice('journey_'.length)}_${crypto.randomUUID()}`, name: i.name, type: i.mimeType ?? kind, size: i.size ?? 0,
      description: i.description ?? '', labels: [...new Set(i.labels ?? [])], storage: i.storage, versions: [], rule: itemRule.init() };
    applyStep(artifact, 0, access, { newKind: libraryKinds.indexOf(kind), newVisibility: +(i.visibility === 'private'), newProject: projectSlot(state, i.projectId) });
    if (i.url !== undefined) { artifact.url = i.url; writes.push(...textWrites(artifact, i.summary ?? '')); }
    else if (i.storage === 'server') writes.push(...textWrites(artifact, i.text ?? ''));
    state.artifacts.push(artifact);
    return { data: itemMetadata(state, artifact), writes, changed: true };
  }
  const found = state.artifacts.find(a => a.id === command.input.itemId);
  const artifact = found && isLibraryArtifact(found) ? found : undefined;
  // Hostile callers must not learn or mutate a private artifact through a write path.
  requireItem(artifact, access.person, access.read || access.write || access.delete);
  if (command.tool === 'library_get') {
    if (!access.read) throw new Refused('Library read capability refused');
    const data = itemMetadata(state, artifact);
    if (artifact.url !== undefined) { data.url = artifact.url; data.summary = await readText(storage, artifact); }
    else if (artifact.storage === 'server') data.text = await readText(storage, artifact);
    return { data, writes, changed: false };
  }
  if (command.tool === 'library_version') {
    const i = command.input;
    if (artifact.storage === 'server' ? i.text === undefined : i.size === undefined) throw new Refused('Content must match artifact storage');
    applyStep(artifact, 1, access, { baseVersion: i.baseVersion });
    if (i.text !== undefined) writes.push(...textWrites(artifact, i.text));
    else if (i.size !== undefined) artifact.size = i.size;
  } else if (command.tool === 'library_update') {
    const i = command.input;
    if (i.visibility !== undefined && scalar(artifact.rule, 'visibility') !== +(i.visibility === 'private')) applyStep(artifact, 3, access, { newVisibility: +(i.visibility === 'private') });
    else if (i.visibility !== undefined && scalar(artifact.rule, 'owner') !== access.person) throw new Refused('Only the owner sets visibility');
    if ([i.name, i.description, i.labels, i.projectId].some(x => x !== undefined)) {
      applyStep(artifact, 2, access, { newProject: i.projectId === undefined ? scalar(artifact.rule, 'project') : projectSlot(state, i.projectId) });
      if (i.name !== undefined) artifact.name = i.name;
      if (i.description !== undefined) artifact.description = i.description;
      if (i.labels !== undefined) artifact.labels = [...new Set(i.labels)];
    }
  } else if (command.tool === 'library_delete') {
    if (!access.delete) throw new Refused('Artifact delete capability refused');
    applyStep(artifact, 4, { ...access, read: access.delete });
    for (const version of artifact.versions) for (let i = 0; i < version.chunks; i++) writes.push([contentKey(artifact.id, version.version, i), 'null']);
    artifact.versions = []; delete artifact.url; delete artifact.summary;
    return { data: { itemId: artifact.id, deleted: true }, writes, changed: true, deleted: artifact.id };
  }
  return { data: itemMetadata(state, artifact), writes, changed: true };
}
