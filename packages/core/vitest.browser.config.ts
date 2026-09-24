import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
export default defineConfig({ test: { browser: { enabled: true, provider: playwright({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }), instances: [{ browser: 'chromium' }], headless: true } } });
