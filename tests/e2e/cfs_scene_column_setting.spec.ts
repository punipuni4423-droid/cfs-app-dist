import { test, expect, type Page } from './support/safe-test';
import { seed, save } from './support/scene-backlight-test-project';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { readNativeDraftProject } from './support/native-project-drafts';
import type { ProjectData } from '../../app/types';

function projectFixture(): ProjectData {
  const project = seed();
  project.id = 't148-project'; project.name = 'T148 Synthetic Project';
  const room = project.roomTypes[0]; room.id = 't148-room'; room.name = 'T148 Room';
  const first = project.circuits[0];
  project.circuits.push({ ...first, id: 't148-group-member', detail: 'Group member' });
  project.locations.push({ id: 't148-area-two', name: 'Vanity', number: '2', code: 'VA', color: '#eeeeee' });
  project.circuits.push({ ...first, id: 't148-light-two', circuitGroupId: 't148-group-two', designerNumber: 'T148-L2', internalNumber: 'T148-L2', area: 't148-area-two', detail: 'Vanity Light' });
  room.circuitIds = project.circuits.map(c => c.id);
  room.deviceAssignments.push({ ...room.deviceAssignments[0], id: 't148-assignment-two', zoneAddress: 'Z2', circuitNumber: 'T148-L2' });
  room.scenes = [
    { id: 't148-bright', name: 'Bright', areaId: first.area, settings: [first.id, 't148-group-member'].map(circuitId => ({ circuitId, percentage: '80' })) },
    { id: 't148-dim', name: 'Dim', areaId: first.area, settings: [first.id, 't148-group-member'].map(circuitId => ({ circuitId, percentage: '20' })) },
    { id: 't148-max', name: 'MAX', areaId: 't148-area-two', settings: [{ circuitId: 't148-light-two', percentage: '100' }] },
  ];
  for (const scene of room.roomScenes) { scene.settings = []; scene.areaSceneSelections = []; scene.backlightCondition = ''; }
  return project;
}

async function navigateCfs(page: Page) {
  const back = page.getByRole('button', { name: /Back to Project List/i }).first();
  const projectCard = page.locator('button.screen-card').filter({ hasText: 'T148 Synthetic Project' });
  await expect(back.or(projectCard).first()).toBeVisible();
  if (await back.isVisible()) await back.click();
  await projectCard.click();
  const edit = page.getByRole('button', { name: 'Start editing', exact: true });
  if (await edit.isVisible()) await edit.click();
  await page.getByRole('tab', { name: 'Room Type', exact: true }).click();
  const card = page.locator('button.screen-card').filter({ hasText: 'T148 Room' }).first();
  if (await card.isVisible()) await card.click();
  else await page.getByRole('tab', { name: 'T148 Room', exact: true }).click();
  await page.getByRole('tab', { name: 'CFS', exact: true }).click();
  const toggle = page.getByRole('button', { name: 'Edit', exact: true });
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
  await page.getByRole('button', { name: 'Base Columns', exact: true }).click();
  await page.locator('.cfs-filter-list-portal').getByRole('button', { name: 'Hide all', exact: true }).click();
  await page.keyboard.press('Escape');
}

async function setup(page: Page, project = projectFixture()) {
  const state = await installLocalEditingMocks(page);
  state.projects = [project as unknown as Record<string, unknown>];
  await page.goto('/');
  const user = page.getByRole('button', { name: /^User:/ });
  if (await user.isVisible()) {
    await user.click(); await page.getByPlaceholder('e.g. Okada').fill('T148 Synthetic Tester');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
  }
  await navigateCfs(page);
  return { state, project };
}

const panel = (page: Page) => page.locator('.setting-overlay-panel');
async function openArrival(page: Page) {
  await page.getByRole('button', { name: /Open Scene Setting Overlay for.*T140 Arrival/i }).click();
  await expect(panel(page).locator('.switch-scene-table')).toBeVisible();
}
async function close(page: Page) { await panel(page).getByRole('button', { name: 'Close', exact: true }).click(); }
async function roomDraft(page: Page) { return (await readNativeDraftProject(page, 't148-project'))?.roomTypes[0]; }

test('unselected Scene opens shared values; per-area Clear and grouped overrides persist without changing definitions', async ({ page }) => {
  const { state, project } = await setup(page);
  const definitions = structuredClone(project.roomTypes[0].scenes);
  await openArrival(page);
  await expect(panel(page).locator('.switch-scene-table select')).toHaveCount(2);
  const first = panel(page).locator('.switch-scene-table tbody tr').filter({ hasText: 'T140 Area' });
  const second = panel(page).locator('.switch-scene-table tbody tr').filter({ hasText: 'Vanity' });
  await first.locator('select').selectOption('t148-bright');
  await second.locator('select').selectOption('t148-max');
  await first.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(second.locator('select')).toHaveValue('t148-max');
  await first.locator('select').selectOption('t148-dim');
  const area = panel(page).locator('.switch-area-panel').filter({ hasText: 'T140 Area' });
  if (await area.locator('.switch-area-toggle').getAttribute('aria-expanded') !== 'true') await area.locator('.switch-area-toggle').click();
  await area.locator('.switch-individual-table .scene-level-input').fill('42');
  await expect.poll(async () => (await roomDraft(page))?.roomScenes[0].settings.map(s => [s.circuitId, s.percentage]).sort()).toEqual([['t140-light', '42'], ['t148-group-member', '42']]);
  await area.getByRole('button', { name: 'Uneffected', exact: true }).last().click();
  await expect.poll(async () => (await roomDraft(page))?.roomScenes[0].settings).toEqual([]);
  await area.locator('.switch-individual-table .scene-level-input').fill('42');
  await close(page); await save(page);
  expect((state.projects[0] as unknown as ProjectData).roomTypes[0].scenes).toEqual(definitions);
  expect((state.projects[0] as unknown as ProjectData).roomTypes[0].roomScenes.map(s => s.id)).toEqual(project.roomTypes[0].roomScenes.map(s => s.id));
  await page.reload(); await navigateCfs(page); await openArrival(page);
  await expect(first.locator('select')).toHaveValue('t148-dim');
  await expect(second.locator('select')).toHaveValue('t148-max');
  await expect(area.locator('.switch-individual-table .scene-level-input')).toHaveValue('42');
});

