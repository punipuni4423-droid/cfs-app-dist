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
  // Context routes cover popup initial requests as well as the main page.
  const router = page.context();
  await router.route('**/auth/connect', route => route.fulfill({ json: { role: 'admin', userId: 'mock-user', sessionId: 'synthetic-session' } }));
  await router.route('**/api/tablet-url', (route) => route.fulfill({ json: { url: `${new URL(route.request().url()).origin}/` } }));
  await router.route('**/api/collaboration/auth', (route) => route.fulfill({ json: { enabled: false, mode: 'local' } }));
  await router.route('**/api/collaboration/lock/release', (route) => route.fulfill({ json: { ok: true } }));
  await router.route('**/api/collaboration/users/register', (route) => {
    const payload = requestJson(route);
    return route.fulfill({ json: { ok: true, user: { id: payload.userId ?? 'mock-user', displayName: payload.displayName ?? 'Mock user', email: payload.email ?? '', role: 'admin', createdAt: null, lastSeenAt: null } } });
  });
  const state: MockServerState = {
    projects: [],
    trash: { projects: [], roomTypes: [] },
  };
  let trashUpdatedAt = 'mock-trash-initial';

  await router.route("**/api/sharing/config**", async (route) => {
    await fulfillJson(route, { mode: "local" });
  });

  await router.route("**/api/collaboration/status**", async (route) => {
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

  await router.route("**/api/projects**", async (route) => {
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
      const updates = Array.isArray(payload.projects) ? payload.projects as ProjectPayload[] : [];
      const ids = new Set(updates.map(project => project.id));
      state.projects = [...updates, ...state.projects.filter(project => !ids.has(project.id))];
      await fulfillJson(route, { ok: true, projects: updates });
      return;
    }
    await fulfillJson(route, { projects: state.projects });
  });

  await router.route("**/api/trash**", async (route) => {
    if (route.request().method() === "POST") {
      const payload = requestJson(route);
      if (payload.restoreCleanup) {
        const original = (payload.restoreCleanup as { original: ProjectPayload }).original;
        const matches = state.trash.projects.filter(item => item.id === original.id);
        const next = { ...state.trash, projects: state.trash.projects.filter(item => item.id !== original.id) };
        if (payload.saveProtocol !== 2 || payload.expectedUpdatedAt !== trashUpdatedAt || matches.length !== 1
          || json(matches[0]) !== json(original) || json(payload.trash) !== json(next)) {
          await fulfillJson(route, { code: 'TRASH_CONFLICT' }, 409); return;
        }
      }
      const rawTrash = payload.trash && typeof payload.trash === "object"
        ? payload.trash as Record<string, unknown>
        : payload;
      state.trash = {
        projects: Array.isArray(rawTrash.projects) ? rawTrash.projects as ProjectPayload[] : [],
        roomTypes: Array.isArray(rawTrash.roomTypes) ? rawTrash.roomTypes as ProjectPayload[] : [],
      };
      trashUpdatedAt += '-next';
      await fulfillJson(route, { ok: true, trash: state.trash, updatedAt: trashUpdatedAt });
      return;
    }
    await fulfillJson(route, { trash: state.trash, updatedAt: trashUpdatedAt });
  });

  await router.route("**/api/app-update/status**", async (route) => {
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

  await router.route('**/api/projects/delete', async route => {
    const payload = requestJson(route);
    const project = state.projects.find(candidate => candidate.id === payload.projectId);
    if (!project || project.updatedAt !== payload.expectedUpdatedAt) {
      await fulfillJson(route, { error: 'Project changed.', code: 'PROJECT_CONFLICT' }, 409);
      return;
    }
    const updatedAt = new Date().toISOString();
    trashUpdatedAt = updatedAt;
    state.trash.projects.unshift({ id: `trash-${project.id}`, deletedAt: updatedAt, project: structuredClone(project) });
    state.projects = state.projects.filter(candidate => candidate.id !== project.id);
    await fulfillJson(route, { ok: true, projects: state.projects, trash: state.trash, updatedAt });
  });

  await router.route('**/api/projects/rename', async route => {
    const payload = requestJson(route);
    const project = state.projects.find(candidate => candidate.id === payload.projectId);
    if (!project || project.updatedAt !== payload.expectedUpdatedAt) return fulfillJson(route, { error: 'Project changed.', code: 'PROJECT_CONFLICT' }, 409);
    Object.assign(project, { name: payload.name, updatedAt: new Date(Math.max(Date.now(), Date.parse(String(project.updatedAt)) + 1)).toISOString() });
    await fulfillJson(route, { ok: true, project });
  });

  return state;
}
