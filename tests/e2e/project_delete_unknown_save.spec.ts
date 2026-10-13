import { test, expect, type Page } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { createNewProject, prepareProjectSave } from '../../app/lib/storage';
import type { ProjectData } from '../../app/types';

const WARNING = 'Warning: the last save of this project could not be verified. Its latest changes may not be saved to the database.\n'
  + 'A local draft is retained on this device and can be exported from Save and Recovery.\n\n';
const trashConfirm = (name: string) => `Move project "${name}" to Trash?\n\nIt will be permanently deleted only when you empty Trash.`;
const SCOPE_TAB = 'synthetic-previous-tab';

/** Record body without identity; the browser-side seed adds `key`/`scope` from its own origin (see installSeed). */
interface DraftSeed { projectId: string; tab: string; record: Record<string, unknown> }

/** Fallback draft record with a retained save intent and no verified evidence: the save outcome is unknown. */
async function unknownSaveSeed(first: ProjectData): Promise<DraftSeed> {
  const sent = await prepareProjectSave({ ...first, updatedAt: '2032-01-01T00:00:00.000Z', remarks: [{ ...first.remarks![0], body: 'unverified save' }] }, 'current');
  return { projectId: first.id, tab: SCOPE_TAB, record: { project: sent, generation: 1, savedAt: '2032-01-01T00:00:01.000Z', baseUpdatedAt: first.updatedAt,
    intent: { before: first, project: sent, expectedUpdatedAt: first.updatedAt, operationId: sent.lastSaveOperation!.id } } };
}

/** The same intent retained verbatim as verified-save evidence: the save outcome is known. */
async function confirmedEvidenceSeed(first: ProjectData): Promise<DraftSeed> {
  const { record } = await unknownSaveSeed(first);
  const sent = record.project as ProjectData;
  return { projectId: first.id, tab: `recovery:save-evidence:${SCOPE_TAB}`, record: { ...record, baseUpdatedAt: null,
    confirmedSaveEvidence: { kind: 'confirmed-save', operationId: sent.lastSaveOperation!.id, fingerprint: sent.lastSaveOperation!.fingerprint,
      saveKind: sent.lastSaveOperation!.kind, confirmedAt: '2032-01-01T00:00:02.000Z' } } };
}

function fixtureProject(name: string): ProjectData {
  const project = createNewProject(name);
  project.remarks = [{ id: 'remark', title: 'Original', body: 'base', hasTable: false, columns: [], rows: [] }];
  return project;
}

function fallbackKey(page: Page, seed: DraftSeed): string {
  return JSON.stringify([`local:${new URL(page.url()).origin}`, 'mock-user', seed.projectId, seed.tab]);
}

async function installSeed(page: Page, seed: DraftSeed) {
  await page.addInitScript(({ seed }) => {
    localStorage.setItem('cfs-collaboration-user-v1', JSON.stringify({ id: 'mock-user', displayName: 'Synthetic tester' }));
    const scope = { workspace: `local:${location.origin}`, owner: 'mock-user', tab: seed.tab };
    const key = JSON.stringify([scope.workspace, scope.owner, seed.projectId, scope.tab]);
    localStorage.setItem(`cfs-draft-project-v3:${key}`, JSON.stringify({ key, scope, ...seed.record }));
  }, { seed });
}

function readFallback(page: Page, seed: DraftSeed) {
  return page.evaluate(key => localStorage.getItem(`cfs-draft-project-v3:${key}`), fallbackKey(page, seed));
}

function trackDialogs(page: Page, respond: 'accept' | 'dismiss') {
  const messages: string[] = [];
  page.on('dialog', dialog => { messages.push(dialog.message()); void (respond === 'accept' ? dialog.accept() : dialog.dismiss()); });
  return messages;
}

function trackDeletes(page: Page) {
  const counts = { deletes: 0, writes: 0 };
  page.on('request', request => {
    if (/\/api\/projects\/delete(?:[/?]|$)/.test(request.url())) counts.deletes++;
    if (/\/api\/(projects|trash)(?:[/?]|$)/.test(request.url()) && request.method() !== 'GET') counts.writes++;
  });
  return counts;
}

