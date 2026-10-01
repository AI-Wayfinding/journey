import { Lexer, type Token, type Tokens } from 'marked';
import { validArtifactUrl } from '@ai-wayfinding/core';
import type { ArtifactAttachment, ArtifactPayload } from '@ai-wayfinding/core';
import { downloadAttachment } from './artifacts.js';
import type { DataRequest, DataView as DataResult } from './data-worker.js';

const DATA_TIMEOUT = 10_000;
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;
};
/** The URL is inert until a deliberate click. No unfurl, image or server request. */
export function openLink(url: string, label = 'Open link'): HTMLElement {
  const box = element('span'); box.append(element('code', url));
  if (validArtifactUrl(url)) {
    const button = element('button', label); button.type = 'button'; button.className = 'secondary';
    button.addEventListener('click', () => { window.open(url, '_blank', 'noopener,noreferrer'); });
    box.append(' ', button);
  } else box.append(element('p', 'This is not a supported web URL.'));
  return box;
}

/** Build only inert DOM nodes; never pass Markdown's HTML or destinations to innerHTML. */
export function markdownView(text: string): HTMLElement {
  const box = element('div'); box.className = 'markdown-view'; let count = 0;
  const render = (tokens: Token[], parent: HTMLElement, depth = 0) => {
    if (depth > 64) throw new Error('Markdown nesting limit.');
    for (const token of tokens) {
      if (++count > 1_000) throw new Error('Markdown node limit.');
      switch (token.type) {
        case 'space': break;
        case 'heading': { const t = token as Tokens.Heading, node = element(`h${Math.min(6, Math.max(1, t.depth))}` as 'h1'); render(t.tokens, node, depth + 1); parent.append(node); break; }
        case 'paragraph': case 'strong': case 'em': case 'del': {
          const t = token as Tokens.Paragraph, node = element(({ paragraph: 'p', strong: 'strong', em: 'em', del: 'del' } as const)[token.type as 'paragraph']);
          render(t.tokens, node, depth + 1); parent.append(node); break;
        }
        case 'blockquote': { const node = element('blockquote'); render((token as Tokens.Blockquote).tokens, node, depth + 1); parent.append(node); break; }
        case 'list': {
          const t = token as Tokens.List, node = element(t.ordered ? 'ol' : 'ul');
          for (const item of t.items) { const li = element('li'); render(item.tokens, li, depth + 1); node.append(li); }
          parent.append(node); break;
        }
        case 'text': {
          const t = token as Tokens.Text; if (t.tokens) render(t.tokens, parent, depth + 1); else parent.append(document.createTextNode(t.text)); break;
        }
        case 'escape': parent.append(document.createTextNode((token as Tokens.Escape).text)); break;
        case 'code': { const pre = element('pre'); pre.append(element('code', (token as Tokens.Code).text)); parent.append(pre); break; }
        case 'codespan': parent.append(element('code', (token as Tokens.Codespan).text)); break;
        case 'br': parent.append(element('br')); break;
        case 'hr': parent.append(element('hr')); break;
        case 'link': { const t = token as Tokens.Link; parent.append(openLink(t.href, t.text || 'Open link')); break; }
        case 'image': parent.append(element('span', `[Image not loaded: ${(token as Tokens.Image).text}]`)); break;
        // HTML, tables and unknown syntax are text, not an execution surface.
        default: parent.append(document.createTextNode(token.raw));
      }
    }
  };
  try {
    if (new TextEncoder().encode(text).length > 100_000) throw new Error('Markdown display limit.');
    render(Lexer.lex(text), box);
  } catch { box.replaceChildren(element('p', 'Markdown exceeds the safe view limits. Download the original text instead.')); }
  return box;
}

/** Magic bytes only choose a raster decoder. Successful browser decoding is also required. */
export function rasterMime(bytes: Uint8Array): string | null {
  const starts = (values: number[]) => values.every((v, i) => bytes[i] === v);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (starts([255, 216, 255]) && bytes.length >= 4 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 === bytes.length) return 'image/webp';
  return null;
}
export async function validatedRaster(bytes: Uint8Array): Promise<Blob | null> {
  const type = rasterMime(bytes); if (!type) return null;
  const blob = new Blob([new Uint8Array(bytes).buffer], { type });
  try {
    const bitmap = await createImageBitmap(blob);
    const valid = bitmap.width > 0 && bitmap.height > 0 && bitmap.width * bitmap.height <= 40_000_000;
    bitmap.close(); return valid ? blob : null;
  } catch { return null; }
}

/** A fresh worker per parse, terminated on success, failure, ten seconds or cancellation. */
export function dataJob(request: DataRequest, signal: AbortSignal): Promise<DataResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Data view cancelled.')); return; }
    const worker = new Worker(new URL('./data-worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (value?: DataResult, error?: Error) => {
      if (settled) return; settled = true; worker.terminate(); clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(value!);
    };
    const cancel = () => finish(undefined, new Error('Data view cancelled.'));
    const timer = setTimeout(() => finish(undefined, new Error('Data view exceeded ten seconds. Download the original bytes instead.')), DATA_TIMEOUT);
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent<DataResult>) => finish(event.data);
    worker.onerror = () => finish(undefined, new Error('Data view failed. Download the original bytes instead.'));
    const bytes = new Uint8Array(request.bytes);
    try { worker.postMessage({ format: request.format, bytes, ...(request.table === undefined ? {} : { table: request.table }) }, [bytes.buffer]); }
    catch { finish(undefined, new Error('Data view could not start. Download the original bytes instead.')); }
  });
}

