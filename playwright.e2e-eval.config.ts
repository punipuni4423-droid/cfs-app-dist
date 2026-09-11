import { baseURL, isolatedSpecs, testStorageState } from './tests/playwright-safety';
/**
 * 評価用 Playwright 設定 (本番 playwright.config.ts は変更しない)
 * baseURL を 3001 に向けた一時設定ファイル
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: isolatedSpecs,
  timeout: 35000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 2,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-eval' }]],
  use: {
    serviceWorkers: 'block',
    storageState: testStorageState(),
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
