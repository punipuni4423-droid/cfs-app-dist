import { test, expect, type Page } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { readNativeDraftRecords } from './support/native-project-drafts';
import { createNewProject, prepareProjectSave } from '../../app/lib/storage';
import { createNewRoomType } from '../../app/lib/constants';
import type { ProjectDraftRecord } from '../../app/lib/projectDraftStore';
import type { ProjectData } from '../../app/types';
import { completeImportBatch, confirmedImportBatch, deferredImportBatch, verifyImportBatch } from '../../app/lib/projectImportRecovery';
import { validDraftRecord, initializeProjectDrafts, refreshProjectImport, cachedDraftRecords } from '../../app/lib/projectDraftStore';

async function importFile(page: Page, projects: ProjectData[]) {
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(projects)) });
}
async function archives(page: Page) {
  return (await readNativeDraftRecords(page) as ProjectDraftRecord[]).filter(record => record.scope.tab.startsWith('recovery:import:'));
}
async function fallbackArchives(page: Page) {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('cfs-draft-project-v3:'))
    .map(key => JSON.parse(localStorage.getItem(key)!)).filter(record => record.scope.tab.startsWith('recovery:import:'))
    .sort((a, b) => a.key.localeCompare(b.key))) as Promise<ProjectDraftRecord[]>;
}
function incoming(project: ProjectData) {
  return { ...structuredClone(project), roomTypes: [createNewRoomType('Imported 日本語 RoomType')] };
}
function acceptDialogs(page: Page, choice = 'U') {
  page.on('dialog', dialog => void dialog.accept(dialog.type() === 'prompt' ? choice : undefined));
}

for (const mode of ['update', 'copy', 'new', 'mixed'] as const) {
  test(`import ${mode}: exact complete recovery precedes POST503 and survives reload`, async ({ page }, info) => {
    const state = await installLocalEditingMocks(page);
    const original = createNewProject('Existing 日本語 project'), unrelated = createNewProject('Unrelated preserved');
    state.projects = [original, unrelated] as unknown as Record<string, unknown>[];
    const targets = mode === 'new' ? [incoming(createNewProject('New import'))]
      : mode === 'mixed' ? [incoming(original), incoming(createNewProject('New mixed import'))] : [incoming(original)];
    acceptDialogs(page, mode === 'copy' ? 'C' : 'U');
    const posts: { projects: ProjectData[]; expectedUpdatedAts: Record<string, string | null> }[] = [];
    let durableBefore: ProjectDraftRecord[] = [];
    await page.context().route('**/api/projects', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { projects: state.projects } });
      durableBefore = await archives(page);
      posts.push(route.request().postDataJSON());
      return route.fulfill({ status: 503, json: { code: 'SYNTHETIC_SAVE_FAILURE' } });
    });
    await page.goto('/');
    await expect(page.locator('.screen-card').filter({ hasText: original.name })).toBeVisible();
    await importFile(page, targets);
    await expect(page.getByTestId('import-save-message')).toContainText('HTTP 503');
    expect(posts).toHaveLength(1);
    const sent = posts[0].projects;
    expect(durableBefore).toHaveLength(targets.length);
    for (const project of sent) {
      const record = durableBefore.find(item => item.project.id === project.id)!;
      expect(record.project).toEqual(project);
      expect(record.importRecovery?.targetIds).toEqual(sent.map(item => item.id));
      expect(record.importRecovery?.expectedUpdatedAt).toBe(posts[0].expectedUpdatedAts[project.id]);
      expect(record.importRecovery?.operationId).toBe(project.lastSaveOperation?.id);
      expect(record.intent).toBeUndefined();
    }
    if (mode === 'copy') { expect(sent[0].id).not.toBe(original.id); expect(sent[0].name).not.toBe(original.name); }
    expect(state.projects).toEqual([original, unrelated]);
    await page.reload();
    await expect(page.getByTestId('import-save-message')).toBeVisible();
    expect(await archives(page)).toEqual(durableBefore);
    await page.getByTestId('save-recovery-toggle').click();
    const recovery = page.getByTestId('import-recovery-record');
    await expect(recovery).toHaveCount(1);
    await expect(recovery.getByRole('button', { name: 'Restore Draft to Editing' })).toHaveCount(0);
    await recovery.getByRole('button', { name: 'Check Import Status', exact: true }).click();
    await expect(recovery).toContainText('No import was resent');
    expect(posts).toHaveLength(1);
    const download = page.waitForEvent('download');
    await recovery.getByRole('button', { name: 'Download Import Backup', exact: true }).click();
    const file = await download;
    await file.saveAs(info.outputPath('import-backup.json'));
    const fs = await import('node:fs/promises');
    const backup = JSON.parse(await fs.readFile(info.outputPath('import-backup.json'), 'utf8'));
    expect(Array.isArray(backup) ? backup : backup.projects).toEqual(sent);
    await info.attach('durability-before-post', { body: JSON.stringify({ durableBefore, posts }), contentType: 'application/json' });
  });
}

