/**
 * T-121 App version badge: the running build identifier is shown on the project
 * list and inside the project toolbar, can be copied, and is never presented as
 * a Room Type revision. Build metadata is read server-side from
 * .cfs-build-info.json next to the app folder, so no API call is involved.
 */
import { test, expect, type Page } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { createNewRoomType } from '../../app/lib/constants';
import type { ProjectData } from '../../app/types';
import {
  APP_VERSION_COMPACT_SHA_LENGTH,
  APP_VERSION_UNKNOWN_LABEL,
  appVersionCopyText,
  appVersionTitle,
  formatAppVersionLabel,
  isAppBuildVersion,
  splitAppVersionLabel,
} from '../../app/lib/appBuildVersion';

const PROJECT_NAME = `T121-Version-${Date.now()}`;
const SHA_OR_UNKNOWN = /^(v[1-9]\d\.([1-9]|1[0-2])\.[1-9]\d*|[0-9a-f]{7,12}|Version unknown)$/;
// T-138 (V86-F01): the fixed project-list toolbar must never reach the heading.
const LAYOUT_WIDTHS = [390, 1024, 1280, 1440, 1536, 1920] as const;
const LAYOUT_HEIGHTS: Record<number, number> = { 390: 844, 1024: 768, 1280: 900, 1440: 900, 1920: 1080 };
const LONG_UPDATE_MESSAGE = 'Git repository was not found. Launch CFS from the latest extracted Git-managed folder.';
// T-139: with a real shared-mode compact bar (role pill, status, message,
// e-mail chip, three actions) beside the full history controls (room revision
// pill, save status, ten icon buttons, App badge, Hide top bar) the project
// toolbar must stay on ONE row at laptop and desktop widths. 1536 is a 1920
// monitor at 125% scaling.
const ROW_WIDTHS = [1366, 1440, 1536, 1600, 1680, 1920] as const;
const COMPACT_BADGE_MAX_WIDTH = 1680;
const SHARED_EMAIL = 'lead-pm@example-cfs.jp';
const LONG_ROOM_TYPE_NAME = 'Deluxe Twin Garden View';
const SHARED_PROJECT_NAME = 'T139 Shared Layout';

