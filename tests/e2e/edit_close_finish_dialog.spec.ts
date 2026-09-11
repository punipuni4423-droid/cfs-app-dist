import { test, expect, type Page } from "./support/safe-test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

// Closing the window while editing with draft changes (2026-08-24): the
// beforeunload handler blocks the close with the browser prompt, and when the
// user stays, the finish dialog (save new revision / save current / discard)
// opens. Business data and collaboration are mocked in this browser context.

const closeTestUser = {
  id: "close-test-editor", displayName: "Close Test", email: "close-test@example.test",
  role: "admin", createdAt: null, lastSeenAt: null,
};

async function installCloseEditingMocks(page: Page): Promise<void> {
  await installLocalEditingMocks(page);
  const ownedScopes = new Set<string>();
  const status = (projectId = "", sessionId = "close-test-session") => {
    const editing = ownedScopes.has(projectId);
    const now = new Date().toISOString();
    const lock = editing ? {
      scopeId: projectId || "global", projectId, sessionId,
      userId: closeTestUser.id, userName: closeTestUser.displayName,
      acquiredAt: now, heartbeatAt: now, expiresAt: new Date(Date.now() + 90_000).toISOString(),
    } : null;
    return {
      enabled: true, mode: editing ? "edit" : "view", ownsLock: editing,
      scopeId: projectId || "global", projectId, lock, locks: lock ? [lock] : [],
      membership: { ...closeTestUser, active: true, updatedAt: null },
      lastUpdatedBy: null, leaseSeconds: 90, heartbeatMs: 20_000, idleMs: 900_000,
    };
  };
  await page.context().route("**/api/collaboration/status**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: status(params.get("projectId") ?? "", params.get("sessionId") ?? "") });
  });
  await page.context().route("**/api/collaboration/lock/acquire", (route) => {
    const payload = route.request().postDataJSON() as { projectId?: string; sessionId?: string };
    ownedScopes.add(payload.projectId ?? "");
    const next = status(payload.projectId, payload.sessionId);
    return route.fulfill({ json: { acquired: true, lock: next.lock, status: next } });
  });
  await page.context().route("**/api/collaboration/lock/heartbeat", (route) => {
    const payload = route.request().postDataJSON() as { projectId?: string; sessionId?: string };
    const next = status(payload.projectId, payload.sessionId);
    return route.fulfill({ json: { acquired: next.ownsLock, lock: next.lock, status: next } });
  });
  await page.context().route("**/api/collaboration/lock/release", (route) => {
    const payload = route.request().postDataJSON() as { projectId?: string; sessionId?: string };
    ownedScopes.delete(payload.projectId ?? "");
    return route.fulfill({ json: { ok: true, released: true, status: status(payload.projectId, payload.sessionId) } });
  });
}

test.describe("Edit-mode window close", () => {
  test.setTimeout(180000);

  test("beforeunload keeps the page and opens the finish dialog when drafts exist", async ({ page }) => {
    await installCloseEditingMocks(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate((user) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("cfs-collaboration-user-v1", JSON.stringify(user));
      sessionStorage.setItem("cfs-collaboration-session-v1", "close-test-session");
    }, closeTestUser);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => !document.body.textContent?.includes("Loading projects"),
      { timeout: 20000 },
    );

    // Start a mocked local editing session with the browser-only seed user.
    const startEditing = page.getByRole("button", { name: "Start editing" }).first();
    await expect(startEditing).toBeVisible({ timeout: 15000 });
    await startEditing.click();
    await expect(page.getByRole("button", { name: "Finish editing", exact: true })).toBeVisible();

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
