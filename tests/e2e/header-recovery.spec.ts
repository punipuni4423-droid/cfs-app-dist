import { test, expect } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { createNewProject, prepareProjectSave } from '../../app/lib/storage';
import { appendCommonRevision } from '../../app/lib/projectCommonHistory';
import { readNativeDraftRecords } from './support/native-project-drafts';

test('normal project keeps recovery in the toolbar; panel disclosure performs no save or restore', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const project = appendCommonRevision(createNewProject('Header recovery fixture'), '既存の日本語履歴', 'Synthetic tester');
  state.projects = [project as unknown as Record<string, unknown>];
  let dataWrites = 0;
  page.on('request', request => { if (/\/api\/(projects|trash)(?:[/?]|$)/.test(request.url()) && request.method() !== 'GET') dataWrites++; });
  await page.goto('/');
  await page.locator('.screen-card').filter({ hasText: project.name }).click();
  await expect(page.getByTestId('project-backup-download')).toBeVisible();
  await expect(page.getByTestId('save-reliability-alert')).toHaveCount(0);
  await expect(page.getByTestId('save-recovery-panel')).toHaveCount(0);
  await expect(page.locator('.revision-save-status-label')).toHaveText('Saved');
  const before = dataWrites;
  const toggle = page.getByTestId('save-recovery-toggle');
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('heading', { name: 'Save and Recovery', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('save-recovery-panel')).toHaveCount(0);
  await expect(toggle).toBeFocused();
  const common = page.getByTestId('common-history-toggle');
  await common.click();
  await expect(page.getByTestId('common-history-panel')).toContainText('既存の日本語履歴');
  await page.getByRole('button', { name: 'Close Common History', exact: true }).click();
  await expect(common).toBeFocused();
  expect(dataWrites).toBe(before);
  expect(state.projects[0]).toEqual(project);
  await expect(page.getByTestId('save-reliability-alert')).toHaveCount(0);
});

test('project/list scope change closes recovery without selecting an old restore', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  state.projects = [createNewProject('Header scope fixture') as unknown as Record<string, unknown>];
  await page.goto('/');
  await page.getByTestId('save-recovery-toggle').click();
  await expect(page.getByTestId('save-recovery-panel')).toBeVisible();
  await page.locator('.screen-card').filter({ hasText: 'Header scope fixture' }).click();
  await expect(page.getByTestId('save-recovery-panel')).toHaveCount(0);
  await expect(page.getByTestId('save-recovery-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Back to Project List', exact: true }).click();
  await expect(page.getByTestId('save-recovery-panel')).toHaveCount(0);
});

test('a list rename failure does not create a recovery warning in another clean project', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const first = createNewProject('Rename failure source'), second = createNewProject('Clean unrelated project');
  state.projects = [first, second] as unknown as Record<string, unknown>[];
  let rejected = 0, alerts = 0;
  page.on('dialog', dialog => { if (dialog.type() === 'alert') alerts++; void dialog.accept(dialog.type() === 'prompt' ? 'Rejected rename' : undefined); });
  await page.context().route('**/api/projects/rename', route => { rejected++; return route.fulfill({ status: 403, json: { error: 'Synthetic rename refusal' } }); });
  await page.goto('/');
  await page.locator('.screen-card-wrap').filter({ hasText: first.name }).getByRole('button', { name: 'Rename Project', exact: true }).click();
  await expect.poll(() => rejected).toBe(1);
  await expect.poll(() => alerts).toBe(1);
  await page.locator('.screen-card').filter({ hasText: second.name }).click();
  // The raw status remains untouched; the clean project's presentation is scoped.
  await expect(page.locator('.revision-save-status-label')).toHaveText('Saved');
  await expect(page.locator('.revision-save-status')).not.toHaveAttribute('title', /failed|error/i);
  await expect(page.getByTestId('save-reliability-alert')).toHaveCount(0);
  expect(state.projects).toEqual([first, second]);
});

