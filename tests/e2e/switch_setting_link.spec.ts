/**
 * T-35: Switch setting link (permanent sync between linked switches).
 *
 * Link button (toolbar, next to Scene/Backlight Setting) puts the checked
 * rows into one settingLinkGroupId. From then on, saving a Function Setting
 * (buttonSetting) or a Backlight CONDITION on any member propagates to every
 * member via commitSwitches. backlightTarget is switch-specific wiring and
 * must NEVER be propagated (protected behavior; past cross-wire incident).
 * Unlink removes only the checked rows; a group left with one member
 * dissolves. Copy Switch never inherits the link.
 *
 * T-62: the checkbox-cell 🔗+symbol badge was removed. Linked rows are now
 * identified by the Setting button TEXT: the Function Setting button shows
 * "Link <symbol>" and the Backlight Setting button shows
 * "Link <symbol> · <condition>" (or "Link <symbol>" while no condition is
 * set). Group colors (shared palette, first-appearance order) still apply to
 * configured buttons only, exactly as in T-35. Unlinked rows keep the
 * original "Setting" / condition-label texts.
 */
import { test, expect, type Page } from "@playwright/test";
import { STORAGE_KEY } from "../../app/lib/constants";
import { SETTING_LINK_COLORS } from "../../app/lib/settingLinkGroups";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

function hexToRgb(hex: string): string {
  const num = parseInt(hex.replace("#", ""), 16);
  return `rgb(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255})`;
}

const PROJECT_DRAFT_STORAGE_KEY = "cfs-project-drafts-v2";

interface SwitchRow {
  id?: string;
  kind?: string;
  settingLinkGroupId?: string;
  backlightCondition?: string;
  backlightTarget?: string;
  buttonSetting?: { sceneIds?: string[]; sceneId?: string; circuitSettings?: Array<{ circuitId: string; percentage: string }> };
}

async function apiPutProjects(page: Page, projects: unknown[]): Promise<void> {
  if (page.url() === "about:blank") {
    await page.goto("/", { waitUntil: "domcontentloaded" });
  }
  await page.evaluate(async ({ nextProjects }) => {
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projects: nextProjects }),
    });
  }, { nextProjects: projects });
}

async function isolate(page: Page): Promise<void> {
  await page.goto("about:blank");
  await page.waitForTimeout(1800);
  await apiPutProjects(page, []);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });
  await page.goto("about:blank");
  await page.waitForTimeout(1800);
  await apiPutProjects(page, []);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !document.body.textContent?.includes("Loading projects"),
    { timeout: 20000 },
  );
}

/** Read the persisted Palladiom switch rows (draft store, then API fallback). */
async function readPalladiomRows(page: Page): Promise<SwitchRow[]> {
  await page.waitForTimeout(1800);
  return page.evaluate(async ({ draftKey }) => {
    const pick = (projects: unknown): SwitchRow[] => {
      const list = projects as Array<{ roomTypes?: Array<{ switches?: Array<{ kind?: string }> }> }>;
      return ((list?.[0]?.roomTypes?.[0]?.switches ?? []) as Array<{ kind?: string }>).filter(
        (item) => item.kind === "lutronPd",
      ) as SwitchRow[];
    };
    try {
      const drafts = JSON.parse(localStorage.getItem(draftKey) || "[]");
      const fromDraft = pick(drafts);
      if (fromDraft.length > 0) return fromDraft;
    } catch { /* fall through to API */ }
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      const body = await res.json();
      return pick(body.projects ?? []);
    } catch {
      return [];
    }
  }, { draftKey: PROJECT_DRAFT_STORAGE_KEY });
}