for (const failure of ['receipt', 'get-empty', 'get-partial', 'get-failed'] as const) {
  test(`import unverified ${failure}: all records retained; Check never resends`, async ({ page }) => {
    const state = await installLocalEditingMocks(page);
    const originals = [createNewProject('First'), createNewProject('Second')];
    state.projects = originals as unknown as Record<string, unknown>[];
    acceptDialogs(page);
    let posts = 0;
    let sent: ProjectData[] = [];
    await page.context().route('**/api/projects', route => {
      if (route.request().method() === 'POST') {
        posts++; sent = route.request().postDataJSON().projects;
        return route.fulfill({ json: failure === 'receipt' ? { ok: true, projects: [] } : { ok: true, projects: sent } });
      }
      if (!posts) return route.fulfill({ json: { projects: originals } });
      if (failure === 'get-failed') return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: { projects: failure === 'get-partial' ? sent.slice(0, 1) : [] } });
    });
    await page.goto('/'); await expect(page.locator('.screen-card')).toHaveCount(2);
    await importFile(page, originals.map(incoming));
    await expect(page.getByTestId('import-save-message')).not.toHaveText('Saving import…');
    await expect.poll(async () => (await archives(page)).length).toBe(2);
    await expect.poll(() => posts).toBe(1);
    await page.getByTestId('save-recovery-toggle').click();
    const recovery = page.getByTestId('import-recovery-record');
    await recovery.getByRole('button', { name: 'Check Import Status', exact: true }).click();
    await expect(recovery).toContainText('No import was resent');
    expect(posts).toBe(1); expect(await archives(page)).toHaveLength(2);
  });
}

for (const storage of ['fallback', 'unavailable', 'partial'] as const) {
  test(`import durable storage ${storage}: no UI or POST before complete readback`, async ({ page }) => {
    const state = await installLocalEditingMocks(page);
    const originals = [createNewProject('Quota first'), createNewProject('Quota second')];
    state.projects = originals as unknown as Record<string, unknown>[];
    acceptDialogs(page);
    await page.addInitScript(storage => {
      const put = IDBObjectStore.prototype.put, set = Storage.prototype.setItem;
      let importWrites = 0;
      IDBObjectStore.prototype.put = function(value, key) {
        if (value?.importRecovery) {
          importWrites++;
          if (storage !== 'partial' || importWrites > 1) throw new DOMException('Synthetic IDB quota', 'QuotaExceededError');
        }
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
      Storage.prototype.setItem = function(key, value) {
        if (storage !== 'fallback' && key.startsWith('cfs-draft-project-v3:')) throw new DOMException('Synthetic fallback quota', 'QuotaExceededError');
        return set.call(this, key, value);
      };
    }, storage);
    let posts = 0, before: ProjectDraftRecord[] = [];
    await page.context().route('**/api/projects', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { projects: originals } });
      posts++; before = await fallbackArchives(page);
      return route.fulfill({ status: 503, json: { code: 'SYNTHETIC_SAVE_FAILURE' } });
    });
    await page.goto('/'); await expect(page.locator('.screen-card')).toHaveCount(2);
    await importFile(page, originals.map(incoming));
    await expect(page.getByTestId('import-save-message')).toContainText(storage === 'fallback' ? 'HTTP 503' : 'No import was sent');
    expect(posts).toBe(storage === 'fallback' ? 1 : 0);
    if (storage === 'fallback') expect(before).toHaveLength(2);
    else {
      expect(await archives(page)).toHaveLength(storage === 'partial' ? 1 : 0);
      for (const card of await page.locator('.screen-card').all()) await expect(card).toContainText('0 room types');
    }
    await expect(page.getByTestId('import-backup')).toBeVisible();
  });
}

