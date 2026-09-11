import { test, expect } from '@playwright/test';
import { createGrant, readAuthKeys } from '../../app/lib/apiAuthCore.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

test('isolated server rejects every unauthenticated API method including spoofed loopback headers', async ({ playwright, baseURL }) => {
  test.setTimeout(180000);
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const results: string[] = [];
  for (const file of readdirSync(path.resolve('app/api'), { recursive: true }).map(String).filter(f => f.endsWith('route.ts'))) {
    const source = readFileSync(path.resolve('app/api', file), 'utf8');
    for (const match of source.matchAll(/export async function (GET|POST)\(/g)) {
      const url = '/api/' + file.replaceAll('\\', '/').replace('/route.ts', '');
      const response = await anonymous.fetch(url, { method: match[1], headers: { host: 'localhost:3087', 'x-forwarded-for': '127.0.0.1' }, ...(match[1] === 'POST' ? { data: {} } : {}) });
      results.push(`${match[1]} ${url}: ${response.status()}`);
      expect(response.status(), results.at(-1)).toBe(401);
    }
  }
  await test.info().attach('live-api-matrix', { body: results.join('\n'), contentType: 'text/plain' });
  await anonymous.dispose();
});

test('PC launch and tablet invitation establish persistent sessions with distinct privileges', async ({ browser, baseURL }) => {
  test.setTimeout(120000);
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  // Only authentication and invitation issuance use the real server. Business APIs cannot write data.
  await context.route('**/api/**', route => {
    if (new URL(route.request().url()).pathname === '/api/tablet-url') return route.continue();
    return route.fulfill({ json: { projects: [], trash: { projects: [], roomTypes: [] }, mode: 'local', enabled: false, ownsLock: true, locks: [], lock: null } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'CFS に接続', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('entry.png') });
  const keys = await readAuthKeys();
  await page.goto(`/#cfs_access=${createGrant(keys)}`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'CFS に接続', exact: true })).toHaveCount(0);
  const identity = await (await context.request.get('/auth/connect')).json();
  expect(identity.role).toBe('admin');
  expect(page.url()).not.toContain('cfs_access');
  const cookie = (await context.cookies()).find(c => c.name === 'cfs-access-v1')!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 86400);
  const savedState = await context.storageState();
  await page.screenshot({ path: test.info().outputPath('pc-authenticated.png') });
  const invite = await (await context.request.get('/api/tablet-url')).json();
  const grant = new URLSearchParams(new URL(invite.url).hash.slice(1)).get('cfs_access');
  expect(grant).toBeTruthy();
  const tablet = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, viewport: { width: 820, height: 1180 } });
  await tablet.route('**/api/**', route => route.fulfill({ json: { projects: [], trash: { projects: [], roomTypes: [] }, mode: 'local', enabled: false, ownsLock: true, locks: [] } }));
  const tabletPage = await tablet.newPage();
  await tabletPage.goto(`/#cfs_access=${grant}`);
  await expect(tabletPage.getByRole('heading', { name: 'CFS に接続', exact: true })).toHaveCount(0);
  const editor = await (await tablet.request.get('/auth/connect')).json();
  expect(editor.role).toBe('editor');
  expect(editor.userId).not.toBe(identity.userId);
  // APIRequestContext does not use page route mocks: these hit the actual auth guard.
  expect((await tablet.request.post('/api/app-update/apply', { data: {} })).status()).toBe(403);
  expect((await tablet.request.post('/api/collaboration/lock/force-release', { data: {} })).status()).toBe(403);
  expect((await tablet.request.get('/api/tablet-url')).status()).toBe(403);
  expect((await tablet.request.post('/api/collaboration/lock/acquire', { data: { userId: identity.userId, sessionId: identity.sessionId + ':tab' } })).status()).toBe(403);
  await tabletPage.screenshot({ path: test.info().outputPath('tablet-authenticated.png') });
  await expect(tabletPage.locator('.app-update-control')).toHaveCount(0);
  const reopened = await browser.newContext({ baseURL, storageState: savedState });
  expect((await (await reopened.request.get('/auth/connect')).json()).userId).toBe(identity.userId);
  await reopened.route('**/api/**', route => route.fulfill({ json: { projects: [], trash: { projects: [], roomTypes: [] }, mode: 'local', enabled: false, ownsLock: true, locks: [] } }));
  const bookmark = await reopened.newPage();
  await bookmark.goto('/');
  await expect(bookmark.getByRole('heading', { name: 'CFS Project Selection' })).toBeVisible();
  await expect(bookmark.getByRole('heading', { name: 'CFS に接続', exact: true })).toHaveCount(0);
  await reopened.close(); await tablet.close(); await context.close();
});