/** Seed Bedroom area + circuit + scenes so the Function Setting panel has content. */
async function seedAreaAndScenes(page: Page): Promise<void> {
  // Wait for the UI-created project/roomType to reach the (mocked) API via
  // the 1200ms debounce autosave before injecting data.
  await page.waitForTimeout(1800);
  await page.evaluate(async ({ draftKey, storageKey }) => {
    type AnyProject = { roomTypes?: Array<Record<string, unknown>>; [k: string]: unknown };
    const readLocal = (): AnyProject[] => {
      for (const key of [draftKey, storageKey]) {
        try {
          const parsed = JSON.parse(localStorage.getItem(key) || "[]");
          if (Array.isArray(parsed) && parsed[0]?.roomTypes?.[0]) return parsed as AnyProject[];
        } catch { /* ignore */ }
      }
      return [];
    };
    let projects: AnyProject[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      projects = readLocal();
      if (projects.length > 0) break;
      const res = await fetch("/api/projects", { cache: "no-store" });
      const body = await res.json();
      const fromApi = (body.projects ?? []) as AnyProject[];
      if (fromApi[0]?.roomTypes?.[0]) {
        projects = fromApi;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const project = projects[0];
    if (!project?.roomTypes?.[0]) throw new Error("project/roomType not persisted yet");
    project.locations = [
      { id: "t35-area-a", name: "Bedroom", number: "1", color: "#FFC7CE" },
    ];
    project.circuits = [
      {
        id: "t35-cir-1", circuitGroupId: "g1", daliFixtureGroupId: "",
        designerNumber: "D-001", internalNumber: "I-001", dimmingType: "DALI",
        fixture: "", pcs: "1", detail: "Ceiling", area: "t35-area-a",
        ffe: false, energySaving: false,
      },
    ];
    project.roomTypes[0].scenes = [
      { id: "t35-scene-a1", areaId: "t35-area-a", name: "Welcome", settings: [{ circuitId: "t35-cir-1", percentage: "80" }] },
      { id: "t35-scene-a2", areaId: "t35-area-a", name: "Relax", settings: [{ circuitId: "t35-cir-1", percentage: "20" }] },
    ];
    project.roomTypes[0].switches = [];
    try {
      localStorage.setItem(storageKey, JSON.stringify(projects));
      localStorage.setItem(draftKey, JSON.stringify(projects));
    } catch { /* ignore */ }
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projects }),
    });
  }, { draftKey: PROJECT_DRAFT_STORAGE_KEY, storageKey: STORAGE_KEY });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !document.body.textContent?.includes("Loading projects"),
    { timeout: 20000 },
  );
  // Reopen the Switch tab. The app may restore the project/room view after
  // the reload; only walk through the cards when it did not.
  await page.waitForTimeout(500);
  const switchSubTab = page.locator('[role="tab"]').filter({ hasText: /^Switch$/ }).first();
  if (!(await switchSubTab.isVisible().catch(() => false))) {
    const projectCard = page.locator("button.screen-card").first();
    await expect(projectCard).toBeVisible({ timeout: 10000 });
    await projectCard.click();
    await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
    await page.waitForTimeout(300);
    const roomCard = page.locator("button.screen-card").first();
    await expect(roomCard).toBeVisible({ timeout: 8000 });
    await roomCard.click();
  }
  await openSwitchTab(page);
}

async function openSwitchTab(page: Page): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: /^Switch$/ }).first().click();
  await page.waitForTimeout(300);
  await page.locator('.scene-area-chip:has-text("Palladiom")').first().click();
  await page.waitForTimeout(200);
}

async function createProjectAndRoom(page: Page): Promise<void> {
  const nameInput = page.locator('input[placeholder="New project name"]').first();
  await expect(nameInput).toBeVisible({ timeout: 15000 });
  await nameInput.fill(`T35-LINK-${Date.now()}`);
  await page.locator("button").filter({ hasText: /^Create Project$/ }).first().click();
  await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
  await page.waitForTimeout(300);
  const roomInput = page.locator('input[placeholder="New room type name"]').first();
  await roomInput.fill(`T35-Room-${Date.now()}`);
  await page.locator("button").filter({ hasText: /^Create Room Type$/ }).first().click();
}

async function addSwitchRows(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(300);
  }
  // Give every switch an identity (Switch #) so backlight target lists and
  // group headers behave like real data.
  for (let i = 0; i < count; i++) {
    await tableRow(page, i).locator("textarea").first().fill(`SW${i + 1}`);
    await page.waitForTimeout(200);
  }
}

async function checkRows(page: Page, indexes: number[]): Promise<void> {
  for (const index of indexes) {
    await page.locator(".switch-bulk-select-cell input[type=checkbox]").nth(index).check();
  }
}

function tableRow(page: Page, index: number) {
  return page.locator("table.switch-table tbody tr").nth(index);
}

/** Function Setting button of a row (first setting column). */
function fnButton(page: Page, index: number) {
  return tableRow(page, index).locator(".setting-status-button").nth(0);
}

/** Backlight Setting button of a row (second setting column). */
function blButton(page: Page, index: number) {
  return tableRow(page, index).locator(".setting-status-button").nth(1);
}

/** T-62: Function Setting button texts of every row, in row order. */
async function fnButtonTexts(page: Page, rowCount: number): Promise<string[]> {
  const texts: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    texts.push(((await fnButton(page, i).textContent()) ?? "").trim());
  }
  return texts;
}

async function closeOverlay(page: Page): Promise<void> {
  await page.locator(".setting-overlay-actions button").filter({ hasText: /^Close$/ }).click();
  await expect(page.locator(".setting-overlay-panel")).toBeHidden({ timeout: 5000 });
}

