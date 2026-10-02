import { defineConfig } from 'vitest/config';
import { cloudflarePool, cloudflareTest } from '@cloudflare/vitest-pool-workers';
const options = { wrangler: { configPath: './wrangler.jsonc' } };
// Admission persists 64 MiB per member. Bound concurrent SQLite writers; the
// 70-agent pagination test alone writes >4 GiB and takes ~44s with four workers.
export default defineConfig({ plugins: [cloudflareTest(options)], test: { pool: cloudflarePool(options), maxWorkers: 4, testTimeout: 60000 } });
