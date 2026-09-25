import { test, expect, type Page } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { readNativeDraftRecords } from './support/native-project-drafts';
import { createNewProject } from '../../app/lib/storage';
import { appendCommonRevision } from '../../app/lib/projectCommonHistory';
import { capturedProjectBase, registerProjectBases } from '../../app/lib/projectBase';
import { localProjectBase, localRevisionRestore } from '../../app/lib/localRevisionRestore';
import { prepareSaveProject, roomHistoryPreserved } from '../../app/lib/projectSaveProtocol';
import { createNewRoomType } from '../../app/lib/constants';
import type { ProjectData } from '../../app/types';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function fixture() {
  const p = createNewProject('Synthetic T149');
  p.remarks = [{ id: 'remark', title: 'Initial', body: 'server v18', hasTable: false, columns: [], rows: [] }];
  return appendCommonRevision(p, 'Named revision', 'Synthetic editor');
}
async function openRemarks(page: Page, project: ProjectData) {
  await page.goto('/');
  await page.locator('button.screen-card').filter({ hasText: project.name }).click();
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
}

test('loaded base stays bound to its timestamp and ambiguous timestamp fails closed', () => {
  const old = fixture(), next = { ...old, updatedAt: '2040-01-01T00:00:00.000Z' };
  const base = { version: 18, hash: 'a'.repeat(64), updatedAt: old.updatedAt };
  registerProjectBases([old], { bases: { [old.id]: base } });
  registerProjectBases([next], { bases: { [old.id]: { version: 19, hash: 'b'.repeat(64), updatedAt: next.updatedAt } } });
  expect(capturedProjectBase(old.id, old.updatedAt)).toEqual(base);
  registerProjectBases([old], { bases: { [old.id]: { ...base, version: 20, hash: 'c'.repeat(64) } } });
  expect(capturedProjectBase(old.id, old.updatedAt)).toBeUndefined();
});

test('room history guards removed parents and byte changes but allows metadata edits', () => {
  const project = fixture(), room = createNewRoomType('Synthetic room');
  room.revisions = [{ id: 'r1', revision: '1.00', savedAt: project.updatedAt, savedBy: 'A', note: '', snapshot: '{ "literal" : "retain bytes" }' }]; project.roomTypes = [room];
  const incoming = structuredClone(project); incoming.roomTypes[0].revisions[0].note = 'metadata correction';
  expect(roomHistoryPreserved(project, incoming)).toBe(true);
  incoming.roomTypes[0].revisions[0].snapshot = '{"literal":"retain bytes"}'; expect(roomHistoryPreserved(project, incoming)).toBe(false);
  expect(roomHistoryPreserved(project, { ...project, roomTypes: [] })).toBe(false);
});

test('real isolated local API previews and saves a revision without source migration', async ({ page }) => {
  // Explicit allowlist for this test's disposable runtime only; all other API is blocked.
  await page.context().route(/\/api\/projects(?:\/history|\?restoreRaw=1)?$/, route => route.continue());
  await page.route('**/t149-local-api', route => route.fulfill({ contentType: 'text/html', body: '<title>Synthetic local API</title>' }));
  await page.goto('/t149-local-api');
  const project = fixture(); project.remarks![0].body = 'latest value';
  const initial = await prepareSaveProject(project, 'current');
  const created = await page.evaluate(async project => {
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, createOnly: true, saveProtocol: 2 }) });
    return { status: response.status, body: await response.json() };
  }, initial);
  expect(created.status).toBe(200);
  const source = { kind: 'common-revision', id: project.commonRevisions![0].id };
  const preview = await page.evaluate(async ({ projectId, source }) => {
    const response = await fetch('/api/projects/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, source }) });
    return { status: response.status, body: await response.json() };
  }, { projectId: project.id, source });
  expect(preview.status).toBe(200); expect(preview.body.project.remarks[0].body).toBe('server v18');
  const sent = await prepareSaveProject(preview.body.project, 'current');
  const saved = await page.evaluate(async ({ project, base, restoreSource }) => {
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, base, restoreSource, expectedUpdatedAt: base.updatedAt, saveProtocol: 2 }) });
    return { status: response.status, body: await response.json() };
  }, { project: sent, base: preview.body.base, restoreSource: source });
  expect(saved.status).toBe(200); expect(saved.body.project.remarks[0].body).toBe('server v18');
  expect(saved.body.project.updatedAt).not.toBe(created.body.project.updatedAt);
  expect(saved.body.project.commonRevisions).toEqual(project.commonRevisions);
});

