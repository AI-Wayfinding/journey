import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rules = fileURLToPath(new URL('../packages/rules/', import.meta.url));
const temporary = mkdtempSync(join(rules, '.generated-'));
try {
  const output = join(temporary, 'rules.mjs');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./bend.mjs', import.meta.url)), 'rules.bend', '-o', output], { cwd: rules, stdio: 'inherit' });
  assert.equal(result.status, 0, 'Bend compilation failed');
  assert.equal(readFileSync(output, 'utf8'), readFileSync(join(rules, 'rules.mjs'), 'utf8'), 'Committed rules.mjs is stale; run npm run build:rules');
  console.log('Committed rules.mjs matches a fresh Bend build');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
