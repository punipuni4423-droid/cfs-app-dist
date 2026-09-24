import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createNewProject, prepareProjectSave } from '../../app/lib/storage';
import type { ProjectData, TrashData } from '../../app/types';

const initial = '2026-09-01T00:00:00.000Z';
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Project updated', exact: true });
const jwt = (sub: string) => `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url')}.c2ln`;
function fixture() {
  return { projects: ['A', 'B'].map(id => ({ ...createNewProject(`T38 ${id}`), id: `t38-${id}`, updatedAt: initial })), summary: true,
    override: null as unknown[] | null, statusGate: null as null | (() => Promise<void>), failNextProjectWrite: false,
    trash: { projects: [], roomTypes: [] } as TrashData, trashGate: null as null | (() => Promise<void>) };
}
type Shared = ReturnType<typeof fixture>;

async function session(page: Page, shared: Shared, user = 'U1', name = user) {
  const base = new URL(test.info().project.use.baseURL as string).origin;
  const counts = { gets: 0, writes: 0, statuses: 0, heartbeats: 0, trashWrites: 0, blocked: [] as string[] };
  const modes = new Set<string>();
  let loseLock = false;
  await page.context().routeWebSocket('**/*', socket => socket.close());
  const membership = { id: user, displayName: name, email: `${user}@example.test`, role: 'admin', active: true, createdAt: initial, lastSeenAt: initial };
  const status = (id: string, sid = '') => {
    const editing = modes.has(id) && !loseLock;
    const lock = editing ? { scopeId: `project:${id}`, projectId: id, userId: user, userName: name, sessionId: sid, acquiredAt: initial, heartbeatAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' } : null;
    return { enabled: true, mode: editing ? 'edit' : 'view', ownsLock: editing, projectId: id, lock, locks: lock ? [lock] : [], membership,
      lastUpdatedBy: { userId: 'wrong-workspace-author', displayName: 'Do not use workspace author', updatedAt: initial },
      lastUpdatedAt: shared.projects.find(p => p.id === id)?.updatedAt ?? null, leaseSeconds: 90, heartbeatMs: 20000, idleMs: 900000,
      ...(shared.summary ? { projectUpdates: shared.override ?? shared.projects.map(p => ({ id: p.id, updatedAt: p.updatedAt, lastUpdatedBy: p.lastUpdatedBy ?? null })) } : {}) };
  };
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://t38-synthetic.supabase.co') {
      await route.fulfill({ json: { user: { id: user, email: membership.email, app_metadata: { provider: 'azure' }, user_metadata: {} } } }); return;
    }
    if (url.origin !== base) { counts.blocked.push(url.origin); await route.abort('blockedbyclient'); return; }
    if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
    const body = request.method() === 'POST' ? request.postDataJSON() as Record<string, unknown> : {};
    if (url.pathname === '/api/sharing/config') { await route.fulfill({ json: { mode: 'supabase', url: 'https://t38-synthetic.supabase.co', publishableKey: jwt('anon') } }); return; }
    if (url.pathname === '/api/collaboration/auth') { await route.fulfill({ json: { membership } }); return; }
    if (url.pathname === '/api/collaboration/status') {
      counts.statuses++; const snapshot = structuredClone(status(url.searchParams.get('projectId') ?? '', url.searchParams.get('sessionId') ?? ''));
      if (shared.statusGate) await shared.statusGate();
      await route.fulfill({ json: snapshot }); return;
    }
    if (url.pathname.startsWith('/api/collaboration/lock/')) {
      const id = String(body.projectId ?? '');
      if (url.pathname.endsWith('/acquire')) modes.add(id);
      if (url.pathname.endsWith('/release')) modes.delete(id);
      if (url.pathname.endsWith('/heartbeat')) counts.heartbeats++;
      const next = status(id, String(body.sessionId ?? ''));
      await route.fulfill({ json: { ok: true, acquired: next.mode === 'edit', released: true, lock: next.lock, status: next } }); return;
    }
    if (url.pathname === '/api/projects') {
      if (request.method() === 'POST') {
        counts.writes++;
        const updates = body.project ? [body.project as ProjectData] : body.projects as ProjectData[];
        for (const project of updates) { const index = shared.projects.findIndex(p => p.id === project.id); if (index < 0) shared.projects.push(project); else shared.projects[index] = structuredClone(project); }
        if (shared.failNextProjectWrite) { shared.failNextProjectWrite = false; await route.fulfill({ status: 503, json: { error: 'Synthetic lost Import response' } }); return; }
        await route.fulfill({ json: { ok: true, project: updates[0], projects: updates } });
      } else { counts.gets++; await route.fulfill({ json: { projects: shared.projects } }); }
      return;
    }
    if (url.pathname === '/api/trash') {
      if (request.method() === 'POST') { counts.trashWrites++; if (shared.trashGate) await shared.trashGate(); shared.trash = body.trash as TrashData; }
      await route.fulfill({ json: { ok: true, trash: shared.trash, updatedAt: initial } }); return;
    }
    if (url.pathname === '/api/app-update/status') { await route.fulfill({ json: { enabled: true, state: 'current', message: 'Current', ahead: 0, behind: 0, dirty: false } }); return; }
    if (url.pathname === '/api/tablet-url') { await route.fulfill({ json: { url: '' } }); return; }
    counts.blocked.push(url.pathname); await route.abort('blockedbyclient');
  });
  await page.goto(`/#access_token=${jwt(user)}&refresh_token=synthetic-only&token_type=bearer&expires_at=${Math.floor(Date.now()/1000)+3600}`);
  await expect(page.locator('.screen-card').filter({ hasText: 'T38 A' })).toBeVisible();
  return { counts, lose: () => { loseLock = true; }, modes };
}
async function open(page: Page, name = 'T38 A') { await page.locator('.screen-card').filter({ hasText: name }).click(); await expect(page.getByRole('button', { name: 'Back to Project List', exact: true })).toBeVisible(); }
function changed(shared: Shared, user = 'U2', name = 'User Two', index = 0) {
  const project = shared.projects[index], time = new Date(Math.max(Date.now(), Date.parse(project.updatedAt) + 1)).toISOString();
  shared.projects[index] = { ...project, updatedAt: time, lastUpdatedBy: { userId: user, displayName: name, updatedAt: time } };
}
async function cycle(page: Page) { await page.getByRole('button', { name: 'Back to Project List', exact: true }).click(); await open(page); }