test('Discard loads v19 with zero project writes and retains another tab draft', async ({ page }) => {
  const state = await installLocalEditingMocks(page), project = fixture(); state.projects = [project as any];
  let posts = 0;
  page.on('request', req => { if (new URL(req.url()).pathname === '/api/projects' && req.method() === 'POST') posts++; });
  await openRemarks(page, project);
  await page.getByLabel('Body for remark 1', { exact: true }).fill('my unsaved work');
  await expect.poll(async () => (await readNativeDraftRecords(page)).some(record => record.project.remarks?.[0].body === 'my unsaved work')).toBe(true);
  await page.evaluate(async () => {
    const request = indexedDB.open('cfs-drafts');
    await new Promise<void>((resolve, reject) => { request.onsuccess = () => {
      const db = request.result, tx = db.transaction('projects', 'readwrite'), store = tx.objectStore('projects'), all = store.getAll();
      all.onsuccess = () => { const record = structuredClone(all.result[0]); record.scope.tab = 'another-tab'; record.key = JSON.stringify([record.scope.workspace, record.scope.owner, record.project.id, record.scope.tab]); store.put(record); };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    }; });
  });
  const latest = structuredClone(project); latest.remarks![0].body = 'server v19'; latest.updatedAt = '2040-01-01T00:00:00.000Z'; state.projects = [latest as any];
  await page.getByRole('button', { name: 'Back to Project List', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Finish editing with draft changes?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Save.*Finish/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Discard my unsaved changes', exact: true }).click();
  await page.locator('button.screen-card').filter({ hasText: project.name }).click();
  await page.getByRole('tab', { name: 'Remarks', exact: true }).click();
  await expect(page.getByLabel('Body for remark 1', { exact: true })).toHaveValue('server v19');
  expect(posts).toBe(0); expect(state.projects[0]).toEqual(latest);
  const records = await readNativeDraftRecords(page);
  expect(records.filter(record => record.scope.tab === 'another-tab')).toHaveLength(1);
  expect(records.filter(record => record.scope.tab !== 'another-tab' && !record.scope.tab.startsWith('recovery:'))).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'artifacts/t149-codex1/browser/discard.png', fullPage: true });
});

test('stale v18 save is not resent; v19 author is shown and changes remain in Recovery', async ({ page }) => {
  const state = await installLocalEditingMocks(page), project = fixture(); state.projects = [project as any];
  const base = { version: 18, hash: 'a'.repeat(64), updatedAt: project.updatedAt };
  let posts = 0, sent: any, newest = project;
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() === 'POST') {
      posts++; sent = route.request().postDataJSON();
      newest = { ...project, updatedAt: '2040-01-01T00:00:00.000Z', lastUpdatedBy: { userId: 'A', displayName: 'Editor A', updatedAt: '2040-01-01T00:00:00.000Z' } };
      return route.fulfill({ status: 409, json: { code: 'STALE_BASE' } });
    }
    return route.fulfill({ json: { projects: [newest], bases: { [project.id]: newest === project ? base : { version: 19, hash: 'b'.repeat(64), updatedAt: newest.updatedAt } } } });
  });
  await openRemarks(page, project);
  await page.getByLabel('Body for remark 1', { exact: true }).fill('B unsaved');
  const messages: string[] = []; page.on('dialog', async dialog => { messages.push(dialog.message()); await dialog.accept(); });
  await page.getByRole('button', { name: 'Save current project without a new revision', exact: true }).click();
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toContain('Editor A'); expect(messages[0]).toContain('2040-01-01');
  expect(sent.base).toEqual(base); expect(posts).toBe(1);
  await expect(page.getByLabel('Body for remark 1', { exact: true })).toHaveValue('server v18');
  expect((await readNativeDraftRecords(page)).some(record => record.scope.tab.startsWith('recovery:') && record.project.remarks?.[0].body === 'B unsaved')).toBe(true);
});

