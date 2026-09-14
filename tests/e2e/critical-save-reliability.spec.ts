import { test, expect, type Page } from './support/safe-test';
import { openSaveRecovery } from './support/save-recovery-ui';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createNewProject, createProjectBackupPayload, migrateProjectsWithReport, normalizeProjectSave, prepareProjectSave, getPendingMigrationReport } from '../../app/lib/storage';
import { createNewRoomType, createEmptySwitchEntry } from '../../app/lib/constants';
import { matchesSaveIntent, projectFingerprint } from '../../app/lib/projectSaveProtocol';
import { appendCommonRevision } from '../../app/lib/projectCommonHistory';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { readNativeDraftRecords } from './support/native-project-drafts';

const wireSwitchKinds = ['contact', 'lutronPd', 'lutronPico', 'command', 'tstat', 'pir', 'qsm'] as const;
function wireSwitchProject() {
  const project = createNewProject('Synthetic switch wire');
  const room = createNewRoomType('Seven switch kinds');
  room.switches = wireSwitchKinds.map((kind, index) => ({ ...createEmptySwitchEntry(kind), id: `wire-switch-${index}`,
    switchName: `Switch ${index}`, buttonLabel: `Label ${index}`, settingLinkGroupId: `link-${index}` }));
  room.revisions = [{ id: 'old-wire-rev', revision: '1.00', savedAt: '2026-09-10T00:00:00Z', savedBy: 'Synthetic', note: '',
    snapshot: '{"unknown":{"literal":"undefined", "spacing": "retain"}}' }];
  project.roomTypes = [room];
  return project;
}

test('normalization wire keeps seven switch kinds through factory, migrated RAM, priority clear and repeated saves', () => {
  const factory = wireSwitchProject();
  for (const input of [factory, migrateProjectsWithReport([factory]).projects[0]]) {
    const before = structuredClone(input);
    let normalized = normalizeProjectSave(input);
    expect(normalized.roomTypes[0].switches.map(sw => sw.id)).toEqual(factory.roomTypes[0].switches.map(sw => sw.id));
    expect(input).toEqual(before);
    expect(normalized.roomTypes[0].revisions[0].snapshot).toBe(factory.roomTypes[0].revisions[0].snapshot);
    for (let index = 0; index < 3; index++) { const previous = normalized; normalized = normalizeProjectSave(normalized); expect(normalized).toEqual(previous); }
  }
  for (const priority of [true, false, undefined]) {
    const input = wireSwitchProject();
    input.roomTypes[0].switches = input.roomTypes[0].switches.flatMap(sw => [
      { ...sw, isPriorityFunction: priority }, { ...sw, id: `${sw.id}-secondary`, isPriorityFunction: undefined },
    ]);
    const normalized = normalizeProjectSave(input);
    expect(normalized.roomTypes[0].switches).toHaveLength(14);
    normalized.roomTypes[0].switches.forEach((sw, index) => {
      expect(sw.id).toBe(input.roomTypes[0].switches[index].id);
      expect(sw.buttonLabel).toBe(input.roomTypes[0].switches[index].buttonLabel);
      expect(sw.settingLinkGroupId).toBe(input.roomTypes[0].switches[index].settingLinkGroupId);
      expect(Boolean(sw.isPriorityFunction)).toBe(index % 2 === 0 && priority === true && !['command', 'pir', 'qsm'].includes(sw.kind));
      if (!sw.isPriorityFunction) expect(Object.hasOwn(sw, 'isPriorityFunction')).toBe(false);
    });
  }
});

