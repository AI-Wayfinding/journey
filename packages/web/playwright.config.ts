import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  use: { baseURL: 'http://localhost:18787', browserName: 'chromium', headless: true, actionTimeout: 15_000, trace: 'retain-on-failure' },
  webServer: {
    command: 'cd ../.. && npm run build -w @ai-wayfinding/web && npx wrangler dev --config packages/server/test/wrangler.jsonc --local --ip 127.0.0.1 --port 18787 --persist-to .scratch/wrangler-e2e --log-level warn',
    url: 'http://localhost:18787/',
    timeout: 120_000,
    reuseExistingServer: false,
  },
  reporter: 'list',
});
