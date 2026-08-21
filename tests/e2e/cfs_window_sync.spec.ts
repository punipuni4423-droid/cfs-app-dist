import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

// Read-only CFS sub-window (2026-08-21): the CFS tab's "Sub Window" button
// opens /cfs-window, which mirrors the active room type via BroadcastChannel
// and follows room-type switches in the main window.

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

async function createRoomType(page: Page, name: string): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
  await page.waitForTimeout(300);
  const roomInput = page.locator('input[placeholder="New room type name"]').first();
  // Once a room type exists, the tab shows chips and the create input moves
  // behind "+ Manage".
  if (!(await roomInput.isVisible().catch(() => false))) {
    await page.locator("button").filter({ hasText: /Manage/ }).first().click();
    await page.waitForTimeout(300);
  }
  await expect(roomInput).toBeVisible({ timeout: 5000 });
  await roomInput.fill(name);
  await page.locator("button").filter({ hasText: /^Create Room Type$/ }).first().click();
  await page.waitForTimeout(400);
}

async function activateRoomType(page: Page, name: string): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
  await page.waitForTimeout(200);
  await page.locator("button").filter({ hasText: name }).first().click();
  await page.waitForTimeout(300);
}

test.describe("CFS sub-window", () => {
  test.beforeEach(async ({ page }) => {
    await installLocalEditingMocks(page);
  });
  test.setTimeout(180000);

  test("mirrors the CFS view read-only and follows room-type switches", async ({ page }) => {
    await isolate(page);

    const projectName = `CFS-WIN-${Date.now()}`;
    const nameInput = page.locator('input[placeholder="New project name"]').first();
    await expect(nameInput).toBeVisible({ timeout: 15000 });
    await nameInput.fill(projectName);
    await page.locator("button").filter({ hasText: /^Create Project$/ }).first().click();

    const roomA = `WIN-Room-A-${Date.now()}`;
    await createRoomType(page, roomA);

    await page.locator('[role="tab"]').filter({ hasText: /^CFS$/ }).first().click();
    await page.waitForTimeout(400);

    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.locator(".cfs-sub-window-trigger").first().click(),
    ]);
    await popup.waitForLoadState("domcontentloaded");

    // The sub-window receives the snapshot and shows the linked status.
    const statusBar = popup.locator(".cfs-window-status-bar");
    await expect(statusBar).toBeVisible({ timeout: 10000 });
    await expect(statusBar.locator("strong")).toHaveText(projectName, { timeout: 10000 });
    await expect(statusBar.locator(".cfs-window-room")).toHaveText(roomA, { timeout: 10000 });
    await expect(popup.locator(".cfs-window-status")).toHaveText("Linked", { timeout: 10000 });

    // CfsView renders in view-only mode: matrix present, no Sub Window button.
    await expect(popup.locator(".cfs-matrix-card")).toBeVisible({ timeout: 10000 });
    await expect(popup.locator(".cfs-sub-window-trigger")).toHaveCount(0);

    // Creating and switching to a second room type in the main window makes
    // the sub-window follow automatically.
    const roomB = `WIN-Room-B-${Date.now()}`;
    await createRoomType(page, roomB);
    await expect(statusBar.locator(".cfs-window-room")).toHaveText(roomB, { timeout: 10000 });

    await popup.close();
  });
});
