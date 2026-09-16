import { test, expect } from './support/safe-test';
import type { ProjectData } from '../../app/types';
import { open, save, assignments, scenePanel, targets, readOnlyTargets, panel, close, tab, expectedTargets } from './support/scene-backlight-test-project';

test('Scene normal and bulk use the same By Scene groups as Switch and Command without assigning groups', async ({ page }, info) => {
  const state = await open(page);
  await save(page);
  const before = assignments(state.projects[0]);
  expect(before.find(v => v[0] === 't140-legacy')?.[1]).toBe('');
  const found: Record<string, string[]> = {};
  await scenePanel(page, false);
  found.scene = await targets(page);
  expect.soft(found.scene, 'normal Scene must omit fixed/Base and deduplicate buttons').toEqual(expectedTargets);
  await readOnlyTargets(panel(page));
  await panel(page).locator('select').selectOption('relax');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: info.outputPath(`scene-normal-${width}-masked.png`), fullPage: true, mask: [page.getByRole('textbox', { name: 'Tablet URL', exact: true })] });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await close(page);
  await scenePanel(page, true);
  found.bulk = await targets(page);
  expect.soft(found.bulk, 'bulk Scene must omit fixed/Base').toEqual(expectedTargets);
  await readOnlyTargets(panel(page));
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: info.outputPath(`scene-bulk-${width}-masked.png`), fullPage: true, mask: [page.getByRole('textbox', { name: 'Tablet URL', exact: true })] });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await panel(page).locator('select').selectOption('mood');
  await panel(page).getByRole('button', { name: 'Apply to 2 rows', exact: true }).click();
  await expect(panel(page)).toBeHidden();
  await save(page);
  expect.soft(assignments(state.projects[0])).toEqual(before);
  const room = (state.projects[0] as unknown as ProjectData).roomTypes[0];
  expect.soft(room.roomScenes.map(s => s.backlightCondition)).toEqual(['mood', 'mood']);
  expect.soft(room.roomScenes.map(s => s.settings[0].percentage)).toEqual(['37', '62']);
  await tab(page, 'Switch');
  await page.locator('.scene-area-chip').filter({ hasText: /^Palladiom$/ }).click();
  await page.locator('tbody tr').filter({ has: page.locator('.setting-status-button') }).first().locator('.setting-status-button').nth(1).click();
  found.switch = await targets(page); expect.soft(found.switch).toEqual(expectedTargets); await close(page);
  await tab(page, 'Command');
  await page.locator('tbody tr').filter({ has: page.locator('.setting-status-button') }).first().locator('.setting-status-button').first().click();
  found.command = await targets(page); expect.soft(found.command).toEqual(expectedTargets); await close(page);
  await info.attach('target-sets-and-protection', { body: JSON.stringify({ found, before, after: assignments(state.projects[0]), conditions: room.roomScenes.map(s => s.backlightCondition) }, null, 2), contentType: 'application/json' });
});

test('Backlight tab still changes whole groups and Scene explains the zero-target state', async ({ page }, info) => {
  const state = await open(page);
  await tab(page, 'Backlight');
  const rows = page.locator('tbody tr');
  for (const label of ['PD-BY', 'PD-LEGACY']) {
    const row = rows.filter({ hasText: label }).first();
    await row.locator('select:has(option[value="__byScene"])').selectOption('sleep');
  }
  await save(page);
  const afterFixed = assignments(state.projects[0]);
  expect(afterFixed.filter(v => ['t140-by-1', 't140-by-2', 't140-legacy'].includes(v[0])).every(v => v[1] === 'sleep')).toBeTruthy();
  for (const bulk of [false, true]) {
    await scenePanel(page, bulk);
    await expect.soft(panel(page).getByText('No By Scene Palladiom switches. Set By Scene on the Backlight tab.', { exact: true })).toBeVisible();
    expect.soft(await targets(page)).toEqual([]);
    await close(page);
  }
  await tab(page, 'Backlight');
  await rows.filter({ hasText: 'PD-BY' }).first().locator('select:has(option[value="__byScene"])').selectOption('__byScene');
  await save(page);
  const afterByScene = assignments(state.projects[0]);
  expect(afterByScene.filter(v => ['t140-by-1', 't140-by-2'].includes(v[0])).every(v => v[1] === '')).toBeTruthy();
  expect(afterByScene.find(v => v[0] === 't140-base')?.[1]).toBe('base');
  await scenePanel(page, false);
  expect.soft(await targets(page)).toEqual([expectedTargets[0]]);
  await info.attach('backlight-tab-assignments', { body: JSON.stringify({ afterFixed, afterByScene }, null, 2), contentType: 'application/json' });
});