test('import defer retains exact batch, refuses failed GET, adopts authoritative empty, and permits explicit new import', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const original = createNewProject('Defer original');
  state.projects = [original] as unknown as Record<string, unknown>[];
  acceptDialogs(page);
  let posts = 0, failedRead = false, emptyRead = false, success = false;
  let sent: ProjectData[] = [];
  await page.context().route('**/api/projects', route => {
    if (route.request().method() === 'POST') {
      posts++; sent = route.request().postDataJSON().projects;
      if (success) { state.projects = sent as unknown as Record<string, unknown>[]; return route.fulfill({ json: { ok: true, projects: sent } }); }
      return route.fulfill({ status: 503, json: { code: 'SYNTHETIC_SAVE_FAILURE' } });
    }
    return route.fulfill({ status: failedRead ? 503 : 200, json: { projects: emptyRead ? [] : state.projects } });
  });
  await page.goto('/'); await expect(page.locator('.screen-card')).toHaveCount(1);
  await importFile(page, [incoming(original)]);
  await expect(page.getByTestId('import-save-message')).toContainText('HTTP 503');
  const originalRecords = await archives(page);
  await page.getByTestId('save-recovery-toggle').click();
  const recovery = page.getByTestId('import-recovery-record');
  const defer = recovery.getByRole('button', { name: 'Keep Import Recovery and Load Shared Data', exact: true });
  failedRead = true; await defer.click();
  await expect(defer).toBeEnabled();
  expect((await archives(page))[0].importRecovery?.deferredAt).toBeUndefined();
  expect(posts).toBe(1);
  failedRead = false; emptyRead = true; await defer.click();
  await expect(recovery).toContainText('Shared data loaded');
  await expect(page.locator('.screen-card')).toHaveCount(0);
  const retained = await archives(page);
  expect(retained[0].project).toEqual(originalRecords[0].project);
  expect(retained[0].importRecovery?.operationId).toBe(originalRecords[0].importRecovery?.operationId);
  expect(retained[0].importRecovery?.deferredAt).toBeTruthy();
  expect(posts).toBe(1);
  await page.reload(); await expect(page.locator('.screen-card')).toHaveCount(0);
  expect(await archives(page)).toEqual(retained);
  // Explicit normal import uses the fixed prepared ID, not a hidden retry/new copy.
  success = true; emptyRead = false; state.projects = [];
  await importFile(page, sent);
  await expect.poll(() => posts).toBe(2);
  await expect(page.getByTestId('import-save-message')).toHaveCount(0);
  expect(state.projects).toHaveLength(1); expect(state.projects[0].id).toBe(original.id);
});

test('successful import rebases later edits and keeps them durably through reload', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const original = createNewProject('Later editing'); state.projects = [original] as unknown as Record<string, unknown>[];
  acceptDialogs(page);
  let release!: () => void, posts = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sent: ProjectData[] = [];
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { projects: state.projects } });
    posts++; sent = route.request().postDataJSON().projects; await gate;
    state.projects = sent as unknown as Record<string, unknown>[];
    return route.fulfill({ json: { ok: true, projects: sent } });
  });
  await page.goto('/'); await expect(page.locator('.screen-card')).toHaveCount(1);
  await importFile(page, [incoming(original)]); await expect.poll(() => posts).toBe(1);
  await page.locator('.screen-card').filter({ hasText: original.name }).click();
  await page.getByRole('tab', { name: 'Room Type', exact: true }).click();
  await page.getByPlaceholder('New room type name').fill('Later local 日本語');
  await page.getByRole('button', { name: 'Create Room Type', exact: true }).click();
  release();
  await expect(page.getByTestId('import-save-message')).toHaveCount(0);
  await expect(page.locator('.revision-save-status-label')).not.toHaveText('Saved');
  await expect.poll(async () => (await readNativeDraftRecords(page)).some(record => record.project.roomTypes.some(room => room.name === 'Later local 日本語'))).toBe(true);
  expect(state.projects[0]).toEqual(sent[0]);
  await page.reload();
  expect((await readNativeDraftRecords(page)).some(record => record.project.roomTypes.some(room => room.name === 'Later local 日本語'))).toBe(true);
  expect(posts).toBe(1);
});

for (const partial of [false, true]) test(`IDB unavailable: fallback defer ${partial ? 'partial write keeps gate' : 'permits normal shared-data resumption'}`, async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const originals = [createNewProject('Fallback one'), createNewProject('Fallback two')];
  state.projects = originals as unknown as Record<string, unknown>[];
  acceptDialogs(page);
  await page.addInitScript(partial => {
    const open = IDBFactory.prototype.open, set = Storage.prototype.setItem;
    IDBFactory.prototype.open = function(name, version) {
      if (name === 'cfs-drafts') throw new DOMException('Synthetic unavailable IDB', 'UnknownError');
      return version === undefined ? open.call(this, name) : open.call(this, name, version);
    };
    let deferred = 0;
    Storage.prototype.setItem = function(key, value) {
      if (partial && key.startsWith('cfs-draft-project-v3:') && JSON.parse(value)?.importRecovery?.deferredAt && ++deferred === 2) {
        throw new DOMException('Synthetic mid-defer quota', 'QuotaExceededError');
      }
      return set.call(this, key, value);
    };
  }, partial);
  let posts = 0;
  await page.context().route('**/api/projects', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { projects: state.projects } });
    posts++; return route.fulfill({ status: 503, json: { code: 'SYNTHETIC_SAVE_FAILURE' } });
  });
  await page.goto('/'); await expect(page.locator('.screen-card')).toHaveCount(2);
  await importFile(page, originals.map(incoming));
  await expect(page.getByTestId('import-save-message')).toContainText('HTTP 503');
  const before = await fallbackArchives(page);
  await page.getByTestId('save-recovery-toggle').click();
  const recovery = page.getByTestId('import-recovery-record');
  await recovery.getByRole('button', { name: 'Keep Import Recovery and Load Shared Data', exact: true }).click();
  if (partial) {
    await expect(recovery).toContainText('Synthetic mid-defer quota');
    await expect(page.getByTestId('import-save-message')).toBeVisible();
    for (const card of await page.locator('.screen-card').all()) await expect(card).toContainText('1 room types');
  } else {
    await expect(recovery).toContainText('Shared data loaded');
    for (const card of await page.locator('.screen-card').all()) await expect(card).toContainText('0 room types');
  }
  const after = await fallbackArchives(page);
  expect(after.map(record => record.project)).toEqual(before.map(record => record.project));
  expect(after.filter(record => record.importRecovery?.deferredAt)).toHaveLength(partial ? 1 : 2);
  expect(posts).toBe(1);
  await page.reload();
  await expect(page.getByTestId('save-recovery-toggle')).toBeVisible();
  expect(await fallbackArchives(page)).toEqual(after);
  if (!partial) {
    await expect(page.getByTestId('import-save-message')).toHaveCount(0);
    await importFile(page, originals.map(incoming));
    await expect.poll(() => posts).toBe(2);
  } else {
    await importFile(page, originals.map(incoming));
    await expect(page.getByTestId('import-save-message')).toBeVisible();
    expect(posts).toBe(1);
  }
});

