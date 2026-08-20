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

test("compact Edit registration accepts a display name and enters edit mode", async ({ page }) => {
  let registeredUser: { id: string; displayName: string; email: string } | null = null;
  let editMode = false;
  let lockAcquireCount = 0;
  const project = createNewProject("Edit Registration Project");

  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  await page.route("**/api/sharing/config", async (route) => {
    await fulfillJson(route, { mode: "local" });
  });

  await page.route("**/api/collaboration/status**", async (route) => {
    const url = new URL(route.request().url());
    const userId = url.searchParams.get("userId") || registeredUser?.id || "";
    const sessionId = url.searchParams.get("sessionId") || "session:test";
    await fulfillJson(route, {
      enabled: true,
      mode: editMode ? "edit" : "view",
      ownsLock: editMode,
      lock: editMode && registeredUser
        ? {
            scopeId: "cfs-projects",
            userId,
            userName: registeredUser.displayName,
            sessionId,
            acquiredAt: "2026-08-04T00:00:00.000Z",
            heartbeatAt: "2026-08-04T00:00:00.000Z",
            expiresAt: "2026-08-04T00:01:30.000Z",
          }
        : null,
      lastUpdatedBy: null,
      leaseSeconds: 90,
      heartbeatMs: 20_000,
      idleMs: 15 * 60 * 1000,
    });
  });

  await page.route("**/api/collaboration/users/register", async (route) => {
    const payload = route.request().postDataJSON() as { userId?: string; displayName?: string; email?: string };
    registeredUser = {
      id: payload.userId || "user:test",
      displayName: payload.displayName || "",
      email: payload.email || "",
    };
    await fulfillJson(route, {
      ok: true,
      user: {
        ...registeredUser,
        createdAt: "2026-08-04T00:00:00.000Z",
        lastSeenAt: "2026-08-04T00:00:00.000Z",
      },
    });
  });

  await page.route("**/api/collaboration/lock/acquire", async (route) => {
    lockAcquireCount += 1;
    const payload = route.request().postDataJSON() as { userId?: string; sessionId?: string };
    editMode = true;
    await fulfillJson(route, {
      acquired: true,
      lock: {
        scopeId: "cfs-projects",
        userId: payload.userId,
        userName: registeredUser?.displayName || "Editor",
        sessionId: payload.sessionId,
        acquiredAt: "2026-08-04T00:00:00.000Z",
        heartbeatAt: "2026-08-04T00:00:00.000Z",
        expiresAt: "2026-08-04T00:01:30.000Z",
      },
      status: {
        enabled: true,
        mode: "edit",
        ownsLock: true,
        lock: {
          scopeId: "cfs-projects",
          userId: payload.userId,
          userName: registeredUser?.displayName || "Editor",
          sessionId: payload.sessionId,
          acquiredAt: "2026-08-04T00:00:00.000Z",
          heartbeatAt: "2026-08-04T00:00:00.000Z",
          expiresAt: "2026-08-04T00:01:30.000Z",
        },
        lastUpdatedBy: null,
        leaseSeconds: 90,
        heartbeatMs: 20_000,
        idleMs: 15 * 60 * 1000,
      },
    });
  });

  await page.route("**/api/projects", async (route) => {
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

  await page.goto("/");

  await page.locator("button.screen-card").filter({ hasText: "Edit Registration Project" }).first().click();
  const compactEditBar = page.getByRole("region", { name: "Shared editing status" });
  await expect(compactEditBar).toBeVisible();

  await compactEditBar.getByRole("button", { name: "Start editing", exact: true }).click();
  const displayName = page.getByLabel("Display name");
  await expect(displayName).toBeVisible();
  await expect(displayName).toBeEditable();

  await displayName.fill("Okada Test");
  await expect(displayName).toHaveValue("Okada Test");
  await page.getByRole("button", { name: "Register", exact: true }).click();

  await expect(compactEditBar.getByRole("button", { name: "Finish editing", exact: true })).toBeVisible();
  await expect(compactEditBar).toContainText("Editing");
  expect(lockAcquireCount).toBe(1);
});
