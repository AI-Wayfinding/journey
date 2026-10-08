import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scratch } from './local-server.js';

/** Inspect actual local workerd storage, not framing or allocation spies. */
export async function databases(folder = join(scratch, 'v3', 'do')): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return (await Promise.all(entries.map(async entry => entry.isDirectory() ? databases(join(folder, entry.name)) : entry.name.endsWith('.sqlite') ? [join(folder, entry.name)] : []))).flat();
}
export async function allocations() {
  const result: { file: string; n: number; min: number; max: number }[] = [];
  for (const file of await databases()) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='slots'").get()) {
        const row = db.prepare('SELECT COUNT(*) AS n,MIN(length(ciphertext)) AS min,MAX(length(ciphertext)) AS max FROM slots').get()!;
        result.push({ file, n: Number(row.n), min: Number(row.min), max: Number(row.max) });
      }
    } finally { db.close(); }
  }
  return result.sort((a, b) => a.file.localeCompare(b.file));
}
export async function registryChange(id: string, field: 'expires' | 'signingKey' | 'keyStorage', value: string | number) {
  for (const file of await databases()) {
    const db = new DatabaseSync(file);
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_sessions'").get()) {
        const result = db.prepare(`UPDATE agent_sessions SET ${field}=? WHERE id=?`).run(value, id);
        if (result.changes !== 1) throw new Error('Missing test agent session');
        return;
      }
    } finally { db.close(); }
  }
  throw new Error('Missing local registry');
}
