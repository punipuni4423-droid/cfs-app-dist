import { test, expect, type Page } from './support/safe-test';
import { writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { createNewProject } from '../../app/lib/storage';
import { createEmptyCircuitEntry, createNewRoomType } from '../../app/lib/constants';
import { installLocalEditingMocks } from './support/secure-sharing-mock';

const remarks = [{ id: 'note1', title: 'Reference', body: 'First\nSecond', hasTable: true, columns: ['Trigger', 'Action'], rows: [['Alpha\nBeta\nGamma', 'Output'], ['Next', 'Value']] }, { id: 'note2', title: 'Second note', body: 'Keep order', hasTable: false, columns: [], rows: [] }];
const check = expect.configure({ timeout: 1000 });

async function openProject(page: Page, names = ['RT-A'], readOnly = false, withCircuits = false) {
  const state = await installLocalEditingMocks(page);
  const circuits = withCircuits ? ['1', '2'].map(number => ({ ...createEmptyCircuitEntry(number), dimmingType: 'PWM' })) : [];
  const project = { ...createNewProject('T117 Synthetic'), circuits, remarks: structuredClone(remarks), roomTypes: names.map(name => ({ ...createNewRoomType(name), circuitIds: circuits.map(circuit => circuit.id) })) };
  state.projects = [project];
  if (readOnly) await page.context().route('**/api/collaboration/status**', route => route.fulfill({ json: { enabled: true, mode: 'view', projectId: project.id, lock: null, locks: [], lastUpdatedBy: null, leaseSeconds: 90, heartbeatMs: 20000, idleMs: 900000 } }));
  await page.goto('/');
  await page.locator('button.screen-card').filter({ hasText: 'T117 Synthetic' }).click();
  await expect(page.getByRole('tab', { name: 'Remarks', exact: true }).first()).toBeVisible();
  return { state, project };
}

async function openRoom(page: Page, tab: string) {
  await page.getByRole('tab', { name: 'Room Type', exact: true }).click();
  await page.locator('button.screen-card').filter({ hasText: 'RT-A' }).click();
  await page.getByRole('tab', { name: tab, exact: true }).click();
}

test('R07 Hide Reserved distinguishes filtered empty and reveals added device', async ({ page }, info) => {
  await openProject(page);
  await openRoom(page, 'Device Assign');
  await expect(page.getByText('No devices are registered yet. Add a device below.')).toBeVisible();
  await page.getByRole('button', { name: 'Hide Reserved', exact: true }).click();
  await page.getByRole('button', { name: '+ Add Device', exact: true }).click();
  await page.getByRole('button', { name: /QSN-4P20-D/ }).click();
  await page.screenshot({ path: info.outputPath('r07-after-add.png'), fullPage: true });
  await expect.soft(page.getByText('No devices are registered yet. Add a device below.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Hide Reserved', exact: true })).toBeVisible();
  await expect(page.locator('tbody tr').filter({ hasText: 'QSN-4P20-D' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Hide Reserved', exact: true }).click();
  await expect(page.getByText('No devices match the current filters. Show Reserved or switch the device tab.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('r07-filtered-empty.png'), fullPage: true });
  await page.getByRole('button', { name: 'Show Reserved', exact: true }).click();
  await expect(page.locator('tbody tr').filter({ hasText: 'QSN-4P20-D' }).first()).toBeVisible();
});

test('R08 device dialog focuses, traps Tab and restores opener for each close path', async ({ page }, info) => {
  await openProject(page);
  await openRoom(page, 'Device Assign');
  const opener = page.getByRole('button', { name: '+ Add Device', exact: true });
  for (const close of ['escape', 'cancel', 'backdrop', 'select']) {
    await opener.click();
    const panel = page.locator('.card.card-padded').filter({ has: page.getByRole('heading', { name: 'Select Device' }) }).last();
    await check.soft(panel).toHaveAttribute('role', 'dialog');
    await check.soft(panel).toHaveAttribute('aria-modal', 'true');
    const first = panel.getByRole('button').first();
    await check.soft(first).toBeFocused();
    await first.focus();
    await page.keyboard.press('Shift+Tab');
    await check.soft(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await check.soft(first).toBeFocused();
    if (close === 'escape') await page.keyboard.press('Escape');
    if (close === 'cancel') await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    if (close === 'backdrop') await page.mouse.click(5, 5);
    if (close === 'select') await first.click();
    await expect(panel).toHaveCount(0);
    await check.soft(opener).toBeFocused();
  }
  await opener.click();
  await expect(page.getByRole('dialog', { name: 'Select Device' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('r08-dialog.png'), fullPage: true });
});

test('R09 multiline native editing and Ctrl-arrow cell movement', async ({ page }, info) => {
  await openProject(page);
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  const cell = page.getByLabel('Remark 1 row 1 column 1', { exact: true });
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
    await cell.focus();
    await cell.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(8, 8));
    await page.keyboard.press(key);
    await check.soft(cell, key + ' must retain textarea focus').toBeFocused();
  }
  await cell.focus();
  await cell.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(8, 8));
  await page.keyboard.press('Home');
  expect.soft(await cell.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(6);
  await page.keyboard.press('End');
  expect.soft(await cell.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(10);
  await page.keyboard.press('Control+ArrowRight');
  await expect(page.getByLabel('Remark 1 row 1 column 2', { exact: true })).toBeFocused();
  await page.keyboard.press('Control+ArrowDown');
  await expect(page.getByLabel('Remark 1 row 2 column 2', { exact: true })).toBeFocused();
  await page.keyboard.press('Control+ArrowLeft');
  await expect(page.getByLabel('Remark 1 row 2 column 1', { exact: true })).toBeFocused();
  await page.keyboard.press('Control+ArrowUp');
  await expect(cell).toBeFocused();
  await page.screenshot({ path: info.outputPath('r09-multiline.png'), fullPage: true });
});

test('R10 all-room actual workbook accepts boundary names without changing RoomType names', async ({ page }, info) => {
  const names = ['RT-A', 'History', 'history', "'Quoted'", 'A'.repeat(30) + "'tail", 'A'.repeat(31), 'a'.repeat(31), '[]:*?/\\', 'Remarks', 'remarks', "'''", "O'Brien", '   '];
  const { project } = await openProject(page, names);
  await openRoom(page, 'CFS');
  const dialogs: string[] = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await page.getByRole('button', { name: 'Excel Export', exact: true }).click();
  const download = page.waitForEvent('download', { timeout: 20000 });
  await page.getByRole('menuitem', { name: 'All Rooms', exact: true }).click();
  const file = info.outputPath('boundary-names.xlsx');
  await (await download).saveAs(file);
  expect(dialogs).toEqual([]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  expect(workbook.worksheets).toHaveLength(names.length + 1);
  const actualNames = workbook.worksheets.map(sheet => sheet.name);
  expect(new Set(actualNames.map(name => name.toLowerCase())).size).toBe(actualNames.length);
  for (const sheet of workbook.worksheets) {
    expect(sheet.name.length).toBeGreaterThan(0);
    expect(sheet.name.length).toBeLessThanOrEqual(31);
    expect(sheet.name).not.toMatch(/^[']|[']$|[\[\]:*?/\\]/);
    expect(sheet.name.toLowerCase()).not.toBe('history');
    expect(sheet.rowCount).toBeGreaterThan(0);
  }
  expect(actualNames).toContain("O'Brien");
  expect(workbook.worksheets.at(-1)?.getCell('A1').value).toBeTruthy();
  await writeFile(info.outputPath('workbook-inspection.json'), JSON.stringify({ requestedNames: names, actualNames, sheets: workbook.worksheets.map(sheet => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount, firstRows: sheet.getSheetValues().slice(0, 6) })) }, null, 2));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cfs-projects-v14') || '[]'));
  expect(saved.find((p: { id: string }) => p.id === project.id).roomTypes.map((r: { name: string }) => r.name)).toEqual(names);
});

test('R09 preserves existing single-line, select and checkbox key behavior', async ({ page }) => {
  await openProject(page, ['RT-A'], false, true);
  await page.getByRole('tab', { name: 'Area', exact: true }).click();
  const rows = page.locator('tbody tr');
  const firstName = rows.nth(0).locator('input').first();
  const secondName = rows.nth(1).locator('input').first();
  await firstName.focus();
  await firstName.evaluate((el: HTMLInputElement) => el.setSelectionRange(2, 2));
  await page.keyboard.press('ArrowLeft');
  await expect(firstName).toBeFocused();
  expect(await firstName.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(1);
  await page.keyboard.press('ArrowDown');
  await expect(secondName).toBeFocused();
  await page.keyboard.press('End');
  await expect(rows.nth(1).locator('input').nth(1)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(secondName).toBeFocused();
  const color = rows.nth(0).locator('select');
  await color.selectOption('');
  const nextColor = await color.locator('option').nth(1).getAttribute('value');
  await color.focus();
  await page.keyboard.press('ArrowDown');
  await expect(color).toBeFocused();
  await expect(color).toHaveValue(nextColor!);
  await openRoom(page, 'Circuit');
  const ffe = page.getByRole('checkbox', { name: 'FFE', exact: true });
  await ffe.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  await expect(ffe.nth(1)).toBeFocused();
  await expect(ffe.nth(1)).not.toBeChecked();
  await page.keyboard.press('ArrowRight');
  // Existing checkbox horizontal movement is explicit Ctrl+arrow.
  await expect(ffe.nth(1)).toBeFocused();
  await page.keyboard.press('Control+ArrowRight');
  const energy = page.getByRole('checkbox', { name: 'Energy Save', exact: true }).nth(1);
  await expect(energy).toBeFocused();
  await page.keyboard.press('Space');
  await expect(energy).toBeChecked();
});

test('R11 View permissions disable all Remarks mutations while preview and export remain usable', async ({ page }, info) => {
  const { state } = await openProject(page, ['RT-A'], true);
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  const view = page.getByTestId('remarks-view');
  for (const input of await view.locator('input:not([type=checkbox]), textarea').all()) await check.soft(input).toHaveAttribute('readonly', '');
  for (const button of await view.getByRole('button').all()) {
    if ((await button.innerText()).includes('Excel Export')) continue;
    await check.soft(button).toBeDisabled();
  }
  await check.soft(view.getByRole('checkbox').first()).toBeDisabled();
  for (const handle of await view.locator('.drag-handle').all()) await check.soft(handle).toHaveAttribute('draggable', 'false');
  await page.screenshot({ path: info.outputPath('r11-view-disabled.png'), fullPage: true });
  await view.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(view.locator('.remarks-preview-note')).toHaveCount(2);
  const download = page.waitForEvent('download');
  await view.getByRole('button', { name: 'Excel Export', exact: true }).click();
  const file = info.outputPath('view-remarks.xlsx');
  await (await download).saveAs(file);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  expect(workbook.getWorksheet('Remarks')).toBeTruthy();
  expect(state.projects[0].remarks).toEqual(remarks);
});