test('batch validation rejects missing, duplicate, mutated and mixed-defer records without changing legacy draft semantics', async () => {
  const prepared = await Promise.all([createNewProject('One'), createNewProject('Two')].map(project => prepareProjectSave(project, 'current')));
  const scope = { workspace: 'synthetic', owner: 'synthetic', tab: 'recovery:import:batch' };
  const records: ProjectDraftRecord[] = prepared.map(project => ({ project, scope, key: JSON.stringify([scope.workspace, scope.owner, project.id, scope.tab]),
    generation: 1, savedAt: '2032-01-01', baseUpdatedAt: null, importRecovery: { version: 1, batchId: 'batch', targetIds: prepared.map(item => item.id),
      expectedUpdatedAt: null, operationId: project.lastSaveOperation!.id, action: 'new' } }));
  expect(records.every(validDraftRecord)).toBe(true);
  await verifyImportBatch(records, prepared);
  expect(completeImportBatch(records.slice(0, 1))).toBe(false);
  expect(completeImportBatch([records[0], records[0]])).toBe(false);
  const mutated = structuredClone(records); mutated[0].project.name = 'changed';
  await expect(verifyImportBatch(mutated)).rejects.toThrow('contents');
  const mixed = structuredClone(records); mixed[0].importRecovery!.deferredAt = '2032-01-01'; mixed[1].importRecovery!.deferredAt = '2032-01-02';
  expect(deferredImportBatch(mixed)).toBe(false);
  const malformed = structuredClone(records[0]); delete malformed.importRecovery;
  expect(validDraftRecord(malformed)).toBe(false);
  const legacy = { ...malformed, scope: { ...scope, tab: 'legacy-normal-tab' }, key: JSON.stringify([scope.workspace, scope.owner, malformed.project.id, 'legacy-normal-tab']) };
  expect(validDraftRecord(legacy)).toBe(true);
});

test('view change while preparing aborts before UI replacement or POST', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const original = createNewProject('Prepare source'); state.projects = [original] as unknown as Record<string, unknown>[];
  const alerts: string[] = [];
  page.on('dialog', dialog => { if (dialog.type() === 'alert') alerts.push(dialog.message()); void dialog.accept(dialog.type() === 'prompt' ? 'U' : undefined); });
  let posts = 0;
  await page.context().route('**/api/projects', route => {
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ status: 503, json: {} }); }
    return route.fulfill({ json: { projects: state.projects } });
  });
  await page.goto('/'); await expect(page.locator('.screen-card')).toHaveCount(1);
  await page.evaluate(() => {
    const state = window as unknown as { digestStarted: boolean; releaseDigest: () => void };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const gate = new Promise<void>(resolve => { state.releaseDigest = resolve; });
    crypto.subtle.digest = async (...args) => { state.digestStarted = true; await gate; return digest(...args); };
  });
  await importFile(page, [incoming(original)]);
  await expect.poll(() => page.evaluate(() => (window as unknown as { digestStarted: boolean }).digestStarted)).toBe(true);
  await page.locator('.screen-card').click();
  await page.evaluate(() => (window as unknown as { releaseDigest: () => void }).releaseDigest());
  await expect.poll(() => alerts.some(message => message.includes('No import was sent'))).toBe(true);
  expect(posts).toBe(0); expect(await archives(page)).toHaveLength(0);
  expect(state.projects).toEqual([original]);
});

