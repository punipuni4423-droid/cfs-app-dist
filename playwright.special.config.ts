import { defineConfig, devices } from '@playwright/test';
import { baseURL, isolatedSpecs, testStorageState } from './tests/playwright-safety';

if (process.env.CFS_ISOLATED_SPECIAL_TESTS !== '1') {
  throw new Error('CFS_TEST_SAFETY: special specs require CFS_ISOLATED_SPECIAL_TESTS=1 and a disposable data/auth environment.');
}
export default defineConfig({
  testDir: './tests/e2e', testMatch: isolatedSpecs, workers: 1, retries: 0,
  use: { baseURL, storageState: testStorageState(), serviceWorkers: 'block', screenshot: 'only-on-failure' },
  projects: [{ name: 'isolated-special', use: { ...devices['Desktop Chrome'] } }],
});
