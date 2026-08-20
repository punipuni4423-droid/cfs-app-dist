import type { Page, Route } from "@playwright/test";

type ProjectPayload = Record<string, unknown>;

interface MockServerState {
  projects: ProjectPayload[];
  trash: {
    projects: ProjectPayload[];
    roomTypes: ProjectPayload[];
  };
}

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

function requestJson(route: Route): Record<string, unknown> {
  try {
    const parsed = route.request().postDataJSON();
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function installLocalEditingMocks(page: Page): Promise<MockServerState> {
  const state: MockServerState = {
    projects: [],
    trash: { projects: [], roomTypes: [] },
  };

  await page.route("**/api/sharing/config**", async (route) => {
    await fulfillJson(route, { mode: "local" });
  });

  await page.route("**/api/collaboration/status**", async (route) => {
    await fulfillJson(route, {
      enabled: false,
      mode: "local",
      lock: null,
      lastUpdatedBy: null,
      leaseSeconds: 90,
      heartbeatMs: 20_000,
      idleMs: 15 * 60 * 1000,
    });
  });

  await page.route("**/api/projects**", async (route) => {
    if (route.request().method() === "POST") {
      const payload = requestJson(route);
      if (payload.project && typeof payload.project === "object") {
        const project = payload.project as ProjectPayload;
        const projectId = String(project.id ?? "");
        const existingIndex = state.projects.findIndex((candidate) => String(candidate.id ?? "") === projectId);
        if (existingIndex >= 0) {
          state.projects = state.projects.map((candidate, index) => (index === existingIndex ? project : candidate));
        } else {
          state.projects = [project, ...state.projects];
        }
        await fulfillJson(route, { ok: true, project, projects: state.projects });
        return;
      }
      state.projects = Array.isArray(payload.projects) ? payload.projects as ProjectPayload[] : [];
      await fulfillJson(route, { ok: true, projects: state.projects });
      return;
    }
    await fulfillJson(route, { projects: state.projects });
  });

  await page.route("**/api/trash**", async (route) => {
    if (route.request().method() === "POST") {
      const payload = requestJson(route);
      const rawTrash = payload.trash && typeof payload.trash === "object"
        ? payload.trash as Record<string, unknown>
        : payload;
      state.trash = {
        projects: Array.isArray(rawTrash.projects) ? rawTrash.projects as ProjectPayload[] : [],
        roomTypes: Array.isArray(rawTrash.roomTypes) ? rawTrash.roomTypes as ProjectPayload[] : [],
      };
      await fulfillJson(route, { ok: true, trash: state.trash });
      return;
    }
    await fulfillJson(route, state.trash);
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

  return state;
}
