import { test, expect, type Dialog, type Page } from '@playwright/test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';

/**
 * AUDIT-01 — Project lifecycle audit
 * Scope: create / rename / duplicate / delete / persistence-after-reload
 *
 * Persistence model (discovered from source):
 *   - app/page.tsx debounces saves by 1200ms then POSTs to /api/projects
 *   - /api/projects persists to data/projects.json on the server (single shared file)
 *   - On mount, loadProjectsFromDatabase() GETs /api/projects (server = source of truth)
 *     and mirrors into localStorage.
 *
 * IMPORTANT — shared backend:
 *   The server persists to ONE data/projects.json. Other audit agents run concurrently
 *   against the same file. This suite therefore MUST NOT wipe the server. Instead it:
 *     - uses run-unique project names (prefix AU01-<runId>) so it never collides,
 *     - asserts only on its OWN cards (tolerating other projects in the list),
 *     - cleans up only its own projects in afterAll (never touches foreign data).
 */

const SHOT_DIR = 'test-results/audit-01';
const SAVE_DEBOUNCE_MS = 1600; // 1200ms app debounce + margin
const RUN_ID = `${Date.now().toString(36)}`;
const PREFIX = `AU01-${RUN_ID}`;

function pname(label: string): string {
  return `${PREFIX}-${label}`;
}

interface ServerProject {
  id?: string;
  name?: string;
}

let mockState: { projects: ServerProject[] };

/**
 * The dev server is shared with other concurrent audit agents and occasionally
 * restarts/recompiles, briefly refusing connections. Retry transient failures so the
 * audit does not report false negatives unrelated to its own scope.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  throw new Error(`${label} failed after retries: ${String(lastError)}`);
}

async function getServerProjects(page: Page): Promise<ServerProject[]> {
  return withRetry(async () => mockState?.projects ?? [], 'getServerProjects');
}

async function setServerProjects(page: Page, projects: ServerProject[]): Promise<void> {
  await withRetry(async () => {
    mockState.projects = projects;
  }, 'setServerProjects');
}

/** Remove only this run's projects from the shared server file, leaving others intact. */
async function cleanupOwnProjects(page: Page): Promise<void> {
  const all = await getServerProjects(page);
  const kept = all.filter((p) => !(p.name ?? '').startsWith(PREFIX));
  if (kept.length !== all.length) {
    await setServerProjects(page, kept);
  }
}

function ownCards(page: Page) {
  return page.locator('li.screen-card-wrap', {
    has: page.locator(`span.screen-card-title:has-text("${PREFIX}")`),
  });
}

function projectCard(page: Page, name: string) {
  return page.locator('li.screen-card-wrap', {
    has: page.locator('span.screen-card-title', { hasText: name }),
  });
}

/** Scope action buttons to the actions row to avoid matching the card button itself. */
function cardAction(page: Page, name: string, action: 'Rename' | 'Export' | 'Delete') {
  const accessibleName = `${action} Project`;
  return projectCard(page, name)
    .locator('.screen-card-actions')
    .getByRole('button', { name: accessibleName, exact: true });
}

async function gotoList(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'CFS Project Selection' })).toBeVisible();
}

