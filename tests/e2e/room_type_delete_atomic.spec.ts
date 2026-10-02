import { test, expect } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { createNewProject, migrateProjectsPayload } from '../../app/lib/storage';
import { createNewRoomType } from '../../app/lib/constants';
import { localProjectBase } from '../../app/lib/localRevisionRestore';
import { createLocalProjectStore } from '../../app/lib/localProjectStore';
import { prepareSaveProject, roomHistoryPreserved } from '../../app/lib/projectSaveProtocol';
import { syncProjectRoomTypeLinks } from '../../app/lib/roomTypeSync';
import type { ProjectData } from '../../app/types';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function fixture(): ProjectData {
  const project = createNewProject('Synthetic room deletion');
  const room = createNewRoomType('Remove me'), survivor = createNewRoomType('Keep me');
  room.revisions = [{ id: 'old-revision', revision: '1.00', savedAt: project.updatedAt, savedBy: 'Synthetic', note: '', snapshot: '{ "exact bytes": [1, 2] }' }];
  Object.assign(room, { futureRoomField: { keep: ['unknown', 1] } });
  Object.assign(project, { futureProjectField: 'retained' });
  project.roomTypes = [room, survivor];
  return project;
}

test('local atomic room deletion preserves full history, other data, CAS, scope and capacity', async ({ page }) => {
  const root = process.env.CFS_ROOM_DELETE_TEST_ROOT!;
  expect(process.env.CFS_APP_DIR).toBe(root);
  expect(path.resolve(root)).not.toBe(path.resolve(process.cwd()));
  const data = path.join(root, 'data'); await fs.mkdir(path.join(data, 'trash'), { recursive: true });
  const project = fixture(), other = createNewProject('Unrelated synthetic project');
  const trash = { futureTrashField: { untouched: true }, projects: [], roomTypes: [{ id: 'previous-trash', deletedAt: project.updatedAt, projectId: other.id, projectName: other.name, roomType: createNewRoomType('Already trashed') }], updatedAt: 'initial' };
  const seed = async (savedTrash: unknown = trash) => {
    await fs.writeFile(path.join(data, 'projects.json'), JSON.stringify([project, other]));
    await fs.writeFile(path.join(data, 'trash/trash.json'), JSON.stringify(savedTrash));
  };
  await seed();
  await page.context().route(/\/api\/projects\/room-types\/delete(?:\?.*)?$/, route => route.continue());
  await page.context().route('**/api/projects', route => route.continue());
  await page.route('**/room-delete-api-test', route => route.fulfill({ contentType: 'text/html', body: '<title>Isolated Room Type API</title>' }));
  await page.goto('/room-delete-api-test');
  const call = (body: unknown, scope?: string) => page.evaluate(async ({ body, scope }) => {
    const response = await fetch('/api/projects/room-types/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(scope ? { 'x-cfs-project-id': scope } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { body, scope });
  const baseResponse = await page.evaluate(async id => (await fetch(`/api/projects/room-types/delete?projectId=${id}`)).json(), project.id);
  expect(baseResponse.project).toEqual(project);
  const intent = { projectId: project.id, roomTypeId: project.roomTypes[0].id, operationId: randomUUID(), base: baseResponse.base };
  const normalRemoval = await prepareSaveProject({ ...project, roomTypes: [project.roomTypes[1]] }, 'current');
  const refusedSave = await page.evaluate(async project => {
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, expectedUpdatedAt: project.updatedAt, saveProtocol: 2 }) });
    return { status: response.status, body: await response.json() };
  }, normalRemoval);
  expect(refusedSave.status).toBe(409); expect(refusedSave.body.code).toBe('ROOM_HISTORY_PROTECTED');
  expect((await call({ ...intent, base: { ...intent.base, hash: 'a'.repeat(64) } })).status).toBe(409);
  expect((await call(intent, other.id)).status).toBe(400);
  expect(JSON.parse(await fs.readFile(path.join(data, 'projects.json'), 'utf8'))).toEqual([project, other]);
  const result = await call(intent, project.id);
  expect(result.status).toBe(200);
  const after = JSON.parse(await fs.readFile(path.join(data, 'projects.json'), 'utf8'));
  const afterTrash = JSON.parse(await fs.readFile(path.join(data, 'trash/trash.json'), 'utf8'));
  expect(after[1]).toEqual(other);
  expect(after[0].roomTypes).toEqual([project.roomTypes[1]]);
  expect(after[0].futureProjectField).toBe('retained');
  expect(afterTrash.roomTypes[0].roomType).toEqual(project.roomTypes[0]);
  expect(afterTrash.roomTypes[0].id).toBe(intent.operationId);
  expect(afterTrash.roomTypes[1]).toEqual(trash.roomTypes[0]);
  expect(afterTrash.futureTrashField).toEqual(trash.futureTrashField);
  expect(roomHistoryPreserved(project, after[0])).toBe(false); // Ordinary save must STILL reject this removal.
  expect((await call(intent)).status).toBe(409);
  expect(JSON.parse(await fs.readFile(path.join(data, 'trash/trash.json'), 'utf8'))).toEqual(afterTrash);
  await seed({ ...trash, padding: 'x'.repeat(10 * 1024 * 1024), roomTypes: [{ ...trash.roomTypes[0], roomType: { ...trash.roomTypes[0].roomType, padding: 'x'.repeat(10 * 1024 * 1024) } }] });
  expect((await call({ ...intent, operationId: randomUUID() })).status).toBe(413);
  expect(JSON.parse(await fs.readFile(path.join(data, 'projects.json'), 'utf8'))).toEqual([project, other]);
});

