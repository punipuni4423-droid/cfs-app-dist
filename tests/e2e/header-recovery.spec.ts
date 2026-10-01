import { test, expect } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { createNewProject, prepareProjectSave } from '../../app/lib/storage';
import { appendCommonRevision } from '../../app/lib/projectCommonHistory';
import { readNativeDraftRecords } from './support/native-project-drafts';
import { expectOperationBlocksUi } from './support/database-operation';

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

test('a delayed previous-save confirmation blocks navigation, retains its draft, and keeps feedback scoped after completion', async ({ page }) => {
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
  page.on('request', request => {
    if (/\/api\/(projects|trash)(?:[/?]|$)/.test(request.url()) && request.method() === 'POST') writes++;
  });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (holdNextRead && !held) { held = true; await gate; }
    return route.fulfill({ json: { projects: state.projects } });
  });
  await page.goto('/');
  await page.getByTestId('save-recovery-toggle').click();
  await page.getByRole('button', { name: 'Check Previous Save', exact: true }).click();
  const scope = { workspace: `local:${new URL(page.url()).origin}`, owner: 'mock-user', tab: 'synthetic-previous-tab' };
  const key = JSON.stringify([scope.workspace, scope.owner, first.id, scope.tab]);
  const originalBytes = JSON.stringify({ key, scope, project: draft, generation: 1,
    savedAt: '2032-01-01T00:00:01.000Z', baseUpdatedAt: first.updatedAt,
    intent: { before: first, project: sent, expectedUpdatedAt: first.updatedAt, operationId: sent.lastSaveOperation!.id } });
  const readFallback = () => page.evaluate(key => localStorage.getItem(`cfs-draft-project-v3:${key}`), key);
  // Initialization reads fallback records; it does not migrate them to IDB.
  // Check must preserve the entire original record until a confirmed Recovery exists.
  expect(await readFallback()).toBe(originalBytes);
  holdNextRead = true;
  const checkStartedAt = Date.now();
  await page.getByTestId('save-check').click();
  await expect.poll(() => held).toBe(true);
  try {
    await expectOperationBlocksUi(page);
    const otherCard = page.locator('.screen-card').filter({ hasText: other.name });
    const bounds = await otherCard.boundingBox();
    expect(bounds).not.toBeNull();
    // Real pointer input hits the modal; explicit DOM click also must not
    // reach the background navigation handler through window capture.
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await otherCard.evaluate(element => (element as HTMLElement).click());
    await expect(otherCard).toBeVisible();
    await expect(page.getByTestId('project-backup-download')).toHaveCount(0);
    await expect(page.getByTestId('database-operation-overlay')).toBeVisible();
    expect(await readFallback()).toBe(originalBytes);
    expect(writes).toBe(0);
    release();
    await expect(page.getByTestId('database-operation-overlay')).toHaveCount(0);
    await expect(page.getByTestId('save-check')).toHaveCount(0);
    const retainedRecords = async () => (await readNativeDraftRecords(page)).filter(record => record.project.id === first.id
      && record.scope.workspace === scope.workspace && record.scope.owner === scope.owner && record.scope.tab.startsWith('recovery:'));
    await expect.poll(async () => (await retainedRecords()).length).toBe(1);
    const retained = (await retainedRecords())[0];
    expect(retained.key).toBe(JSON.stringify([scope.workspace, scope.owner, first.id, retained.scope.tab]));
    expect(retained.baseUpdatedAt).toBe(sent.updatedAt);
    expect('intent' in retained ? retained.intent : undefined).toBeUndefined();
    // Rebase advances only edit metadata here; compare every project field,
    // and independently bound the generated timestamp instead of guessing it.
    const editedAt = Date.parse(retained.project.updatedAt);
    const priorTime = Math.max(Date.parse(sent.updatedAt), Date.parse(draft.updatedAt)) + 1;
    expect(editedAt).toBeGreaterThanOrEqual(Math.max(priorTime, checkStartedAt));
    expect(editedAt).toBeLessThanOrEqual(Math.max(priorTime, Date.now()));
    expect(retained.project).toEqual(JSON.parse(JSON.stringify({ ...draft, updatedAt: retained.project.updatedAt, lastUpdatedBy: sent.lastUpdatedBy })));
    expect(await readFallback()).toBeNull();
    await otherCard.click();
    await expect(page.getByTestId('project-backup-download')).toBeVisible();
    await expect(page.getByTestId('save-reliability-alert')).toHaveCount(0);
    await page.getByTestId('save-recovery-toggle').click();
    await expect(page.getByTestId('save-recovery-panel')).not.toContainText('The previous save has been verified');
    expect(await retainedRecords()).toEqual([retained]);
    expect(await readFallback()).toBeNull();
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
