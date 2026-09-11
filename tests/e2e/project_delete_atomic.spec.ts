import { test, expect } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';

for (const failure of ['413', '503', 'timeout'] as const) {
  test(`delete ${failure}: reload retains an original or recoverable Trash copy`, async ({ page }, testInfo) => {
    const state = await installLocalEditingMocks(page);
    await page.goto('/');
    await page.getByPlaceholder('New project name').fill('Atomic delete original');
    await page.getByRole('button', { name: 'Create Project', exact: true }).click();
    await page.getByRole('button', { name: 'Back to Project List', exact: true }).click();
    await expect.poll(() => state.projects.length).toBe(1);
    const original = structuredClone(state.projects[0]);
    let attempted = false;
    const fail = async (route: import('@playwright/test').Route) => {
      attempted = true;
      if (failure === 'timeout') await route.abort('timedout');
      else await route.fulfill({ status: Number(failure), json: { error: 'injected deletion failure' } });
    };
    await page.context().route('**/api/trash', async route => {
      if (route.request().method() === 'POST') return fail(route);
      return route.fallback();
    });
    await page.context().route('**/api/projects/delete', fail);
    page.on('dialog', dialog => void dialog.accept());
    await page.getByRole('button', { name: 'Delete Project', exact: true }).click();
    await expect.poll(() => attempted).toBe(true);
    await page.reload();
    await expect(page.getByPlaceholder('New project name')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`delete-${failure}.png`) });
    const recoverable = state.projects.some(project => project.id === original.id)
      || state.trash.projects.some(item => (item.project as typeof original)?.id === original.id);
    expect(recoverable, 'a failed delete must not remove the only persisted copy').toBe(true);
    await expect(page.locator('.screen-card-wrap, .trash-row').filter({ hasText: String(original.name) }).first()).toBeVisible();
  });
}

for (const loseReply of [false, true]) {
  test(`delete commits once with ${loseReply ? 'lost' : 'delayed'} response`, async ({ page }, testInfo) => {
    const state = await installLocalEditingMocks(page);
    await page.goto('/');
    await page.getByPlaceholder('New project name').fill('Atomic delayed project');
    await page.getByRole('button', { name: 'Create Project', exact: true }).click();
    await page.getByRole('button', { name: 'Back to Project List', exact: true }).click();
    const original = structuredClone(state.projects[0]);
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.context().route('**/api/projects/delete', async route => {
      requests++;
      expect(route.request().postDataJSON()).toEqual({ projectId: original.id, expectedUpdatedAt: original.updatedAt });
      await gate;
      state.trash.projects.unshift({ id: 'synthetic-trash', project: original, deletedAt: String(original.updatedAt) });
      state.projects = [];
      if (loseReply) await route.abort('timedout');
      else await route.fulfill({ json: { ok: true, projects: [], trash: state.trash, updatedAt: '1' } });
    });
    page.on('dialog', dialog => void dialog.accept());
    await page.getByRole('button', { name: 'Delete Project', exact: true }).click();
    try {
      await expect.poll(() => requests).toBe(1);
      await expect(page.locator('.screen-card-wrap').filter({ hasText: 'Atomic delayed project' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Delete Project', exact: true })).toBeDisabled();
      await page.screenshot({ path: testInfo.outputPath('delete-pending-original.png') });
    } finally { release(); }
    await expect.poll(() => state.trash.projects.length).toBe(1);
    if (!loseReply) await expect(page.locator('.trash-row')).toBeVisible();
    await page.reload();
    await expect(page.locator('.trash-row').filter({ hasText: 'Atomic delayed project' })).toBeVisible();
    expect(requests).toBe(1);
    await page.getByRole('button', { name: 'Restore Project', exact: true }).click();
    await expect.poll(() => state.projects.length).toBe(1);
    await expect.poll(() => state.trash.projects.length).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('restored-original.png') });
    await page.context().unroute('**/api/projects/delete');
    await page.context().route('**/api/projects/delete', async route => {
      const project = state.projects[0];
      state.projects = [];
      state.trash.projects = [{ id: 'second-trash', project, deletedAt: String(project.updatedAt) }];
      await route.fulfill({ json: { ok: true, projects: [], trash: state.trash, updatedAt: '2' } });
    });
    await page.getByRole('button', { name: 'Delete Project', exact: true }).click();
    await expect(page.locator('.trash-row')).toBeVisible();
    await page.getByRole('button', { name: 'Empty Trash', exact: true }).click();
    await expect.poll(() => state.trash.projects.length).toBe(0);
    await page.reload();
    await expect(page.locator('.trash-row')).toHaveCount(0);
    expect(state.projects).toEqual([]);
  });
}
