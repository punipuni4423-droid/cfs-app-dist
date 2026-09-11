import { expect, test } from './support/safe-test';
import { createNewProject, migrateProjectsPayload, migrateProjectsWithReport } from '../../app/lib/storage';
import { createNewRoomType, createEmptySwitchEntry, createEmptyScene, createEmptyDeviceAssignment } from '../../app/lib/constants';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import Module from 'node:module';
import path from 'node:path';
import ts from 'typescript';

function sample() {
  const project = createNewProject('Migration Safety');
  const room = createNewRoomType('Sample Room');
  room.switches = [createEmptySwitchEntry('contact'), createEmptySwitchEntry('command')];
  room.scenes = [createEmptyScene('area:1'), createEmptyScene('area:2')];
  room.deviceAssignments = [createEmptyDeviceAssignment()];
  project.roomTypes = [room];
  return project;
}

for (const field of ['switches', 'scenes', 'roomScenes', 'hvacSeasons', 'deviceAssignments'] as const) {
  test(`migration preserves valid ${field} around an invalid element`, () => {
    const input = sample();
    const expected = migrateProjectsPayload([input])[0];
    const broken = structuredClone(input);
    (broken.roomTypes[0][field] as unknown[]).splice(1, 0, null);
    const output = migrateProjectsPayload([broken]);
    expect(output).toHaveLength(1);
    expect(output[0].roomTypes).toHaveLength(1);
    expect(output[0].roomTypes[0][field]).toEqual(expected.roomTypes[0][field]);
  });
}

test('migration preserves valid room types around an invalid element', () => {
  const input = sample();
  const expected = migrateProjectsPayload([input]);
  (input.roomTypes as unknown[]).push(null);
  expect(migrateProjectsPayload([input])).toEqual(expected);
});

test('normal real-data migration is byte-identical to the pre-fix migration', () => {
  // Compile only the old storage module in memory; neither checkout nor real data is changed.
  const filename = path.resolve('app/lib/storage.ts');
  const source = execFileSync('git', ['show', 'HEAD:app/lib/storage.ts'], { encoding: 'utf8' });
  const baseline = new Module(filename, module) as Module & { _compile(code: string, filename: string): void; paths: string[] };
  baseline.filename = filename;
  baseline.paths = module.paths;
  baseline._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
  const raw = readFileSync('data/projects.json', 'utf8');
  const input = JSON.parse(raw);
  const before = JSON.stringify(baseline.exports.migrateProjectsPayload(input));
  const { projects, report } = migrateProjectsWithReport(input);
  const after = JSON.stringify(projects);
  expect(after).toBe(before);
  expect(report.issues).toEqual([]);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const hashes = { raw: hash(raw), migratedBefore: hash(before), migratedAfter: hash(after) };
  writeFileSync(test.info().outputPath('normal-data-hashes.json'), JSON.stringify(hashes, null, 2));
});

test('missing legacy group is repaired and reported without removing the assignment', () => {
  const input = sample();
  delete (input.roomTypes[0].deviceAssignments[0] as Partial<ReturnType<typeof createEmptyDeviceAssignment>>).group;
  const { projects, report } = migrateProjectsWithReport([input]);
  expect(projects[0].roomTypes[0].deviceAssignments).toHaveLength(1);
  expect(projects[0].roomTypes[0].deviceAssignments[0].group).toBe('');
  expect(report.repaired).toBe(1);
});

test('fully excluded room scenes stay empty for the current load; normal empty input keeps legacy defaults', () => {
  const input = sample();
  (input.roomTypes[0] as unknown as { roomScenes: unknown[] }).roomScenes = [null];
  const first = migrateProjectsWithReport([input]);
  expect(first.report.excluded).toBe(1);
  expect(first.projects[0].roomTypes[0].roomScenes).toEqual([]);
  const normalEmpty = sample();
  normalEmpty.roomTypes[0].roomScenes = [];
  expect(migrateProjectsWithReport([normalEmpty]).projects[0].roomTypes[0].roomScenes.length).toBeGreaterThan(0);
  expect(migrateProjectsWithReport([normalEmpty]).report.issues).toEqual([]);
});

for (const allScenesExcluded of [false, true]) {
test(`browser preserves ${allScenesExcluded ? 'server-excluded empty scenes' : 'valid switches'} until explicit save confirmation`, async ({ page }) => {
  test.setTimeout(90_000);
  await page.context().route('**/api/**', (route) => route.fulfill({ json: {} }));
  const state = await installLocalEditingMocks(page);
  const input = sample();
  if (allScenesExcluded) {
    (input.roomTypes[0] as unknown as { roomScenes: unknown[] }).roomScenes = [null];
  } else (input.roomTypes[0].switches as unknown[]).push(null);
  state.projects = [input as unknown as Record<string, unknown>];
  if (allScenesExcluded) {
    await page.context().route('**/api/projects', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const migrated = migrateProjectsWithReport(state.projects);
      await route.fulfill({ json: { projects: migrated.projects, migrationReport: migrated.report } });
    });
  }
  const raw = JSON.stringify([input]);
  await page.addInitScript((value) => {
    localStorage.setItem('cfs-projects-v14', value);
    localStorage.setItem('cfs-project-drafts-v2', value);
  }, raw);
  let postCount = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/projects') && request.method() === 'POST') postCount++;
  });
  await page.goto('/');
  await expect(page.locator('aside[role="alert"]')).toContainText('除外 1 件');
  await page.locator('button.screen-card').filter({ hasText: 'Migration Safety' }).click();
  await page.getByPlaceholder('New room type name').fill('Another Room');
  await page.getByRole('button', { name: 'Create Room Type' }).click();
  await page.waitForTimeout(1700);
  expect(postCount).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('cfs-project-drafts-v2'))).toBe(raw);
  expect(await page.evaluate(() => localStorage.getItem('cfs-projects-v14'))).toBe(raw);
  await page.screenshot({ path: test.info().outputPath('migration-notice.png'), fullPage: true });
  let acceptSave = false;
  const confirmations: string[] = [];
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'confirm') {
      confirmations.push(dialog.message());
      if (acceptSave) await dialog.accept(); else await dialog.dismiss();
    } else await dialog.dismiss();
  });
  const save = page.getByRole('button', { name: 'Save current project without a new revision', exact: true });
  await save.click();
  await expect.poll(() => confirmations.length).toBe(1);
  expect(postCount).toBe(0);
  await expect(page.locator('aside[role="alert"]')).toBeVisible();
  acceptSave = true;
  await save.click();
  await expect.poll(() => postCount).toBe(1);
  await expect(page.locator('aside[role="alert"]')).toHaveCount(0);
  expect(state.projects[0].roomTypes).toHaveLength(2);
  if (allScenesExcluded) {
    const rooms = state.projects[0].roomTypes as { roomScenes: unknown[] }[];
    expect(rooms[0].roomScenes, JSON.stringify(state.projects[0].roomTypes)).toEqual([]);
  }
  await page.screenshot({ path: test.info().outputPath('migration-saved.png'), fullPage: true });
});
}