test('normalization wire preserves invalid array and scalar diagnostics and rejects cycles finitely', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent() {} } });
  try {
    for (const invalid of ['true', 1, null, [], {}, NaN]) {
      const input = wireSwitchProject();
      (input.roomTypes[0].switches[0] as any).isPriorityFunction = invalid;
      const normalized = normalizeProjectSave(input);
      expect(normalized.roomTypes[0].switches).toHaveLength(6);
      expect(getPendingMigrationReport()?.issues.some(issue => issue.path.endsWith('.switches') && issue.action === 'excluded' && issue.count >= 1)).toBe(true);
      expect((input.roomTypes[0].switches[0] as any).isPriorityFunction).toBe(invalid);
    }
    const input = wireSwitchProject();
    input.roomTypes[0].switches.push(undefined as any, null as any, NaN as any);
    input.roomTypes[0].switches.length++;
    const normalized = normalizeProjectSave(input);
    expect(normalized.roomTypes[0].switches).toHaveLength(7);
    expect(getPendingMigrationReport()?.issues.some(issue => issue.path.endsWith('.switches') && issue.count >= 4)).toBe(true);
    expect(input.roomTypes[0].switches[7]).toBeUndefined(); expect(input.roomTypes[0].switches[8]).toBeNull();
    expect(Number.isNaN(input.roomTypes[0].switches[9])).toBe(true); expect(10 in input.roomTypes[0].switches).toBe(false);
    const cyclic = wireSwitchProject(); (cyclic as any).unknownCycle = cyclic;
    expect(() => normalizeProjectSave(cyclic)).toThrow(/circular references/);
    for (const invalid of [new Date(0), new Map([['key', 'value']]), new Set(['value'])]) {
      const unknown = wireSwitchProject(); (unknown as any).unknownObject = invalid;
      expect(() => normalizeProjectSave(unknown)).toThrow(/non-JSON/);
      expect((unknown as any).unknownObject).toBe(invalid);
      const history = appendCommonRevision(wireSwitchProject(), 'Synthetic', 'history');
      (history.commonRevisions![0].snapshot as any).settings = invalid;
      expect(() => normalizeProjectSave(history)).toThrow(/non-JSON/);
      expect(history.commonRevisions![0].snapshot.settings).toBe(invalid);
    }
    const ownKeys = appendCommonRevision(wireSwitchProject(), 'Synthetic', 'own keys');
    const settings = JSON.parse('{"__proto__":{"polluted":"retained-data"},"constructor":"own-data","optional":null}');
    (ownKeys.commonRevisions![0].snapshot as any).settings = settings;
    const retained = normalizeProjectSave(ownKeys).commonRevisions![0].snapshot.settings!;
    expect(Object.getPrototypeOf(retained)).toBe(Object.prototype);
    expect(Object.hasOwn(retained, '__proto__')).toBe(true);
    expect((retained as any).__proto__).toEqual({ polluted: 'retained-data' });
    expect(({} as any).polluted).toBeUndefined();
    expect(retained).toEqual(settings);
  } finally { if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); }
});

test('normalization wire Current NewRev idle keeps all kinds, immutable requests and exact JSON receipts', async () => {
  for (const kind of ['current', 'revision', 'idle'] as const) {
    const input = migrateProjectsWithReport([wireSwitchProject()]).projects[0], before = structuredClone(input);
    const sent = await prepareProjectSave(input, kind, `wire-operation-${kind}`);
    expect(sent.roomTypes[0].switches).toHaveLength(7);
    expect(input).toEqual(before);
    expect(sent.lastSaveOperation?.fingerprint).toBe(await projectFingerprint(sent));
    expect(await matchesSaveIntent(sent, JSON.parse(JSON.stringify(sent)))).toBe(true);
    expect(await prepareProjectSave(sent, kind, sent.lastSaveOperation!.id)).toEqual(sent);
    expect(sent.roomTypes[0].revisions[0].snapshot).toBe(input.roomTypes[0].revisions[0].snapshot);
  }
});

// Isolated real-browser IndexedDB harness. No application API or customer data.
function bundle() {
  const names = ['canonicalJson', 'id', 'projectDraftStore', 'projectSaveProtocol', 'projectSaveState', 'projectCommonHistory'];
  return Object.fromEntries(names.map(name => [name, ts.transpileModule(fs.readFileSync(path.resolve(`app/lib/${name}.ts`), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText]));
}
async function harness(page: Page) {
  await page.route('**/critical-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>synthetic draft harness</title>' }));
  await page.goto('/critical-harness');
  await page.evaluate(sources => {
    const modules: Record<string, { exports: Record<string, unknown> }> = {};
    const require = (name: string): Record<string, unknown> => {
      name = name.replace('./', '');
      if (!modules[name]) { const module = { exports: {} }; modules[name] = module; new Function('require', 'exports', 'module', sources[name])(require, module.exports, module); }
      return modules[name].exports;
    };
    Object.assign(window, { draftHarness: { store: require('projectDraftStore'), protocol: require('projectSaveProtocol'), state: require('projectSaveState'), history: require('projectCommonHistory') } });
  }, bundle());
}

