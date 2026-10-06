import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build rules.mjs into a temporary file and replace the committed copy only
// when its bytes differ, so an unchanged build never rewrites a tracked file.
const rules = fileURLToPath(new URL('../packages/rules/', import.meta.url));
const target = join(rules, 'rules.mjs');
const temporary = mkdtempSync(join(rules, '.build-'));
try {
  const output = join(temporary, 'rules.mjs');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./bend.mjs', import.meta.url)), 'rules.bend', '-o', output], { cwd: rules, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  let current = null;
  try { current = readFileSync(target, 'utf8'); } catch { /* first build */ }
  if (current === readFileSync(output, 'utf8')) console.log('rules.mjs is up to date');
  else { renameSync(output, target); console.log('rules.mjs rebuilt'); }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