test('a delayed previous-save confirmation keeps its list display scope after opening another project', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const first = createNewProject('Archived previous save');
  first.remarks = [{ id: 'remark', title: 'Original', body: 'base', hasTable: false, columns: [], rows: [] }];
  const sent = await prepareProjectSave({ ...first, updatedAt: '2032-01-01T00:00:00.000Z', remarks: [{ ...first.remarks[0], body: 'confirmed save' }] }, 'current');
  const draft = { ...sent, remarks: [{ ...sent.remarks![0], body: 'later local draft' }] };
  const other = createNewProject('Clean destination during confirmation');
  state.projects = [sent, other] as unknown as Record<string, unknown>[];
  await page.addInitScript(({ first, sent, draft }) => {
    localStorage.setItem('cfs-collaboration-user-v1', JSON.stringify({ id: 'mock-user', displayName: 'Synthetic tester' }));
    const scope = { workspace: `local:${location.origin}`, owner: 'mock-user', tab: 'synthetic-previous-tab' };
    const key = JSON.stringify([scope.workspace, scope.owner, first.id, scope.tab]);
    localStorage.setItem(`cfs-draft-project-v3:${key}`, JSON.stringify({ key, scope, project: draft, generation: 1,
      savedAt: '2032-01-01T00:00:01.000Z', baseUpdatedAt: first.updatedAt,
      intent: { before: first, project: sent, expectedUpdatedAt: first.updatedAt, operationId: sent.lastSaveOperation!.id } }));
  }, { first, sent, draft });
  let holdNextRead = false, held = false, release!: () => void, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() !== 'GET') { writes++; return route.fallback(); }
    if (holdNextRead && !held) { held = true; await gate; }
    return route.fulfill({ json: { projects: state.projects } });
  });
  await page.goto('/');
  await page.getByTestId('save-recovery-toggle').click();
  await page.getByRole('button', { name: 'Check Previous Save', exact: true }).click();
  holdNextRead = true;
  await page.getByTestId('save-check').click();
  await expect.poll(() => held).toBe(true);
  try {
    await page.locator('.screen-card').filter({ hasText: other.name }).click();
    await expect(page.getByTestId('project-backup-download')).toBeVisible();
    release();
    await expect(page.getByTestId('save-check')).toHaveCount(0);
    await expect(page.getByTestId('save-reliability-alert')).toHaveCount(0);
    await page.getByTestId('save-recovery-toggle').click();
    await expect(page.getByTestId('save-recovery-panel')).not.toContainText('The previous save has been verified');
    await expect.poll(async () => (await readNativeDraftRecords(page)).some(record => record.project.id === first.id && record.project.remarks?.[0]?.body === 'later local draft')).toBe(true);
    expect(state.projects).toEqual([sent, other]);
    expect(writes).toBe(0);
  } finally { release(); }
});

test('closing recovery after its warning disappears focuses its own visible toolbar toggle', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const project = createNewProject('Recovery focus after confirmation');
  project.remarks = [{ id: 'remark', title: 'Original', body: 'base', hasTable: false, columns: [], rows: [] }];
  state.projects = [project as unknown as Record<string, unknown>];
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    state.projects = [route.request().postDataJSON().project];
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
  await page.locator('.screen-card').filter({ hasText: project.name }).click();
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  await page.getByLabel('Body for remark 1', { exact: true }).fill('confirmed edited value');
  await page.getByRole('button', { name: 'Save current project without a new revision' }).click();
  await expect(page.getByTestId('save-check')).toBeVisible();
  await page.getByTestId('save-recovery-open').click();
  await expect(page.getByTestId('save-recovery-panel')).toBeVisible();
  await page.getByTestId('save-check').click();
  await expect(page.getByTestId('save-reliability-alert')).toHaveCount(0);
  await expect(page.getByTestId('save-recovery-open')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close Save and Recovery', exact: true }).click();
  await expect(page.getByTestId('save-recovery-toggle')).toBeFocused();
  await expect(page.getByTestId('save-recovery-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('common-history-toggle').click();
  await page.getByRole('button', { name: 'Hide top bar', exact: true }).click();
  await page.getByRole('button', { name: 'Close Common History', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show top bar', exact: true })).toBeFocused();
});