test('IndexedDB survives quota, restart, owner separation, immutable intent and latest generation', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async project => {
    const { store, protocol, state } = (window as any).draftHarness;
    const owner = { workspace: 'synthetic', owner: 'A', tab: 'first-document' };
    await store.initializeProjectDrafts(owner);
    const sent = await protocol.prepareSaveProject(project, 'revision', 'same-operation');
    const intent = { before: structuredClone(project), project: sent, expectedUpdatedAt: project.updatedAt, operationId: 'same-operation' };
    const first = await store.checkpointProject(project, project.updatedAt, intent, owner);
    const edited = { ...project, name: 'typed-after-send' };
    const latest = await store.checkpointProject(edited, project.updatedAt, undefined, owner);
    await store.removeConfirmedDraft(first);
    const recovered = await store.initializeProjectDrafts({ ...owner, tab: 'second-document' });
    const merged = state.rebaseProjectSave({ before: recovered[0].intent.before, saved: sent }, recovered[0].project);
    const another = { workspace: 'synthetic', owner: 'B', tab: 'third-document' };
    await store.initializeProjectDrafts(another);
    await store.checkpointProject({ ...edited, name: 'old-owner-flush' }, project.updatedAt, undefined, owner);
    const b = await store.initializeProjectDrafts(another);
    const originalIdb = indexedDB;
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    // Another owner's RAM cache cannot prove that this old key has no unresolved intent.
    const blockedFallback = await store.checkpointProject({ ...edited, name: 'must-not-hide-unknown' }, project.updatedAt, undefined, owner);
    const fallbackBeforeQuota = localStorage.getItem('cfs-draft-project-v3:' + first.key);
    const originalSet = Storage.prototype.setItem;
    localStorage.setItem('cfs-project-drafts-v2', 'prior-legacy-draft');
    Storage.prototype.setItem = function() { throw new DOMException('injected quota', 'QuotaExceededError'); };
    await store.initializeProjectDrafts(owner);
    const failed = await store.checkpointProject({ ...edited, name: 'quota-edit' }, project.updatedAt, undefined, owner);
    const legacy = localStorage.getItem('cfs-project-drafts-v2');
    Storage.prototype.setItem = originalSet;
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: originalIdb });
    const afterFailure = await store.initializeProjectDrafts({ ...owner, tab: 'restart' });
    return { first: Boolean(first), latest: Boolean(latest), recovered: recovered[0].project.name, before: recovered[0].intent.before.name,
      merged: merged.name, b: b.length, failed, legacy, afterFailure: afterFailure[0].project.name,
      blockedFallback, fallbackBeforeQuota, retainedOperation: afterFailure[0].intent?.operationId };
  }, createNewProject('original'));
  expect(result).toMatchObject({ first: true, latest: true, recovered: 'typed-after-send', before: 'original', merged: 'typed-after-send', b: 0, failed: null, legacy: 'prior-legacy-draft', afterFailure: 'old-owner-flush' });
  expect(result).toMatchObject({ blockedFallback: null, fallbackBeforeQuota: null, retainedOperation: 'same-operation' });
});

