import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

// Regression: Palladiom "By Scene" un-setting itself during consecutive edits
// (stale prop-snapshot clobber) and unsaved Backlight edits vanishing on tab
// switches / reloads (2026-08-21 reports). Runs against an isolated
// local-mode server; the code paths under test are shared with supabase mode.

const PLAYWRIGHT_BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3014";
const BY_SCENE = "__byScene";

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

async function createAndOpenProject(page: Page, name: string): Promise<void> {
  const nameInput = page.locator('input[placeholder="New project name"]').first();
  await expect(nameInput).toBeVisible({ timeout: 15000 });
  await nameInput.fill(name);
  await page.locator("button").filter({ hasText: /^Create Project$/ }).first().click();
  await expect(
    page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first(),
  ).toBeVisible({ timeout: 10000 });
}

async function createRoomTypeAndSelect(page: Page, roomName: string): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
  await page.waitForTimeout(300);
  const roomInput = page.locator('input[placeholder="New room type name"]').first();
  await expect(roomInput).toBeVisible({ timeout: 5000 });
  await roomInput.fill(roomName);
  await page.locator("button").filter({ hasText: /^Create Room Type$/ }).first().click();
  await expect(
    page.locator('[role="tab"]').filter({ hasText: /^Switch$/ }).first(),
  ).toBeVisible({ timeout: 8000 });
}

async function subTab(page: Page, pattern: RegExp): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: pattern }).first().click();
  await page.waitForTimeout(300);
}

function assignmentSelect(page: Page) {
  // Only the Palladiom Backlight Assignment selects offer "By Scene".
  return page.locator('select:has(option[value="__byScene"])').first();
}

