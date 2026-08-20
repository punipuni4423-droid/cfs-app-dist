import { expect, test, type Route } from "@playwright/test";
import { createNewProject } from "../../app/lib/storage";

function json(body: unknown): string {
  return JSON.stringify(body);
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: json(body),
  });
}

test("project cache quota failures do not block database-backed editing", async ({ page }) => {
  const project = createNewProject("Storage Quota Project");
  const alerts: string[] = [];

  await page.addInitScript(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem(
      "cfs-collaboration-user-v1",
      JSON.stringify({
        id: "user:quota-test",
        displayName: "Quota Tester",
        email: "quota@example.com",
        role: "admin",
        createdAt: "2026-08-07T00:00:00.000Z",
        lastSeenAt: "2026-08-07T00:00:00.000Z",
      }),
    );
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function patchedSetItem(key: string, value: string): void {
      if (key === "cfs-projects-v14" || key === "cfs-project-drafts-v1") {
        throw new DOMException("Quota exceeded for test", "QuotaExceededError");
      }
      originalSetItem.call(this, key, value);
    };
  });

  page.on("dialog", async (dialog) => {
    alerts.push(dialog.message());
    await dialog.dismiss();
  });

  await page.route("**/api/sharing/config", async (route) => {
    await fulfillJson(route, { mode: "local" });
  });
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "POST") {
      await fulfillJson(route, { ok: true, projects: [project], lastUpdatedBy: null });
      return;
    }
    await fulfillJson(route, { projects: [project] });
  });
  await page.route("**/api/trash", async (route) => {
    await fulfillJson(route, { projects: [], roomTypes: [] });
  });
  await page.route("**/api/tablet-url", async (route) => {
    await fulfillJson(route, { url: "" });
  });
  await page.route("**/api/app-update/status**", async (route) => {
    await fulfillJson(route, {
      enabled: true,
      state: "current",
      message: "Latest version installed. Safe to use.",
      ahead: 0,
      behind: 0,
      dirty: false,
      checkedAt: new Date().toISOString(),
      appDir: "mock",
    });
  });
  await page.route("**/api/collaboration/status**", async (route) => {
    await fulfillJson(route, {
      enabled: true,
      mode: "edit",
      ownsLock: true,
      lock: {
        scopeId: "cfs-projects",
        userId: "user:quota-test",
        userName: "Quota Tester",
        sessionId: "session:quota-test",
        acquiredAt: "2026-08-07T00:00:00.000Z",
        heartbeatAt: "2026-08-07T00:00:00.000Z",
        expiresAt: "2026-08-07T00:01:30.000Z",
      },
      membership: {
        id: "user:quota-test",
        email: "quota@example.com",
        displayName: "Quota Tester",
        role: "admin",
        active: true,
        createdAt: "2026-08-07T00:00:00.000Z",
        lastSeenAt: "2026-08-07T00:00:00.000Z",
      },
      lastUpdatedBy: null,
      leaseSeconds: 90,
      heartbeatMs: 20_000,
      idleMs: 15 * 60 * 1000,
    });
  });

  await page.goto("/");
  await expect(page.locator("button.screen-card").filter({ hasText: "Storage Quota Project" })).toBeVisible();
  await page.locator("button.screen-card").filter({ hasText: "Storage Quota Project" }).first().click();
  await expect(page.getByRole("tab", { name: "Room Type" })).toBeVisible();

  await page.getByPlaceholder("New room type name").fill("Quota Type");
  await page.getByRole("button", { name: "Create Room Type" }).click();
  await expect(page.getByText("Quota Type").first()).toBeVisible();
  await page.waitForTimeout(1500);

  expect(alerts.filter((message) => message.includes("Failed to save locally"))).toEqual([]);
  await expect
    .poll(async () =>
      page.evaluate(() => ({
        projectCache: window.localStorage.getItem("cfs-projects-v14"),
        draftCache: window.localStorage.getItem("cfs-project-drafts-v1"),
      })),
    )
    .toEqual({ projectCache: null, draftCache: null });
});

test("empty project response is authoritative over stale local project cache", async ({ page }) => {
  const staleProject = createNewProject("Stale Local Project");

  await page.addInitScript((project) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("cfs-projects-v14", JSON.stringify([project]));
    window.localStorage.setItem("cfs-project-drafts-v1", JSON.stringify([project]));
  }, staleProject);

  await page.route("**/api/sharing/config", async (route) => {
    await fulfillJson(route, { mode: "local" });
  });
  await page.route("**/api/projects", async (route) => {
    await fulfillJson(route, { projects: [] });
  });
  await page.route("**/api/trash", async (route) => {
    await fulfillJson(route, { projects: [], roomTypes: [] });
  });
  await page.route("**/api/tablet-url", async (route) => {
    await fulfillJson(route, { url: "" });
  });
  await page.route("**/api/app-update/status**", async (route) => {
    await fulfillJson(route, {
      enabled: true,
      state: "current",
      message: "Latest version installed. Safe to use.",
      ahead: 0,
      behind: 0,
      dirty: false,
      checkedAt: new Date().toISOString(),
      appDir: "mock",
    });
  });
  await page.route("**/api/collaboration/status**", async (route) => {
    await fulfillJson(route, {
      enabled: true,
      mode: "view",
      ownsLock: false,
      lock: null,
      membership: null,
      lastUpdatedBy: null,
      leaseSeconds: 90,
      heartbeatMs: 20_000,
      idleMs: 15 * 60 * 1000,
    });
  });

  await page.goto("/");

  await expect(page.getByText("CFS Project Selection")).toBeVisible();
  await expect(page.locator("button.screen-card").filter({ hasText: "Stale Local Project" })).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(() => ({
        projectCache: window.localStorage.getItem("cfs-projects-v14"),
        draftCache: window.localStorage.getItem("cfs-project-drafts-v1"),
      })),
    )
    .toEqual({ projectCache: null, draftCache: null });
});