test('save deadline includes stalled response body; strict receipt rejects same timestamp wrong content', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async project => {
    const { protocol } = (window as any).draftHarness;
    const sent = await protocol.prepareSaveProject(project, 'current', 'operation');
    const exact = await protocol.matchesSaveIntent(sent, { ...sent, updatedAt: '2031-01-01T00:00:00.000Z' });
    const wrong = await protocol.matchesSaveIntent(sent, { ...sent, name: 'wrong-body' });
    const original = window.fetch;
    window.fetch = async () => new Response(new ReadableStream({ start() {} }));
    const started = performance.now();
    let code = '';
    try { await protocol.finiteFetch('/synthetic', {}, 80); } catch (error) { code = (error as { code: string }).code; }
    window.fetch = original;
    return { exact, wrong, code, elapsed: performance.now() - started };
  }, createNewProject('receipt'));
  expect(result).toMatchObject({ exact: true, wrong: false, code: 'SAVE_RESULT_UNKNOWN' });
  expect(result.elapsed).toBeLessThan(1000);
});

test('archived readback keeps derived recovery separate from the current edited tab', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async project => {
    const { store } = (window as any).draftHarness;
    const owner = { workspace: 'synthetic', owner: 'A', tab: 'current' };
    await store.initializeProjectDrafts(owner);
    const first = await store.checkpointProject(project, project.updatedAt, null, owner);
    await store.checkpointProject({ ...project, name: 'current-new-edit' }, project.updatedAt, null, owner);
    await store.preserveRecoveryProject({ ...project, name: 'archived-old-edit' }, project.updatedAt, owner);
    await store.removeConfirmedDraft(first);
    const records = await store.initializeProjectDrafts({ ...owner, tab: 'restart' });
    return records.map((record: any) => ({ tab: record.scope.tab, name: record.project.name }));
  }, createNewProject('old'));
  expect(result).toContainEqual({ tab: 'current', name: 'current-new-edit' });
  expect(result.find((item: { tab: string; name: string }) => item.tab.startsWith('recovery:'))?.name).toBe('archived-old-edit');
});

test('common-only revision is non-recursive, preserves room history and rejects malformed duplicate history', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(project => {
    const { history } = (window as any).draftHarness;
    const first = history.appendCommonRevision(project, '自動保存', 'Tester');
    const second = history.appendCommonRevision({ ...first, remarks: [{ id: 'remark', title: 'new', body: 'preserved' }] }, '自動保存', 'Tester');
    return { notes: second.commonRevisions.map((rev: any) => rev.note), revisions: second.commonRevisions.map((rev: any) => rev.revision),
      recursive: 'commonRevisions' in second.commonRevisions[1].snapshot,
      rooms: JSON.stringify(project.roomTypes) === JSON.stringify(second.roomTypes),
      duplicate: history.validCommonHistory([second.commonRevisions[0], second.commonRevisions[0]]) };
  }, createNewProject('common'));
  expect(result).toEqual({ notes: ['自動保存', '自動保存'], revisions: ['P1', 'P2'], recursive: false, rooms: true, duplicate: false });
});

test('HTTP 200 invalid receipt never becomes Saved and blocks a second blind operation', async ({ page }) => {
  await installLocalEditingMocks(page);
  await page.goto('/');
  await page.getByPlaceholder('New project name').fill('Synthetic invalid response');
  await page.getByRole('button', { name: 'Create Project', exact: true }).click();
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  await page.getByRole('button', { name: 'Add Remark', exact: true }).click();
  await page.getByLabel('Title for remark 1', { exact: true }).fill('unsaved');
  let posts = 0;
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts++; await route.fulfill({ json: {} });
  });
  const current = page.getByRole('button', { name: 'Save current project without a new revision' });
  await current.click();
  await expect(page.getByText(/SAVE_RESPONSE_INVALID/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check Save Status', exact: true })).toBeVisible();
  await current.click();
  expect(posts).toBe(1);
  await expect(page.getByLabel('Title for remark 1', { exact: true })).toHaveValue('unsaved');
  const beforeUndo = (await readNativeDraftRecords(page)).find(record => record.project.name === 'Synthetic invalid response')!;
  const unresolved = beforeUndo as typeof beforeUndo & { intent: { operationId: string; project: unknown; before: unknown } };
  // Undo back to the persisted baseline must replace stale editing content, while retaining the unknown request.
  while (await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled()) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
  }
  await expect(page.getByLabel('Title for remark 1', { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await readNativeDraftRecords(page)).find(record => record.key === beforeUndo.key)?.project.remarks?.length ?? 0).toBe(0);
  const afterUndo = (await readNativeDraftRecords(page)).find(record => record.key === beforeUndo.key) as typeof unresolved;
  expect(afterUndo.generation).toBeGreaterThan(beforeUndo.generation);
  expect(afterUndo.intent).toEqual(unresolved.intent);
  expect(posts).toBe(1);
  page.once('dialog', dialog => dialog.accept());
  await page.reload({ waitUntil: 'load' });
  const afterReload = (await readNativeDraftRecords(page)).find(record => record.key === beforeUndo.key) as typeof unresolved;
  expect(afterReload.project.remarks?.length ?? 0).toBe(0);
  expect(afterReload.intent).toEqual(unresolved.intent);
});

