import { defineConfig } from 'vitest/config';
import { cloudflarePool, cloudflareTest } from '@cloudflare/vitest-pool-workers';
const options = { wrangler: { configPath: './wrangler.jsonc' } };
export default defineConfig({ plugins: [cloudflareTest(options)], test: { pool: cloudflarePool(options) } });