type MockState = Awaited<ReturnType<typeof installLocalEditingMocks>>;
let mockState: MockState;

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.c2ln`;
}

function sharedLayoutProject(): ProjectData {
  const roomType = createNewRoomType(LONG_ROOM_TYPE_NAME);
  roomType.revision = '1.02';
  return {
    id: 't139-shared-layout',
    name: SHARED_PROJECT_NAME,
    updatedAt: '2026-09-16T00:00:00.000Z',
    locations: [],
    fixtures: [],
    circuits: [],
    roomTypes: [roomType],
  };
}

/**
 * Secure-sharing shape from secure-auth.spec.ts: a signed-in Admin whose
 * display name is the e-mail address, either holding the edit lock (edit) or
 * viewing while another user holds the lock and has saved newer data (view:
 * "Locked", lock message, refresh notice, Wait + Force-release actions).
 */
async function installSharedModeMocks(page: Page, mode: 'edit' | 'view'): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const membership = {
    id: 't139-member', email: SHARED_EMAIL, displayName: SHARED_EMAIL, role: 'admin', active: true,
    createdAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-16T00:00:00.000Z',
  };
  const lock = {
    scopeId: 'cfs-projects',
    userId: mode === 'edit' ? 't139-user' : 't139-other',
    userName: mode === 'edit' ? SHARED_EMAIL : 'Another user',
    sessionId: mode === 'edit' ? 'synthetic-session' : 'other-session',
    acquiredAt: '2026-09-16T00:00:00.000Z', heartbeatAt: '2026-09-16T00:00:00.000Z', expiresAt: '2026-09-16T00:01:30.000Z',
  };
  const status = {
    enabled: true, mode, ownsLock: mode === 'edit', lock,
    lastUpdatedBy: mode === 'view' ? { userId: 't139-other', displayName: 'Another user', updatedAt: '2026-09-16T01:00:00.000Z' } : null,
    lastUpdatedAt: mode === 'view' ? '2026-09-16T01:00:00.000Z' : null,
    leaseSeconds: 90, heartbeatMs: 20_000, idleMs: 15 * 60 * 1000, membership, members: [],
  };
  const router = page.context();
  await router.route('**/api/sharing/config**', (route) => route.fulfill({
    json: { mode: 'supabase', url: 'https://demo.supabase.co', publishableKey: fakeJwt({ role: 'anon', exp: expiresAt }) },
  }));
  await router.route('https://demo.supabase.co/**', (route) => route.fulfill({
    json: { user: { id: 't139-user', email: SHARED_EMAIL, app_metadata: { provider: 'azure' }, user_metadata: {} } },
  }));
  await router.route('**/api/collaboration/auth', (route) => route.fulfill({ json: { membership } }));
  await router.route('**/api/collaboration/status**', (route) => route.fulfill({ json: status }));
  await router.route('**/api/collaboration/lock/heartbeat', (route) => route.fulfill({ json: { acquired: true, lock, status } }));
  return fakeJwt({ sub: 't139-user', email: SHARED_EMAIL, exp: expiresAt });
}

interface LayoutBox { name: string; x: number; y: number; right: number; bottom: number }
interface LayoutOverlap { a: string; b: string; width: number; height: number }
interface LayoutReport { overflow: number; boxes: LayoutBox[]; overlaps: LayoutOverlap[] }

/**
 * Bounding boxes of the App badge, the screen heading, every other control in
 * the same toolbar, the collaboration bar and the fixed settings gear, plus the
 * pairwise intersections between them (containers are only compared with the
 * heading, since they legitimately contain their own children).
 */
function collectLayout(screen: 'list' | 'project'): LayoutReport {
  const containers = new Set(['toolbar', 'collaboration-bar']);
  const boxes: LayoutBox[] = [];
  const addRect = (name: string, r: DOMRect): void => {
    if (r.width > 0 && r.height > 0) boxes.push({ name, x: r.x, y: r.y, right: r.right, bottom: r.bottom });
  };
  const add = (name: string, el: Element | null): void => {
    if (!el) return;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    addRect(name, el.getBoundingClientRect());
  };
  const label = (el: Element): string => el.getAttribute('data-testid') === 'app-version-badge'
    ? 'badge'
    : el.getAttribute('aria-label') || el.className.split(' ')[0] || el.tagName;
  if (screen === 'list') {
    const heading = document.querySelector('.project-selection-title');
    add('heading', heading);
    if (heading) {
      const range = document.createRange();
      range.selectNodeContents(heading);
      addRect('heading-text', range.getBoundingClientRect());
    }
    const toolbar = document.querySelector('.project-list-top-tools');
    add('toolbar', toolbar);
    for (const child of Array.from(toolbar?.children ?? [])) add(label(child), child);
    add('collaboration-bar', document.querySelector('.project-list-shell > .collaboration-bar'));
  } else {
    add('heading', document.querySelector('.project-top-breadcrumb'));
    const controls = document.querySelector('.history-controls');
    add('toolbar', controls);
    for (const child of Array.from(controls?.children ?? [])) {
      if (child.classList.contains('revision-top-controls')) {
        for (const inner of Array.from(child.children)) add(label(inner), inner);
      } else {
        add(label(child), child);
      }
    }
    add('collaboration-bar', document.querySelector('.project-top-action-groups > .collaboration-bar'));
  }
  add('settings-menu', document.querySelector('.settings-menu'));
  const comparable = (a: LayoutBox, b: LayoutBox): boolean => {
    const headings = [a, b].filter((box) => box.name.startsWith('heading')).length;
    if (headings === 2) return false;
    if (headings === 1) return true;
    return !containers.has(a.name) && !containers.has(b.name);
  };
  const overlaps: LayoutOverlap[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (!comparable(a, b)) continue;
      const width = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      if (width > 0 && height > 0) overlaps.push({ a: a.name, b: b.name, width, height });
    }
  }
  return { overflow: document.documentElement.scrollWidth - window.innerWidth, boxes, overlaps };
}

async function measureLayout(page: Page, screen: 'list' | 'project', width: number): Promise<LayoutReport> {
  await page.setViewportSize({ width, height: LAYOUT_HEIGHTS[width] ?? 900 });
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'), null, { timeout: 5000 }).catch(() => undefined);
  return page.evaluate(collectLayout, screen);
}

async function expectNoOverlap(page: Page, screen: 'list' | 'project', width: number): Promise<LayoutReport> {
  const report = await measureLayout(page, screen, width);
  const names = report.boxes.map((box) => box.name);
  expect(names, `${screen} ${width}px: badge and heading are measured`).toEqual(expect.arrayContaining(['badge', 'heading']));
  expect(report.overlaps, `${screen} ${width}px: no bounding-box intersection`).toEqual([]);
  expect(report.overflow, `${screen} ${width}px: no horizontal overflow`).toBeLessThanOrEqual(0);
  return report;
}

test.beforeEach(async ({ page }) => {
  mockState = await installLocalEditingMocks(page);
});

async function openProject(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  const nameInput = page.locator('input[placeholder="New project name"]').first();
  await expect(nameInput).toBeEnabled({ timeout: 10000 });
  await nameInput.fill(name);
  await page.getByRole('button', { name: 'Create Project' }).first().click();
  // Creating a project normally opens it; older flows return to the list, so
  // fall back to clicking the card only when the project screen did not open.
  const tablist = page.locator('[role="tablist"]').first();
  const opened = await tablist.isVisible({ timeout: 10000 }).catch(() => false)
    || await tablist.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  if (!opened) {
    await page.locator('button.screen-card').filter({ hasText: name }).first().click();
  }
  await expect(tablist).toBeVisible({ timeout: 10000 });
}

test('pure helpers: unknown metadata never guesses a version and copy text carries the full SHA', async () => {
  expect(formatAppVersionLabel(null)).toBe(APP_VERSION_UNKNOWN_LABEL);
  expect(appVersionCopyText(null)).toBe('');
  expect(appVersionTitle(null)).toContain('unknown');
  expect(isAppBuildVersion({ builtAt: '2026-09-15T00:00:00.000Z' })).toBe(false);
  expect(isAppBuildVersion({ gitSha: 'not a sha' })).toBe(false);
  const info = { gitSha: '4123e1a81a097a38cdb6415a9670373de2760b70', builtAt: '2026-09-15T03:00:00.000Z' };
  expect(isAppBuildVersion(info)).toBe(true);
  expect(formatAppVersionLabel(info)).toBe('4123e1a81a09');
  expect(appVersionCopyText(info)).toBe('CFS app build 4123e1a81a097a38cdb6415a9670373de2760b70 (built 2026-09-15T03:00:00.000Z)');
  expect(appVersionTitle(info)).not.toMatch(/revision/i);
  // T-139: the narrow-toolbar split always re-joins to the full label.
  const knownParts = splitAppVersionLabel(info);
  expect(knownParts).toEqual({ prefix: '', visible: '4123e1a', suffix: '81a09' });
  expect(knownParts.prefix + knownParts.visible + knownParts.suffix).toBe(formatAppVersionLabel(info));
  const unknownParts = splitAppVersionLabel(null);
  expect(unknownParts).toEqual({ prefix: 'Version ', visible: 'unknown', suffix: '' });
  expect(unknownParts.prefix + unknownParts.visible + unknownParts.suffix).toBe(APP_VERSION_UNKNOWN_LABEL);
});

test('project list shows the app version badge with a copy button', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const badge = page.getByTestId('app-version-badge').first();
  await expect(badge).toBeVisible();
  const value = (await page.getByTestId('app-version-value').first().textContent())?.trim() ?? '';
  expect(value).toMatch(SHA_OR_UNKNOWN);
  expect(value).not.toMatch(/revision/i);
  await expect(badge).toHaveAttribute('aria-label', `App version ${value}`);
  const copy = page.getByTestId('app-version-copy').first();
  if (value === APP_VERSION_UNKNOWN_LABEL) {
    await expect(copy).toBeDisabled();
    return;
  }
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(copy).toHaveAttribute('aria-label', 'Copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(value.startsWith('v') ? /^v[\d.]+ \([0-9a-f]{7,64}\)$/ : /^CFS app build [0-9a-f]{7,64}( \(built .+\))?$/);
  expect(copied).toContain(value);
  expect(copied).not.toMatch(/[A-Za-z]:\\|\\\\|\/[A-Za-z]/);
  await expect(copy).toHaveAttribute('aria-label', 'Copy app version', { timeout: 5000 });
});

test('project toolbar shows the same version next to (not inside) the revision pill', async ({ page }) => {
  await page.goto('/');
  const listValue = (await page.getByTestId('app-version-value').first().textContent())?.trim() ?? '';
  await openProject(page, PROJECT_NAME);
  const toolbar = page.locator('.history-controls');
  const badge = toolbar.getByTestId('app-version-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveClass(/is-compact/);
  await expect(toolbar.getByTestId('app-version-value')).toHaveText(listValue);
  await expect(badge.locator('.revision-save-status, .muted-pill')).toHaveCount(0);
  await expect(toolbar.locator('.revision-save-status')).toHaveCount(1);
  await expect(badge).not.toContainText(/revision/i);
});

test('badge, heading, and toolbar controls never overlap at 390-1920px on both screens', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  await expect(page.getByTestId('app-version-badge').first()).toBeVisible();
  await expect(page.locator('.app-update-button').first()).toHaveText('Latest');
  for (const width of LAYOUT_WIDTHS) {
    const report = await expectNoOverlap(page, 'list', width);
    if (width >= 1024) {
      // Wide layouts keep the fixed toolbar strictly right of the heading text.
      const heading = report.boxes.find((box) => box.name === 'heading-text');
      const toolbar = report.boxes.find((box) => box.name === 'toolbar');
      expect(toolbar!.x, `list ${width}px: toolbar starts right of the heading`).toBeGreaterThan(heading!.right);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await openProject(page, `${PROJECT_NAME}-layout`);
  for (const width of LAYOUT_WIDTHS) await expectNoOverlap(page, 'project', width);
});

test('project list keeps the badge clear of the heading even with a long update message', async ({ page }) => {
  // Same shape as the real "Git Setup Needed" status: the widest Update pill.
  await page.route('**/api/app-update/status**', (route) => route.fulfill({
    json: { enabled: true, state: 'not_configured', message: LONG_UPDATE_MESSAGE, ahead: 0, behind: 0, dirty: false, checkedAt: new Date().toISOString(), appDir: 'mock' },
  }));
  await page.goto('/');
  await expect(page.locator('.app-update-button').first()).toHaveText('Git Setup Needed');
  for (const width of LAYOUT_WIDTHS) {
    await expectNoOverlap(page, 'list', width);
    await expect(page.getByRole('button', { name: /^Copy$/ }).first(), `list ${width}px: Tablet URL copy stays visible`).toBeVisible();
  }
});

for (const mode of ['edit', 'view'] as const) {
  test(`project toolbar keeps one row at 1366-1920px with a shared-mode compact bar (${mode})`, async ({ page, context }, testInfo) => {
    test.setTimeout(120000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    mockState.projects = [{ ...sharedLayoutProject() }];
    const token = await installSharedModeMocks(page, mode);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await page.setViewportSize({ width: 1536, height: 900 });
    await page.goto(`/#access_token=${token}&refresh_token=fake-refresh&token_type=bearer&expires_at=${expiresAt}`);
    await expect(page).toHaveURL(/\/$/);
    await page.locator('button.screen-card').filter({ hasText: SHARED_PROJECT_NAME }).first().click();
    await expect(page.locator('[role="tablist"]').first()).toBeVisible({ timeout: 10000 });
    await page.getByRole('tab', { name: 'Room Type', exact: true }).click();
    await page.getByRole('tab', { name: LONG_ROOM_TYPE_NAME, exact: true }).click();

    // The real-data state the user reported (edit) and its widest viewing
    // counterpart: every optional element of the compact bar present.
    const bar = page.locator('.project-top-action-groups > .collaboration-bar.is-compact');
    await expect(bar).toContainText(mode === 'edit' ? 'Editing' : 'Admin');
    await expect(bar.locator('.collaboration-user-chip')).toHaveText(SHARED_EMAIL);
    await expect(bar.locator('.collaboration-actions .history-button')).toHaveCount(mode === 'edit' ? 3 : 4);
    await expect(bar.locator('.collaboration-message')).toHaveText(mode === 'edit' ? 'Editing resumed.' : /is editing/);
    if (mode === 'view') await expect(bar.locator('.collaboration-refresh-notice')).toBeVisible();
    const controls = page.locator('.history-controls');
    await expect(controls.locator('.revision-top-controls .muted-pill').first()).toContainText('Revision 1.02');
    await expect(controls.getByTestId('project-backup-download')).toBeVisible();
    const fullLabel = (await controls.getByTestId('app-version-value').textContent())?.trim() ?? '';
    const known = fullLabel !== APP_VERSION_UNKNOWN_LABEL;

    const rows: string[] = [];
    for (const width of ROW_WIDTHS) {
      // Soft expectations so the whole width table is reported in one run.
      const report = await measureLayout(page, 'project', width);
      expect.soft(report.overlaps, `${mode} ${width}px: no bounding-box intersection`).toEqual([]);
      expect.soft(report.overflow, `${mode} ${width}px: no horizontal overflow`).toBeLessThanOrEqual(0);
      const barBox = report.boxes.find((box) => box.name === 'collaboration-bar');
      const controlsBox = report.boxes.find((box) => box.name === 'toolbar');
      const badgeBox = report.boxes.find((box) => box.name === 'badge');
      const headingBox = report.boxes.find((box) => box.name === 'heading');
      expect(barBox && controlsBox && badgeBox && headingBox, `${mode} ${width}px: heading, bar, controls and badge are measured`).toBeTruthy();
      if (!barBox || !controlsBox || !badgeBox || !headingBox) continue;
      const visibleLabel = (await controls.getByTestId('app-version-value').innerText()).trim();
      rows.push(`${mode} ${width}px heading=[${headingBox.x.toFixed(1)}..${headingBox.right.toFixed(1)}]`
        + ` bar=[${barBox.x.toFixed(1)}..${barBox.right.toFixed(1)} y ${barBox.y.toFixed(1)}..${barBox.bottom.toFixed(1)}]`
        + ` controls=[${controlsBox.x.toFixed(1)}..${controlsBox.right.toFixed(1)} y ${controlsBox.y.toFixed(1)}..${controlsBox.bottom.toFixed(1)}]`
        + ` badge=[${badgeBox.x.toFixed(1)}..${badgeBox.right.toFixed(1)}] "${visibleLabel}" overlaps=${report.overlaps.length} overflow=${report.overflow}`);
      expect.soft(Math.abs(controlsBox.y - barBox.y), `${mode} ${width}px: history controls start on the collaboration bar's row`).toBeLessThanOrEqual(1);
      expect.soft(Math.abs(controlsBox.bottom - barBox.bottom), `${mode} ${width}px: both groups end on the same row`).toBeLessThanOrEqual(2);
      expect.soft(barBox.right, `${mode} ${width}px: collaboration bar ends before the history controls`).toBeLessThanOrEqual(controlsBox.x + 0.5);
      expect.soft(controlsBox.right, `${mode} ${width}px: history controls stay inside the viewport`).toBeLessThanOrEqual(width);
      // Narrow toolbars show the 7-character prefix (or "Unknown") without the "App" label.
      const narrowLabel = known ? (fullLabel.startsWith('v') ? fullLabel : fullLabel.slice(0, APP_VERSION_COMPACT_SHA_LENGTH)) : 'Unknown';
      expect.soft(visibleLabel, `${mode} ${width}px: visible build identifier`).toBe(width <= COMPACT_BADGE_MAX_WIDTH ? narrowLabel : fullLabel);
      await page.screenshot({ path: testInfo.outputPath(`${mode}-${width}.png`), animations: 'disabled' });
    }
    await testInfo.attach('toolbar-rows', { body: rows.join('\n'), contentType: 'text/plain' });
    for (const line of rows) console.log(`T139 ${line}`);

    // The full identifier stays available to assistive tech, the tooltip and the clipboard.
    const badge = controls.getByTestId('app-version-badge');
    await expect(badge).toHaveAttribute('aria-label', `App version ${fullLabel}`);
    if (known) {
      expect(fullLabel).toMatch(SHA_OR_UNKNOWN);
      expect(await badge.getAttribute('title')).toContain(fullLabel);
      await page.setViewportSize({ width: 1536, height: 900 });
      await controls.getByTestId('app-version-copy').click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toMatch(fullLabel.startsWith('v') ? /^v[\d.]+ \([0-9a-f]{40}\)$/ : /^CFS app build [0-9a-f]{40}( \(built .+\))?$/);
      expect(copied).toContain(fullLabel);
    }
  });
}