for (const outcome of ['success', 'failure'] as const) test(`idle common-only ${outcome}: heartbeat continues, no repeated POST, exact autosave note`, async ({ page }) => {
  test.setTimeout(65_000);
  const state = await installLocalEditingMocks(page);
  const project = createNewProject('Synthetic idle common only');
  project.remarks = [{ id: 'remark', title: 'Initial', body: 'server', hasTable: false, columns: [], rows: [] }];
  state.projects = [project as unknown as Record<string, unknown>];
  let armed = false, heartbeats = 0, releases = 0, posts = 0, released = false;
  const status = (projectId = '', sessionId = 'synthetic-session') => {
    const now = new Date().toISOString();
    const lock = { scopeId: projectId || 'global', projectId, sessionId, userId: 'mock-user', userName: 'Tester', acquiredAt: now, heartbeatAt: now, expiresAt: new Date(Date.now() + 90_000).toISOString() };
    return { enabled: true, mode: released ? 'view' : 'edit', ownsLock: !released, projectId, scopeId: projectId || 'global', membership: { id: 'mock-user', displayName: 'Tester', email: 'test@example.test', role: 'admin', active: true }, lock: released ? null : lock, locks: released ? [] : [lock], leaseSeconds: 90, heartbeatMs: 1000, idleMs: armed ? 1000 : 900_000 };
  };
  await page.context().route('**/api/collaboration/status**', route => { const params = new URL(route.request().url()).searchParams; return route.fulfill({ json: status(params.get('projectId') ?? '', params.get('sessionId') ?? '') }); });
  await page.context().route('**/api/collaboration/lock/heartbeat', route => { heartbeats++; const payload = route.request().postDataJSON(); const current = status(payload.projectId, payload.sessionId); return route.fulfill({ json: { acquired: true, lock: current.lock, status: current } }); });
  await page.context().route('**/api/collaboration/lock/release', route => { const payload = route.request().postDataJSON(); if (payload.projectId) { releases++; released = true; } return route.fulfill({ json: { ok: true, released: true, status: status(payload.projectId, payload.sessionId) } }); });
  await page.goto('/');
  await page.locator('button.screen-card').filter({ hasText: project.name }).click();
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  await page.getByLabel('Body for remark 1', { exact: true }).fill('unsaved-common-only');
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts++; const payload = route.request().postDataJSON();
    await gate;
    if (outcome === 'failure') return route.fulfill({ status: 503, json: { error: 'synthetic failure' } });
    state.projects = [payload.project]; return route.fulfill({ json: { ok: true, project: payload.project } });
  });
  try {
    armed = true;
    await expect.poll(() => posts, { timeout: 20_000 }).toBe(1);
    const start = heartbeats;
    await page.waitForTimeout(11_500);
    expect(heartbeats).toBeGreaterThan(start);
    expect(releases).toBe(0);
    release();
    if (outcome === 'success') {
      await expect.poll(() => releases).toBe(1);
      const saved = state.projects[0] as unknown as typeof project;
      expect(saved.roomTypes).toHaveLength(0);
      expect(saved.commonRevisions?.at(-1)?.note).toBe('Automatic save');
      expect(saved.commonRevisions?.at(-1)?.snapshot.remarks?.[0].body).toBe('unsaved-common-only');
    } else {
      await expect(page.getByRole('dialog', { name: 'Finish editing with draft changes?' })).toBeVisible();
      await page.waitForTimeout(10_500);
      expect(posts).toBe(1);
      expect(releases).toBe(0);
    }
  } finally { release(); }
});

