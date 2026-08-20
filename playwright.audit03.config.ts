import { defineConfig, devices } from '@playwright/test';
import * as path from 'node:path';
import * as os from 'node:os';

// OneDrive がプロジェクト配下の .next / test-results を同期で破壊するため、
// Playwright のアーティファクト出力先を OneDrive 外 (ローカル AppData temp) に逃がす。
const OUT = path.join(os.tmpdir(), 'audit03-pw-output');

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '_audit_03_fixtures.spec.ts',
  outputDir: OUT,
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['line']],
  use: {
    baseURL: 'http://localhost:3014',
    trace: 'off',
    screenshot: 'off',
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