test.describe("Backlight By-Scene retention", () => {
  test.beforeEach(async ({ page }) => {
    await installLocalEditingMocks(page);
  });
  test.setTimeout(180000);

  test("By-Scene and level edits survive bursts, tab switches, and reload", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, `BL-QA-${Date.now()}`);
    await createRoomTypeAndSelect(page, `BL-Room-${Date.now()}`);

    // Add one Palladiom switch.
    await subTab(page, /^Switch$/);
    await page.locator('.scene-area-chip:has-text("Palladiom")').first().click();
    await page.waitForTimeout(200);
    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(400);

    // Assign By Scene on the Backlight tab.
    await subTab(page, /^Backlight$/);
    const select = assignmentSelect(page);
    await expect(select).toBeVisible({ timeout: 8000 });
    await select.selectOption(BY_SCENE);
    await expect(select).toHaveValue(BY_SCENE);

    // Burst of level edits immediately afterwards (historical clobber window).
    const plusOne = page.locator('button:has-text("+1")').first();
    await expect(plusOne).toBeVisible({ timeout: 5000 });
    await plusOne.click();
    await plusOne.click();
    await plusOne.click();
    await plusOne.click();
    await expect(assignmentSelect(page)).toHaveValue(BY_SCENE);

    // Interleave: assignment change then instant level burst then re-assert.
    await assignmentSelect(page).selectOption(BY_SCENE);
    await plusOne.click();
    await plusOne.click();
    await expect(assignmentSelect(page)).toHaveValue(BY_SCENE);

    // Tab away and back.
    await subTab(page, /^Circuit$/);
    await subTab(page, /^Backlight$/);
    await expect(assignmentSelect(page)).toHaveValue(BY_SCENE);

    // Let the debounced browser-draft save land, then verify the v2 draft —
    // the layer that must survive reloads (server only receives explicit
    // saves by design).
    await page.waitForTimeout(1800);
    const draftAssignment = await page.evaluate(() => {
      try {
        const drafts = JSON.parse(localStorage.getItem("cfs-project-drafts-v2") || "[]");
        const sw = (drafts?.[0]?.roomTypes?.[0]?.switches ?? []).find(
          (item: { kind?: string }) => item.kind === "lutronPd",
        );
        if (!sw) return null;
        // Field-split model: By Scene is backlightAssignment === "".
        return typeof sw.backlightAssignment === "string" ? sw.backlightAssignment : null;
      } catch {
        return null;
      }
    });
    expect(draftAssignment).toBe("");

    // Reload and re-open: the value must still be there.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => !document.body.textContent?.includes("Loading projects"),
      { timeout: 20000 },
    );
    const switchSubTab = page.locator('[role="tab"]').filter({ hasText: /^Backlight$/ }).first();
    if (!(await switchSubTab.isVisible().catch(() => false))) {
      await page.locator("button.screen-card").first().click();
      await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
      await page.waitForTimeout(300);
      await page.locator("button.screen-card").first().click();
    }
    await subTab(page, /^Backlight$/);
    await expect(assignmentSelect(page)).toHaveValue(BY_SCENE);
  });

  test("per-row action edits never break the group's By-Scene assignment", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, `BL-MIX-${Date.now()}`);
    await createRoomTypeAndSelect(page, `BL-MixRoom-${Date.now()}`);

    // One Palladiom switch with 2 button rows (two entries in the same group).
    await subTab(page, /^Switch$/);
    await page.locator('.scene-area-chip:has-text("Palladiom")').first().click();
    await page.waitForTimeout(200);
    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(300);
    const buttonCountSelect = page.locator("tbody select").first();
    await buttonCountSelect.selectOption("2");
    await page.waitForTimeout(400);

    // Give only the FIRST row a per-row backlight condition via its panel.
    await page.locator("tbody .setting-status-button").nth(1).click();
    const overlay = page.locator(".setting-overlay-panel");
    await expect(overlay).toBeVisible({ timeout: 5000 });
    const panelSelect = overlay.locator("select").first();
    await panelSelect.selectOption({ index: 1 });
    const rowValue = await panelSelect.inputValue();
    await overlay.locator("button").filter({ hasText: /^Close$/ }).click();
    await expect(overlay).toBeHidden({ timeout: 5000 });

    // The INDIVIDUAL panel edit must stay scoped to its own row: the second
    // row's condition and both rows' targets are untouched.
    await page.waitForTimeout(1800);
    const afterIndividual = await page.evaluate(() => {
      try {
        const drafts = JSON.parse(localStorage.getItem("cfs-project-drafts-v2") || "[]");
        return (drafts?.[0]?.roomTypes?.[0]?.switches ?? [])
          .filter((item: { kind?: string }) => item.kind === "lutronPd")
          .map((item: { backlightCondition?: string; backlightTarget?: string }) => ({
            condition: item.backlightCondition ?? "",
            target: item.backlightTarget ?? "",
          }));
      } catch {
        return [];
      }
    });
    expect(afterIndividual.length).toBe(2);
    const touched = afterIndividual.filter((row: { condition: string }) => row.condition === rowValue);
    expect(touched.length).toBe(1);
    const untouched = afterIndividual.filter((row: { condition: string }) => row.condition !== rowValue);
    expect(untouched.length).toBe(1);
    expect(untouched[0].condition).toBe("");
    expect(afterIndividual.every((row: { target: string }) => row.target === "" || row.target.length > 0)).toBe(true);

    // Field-split invariant (the 2026-08-21 field report: applying Sleep to
    // Palladiom rows knocked their groups out of By Scene, emptied the
    // target list, and hid their CFS backlight rows): the per-row ACTION
    // never touches the group's ASSIGNMENT, so the dropdown still shows
    // By Scene — NOT (Mixed), and not the edited row's value.
    await subTab(page, /^Backlight$/);
    const select = assignmentSelect(page);
    await expect(select).toBeVisible({ timeout: 8000 });
    await expect(select).toHaveValue(BY_SCENE);

    const readRows = () =>
      page.evaluate(() => {
        try {
          const drafts = JSON.parse(localStorage.getItem("cfs-project-drafts-v2") || "[]");
          return (drafts?.[0]?.roomTypes?.[0]?.switches ?? [])
            .filter((item: { kind?: string }) => item.kind === "lutronPd")
            .map((item: { backlightCondition?: string; backlightAssignment?: string }) => ({
              condition: item.backlightCondition ?? "",
              assignment: item.backlightAssignment ?? "",
            }));
        } catch {
          return null;
        }
      });

    const afterAction = await readRows();
    expect(afterAction).not.toBeNull();
    expect((afterAction as Array<{ assignment: string }>).every((row) => row.assignment === "")).toBe(true);

    // Assigning a fixed level writes the ASSIGNMENT for the whole group and
    // leaves each row's ACTION condition untouched.
    const levelKey = await select.evaluate((el: HTMLSelectElement) =>
      Array.from(el.options)
        .map((option) => option.value)
        .find((value) => value !== "__byScene" && value !== "__mixed") ?? "",
    );
    expect(levelKey).not.toBe("");
    await select.selectOption(levelKey);
    await page.waitForTimeout(1800);
    const afterLevel = (await readRows()) as Array<{ condition: string; assignment: string }>;
    expect(afterLevel.length).toBe(2);
    expect(afterLevel.every((row) => row.assignment === levelKey)).toBe(true);
    expect(afterLevel.filter((row) => row.condition === rowValue).length).toBe(1);
    expect(afterLevel.filter((row) => row.condition === "").length).toBe(1);

    // Returning to By Scene restores assignment "" — actions still intact.
    await assignmentSelect(page).selectOption(BY_SCENE);
    await page.waitForTimeout(1800);
    const afterByScene = (await readRows()) as Array<{ condition: string; assignment: string }>;
    expect(afterByScene.every((row) => row.assignment === "")).toBe(true);
    expect(afterByScene.filter((row) => row.condition === rowValue).length).toBe(1);
    await expect(assignmentSelect(page)).toHaveValue(BY_SCENE);
  });
});
