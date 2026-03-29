import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './extension/test/e2e',
  testMatch: 'playwright-extension.test.mjs',
  timeout: 60_000,
  retries: 0,
  workers: 1, // extensions need serial execution
  use: {
    // Extensions require Chromium — not Firefox or WebKit
    browserName: 'chromium',
  },
  projects: [
    {
      name: 'extension-e2e',
      use: { browserName: 'chromium' },
    },
  ],
});
