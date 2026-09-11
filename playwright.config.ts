import { defineConfig, devices } from '@playwright/test';
import { baseURL, isolatedSpecs, testStorageState } from './tests/playwright-safety';
const storageState = testStorageState();

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: isolatedSpecs,
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    serviceWorkers: 'block',
    baseURL,
    storageState,
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
