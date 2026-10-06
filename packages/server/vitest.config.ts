import { defineConfig } from 'vitest/config';
import { cloudflarePool, cloudflareTest } from '@cloudflare/vitest-pool-workers';
const options = { wrangler: { configPath: './wrangler.jsonc' } };
// Default workers pass the full suite in ~33s; the default 5s timeout fails
// five person-admission/pagination cases. 10s passes all 103 tests (was 60s).
export default defineConfig({ plugins: [cloudflareTest(options)], test: { pool: cloudflarePool(options), testTimeout: 10000 } });