/** Read only already verified/decrypted content. The transport callback retains all Bend access checks. */
export function mountArtifactViewer(host: HTMLElement, payload: ArtifactPayload, load: (a: ArtifactAttachment, signal: AbortSignal) => Promise<Uint8Array>): () => void {
  const lifetime = new AbortController(); const urls = new Set<string>(); let job: AbortController | undefined;
  const content = payload.content;
  const cleanup = () => { lifetime.abort(); job?.abort(); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); };
  const downloadText = (name: string, text: string) => {
    const button = element('button', 'Download original text'); button.type = 'button'; button.className = 'secondary';
    button.addEventListener('click', () => downloadAttachment(name, new TextEncoder().encode(text))); host.append(button);
  };
  if (content.kind === 'document') { host.append(markdownView(content.markdown)); downloadText('document.md', content.markdown); }
  else if (content.kind === 'link') { host.append(openLink(content.url), element('p', content.summary), element('pre', content.notes)); }
  else if (content.kind === 'skill' || content.kind === 'prompt') host.append(element('pre', content.kind === 'skill' ? content.skill : content.text));
  else if (content.kind === 'file') host.append(element('p', 'No inline view. Download the original file.'));
  else {
    const status = element('p', 'Loading local view…'); status.setAttribute('role', 'status');
    const cancel = element('button', 'Cancel view'); cancel.type = 'button'; cancel.className = 'secondary';
    const output = element('div'); output.className = 'data-output'; host.append(status, cancel, output);
    cancel.addEventListener('click', () => { cleanup(); cancel.disabled = true; status.textContent = 'View cancelled. Download the original bytes instead.'; output.replaceChildren(); });
    const primary = payload.attachments.find(a => a.blob.id === content.primary);
    const showData = async (bytes: Uint8Array, table?: string) => {
      job?.abort(); job = new AbortController(); const current = job;
      status.textContent = 'Parsing locally…'; cancel.disabled = false; output.replaceChildren();
      try {
        const result = await dataJob({ format: content.kind === 'data' ? content.format : '', bytes, ...(table === undefined ? {} : { table }) }, current.signal);
        if (lifetime.signal.aborted || current.signal.aborted || !host.isConnected) return;
        if (result.kind === 'error') { status.textContent = result.message; return; }
        if (result.kind === 'tree') { status.textContent = `Local view · ${result.nodes} nodes (limits: 1,000 nodes, 100,000 UTF-8 bytes).`; output.append(element('pre', result.text)); }
        else {
          status.textContent = `Local view · ${result.rows.length} rows · ${result.columns.length} columns.${result.truncated ? ' Truncated to the first 100 rows and 100 columns (and 100 tables).' : ''}`;
          if (result.tables) {
            const label = element('label', 'SQLite table'); const select = element('select'); select.setAttribute('aria-label', 'SQLite table');
            for (const name of result.tables) { const option = element('option', name); option.value = name; select.append(option); }
            select.value = result.table ?? ''; select.addEventListener('change', () => { void showData(bytes, select.value); }); output.append(label, select);
          }
          const tableNode = element('table'), head = element('thead'), heading = element('tr'), body = element('tbody');
          for (const column of result.columns) heading.append(element('th', column)); head.append(heading);
          for (const row of result.rows) { const tr = element('tr'); for (const cell of row) tr.append(element('td', cell)); body.append(tr); }
          tableNode.append(head, body); output.append(tableNode);
        }
      } catch (cause) { if (!lifetime.signal.aborted && !current.signal.aborted && host.isConnected) status.textContent = cause instanceof Error ? cause.message : 'No data view. Download the original bytes instead.'; }
    };
    void (async () => {
      try {
        const bytes = primary ? await load(primary, lifetime.signal) : new TextEncoder().encode(content.kind === 'data' ? content.text ?? '' : '');
        if (lifetime.signal.aborted || !host.isConnected) return;
        if (content.kind === 'image') {
          const blob = await validatedRaster(bytes);
          if (lifetime.signal.aborted || !host.isConnected) return;
          cancel.disabled = true;
          if (!blob) { status.textContent = 'No image preview: not a validated PNG, JPEG, GIF or WebP. Download the original file.'; return; }
          const url = URL.createObjectURL(blob); urls.add(url); const image = element('img'); image.src = url; image.alt = payload.title; image.className = 'artifact-image';
          output.append(image); status.textContent = 'Validated local image preview.';
        } else {
          if (content.kind === 'data' && !primary) downloadText(`data.${content.format}`, content.text ?? '');
          await showData(bytes);
        }
      } catch { if (!lifetime.signal.aborted && host.isConnected) status.textContent = 'Could not load the view. Try downloading the original file.'; }
    })();
  }
  return cleanup;
}
