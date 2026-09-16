import { test, expect } from './support/safe-test';
import type { Page } from './support/safe-test';
import type { ProjectData } from '../../app/types';
import { open, save, scenePanel, panel, close, tab } from './support/scene-backlight-test-project';

type Surface = 'Scene normal' | 'Scene bulk' | 'Switch' | 'Command';
async function openCondition(page: Page, surface: Surface) {
  if (surface.startsWith('Scene')) return scenePanel(page, surface === 'Scene bulk');
  await tab(page, surface);
  if (surface === 'Switch') await page.locator('.scene-area-chip').filter({ hasText: /^Palladiom$/ }).click();
  const row = page.locator('tbody tr').filter({ has: page.locator('.setting-status-button') }).first();
  await row.locator('.setting-status-button').nth(surface === 'Switch' ? 1 : 0).click();
  await expect(panel(page)).toBeVisible();
}
function values(project: Record<string, unknown>, surface: Surface) {
  const room = (project as unknown as ProjectData).roomTypes[0];
  return surface.startsWith('Scene') ? room.roomScenes.slice(0, surface === 'Scene bulk' ? 2 : 1).map(s => s.backlightCondition)
    : room.switches.filter(s => s.id === (surface === 'Switch' ? 't140-by-1' : 't140-command')).map(s => s.backlightCondition);
}
async function applyClose(page: Page, surface: Surface) {
  if (surface === 'Scene bulk') await panel(page).getByRole('button', { name: 'Apply to 2 rows', exact: true }).click();
  else await close(page);
}

for (const surface of ['Scene normal', 'Scene bulk', 'Switch', 'Command'] as const) {
  test(`${surface}: Uneffected is selectable, persists empty string, and clear button remains equivalent`, async ({ page }, info) => {
    const state = await open(page);
    await openCondition(page, surface);
    const select = panel(page).locator('select');
    const options = await select.locator('option').evaluateAll(els => els.map(el => ({ value: (el as HTMLOptionElement).value, text: el.textContent, disabled: (el as HTMLOptionElement).disabled })));
    await info.attach('condition-options', { body: JSON.stringify({ surface, options }, null, 2), contentType: 'application/json' });
    await expect(select.locator('option[value=""]'), `${surface}: Uneffected must be enabled`).toBeEnabled();
    await select.selectOption('relax');
    await expect(panel(page).getByRole('button', { name: 'Uneffected', exact: true })).toBeVisible();
    await select.selectOption('');
    await expect(select).toHaveValue('');
    await expect(panel(page).getByRole('button', { name: 'Uneffected', exact: true })).toHaveCount(0);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: info.outputPath(`${surface.replace(' ', '-')}-${width}.png`), fullPage: true, mask: [page.getByRole('textbox', { name: 'Tablet URL', exact: true })] });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await applyClose(page, surface);
    await save(page);
    expect(values(state.projects[0], surface)).toEqual(surface === 'Scene bulk' ? ['', ''] : ['']);
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Scene', exact: true })).toBeVisible();
    await openCondition(page, surface);
    await expect(select).toHaveValue('');
    await select.selectOption('mood');
    await panel(page).getByRole('button', { name: 'Uneffected', exact: true }).click();
    await expect(select).toHaveValue('');
    await applyClose(page, surface);
    await save(page);
    expect(values(state.projects[0], surface)).toEqual(surface === 'Scene bulk' ? ['', ''] : ['']);
    const room = (state.projects[0] as unknown as ProjectData).roomTypes[0];
    expect(room.roomScenes.map(s => s.settings[0].percentage)).toEqual(['37', '62']);
    await info.attach('saved-empty-condition', { body: JSON.stringify({ surface, values: values(state.projects[0], surface), sceneValues: room.roomScenes.map(s => s.settings[0].percentage) }, null, 2), contentType: 'application/json' });
  });
}

test('All three tabs and Scene bulk have the same ordered condition labels and values', async ({ page }, info) => {
  await open(page);
  const sets: Record<string, Array<{ value: string; text: string | null }>> = {};
  for (const surface of ['Scene normal', 'Scene bulk', 'Switch', 'Command'] as const) {
    await openCondition(page, surface);
    sets[surface] = await panel(page).locator('select option').evaluateAll(els => els.map(el => ({ value: (el as HTMLOptionElement).value, text: el.textContent })));
    await close(page);
  }
  expect(sets['Scene normal'][0]).toEqual({ value: '', text: 'Uneffected' });
  expect(sets['Scene normal'].length).toBeGreaterThan(1);
  for (const list of Object.values(sets)) expect(list).toEqual(sets['Scene normal']);
  await info.attach('ordered-condition-sets', { body: JSON.stringify(sets, null, 2), contentType: 'application/json' });
});
