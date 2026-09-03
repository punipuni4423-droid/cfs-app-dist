/**
 * T-57: Dimming-row "Uneffected" active display.
 *
 * The percent (dimming) rows in the setting panels render "Uneffected" as a
 * standalone .btn-clear-circuit button. Unlike the On/Off rows (and the
 * Raise/Lower quick buttons) it carried no is-active class, so a selected
 * "Uneffected" state was invisible. This spec locks the display rule:
 *   value === ""  ->  the Uneffected button shows .is-active
 * across every copy of the panel:
 *   - Area Scene tab (SceneView per-circuit rows)
 *   - Switch tab Function Setting panel (Individual Override)
 *   - Command tab Setting panel (Individual Override)
 *   - Scene tab (RoomSceneView Individual Override; quick-button variant that
 *     was already correct - regression guard)
 * Display-only: the persisted values ("" / "Raise" / percent) must not change.
 */
import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

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

async function gotoParentTab(page: Page, label: RegExp): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: label }).first().click();
  await page.waitForTimeout(200);
}

async function gotoSubTab(page: Page, label: RegExp): Promise<void> {
  const subTab = page.locator('[role="tab"]').filter({ hasText: label }).first();
  if (!(await subTab.isVisible().catch(() => false))) {
    await gotoParentTab(page, /Room Type/);
  }
  await expect(subTab).toBeVisible({ timeout: 8000 });
  await subTab.click();
  await page.waitForTimeout(250);
}

async function addArea(page: Page, areaName: string): Promise<void> {
  await gotoParentTab(page, /^Area$/);
  const addBtn = page.locator(".btn-add-row").first();
  await expect(addBtn).toBeVisible({ timeout: 5000 });
  await addBtn.click();
  const row = page.locator("tbody tr").last();
  const nameInput = row.locator("input").first();
  await expect(nameInput).toBeVisible({ timeout: 5000 });
  await nameInput.fill(areaName);
  await page.waitForTimeout(150);
}

async function createRoomType(page: Page, roomName: string): Promise<void> {
  await gotoParentTab(page, /Room Type/);
  const roomInput = page.locator('input[placeholder="New room type name"]').first();
  await expect(roomInput).toBeVisible({ timeout: 5000 });
  await roomInput.fill(roomName);
  await page.locator("button").filter({ hasText: /^Create Room Type$/ }).first().click();
  await expect(page.locator('[role="tab"]').filter({ hasText: /^Circuit$/ }).first()).toBeVisible({
    timeout: 8000,
  });
}

/** Circuit sub-tab: add one circuit with designer number, dimming type, area. */
async function addCircuit(
  page: Page,
  designer: string,
  areaName: string,
  dimmingType: string,
): Promise<void> {
  await gotoSubTab(page, /^Circuit$/);
  const addBtn = page.locator(".btn-add-row").first();
  await expect(addBtn).toBeVisible({ timeout: 5000 });
  await addBtn.click();
  await page.waitForTimeout(200);

  const row = page.locator("tbody tr").last();
  const designerInput = row.locator(".device-cell textarea, .device-cell input").first();
  await expect(designerInput).toBeVisible({ timeout: 5000 });
  await designerInput.fill(designer);
  await page.waitForTimeout(100);

  const selects = row.locator("select");
  const selectCount = await selects.count();
  if (selectCount >= 1 && dimmingType) {
    try {
      await selects.nth(0).selectOption({ label: dimmingType });
    } catch {
      // keep default when the label is unavailable
    }
    await page.waitForTimeout(100);
  }
  const areaSelect = selects.filter({ has: page.locator("option", { hasText: areaName }) }).first();
  if (await areaSelect.count()) {
    await areaSelect.selectOption({ label: areaName });
  } else if (selectCount >= 2) {
    await selects.nth(1).selectOption({ label: areaName });
  }
  await page.waitForTimeout(150);
}

