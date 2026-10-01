import { isAlias, isCollection, isScalar, parseDocument } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import initSqlJs from 'sql.js';
import sqliteWasm from 'sql.js/dist/sql-wasm.wasm?url';

export const VIEW_LIMITS = { input: 25_000_000, rows: 100, columns: 100, nodes: 1_000, bytes: 100_000, depth: 64, memory: 128 * 1024 * 1024, milliseconds: 10_000 } as const;
export type DataView =
  | { kind: 'tree'; text: string; nodes: number }
  | { kind: 'table'; columns: string[]; rows: string[][]; truncated: boolean; tables?: string[]; table?: string }
  | { kind: 'error'; message: string };
export interface DataRequest { format: string; bytes: Uint8Array; table?: string }
const encoder = new TextEncoder();
const fallback = (message: string): DataView => ({ kind: 'error', message: `${message} Download the original bytes instead.` });

/** Iterative validation before stringification: no prototype assignment or executable objects. */
function structured(value: unknown): DataView {
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > VIEW_LIMITS.depth) throw new Error('Nesting exceeds 64 levels.');
    if (++nodes > VIEW_LIMITS.nodes) throw new Error('Structure exceeds 1,000 displayed nodes.');
    if (item.value && typeof item.value === 'object') {
      for (const key of Object.keys(item.value)) {
        if (nodes + pending.length >= VIEW_LIMITS.nodes) throw new Error('Structure exceeds 1,000 displayed nodes.');
        pending.push({ value: (item.value as Record<string, unknown>)[key], depth: item.depth + 1 });
      }
    }
  }
  const text = JSON.stringify(value, null, 2);
  if (encoder.encode(text).length > VIEW_LIMITS.bytes) throw new Error('Structure exceeds 100,000 displayed UTF-8 bytes.');
  return { kind: 'tree', text, nodes };
}

