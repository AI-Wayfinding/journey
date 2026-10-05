import { copyFileSync, mkdirSync } from 'node:fs';

// Keep source imports and emitted imports identical; ship the runtime in dist.
for (const directory of ['src/rules', 'dist/rules']) {
  const destination = new URL(`../packages/core/${directory}/`, import.meta.url);
  mkdirSync(destination, { recursive: true });
  for (const file of ['rules.mjs', 'rules.d.mts']) {
    copyFileSync(new URL(`../packages/rules/${file}`, import.meta.url), new URL(file, destination));
  }
}
