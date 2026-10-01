import { test, expect } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { expectOperationBlocksUi } from './support/database-operation';
import { createNewProject } from '../../app/lib/storage';
import type { ProjectData } from '../../app/types';

test('Current holds the modal through POST and confirmation GET; failures unlock recovery', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const project = createNewProject('Operation boundaries');
  project.remarks = [{ id: 'remark', title: 'Before', body: 'Original', hasTable: false, columns: [], rows: [] }];
  state.projects = [project] as unknown as Record<string, unknown>[];
  await page.goto('/');
  await page.locator('.screen-card').filter({ hasText: project.name }).click();
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  const title = page.getByLabel('Title for remark 1', { exact: true });
  await title.fill('Final input');
  let posts = 0, checks = 0;
  let releasePost!: () => void, releaseCheck!: () => void;
  const post = new Promise<void>(resolve => { releasePost = resolve; });
  const check = new Promise<void>(resolve => { releaseCheck = resolve; });
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() === 'POST') {
      posts++;
      const sent = route.request().postDataJSON().project as ProjectData;
      expect(sent.remarks?.[0].title).toBe('Final input');
      await post;
      state.projects = [sent] as unknown as Record<string, unknown>[];
      return route.fulfill({ json: { ok: true, project: sent } });
    }
    checks++;
    await check;
    return route.fulfill({ status: 503, json: { error: 'readback unavailable' } });
  });
  try {
    const save = page.getByRole('button', { name: 'Save current project without a new revision' });
    await save.click();
    await expect.poll(() => posts).toBe(1);
    await expectOperationBlocksUi(page);
    await page.keyboard.type('must not be entered');
    await expect(title).toHaveValue('Final input');
    await page.getByRole('tab', { name: 'Room Type', exact: true, includeHidden: true }).evaluate(element => (element as HTMLElement).click());
    await expect(title).toBeVisible();
    releasePost();
    await expect.poll(() => checks).toBe(1);
    await expectOperationBlocksUi(page);
    expect(posts).toBe(1);
    releaseCheck();
    await expect(page.getByTestId('database-operation-overlay')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Check Save Status', exact: true })).toBeVisible();
    await expect(title).toHaveValue('Final input');
    expect(posts).toBe(1);
  } finally { releasePost(); releaseCheck(); }
});

test('create blocks competing creation and navigation until its response and readback finish', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  state.projects = [createNewProject('Existing')] as unknown as Record<string, unknown>[];
  await page.goto('/');
  let posts = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { projects: state.projects } });
    posts++;
    const sent = route.request().postDataJSON().project;
    await gate;
    state.projects = [sent, ...state.projects];
    return route.fulfill({ json: { ok: true, project: sent } });
  });
  await page.getByPlaceholder('New project name').fill('Created');
  try {
    await page.getByRole('button', { name: 'Create Project', exact: true }).click();
    await expect.poll(() => posts).toBe(1);
    await expectOperationBlocksUi(page);
    await page.locator('.screen-card').filter({ hasText: 'Existing' }).evaluate(element => (element as HTMLElement).click());
    await expect(page.getByPlaceholder('New project name')).toBeVisible();
    await page.getByRole('button', { name: 'Create Project', exact: true, includeHidden: true }).evaluate(element => (element as HTMLElement).click());
    expect(posts).toBe(1);
    release();
    await expect(page.getByTestId('database-operation-overlay')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Back to Project List', exact: true })).toBeVisible();
    expect(posts).toBe(1);
  } finally { release(); }
});
