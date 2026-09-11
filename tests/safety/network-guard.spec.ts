import { test, expect } from '../e2e/support/safe-test';

test('guard probe', async ({ page, context, request, browser, baseURL }) => {
  await context.route('**/safety-probe', (route) => route.fulfill({ contentType: 'text/html', body: '<button>Probe</button>' }));
  await page.goto(`${baseURL}/safety-probe`);
  const mode = process.env.CFS_GUARD_PROBE;
  if (mode === 'mocked') {
    await context.route('**/api/probe', (route) => route.fulfill({ json: { ok: true } }));
    expect(await page.evaluate(async () => (await fetch('/api/probe')).json())).toEqual({ ok: true });
  } else if (mode === 'request') {
    await request.post('/api/probe', { data: {} }).catch(() => {});
  } else if (mode === 'context-request') {
    await context.request.post('/api/probe', { data: {} }).catch(() => {});
  } else if (mode === 'new-context') {
    await browser.newContext().catch(() => {});
  } else if (mode === 'popup') {
    const popup = context.waitForEvent('page');
    await page.evaluate(() => window.open('/api/probe'));
    const opened = await popup;
    await opened.waitForLoadState('domcontentloaded').catch(() => {});
  } else {
    await page.evaluate(async () => { await fetch('/api/probe', { method: 'POST', body: '{}' }).catch(() => {}); });
  }
});
