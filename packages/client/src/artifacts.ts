import { open, readdir, lstat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { ARTIFACT_TYPES, MAX_BLOB_BYTES, suggestedArtifact, validPackagePath, validateArtifactPayload } from '@ai-wayfinding/core';
import type { ArtifactAttachment, ArtifactContent, ArtifactPayload, ArtifactState, PlacementChange } from '@ai-wayfinding/core';

export interface LocalAttachment { path: string; packagePath?: string; mime?: string }
export interface ArtifactInput { type: string; title: string; body?: string; tags?: string[]; files?: LocalAttachment[]; format?: 'json' | 'csv' | 'toml' | 'yaml' | 'sqlite'; url?: string; summary?: string; notes?: string }
export interface ArtifactVersion { id: string; actor: string; authoredBy: 'agent' | 'human'; at: string; payload: ArtifactPayload }
export interface ArtifactComment { id: string; item: string; onVersion?: string; author: string; actor: string; authoredBy: 'agent' | 'human'; at: string; body: string; text: string }
export interface ArtifactView { state: ArtifactState; versions: ArtifactVersion[]; comments: ArtifactComment[] }
export interface ArtifactItem { project: string | null; placementRevision: number | null; placementHistory: PlacementChange[]; id: string; version: string; itemType: string; title: string; body: string; tags: string[]; author: string; authoredBy: 'agent' | 'human'; writer: string; created: string; payload: ArtifactPayload }
export function artifactText(payload: ArtifactPayload): string {
  const c = payload.content;
  switch (c.kind) {
    case 'skill': return c.skill;
    case 'prompt': return c.text;
    case 'document': return c.markdown;
    case 'data': return c.text ?? '';
    case 'link': return `${c.url}\n${c.summary}\n${c.notes}`;
    default: return '';
  }
}
export function artifactPayload(input: ArtifactInput, attachments: ArtifactAttachment[]): ArtifactPayload {
  const mapped = (ARTIFACT_TYPES as readonly string[]).includes(input.type) ? null : suggestedArtifact(input.type, input.tags);
  if (['html', 'applet', 'interview', 'sensemaking-document'].includes(input.type) && input.type !== 'interview') throw new Error('That artifact type is reserved for a later stage.');
  if (input.type === 'recovery') throw new Error('Recovery is not a user artifact.');
  const type = mapped?.type ?? input.type, body = input.body ?? '';
  let content: ArtifactContent;
  switch (type) {
    case 'skill': content = { kind: 'skill', skill: body }; break;
    case 'prompt': content = { kind: 'prompt', text: body }; break;
    case 'document': content = { kind: 'document', markdown: body }; break;
    case 'file': case 'image': if (!attachments[0]) throw new Error('File and image artifacts need an explicit local file.'); content = { kind: type, primary: attachments[0].blob.id }; break;
    case 'data': if (!input.format) throw new Error('Data needs a format: json, csv, toml, yaml or sqlite.'); content = { kind: 'data', format: input.format, ...(attachments[0] ? { primary: attachments[0].blob.id } : { text: body }) }; break;
    case 'link': content = { kind: 'link', url: input.url ?? body, summary: input.summary ?? '', notes: input.notes ?? '' }; break;
    default: throw new Error('Unsupported artifact type.');
  }
  const payload: ArtifactPayload = { title: input.title, tags: [...new Set(mapped?.tags ?? input.tags ?? [])], content, attachments };
  const checked = validateArtifactPayload(payload); if (!checked.ok) throw new Error(checked.reason);
  return payload;
}
/** Explicit local files only. Size is checked before reading; symlinks are refused. */
export async function localBytes(path: string): Promise<Uint8Array> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Choose a regular local file, not a symlink.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || info.ino !== opened.ino || info.dev !== opened.dev) throw new Error('Choose a regular local file, not a symlink.');
    if (opened.size > MAX_BLOB_BYTES) throw new Error('Files can be at most 25,000,000 bytes (25 MB).');
    const bytes = new Uint8Array(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error('Local file changed while reading.');
      offset += result.bytesRead;
    }
    const extra = await file.read(new Uint8Array(1), 0, 1, bytes.length);
    if (extra.bytesRead || (await file.stat()).size !== opened.size) throw new Error('Local file changed while reading.');
    return bytes;
  } finally { await file.close(); }
}
/** SKILL.md stays inline; package attachments keep validated relative display paths. */
export async function skillPackage(path: string): Promise<{ body: string; files: LocalAttachment[] }> {
  if (!(await lstat(path)).isDirectory()) throw new Error('Choose a local skill folder containing SKILL.md.');
  const files: LocalAttachment[] = [];
  async function collect(folder: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (!validPackagePath(relative) || entry.isSymbolicLink()) throw new Error('Unsafe skill package path.');
      if (entry.isDirectory()) await collect(join(folder, entry.name), relative + '/');
      else if (entry.isFile() && relative !== 'SKILL.md') files.push({ path: join(folder, entry.name), packagePath: relative });
      else if (!entry.isFile()) throw new Error('Choose regular skill package files.');
    }
  }
  await collect(path);
  if (files.length > 8) throw new Error('A version can have at most eight attachments.');
  return { body: new TextDecoder('utf-8', { fatal: true }).decode(await localBytes(join(path, 'SKILL.md'))), files };
}
export function validateLocalAttachment(file: LocalAttachment): void {
  if (!file || typeof file.path !== 'string' || !file.path || Object.keys(file).some(key => !['path', 'packagePath', 'mime'].includes(key))) throw new Error('Choose an explicit local path with only defined attachment fields.');
  if (file.packagePath !== undefined && !validPackagePath(file.packagePath) || file.mime !== undefined && typeof file.mime !== 'string') throw new Error('Invalid artifact attachment');
}
export function attachmentName(file: LocalAttachment): string { return basename(file.path); }
/** The destination is caller-selected, never an attachment name or package path. */
export async function saveDownload(path: string, bytes: Uint8Array): Promise<void> { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