test('full backup/migration roundtrip preserves common history and flags malformed history without deleting bytes', () => {
  const project = appendCommonRevision(createNewProject('Synthetic roundtrip'), '自動保存', 'Tester');
  const roundtrip = migrateProjectsWithReport(JSON.parse(JSON.stringify(createProjectBackupPayload([project]))));
  expect(roundtrip.projects[0].commonRevisions).toEqual(project.commonRevisions);
  const malformed = { ...project, commonRevisions: [...project.commonRevisions!, ...project.commonRevisions!] };
  const diagnostic = migrateProjectsWithReport([malformed]);
  expect(diagnostic.projects[0].commonRevisions).toEqual(malformed.commonRevisions);
  expect(diagnostic.report.issues.some(issue => issue.path.includes('commonRevisions'))).toBe(true);
});

test('409 Reload preserves the edited durable draft across reload instead of saving the server copy over it', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const project = createNewProject('Synthetic conflict reload');
  project.remarks = [{ id: 'remark', title: 'Initial', body: 'base', hasTable: false, columns: [], rows: [] }];
  state.projects = [project as unknown as Record<string, unknown>];
  await page.goto('/');
  await page.locator('button.screen-card').filter({ hasText: project.name }).click();
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  await page.getByLabel('Body for remark 1', { exact: true }).fill('local-before-conflict');
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const server = { ...project, updatedAt: '2031-01-01T00:00:00.000Z', remarks: [{ ...project.remarks![0], body: 'other-editor' }] };
    state.projects = [server as unknown as Record<string, unknown>];
    await route.fulfill({ status: 409, json: { code: 'PROJECT_CONFLICT', error: 'Project was updated by another user.', project: server } });
  });
  page.on('dialog', dialog => dialog.type() === 'prompt' ? dialog.accept('R') : dialog.accept());
  await page.getByRole('button', { name: 'Save current project without a new revision' }).click();
  await expect(page.getByLabel('Body for remark 1', { exact: true })).toHaveValue('other-editor');
  await page.reload();
  await expect(page.getByLabel('Body for remark 1', { exact: true })).toHaveValue('other-editor');
  const raw = await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const open = indexedDB.open('cfs-drafts', 1); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result; const read = db.transaction('projects').objectStore('projects').getAll(); read.onsuccess = () => { resolve(JSON.stringify(read.result)); db.close(); }; };
  }));
  expect(raw).toContain('local-before-conflict');
  expect(raw).not.toContain('other-editor');
  await openSaveRecovery(page);
  await expect(page.getByRole('button', { name: 'Export Original Draft', exact: true })).toBeVisible();
});

