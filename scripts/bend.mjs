import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const options = { stdio: 'inherit' };
let result = spawnSync('bend', args, options);
if (result.error?.code === 'ENOENT') {
  result = spawnSync(join(homedir(), '.bend/bin/bend'), args, options);
}
if (result.error) {
  console.error(`Unable to run Bend. Install bend on PATH or in ~/.bend/bin/bend: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
