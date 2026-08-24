import { test, expect, type Page } from "@playwright/test";

// Closing the window while editing with draft changes (2026-08-24): the
// beforeunload handler blocks the close with the browser prompt, and when the
// user stays, the finish dialog (save new revision / save current / discard)
// opens. Uses the real local-mode collaboration endpoints (no mocks).

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

test.describe("Edit-mode window close", () => {
  test.setTimeout(180000);

  test("beforeunload keeps the page and opens the finish dialog when drafts exist", async ({ page }) => {
    await page.goto("about:blank");
    await page.waitForTimeout(1800);
    await apiPutProjects(page, []);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => !document.body.textContent?.includes("Loading projects"),
      { timeout: 20000 },
    );

    // Register a local user and start editing (real collaboration endpoints).
    const startEditing = page.getByRole("button", { name: "Start editing" }).first();
    await expect(startEditing).toBeVisible({ timeout: 15000 });
    await startEditing.click();
    const nameInput = page.locator('input[placeholder="e.g. Okada"]');
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill("CloseTest");
      await page.locator('input[type="email"]').fill("close-test@example.com");
      await page.locator("button").filter({ hasText: /^Register$/ }).first().click();
      await page.waitForTimeout(400);
    }

    const projInput = page.locator('input[placeholder="New project name"]').first();
    await expect(projInput).toBeVisible({ timeout: 15000 });
    await projInput.fill(`CLOSE-${Date.now()}`);
    await page.locator("button").filter({ hasText: /^Create Project$/ }).first().click();
    await page.waitForTimeout(500);

    // Enter edit mode inside the project screen if still in view mode.
    const startInProject = page.getByRole("button", { name: "Start editing" }).first();
    if (await startInProject.isVisible().catch(() => false)) {
      await startInProject.click();
      await page.waitForTimeout(400);
    }

    const roomInput = page.locator('input[placeholder="New room type name"]').first();
    await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
    await expect(roomInput).toBeVisible({ timeout: 5000 });
    await roomInput.fill(`CLOSE-Room-${Date.now()}`);
    await page.locator("button").filter({ hasText: /^Create Room Type$/ }).first().click();
    await page.waitForTimeout(500);

    // Create a revision draft: add a circuit row.
    await page.locator('[role="tab"]').filter({ hasText: /^Circuit$/ }).first().click();
    await page.waitForTimeout(400);
    await page.locator("button").filter({ hasText: /Add Row/ }).first().click();
    await page.waitForTimeout(800);

    // Simulate the user closing the window: fire beforeunload; the page
    // survives (as after cancelling the browser prompt) and the finish dialog
    // must open with the three actions.
    const prevented = await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(true);

    const dialog = page.locator(".edit-finish-dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator("button").filter({ hasText: /Continue Editing/ })).toBeVisible();
    await expect(page.getByText("Finish editing with draft changes?")).toBeVisible();

    // Continue editing closes the dialog and keeps edit mode.
    await dialog.locator("button").filter({ hasText: /Continue Editing/ }).click();
    await expect(dialog).toHaveCount(0);

    // Back to Project List with drafts also opens the finish dialog instead
    // of leaving directly.
    await page.locator("button").filter({ hasText: /^Back to Project List$/ }).first().click();
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Finish editing with draft changes?")).toBeVisible();
    await dialog.locator("button").filter({ hasText: /Continue Editing/ }).click();
    await expect(dialog).toHaveCount(0);
    // Still on the project screen (did not navigate away).
    await expect(page.locator("button").filter({ hasText: /^Back to Project List$/ })).toBeVisible();
  });
});