async function openListWithRecovery(page: Page, seeded: 'intent' | 'evidence') {
  await page.goto('/');
  // Draft initialization is asynchronous; wait for the recovery panel to reflect the seeded record before deleting.
  await page.getByTestId('save-recovery-toggle').click();
  await expect(page.getByTestId('save-recovery-panel')).toBeVisible();
  const record = page.getByTestId('recovery-record');
  await expect(record).toHaveCount(1);
  if (seeded === 'intent') await expect(record.getByRole('button', { name: 'Check Previous Save', exact: true })).toBeVisible();
  else await expect(record).toContainText('Verified save evidence');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('save-recovery-panel')).toHaveCount(0);
}

function deleteButton(page: Page, name: string) {
  return page.locator('.screen-card-wrap').filter({ hasText: name }).getByRole('button', { name: 'Delete Project', exact: true });
}

test('unknown save outcome: Delete warns first; Cancel sends nothing and keeps the project and its draft', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const first = fixtureProject('Unknown save outcome project'), other = fixtureProject('Clean sibling project');
  state.projects = [first, other] as unknown as Record<string, unknown>[];
  const seed = await unknownSaveSeed(first);
  await installSeed(page, seed);
  const messages = trackDialogs(page, 'dismiss');
  const counts = trackDeletes(page);
  await openListWithRecovery(page, 'intent');
  const originalBytes = await readFallback(page, seed);
  expect(originalBytes).not.toBeNull();
  await deleteButton(page, first.name).click();
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toBe(`${WARNING}${trashConfirm(first.name)}`);
  await expect(page.locator('.screen-card-wrap').filter({ hasText: first.name })).toBeVisible();
  await expect(deleteButton(page, first.name)).toBeEnabled();
  expect(counts.deletes).toBe(0);
  expect(counts.writes).toBe(0);
  expect(state.projects).toEqual([first, other]);
  expect(state.trash.projects).toEqual([]);
  expect(await readFallback(page, seed)).toBe(originalBytes);
  await expect(page.locator('.trash-row')).toHaveCount(0);
});

test('unknown save outcome: proceeding after the warning moves the project to Trash as before and retains the draft', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const first = fixtureProject('Unknown save outcome proceed'), other = fixtureProject('Clean sibling project');
  state.projects = [first, other] as unknown as Record<string, unknown>[];
  const seed = await unknownSaveSeed(first);
  await installSeed(page, seed);
  const messages = trackDialogs(page, 'accept');
  const counts = trackDeletes(page);
  await openListWithRecovery(page, 'intent');
  const originalBytes = await readFallback(page, seed);
  expect(originalBytes).not.toBeNull();
  await deleteButton(page, first.name).click();
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toBe(`${WARNING}${trashConfirm(first.name)}`);
  await expect(page.locator('.trash-row').filter({ hasText: first.name })).toBeVisible();
  await expect(page.locator('.screen-card-wrap').filter({ hasText: first.name })).toHaveCount(0);
  await expect.poll(() => state.trash.projects.length).toBe(1);
  expect(counts.deletes).toBe(1);
  expect(state.projects).toEqual([other]);
  expect((state.trash.projects[0].project as ProjectData).id).toBe(first.id);
  // The warning promises a retained local draft: deletion must not remove it.
  expect(await readFallback(page, seed)).toBe(originalBytes);
  await expect(page.locator('.screen-card-wrap').filter({ hasText: other.name })).toBeVisible();
});

test('known save outcome: Delete shows only the existing Trash confirmation', async ({ page }) => {
  const state = await installLocalEditingMocks(page);
  const first = fixtureProject('Verified evidence project'), plain = fixtureProject('Plain confirmed project');
  state.projects = [first, plain] as unknown as Record<string, unknown>[];
  // A verified-save evidence record for `first` is not an unresolved intent; `plain` has no draft record at all.
  await installSeed(page, await confirmedEvidenceSeed(first));
  const messages = trackDialogs(page, 'accept');
  const counts = trackDeletes(page);
  await openListWithRecovery(page, 'evidence');
  await deleteButton(page, first.name).click();
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toBe(trashConfirm(first.name));
  await expect(page.locator('.trash-row').filter({ hasText: first.name })).toBeVisible();
  await expect.poll(() => counts.deletes).toBe(1);
  await deleteButton(page, plain.name).click();
  await expect.poll(() => messages.length).toBe(2);
  expect(messages[1]).toBe(trashConfirm(plain.name));
  await expect(page.locator('.trash-row').filter({ hasText: plain.name })).toBeVisible();
  await expect.poll(() => counts.deletes).toBe(2);
  expect(state.projects).toEqual([]);
  expect(state.trash.projects).toHaveLength(2);
});