test('Check Import Status advances the confirmed baseline before the next Current save', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const original = createNewProject('Check baseline'); state.projects = [original] as unknown as Record<string, unknown>[];
  acceptDialogs(page);
  const posts: Record<string, unknown>[] = [];
  const confirmedTime = '2035-01-01T00:00:00.000Z';
  await page.context().route('**/api/projects', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { projects: state.projects } });
    const body = route.request().postDataJSON(); posts.push(body);
    if (posts.length === 1) {
      state.projects = body.projects.map((project: ProjectData) => ({ ...project, updatedAt: confirmedTime }));
      return route.fulfill({ json: { ok: true, projects: [] } });
    }
    state.projects = [body.project];
    return route.fulfill({ json: { ok: true, project: body.project, projects: state.projects } });
  });
  await page.goto('/'); await expect(page.locator('.screen-card')).toHaveCount(1);
  await importFile(page, [incoming(original)]);
  await expect(page.getByTestId('import-save-message')).toContainText('SAVE_RESPONSE_INVALID');
  await page.getByTestId('save-reliability-alert').getByRole('button', { name: 'Check Import Status', exact: true }).click();
  await expect(page.getByTestId('import-save-message')).toHaveCount(0);
  await page.locator('.screen-card').click();
  await page.getByRole('tab', { name: 'Room Type', exact: true }).click();
  await page.getByPlaceholder('New room type name').fill('After confirmed import');
  await page.getByRole('button', { name: 'Create Room Type', exact: true }).click();
  await page.getByRole('button', { name: 'Save current project without a new revision', exact: true }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1].expectedUpdatedAt).toBe(confirmedTime);
  await expect(page.locator('.revision-save-status-label')).toHaveText('Saved');
});

test('malformed import metadata stays raw-export-only after opening its project', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const project = createNewProject('Malformed recovery 日本語'); state.projects = [project] as unknown as Record<string, unknown>[];
  await page.addInitScript(project => {
    localStorage.setItem('cfs-collaboration-user-v1', JSON.stringify({ id: 'mock-user', displayName: 'Synthetic tester' }));
    const scope = { workspace: `local:${location.origin}`, owner: 'mock-user', tab: 'recovery:import:broken' };
    const key = JSON.stringify([scope.workspace, scope.owner, project.id, scope.tab]);
    localStorage.setItem(`cfs-draft-project-v3:${key}`, JSON.stringify({ key, scope, project, generation: 1, savedAt: '2032-01-01', baseUpdatedAt: null,
      importRecovery: { version: 1, batchId: 'broken', targetIds: { invalid: true }, action: 'new', expectedUpdatedAt: null, operationId: 'missing' } }));
  }, project);
  let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects') writes++; });
  await page.goto('/'); await expect(page.locator('.screen-card')).toHaveCount(1);
  await page.locator('.screen-card').click();
  await page.getByTestId('save-recovery-toggle').click();
  const recovery = page.getByTestId('import-recovery-record');
  await expect(recovery).toContainText('could not be verified');
  await expect(recovery.getByRole('button', { name: 'Check Import Status', exact: true })).toBeDisabled();
  await expect(recovery.getByRole('button', { name: 'Export Original Import Recovery', exact: true })).toBeEnabled();
  await expect(page.getByTestId('recovery-return-to-editor')).toHaveCount(0);
  expect(await fallbackArchives(page)).toHaveLength(1); expect(writes).toBe(0);
});