test('T38 normal two-context save, real timer, Close keeps badge, next token and reload', async ({ page, browser }, info) => {
  const shared = fixture();
  const second: BrowserContext = await browser.newContext({ storageState: await page.context().storageState(), serviceWorkers: 'block' });
  try {
    const writer = await second.newPage();
    const one = await session(page, shared, 'U1', 'User One');
    const two = await session(writer, shared, 'U2', 'User Two');
    await open(page); await open(writer);
    await writer.getByRole('button', { name: 'Start editing', exact: true }).click();
    await writer.getByRole('tab', { name: 'Remarks', exact: true }).click();
    await writer.getByRole('button', { name: 'Add Remark', exact: true }).click();
    await writer.getByLabel('Body for remark 1', { exact: true }).fill('Written in the other context');
    const before = { ...one.counts };
    await writer.getByRole('button', { name: 'Save current project without a new revision' }).click();
    await expect.poll(() => shared.projects[0].remarks?.[0]?.body).toBe('Written in the other context');
    await expect(dialog(page)).toBeVisible({ timeout: 30000 });
    await expect(dialog(page)).toContainText('User Two updated this project at');
    await expect(dialog(page)).toContainText('Press F5');
    expect(one.counts.gets).toBe(before.gets); expect(one.counts.writes).toBe(0);
    await page.screenshot({ path: info.outputPath('normal-1280.png') });
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForTimeout(42000);
    await expect(dialog(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to Project List', exact: true }).click();
    await expect(page.getByTestId('remote-project-update-badge')).toContainText('Updated by User Two');
    await page.screenshot({ path: info.outputPath('list-1280.png') });
    await open(page); await expect(dialog(page)).toHaveCount(0);
    changed(shared, 'U2', 'User Two second save');
    await expect(dialog(page)).toBeVisible({ timeout: 30000 });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Back to Project List', exact: true })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    expect(one.counts.writes).toBe(0); expect(two.counts.writes).toBe(1);
    expect(one.counts.blocked).toEqual([]); expect(two.counts.blocked).toEqual([]);
    await info.attach('request-counts', { body: JSON.stringify({ one: one.counts, two: two.counts }), contentType: 'application/json' });
  } finally { await second.close(); }
});

test('T38 self, unknown identity, invalid token and old API do not create notifications', async ({ page }) => {
  const shared = fixture(), one = await session(page, shared); await open(page);
  changed(shared, 'U1'); await cycle(page); await expect(dialog(page)).toHaveCount(0);
  changed(shared, ''); await cycle(page); await expect(dialog(page)).toHaveCount(0);
  shared.override = [{ id: 't38-A', updatedAt: '2026-02-30T00:00:00.000Z', lastUpdatedBy: { userId: 'U2', displayName: 'Wrong date', updatedAt: '2026-02-30T00:00:00.000Z' } }];
  await cycle(page); await expect(dialog(page)).toHaveCount(0);
  shared.override = null; shared.summary = false; changed(shared); await cycle(page); await expect(dialog(page)).toHaveCount(0);
  expect(one.counts.writes).toBe(0); expect(one.counts.blocked).toEqual([]);
});

test('T38 Recovery and competing portals defer, long name layout and keyboard Close', async ({ page }, info) => {
  const shared = fixture(); await session(page, shared); await open(page);
  const trigger = page.getByTestId('save-recovery-toggle'); await trigger.click();
  changed(shared, 'U2', 'User Two with a very long display name '.repeat(5));
  await page.waitForTimeout(23000);
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Close Save and Recovery', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeFocused();
  for (const width of [390, 1280, 1536]) {
    await page.setViewportSize({ width, height: 900 }); await page.screenshot({ path: info.outputPath(`dialog-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.keyboard.press('Escape'); await expect(dialog(page)).toHaveCount(0); await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: 'Hide top bar', exact: true }).click();
  changed(shared, 'U2', 'Hidden top bar update');
  await expect(dialog(page)).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: info.outputPath('hidden-topbar.png') });
});

test('T38 dirty lock-lost View retains draft and defers F5', async ({ page }, info) => {
  const shared = fixture(), one = await session(page, shared); await open(page);
  await page.getByRole('button', { name: 'Start editing', exact: true }).click();
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  await page.getByRole('button', { name: 'Add Remark', exact: true }).click();
  await page.getByLabel('Body for remark 1', { exact: true }).fill('Unshared protected text');
  changed(shared); one.lose();
  await expect(page.getByRole('button', { name: 'Start editing', exact: true })).toBeVisible({ timeout: 30000 });
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByLabel('Body for remark 1', { exact: true })).toHaveValue('Unshared protected text');
  expect(one.counts.writes).toBe(0);
  await page.screenshot({ path: info.outputPath('dirty-view-protected.png') });
  const bytes = await page.evaluate(async () => await new Promise<unknown[]>((resolve, reject) => { const req = indexedDB.open('cfs-drafts', 1); req.onerror = () => reject(req.error); req.onsuccess = () => { const db = req.result; const read = db.transaction('projects').objectStore('projects').getAll(); read.onsuccess = () => { db.close(); resolve(read.result); }; }; }));
  expect(JSON.stringify(bytes)).toContain('Unshared protected text');
});

test('T38 pending saved-intent recovery remains protected after page reload', async ({ page }) => {
  const shared = fixture(), one = await session(page, shared); await open(page);
  const before = structuredClone(shared.projects[0]);
  const project = await prepareProjectSave(before, 'current', 'unconfirmed-synthetic');
  await page.evaluate(async ({ project, before }) => {
    const scope = { workspace: 'supabase:https://t38-synthetic.supabase.co', owner: 'U1', tab: 'retained-intent' };
    const key = JSON.stringify([scope.workspace, scope.owner, project.id, scope.tab]);
    await new Promise<void>((resolve, reject) => { const request = indexedDB.open('cfs-drafts', 1); request.onerror = () => reject(request.error); request.onsuccess = () => {
      const db = request.result, tx = db.transaction('projects', 'readwrite'); tx.objectStore('projects').put({ key, scope, project, baseUpdatedAt: before.updatedAt, generation: Date.now(), savedAt: new Date().toISOString(), intent: { before, project, expectedUpdatedAt: before.updatedAt, operationId: project.lastSaveOperation!.id } });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    }; });
  }, { project, before });
  await page.reload(); await expect(page.getByRole('button', { name: 'Back to Project List', exact: true })).toBeVisible();
  changed(shared); await page.waitForTimeout(23000); await expect(dialog(page)).toHaveCount(0);
  await page.getByTestId('save-recovery-toggle').click(); await expect(page.getByRole('button', { name: 'Check Previous Save', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check Previous Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check Previous Save', exact: true })).toBeEnabled();
  expect(one.counts.writes).toBe(0);
  const retained = await page.evaluate(async () => await new Promise<unknown[]>((resolve, reject) => { const req = indexedDB.open('cfs-drafts', 1); req.onerror = () => reject(req.error); req.onsuccess = () => { const db = req.result; const read = db.transaction('projects').objectStore('projects').getAll(); read.onsuccess = () => { db.close(); resolve(read.result); }; }; }));
  expect(JSON.stringify(retained)).toContain('unconfirmed-synthetic');
});

test('T38 Trash pending after Finish defers F5 and confirmed completion resumes', async ({ page }, info) => {
  const shared = fixture();
  shared.trash.projects.push({ id: 't38-trash', deletedAt: initial, project: createNewProject('Synthetic Trash') });
  const one = await session(page, shared);
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }); shared.trashGate = () => gate;
  page.on('dialog', native => void native.accept());
  await page.getByRole('button', { name: 'Start editing', exact: true }).click();
  await page.getByRole('button', { name: 'Empty Trash', exact: true }).click();
  await expect.poll(() => one.counts.trashWrites).toBe(1);
  await page.getByRole('button', { name: 'Finish editing', exact: true }).click();
  changed(shared); await open(page); await expect(dialog(page)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('trash-pending.png') });
  release(); await expect(dialog(page)).toBeVisible({ timeout: 30000 });
  expect(one.counts.writes).toBe(0);
});

test('T38 confirmed Import backup permits normal notification', async ({ page }, info) => {
  const shared = fixture(); await session(page, shared);
  page.on('dialog', native => void native.accept(native.type() === 'prompt' ? 'update' : undefined));
  await page.getByRole('button', { name: 'Start editing', exact: true }).click();
  const imported = { ...createNewProject('T38 Imported'), id: 't38-import' };
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-import.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ projects: [imported] })) });
  await expect(page.locator('.screen-card').filter({ hasText: 'T38 Imported' })).toBeVisible();
  await expect(page.getByTestId('save-reliability-alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Finish editing', exact: true }).click();
  await open(page); changed(shared);
  await expect(dialog(page)).toBeVisible({ timeout: 30000 });
  await expect(dialog(page)).toContainText('Review any local drafts');
  await page.screenshot({ path: info.outputPath('confirmed-import-notification.png') });
});

for (const confirm of [false, true]) test(`T38 deferred Import history ${confirm ? 'confirmed backup resumes notification' : 'unconfirmed backup keeps notification deferred'}`, async ({ page }, info) => {
  const shared = fixture();
  shared.projects[0].remarks = [{ id: 't38-original', title: 'Original', body: 'Original A body', hasTable: false, columns: [], rows: [] }];
  const one = await session(page, shared);
  page.on('dialog', native => void native.accept(native.type() === 'prompt' ? 'U' : undefined));
  await page.getByRole('button', { name: 'Start editing', exact: true }).click();
  shared.failNextProjectWrite = true;
  const imported = ['B', 'C'].map(id => ({ ...createNewProject(`T38 Imported ${id}`), id: `t38-${id}` }));
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-deferred-import.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ projects: imported })) });
  await expect(page.getByTestId('import-save-message')).toContainText('503');
  await page.getByTestId('save-recovery-toggle').click();
  await page.getByRole('button', { name: 'Keep Import Recovery and Load Shared Data', exact: true }).click();
  await expect(page.getByTestId('import-recovery-record')).toContainText('Shared data loaded');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Finish editing', exact: true }).click();
  await open(page);
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  await expect(page.getByLabel('Body for remark 1', { exact: true })).toHaveValue('Original A body');
  changed(shared);
  shared.projects[0].remarks = shared.projects[0].remarks.map(remark => ({ ...remark, body: 'Updated A server body' }));
  await page.waitForTimeout(23000);
  await expect(dialog(page)).toHaveCount(0);
  const readImports = () => page.evaluate(async () => await new Promise<Array<{ importRecovery?: { deferredAt?: string; confirmedAt?: string }; project: { id: string } }>>((resolve, reject) => {
    const request = indexedDB.open('cfs-drafts', 1); request.onerror = () => reject(request.error); request.onsuccess = () => {
      const db = request.result, read = db.transaction('projects').objectStore('projects').getAll();
      read.onsuccess = () => { db.close(); resolve(read.result.filter(record => record.importRecovery)); };
    };
  }));
  const deferred = await readImports();
  expect(deferred).toHaveLength(2); expect(deferred.every(record => record.importRecovery?.deferredAt && !record.importRecovery.confirmedAt)).toBe(true);
  if (confirm) {
    await page.getByRole('button', { name: 'Back to Project List', exact: true }).click();
    await page.getByTestId('save-recovery-toggle').click();
    await page.getByRole('button', { name: 'Check Import Status', exact: true }).click();
    await expect.poll(async () => (await readImports()).every(record => record.importRecovery?.confirmedAt)).toBe(true);
    await page.keyboard.press('Escape');
    await open(page);
    await expect(page.getByLabel('Body for remark 1', { exact: true })).toHaveValue('Original A body');
    await expect(dialog(page)).toBeVisible({ timeout: 30000 });
    const retained = await readImports();
    expect(retained).toHaveLength(2); expect(retained.every(record => record.importRecovery?.deferredAt && record.importRecovery.confirmedAt)).toBe(true);
    await info.attach('confirmed-deferred-import-history', { body: JSON.stringify(retained.map(record => ({ id: record.project.id, ...record.importRecovery }))), contentType: 'application/json' });
  }
  expect(one.counts.writes).toBe(1);
  expect(one.counts.blocked).toEqual([]);
});

test('T38 delayed older status cannot replace latest author and T30 key stays untouched', async ({ page }, info) => {
  const shared = fixture();
  const seen = JSON.stringify({ lastSeenId: 'synthetic-older' });
  await page.addInitScript(value => localStorage.setItem('cfs-user-changelog-seen-v1', value), seen);
  const one = await session(page, shared); await open(page);
  let release = () => {}, captured = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  changed(shared, 'U2', 'Old delayed author');
  shared.statusGate = () => { captured++; return captured === 1 ? gate : Promise.resolve(); };
  await expect.poll(() => captured, { timeout: 30000 }).toBeGreaterThan(0);
  changed(shared, 'U3', 'Latest independent author');
  await expect(dialog(page)).toBeVisible({ timeout: 30000 });
  await expect(dialog(page)).toContainText('Latest independent author');
  release(); await page.waitForTimeout(1000);
  await expect(dialog(page)).toContainText('Latest independent author');
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Back to Project List', exact: true }).click();
  await expect(page.getByRole('region', { name: "What's new" })).toBeVisible();
  await expect(page.getByTestId('remote-project-update-badge')).toContainText('Latest independent author');
  expect(await page.evaluate(() => localStorage.getItem('cfs-user-changelog-seen-v1'))).toBe(seen);
  expect(one.counts.writes).toBe(0); expect(one.counts.blocked).toEqual([]);
  for (const width of [390, 1280, 1536]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: info.outputPath(`t30-and-notification-${width}.png`), fullPage: true, animations: 'disabled' });
    const bounds = await page.getByTestId('remote-project-update-badge').evaluate(element => {
      const rect = element.getBoundingClientRect();
      let opacity = 1;
      for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      return { opacity, left: rect.left, right: rect.right, width: innerWidth, overflows: element.scrollWidth > element.clientWidth };
    });
    expect(bounds.opacity).toBe(1); expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width); expect(bounds.overflows).toBe(false);
    await info.attach(`list-bounds-${width}`, { body: JSON.stringify(bounds), contentType: 'application/json' });
  }
});
