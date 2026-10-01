// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { ArtifactPayload } from '@ai-wayfinding/core';
import { dataJob, markdownView, mountArtifactViewer, openLink, rasterMime, validatedRaster } from './artifact-viewer.js';
import { parseData, VIEW_LIMITS } from './data-worker.js';
import initSqlJs from 'sql.js';

// Supply the real local engine bytes in Node; browsers load the bundled same-origin asset.
vi.mock('sql.js', async importOriginal => {
  const actual = await importOriginal<typeof import('sql.js')>();
  const require = createRequire(import.meta.url);
  const wasmBinary = new Uint8Array(readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'))).buffer;
  return { default: (config: object = {}) => actual.default({ ...config, wasmBinary }) };
});
const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (format: string, text: string) => parseData({ format, bytes: bytes(text) });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe('safe local formats and bounds', () => {
  it('reads JSON, TOML and YAML without constructing executable objects', async () => {
    for (const [format, text] of [['json', '{"name":"safe","__proto__":{"polluted":true}}'], ['toml', 'name = "safe"'], ['yaml', 'name: safe']]) {
      const view = await parse(format, text); expect(view.kind).toBe('tree');
      if (view.kind === 'tree') expect(view.text).toContain('safe');
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
  it('fails closed for YAML custom/standard tags, aliases and malformed input', async () => {
    for (const text of ['x: !evil script', 'x: !!js/function function(){}', 'x: !!str safe', 'a: &a [1]\nb: *a', 'x: [']) {
      const view = await parse('yaml', text); expect(view.kind).toBe('error');
      if (view.kind === 'error') expect(view.message).toContain('Download the original bytes');
    }
  });
  it('enforces 64 levels, 1,000 nodes and 100,000 displayed UTF-8 bytes', async () => {
    expect((await parse('json', '['.repeat(64) + '0' + ']'.repeat(64))).kind).toBe('tree');
    expect((await parse('json', '['.repeat(65) + '0' + ']'.repeat(65))).kind).toBe('error');
    expect((await parse('json', JSON.stringify(Array(999).fill(0)))).kind).toBe('tree');
    expect((await parse('json', JSON.stringify(Array(1000).fill(0)))).kind).toBe('error');
    expect((await parse('json', JSON.stringify('x'.repeat(99_998)))).kind).toBe('tree');
    expect((await parse('json', JSON.stringify('é'.repeat(50_000)))).kind).toBe('error');
    expect((await parse('toml', '[a]'.repeat(100))).kind).toBe('error');
    expect((await parse('yaml', 'a: '.repeat(70))).kind).toBe('error');
  });
  it('accepts exactly 25,000,000 input bytes and rejects the next byte', async () => {
    expect(VIEW_LIMITS.input).toBe(25_000_000);
    const input = new Uint8Array(25_000_000).fill(32); input[0] = 48;
    expect((await parseData({ format: 'json', bytes: input })).kind).toBe('tree');
    const oversized = new Uint8Array(25_000_001).fill(32); oversized[0] = 48;
    expect((await parseData({ format: 'json', bytes: oversized })).kind).toBe('error');
  });
  it('keeps formulas as text and truncates CSV to 100 rows and 100 columns', async () => {
    const header = Array.from({ length: 101 }, (_, i) => 'col' + i).join(',');
    const row = ['=WEBSERVICE("https://evil.example")', '+CMD', '@SUM(1)', '-2', '<img src=https://evil.example>', ...Array(96).fill('x')].map(x => '"' + x.replaceAll('"', '""') + '"').join(',');
    const view = await parse('csv', header + '\n' + Array(101).fill(row).join('\n'));
    expect(view.kind).toBe('table');
    if (view.kind === 'table') {
      expect(view.rows).toHaveLength(100); expect(view.columns).toHaveLength(100); expect(view.truncated).toBe(true);
      expect(view.rows[0]!.slice(0, 4)).toEqual(['=WEBSERVICE("https://evil.example")', '+CMD', '@SUM(1)', '-2']);
    }
    expect((await parse('csv', 'a\n"unterminated')).kind).toBe('error');
    expect((await parse('csv', 'a\n' + 'é'.repeat(50_001))).kind).toBe('error');
  });
  it('provides explicit original-byte fallbacks for malformed/unsupported formats', async () => {
    for (const [format, text] of [['json', '{'], ['toml', 'x='], ['sqlite', 'SQLite format 3\0broken'], ['html', '<script>evil()</script>']]) {
      const view = await parse(format, text); expect(view.kind).toBe('error');
      if (view.kind === 'error') expect(view.message).toContain('Download the original bytes');
    }
    expect((await parseData({ format: 'json', bytes: new Uint8Array([255]) })).kind).toBe('error');
  });
  it('browses local SQLite tables with quoted generated SELECT only, excluding views and virtual tables', async () => {
    const SQL = await initSqlJs(), db = new SQL.Database();
    const name = 'odd"; DROP TABLE safe; --';
    db.run('CREATE TABLE safe (value TEXT); INSERT INTO safe VALUES (\'kept\'); CREATE VIEW forbidden AS SELECT * FROM safe; CREATE VIRTUAL TABLE virtual USING fts3(value);');
    db.run('CREATE TABLE "' + name.replaceAll('"', '""') + '" (' + Array.from({ length: 101 }, (_, i) => 'c' + i + ' TEXT').join(',') + ')');
    for (let i = 0; i < 101; i++) db.run('INSERT INTO "' + name.replaceAll('"', '""') + '" VALUES (' + Array(101).fill('?').join(',') + ')', Array(101).fill('=evil()'));
    const input = db.export(); db.close(); const original = input.slice();
    const run = vi.spyOn(SQL.Database.prototype, 'run');
    const view = await parseData({ format: 'sqlite', bytes: input, table: name });
    expect(view.kind).toBe('table');
    expect(run).toHaveBeenCalledWith('PRAGMA hard_heap_limit=134217728; PRAGMA soft_heap_limit=134217728; PRAGMA cache_size=-1024; PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    if (view.kind === 'table') {
      expect(view.rows).toHaveLength(100); expect(view.columns).toHaveLength(100); expect(view.rows[0]![0]).toBe('=evil()'); expect(view.truncated).toBe(true);
      expect(view.tables).not.toContain('virtual'); expect(view.tables).not.toContain('forbidden');
    }
    for (const table of ['forbidden', 'virtual', 'safe; DROP TABLE safe']) expect((await parseData({ format: 'sqlite', bytes: input, table })).kind).toBe('error');
    expect((await parseData({ format: 'sqlite', bytes: input, table: 'safe' })).kind).toBe('table');
    expect(input).toEqual(original);
  });
});

describe('inert DOM and lifecycle', () => {
  it('never creates active Markdown HTML, images or automatic destinations', () => {
    const view = markdownView('# Heading\n**strong**\n<script>window.evil=1</script>\n<img src="https://evil.example" onerror="evil()">\n\n![remote](https://evil.example/a.png)\n[bad](javascript:evil())\n[open](https://example.org)');
    document.body.append(view);
    expect(view.querySelector('h1')?.textContent).toBe('Heading'); expect(view.querySelector('strong')?.textContent).toBe('strong');
    expect(view.querySelectorAll('script,img,iframe,a,[src],[href],[onerror]')).toHaveLength(0);
    expect(view.textContent).toContain('Image not loaded');
    expect(markdownView('x'.repeat(100_001)).textContent).toContain('safe view limits');
  });
  it('refuses non-web, credential and control-character URLs; opens valid URLs only deliberately', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    for (const url of ['javascript:evil()', 'data:text/html,evil', 'file:///etc/passwd', 'https://user:pass@example.org', 'https://example.org/\n']) expect(openLink(url).querySelector('button')).toBeNull();
    const view = openLink('https://example.org'); expect(open).not.toHaveBeenCalled();
    view.querySelector('button')!.click(); expect(open).toHaveBeenCalledWith('https://example.org', '_blank', 'noopener,noreferrer');
  });
  it('requires raster signatures and successful decoding, rejecting SVG and fake MIME bytes', async () => {
    expect(rasterMime(bytes('<svg onload="evil()"></svg>'))).toBeNull();
    expect(rasterMime(new Uint8Array([137,80,78,71,13,10,26,10]))).toBe('image/png');
    const close = vi.fn(); vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1, height: 1, close }));
    expect(await validatedRaster(new Uint8Array([137,80,78,71,13,10,26,10]))).not.toBeNull(); expect(close).toHaveBeenCalled();
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('invalid')));
    expect(await validatedRaster(new Uint8Array([137,80,78,71,13,10,26,10]))).toBeNull();
  });
  it('terminates workers on success, errors, timeout and cancellation, and preserves the original bytes', async () => {
    vi.useFakeTimers();
    class TestWorker {
      static instances: TestWorker[] = []; onmessage?: (event: { data: unknown }) => void; onerror?: () => void;
      terminate = vi.fn(); postMessage = vi.fn(); constructor() { TestWorker.instances.push(this); }
    }
    vi.stubGlobal('Worker', TestWorker);
    const original = bytes('original'), signal = new AbortController();
    const success = dataJob({ format: 'json', bytes: original }, signal.signal);
    const worker = TestWorker.instances.at(-1)!;
    expect(worker.postMessage.mock.calls[0]![0].bytes).not.toBe(original);
    worker.onmessage!({ data: { kind: 'tree', text: 'safe', nodes: 1 } }); await expect(success).resolves.toMatchObject({ kind: 'tree' }); expect(worker.terminate).toHaveBeenCalledOnce();
    const cancelled = dataJob({ format: 'json', bytes: original }, signal.signal); const cancelCheck = expect(cancelled).rejects.toThrow('cancelled'); signal.abort(); await cancelCheck;
    expect(TestWorker.instances.at(-1)!.terminate).toHaveBeenCalledOnce();
    const timeout = dataJob({ format: 'json', bytes: original }, new AbortController().signal); const timeoutCheck = expect(timeout).rejects.toThrow('ten seconds'); await vi.advanceTimersByTimeAsync(10_000); await timeoutCheck;
    expect(TestWorker.instances.at(-1)!.terminate).toHaveBeenCalledOnce();
    const failed = dataJob({ format: 'json', bytes: original }, new AbortController().signal); const failureCheck = expect(failed).rejects.toThrow('failed'); TestWorker.instances.at(-1)!.onerror!(); await failureCheck;
    expect(TestWorker.instances.at(-1)!.terminate).toHaveBeenCalledOnce(); expect(original).toEqual(bytes('original'));
    await expect(dataJob({ format: 'json', bytes: original }, signal.signal)).rejects.toThrow('cancelled');
    expect(TestWorker.instances).toHaveLength(4);
  });
  it('cancels attachment loading when the viewer is disposed', async () => {
    const host = document.createElement('div'); document.body.append(host); let signal: AbortSignal | undefined;
    const attachment = { blob: { id: 'primary' } };
    const cleanup = mountArtifactViewer(host, { title: 'Test', content: { kind: 'image', primary: 'primary' }, attachments: [attachment] } as ArtifactPayload, async (_a, s) => { signal = s; return new Promise(() => {}); });
    expect(signal?.aborted).toBe(false); cleanup(); expect(signal?.aborted).toBe(true);
  });
});