function json(text: string): unknown {
  let depth = 0, quoted = false, escaped = false;
  for (const c of text) {
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '[' || c === '{') { if (++depth > VIEW_LIMITS.depth) throw new Error('Nesting exceeds 64 levels.'); }
    else if (c === ']' || c === '}') depth--;
  }
  return JSON.parse(text);
}
function yaml(text: string): unknown {
  const doc = parseDocument(text, { customTags: [], uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Error('Malformed YAML or unsupported YAML tag.');
  const pending = [{ value: doc.contents, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 2 * VIEW_LIMITS.nodes) throw new Error('Structure exceeds the YAML view limit.');
    if (depth > VIEW_LIMITS.depth) throw new Error('Nesting exceeds 64 levels.');
    if (isAlias(value)) throw new Error('YAML aliases are not supported.');
    if (isScalar(value) || isCollection(value)) {
      if (value.tag) throw new Error('YAML tags are not supported.');
      if (isCollection(value)) for (const child of value.items) {
        if (child && typeof child === 'object' && 'key' in child && 'value' in child) {
          pending.push({ value: child.key, depth: depth + 1 }, { value: child.value, depth: depth + 1 });
        } else pending.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return doc.toJS({ maxAliasCount: 0, mapAsMap: false });
}

/** CSV cells remain strings, including formula prefixes. Scan all input, retain only the bounded preview. */
function csv(text: string): DataView {
  const kept: string[][] = []; let row: string[] = [], cell = '', quoted = false, closed = false, start = true;
  let rowCount = 0, columnCount = 0, bytes = 0, truncated = false;
  const finishCell = () => {
    if (rowCount <= VIEW_LIMITS.rows && columnCount < VIEW_LIMITS.columns) {
      bytes += encoder.encode(cell).length;
      if (bytes > VIEW_LIMITS.bytes) throw new Error('Table exceeds 100,000 displayed UTF-8 bytes.');
      row.push(cell);
    } else truncated = true;
    columnCount++; cell = ''; start = true; closed = false;
  };
  const append = (c: string) => {
    if (rowCount <= VIEW_LIMITS.rows && columnCount < VIEW_LIMITS.columns) {
      cell += c;
      if (cell.length > VIEW_LIMITS.bytes) throw new Error('Cell exceeds the display limit.');
    }
  };
  const finishRow = () => { finishCell(); if (rowCount <= VIEW_LIMITS.rows) kept.push(row); else truncated = true; rowCount++; row = []; columnCount = 0; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { append('"'); i++; } else { quoted = false; closed = true; } }
      else append(c);
    } else if (c === ',') finishCell();
    else if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; finishRow(); }
    else if (c === '"' && start && !closed) { quoted = true; start = false; }
    else { if (closed || c === '"') throw new Error('Malformed CSV quoting.'); append(c); start = false; }
  }
  if (quoted) throw new Error('Malformed CSV: unterminated quoted cell.');
  if (cell || columnCount || !start || closed) finishRow();
  const columns = kept.shift() ?? [];
  const width = Math.max(columns.length, ...kept.map(r => r.length));
  while (columns.length < width) columns.push(`Column ${columns.length + 1}`);
  return { kind: 'table', columns, rows: kept, truncated };
}

let sqlite: ReturnType<typeof initSqlJs> | undefined;
const identifier = (name: string) => '"' + name.replace(/"/g, '""') + '"';
/** Fresh browser-local database per request. No user SQL, views, virtual tables, extensions or filesystem API. */
async function sqliteView(bytes: Uint8Array, selected?: string): Promise<DataView> {
  if (new TextDecoder().decode(bytes.subarray(0, 16)) !== 'SQLite format 3\0') throw new Error('Malformed SQLite header.');
  sqlite ??= initSqlJs({ locateFile: () => sqliteWasm });
  const SQL = await sqlite, db = new SQL.Database(bytes);
  try {
    db.run(`PRAGMA hard_heap_limit=${VIEW_LIMITS.memory}; PRAGMA soft_heap_limit=${VIEW_LIMITS.memory}; PRAGMA cache_size=-1024; PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;`);
    const schema = db.exec("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND upper(ltrim(sql)) NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name LIMIT 101")[0];
    const names = schema?.values.map(r => String(r[0])) ?? [], tables = names.slice(0, VIEW_LIMITS.columns);
    const table = selected ?? tables[0];
    if (selected !== undefined && !tables.includes(selected)) throw new Error('Unknown or unsupported SQLite table.');
    if (!table) return { kind: 'table', columns: [], rows: [], tables, truncated: false };
    const info = db.exec(`PRAGMA table_info(${identifier(table)})`)[0];
    const namesOfColumns = info?.values.map(r => String(r[1])) ?? [];
    const columns = namesOfColumns.slice(0, VIEW_LIMITS.columns);
    if (!columns.length) throw new Error('Unsupported SQLite table schema.');
    const result = db.exec(`SELECT ${columns.map(identifier).join(',')} FROM ${identifier(table)} LIMIT 101`)[0];
    let displayedBytes = encoder.encode(columns.join('')).length;
    const rows = (result?.values ?? []).slice(0, VIEW_LIMITS.rows).map(row => row.map(value => {
      const cell = value instanceof Uint8Array ? `[binary: ${value.byteLength} bytes]` : value === null ? 'null' : String(value);
      displayedBytes += encoder.encode(cell).length;
      if (displayedBytes > VIEW_LIMITS.bytes) throw new Error('Table exceeds 100,000 displayed UTF-8 bytes.');
      return cell;
    }));
    return { kind: 'table', columns, rows, tables, table, truncated: names.length > tables.length || namesOfColumns.length > columns.length || (result?.values.length ?? 0) > rows.length };
  } finally { db.close(); }
}

export async function parseData(request: DataRequest): Promise<DataView> {
  try {
    if (request.bytes.byteLength > VIEW_LIMITS.input) throw new Error('Input exceeds 25,000,000 bytes.');
    if (request.format === 'sqlite') return await sqliteView(request.bytes, request.table);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(request.bytes);
    switch (request.format) {
      case 'json': return structured(json(text));
      case 'csv': return csv(text.replace(/^\uFEFF/, ''));
      case 'toml': return structured(parseToml(text, { maxDepth: VIEW_LIMITS.depth }));
      case 'yaml': return structured(yaml(text));
      default: return fallback('No data view for this format.');
    }
  } catch (cause) {
    // Parser messages may contain private input. Report a bounded, local-only message, never log it.
    return fallback(cause instanceof Error ? cause.message.slice(0, 240) : 'Malformed or unsupported data.');
  }
}

// Only install a handler inside a worker, not when unit tests import the parser.
if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = async (event: MessageEvent<DataRequest>) => {
    const input = event.data;
    const request: DataRequest = { format: input.format, bytes: input.bytes, ...(typeof input.table === 'string' ? { table: input.table } : {}) };
    self.postMessage(await parseData(request));
  };
}