for (const fallback of [false, true]) test(`complete import confirmation ${fallback ? 'fallback partial marker' : 'IDB transaction abort'} retains all original members and Check can finish`, async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const originals = [createNewProject('Confirm one'), createNewProject('Confirm two')];
  state.projects = originals as unknown as Record<string, unknown>[];
  acceptDialogs(page);
  await page.addInitScript(fallback => {
    const open = IDBFactory.prototype.open, put = IDBObjectStore.prototype.put, set = Storage.prototype.setItem;
    let confirmed = 0;
    if (fallback) IDBFactory.prototype.open = function(name, version) {
      if (name === 'cfs-drafts') throw new DOMException('Synthetic unavailable IDB', 'UnknownError');
      return version === undefined ? open.call(this, name) : open.call(this, name, version);
    };
    IDBObjectStore.prototype.put = function(value, key) {
      if (!fallback && value?.importRecovery?.confirmedAt && ++confirmed === 2) throw new DOMException('Synthetic confirmation abort', 'QuotaExceededError');
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (fallback && key.startsWith('cfs-draft-project-v3:') && JSON.parse(value)?.importRecovery?.confirmedAt && ++confirmed === 2) throw new DOMException('Synthetic confirmation quota', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  }, fallback);
  let posts = 0;
  let sent: ProjectData[] = [];
  await page.context().route('**/api/projects', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { projects: state.projects } });
    posts++; sent = route.request().postDataJSON().projects;
    state.projects = sent as unknown as Record<string, unknown>[];
    return route.fulfill({ json: { ok: true, projects: sent } });
  });
  await page.goto('/'); await expect(page.locator('.screen-card')).toHaveCount(2);
  await importFile(page, originals.map(incoming));
  await expect(page.getByTestId('import-save-message')).toContainText(fallback ? 'Synthetic confirmation quota' : 'Local draft storage failed');
  const read = () => fallback ? fallbackArchives(page) : archives(page);
  const retained = await read();
  expect(retained).toHaveLength(2); expect(confirmedImportBatch(retained)).toBe(false);
  for (const record of retained) expect(record.project).toEqual(sent.find(project => project.id === record.project.id));
  await page.getByTestId('save-reliability-alert').getByRole('button', { name: 'Check Import Status', exact: true }).click();
  await expect(page.getByTestId('import-save-message')).toHaveCount(0);
  const confirmed = await read();
  expect(confirmed).toHaveLength(2); expect(confirmedImportBatch(confirmed)).toBe(true);
  expect(posts).toBe(1);
  for (const record of confirmed) expect(record.project).toEqual(sent.find(project => project.id === record.project.id));
  await page.reload(); await expect(page.getByTestId('save-recovery-toggle')).toBeVisible();
  await expect(page.getByTestId('import-save-message')).toHaveCount(0);
});

test('partial initial checkpoint remains incomplete but explicit shared-data resumption restores normal Current', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const originals = [createNewProject('Partial one'), createNewProject('Partial two'), createNewProject('Partial three')];
  state.projects = originals as unknown as Record<string, unknown>[];
  acceptDialogs(page);
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put, set = Storage.prototype.setItem;
    let writes = 0;
    IDBObjectStore.prototype.put = function(value, key) {
      if (value?.importRecovery && ++writes === 2) throw new DOMException('Synthetic partial import quota', 'QuotaExceededError');
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('cfs-draft-project-v3:') && JSON.parse(value)?.importRecovery) throw new DOMException('Synthetic import fallback quota', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  });
  let posts = 0;
  await page.context().route('**/api/projects', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { projects: state.projects } });
    posts++; const body = route.request().postDataJSON();
    state.projects = state.projects.map(project => project.id === body.project.id ? body.project : project);
    return route.fulfill({ json: { ok: true, project: body.project, projects: state.projects } });
  });
  await page.goto('/'); await expect(page.locator('.screen-card')).toHaveCount(3);
  await importFile(page, originals.map(incoming));
  await expect(page.getByTestId('import-save-message')).toContainText('No import was sent');
  const raw = await archives(page); expect(raw).toHaveLength(1); expect(posts).toBe(0);
  await page.reload(); await expect(page.getByTestId('import-save-message')).toBeVisible();
  await page.getByTestId('save-recovery-toggle').click();
  const recovery = page.getByTestId('import-recovery-record');
  await expect(recovery).toContainText('cannot be restored');
  await expect(recovery.getByRole('button', { name: 'Check Import Status', exact: true })).toBeDisabled();
  await recovery.getByRole('button', { name: 'Keep Import Recovery and Load Shared Data', exact: true }).click();
  await expect(recovery).toContainText('Shared data loaded');
  expect(posts).toBe(0);
  const retained = await archives(page);
  expect(retained).toHaveLength(1); expect(retained[0].project).toEqual(raw[0].project);
  expect(completeImportBatch(retained)).toBe(false); expect(confirmedImportBatch(retained)).toBe(false);
  await page.locator('.screen-card').filter({ hasText: originals[2].name }).click();
  await page.getByRole('tab', { name: 'Room Type', exact: true }).click();
  await page.getByPlaceholder('New room type name').fill('Normal work resumed');
  await page.getByRole('button', { name: 'Create Room Type', exact: true }).click();
  await page.getByRole('button', { name: 'Save current project without a new revision', exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await expect(page.locator('.revision-save-status-label')).toHaveText('Saved');
});

