import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

// Command tab (2026-08-21): per-row Backlight Setting button + bulk-select
// checkboxes with top-right Scene/Backlight Setting buttons.

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

test.describe("Command tab backlight + bulk setting", () => {
  test.beforeEach(async ({ page }) => {
    await installLocalEditingMocks(page);
  });
  test.setTimeout(180000);

  test("backlight bulk applies the condition to all checked commands", async ({ page }) => {
    await isolate(page);

    const nameInput = page.locator('input[placeholder="New project name"]').first();
    await expect(nameInput).toBeVisible({ timeout: 15000 });
    await nameInput.fill(`CMD-BULK-${Date.now()}`);
    await page.locator("button").filter({ hasText: /^Create Project$/ }).first().click();
    await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
    await page.waitForTimeout(300);
    const roomInput = page.locator('input[placeholder="New room type name"]').first();
    await roomInput.fill(`CMD-Room-${Date.now()}`);
    await page.locator("button").filter({ hasText: /^Create Room Type$/ }).first().click();
    await page.waitForTimeout(400);

    // Two command rows.
    await page.locator('[role="tab"]').filter({ hasText: /^Command$/ }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(300);
    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(300);

    // The per-row Backlight Setting button exists (unset rows show "Setting").
    await expect(page.locator("tbody .setting-status-button")).toHaveCount(2);

    // Select all commands and open the bulk backlight panel.
    const selectAll = page.locator(".switch-bulk-select-header input").first();
    await selectAll.check();
    await expect(page.locator(".muted-pill").filter({ hasText: /checked/ })).toHaveText(/2 checked/);
    await page.locator(".toolbar button").filter({ hasText: /^Backlight Setting$/ }).click();

    // The overlay header (with the bulk Apply button) lives in
    // .setting-overlay-panel; .switch-setting-card is only the inner panel.
    const panel = page.locator(".setting-overlay-panel").first();
    await expect(panel).toBeVisible({ timeout: 5000 });
    const conditionSelect = panel.locator("select").first();
    await conditionSelect.selectOption({ index: 1 });
    const chosen = await conditionSelect.inputValue();
    expect(chosen).not.toBe("");

    await panel.locator("button").filter({ hasText: /^Apply to 2 rows$/ }).click();
    await page.waitForTimeout(1800);

    const rows = await page.evaluate(() => {
      try {
        const drafts = JSON.parse(localStorage.getItem("cfs-project-drafts-v2") || "[]");
        return (drafts?.[0]?.roomTypes?.[0]?.switches ?? [])
          .filter((item: { kind?: string }) => item.kind === "command")
          .map((item: { backlightCondition?: string; backlightTarget?: string }) => ({
            condition: item.backlightCondition ?? "",
            target: item.backlightTarget ?? "",
          }));
      } catch {
        return null;
      }
    });
    expect(rows).not.toBeNull();
    const typed = rows as Array<{ condition: string; target: string }>;
    expect(typed.length).toBe(2);
    expect(typed.every((row) => row.condition === chosen)).toBe(true);
    // Targets stay per-command.
    expect(typed.every((row) => row.target === "")).toBe(true);

    // Selection resets and the row buttons now show the level name.
    await expect(page.locator(".muted-pill").filter({ hasText: /checked/ })).toHaveText(/0 checked/);
  });
});
