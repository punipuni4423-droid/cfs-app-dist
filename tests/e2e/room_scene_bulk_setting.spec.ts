import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

// Bulk setting on the Scene tab (2026-08-21): checkbox column + top-right
// Scene Setting / Backlight Setting buttons, mirroring the Switch tab bulk
// feature. Also covers the Backlight tab's bulk Palladiom assignment.

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

async function createProjectAndRoom(page: Page, prefix: string): Promise<void> {
  const nameInput = page.locator('input[placeholder="New project name"]').first();
  await expect(nameInput).toBeVisible({ timeout: 15000 });
  await nameInput.fill(`${prefix}-${Date.now()}`);
  await page.locator("button").filter({ hasText: /^Create Project$/ }).first().click();
  await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
  await page.waitForTimeout(300);
  const roomInput = page.locator('input[placeholder="New room type name"]').first();
  await roomInput.fill(`${prefix}-Room-${Date.now()}`);
  await page.locator("button").filter({ hasText: /^Create Room Type$/ }).first().click();
  await expect(
    page.locator('[role="tab"]').filter({ hasText: /^Switch$/ }).first(),
  ).toBeVisible({ timeout: 8000 });
}

test.describe("Scene tab bulk setting", () => {
  test.beforeEach(async ({ page }) => {
    await installLocalEditingMocks(page);
  });
  test.setTimeout(180000);

  test("backlight setting applies to all checked scene rows at once", async ({ page }) => {
    await isolate(page);
    await createProjectAndRoom(page, "SCENE-BULK");

    await page.locator('[role="tab"]').filter({ hasText: /^Scene$/ }).first().click();
    await page.waitForTimeout(300);

    // Select every default Door Magnet scene via that table's header checkbox
    // (index 0 belongs to the From PMS table, which starts empty).
    const selectAll = page.locator(".switch-bulk-select-header input").nth(1);
    await expect(selectAll).toBeVisible({ timeout: 5000 });
    await selectAll.check();
    const checkedText = await page
      .locator(".room-scene-bulk-toolbar .muted-pill")
      .filter({ hasText: /checked/ })
      .textContent();
    const checkedCount = Number.parseInt(checkedText ?? "0", 10);
    expect(checkedCount).toBeGreaterThanOrEqual(2);

    // Top-right Backlight Setting opens the panel with the bulk Apply button.
    await page
      .locator(".room-scene-bulk-toolbar button")
      .filter({ hasText: /^Backlight Setting$/ })
      .click();
    const overlay = page.locator(".setting-overlay-panel");
    await expect(overlay).toBeVisible({ timeout: 5000 });
    const applyButton = overlay
      .locator("button")
      .filter({ hasText: new RegExp(`^Apply to ${checkedCount} rows$`) });
    await expect(applyButton).toBeVisible();

    const conditionSelect = overlay.locator("select").first();
    await conditionSelect.selectOption({ index: 1 });
    const chosen = await conditionSelect.inputValue();
    expect(chosen).not.toBe("");

    await applyButton.click();
    await expect(overlay).toBeHidden({ timeout: 5000 });

    await page.waitForTimeout(1800);
    const conditions = await page.evaluate(() => {
      try {
        const drafts = JSON.parse(localStorage.getItem("cfs-project-drafts-v2") || "[]");
        return (drafts?.[0]?.roomTypes?.[0]?.roomScenes ?? []).map(
          (scene: { backlightCondition?: string }) => scene.backlightCondition ?? "",
        );
      } catch {
        return null;
      }
    });
    expect(conditions).not.toBeNull();
    expect((conditions as string[]).filter((value) => value === chosen).length).toBe(checkedCount);

    // Selection resets after applying.
    await expect(
      page.locator(".room-scene-bulk-toolbar .muted-pill").filter({ hasText: /checked/ }),
    ).toHaveText(/0 checked/);
  });

  test("Backlight tab bulk-assigns the Palladiom backlight scene", async ({ page }) => {
    await isolate(page);
    await createProjectAndRoom(page, "BL-BULK");

    // Two Palladiom switches (two groups).
    await page.locator('[role="tab"]').filter({ hasText: /^Switch$/ }).first().click();
    await page.waitForTimeout(300);
    await page.locator('.scene-area-chip:has-text("Palladiom")').first().click();
    await page.waitForTimeout(200);
    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(300);
    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(300);

    await page.locator('[role="tab"]').filter({ hasText: /^Backlight$/ }).first().click();
    await page.waitForTimeout(300);

    const selectAll = page.locator(".switch-bulk-select-header input").first();
    await expect(selectAll).toBeVisible({ timeout: 5000 });
    await selectAll.check();
    await expect(page.locator(".muted-pill").filter({ hasText: /checked/ })).toHaveText(/2 checked/);

    const bulkSelect = page.locator(".backlight-bulk-assign-select");
    await bulkSelect.selectOption({ index: 1 });
    const chosen = await bulkSelect.inputValue();
    expect(chosen).not.toBe("__byScene");

    await page.locator(".toolbar button").filter({ hasText: /^Apply$/ }).click();
    await page.waitForTimeout(1800);

    const rows = await page.evaluate(() => {
      try {
        const drafts = JSON.parse(localStorage.getItem("cfs-project-drafts-v2") || "[]");
        return (drafts?.[0]?.roomTypes?.[0]?.switches ?? [])
          .filter((item: { kind?: string }) => item.kind === "lutronPd")
          .map((item: { backlightAssignment?: string; backlightCondition?: string }) => ({
            assignment: item.backlightAssignment ?? "",
            condition: item.backlightCondition ?? "",
          }));
      } catch {
        return null;
      }
    });
    expect(rows).not.toBeNull();
    const typed = rows as Array<{ assignment: string; condition: string }>;
    expect(typed.length).toBe(2);
    // Bulk assignment writes the ASSIGNMENT only; per-row ACTION conditions
    // stay untouched.
    expect(typed.every((row) => row.assignment === chosen)).toBe(true);
    expect(typed.every((row) => row.condition === "")).toBe(true);

    // Selection resets after applying.
    await expect(page.locator(".muted-pill").filter({ hasText: /checked/ })).toHaveText(/0 checked/);
  });
});
