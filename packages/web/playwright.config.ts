import { defineConfig } from '@playwright/test';
const port = process.env.WAYFINDING_E2E_PORT ?? '18787';
const origin = `http://localhost:${port}`;
export default defineConfig({
  testDir: './e2e',
  workers: 1, // Every file uses the same local journey server and port.
  timeout: 180_000,
  use: { baseURL: origin, browserName: 'chromium', headless: true, actionTimeout: 15_000, trace: 'retain-on-failure' },
  webServer: {
    command: `cd ../.. && npm run build -w @ai-wayfinding/web && npx wrangler dev --config packages/server/test/wrangler.jsonc --local --ip 127.0.0.1 --port ${port} --var ORIGIN:${origin} --persist-to .scratch/wrangler-e2e-${port} --log-level warn`,
    url: origin + '/',
    timeout: 120_000,
    reuseExistingServer: false,
  },
  reporter: 'list',
});
