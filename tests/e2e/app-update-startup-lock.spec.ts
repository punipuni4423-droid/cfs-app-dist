/**
 * Startup maintenance busy window: right after START_CFS_APP.bat the launcher
 * still holds .cfs-updater/maintenance.lock for a short while, so
 * POST /api/app-update/apply answers 409. The UI must show a clear English
 * notice, keep the Update button enabled and never auto-retry the update.
 * The API side (lock probe, stable code) is covered by the isolated
 * _app_update_startup_lock_api.spec.ts; this spec mocks the apply response.
 */
import { test, expect, type Page } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { applyRejectionNotice, STARTUP_MAINTENANCE_RUNNING_CODE, STARTUP_MAINTENANCE_RUNNING_MESSAGE } from '../../app/lib/appUpdateProgress';

const BOOTSTRAP_BUSY_MESSAGE = 'An update or maintenance operation is already running.';
const LEGACY_HINT = ' If CFS was just started, startup maintenance may still be finishing. Please try again in about a minute.';
const NOT_READY_MESSAGE = 'The installation is not ready for an update. Use UPDATE_CFS_APP.cmd for diagnostics.';

function availableStatus() {
  return {
    enabled: true, state: 'available', message: 'Update available: 1111111 -> 2222222.',
    localSha: '1'.repeat(40), remoteSha: '2'.repeat(40), ahead: 0, behind: 1, dirty: false,
    checkedAt: new Date().toISOString(), appDir: 'mock',
  };
}

interface Rejection { status?: number; body: Record<string, unknown> }

/** Clicks Update, accepts the confirm, and returns the alert text plus live counters of confirms and apply POSTs. */
async function clickUpdateAndCollectAlert(page: Page, rejection: Rejection): Promise<{ alert: string; counts: { apply: number; confirms: number } }> {
  const counts = { apply: 0, confirms: 0 };
  let alertText = '';
  await page.route('**/api/app-update/status**', (route) => route.fulfill({ json: availableStatus() }));
  await page.route('**/api/app-update/apply', async (route) => {
    counts.apply += 1;
    await route.fulfill({ status: rejection.status ?? 409, json: rejection.body });
  });
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'confirm') { counts.confirms += 1; await dialog.accept(); return; }
    alertText = dialog.message();
    await dialog.dismiss();
  });
  await page.goto('/');
  const button = page.locator('.app-update-button').first();
  await expect(button).toHaveText('Update Available');
  await button.click();
  await expect.poll(() => alertText, { timeout: 10000 }).not.toBe('');
  return { alert: alertText, counts };
}

async function expectButtonReadyAgain(page: Page): Promise<void> {
  const button = page.locator('.app-update-button').first();
  await expect(button).toBeEnabled();
  await expect(button).toHaveText('Update Available');
  await expect(page.locator('.app-update-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => window.sessionStorage.getItem('cfs-self-update-active'))).toBeNull();
}

test.beforeEach(async ({ page }) => {
  await installLocalEditingMocks(page);
});

test('pure helper: startup code wins, the frozen bootstrap busy text gets the hint, other errors stay verbatim', () => {
  expect(applyRejectionNotice({ error: STARTUP_MAINTENANCE_RUNNING_MESSAGE, code: STARTUP_MAINTENANCE_RUNNING_CODE })).toBe(STARTUP_MAINTENANCE_RUNNING_MESSAGE);
  expect(applyRejectionNotice({ code: STARTUP_MAINTENANCE_RUNNING_CODE })).toBe(STARTUP_MAINTENANCE_RUNNING_MESSAGE);
  expect(applyRejectionNotice({ error: BOOTSTRAP_BUSY_MESSAGE })).toBe(BOOTSTRAP_BUSY_MESSAGE + LEGACY_HINT);
  expect(applyRejectionNotice({ error: NOT_READY_MESSAGE })).toBe(NOT_READY_MESSAGE);
  expect(applyRejectionNotice(null)).toBe('Update could not be started.');
  expect(STARTUP_MAINTENANCE_RUNNING_MESSAGE).not.toMatch(/[^\x20-\x7E]/);
});

test('409 startup_maintenance_running shows the startup notice verbatim and leaves Update enabled without retrying', async ({ page }) => {
  const result = await clickUpdateAndCollectAlert(page, {
    body: { error: STARTUP_MAINTENANCE_RUNNING_MESSAGE, code: STARTUP_MAINTENANCE_RUNNING_CODE, retryAfterSeconds: 60, status: availableStatus() },
  });
  expect(result.counts.confirms).toBe(1);
  expect(result.alert).toBe(STARTUP_MAINTENANCE_RUNNING_MESSAGE);
  await expectButtonReadyAgain(page);
  // No automatic retry loop: a single POST, even after the status refresh settles.
  await page.waitForTimeout(2500);
  expect(result.counts.apply).toBe(1);
});

test('legacy bootstrap busy text from an older server gets the startup hint as a suffix', async ({ page }) => {
  const result = await clickUpdateAndCollectAlert(page, { body: { error: BOOTSTRAP_BUSY_MESSAGE, status: availableStatus() } });
  expect(result.alert).toBe(BOOTSTRAP_BUSY_MESSAGE + LEGACY_HINT);
  await expectButtonReadyAgain(page);
  expect(result.counts.apply).toBe(1);
});

test('other 409 rejections are shown unchanged', async ({ page }) => {
  const result = await clickUpdateAndCollectAlert(page, { body: { error: NOT_READY_MESSAGE, status: availableStatus() } });
  expect(result.alert).toBe(NOT_READY_MESSAGE);
  await expectButtonReadyAgain(page);
  expect(result.counts.apply).toBe(1);
});