test('Scene Backlight is read-only By Scene targets and editable linked condition shared with the Scene tab', async ({ page }) => {
  const project = projectFixture();
  project.roomTypes[0].roomScenes.forEach(s => { s.settingLinkGroupId = 't148-link'; });
  const { state } = await setup(page, project);
  const assignments = project.roomTypes[0].switches.map(s => [s.id, s.backlightAssignment === '__byScene' ? '' : s.backlightAssignment]);
  await openArrival(page);
  await panel(page).getByRole('button', { name: 'Backlight', exact: true }).click();
  await expect(panel(page).locator('.switch-target-list input')).toHaveCount(0);
  await expect(panel(page).locator('.switch-target-option')).toHaveCount(2);
  await panel(page).locator('select').selectOption('mood');
  await expect.poll(async () => (await roomDraft(page))?.roomScenes.map(s => s.backlightCondition)).toEqual(['mood', 'mood']);
  await close(page);
  await page.getByRole('tab', { name: 'Scene', exact: true }).click();
  await page.locator('.room-scene-pms-table tbody tr').first().locator('.setting-status-button').nth(1).click();
  await expect(panel(page).locator('select')).toHaveValue('mood');
  await panel(page).locator('select').selectOption('');
  await close(page); await save(page);
  const saved = (state.projects[0] as unknown as ProjectData).roomTypes[0];
  expect(saved.roomScenes.map(s => s.backlightCondition)).toEqual(['', '']);
  expect(saved.switches.map(s => [s.id, s.backlightAssignment])).toEqual(assignments);
});

test('Scene columns sharing one Area Scene still open their own RoomScene and preserve the secondary definitions entry', async ({ page }) => {
  const project = projectFixture();
  project.roomTypes[0].roomScenes.forEach(s => { s.areaSceneSelections = [{ areaId: 't140-area', sceneId: 't148-bright' }]; });
  await setup(page, project);
  await openArrival(page);
  await panel(page).getByRole('button', { name: 'Edit Area Scene definitions', exact: true }).click();
  await expect(panel(page)).toContainText('Area Scene Setting / Bright');
  await close(page);
  await page.getByRole('button', { name: /Open Scene Setting Overlay for.*T140 Departure/i }).click();
  await expect(panel(page).locator('.setting-overlay-header strong')).toContainText('T140 Departure');
  await panel(page).locator('.switch-scene-table select').first().selectOption('t148-dim');
  await expect.poll(async () => (await roomDraft(page))?.roomScenes.map(s => s.areaSceneSelections?.[0]?.sceneId)).toEqual(['t148-bright', 't148-dim']);
});

for (const width of [390, 1280]) test(`shared Scene overlay is usable at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await setup(page); await openArrival(page);
  for (const tab of ['Scene Value', 'Backlight']) {
    await panel(page).getByRole('button', { name: tab, exact: true }).click();
    if (tab === 'Scene Value') {
      await panel(page).locator('.switch-scene-table select').first().selectOption('t148-bright');
      await panel(page).locator('.switch-area-toggle').first().click();
      await expect(panel(page).locator('.switch-individual-table')).toBeVisible();
    }
    const metrics = await panel(page).evaluate(el => {
      const p = el.getBoundingClientRect();
      const controls = Array.from(el.querySelectorAll('.setting-overlay-actions button')).map(b => b.getBoundingClientRect());
      return { left: p.left, right: p.right, width: innerWidth, clipped: controls.some(b => b.left < p.left || b.right > p.right), overlaps: controls.some((a, i) => controls.slice(i + 1).some(b => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)) };
    });
    expect(metrics.left).toBeGreaterThanOrEqual(0); expect(metrics.right).toBeLessThanOrEqual(width);
    expect(metrics.clipped).toBe(false); expect(metrics.overlaps).toBe(false);
    await page.screenshot({ path: info.outputPath(`scene-${tab.replaceAll(' ', '-')}-${width}.png`), fullPage: false });
    if (tab === 'Scene Value') {
      const override = panel(page).locator('.switch-individual-table .scene-level-input');
      await override.scrollIntoViewIfNeeded();
      await override.fill('42');
      await expect.poll(async () => (await roomDraft(page))?.roomScenes[0].settings.map(s => s.percentage)).toEqual(['42', '42']);
      await page.screenshot({ path: info.outputPath(`scene-override-${width}.png`), fullPage: false });
    }
  }
  await close(page); await expect(panel(page)).toHaveCount(0);
});
