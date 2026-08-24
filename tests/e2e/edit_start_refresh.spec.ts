import { expect, test, type Page, type Route } from "@playwright/test";
import { createNewProject } from "../../app/lib/storage";
import type { ProjectData } from "../../app/types";

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

function editorLock(projectId: string, mode: "view" | "edit") {
  if (mode === "view") return null;
  return {
    scopeId: `project:${projectId}`,
    projectId,
    userId: "edit-refresh-user",
    userName: "Edit Refresh User",
    sessionId: "edit-refresh-session",
    acquiredAt: "2026-08-25T00:00:00.000Z",
    heartbeatAt: "2026-08-25T00:00:00.000Z",
    expiresAt: "2026-08-25T00:01:30.000Z",
  };
}

function statusPayload(projectId: string, mode: "view" | "edit", lastUpdatedAt: string | null) {
  const lock = editorLock(projectId, mode);
  return {
    enabled: true,
    mode,
    ownsLock: mode === "edit",
    scopeId: projectId ? `project:${projectId}` : "cfs-projects",
    projectId,
    lock,
    locks: lock ? [lock] : [],
    lastUpdatedBy: null,
    lastUpdatedAt,
    leaseSeconds: 90,
    heartbeatMs: 20_000,
    idleMs: 15 * 60 * 1000,
  };
}

async function installEditRefreshRoutes(
  page: Page,
  options: {
    staleProject: ProjectData;
    freshProject: ProjectData;
    failRefresh?: boolean;
  },
) {
  let mode: "view" | "edit" = "view";
  let projectGetCount = 0;
  let releaseCount = 0;
  let savedExpectedUpdatedAt = "";

  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(
      "cfs-collaboration-user-v1",
      JSON.stringify({
        id: "edit-refresh-user",
        displayName: "Edit Refresh User",
        email: "edit-refresh@example.com",
        createdAt: null,
        lastSeenAt: null,
      }),
    );
    sessionStorage.setItem("cfs-collaboration-session-v1", "edit-refresh-session");
  });

  await page.route("**/api/sharing/config**", async (route) => {
    await fulfillJson(route, { mode: "local" });
  });

  await page.route("**/api/collaboration/status**", async (route) => {
    const url = new URL(route.request().url());
    const projectId = url.searchParams.get("projectId") || "";
    await fulfillJson(route, statusPayload(projectId, mode, options.freshProject.updatedAt));
  });

  await page.route("**/api/collaboration/lock/acquire**", async (route) => {
    mode = "edit";
    await fulfillJson(route, {
      acquired: true,
      lock: editorLock(options.staleProject.id, "edit"),
      status: statusPayload(options.staleProject.id, "edit", options.freshProject.updatedAt),
    });
  });

  await page.route("**/api/collaboration/lock/release**", async (route) => {
    mode = "view";
    releaseCount += 1;
    await fulfillJson(route, {
      ok: true,
      released: true,
      status: statusPayload(options.staleProject.id, "view", options.freshProject.updatedAt),
    });
  });

  await page.route("**/api/projects**", async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON() as { expectedUpdatedAt?: string; project?: ProjectData };
      savedExpectedUpdatedAt = payload.expectedUpdatedAt || "";
      const project = payload.project ?? options.freshProject;
      await fulfillJson(route, { ok: true, project, projects: [project] });
      return;
    }

    projectGetCount += 1;
    if (options.failRefresh && projectGetCount > 1) {
      await fulfillJson(route, { error: "refresh failed" }, 503);
      return;
    }
    await fulfillJson(route, { projects: [projectGetCount === 1 ? options.staleProject : options.freshProject] });
  });

  await page.route("**/api/trash**", async (route) => {
    await fulfillJson(route, { projects: [], roomTypes: [] });
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

  return {
    get projectGetCount() {
      return projectGetCount;
    },
    get releaseCount() {
      return releaseCount;
    },
    get savedExpectedUpdatedAt() {
      return savedExpectedUpdatedAt;
    },
  };
}

test("Edit entry refreshes the project after acquiring the lock", async ({ page }) => {
  const projectId = "edit-refresh-project";
  const staleProject = {
    ...createNewProject("Refresh Before Edit Old"),
    id: projectId,
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  const freshProject = {
    ...staleProject,
    name: "Refresh Before Edit Fresh",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
  const routes = await installEditRefreshRoutes(page, { staleProject, freshProject });

  await page.goto("/");
  await page.locator("button.screen-card").filter({ hasText: "Refresh Before Edit Old" }).first().click();
  await expect(page.locator(".breadcrumb-current")).toHaveText("Refresh Before Edit Old");
  await expect(page.getByText("他のユーザーが保存しました。Editで最新に更新されます。")).toBeVisible();

  await page.getByRole("button", { name: "Start editing", exact: true }).click();

  await expect(page.locator(".breadcrumb-current")).toHaveText("Refresh Before Edit Fresh");
  await expect(page.getByRole("button", { name: "Finish editing", exact: true })).toBeVisible();
  expect(routes.projectGetCount).toBeGreaterThanOrEqual(2);

  await page.getByRole("button", { name: "Save current project without a new revision", exact: true }).click();
  await expect.poll(() => routes.savedExpectedUpdatedAt).toBe(freshProject.updatedAt);
});

test("Edit entry releases the lock when the refresh fails", async ({ page }) => {
  const projectId = "edit-refresh-failure-project";
  const staleProject = {
    ...createNewProject("Refresh Failure Old"),
    id: projectId,
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  const freshProject = {
    ...staleProject,
    name: "Refresh Failure Fresh",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
  const routes = await installEditRefreshRoutes(page, { staleProject, freshProject, failRefresh: true });

  await page.goto("/");
  await page.locator("button.screen-card").filter({ hasText: "Refresh Failure Old" }).first().click();
  await page.getByRole("button", { name: "Start editing", exact: true }).click();

  await expect(page.getByRole("button", { name: "Start editing", exact: true })).toBeVisible();
  await expect(page.getByText(/Latest shared data could not be loaded/)).toBeVisible();
  await expect.poll(() => routes.releaseCount).toBe(1);
});
