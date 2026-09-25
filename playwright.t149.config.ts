import { defineConfig, devices } from '@playwright/test';
import { baseURL, testPort, testStorageState } from './tests/playwright-safety';
const smoke = process.env.T149_TEST_GROUP === 'smoke';
const output = `artifacts/t149-codex1/${smoke ? 'modified-smoke' : 'browser'}`;
export default defineConfig({
  testDir: './tests/e2e', testMatch: smoke ? ['cfs-smoke.spec.ts'] : ['t149-save-history.spec.ts', 'critical-save-reliability.spec.ts', 'import-save-recovery.spec.ts', 'user-changelog.spec.ts'], workers: 1, retries: 0,
  timeout: smoke ? 30000 : 45000, expect: { timeout: smoke ? 8000 : 10000 },
  outputDir: `${output}/test-results`,
  reporter: [['line'], ['json', { outputFile: `${output}/results.json` }]],
  use: { ...devices['Desktop Chrome'], baseURL, storageState: testStorageState(), headless: true, serviceWorkers: 'block', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: `node node_modules/next/dist/bin/next dev -H 127.0.0.1 -p ${testPort}`, url: baseURL, timeout: 120000, reuseExistingServer: false },
});