test('Restore Revision previews, then makes one verified save and preserves named history', async ({ page }) => {
  const state = await installLocalEditingMocks(page), project = fixture();
  project.remarks![0].body = 'server v19'; state.projects = [project as any];
  let posts = 0, previews = 0, rawRead = false, sent: any;
  const base = localProjectBase(project), source = { kind: 'common-revision' as const, id: project.commonRevisions![0].id };
  const candidate = localRevisionRestore(project, source);
  await page.context().route('**/api/projects/history', route => { previews++; return route.fulfill({ json: { project: candidate, base, restoreSource: source } }); });
  await page.context().route(/\/api\/projects(?:\?.*)?$/, async route => {
    if (route.request().method() === 'POST') { posts++; sent = route.request().postDataJSON(); state.projects = [{ ...sent.project, updatedAt: '2040-01-01T00:00:00.000Z' }]; return route.fulfill({ json: { ok: true, project: state.projects[0] } }); }
    rawRead ||= route.request().url().includes('restoreRaw=1'); return route.fulfill({ json: { projects: state.projects } });
  });
  await openRemarks(page, project);
  await page.getByRole('button', { name: 'Common History', exact: true }).click();
  await page.getByRole('button', { name: 'Restore Revision…', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Restore Revision…', exact: true });
  await expect(preview).toBeVisible(); expect(posts).toBe(0); expect(previews).toBe(1);
  await preview.locator('summary').click();
  await expect(preview).toContainText('server v18');
  await page.screenshot({ path: 'artifacts/t149-codex1/browser/restore-preview.png', fullPage: true });
  await preview.getByRole('button', { name: 'Confirm Restore as New Version' }).click();
  await expect(preview).toHaveCount(0); expect(posts).toBe(1); expect(rawRead).toBe(true);
  expect(sent.restoreSource).toEqual(source); expect(sent.base).toEqual(base);
  expect((state.projects[0] as any).commonRevisions).toEqual(project.commonRevisions);
  await expect(page.getByLabel('Body for remark 1', { exact: true })).toHaveValue('server v18');
});

test('native draft discard fences older checkpoints and refuses unresolved intents', async ({ page }) => {
  await page.route('**/t149-harness', route => route.fulfill({ contentType: 'text/html', body: '<title>T149 synthetic draft</title>' }));
  await page.goto('/t149-harness');
  const names = ['canonicalJson','id','projectBase','projectDraftStore','projectImportRecovery','projectSaveProtocol'];
  const sources = Object.fromEntries(names.map(name => [name, ts.transpileModule(fs.readFileSync(`app/lib/${name}.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText]));
  const result = await page.evaluate(async ({ sources, project }) => {
    const modules: Record<string, any> = {};
    const require = (name: string): any => { name = name.replace('./',''); if (!modules[name]) { const m = { exports: {} }; modules[name] = m; new Function('require','exports','module', sources[name])(require,m.exports,m); } return modules[name].exports; };
    const store = require('projectDraftStore'), protocol = require('projectSaveProtocol');
    const owner = { workspace: 'synthetic', owner: 'A', tab: 'tab1' }; await store.initializeProjectDrafts(owner);
    await store.checkpointProject(project, project.updatedAt, null, owner);
    const pending = store.checkpointProject({ ...project, name: 'in flight' }, project.updatedAt, null, owner);
    await store.discardCurrentTabDraft(project.id, owner); await pending;
    const after = await store.initializeProjectDrafts(owner);
    const sent = await protocol.prepareSaveProject(project,'current');
    await store.checkpointProject(project, project.updatedAt, { before: project, project: sent, expectedUpdatedAt: project.updatedAt, operationId: sent.lastSaveOperation.id }, owner);
    let refused = false; try { await store.discardCurrentTabDraft(project.id, owner); } catch { refused = true; }
    return { count: after.length, refused, remaining: store.cachedDraftRecords().length };
  }, { sources, project: fixture() });
  expect(result).toEqual({ count: 0, refused: true, remaining: 1 });
});

test('two clients: A saves v19, B stale save gets 409, Discard writes zero, explicit Restore creates v20', async ({ page }) => {
  const state = await installLocalEditingMocks(page), original = fixture();
  state.projects = [original as any]; let head = original, version = 18, posts = 0;
  const history: ProjectData[] = [];
  const base = () => ({ version, hash: String(version % 10).repeat(64), updatedAt: head.updatedAt });
  await page.context().route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { projects: [head], bases: { [head.id]: base() } } });
    posts++; const body = route.request().postDataJSON();
    if (body.base?.version !== version || body.base?.hash !== base().hash) return route.fulfill({ status: 409, json: { code: 'STALE_BASE' } });
    history.push(structuredClone(head)); version++;
    head = { ...body.project, updatedAt: `2040-01-01T00:00:${version}.000Z`, lastUpdatedBy: { userId: 'A', displayName: 'Editor A', updatedAt: `2040-01-01T00:00:${version}.000Z` } };
    return route.fulfill({ json: { ok: true, project: head } });
  });
  await page.context().route('**/api/projects?restoreRaw=1', route => route.fulfill({ json: { projects: [head], bases: { [head.id]: base() } } }));
  await page.context().route('**/api/projects/history', route => {
    const source = route.request().postDataJSON().source;
    return route.fulfill({ json: { project: localRevisionRestore(head, source), base: base(), restoreSource: source } });
  });
  const b = await page.context().newPage();
  await openRemarks(page, original); await openRemarks(b, original);
  await page.getByLabel('Body for remark 1', { exact: true }).fill('A version19');
  await page.getByRole('button', { name: 'Save current project without a new revision' }).click();
  await expect.poll(() => version).toBe(19);
  await b.getByLabel('Body for remark 1', { exact: true }).fill('B stale draft');
  b.once('dialog', dialog => dialog.dismiss());
  await b.getByRole('button', { name: 'Save current project without a new revision' }).click();
  await expect.poll(() => posts).toBe(2);
  await expect.poll(async () => (await readNativeDraftRecords(b)).some(record => record.scope.tab.startsWith('recovery:') && record.project.remarks?.[0].body === 'B stale draft')).toBe(true);
  await b.getByRole('button', { name: 'Back to Project List', exact: true }).click();
  await b.getByRole('button', { name: 'Discard my unsaved changes', exact: true }).click();
  await b.locator('button.screen-card').filter({ hasText: original.name }).click();
  await b.getByRole('tab', { name: 'Remarks', exact: true }).click();
  await expect(b.getByLabel('Body for remark 1', { exact: true })).toHaveValue('A version19');
  expect(posts).toBe(2); expect(version).toBe(19);
  await b.getByRole('button', { name: 'Common History', exact: true }).click();
  await b.getByRole('button', { name: 'Restore Revision…', exact: true }).click();
  await b.getByRole('dialog', { name: 'Restore Revision…', exact: true }).getByRole('button', { name: 'Confirm Restore as New Version' }).click();
  await expect.poll(() => version).toBe(20); expect(posts).toBe(3);
  await expect(b.getByLabel('Body for remark 1', { exact: true })).toHaveValue('server v18');
  expect(history.map(project => project.remarks![0].body)).toEqual(['server v18','A version19']);
  expect(head.commonRevisions).toEqual(original.commonRevisions);
  await b.close();
});

test('bilingual updates render English and Japanese on separate lines', async ({ page }) => {
  await installLocalEditingMocks(page); await page.goto('/');
  const item = page.getByTestId('update-highlights').locator('li').first();
  await expect(item.locator('span[lang=en]')).toBeVisible(); await expect(item.locator('span[lang=ja]')).toBeVisible();
  const en = await item.locator('span[lang=en]').boundingBox(), ja = await item.locator('span[lang=ja]').boundingBox();
  expect(ja!.y).toBeGreaterThanOrEqual(en!.y + en!.height);
});

test('real local restore preserves raw legacy revision metadata and unknown fields; ordinary deletion is refused', async ({ page }) => {
  const runtime = process.env.CFS_APP_DIR ?? '';
  const relative = path.relative(path.resolve('artifacts/t149-codex1'), path.resolve(runtime));
  expect(runtime).toBeTruthy(); expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(false);
  const file = path.join(runtime, 'data', 'projects.json');
  const projects = JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectData[];
  const project = fixture(), room = createNewRoomType('Legacy synthetic');
  room.revisions = [
    { id: 'valid', revision: '1.00', savedAt: project.updatedAt, savedBy: 'A', note: '', snapshot: '{}' },
    { id: 'legacy', revision: '1.01', savedAt: 123 as any, savedBy: 'A', note: '', snapshot: '{ "old": true }' },
  ];
  project.roomTypes = [room]; (project as any).unknownFutureProperty = { keep: 'literal' };
  project.remarks![0].body = 'latest raw';
  fs.writeFileSync(file, JSON.stringify([...projects, project]));
  await page.context().route(/\/api\/projects(?:\/history|\?restoreRaw=1)?$/, route => route.continue());
  await page.route('**/t149-raw-api', route => route.fulfill({ contentType: 'text/html', body: '<title>Synthetic raw API</title>' }));
  await page.goto('/t149-raw-api');
  const source = { kind: 'common-revision', id: project.commonRevisions![0].id };
  const preview = await page.evaluate(async ({ projectId, source }) => {
    const response = await fetch('/api/projects/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, source }) });
    return { status: response.status, body: await response.json() };
  }, { projectId: project.id, source });
  expect(preview.status).toBe(200);
  expect(preview.body.project.roomTypes[0].revisions).toEqual(room.revisions);
  expect(preview.body.project.unknownFutureProperty).toEqual({ keep: 'literal' });
  const sent = await prepareSaveProject(preview.body.project, 'current');
  const saved = await page.evaluate(async ({ project, base, source }) => {
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, base, restoreSource: source, expectedUpdatedAt: base.updatedAt, saveProtocol: 2 }) });
    return { status: response.status, body: await response.json() };
  }, { project: sent, base: preview.body.base, source });
  expect(saved.status).toBe(200); expect(saved.body.project.roomTypes[0].revisions).toEqual(room.revisions);
  const before = fs.readFileSync(file, 'utf8');
  const edited = structuredClone(saved.body.project); edited.remarks[0].body = 'normal update'; edited.roomTypes[0].revisions.pop();
  const normal = await prepareSaveProject(edited, 'current');
  const refusal = await page.evaluate(async project => {
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, expectedUpdatedAt: project.updatedAt, saveProtocol: 2 }) });
    return { status: response.status, body: await response.json() };
  }, normal);
  expect(refusal.status).toBe(409); expect(refusal.body.code).toBe('ROOM_HISTORY_PROTECTED'); expect(fs.readFileSync(file, 'utf8')).toBe(before);
});