test.describe("T-57 Uneffected active display on dimming rows", () => {
  test.beforeEach(async ({ page }) => {
    await installLocalEditingMocks(page);
  });
  test.setTimeout(300000);

  test("dimming-row Uneffected shows/clears is-active in every setting panel copy", async ({ page }) => {
    await isolate(page);

    // ---- Shared seed: project + area + room type + PWM circuit + On/Off circuit
    const nameInput = page.locator('input[placeholder="New project name"]').first();
    await expect(nameInput).toBeVisible({ timeout: 15000 });
    await nameInput.fill(`T57-${Date.now()}`);
    await page.locator("button").filter({ hasText: /^Create Project$/ }).first().click();
    await expect(page.getByText("Back to Project List")).toBeVisible({ timeout: 10000 });
    await addArea(page, "T57Area");
    await createRoomType(page, "T57Room");
    await addCircuit(page, "C-1", "T57Area", "Phase");
    await addCircuit(page, "C-2", "T57Area", "On/Off");

    // ================= 1) Area Scene tab (SceneView) =================
    await gotoSubTab(page, /^Area Scene$/);
    const areaChip = page.locator(".scene-area-chip").filter({ hasText: "T57Area" }).first();
    await expect(areaChip).toBeVisible({ timeout: 8000 });
    await areaChip.click();
    await page.waitForTimeout(200);
    const addSceneBtn = page.getByRole("button", { name: "Add Scene", exact: true }).first();
    await expect(addSceneBtn).toBeEnabled({ timeout: 5000 });
    await addSceneBtn.click();
    await page.waitForTimeout(300);

    const asDimControl = page.locator(".scene-table tbody .scene-level-control").first();
    await expect(asDimControl).toBeVisible({ timeout: 8000 });
    const asDimUneffected = asDimControl.locator(".btn-clear-circuit");
    const asDimInput = asDimControl.locator(".scene-level-input");
    const asDimRaise = asDimControl.locator(".scene-quick-buttons button").filter({ hasText: /^Raise$/ });
    const asOnOffUneffected = page
      .locator(".scene-table tbody .scene-onoff-buttons button")
      .filter({ hasText: /^Uneffected$/ })
      .first();

    // Initial (unset) state: both rows highlight Uneffected.
    await expect(asDimUneffected).toHaveClass(/is-active/);
    await expect(asOnOffUneffected).toHaveClass(/is-active/);

    // Entering a percent clears the highlight.
    await asDimInput.fill("55");
    await page.waitForTimeout(200);
    await expect(asDimUneffected).not.toHaveClass(/is-active/);

    // Raise: quick button takes the highlight, Uneffected stays off.
    await asDimRaise.click();
    await page.waitForTimeout(200);
    await expect(asDimRaise).toHaveClass(/is-active/);
    await expect(asDimUneffected).not.toHaveClass(/is-active/);

    // Back to Uneffected: highlight returns, Raise clears, value empties.
    await asDimUneffected.click();
    await page.waitForTimeout(200);
    await expect(asDimUneffected).toHaveClass(/is-active/);
    await expect(asDimRaise).not.toHaveClass(/is-active/);
    await expect(asDimInput).toHaveValue("");

    // ================= 2) Switch tab Function Setting (SwitchView) =================
    await gotoSubTab(page, /^Switch$/);
    await page.locator('.scene-area-chip:has-text("Palladiom")').first().click();
    await page.waitForTimeout(200);
    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(400);
    await page.locator("tbody .setting-status-button").nth(0).click();
    const overlay = page.locator(".setting-overlay-panel");
    await expect(overlay).toBeVisible({ timeout: 5000 });
    await overlay.locator(".switch-area-toggle").first().click();
    await page.waitForTimeout(300);

    const swDimControl = overlay.locator(".switch-individual-table .switch-override-control").first();
    await expect(swDimControl).toBeVisible({ timeout: 5000 });
    const swDimUneffected = swDimControl.locator(".btn-clear-circuit");
    const swDimInput = swDimControl.locator(".scene-level-input");
    const swDimRaise = swDimControl.locator(".scene-quick-buttons button").filter({ hasText: /^Raise$/ });
    const swOnOffUneffected = overlay
      .locator(".switch-individual-table .switch-onoff-buttons button")
      .filter({ hasText: /^Uneffected$/ })
      .first();

    await expect(swDimUneffected).toHaveClass(/is-active/);
    await expect(swOnOffUneffected).toHaveClass(/is-active/);

    await swDimInput.fill("60");
    await page.waitForTimeout(200);
    await expect(swDimUneffected).not.toHaveClass(/is-active/);

    await swDimRaise.click();
    await page.waitForTimeout(200);
    await expect(swDimRaise).toHaveClass(/is-active/);
    await expect(swDimUneffected).not.toHaveClass(/is-active/);

    await swDimUneffected.click();
    await page.waitForTimeout(200);
    await expect(swDimUneffected).toHaveClass(/is-active/);
    await expect(swDimRaise).not.toHaveClass(/is-active/);
    await expect(swDimInput).toHaveValue("");

    // Display-only guarantee: after Raise -> Uneffected the persisted circuit
    // setting for the dimming circuit is back to "" (same payload semantics
    // as before the fix).
    await page.waitForTimeout(1800);
    const persisted = await page.evaluate(() => {
      try {
        const drafts = JSON.parse(localStorage.getItem("cfs-project-drafts-v2") || "[]");
        const sw = (drafts?.[0]?.roomTypes?.[0]?.switches ?? []).find(
          (item: { kind?: string }) => item.kind === "lutronPd",
        );
        return (sw?.buttonSetting?.circuitSettings ?? []) as Array<{ circuitId: string; percentage: string }>;
      } catch {
        return null;
      }
    });
    expect(persisted).not.toBeNull();
    expect((persisted ?? []).filter((item) => item.percentage !== "").length).toBe(0);

    await overlay.locator(".setting-overlay-actions button").filter({ hasText: /^Close$/ }).click();
    await expect(overlay).toBeHidden({ timeout: 5000 });

    // ================= 3) Command tab Setting panel (CommandView) =================
    await gotoSubTab(page, /^Command$/);
    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(400);
    await page
      .locator("tbody button.btn.btn-primary.btn-sm:not(.setting-status-button)")
      .filter({ hasText: /^Setting$/ })
      .first()
      .click();
    await expect(overlay).toBeVisible({ timeout: 5000 });
    await overlay.locator(".switch-area-toggle").first().click();
    await page.waitForTimeout(300);

    const cmdDimControl = overlay.locator(".switch-individual-table .switch-override-control").first();
    await expect(cmdDimControl).toBeVisible({ timeout: 5000 });
    const cmdDimUneffected = cmdDimControl.locator(".btn-clear-circuit");
    const cmdDimInput = cmdDimControl.locator(".scene-level-input");
    const cmdDimRaise = cmdDimControl.locator(".scene-quick-buttons button").filter({ hasText: /^Raise$/ });
    const cmdOnOffUneffected = overlay
      .locator(".switch-individual-table .switch-onoff-buttons button")
      .filter({ hasText: /^Uneffected$/ })
      .first();

    await expect(cmdDimUneffected).toHaveClass(/is-active/);
    await expect(cmdOnOffUneffected).toHaveClass(/is-active/);

    await cmdDimInput.fill("35");
    await page.waitForTimeout(200);
    await expect(cmdDimUneffected).not.toHaveClass(/is-active/);

    await cmdDimUneffected.click();
    await page.waitForTimeout(200);
    await expect(cmdDimUneffected).toHaveClass(/is-active/);
    await expect(cmdDimRaise).not.toHaveClass(/is-active/);
    await expect(cmdDimInput).toHaveValue("");

    await overlay.locator(".setting-overlay-actions button").filter({ hasText: /^Close$/ }).click();
    await expect(overlay).toBeHidden({ timeout: 5000 });

    // ================= 4) Scene tab (RoomSceneView; already-correct variant) =================
    await gotoSubTab(page, /^Scene$/);
    await page.locator("tbody .setting-status-button").nth(0).click();
    await expect(overlay).toBeVisible({ timeout: 5000 });
    await overlay.locator(".switch-area-toggle").first().click();
    await page.waitForTimeout(300);

    const rsDimControl = overlay.locator(".switch-individual-table .switch-override-control").first();
    await expect(rsDimControl).toBeVisible({ timeout: 5000 });
    const rsDimUneffected = rsDimControl
      .locator(".scene-quick-buttons button")
      .filter({ hasText: /^Uneffected$/ });
    const rsDimInput = rsDimControl.locator(".scene-level-input");

    await expect(rsDimUneffected).toHaveClass(/is-active/);
    await rsDimInput.fill("40");
    await page.waitForTimeout(200);
    await expect(rsDimUneffected).not.toHaveClass(/is-active/);
    await rsDimUneffected.click();
    await page.waitForTimeout(200);
    await expect(rsDimUneffected).toHaveClass(/is-active/);
    await expect(rsDimInput).toHaveValue("");

    await overlay.locator(".setting-overlay-actions button").filter({ hasText: /^Close$/ }).click();
    await expect(overlay).toBeHidden({ timeout: 5000 });
  });
});
