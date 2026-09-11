import { test, expect } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { createNewProject } from '../../app/lib/storage';

for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'local'} stale list rename preserves concurrent creation`, async ({ page }, testInfo) => {
    const state = await installLocalEditingMocks(page);
    const a = { ...createNewProject('Client A project') };
    const b = { ...createNewProject('Client B created later'), unknown: { retain: true } };
    state.projects = [a];
    let url = '/';
    if (shared) {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const jwt = (payload: object) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2ln`;
      const membership = { id: 'test-user', email: 'test@example.test', displayName: 'Test Editor', role: 'editor', active: true };
      await page.context().route('**/api/sharing/config', route => route.fulfill({ json: { mode: 'supabase', url: 'https://synthetic.supabase.co', publishableKey: jwt({ role: 'anon', exp }) } }));
      await page.context().route('https://synthetic.supabase.co/**', route => route.fulfill({ json: { user: { id: 'test-user', email: membership.email, app_metadata: {}, user_metadata: {} } } }));
      await page.context().route('**/api/collaboration/auth', route => route.fulfill({ json: { membership } }));
      await page.context().route('**/api/collaboration/status**', route => route.fulfill({ json: { enabled: true, mode: 'edit', membership, lock: null, locks: [], heartbeatMs: 20000, idleMs: 900000 } }));
      url = `/#access_token=${jwt({ sub: 'test-user', email: membership.email, exp })}&refresh_token=fake&token_type=bearer&expires_at=${exp}`;
    }
    // Model the pre-T116 backend explicitly. The same test detects any client
    // that still submits a whole list: omitted B is deleted by that backend.
    let listWrites = 0;
    await page.context().route('**/api/projects', async route => {
      if (route.request().method() === 'POST' && Array.isArray(route.request().postDataJSON().projects)) {
        listWrites++;
        state.projects = route.request().postDataJSON().projects;
        return route.fulfill({ json: { ok: true, projects: state.projects } });
      }
      return route.fallback();
    });
    await page.goto(url);
    const card = page.locator('.screen-card-wrap').filter({ hasText: a.name });
    await expect(card.getByRole('button', { name: 'Rename Project', exact: true })).toBeEnabled();
    state.projects.push(structuredClone(b)); // B creates after A finished reading.
    page.on('dialog', dialog => void dialog.accept('Client A renamed'));
    await card.getByRole('button', { name: 'Rename Project', exact: true }).click();
    await expect.poll(() => state.projects.find(project => project.id === a.id)?.name).toBe('Client A renamed');
    expect(state.projects.find(project => project.id === b.id), 'B must survive A stale rename').toEqual(b);
    expect(listWrites).toBe(0);
    await page.reload();
    await expect(page.locator('.screen-card-wrap').filter({ hasText: b.name })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('stale-rename-preserved.png') });
  });
}

test('rename failure keeps original; delayed response changes only requested project', async ({ page }, testInfo) => {
  const state = await installLocalEditingMocks(page);
  const a = { ...createNewProject('Rename original') };
  const b = { ...createNewProject('Unrelated original') };
  state.projects = [a, b];
  await page.goto('/');
  const alerts: string[] = [];
  page.on('dialog', dialog => {
    if (dialog.type() === 'alert') alerts.push(dialog.message());
    void dialog.accept(dialog.type() === 'prompt' ? 'Rename committed' : undefined);
  });
  await page.context().route('**/api/projects/rename', route => route.fulfill({ status: 409, json: { error: 'Project changed' } }));
  await page.locator('.screen-card-wrap').filter({ hasText: a.name }).getByRole('button', { name: 'Rename Project' }).click();
  await expect.poll(() => alerts).toEqual(['Project changed\nReload to check the project before retrying.']);
  expect(state.projects).toEqual([a, b]);
  await expect(page.locator('.screen-card-wrap').filter({ hasText: a.name })).toBeVisible();
  await page.context().unroute('**/api/projects/rename');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requestSeen = false;
  await page.context().route('**/api/projects/rename', async route => {
    expect(route.request().postDataJSON()).toEqual({ projectId: a.id, name: 'Rename committed', expectedUpdatedAt: a.updatedAt });
    requestSeen = true;
    await gate;
    state.projects[0] = { ...a, name: 'Rename committed', updatedAt: new Date().toISOString() };
    await route.fulfill({ json: { ok: true, project: state.projects[0] } });
  });
  await page.locator('.screen-card-wrap').filter({ hasText: a.name }).getByRole('button', { name: 'Rename Project' }).click();
  try { await expect.poll(() => requestSeen).toBe(true); await expect(page.locator('.screen-card-wrap').filter({ hasText: a.name })).toBeVisible(); }
  finally { release(); }
  await expect(page.locator('.screen-card-wrap').filter({ hasText: 'Rename committed' })).toBeVisible();
  expect(state.projects[1]).toEqual(b);
  await page.screenshot({ path: testInfo.outputPath('rename-retry.png') });
});
