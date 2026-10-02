import { defineConfig, devices } from '@playwright/test';
import { baseURL, testPort, testStorageState } from './tests/playwright-safety';
if (!process.env.CFS_ROOM_DELETE_TEST_ROOT || process.env.CFS_APP_DIR !== process.env.CFS_ROOM_DELETE_TEST_ROOT
  || !process.env.NEXT_DIST_DIR || !process.env.CFS_AUTH_DIR) throw new Error('Room deletion tests require an isolated app/data/auth/build directory.');
export default defineConfig({
  testDir: './tests/e2e', testMatch: ['room_type_delete_atomic.spec.ts', 't149-save-history.spec.ts'], workers: 1, retries: 0,
  timeout: 60000, expect: { timeout: 12000 }, outputDir: `${process.env.CFS_ROOM_DELETE_TEST_ROOT}/results`,
  reporter: [['list'], ['json', { outputFile: `${process.env.CFS_ROOM_DELETE_TEST_ROOT}/results.json` }]],
  use: { ...devices['Desktop Chrome'], baseURL, storageState: testStorageState(), headless: true, serviceWorkers: 'block', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: `node node_modules/next/dist/bin/next dev -H 127.0.0.1 -p ${testPort}`, url: baseURL, timeout: 120000, reuseExistingServer: false },
});
