import * as z from 'zod';

// These ordinals match the shipped item model's Kind and Visibility choices.
export const libraryKinds = ['markdown', 'html', 'pdf', 'code', 'image', 'video', 'audio', 'data', 'link', 'skill', 'prompt', 'agent', 'applet', 'other'] as const;
export type LibraryKind = typeof libraryKinds[number];
export const serverTextLimit = 256 * 1024;
const id = z.string().min(1).max(200);
const name = z.string().min(1).max(4096);
const description = z.string().max(4096);
const labels = z.array(z.string().trim().min(1).max(200)).max(64);
const natural = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const body = z.string().max(serverTextLimit).refine(v => new TextEncoder().encode(v).length <= serverTextLimit, 'Server text exceeds 256 KiB');
const kind = z.enum(libraryKinds);
const visibility = z.enum(['members', 'private']);
const acting = { actingAgent: id.optional() };
const item = { itemId: id, ...acting };
export const libraryInputs = {
  library_add: z.object({ journeyId: id, ...acting, name, kind: kind.optional(), mimeType: id.optional(), description: description.optional(), labels: labels.optional(), projectId: id.optional(), visibility: visibility.default('members'), storage: z.enum(['server', 'sealed']).default('server'), text: body.optional(), size: natural.optional(), url: z.url().max(4096).refine(v => /^https?:\/\//i.test(v), 'HTTP(S) links only').optional(), summary: description.optional() }).strict()
    .refine(v => v.storage === 'sealed' ? v.text === undefined && v.url === undefined && v.summary === undefined && v.size !== undefined : v.size === undefined, 'Sealed content needs size, not plaintext; server size is computed')
    .refine(v => v.kind === 'link' || v.url !== undefined ? v.storage === 'server' && v.url !== undefined && v.summary !== undefined && v.text === undefined && (v.kind === undefined || v.kind === 'link') : v.summary === undefined, 'Links require URL and summary, without text'),
  library_version: z.object({ ...item, baseVersion: natural, text: body.optional(), size: natural.optional() }).strict().refine(v => (v.text !== undefined) !== (v.size !== undefined), 'Supply exactly one of text or size'),
  library_update: z.object({ ...item, name: name.optional(), description: description.optional(), labels: labels.optional(), projectId: id.nullable().optional(), visibility: visibility.optional() }).strict().refine(v => [v.name, v.description, v.labels, v.projectId, v.visibility].some(x => x !== undefined), 'Supply metadata to change'),
  library_delete: z.object(item).strict(),
  library_get: z.object(item).strict(),
  library_search: z.object({ journeyId: id, ...acting, query: z.string().max(4096).optional(), kind: kind.optional(), label: z.string().max(200).optional(), projectId: id.optional(), includeProjects: z.boolean().default(false) }).strict(),
} as const;
export const libraryDescriptions = {
  library_add: 'Add a labelled library artifact. Kind is detected from name or mimeType if omitted. Server text is readable by the PoC server (256 KiB maximum); sealed bytes use artifact_blob_put. Links require URL and summary.',
  library_version: 'Append library content with the exact current baseVersion; use text for server storage (the summary for a link) or size for sealed storage. Owner and kind never change.',
  library_update: 'Change library name, description, labels or project (null clears it). Only the owner may change visibility.',
  library_delete: 'Permanently delete a library artifact and its content versions as its owner or a journey guide.',
  library_get: 'Read a library artifact by itemId, including server text or link URL and summary; private artifacts are visible only to their owner and owned agents.',
  library_search: 'Search library names, descriptions, labels and server text with case-insensitive tokens. Project artifacts are hidden unless projectId or includeProjects is supplied.',
} as const;