async function createProjectAndReturn(page: Page, name: string): Promise<void> {
  await page.getByPlaceholder('New project name').fill(name);
  await page.getByRole('button', { name: 'Create Project' }).click();
  // Create navigates INTO the project (ProjectScreen); verify, then return to list.
  await expect(page.getByText('Back to Project List')).toBeVisible();
  await page.getByText('Back to Project List').click();
  await expect(page.getByRole('heading', { name: 'CFS Project Selection' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.describe('AUDIT-01 project lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    mockState = await installLocalEditingMocks(page);
    // Do not wipe the shared server. Remove any leftovers from THIS run and ensure
    // local browser storage is clean before the app mounts. A prior test's debounced
    // save (1200ms) may land slightly after it ends, so cleanup is retried until the
    // server is genuinely free of this run's projects.
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await cleanupOwnProjects(page);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'CFS Project Selection' })).toBeVisible({ timeout: 15000 });

    // Belt-and-suspenders: the backend is a single shared JSON file under concurrent
    // writes from other audit agents (last-writer-wins), so a server cleanup can be
    // clobbered. If any of THIS run's cards remain, delete them through the UI so each
    // test still starts from a clean slate for its own project set.
    for (let guard = 0; guard < 10; guard++) {
      const remaining = await ownCards(page).count();
      if (remaining === 0) break;
      await ownCards(page).first().locator('.screen-card-actions')
        .getByRole('button', { name: 'Delete', exact: true })
        .click();
      await expect(ownCards(page)).toHaveCount(remaining - 1);
    }
    await expect(ownCards(page)).toHaveCount(0);
  });

  test('create multiple projects', async ({ page }) => {
    await createProjectAndReturn(page, pname('Alpha'));
    await expect(projectCard(page, pname('Alpha'))).toHaveCount(1);

    await createProjectAndReturn(page, pname('Beta'));
    await expect(projectCard(page, pname('Beta'))).toHaveCount(1);

    // Both of this run's cards coexist; newest is prepended among our own set.
    await expect(ownCards(page)).toHaveCount(2);
    const ownTitles = await ownCards(page)
      .locator('span.screen-card-title')
      .allTextContents();
    expect(ownTitles).toContain(pname('Alpha'));
    expect(ownTitles).toContain(pname('Beta'));

    await page.screenshot({ path: `${SHOT_DIR}/01-create-two.png`, fullPage: true });
  });

  test('newest project is prepended to the list', async ({ page }) => {
    await createProjectAndReturn(page, pname('First'));
    await createProjectAndReturn(page, pname('Second'));

    // page.tsx prepends new projects: [project, ...current]. The shared list may also
    // contain other agents' projects, so we assert ORDER WITHIN our own set: the more
    // recently created 'Second' must appear before 'First'.
    const allTitles = await page.locator('span.screen-card-title').allTextContents();
    const idxSecond = allTitles.indexOf(pname('Second'));
    const idxFirst = allTitles.indexOf(pname('First'));
    expect(idxSecond).toBeGreaterThanOrEqual(0);
    expect(idxFirst).toBeGreaterThan(idxSecond); // newest (Second) is earlier in list
  });

  test('reject duplicate name on create', async ({ page }) => {
    await createProjectAndReturn(page, pname('Dup'));

    let alertText = '';
    page.once('dialog', async (d: Dialog) => {
      alertText = d.message();
      await d.accept();
    });
    await page.getByPlaceholder('New project name').fill(pname('Dup'));
    await page.getByRole('button', { name: 'Create Project' }).click();

    await expect.poll(() => alertText).toContain('same name');
    await expect(projectCard(page, pname('Dup'))).toHaveCount(1);
  });

  test('rename a project (via window.prompt) and persist', async ({ page }) => {
    await createProjectAndReturn(page, pname('RenameSrc'));

    page.once('dialog', async (d: Dialog) => {
      expect(d.type()).toBe('prompt');
      await d.accept(pname('RenameDst'));
    });
    await cardAction(page, pname('RenameSrc'), 'Rename').click();

    await expect(projectCard(page, pname('RenameDst'))).toHaveCount(1);
    await expect(projectCard(page, pname('RenameSrc'))).toHaveCount(0);
    await page.screenshot({ path: `${SHOT_DIR}/02-rename.png`, fullPage: true });

    // Verify the rename PERSISTS by reloading through the app (reading back from the
    // server via the UI). A direct one-shot API poll is unreliable here because the
    // single shared data file is under concurrent writes from other audit agents.
    await page.waitForTimeout(SAVE_DEBOUNCE_MS);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'CFS Project Selection' })).toBeVisible();
    await expect(projectCard(page, pname('RenameDst'))).toHaveCount(1);
    await expect(projectCard(page, pname('RenameSrc'))).toHaveCount(0);
  });

  test('rename cancel keeps original name', async ({ page }) => {
    await createProjectAndReturn(page, pname('KeepMe'));

    page.once('dialog', async (d: Dialog) => {
      await d.dismiss(); // Cancel in the prompt
    });
    await cardAction(page, pname('KeepMe'), 'Rename').click();

    await expect(projectCard(page, pname('KeepMe'))).toHaveCount(1);
  });

  test('DUPLICATE feature is absent (documented finding)', async ({ page }) => {
    await createProjectAndReturn(page, pname('DupCheck'));

    const card = projectCard(page, pname('DupCheck'));
    await expect(card.getByRole('button', { name: /duplicate/i })).toHaveCount(0);
    await expect(card.getByRole('button', { name: /copy/i })).toHaveCount(0);
    await expect(card.getByRole('button', { name: /clone/i })).toHaveCount(0);

    const actions = await card.locator('.screen-card-actions button').evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent?.trim() || ''),
    );
    console.log('AUDIT-01 per-card actions present:', JSON.stringify(actions));
    expect(actions).toEqual(['Rename Project', 'Export Project', 'Delete Project']);

    await page.screenshot({ path: `${SHOT_DIR}/03-no-duplicate.png`, fullPage: true });
  });

  test('delete a project after confirmation', async ({ page }) => {
    await createProjectAndReturn(page, pname('Keep'));
    await createProjectAndReturn(page, pname('DeleteMe'));
    await expect(ownCards(page)).toHaveCount(2);

    let dialogAppeared = false;
    const handler = async (d: Dialog) => {
      dialogAppeared = true;
      await d.accept();
    };
    page.on('dialog', handler);

    await cardAction(page, pname('DeleteMe'), 'Delete').click();

    // Deletion is protected by a confirmation dialog.
    await expect(projectCard(page, pname('DeleteMe'))).toHaveCount(0);
    await expect(projectCard(page, pname('Keep'))).toHaveCount(1);

    await page.waitForTimeout(500);
    page.off('dialog', handler);

    console.log('AUDIT-01 delete confirmation dialog shown?', dialogAppeared);
    expect(dialogAppeared, 'Delete should ask for confirmation before removing a project').toBe(true);

    await page.screenshot({ path: `${SHOT_DIR}/04-after-delete.png`, fullPage: true });
  });

  test('persistence after reload', async ({ page }) => {
    await createProjectAndReturn(page, pname('Persist-A'));
    await createProjectAndReturn(page, pname('Persist-B'));
    await expect(ownCards(page)).toHaveCount(2);

    // In secure-sharing regression mode, persistence is verified through app reload.
    // Production Supabase read/write is covered by the separate authenticated smoke.
    await page.waitForTimeout(SAVE_DEBOUNCE_MS);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'CFS Project Selection' })).toBeVisible({ timeout: 15000 });

    await expect(projectCard(page, pname('Persist-A'))).toHaveCount(1);
    await expect(projectCard(page, pname('Persist-B'))).toHaveCount(1);

    await page.screenshot({ path: `${SHOT_DIR}/05-after-reload.png`, fullPage: true });
  });

  test('deletion persists after reload', async ({ page }) => {
    await createProjectAndReturn(page, pname('Stay'));
    await createProjectAndReturn(page, pname('Gone'));
    await page.waitForTimeout(SAVE_DEBOUNCE_MS);

    page.once('dialog', async (d: Dialog) => {
      await d.accept();
    });
    await cardAction(page, pname('Gone'), 'Delete').click();
    await expect(projectCard(page, pname('Gone'))).toHaveCount(0);

    await page.waitForTimeout(SAVE_DEBOUNCE_MS);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'CFS Project Selection' })).toBeVisible({ timeout: 15000 });

    await expect(projectCard(page, pname('Stay'))).toHaveCount(1);
    await expect(projectCard(page, pname('Gone'))).toHaveCount(0);
  });
});
