import { PRIVATE_HEADER_BYTES, PRIVATE_SLOT_BYTES, decodeVaultPatch, privateDecode, privateRandomBytes } from '@ai-wayfinding/core';
import type { VaultPatch, VaultWire } from '@ai-wayfinding/core';
import { failure } from './types.js';
const randomToken = (): string => Array.from(privateRandomBytes(32), b => b.toString(16).padStart(2, '0')).join('');

const encode = (bytes: Uint8Array): string => { let value = ''; for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(value); };
/** Dedicated SQLite object, never R2/shared records. Allocation creates all 64
 * fixed-sized rows before admission is acknowledged. Only the Worker/Enclave
 * can address this binding; user-supplied handles are never accepted. */
export class PrivateVaultObject {
  constructor(private state: DurableObjectState) {
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS head (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, frame BLOB)');
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS slots (id INTEGER PRIMARY KEY, ciphertext BLOB NOT NULL)');
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS agent_wraps (agent TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, expires INTEGER NOT NULL)');
  }
  async allocate(): Promise<void> {
    if (this.state.storage.sql.exec('SELECT token FROM head WHERE id=1').toArray().length) return;
    const token = randomToken();
    // SQLite copies bound bytes synchronously. Reuse one slot and its 64 KiB
    // views instead of allocating 64 buffers and 1,024 views per admission.
    const bytes = new Uint8Array(PRIVATE_SLOT_BYTES);
    const chunks = Array.from({ length: PRIVATE_SLOT_BYTES / 65536 }, (_, i) => bytes.subarray(i * 65536, (i + 1) * 65536));
    this.state.storage.transactionSync(() => {
      if (this.state.storage.sql.exec('SELECT token FROM head WHERE id=1').toArray().length) return;
      for (let i = 0; i < 64; i++) {
        // Never reuse contents: refill every byte with fresh CSPRNG output.
        for (const chunk of chunks) crypto.getRandomValues(chunk);
        this.state.storage.sql.exec('INSERT INTO slots VALUES(?,?)', i, bytes);
      }
      this.state.storage.sql.exec('INSERT INTO head VALUES(1,?,NULL)', token);
    });
  }
  async read(indices: readonly number[] | 'all'): Promise<VaultWire> {
    const wanted = indices === 'all' ? Array.from({ length: 64 }, (_, i) => i) : indices;
    if (indices !== 'all' && (wanted.length !== 2 || new Set(wanted).size !== 2 || wanted.some(i => !Number.isInteger(i) || i < 0 || i >= 64))) throw new Error('Invalid private read');
    const head = this.state.storage.sql.exec<{ token: string; frame: ArrayBuffer | null }>('SELECT token,frame FROM head WHERE id=1').one();
    const slots = wanted.map(index => ({ index, ciphertext: encode(new Uint8Array(this.state.storage.sql.exec<{ ciphertext: ArrayBuffer }>('SELECT ciphertext FROM slots WHERE id=?', index).one().ciphertext)) }));
    return { token: head.token, frame: head.frame ? encode(new Uint8Array(head.frame)) : null, slots };
  }
  async commit(patch: VaultPatch): Promise<{ token: string } | null> {
    const token = randomToken(), frame = privateDecode(patch.frame, PRIVATE_HEADER_BYTES), slots = patch.slots.map(s => ({ index: s.index, bytes: privateDecode(s.ciphertext, PRIVATE_SLOT_BYTES) }));
    return this.state.storage.transactionSync(() => {
      const head = this.state.storage.sql.exec<{ token: string; frame: ArrayBuffer | null }>('SELECT token,frame FROM head WHERE id=1').one();
      if (head.token !== patch.token) return null;
      for (const row of slots) this.state.storage.sql.exec('UPDATE slots SET ciphertext=? WHERE id=?', row.bytes, row.index);
      this.state.storage.sql.exec('UPDATE head SET token=?,frame=? WHERE id=1', token, frame); return { token };
    });
  }
  async alarm(): Promise<void> {
    this.state.storage.sql.exec('DELETE FROM agent_wraps WHERE expires<=?', Date.now());
    const next = this.state.storage.sql.exec<{ expires: number }>('SELECT MIN(expires) AS expires FROM agent_wraps').one().expires;
    if (next) await this.state.storage.setAlarm(next);
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/allocate') { await this.allocate(); return Response.json({ ok: true }); }
      if (url.pathname === '/agent-wrap') {
        this.state.storage.sql.exec('DELETE FROM agent_wraps WHERE expires<=?', Date.now());
        const agent = url.searchParams.get('agent'); if (!agent) return failure('invalid-request', 400);
        if (request.method === 'DELETE') { this.state.storage.sql.exec('DELETE FROM agent_wraps WHERE agent=?', agent); return new Response(null, { status: 204 }); }
        if (request.method === 'GET') {
          const row = this.state.storage.sql.exec<{ ciphertext: string }>('SELECT ciphertext FROM agent_wraps WHERE agent=?', agent).toArray()[0];
          return row ? Response.json({ ciphertext: row.ciphertext }, { headers: { 'Cache-Control': 'no-store' } }) : failure('not-found', 404);
        }
        if (request.method === 'PUT') {
          const value = await request.json() as { ciphertext: string; expires: number };
          if (!this.state.storage.sql.exec('SELECT frame FROM head WHERE frame IS NOT NULL').toArray().length) return failure('conflict', 409);
          this.state.storage.sql.exec('INSERT OR REPLACE INTO agent_wraps VALUES(?,?,?)', agent, value.ciphertext, value.expires);
          await this.state.storage.setAlarm(Date.now() + 60000);
          return Response.json({ ok: true });
        }
        return failure('invalid-request', 400);
      }
      if (request.method === 'GET') {
        const q = url.searchParams.get('slots');
        if (q !== 'all' && !/^\d{2},\d{2}$/.test(q ?? '')) return failure('invalid-request', 400);
        const wanted = q === 'all' ? Array.from({ length: 64 }, (_, i) => i) : q!.split(',').map(Number);
        if (new Set(wanted).size !== wanted.length || wanted.some(i => i >= 64)) return failure('invalid-request', 400);
        const head = this.state.storage.sql.exec<{ token: string; frame: ArrayBuffer | null }>('SELECT token,frame FROM head WHERE id=1').one();
        // Copy raw SQLite bytes directly; a 64-slot response must not allocate
        // an additional 89 MiB base64 representation in the Worker heap.
        const bytes = new Uint8Array(65 + PRIVATE_HEADER_BYTES + wanted.length * (1 + PRIVATE_SLOT_BYTES));
        bytes.set(new TextEncoder().encode(head.token)); bytes[64] = head.frame ? 1 : 0;
        bytes.set(head.frame ? new Uint8Array(head.frame) : privateRandomBytes(PRIVATE_HEADER_BYTES), 65);
        let offset = 65 + PRIVATE_HEADER_BYTES;
        for (const index of wanted) { bytes[offset++] = index; const row = this.state.storage.sql.exec<{ ciphertext: ArrayBuffer }>('SELECT ciphertext FROM slots WHERE id=?', index).one(); bytes.set(new Uint8Array(row.ciphertext), offset); offset += PRIVATE_SLOT_BYTES; }
        return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
      }
      if (request.method === 'PUT') {
        const expected = 64 + PRIVATE_HEADER_BYTES + 2 * (1 + PRIVATE_SLOT_BYTES), bytes = new Uint8Array(expected), reader = request.body?.getReader(); let count = 0;
        try {
          if (reader) for (;;) { const part = await reader.read(); if (part.done) break; if (count + part.value.length > expected) return failure('invalid-request', 400); bytes.set(part.value, count); count += part.value.length; }
          if (count !== expected) return failure('invalid-request', 400);
          const result = await this.commit(decodeVaultPatch(bytes)); return result ? Response.json(result) : failure('conflict', 409);
        } finally { await reader?.cancel().catch(() => {}); }
      }
      return failure('invalid-request', 400);
    } catch { return failure('invalid-request', 400); }
  }
}
