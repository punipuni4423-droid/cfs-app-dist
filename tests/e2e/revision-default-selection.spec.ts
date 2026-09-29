import { test, expect, type Page } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import type { ProjectData } from '../../app/types';

const openRevision = async (page: Page) => {
  await page.getByRole('button', { name: 'Save all room types as new revisions' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save Revision', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
};

test('revision defaults follow room snapshot changes before and after Current save, revert and reopen', async ({ page }, testInfo) => {
  const state = await installLocalEditingMocks(page);
  const saved = () => state.projects[0] as unknown as ProjectData;
  const posts: Array<{ project: ProjectData }> = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/projects' && request.method() === 'POST') {
      const data = request.postDataJSON();
      if (data.project) posts.push(data);
    }
  });
  await page.goto('/');
  await page.getByPlaceholder('New project name').fill('Synthetic revision defaults');
  await page.getByRole('button', { name: 'Create Project', exact: true }).click();
  for (const name of ['Changed room', 'Unchanged room']) {
    await page.getByRole('tab', { name: 'Room Type', exact: true }).click();
    const manage = page.getByRole('tab', { name: '+ Manage', exact: true });
    if (await manage.isVisible()) await manage.click();
    await page.getByPlaceholder('New room type name').fill(name);
    await page.getByRole('button', { name: 'Create Room Type', exact: true }).click();
  }
  await page.getByRole('tab', { name: 'Changed room', exact: true }).click();
  await page.getByRole('tab', { name: 'Circuit', exact: true }).click();
  await page.locator('.btn-add-row').filter({ hasText: /Add Row/ }).first().click();
  const designer = page.locator('.circuits-table tbody tr').last().locator('.device-cell textarea').first();
  await designer.fill('BASE-CIRCUIT');
  let dialog = await openRevision(page);
  await expect(dialog.getByLabel('Save revision for Changed room', { exact: true })).toBeChecked();
  await expect(dialog.getByLabel('Save revision for Unchanged room', { exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Save Revision', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => saved().roomTypes.map(room => room.revisions.length)).toEqual([1, 1]);
  const initialRooms = structuredClone(saved().roomTypes);
  const initialCommonCount = saved().commonRevisions?.length ?? 0;

  dialog = await openRevision(page);
  await expect(dialog.locator('.revision-batch-summary')).toContainText('0 / 2 room types selected');
  await expect(dialog.getByRole('button', { name: 'Save Revision', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('unchanged-defaults.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  await designer.fill('EDITED-CIRCUIT');
  dialog = await openRevision(page);
  await expect(dialog.getByLabel('Save revision for Changed room', { exact: true })).toBeChecked();
  await expect(dialog.getByLabel('Save revision for Unchanged room', { exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Save Revision', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  dialog = await openRevision(page);
  await expect(dialog.getByLabel('Save revision for Changed room', { exact: true })).toBeChecked();
  await expect(dialog.getByLabel('Save revision for Unchanged room', { exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('button', { name: 'Save current project without a new revision' }).click();
  await expect(page.locator('.revision-save-status-label')).toHaveText('Saved');
  expect(saved().circuits.some(circuit => circuit.designerNumber === 'EDITED-CIRCUIT')).toBe(true);
  expect(saved().roomTypes.map(room => room.revisions)).toEqual(initialRooms.map(room => room.revisions));
  expect(saved().roomTypes.map(room => room.revision)).toEqual(initialRooms.map(room => room.revision));
  dialog = await openRevision(page);
  await expect(dialog.getByLabel('Save revision for Changed room', { exact: true })).toBeChecked();
  await expect(dialog.getByLabel('Save revision for Unchanged room', { exact: true })).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('changed-after-current-save.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  await designer.fill('BASE-CIRCUIT');
  dialog = await openRevision(page);
  await expect(dialog.locator('.revision-batch-summary')).toContainText('0 / 2 room types selected');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await designer.fill('EDITED-CIRCUIT');
  dialog = await openRevision(page);
  await expect(dialog.locator('.revision-batch-summary')).toContainText('1 / 2 room types selected');
  await dialog.getByRole('button', { name: 'Save Revision', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(saved().roomTypes.map(room => room.revisions.length)).toEqual([2, 1]);
  expect(saved().roomTypes[0].revisions[0]).toEqual(initialRooms[0].revisions[0]);
  expect(saved().roomTypes[1]).toEqual(initialRooms[1]);
  expect(saved().roomTypes[0].revision).not.toBe(initialRooms[0].revision);
  expect(saved().roomTypes[1].revision).toBe(initialRooms[1].revision);

  dialog = await openRevision(page);
  await expect(dialog.locator('.revision-batch-summary')).toContainText('0 / 2 room types selected');
  await dialog.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(dialog.locator('.revision-batch-summary')).toContainText('2 / 2 room types selected');
  await dialog.getByLabel('Save revision for Changed room', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Save Revision', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(saved().roomTypes.map(room => room.revisions.length)).toEqual([2, 2]);

  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  await page.getByRole('button', { name: 'Add Remark', exact: true }).click();
  await page.getByLabel('Title for remark 1', { exact: true }).fill('Common-only change');
  await page.getByRole('button', { name: 'Save current project without a new revision' }).click();
  await expect(page.locator('.revision-save-status-label')).toHaveText('Saved');
  expect(saved().commonRevisions?.length).toBe(initialCommonCount);
  const beforeCommon = structuredClone(saved().roomTypes);
  dialog = await openRevision(page);
  await expect(dialog.locator('.revision-batch-summary')).toContainText('0 / 2 room types selected');
  await expect(dialog.getByRole('button', { name: 'Save Revision', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('common-only-save.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Save Revision', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(saved().roomTypes).toEqual(beforeCommon);
  expect(saved().commonRevisions?.length).toBe(initialCommonCount + 1);
  expect(saved().remarks?.[0].title).toBe('Common-only change');
  dialog = await openRevision(page);
  await expect(dialog.locator('.revision-batch-summary')).toContainText('0 / 2 room types selected');
  await expect(dialog.getByRole('button', { name: 'Save Revision', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.reload();
  const projectCard = page.locator('button.screen-card').filter({ hasText: 'Synthetic revision defaults' });
  if (await projectCard.isVisible()) await projectCard.click();
  await expect(page.locator('.revision-save-status-label')).toHaveText('Saved');
  dialog = await openRevision(page);
  await expect(dialog.locator('.revision-batch-summary')).toContainText('0 / 2 room types selected');
  await expect(dialog.getByRole('button', { name: 'Save Revision', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('saved-reload-defaults.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await testInfo.attach('synthetic-save-requests', { body: JSON.stringify(posts, null, 2), contentType: 'application/json' });
  await testInfo.attach('synthetic-final-project', { body: JSON.stringify(saved(), null, 2), contentType: 'application/json' });
});
