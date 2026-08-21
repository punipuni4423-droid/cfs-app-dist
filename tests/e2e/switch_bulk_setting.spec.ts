import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

// Bulk setting feature (2026-08-21): checkbox column left of Function
// Setting + toolbar Scene/Backlight Setting buttons that apply one panel's
// values to every checked row.

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

test.describe("Switch bulk setting", () => {
  test.beforeEach(async ({ page }) => {
    await installLocalEditingMocks(page);
  });
  test.setTimeout(180000);

  test("backlight setting applies to all checked rows at once", async ({ page }) => {
    await isolate(page);

    const nameInput = page.locator('input[placeholder="New project name"]').first();
    await expect(nameInput).toBeVisible({ timeout: 15000 });
    await nameInput.fill(`BULK-QA-${Date.now()}`);
    await page.locator("button").filter({ hasText: /^Create Project$/ }).first().click();
    await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
    await page.waitForTimeout(300);
    const roomInput = page.locator('input[placeholder="New room type name"]').first();
    await roomInput.fill(`BULK-Room-${Date.now()}`);
    await page.locator("button").filter({ hasText: /^Create Room Type$/ }).first().click();

    // Switch tab: add two Palladiom switches.
    await page.locator('[role="tab"]').filter({ hasText: /^Switch$/ }).first().click();
    await page.waitForTimeout(300);
    await page.locator('.scene-area-chip:has-text("Palladiom")').first().click();
    await page.waitForTimeout(200);
    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(300);
    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(300);

    // Select all rows via the header checkbox.
    const selectAll = page.locator(".switch-bulk-select-header input").first();
    await expect(selectAll).toBeVisible({ timeout: 5000 });
    await selectAll.check();
    await expect(page.locator(".muted-pill").filter({ hasText: /checked/ })).toHaveText(/2 checked/);

    // Toolbar Backlight Setting opens the panel with the bulk Apply button.
    await page.locator(".toolbar button").filter({ hasText: /^Backlight Setting$/ }).click();
    const overlay = page.locator(".setting-overlay-panel");
    await expect(overlay).toBeVisible({ timeout: 5000 });
    const applyButton = overlay.locator("button").filter({ hasText: /^Apply to 2 rows$/ });
    await expect(applyButton).toBeVisible();

    // Pick a backlight condition in the panel (first select, second option).
    const panelSelect = overlay.locator("select").first();
    await expect(panelSelect).toBeVisible({ timeout: 5000 });
    await panelSelect.selectOption({ index: 1 });
    const chosen = await panelSelect.inputValue();
    expect(chosen).not.toBe("");

    await applyButton.click();
    await expect(overlay).toBeHidden({ timeout: 5000 });

    // Both rows carry the same condition in the persisted draft.
    await page.waitForTimeout(1800);
    const conditions = await page.evaluate(() => {
      try {
        const drafts = JSON.parse(localStorage.getItem("cfs-project-drafts-v2") || "[]");
        return (drafts?.[0]?.roomTypes?.[0]?.switches ?? [])
          .filter((item: { kind?: string }) => item.kind === "lutronPd")
          .map((item: { backlightCondition?: string }) => item.backlightCondition ?? "");
      } catch {
        return [];
      }
    });
    expect(conditions.length).toBe(2);
    expect(conditions[0]).toBe(chosen);
    expect(conditions[1]).toBe(chosen);

    // Selection resets after applying.
    await expect(page.locator(".muted-pill").filter({ hasText: /checked/ })).toHaveText(/0 checked/);
  });
});
