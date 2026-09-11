import { test, expect, type Page } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { createNewProject } from '../../app/lib/storage';
import { readNativeDraftRecords } from './support/native-project-drafts';
import { createNewRoomType, createEmptyDeviceAssignment } from '../../app/lib/constants';

async function setup(page: Page, ownerChange = false, legacy = false) {
  const state = await installLocalEditingMocks(page);
  const project = createNewProject('Synthetic restored project');
  project.remarks = [{ id: 'remark', title: 'Initial', body: 'saved-original', hasTable: false, columns: [], rows: [] }];
  if (legacy) {
    const room = createNewRoomType('Legacy room'), assignment = createEmptyDeviceAssignment();
    delete (room as any).hvacSeasons; delete (room as any).hvacAssignments; delete (assignment as any).deviceGroupId;
    room.deviceAssignments = [assignment]; project.roomTypes = [room];
  }
  const item = { id: 'restore-item', deletedAt: '2026-09-10T00:00:00.000Z', project };
  state.trash.projects = [item];
  if (ownerChange) {
    await page.addInitScript(() => localStorage.setItem('cfs-collaboration-user-v1', JSON.stringify({ id: 'mock-user', displayName: 'Owner A' })));
    await page.context().route('**/api/collaboration/status**', route => {
      const query = new URL(route.request().url()).searchParams;
      return route.fulfill({ json: { enabled: true, mode: 'edit', projectId: query.get('projectId') ?? '',
        lock: { userId: query.get('userId'), sessionId: query.get('sessionId'), expiresAt: '2099-01-01T00:00:00Z' },
        locks: [], leaseSeconds: 90, heartbeatMs: 900000, idleMs: 900000 } });
    });
  }
  let trashToken = 'trash-0', trashFails = false, trashPosts = 0;
  await page.context().route('**/api/projects?restoreRaw=1', route => route.fulfill({ json: { projects: state.projects } }));
  await page.context().route('**/api/trash**', async route => {
    if (route.request().method() === 'POST') {
      trashPosts++;
      if (trashFails) return route.fulfill({ status: 503, json: { error: 'synthetic trash failure' } });
      const payload = route.request().postDataJSON();
      if (payload.expectedUpdatedAt !== trashToken) return route.fulfill({ status: 409, json: { code: 'TRASH_CONFLICT' } });
      if (payload.restoreCleanup) {
        const matches = state.trash.projects.filter(item => item.id === payload.restoreCleanup.original.id);
        if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(payload.restoreCleanup.original)) return route.fulfill({ status: 409, json: { code: 'TRASH_CONFLICT' } });
        expect(payload.saveProtocol).toBe(2);
        expect(payload.trash).toEqual({ ...state.trash, projects: state.trash.projects.filter(item => item.id !== payload.restoreCleanup.original.id) });
      }
      state.trash = payload.trash; trashToken += '-next';
      return route.fulfill({ json: { ok: true, trash: state.trash, updatedAt: trashToken } });
    }
    return route.fulfill({ json: { trash: state.trash, updatedAt: trashToken } });
  });
  page.on('dialog', dialog => void dialog.accept());
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Restore Project', exact: true })).toBeVisible();
  return { state, project, item, setTrashFailure: (value: boolean) => { trashFails = value; }, trashPosts: () => trashPosts,
    changeTrashToken: () => { trashToken += '-external'; } };
}
const card = (page: Page) => page.locator('.screen-card-wrap').filter({ hasText: 'Synthetic restored project' });
const trashRow = (page: Page) => page.locator('.trash-row').filter({ hasText: 'Synthetic restored project' });

test('Restore POST rejection keeps Trash and does not claim restoration before or after reload', async ({ page }) => {
  const { state } = await setup(page);
  let posts = 0;
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts++; return route.fulfill({ status: 423, json: { code: 'LOCK_REQUIRED', error: 'synthetic lock loss' } });
  });
  await page.getByRole('button', { name: 'Restore Project', exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await expect(card(page)).toHaveCount(0);
  await expect(trashRow(page)).toBeVisible();
  await expect(page.getByText(/復元を確認できません/)).toBeVisible();
  expect(state.projects).toHaveLength(0);
  const records = await readNativeDraftRecords(page);
  expect(records.some(record => (record as any).intent?.restore?.trashItemId === 'restore-item')).toBe(true);
  await page.reload();
  await expect(card(page)).toHaveCount(0);
  await expect(trashRow(page)).toBeVisible();
  await expect(page.getByRole('button', { name: '以前の復元を確認', exact: true })).toBeVisible();
});

