import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

// Reject before even invoking typecheck or starting the application.
const value = process.env.PLAYWRIGHT_BASE_URL;
let url;
try { url = new URL(value); } catch { throw new Error('CFS_TEST_SAFETY: PLAYWRIGHT_BASE_URL is required.'); }
if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || Number(url.port) < 3086 || Number(url.port) > 3095 || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('CFS_TEST_SAFETY: use an isolated localhost port 3086-3095.');
if (!/^\.next-[A-Za-z0-9_-]+$/.test(process.env.NEXT_DIST_DIR ?? '')) throw new Error('CFS_TEST_SAFETY: isolated NEXT_DIST_DIR is required.');
const output = path.resolve(process.env.CFS_PLAYWRIGHT_OUTPUT_DIR ?? 'artifacts/playwright/release-check');
mkdirSync(output, { recursive: true });
const env = { ...process.env, CFS_TEST_AUTH: '1', CFS_AUTH_DIR: path.resolve(process.env.CFS_AUTH_DIR ?? path.join(output, 'private-auth')), CFS_SHARING_MODE: 'local', CFS_ALLOW_LEGACY_SERVICE_ROLE_SYNC: '0' };
for (const args of [['node_modules/typescript/bin/tsc', '--noEmit'], ['node_modules/eslint/bin/eslint.js', 'app', 'tests/playwright-safety.ts', 'tests/e2e/support/safe-test.ts', 'tests/e2e/support/secure-sharing-mock.ts', 'tests/safety', 'playwright*.config.ts', 'scripts/release-check.mjs', 'scripts/test-playwright-*.mjs'], ['node_modules/@playwright/test/cli.js', 'test', '-c', 'playwright.regression.config.ts']]) {
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
