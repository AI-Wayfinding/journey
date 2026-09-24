import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { AddInput, JourneyClient } from './journey.js';

/** Read only the simple fields shared by Markdown front matter and journey items. */
export async function importMarkdown(client: Pick<JourneyClient, 'add'>, path: string): Promise<unknown[]> {
  const files: string[] = [];
  async function collect(name: string): Promise<void> {
    if ((await stat(name)).isDirectory()) {
      for (const entry of await readdir(name, { withFileTypes: true })) {
        if (entry.isFile() || entry.isDirectory()) await collect(join(name, entry.name));
      }
    } else if (/\.md$/i.test(name)) files.push(name);
  }
  await collect(path);
  if (files.length === 0) throw new Error('No Markdown files found to import into this journey.');
  const results: unknown[] = [];
  for (const file of files.sort()) {
    const markdown = await readFile(file, 'utf8');
    const front: Record<string, string> = {};
    let body = markdown;
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
    if (match) {
      body = markdown.slice(match[0].length);
      for (const line of match[1]!.split(/\r?\n/)) {
        const pair = /^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/.exec(line);
        if (pair) front[pair[1]!] = pair[2]!.replace(/^(['"])(.*)\1$/, '$2');
      }
    }
    const title = front.title || basename(file).replace(/\.md$/i, '');
    const type = front.itemType || front.type || 'resource';
    const tags = front.tags ? (front.tags.startsWith('[') ? front.tags.slice(1, -1) : front.tags).split(',').map(tag => tag.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
    const item: AddInput = { type, title, body, tags };
    if (front.created) item.created = front.created;
    if (front.resourceKind) item.resourceKind = front.resourceKind;
    if (front.sharedFrom) item.sharedFrom = front.sharedFrom;
    results.push(await client.add(item));
  }
  return results;
}