test('Restore waits for strict readback, blocks duplicate start, then survives reload', async ({ page }) => {
  const { state } = await setup(page);
  let posts = 0, checking = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() === 'POST') {
      posts++; state.projects = route.request().postDataJSON().projects;
      checking = true; return route.fulfill({ json: { ok: true, projects: state.projects } });
    }
    if (checking) await gate;
    return route.fulfill({ json: { projects: state.projects } });
  });
  await page.context().route('**/api/projects?restoreRaw=1', async route => { if (checking) await gate; return route.fulfill({ json: { projects: state.projects } }); });
  await page.getByRole('button', { name: 'Restore Project', exact: true }).click();
  try {
    await expect.poll(() => posts).toBe(1);
    await expect(card(page)).toHaveCount(0);
    await expect(trashRow(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore Project', exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(card(page)).toBeVisible();
  await expect(trashRow(page)).toHaveCount(0);
  expect(posts).toBe(1);
  await page.reload();
  await expect(card(page)).toBeVisible();
  await expect(trashRow(page)).toHaveCount(0);
});

test('Restore committed with lost reply confirms the same intent and preserves unrelated Trash additions', async ({ page }) => {
  const { state } = await setup(page);
  let posts = 0;
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts++; const payload = route.request().postDataJSON(); state.projects = payload.projects;
    expect(payload.restoreProjectIds).toEqual([state.projects[0].id]);
    expect(payload.expectedUpdatedAts).toEqual({ [String(state.projects[0].id)]: null });
    return route.abort('timedout');
  });
  await page.getByRole('button', { name: 'Restore Project', exact: true }).click();
  await expect(page.getByRole('button', { name: '復元状態を確認', exact: true })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  const other = { id: 'other-item', deletedAt: '2026-09-10T00:00:00.000Z', project: { ...createNewProject('Other trash original'), unknownHistoricalField: { original: 'retain verbatim' } } };
  state.trash.projects.push(other);
  await page.getByRole('button', { name: '復元状態を確認', exact: true }).click();
  await expect(card(page)).toBeVisible();
  await expect(trashRow(page)).toHaveCount(0);
  expect(state.trash.projects).toEqual([other]);
  expect(posts).toBe(1);
});

test('Restore distinguishes confirmed Project from failed Trash cleanup and never resends the Project', async ({ page }) => {
  const { state, setTrashFailure } = await setup(page);
  setTrashFailure(true);
  let posts = 0;
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts++; state.projects = route.request().postDataJSON().projects;
    return route.fulfill({ json: { ok: true, projects: state.projects } });
  });
  await page.getByRole('button', { name: 'Restore Project', exact: true }).click();
  await expect(card(page)).toBeVisible();
  await expect(trashRow(page)).toBeVisible();
  await expect(page.getByText(/本体は復旧済み.*Trash更新は未確認/)).toBeVisible();
  setTrashFailure(false);
  await page.getByRole('button', { name: '復元状態を確認', exact: true }).click();
  await expect(trashRow(page)).toHaveCount(0);
  expect(posts).toBe(1);
});

test('Restore explicit retry reuses the identical original operation and CAS request', async ({ page }) => {
  const { state } = await setup(page);
  const attempts: any[] = [];
  await page.context().route('**/api/projects', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON(); attempts.push(body);
    if (attempts.length === 1) return route.fulfill({ status: 503, json: { error: 'synthetic no commit' } });
    state.projects = body.projects; return route.fulfill({ json: { ok: true, projects: state.projects } });
  });
  await page.getByRole('button', { name: 'Restore Project', exact: true }).click();
  await expect(page.getByRole('button', { name: '同じ復元を再送', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '同じ復元を再送', exact: true }).click();
  await expect(trashRow(page)).toHaveCount(0);
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
});