test('badge stays inside a 390px viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('app-version-badge').first()).toBeVisible();
  const listOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(listOverflow).toBeLessThanOrEqual(0);
  await openProject(page, `${PROJECT_NAME}-narrow`);
  await expect(page.locator('.history-controls').getByTestId('app-version-badge')).toBeVisible();
  const projectOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(projectOverflow).toBeLessThanOrEqual(0);
});

test('numbered package versions stay complete in compact labels and retain full SHA', () => {
  const gitSha = 'a731c72634f9a6374b464dac95fd9e2098a7af4a';
  for (const packageVersion of ['26.9.1', '26.10.12', '99.12.999']) {
    const info = { gitSha, packageVersion, builtAt: '2026-09-16T00:00:00.000Z' };
    expect(formatAppVersionLabel(info)).toBe(`v${packageVersion}`);
    expect(splitAppVersionLabel(info)).toEqual({ prefix: '', visible: `v${packageVersion}`, suffix: '' });
    expect(appVersionCopyText(info)).toBe(`v${packageVersion} (${gitSha})`);
    expect(appVersionTitle(info)).toContain(gitSha);
    expect(appVersionTitle(info)).toContain(`v${packageVersion}`);
  }
});

test('old and invalid package versions preserve legacy SHA fallback and unknown behavior', () => {
  const gitSha = 'a731c72634f9a6374b464dac95fd9e2098a7af4a';
  for (const packageVersion of ['0.1.0', '06.9.1', '26.0.1', '26.13.1', '26.09.1', '26.9.0', '26.9.01', '26.9.1-beta', 'v26.9.1', '26.9.9007199254740992']) {
    const info = { gitSha, packageVersion };
    expect(formatAppVersionLabel(info)).toBe(gitSha.slice(0, 12));
    expect(appVersionCopyText(info)).toBe(`CFS app build ${gitSha}`);
    expect(splitAppVersionLabel(info)).toEqual({ prefix: '', visible: gitSha.slice(0, 7), suffix: gitSha.slice(7, 12) });
  }
  expect(formatAppVersionLabel(null)).toBe('Version unknown');
  expect(appVersionCopyText(null)).toBe('');
});