test('confirmed force save with lost response retains the same operation and force CAS token for explicit retry', async ({ page }, testInfo) => {
  const state = await installLocalEditingMocks(page);
  const project = createNewProject('Synthetic force unknown');
  project.remarks = [{ id: 'remark', title: 'Initial', body: 'base', hasTable: false, columns: [], rows: [] }];
  state.projects = [project as unknown as Record<string, unknown>];
  await page.goto('/');
  await page.locator('button.screen-card').filter({ hasText: project.name }).click();
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  await page.getByLabel('Body for remark 1', { exact: true }).fill('my-confirmed-overwrite');
  const attempts: any[] = [];
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const payload = route.request().postDataJSON(); attempts.push(payload);
    if (attempts.length === 1) {
      const server = { ...project, updatedAt: '2031-01-01T00:00:00.000Z' };
      state.projects = [server as unknown as Record<string, unknown>];
      return route.fulfill({ status: 409, json: { code: 'PROJECT_CONFLICT', error: 'Project was updated by another user.', project: server } });
    }
    state.projects = [payload.project];
    if (attempts.length === 2) return route.fulfill({ status: 503, json: { error: 'synthetic response loss' } });
    return route.fulfill({ json: { ok: true, project: payload.project } });
  });
  page.on('dialog', dialog => dialog.type() === 'prompt' ? dialog.accept('O') : dialog.accept());
  await page.getByRole('button', { name: 'Save current project without a new revision' }).click();
  await expect(page.getByRole('button', { name: 'Retry This Save', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry This Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry This Save', exact: true })).toHaveCount(0);
  expect(attempts).toHaveLength(3);
  expect(attempts[2].forceOverwriteUpdatedAt).toBe('2031-01-01T00:00:00.000Z');
  expect(attempts[2].forceOverwrite).toBe(true);
  expect(attempts[2].expectedUpdatedAt).toBe(attempts[1].expectedUpdatedAt);
  expect(attempts[2].project).toEqual(attempts[1].project);
  await page.screenshot({ path: testInfo.outputPath('critical-force-confirmed.png'), fullPage: true });
});

test('New Revision captures normalized new rows and preserves prior snapshot bytes across reload', async ({ page }, testInfo) => {
  const state = await installLocalEditingMocks(page);
  type Identity = { userId: string; sessionId: string; projectId: string };
  let lease: Identity | null = null;
  let phase: 'setup' | 'reload' | 'inspection' | 'idle' = 'setup';
  let idleArmed = false;
  let projectPosts = 0;
  const releases: Array<Identity & { phase: string }> = [];
  const acquires: Identity[] = [];
  const heartbeats: Array<Identity & { idleMs: number }> = [];
  let finishReloadRelease!: () => void;
  const reloadRelease = new Promise<void>(resolve => { finishReloadRelease = resolve; });
  const owns = (identity: Identity) => lease !== null && lease.userId === identity.userId
    && lease.sessionId === identity.sessionId && lease.projectId === identity.projectId;
  const status = (identity: Identity) => ({ enabled: true, mode: owns(identity) ? 'edit' : 'view', ownsLock: owns(identity),
    membership: { id: 'mock-user', displayName: 'Synthetic idle user', role: 'admin', active: true },
    projectId: identity.projectId, lock: lease?.projectId === identity.projectId ? { ...lease, expiresAt: '2099-01-01T00:00:00Z' } : null,
    locks: [], heartbeatMs: 1000, idleMs: idleArmed ? 1000 : 900000, leaseSeconds: 90 });
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects') projectPosts++; });
  await page.context().route('**/api/collaboration/status**', async route => {
    const query = new URL(route.request().url()).searchParams;
    const identity = { userId: query.get('userId') ?? '', sessionId: query.get('sessionId') ?? '', projectId: query.get('projectId') ?? '' };
    // Make unload release deterministic even if the new document asks first.
    if (phase === 'reload') await reloadRelease;
    await route.fulfill({ json: status(identity) });
  });
  await page.context().route('**/api/collaboration/lock/acquire', route => {
    const identity = route.request().postDataJSON() as Identity;
    expect(identity.userId).toBe('mock-user'); expect(identity.sessionId).not.toBe('');
    expect(identity.projectId).toBe((state.projects[0] as any).id);
    lease = { ...identity }; acquires.push({ ...identity });
    return route.fulfill({ json: { acquired: true, lock: status(identity).lock, status: status(identity) } });
  });
  await page.context().route('**/api/collaboration/lock/heartbeat', route => {
    const identity = route.request().postDataJSON() as Identity;
    const response = status(identity);
    heartbeats.push({ ...identity, idleMs: response.idleMs });
    return route.fulfill({ json: { acquired: owns(identity), lock: response.lock, status: response } });
  });
  await page.context().route('**/api/collaboration/lock/release', route => {
    const identity = route.request().postDataJSON() as Identity;
    const released = owns(identity);
    if (released) {
      releases.push({ ...identity, phase }); lease = null;
      if (phase === 'reload') finishReloadRelease();
    }
    return route.fulfill({ json: { ok: true, released } });
  });
  await page.goto('/');
  await page.getByPlaceholder('New project name').fill('Synthetic revision normalization');
  await page.getByRole('button', { name: 'Create Project', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Room Type', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start editing', exact: true }).click();
  await expect(page.locator('.collaboration-mode-pill')).toHaveText('Editing');
  await page.getByRole('tab', { name: 'Room Type', exact: true }).click();
  await page.getByPlaceholder('New room type name').fill('Normalized room');
  await page.getByRole('button', { name: 'Create Room Type', exact: true }).click();
  const saveRevision = async () => {
    await page.getByRole('button', { name: 'Save all room types as new revisions' }).click();
    await page.getByRole('dialog', { name: 'Save Revision', exact: true }).getByRole('button', { name: 'Save Revision', exact: true }).click();
  };
  await saveRevision();
  await expect.poll(() => (state.projects[0] as any)?.roomTypes[0]?.revisions.length).toBe(1);
  const first = (state.projects[0] as any).roomTypes[0];
  const originalBytes = first.revisions[0].snapshot;
  expect(JSON.parse(originalBytes).rows[0].deviceGroupId).toBe(first.rows[0].id);
  expect(first.rows[0].deviceGroupId).toBe(first.rows[0].id);
  await saveRevision();
  await expect.poll(() => (state.projects[0] as any).roomTypes[0].revisions.length).toBe(2);
  expect((state.projects[0] as any).roomTypes[0].revisions[0].snapshot).toBe(originalBytes);
  expect(acquires).toHaveLength(1);
  phase = 'reload';
  await page.reload();
  await expect.poll(() => releases.filter(entry => entry.phase === 'reload').length).toBe(1);
  await expect(page.locator('.collaboration-mode-pill')).toHaveText('View Only');
  if (await page.locator('button.screen-card').filter({ hasText: 'Synthetic revision normalization' }).count()) await page.locator('button.screen-card').filter({ hasText: 'Synthetic revision normalization' }).click();
  await page.getByRole('tab', { name: 'Room Type', exact: true }).click();
  await page.getByRole('tab', { name: 'Normalized room', exact: true }).click();
  expect((state.projects[0] as any).roomTypes[0].revisions[0].snapshot).toBe(originalBytes);
  await expect(page.locator('.revision-save-status-label')).toHaveText('Saved');
  await expect(page.locator('.revision-save-status')).toHaveAttribute('title', 'Current project matches the saved data');
  phase = 'inspection';
  await page.getByRole('button', { name: 'Start editing', exact: true }).click();
  await expect(page.locator('.collaboration-mode-pill')).toHaveText('Editing');
  expect(acquires).toHaveLength(2);
  expect(acquires[1]).toEqual(acquires[0]);
  // Inspection reads the actual snapshot comparison, independently of the badge.
  await page.getByRole('tab', { name: 'CFS', exact: true }).click();
  await page.getByRole('button', { name: 'InspectionMode', exact: true }).click();
  const inspection = page.getByRole('dialog', { name: 'Start InspectionMode', exact: true });
  await expect(inspection.getByText('Choose whether to save a new revision before starting InspectionMode.', { exact: true })).toBeVisible();
  await inspection.getByRole('button', { name: 'Cancel', exact: true }).click();
  const releasesBeforeIdle = releases.length;
  const postsBeforeIdle = projectPosts;
  expect(releasesBeforeIdle).toBe(1);
  phase = 'idle'; idleArmed = true;
  await expect.poll(() => heartbeats.some(entry => entry.idleMs === 1000), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => releases.length, { timeout: 20_000 }).toBe(releasesBeforeIdle + 1);
  expect(releases.at(-1)).toEqual({ ...acquires[1], phase: 'idle' });
  await expect(page.locator('.collaboration-mode-pill')).toHaveText('View Only');
  expect(projectPosts).toBe(postsBeforeIdle);
  expect((state.projects[0] as any).roomTypes[0].revisions).toHaveLength(2);
  expect((state.projects[0] as any).roomTypes[0].revisions[0].snapshot).toBe(originalBytes);
  await testInfo.attach('lease-phases', { body: JSON.stringify({ acquires, releases, heartbeats, postsBeforeIdle, projectPosts }), contentType: 'application/json' });
});
