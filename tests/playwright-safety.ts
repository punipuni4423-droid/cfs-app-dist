import { execFileSync } from 'node:child_process';
import path from 'node:path';

const value = process.env.PLAYWRIGHT_BASE_URL;
if (!value) throw new Error('CFS_TEST_SAFETY: PLAYWRIGHT_BASE_URL is required.');
let parsed: URL;
try { parsed = new URL(value); } catch { throw new Error('CFS_TEST_SAFETY: invalid PLAYWRIGHT_BASE_URL.'); }
if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(parsed.hostname)
  || Number(parsed.port) < 3086 || Number(parsed.port) > 3095
  || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
  throw new Error('CFS_TEST_SAFETY: use an isolated http://localhost:3086-3095 origin; production/verification ports are forbidden.');
}
export const baseURL = parsed.origin;
export const testPort = parsed.port;
export const testHost = parsed.hostname;
export const isolatedSpecs = [
  '**/_manual_screenshots.spec.ts', '**/_manual_inspection_screenshots.spec.ts', '**/_visual_topbar.spec.ts',
  '**/_project_export_ld_compat.spec.ts', '**/_lutron_spec_ui.spec.ts', '**/verify-fill.spec.ts',
  '**/_api_access_ui.spec.ts', '**/_api_access.spec.ts', '**/_migration_api.spec.ts', '**/_trash_concurrency.spec.ts',
];
export function testStorageState() {
  if (process.env.CFS_TEST_AUTH !== '1') return undefined;
  if (!process.env.CFS_AUTH_DIR) throw new Error('CFS_TEST_SAFETY: CFS_AUTH_DIR is required for test authentication.');
  const token = execFileSync(process.execPath, [path.resolve('scripts/cfs-access.mjs'), 'session'], { encoding: 'utf8', windowsHide: true });
  return { cookies: [{ name: 'cfs-access-v1', value: token, domain: testHost, path: '/', expires: Date.now() / 1000 + 3600, httpOnly: true, secure: false, sameSite: 'Strict' as const }], origins: [] };
}