test('a missing confirmed member is not confirmed; retained subset can explicitly load shared data', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const project = await prepareProjectSave(createNewProject('Missing confirmed member'), 'current');
  state.projects = [project] as unknown as Record<string, unknown>[];
  acceptDialogs(page);
  await page.addInitScript(project => {
    localStorage.setItem('cfs-collaboration-user-v1', JSON.stringify({ id: 'mock-user', displayName: 'Synthetic tester' }));
    const scope = { workspace: `local:${location.origin}`, owner: 'mock-user', tab: 'recovery:import:missing-confirmed' };
    const key = JSON.stringify([scope.workspace, scope.owner, project.id, scope.tab]);
    localStorage.setItem(`cfs-draft-project-v3:${key}`, JSON.stringify({ key, scope, project, generation: 1, savedAt: '2032-01-01', baseUpdatedAt: null,
      importRecovery: { version: 1, batchId: 'missing-confirmed', targetIds: [project.id, 'missing-project'], action: 'new', expectedUpdatedAt: null,
        operationId: project.lastSaveOperation!.id, confirmedAt: '2032-01-01' } }));
  }, project);
  let posts = 0; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects') posts++; });
  await page.goto('/'); await expect(page.getByTestId('import-save-message')).toBeVisible();
  await page.getByTestId('save-recovery-toggle').click();
  const recovery = page.getByTestId('import-recovery-record');
  await expect(recovery).not.toContainText('Verified import backup retained');
  await recovery.getByRole('button', { name: 'Keep Import Recovery and Load Shared Data', exact: true }).click();
  await expect(recovery).toContainText('Shared data loaded');
  await expect(recovery).toContainText('cannot be restored');
  expect(posts).toBe(0); expect(state.projects).toEqual([project]);
  await page.reload(); await expect(page.getByTestId('save-recovery-toggle')).toBeVisible();
  await expect(page.getByTestId('import-save-message')).toHaveCount(0);
  expect(posts).toBe(0);
});

test('confirmed commit with failed readback is recoverable by Check in the same view', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const original = createNewProject('Readback recovery'); state.projects = [original] as unknown as Record<string, unknown>[];
  acceptDialogs(page);
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put, getAll = IDBObjectStore.prototype.getAll;
    let failRead = false, armed = true;
    IDBObjectStore.prototype.put = function(value, key) {
      if (armed && value?.importRecovery?.confirmedAt) { armed = false; failRead = true; }
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
    IDBObjectStore.prototype.getAll = function(...args) {
      if (failRead) { failRead = false; throw new DOMException('Synthetic readback failure after commit', 'UnknownError'); }
      return getAll.apply(this, args);
    };
  });
  let posts = 0;
  await page.context().route('**/api/projects', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { projects: state.projects } });
    posts++; state.projects = route.request().postDataJSON().projects;
    return route.fulfill({ json: { ok: true, projects: state.projects } });
  });
  await page.goto('/'); await expect(page.locator('.screen-card')).toHaveCount(1);
  await importFile(page, [incoming(original)]);
  await expect(page.getByTestId('import-save-message')).toContainText('Synthetic readback failure');
  const committed = await archives(page); expect(confirmedImportBatch(committed)).toBe(true);
  await page.getByTestId('save-reliability-alert').getByRole('button', { name: 'Check Import Status', exact: true }).click();
  await expect(page.getByTestId('import-save-message')).toHaveCount(0);
  expect(await archives(page)).toEqual(committed); expect(posts).toBe(1);
});

test('edits during confirmation readback keep the gate until their latest contents are archived', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const original = createNewProject('Confirmation later edits'); state.projects = [original] as unknown as Record<string, unknown>[];
  acceptDialogs(page);
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put, open = IDBFactory.prototype.open;
    let hold = false, armed = true;
    IDBObjectStore.prototype.put = function(value, key) {
      if (armed && value?.importRecovery?.confirmedAt) { hold = true; armed = false; }
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
    IDBFactory.prototype.open = function(name, version) {
      const request = version === undefined ? open.call(this, name) : open.call(this, name, version);
      if (hold && name === 'cfs-drafts') {
        hold = false;
        let callback: ((this: IDBRequest, event: Event) => unknown) | null = null;
        Object.defineProperty(request, 'onsuccess', { configurable: true, get: () => callback, set: value => { callback = value; } });
        request.addEventListener('success', event => {
          (window as unknown as { releaseImportRead: () => void }).releaseImportRead = () => callback?.call(request, event);
        });
      }
      return request;
    };
  });
  let posts = 0;
  await page.context().route('**/api/projects', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { projects: state.projects } });
    posts++; state.projects = route.request().postDataJSON().projects;
    return route.fulfill({ json: { ok: true, projects: state.projects } });
  });
  await page.goto('/'); await expect(page.locator('.screen-card')).toHaveCount(1);
  await importFile(page, [incoming(original)]);
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseImportRead: unknown }).releaseImportRead)).toBe('function');
  await page.locator('.screen-card').click();
  await page.getByRole('tab', { name: 'Room Type', exact: true }).click();
  await page.getByPlaceholder('New room type name').fill('During confirmation 日本語');
  await page.getByRole('button', { name: 'Create Room Type', exact: true }).click();
  await page.evaluate(() => (window as unknown as { releaseImportRead: () => void }).releaseImportRead());
  await expect(page.getByTestId('import-save-message')).toContainText('local edits changed');
  await page.getByTestId('save-reliability-alert').getByRole('button', { name: 'Check Import Status', exact: true }).click();
  await expect(page.getByTestId('import-save-message')).toHaveCount(0);
  expect((await readNativeDraftRecords(page)).some(record => record.scope.tab.startsWith('recovery:') && !record.scope.tab.startsWith('recovery:import:')
    && record.project.roomTypes.some(room => room.name === 'During confirmation 日本語'))).toBe(true);
  await page.reload();
  expect((await readNativeDraftRecords(page)).some(record => record.project.roomTypes.some(room => room.name === 'During confirmation 日本語'))).toBe(true);
  expect(posts).toBe(1);
});