test('local journal recovers an interrupted project replacement after Trash is durable', async () => {
  const root = path.join(process.env.CFS_ROOM_DELETE_TEST_ROOT!, `journal-${randomUUID()}`);
  const before = fixture(), after = { ...before, roomTypes: [before.roomTypes[1]] };
  const trash = { projects: [], roomTypes: [{ id: randomUUID(), roomType: before.roomTypes[0] }] };
  let fail = true;
  const io = { ...fs, rename: async (source: Parameters<typeof fs.rename>[0], target: Parameters<typeof fs.rename>[1]) => {
    if (String(target) === path.join(root, 'projects.json') && fail) { fail = false; throw new Error('Injected project replacement failure'); }
    return fs.rename(source, target);
  } };
  await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify([before]));
  const store = createLocalProjectStore(root, io);
  await expect(store.locked(() => store.commit([after], trash))).rejects.toThrow('Injected');
  expect(JSON.parse(await fs.readFile(path.join(root, 'projects.json'), 'utf8'))).toEqual([before]);
  expect(JSON.parse(await fs.readFile(path.join(root, 'trash/trash.json'), 'utf8'))).toEqual(trash);
  expect(await store.locked(() => store.readProjects())).toEqual([after]);
  expect(await store.locked(() => store.readTrash())).toEqual(trash);
});

