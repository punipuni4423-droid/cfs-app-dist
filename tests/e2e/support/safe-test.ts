import { test as base, expect } from '@playwright/test';
export { expect };
export type { Page, Locator, BrowserContext, Download, Route, TestInfo, Dialog } from '@playwright/test';

/** Last-resort context route: mocks registered by a test take precedence.
 * Popup initial requests also pass through this route, before a page exists.
 */
export const test = base.extend<{ networkSafety: void }>({
  networkSafety: [async ({ context }, runFixture) => {
    void context;
    await runFixture();
  }, { auto: true }],
  request: async ({ context }, runFixture) => { await runFixture(context.request); },
  context: async ({ context, browser, baseURL }, runFixture, testInfo) => {
    const unexpected: string[] = [];
    const origin = new URL(baseURL!).origin;
    const restorers: Array<() => void> = [];
    const denyMethod = (target: object, key: string) => {
      const original = Reflect.get(target, key);
      Reflect.set(target, key, async () => {
        unexpected.push(`Unrouted API: ${key}`);
        throw new Error('CFS_TEST_SAFETY: use the routed context/page with explicit mocks; direct API requests and extra browser contexts are forbidden.');
      });
      restorers.push(() => { Reflect.set(target, key, original); });
    };
    for (const method of ['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head']) denyMethod(context.request, method);
    for (const method of ['newContext', 'newPage']) denyMethod(browser, method);
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      // Next's dev overlay requests source frames for intentionally injected
      // errors. Mock this diagnostic endpoint; never send its POST to a server.
      if (url.origin === origin && url.pathname === '/__nextjs_original-stack-frames' && request.method() === 'POST') {
        await route.fulfill({ json: [] });
        return;
      }
      if (url.origin === origin && !url.pathname.startsWith('/api/') && request.method() === 'GET') {
        await route.continue();
        return;
      }
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient');
    });
    try { await runFixture(context); } finally { restorers.reverse().forEach((restore) => restore()); }
    if (unexpected.length) {
      await testInfo.attach('unmocked-requests', { body: JSON.stringify(unexpected, null, 2), contentType: 'application/json' });
      expect(unexpected, 'Unmocked requests were blocked (including popup requests)').toEqual([]);
    }
  },
});