for (const action of ['confirm', 'defer'] as const) test(`refresh observes another tab's higher generation before ${action} marking`, async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const original = createNewProject('Higher durable generation'); state.projects = [original] as unknown as Record<string, unknown>[];
  acceptDialogs(page);
  let posts = 0;
  await page.context().route('**/api/projects', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { projects: state.projects } });
    posts++;
    if (action === 'confirm') state.projects = route.request().postDataJSON().projects;
    return route.fulfill({ status: 503, json: { code: 'SYNTHETIC_SAVE_FAILURE' } });
  });
  await page.goto('/'); await expect(page.locator('.screen-card')).toHaveCount(1);
  await importFile(page, [incoming(original)]);
  await expect(page.getByTestId('import-save-message')).toContainText('HTTP 503');
  const record = (await archives(page))[0];
  const higher = record.generation + 1_000_000_000;
  // Synthetic external-tab durable write; the application RAM generation stays old.
  await page.evaluate(({ record, higher }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('cfs-drafts');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put({ ...record, generation: higher });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { record, higher });
  await page.getByTestId('save-recovery-toggle').click();
  const recovery = page.getByTestId('import-recovery-record');
  await recovery.getByRole('button', { name: action === 'confirm' ? 'Check Import Status' : 'Keep Import Recovery and Load Shared Data', exact: true }).click();
  await expect(page.getByTestId('import-save-message')).toHaveCount(0);
  const marked = (await archives(page))[0];
  expect(marked.generation).toBeGreaterThan(higher);
  expect(marked.project).toEqual(record.project);
  expect(marked.importRecovery?.[action === 'confirm' ? 'confirmedAt' : 'deferredAt']).toBeTruthy();
  expect(posts).toBe(1);
});

test('native read failure cannot replace known confirmed recovery with older deferred fallback', async () => {
  const owner = { workspace: 'synthetic-refresh', owner: 'synthetic-owner', tab: 'editor' };
  const project = await prepareProjectSave(createNewProject('Synthetic native fallback boundary'), 'current');
  const archiveScope = { ...owner, tab: 'recovery:import:refresh-boundary' };
  const key = JSON.stringify([owner.workspace, owner.owner, project.id, archiveScope.tab]);
  const low: ProjectDraftRecord = { key, scope: archiveScope, project, baseUpdatedAt: null, generation: 100, savedAt: '2030-01-01',
    importRecovery: { version: 1, batchId: 'refresh-boundary', targetIds: [project.id], expectedUpdatedAt: null,
      operationId: project.lastSaveOperation!.id, action: 'new', deferredAt: '2030-01-01' } };
  const high = structuredClone(low); high.generation = 200;
  delete high.importRecovery!.deferredAt; high.importRecovery!.confirmedAt = '2030-01-02';
  const values = new Map([['cfs-draft-project-v3:' + key, JSON.stringify(low)]]);
  let unavailable = false;
  const oldIdb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => values.set(name, value) };
  const idb = { open() {
    if (unavailable) throw new Error('Synthetic native read failure');
    const request: { onsuccess?: () => void; result: unknown } = { result: { close() {}, transaction() {
      const tx: { oncomplete?: () => void; objectStore: () => unknown } = { objectStore: () => ({ getAll() {
        const read: { result?: ProjectDraftRecord[]; onsuccess?: () => void } = {};
        queueMicrotask(() => { read.result = [structuredClone(high)]; read.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); });
        return read;
      } }) };
      return tx;
    } } };
    queueMicrotask(() => request.onsuccess?.()); return request;
  } };
  try {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: idb });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    const initial = await initializeProjectDrafts(owner);
    expect(initial).toEqual([high]);
    unavailable = true;
    await expect(refreshProjectImport(initial, owner)).rejects.toThrow('latest import recovery could not be verified');
    expect(cachedDraftRecords()).toEqual([high]);
    expect(JSON.parse(values.get('cfs-draft-project-v3:' + key)!)).toEqual(low);
    // Equal available bytes remain usable in a fallback-only environment.
    values.set('cfs-draft-project-v3:' + key, JSON.stringify(high));
    await expect(refreshProjectImport(initial, owner)).resolves.toEqual([high]);
  } finally {
    if (oldIdb) Object.defineProperty(globalThis, 'indexedDB', oldIdb); else Reflect.deleteProperty(globalThis, 'indexedDB');
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