test.describe("T-35 switch setting link", () => {
  test.beforeEach(async ({ page }) => {
    await installLocalEditingMocks(page);
  });
  test.setTimeout(240000);

  test("link syncs function setting and backlight condition, never the target; unlink stops sync", async ({ page }) => {
    await isolate(page);
    await createProjectAndRoom(page);
    await seedAreaAndScenes(page);
    await addSwitchRows(page, 3);

    // Give row 1 a switch-specific backlight TARGET before linking.
    await tableRow(page, 0).locator(".setting-status-button").nth(1).click();
    const overlay = page.locator(".setting-overlay-panel");
    await expect(overlay).toBeVisible({ timeout: 5000 });
    const firstTarget = overlay.locator(".switch-target-option input").first();
    await expect(firstTarget).toBeVisible({ timeout: 5000 });
    await firstTarget.check();
    await closeOverlay(page);

    let rows = await readPalladiomRows(page);
    expect(rows.length).toBe(3);
    const row1Target = rows[0].backlightTarget ?? "";
    expect(row1Target).not.toBe("");

    // Link rows 1 + 2.
    await checkRows(page, [0, 1]);
    await page.locator(".toolbar button").filter({ hasText: /^Link$/ }).click();
    await page.waitForTimeout(500);
    // T-62: no checkbox-cell badge anymore; the linked rows are identified by
    // the Setting button text "Link A" (Function AND Backlight buttons; no
    // condition is set yet so the Backlight button shows the symbol alone).
    await expect(page.locator(".switch-setting-link-badge")).toHaveCount(0);
    await expect(fnButton(page, 0)).toHaveText("Link A");
    await expect(fnButton(page, 1)).toHaveText("Link A");
    await expect(fnButton(page, 2)).toHaveText("Setting");
    await expect(blButton(page, 1)).toHaveText("Link A");

    rows = await readPalladiomRows(page);
    expect(rows[0].settingLinkGroupId).toBeTruthy();
    expect(rows[1].settingLinkGroupId).toBe(rows[0].settingLinkGroupId);
    expect(rows[2].settingLinkGroupId ?? "").toBe("");
    // Linking must not copy the template's backlightTarget to the partner.
    expect(rows[0].backlightTarget ?? "").toBe(row1Target);
    expect(rows[1].backlightTarget ?? "").toBe("");

    // Change row 2's Function Setting (area scene) -> row 1 follows.
    await tableRow(page, 1).locator(".setting-status-button").nth(0).click();
    await expect(overlay).toBeVisible({ timeout: 5000 });
    const sceneSelect = overlay.locator("select").first();
    await expect(sceneSelect).toBeVisible({ timeout: 5000 });
    await sceneSelect.selectOption("t35-scene-a1");
    await closeOverlay(page);

    rows = await readPalladiomRows(page);
    expect(rows[0].buttonSetting?.sceneIds ?? []).toContain("t35-scene-a1");
    expect(rows[1].buttonSetting?.sceneIds ?? []).toContain("t35-scene-a1");
    expect(rows[2].buttonSetting?.sceneIds ?? []).not.toContain("t35-scene-a1");

    // T-62: configured linked buttons carry the group color (first group =
    // first palette color) behind the "Link A" text; the unlinked row keeps
    // the plain "Setting" button without that color.
    const groupAColor = hexToRgb(SETTING_LINK_COLORS[0]);
    await expect(fnButton(page, 0)).toHaveText("Link A");
    await expect(fnButton(page, 1)).toHaveText("Link A");
    expect(await fnButton(page, 0).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(groupAColor);
    expect(await fnButton(page, 1).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(groupAColor);
    await expect(fnButton(page, 2)).toHaveText("Setting");
    expect(await fnButton(page, 2).evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(groupAColor);

    // Change row 1's Backlight CONDITION -> row 2 follows; targets untouched.
    await tableRow(page, 0).locator(".setting-status-button").nth(1).click();
    await expect(overlay).toBeVisible({ timeout: 5000 });
    const conditionSelect = overlay.locator("select").first();
    await conditionSelect.selectOption({ index: 1 });
    const chosen = await conditionSelect.inputValue();
    expect(chosen).not.toBe("");
    const chosenLabel = (
      (await conditionSelect.locator("option:checked").textContent()) ?? ""
    ).trim();
    expect(chosenLabel).not.toBe("");
    await closeOverlay(page);

    rows = await readPalladiomRows(page);
    expect(rows[0].backlightCondition ?? "").toBe(chosen);
    expect(rows[1].backlightCondition ?? "").toBe(chosen);
    expect(rows[2].backlightCondition ?? "").toBe("");
    expect(rows[0].backlightTarget ?? "").toBe(row1Target);
    expect(rows[1].backlightTarget ?? "").toBe("");

    // T-62: with a condition set, linked Backlight buttons show
    // "Link A · <condition>"; the unlinked row 3 keeps the plain button.
    await expect(blButton(page, 0)).toHaveText(`Link A · ${chosenLabel}`);
    await expect(blButton(page, 1)).toHaveText(`Link A · ${chosenLabel}`);
    await expect(blButton(page, 2)).toHaveText("Setting");

    // Unlink row 2 -> group of one dissolves entirely.
    await checkRows(page, [1]);
    await page.locator(".toolbar button").filter({ hasText: /^Unlink$/ }).click();
    await page.waitForTimeout(500);
    // T-62: buttons revert to the plain unlinked texts ("Setting" /
    // condition label without the "Link" prefix).
    await expect(fnButton(page, 0)).toHaveText("Setting");
    await expect(fnButton(page, 1)).toHaveText("Setting");
    await expect(blButton(page, 0)).toHaveText(chosenLabel);
    await expect(blButton(page, 1)).toHaveText(chosenLabel);
    await expect(page.locator("table.switch-table .setting-status-button").filter({ hasText: /^Link\s/ })).toHaveCount(0);

    rows = await readPalladiomRows(page);
    expect(rows[0].settingLinkGroupId ?? "").toBe("");
    expect(rows[1].settingLinkGroupId ?? "").toBe("");

    // After unlink, changing row 1 no longer touches row 2.
    await tableRow(page, 0).locator(".setting-status-button").nth(1).click();
    await expect(overlay).toBeVisible({ timeout: 5000 });
    await overlay.locator("select").first().selectOption({ index: 2 });
    const second = await overlay.locator("select").first().inputValue();
    expect(second).not.toBe(chosen);
    await closeOverlay(page);

    rows = await readPalladiomRows(page);
    expect(rows[0].backlightCondition ?? "").toBe(second);
    expect(rows[1].backlightCondition ?? "").toBe(chosen);
  });

  test("multiple groups get distinct symbols on the Setting buttons and Copy Switch never inherits the link", async ({ page }) => {
    await isolate(page);
    await createProjectAndRoom(page);
    await openSwitchTab(page);
    await addSwitchRows(page, 4);

    await checkRows(page, [0, 1]);
    await page.locator(".toolbar button").filter({ hasText: /^Link$/ }).click();
    await page.waitForTimeout(400);
    await checkRows(page, [2, 3]);
    await page.locator(".toolbar button").filter({ hasText: /^Link$/ }).click();
    await page.waitForTimeout(400);

    // T-62: the badge is gone; the group symbol is read from the Function
    // Setting button text. Two groups in first-appearance order: A then B.
    await expect(page.locator(".switch-setting-link-badge")).toHaveCount(0);
    expect(await fnButtonTexts(page, 4)).toEqual(["Link A", "Link A", "Link B", "Link B"]);

    // Copy Switch on the first (linked) switch -> the copy is NOT linked.
    await page.locator('button[aria-label="Copy Switch"]').first().click();
    await page.waitForTimeout(500);
    const rows = await readPalladiomRows(page);
    expect(rows.length).toBe(5);
    const groupIds = rows.map((row) => row.settingLinkGroupId ?? "");
    // Copy inserts right after the source group: index 1 is the copy.
    expect(groupIds[0]).not.toBe("");
    expect(groupIds[1]).toBe("");
    expect(await fnButtonTexts(page, 5)).toEqual(["Link A", "Setting", "Link A", "Link B", "Link B"]);

    // Join: linking the (unlinked) copy together with a group-A member makes
    // group A a three-member group (checked selection joins the existing group).
    await checkRows(page, [0, 1]);
    await page.locator(".toolbar button").filter({ hasText: /^Link$/ }).click();
    await page.waitForTimeout(500);
    expect(await fnButtonTexts(page, 5)).toEqual(["Link A", "Link A", "Link A", "Link B", "Link B"]);
    const joined = await readPalladiomRows(page);
    const joinedIds = joined.map((row) => row.settingLinkGroupId ?? "");
    expect(joinedIds[1]).toBe(joinedIds[0]);
    expect(joinedIds[2]).toBe(joinedIds[0]);
    expect(joinedIds[3]).not.toBe(joinedIds[0]);
    expect(joinedIds[4]).toBe(joinedIds[3]);
  });
});