test('Partial restore confirmation retains later edits durably and survives normal Current save and reload', async ({ page }) => {
  const { state, setTrashFailure } = await setup(page);
  setTrashFailure(true);
  await page.getByRole('button', { name: 'Restore Project', exact: true }).click();
  await expect(card(page)).toBeVisible();
  await page.getByRole('button', { name: '後で確認', exact: true }).click();
  await page.locator('button.screen-card').filter({ hasText: 'Synthetic restored project' }).click();
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  const body = page.getByLabel('Body for remark 1', { exact: true });
  await body.fill('later-edited-E');
  await page.getByRole('button', { name: '以前の復元を確認', exact: true }).click();
  await page.getByRole('button', { name: '復元状態を確認', exact: true }).click();
  await expect(body).toHaveValue('later-edited-E');
  await expect.poll(async () => (await readNativeDraftRecords(page)).some(r => !r.scope.tab.startsWith('recovery:') && r.project.remarks?.[0].body === 'later-edited-E')).toBe(true);
  await page.reload();
  if (await card(page).count()) await page.locator('button.screen-card').filter({ hasText: 'Synthetic restored project' }).click();
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  await expect(body).toHaveValue('saved-original');
  await page.getByRole('button', { name: '退避を編集へ戻す', exact: true }).and(page.locator(':enabled')).click();
  await expect(body).toHaveValue('later-edited-E');
  await page.getByRole('button', { name: 'Save current project without a new revision' }).click();
  await expect.poll(() => (state.projects[0] as any).remarks[0].body).toBe('later-edited-E');
  const retained = await readNativeDraftRecords(page);
  expect(retained.some(r => (r as any).intent?.restore?.confirmedProject)).toBe(true);
  setTrashFailure(false);
  await page.reload();
  await page.getByRole('button', { name: 'Back to Project List', exact: true }).click();
  await page.getByRole('button', { name: '以前の復元を確認', exact: true }).click();
  await page.getByRole('button', { name: '復元状態を確認', exact: true }).click();
  await expect(trashRow(page)).toHaveCount(0);
  expect((state.projects[0] as any).remarks[0].body).toBe('later-edited-E');
  await page.reload();
  await expect(page.getByRole('button', { name: '以前の復元を確認', exact: true })).toHaveCount(0);
});

test('Restore delayed completion cannot publish account A result or clear Trash after owner B registers', async ({ page }) => {
  const { state, trashPosts } = await setup(page, true);
  let release!: () => void, posts = 0, committed: any[] = [];
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts++; const body = route.request().postDataJSON(); await gate;
    committed = body.projects;
    return route.fulfill({ json: { ok: true, projects: body.projects } });
  });
  await page.context().route('**/api/projects?restoreRaw=1', route => route.fulfill({ json: { projects: committed } }));
  const rawConfirmation = page.waitForResponse(response => response.url().endsWith('/api/projects?restoreRaw=1'));
  await page.getByRole('button', { name: 'Restore Project', exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  try {
    await page.context().route('**/api/collaboration/users/register', route => route.fulfill({ json: { ok: true, user: { id: 'owner-B', displayName: 'Owner B', role: 'admin' } } }));
    await page.getByRole('button', { name: 'User: Owner A', exact: true }).click();
    await page.getByLabel('Display name', { exact: true }).fill('Owner B');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByRole('button', { name: 'User: Owner B', exact: true })).toBeVisible();
  } finally { release(); }
  await (await rawConfirmation).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(card(page)).toHaveCount(0);
  expect(state.projects).toHaveLength(0); expect(trashPosts()).toBe(0);
  const records = await readNativeDraftRecords(page);
  expect(records.filter(r => (r as any).intent?.restore).every(r => r.scope.owner !== 'owner-B')).toBe(true);
});

test('Restore legacy nested defaults keeps the raw wire and confirms the displayed original', async ({ page }) => {
  const { state, project } = await setup(page, false, true);
  await page.getByRole('button', { name: 'Restore Project', exact: true }).click();
  await expect(card(page)).toBeVisible();
  await expect(trashRow(page)).toHaveCount(0);
  const saved = state.projects[0] as any;
  expect(saved.roomTypes).toEqual(project.roomTypes);
  expect(saved.roomTypes[0]).not.toHaveProperty('hvacSeasons');
  expect(saved.roomTypes[0].deviceAssignments[0]).not.toHaveProperty('deviceGroupId');
  await page.reload();
  await expect(card(page)).toBeVisible();
  await expect(page.getByRole('button', { name: '以前の復元を確認', exact: true })).toHaveCount(0);
});

test('Restore rejects a field deletion after the displayed Trash token without sending a Project', async ({ page }) => {
  const { state, changeTrashToken, trashPosts } = await setup(page);
  delete (state.trash.projects[0].project as any).remarks;
  changeTrashToken();
  let posts = 0;
  await page.context().route('**/api/projects', route => { if (route.request().method() === 'POST') posts++; return route.fallback(); });
  await page.getByRole('button', { name: 'Restore Project', exact: true }).click();
  await expect(page.getByText(/表示後にTrashが変化/)).toBeVisible();
  expect(posts).toBe(0); expect(trashPosts()).toBe(0);
  await expect(trashRow(page)).toBeVisible();
  expect(state.trash.projects[0].project).not.toHaveProperty('remarks');
});