for (const mode of ['normal', 'lost-response', 'readback-401', 'late-draft']) test(`UI room deletion ${mode}`, async ({ page }, info) => {
  const state = await installLocalEditingMocks(page), original = syncProjectRoomTypeLinks(migrateProjectsPayload([fixture()])[0], { devices: [] }); state.projects = [original as unknown as Record<string, unknown>];
  let posts = 0, writes = 0, failedReadback = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  page.on('request', req => { if (req.method() === 'POST' && ['/api/projects', '/api/trash'].includes(new URL(req.url()).pathname)) writes++; });
  await page.context().route('**/api/projects/room-types/delete**', async route => {
    if (route.request().method() === 'GET') {
      if (mode === 'readback-401' && posts && !failedReadback) { failedReadback = true; return route.fulfill({ status: 401, json: { error: 'Injected expired readback session' } }); }
      return route.fulfill({ json: { project: state.projects[0], base: localProjectBase(state.projects[0] as unknown as ProjectData) } });
    }
    posts++; const intent = route.request().postDataJSON(); await gate;
    const item = { id: intent.operationId, deletedAt: new Date().toISOString(), projectId: original.id, projectName: original.name, roomType: original.roomTypes[0] };
    state.projects = [{ ...original, updatedAt: item.deletedAt, roomTypes: [original.roomTypes[1]] }]; state.trash.roomTypes = [item];
    if (mode === 'lost-response') await route.abort('timedout');
    else await route.fulfill({ json: { ok: true, operationId: intent.operationId } });
  });
  const dialogs: string[] = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
  await page.goto('/'); await page.locator('button.screen-card').filter({ hasText: original.name }).click();
  if (mode === 'late-draft') {
    await page.getByPlaceholder('New room type name').fill('Late preserved room');
    // Simulate an earlier internal input callback completing during native draft cleanup.
    // No user click passes through the overlay; the real UI mutation still runs.
    await page.evaluate(projectId => {
      const remove = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function(key) {
        const result = remove.call(this, key);
        if (String(key).includes(projectId)) {
          IDBObjectStore.prototype.delete = remove;
          queueMicrotask(() => {
            const button = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Create Room Type');
            const key = button && Object.keys(button).find(key => key.startsWith('__reactProps'));
            if (button && key) Reflect.get(button, key).onClick();
          });
        }
        return result;
      };
    }, original.id);
  }
  await page.getByRole('button', { name: 'Delete Room Type', exact: true }).first().click();
  await expect.poll(() => ({ posts, errors: dialogs.filter(message => !message.startsWith('Move room type')) })).toEqual({ posts: 1, errors: [] });
  await expect(page.getByText('Moving Room Type to Trash…', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('room-delete-pending.png') });
  release();
  await expect(page.getByText('Moving Room Type to Trash…', { exact: true })).toHaveCount(0);
  if (mode === 'late-draft') {
    await expect.poll(() => dialogs.some(message => message.includes('Newer edits were retained'))).toBe(true);
    await expect(page.getByRole('tab', { name: 'Late preserved room', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '+ Manage', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Delete Room Type', exact: true })).toHaveCount(3);
    expect(posts).toBe(1); expect(writes).toBe(0);
    return;
  }
  if (mode !== 'normal') {
    await expect.poll(() => dialogs.some(message => message.includes('Reload to check'))).toBe(true);
    await page.getByRole('button', { name: 'Delete Room Type', exact: true }).first().click();
  }
  await expect(page.getByRole('button', { name: 'Delete Room Type', exact: true })).toHaveCount(1);
  expect(posts).toBe(1); expect(writes).toBe(0);
  expect(state.trash.roomTypes[0].roomType).toEqual(original.roomTypes[0]);
  await page.screenshot({ path: info.outputPath('room-delete-confirmed.png') });
});

test('UI refuses Room Type deletion while project edits are unsaved', async ({ page }) => {
  const state = await installLocalEditingMocks(page), original = fixture(); state.projects = [original as unknown as Record<string, unknown>];
  let posts = 0; const dialogs: string[] = [];
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/projects/room-types/delete') posts++; });
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
  await page.goto('/'); await page.locator('button.screen-card').filter({ hasText: original.name }).click();
  await page.getByPlaceholder('New room type name').fill('Unsaved room');
  await page.getByRole('button', { name: 'Create Room Type', exact: true }).click();
  await page.getByRole('tab', { name: '+ Manage', exact: true }).click();
  await page.getByRole('button', { name: 'Delete Room Type', exact: true }).first().click();
  await expect.poll(() => dialogs.some(message => message.includes('Save your changes'))).toBe(true);
  expect(posts).toBe(0); expect(state.projects[0]).toEqual(original);
});
