import { test, expect, type Page } from "./support/safe-test";
import type { ProjectData } from "../../app/types";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

const currentSave = (page: Page) => page.getByRole("button", { name: "Save current project without a new revision" });
const title = (page: Page) => page.getByLabel("Title for remark 1", { exact: true });
const body = (page: Page) => page.getByLabel("Body for remark 1", { exact: true });

async function setup(page: Page, collaborationEnabled = false) {
  const state = await installLocalEditingMocks(page);
  if (collaborationEnabled) {
    // Locks are scoped: releasing the list lock when opening a project must
    // not release that project's independent editing session.
    const releasedScopes = new Set<string>();
    const status = (projectId = "", sessionId = "t114-session") => {
      const editing = !releasedScopes.has(projectId);
      const now = new Date().toISOString();
      const lock = editing ? {
        scopeId: projectId || "global", projectId, sessionId,
        userId: "t114-editor", userName: "T114 Editor",
        acquiredAt: now, heartbeatAt: now, expiresAt: new Date(Date.now() + 90_000).toISOString(),
      } : null;
      return {
        enabled: true, mode: editing ? "edit" : "view", ownsLock: editing,
        projectId, scopeId: projectId || "global",
        membership: { id: "t114-editor", displayName: "T114 Editor", email: "t114@example.test", role: "admin", active: true },
        lock, locks: lock ? [lock] : [], lastUpdatedBy: null,
        leaseSeconds: 90, heartbeatMs: 20_000, idleMs: 900_000,
      };
    };
    await page.context().route("**/api/collaboration/status**", (route) => {
      const params = new URL(route.request().url()).searchParams;
      return route.fulfill({ json: status(params.get("projectId") ?? "", params.get("sessionId") ?? "") });
    });
    await page.context().route("**/api/collaboration/lock/heartbeat", (route) => {
      const payload = route.request().postDataJSON() as { projectId?: string; sessionId?: string };
      const next = status(payload.projectId, payload.sessionId);
      return route.fulfill({ json: { acquired: next.mode === "edit", lock: next.lock, status: next } });
    });
    await page.context().route("**/api/collaboration/lock/release", (route) => {
      const payload = route.request().postDataJSON() as { projectId?: string; sessionId?: string };
      releasedScopes.add(payload.projectId ?? "");
      return route.fulfill({ json: { ok: true, released: true, status: status(payload.projectId, payload.sessionId) } });
    });
  }
  await page.goto("/");
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload({ waitUntil: "load" });
  await page.getByPlaceholder("New project name").fill("T114 In-flight save");
  await page.getByRole("button", { name: "Create Project", exact: true }).click();
  await page.getByRole("tab", { name: "Remarks", exact: true }).click();
  await page.getByRole("button", { name: "Add Remark", exact: true }).click();
  await title(page).fill("Before request");
  await body(page).fill("Original body");
  await currentSave(page).click();
  await expect.poll(() => (state.projects[0] as unknown as ProjectData)?.remarks?.[0]?.body).toBe("Original body");
  await expect(currentSave(page)).toBeEnabled();
  return state;
}

test("Current retains edits made during POST, Undo/Redo and the next save use them", async ({ page }, testInfo) => {
  const state = await setup(page);
  const requests: Array<{ project: ProjectData; expectedUpdatedAt: string }> = [];
  const savedToken = "2030-01-02T03:04:05.000Z";
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.context().route("**/api/projects**", async (route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    const payload = route.request().postDataJSON() as typeof requests[number];
    requests.push(payload);
    if (requests.length === 1) await gate;
    const saved = { ...payload.project, updatedAt: requests.length === 1 ? savedToken : "2030-01-02T03:05:05.000Z" };
    state.projects = [saved as unknown as Record<string, unknown>];
    await route.fulfill({ json: { ok: true, project: saved, projects: state.projects } });
  });
  try {
    await currentSave(page).click();
    await expect.poll(() => requests.length).toBe(1);
    // Undo groups are deliberately separated by the product's 900 ms interval.
    await page.waitForTimeout(1000);
    await title(page).fill("Typed while saving");
    await page.waitForTimeout(1000);
    await body(page).fill("Second field while saving");
    const response = page.waitForResponse((candidate) => candidate.url().includes("/api/projects") && candidate.request().method() === "POST");
    release();
    await (await response).finished();
    await expect(currentSave(page)).toBeEnabled();
    await expect(title(page)).toHaveValue("Typed while saving");
    await expect(body(page)).toHaveValue("Second field while saving");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(title(page)).toHaveValue("Typed while saving");
    await expect(body(page)).toHaveValue("Original body");
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(body(page)).toHaveValue("Second field while saving");
    await currentSave(page).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].expectedUpdatedAt).toBe(savedToken);
    expect(requests[1].project.remarks?.[0]).toMatchObject({ title: "Typed while saving", body: "Second field while saving" });
    await expect(currentSave(page)).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("current-inflight-retained.png"), fullPage: true });
  } finally {
    release();
  }
});

test("New Revision retains keyboard Redo changes during POST and preserves revision metadata through Undo", async ({ page }, testInfo) => {
  const state = await setup(page);
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  await page.getByPlaceholder("New room type name").fill("T114 Room");
  await page.getByRole("button", { name: "Create Room Type", exact: true }).click();
  await page.getByRole("tab", { name: "Remarks", exact: true }).click();
  await page.waitForTimeout(1000);
  await title(page).fill("Redo title during revision save");
  await page.waitForTimeout(1000);
  await body(page).fill("Redo body during revision save");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(title(page)).toHaveValue("Before request");
  await expect(body(page)).toHaveValue("Original body");

  const requests: Array<{ project: ProjectData; expectedUpdatedAt: string }> = [];
  const savedToken = "2030-02-02T03:04:05.000Z";
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.context().route("**/api/projects**", async (route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    const payload = route.request().postDataJSON() as typeof requests[number];
    requests.push(payload);
    if (requests.length === 1) await gate;
    const saved = { ...payload.project, updatedAt: savedToken };
    state.projects = [saved as unknown as Record<string, unknown>];
    await route.fulfill({ json: { ok: true, project: saved, projects: state.projects } });
  });
  try {
    await page.getByRole("button", { name: "Save all room types as new revisions" }).click();
    const dialog = page.getByRole("dialog", { name: "Save Revision", exact: true });
    await dialog.getByRole("button", { name: "Save Revision", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].project.roomTypes[0].revisions).toHaveLength(1);
    // A real keyboard path remains available while the modal blocks pointer
    // access to the editor: clicking its heading leaves focus off text inputs.
    await dialog.getByRole("heading", { name: "Save Revision", exact: true }).click();
    await page.keyboard.press("Control+y");
    await expect(title(page)).toHaveValue("Redo title during revision save");
    await page.keyboard.press("Control+y");
    await expect(body(page)).toHaveValue("Redo body during revision save");
    release();
    await expect(dialog).toBeHidden();
    await expect(title(page)).toHaveValue("Redo title during revision save");
    await expect(body(page)).toHaveValue("Redo body during revision save");
    await expect(page.locator(".revision-save-status-label")).not.toHaveText("Saved");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(body(page)).toHaveValue("Original body");
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(body(page)).toHaveValue("Redo body during revision save");
    await currentSave(page).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].expectedUpdatedAt).toBe(savedToken);
    expect(requests[1].project.roomTypes[0].revisions).toEqual(requests[0].project.roomTypes[0].revisions);
    expect(requests[1].project.roomTypes[0].revision).toBe(requests[0].project.roomTypes[0].revision);
    expect(requests[1].project.remarks?.[0]).toMatchObject({ title: "Redo title during revision save", body: "Redo body during revision save" });
    await expect(currentSave(page)).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("revision-inflight-redo-retained.png"), fullPage: true });
  } finally {
    release();
  }
});

for (const exit of ["Back", "Window close", "Finish"] as const) {
  test(`Remarks-only changes guard ${exit} without any Room Type revision draft`, async ({ page }, testInfo) => {
    await setup(page, exit === "Finish");
    await body(page).fill("Unsaved project-level remark");
    if (exit === "Back") {
      await page.getByRole("button", { name: "Back to Project List", exact: true }).click();
    } else if (exit === "Finish") {
      await page.getByRole("button", { name: "Finish editing", exact: true }).click();
    } else {
      // Cancelable beforeunload models staying after the browser close prompt.
      const prevented = await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(prevented).toBe(true);
    }
    const dialog = page.getByRole("dialog", { name: "Finish editing with draft changes?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Continue Editing", exact: true }).click();
    await expect(body(page)).toHaveValue("Unsaved project-level remark");
    await page.screenshot({ path: testInfo.outputPath("remarks-exit-cancel.png"), fullPage: true });
    await currentSave(page).click();
    await expect(currentSave(page)).toBeEnabled();
    await page.getByRole("button", { name: "Back to Project List", exact: true }).click();
    await expect(page.getByPlaceholder("New project name")).toBeVisible();
  });
}

for (const tab of ["Area", "Fixture"] as const) {
  test(`${tab}-only changes guard leaving the project and Cancel preserves the field`, async ({ page }, testInfo) => {
    await setup(page);
    await page.getByRole("tab", { name: tab, exact: true }).click();
    if (tab === "Fixture") await page.getByRole("button", { name: "Add Row", exact: false }).click();
    const field = page.locator("tbody input.cell-input").first();
    await field.fill(`T114 unsaved ${tab}`);
    await page.getByRole("button", { name: "Back to Project List", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Finish editing with draft changes?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Continue Editing", exact: true }).click();
    await expect(field).toHaveValue(`T114 unsaved ${tab}`);
    await page.screenshot({ path: testInfo.outputPath(`${tab.toLowerCase()}-only-draft.png`), fullPage: true });
    await currentSave(page).click();
    await expect(currentSave(page)).toBeEnabled();
    await page.getByRole("button", { name: "Back to Project List", exact: true }).click();
    await expect(page.getByPlaceholder("New project name")).toBeVisible();
  });
}

test("Save Current & Finish stays in editing when keyboard Redo adds a change during POST", async ({ page }, testInfo) => {
  const state = await setup(page, true);
  // An unsaved room also opens the old revision-only guard, so this case
  // specifically detects the later exit race rather than the missing guard.
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  await page.getByPlaceholder("New room type name").fill("T114 Finish Room");
  await page.getByRole("button", { name: "Create Room Type", exact: true }).click();
  await page.getByRole("tab", { name: "Remarks", exact: true }).click();
  await page.waitForTimeout(1000);
  await title(page).fill("Finish submitted title");
  await page.waitForTimeout(1000);
  await body(page).fill("Redo while finishing");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(body(page)).toHaveValue("Original body");
  let submitted: ProjectData | undefined;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.context().route("**/api/projects**", async (route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    submitted = (route.request().postDataJSON() as { project: ProjectData }).project;
    await gate;
    const saved = { ...submitted, updatedAt: new Date().toISOString() };
    state.projects = [saved as unknown as Record<string, unknown>];
    await route.fulfill({ json: { ok: true, project: saved, projects: state.projects } });
  });
  try {
    await page.getByRole("button", { name: "Finish editing", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Finish editing with draft changes?" });
    await dialog.getByRole("button", { name: "Save Current & Finish", exact: true }).click();
    await expect.poll(() => submitted?.remarks?.[0]?.title).toBe("Finish submitted title");
    await dialog.getByRole("heading").click();
    await page.keyboard.press("Control+y");
    await expect(body(page)).toHaveValue("Redo while finishing");
    const response = page.waitForResponse((candidate) => candidate.url().includes("/api/projects") && candidate.request().method() === "POST");
    release();
    await (await response).finished();
    await expect(dialog.getByRole("button", { name: "Continue Editing", exact: true })).toBeEnabled();
    await expect(dialog).toBeVisible();
    await expect(body(page)).toHaveValue("Redo while finishing");
    await page.screenshot({ path: testInfo.outputPath("finish-stays-with-later-edit.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Continue Editing", exact: true }).click();
    await expect(page.getByRole("button", { name: "Finish editing", exact: true })).toBeEnabled();
  } finally {
    release();
  }
});

for (const outcome of ["success", "failure"] as const) {
  test(`Delayed save ${outcome} preserves the latest local draft across reload`, async ({ page }, testInfo) => {
    const state = await setup(page);
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.getByPlaceholder("New room type name").fill("T114 Draft Room");
    await page.getByRole("button", { name: "Create Room Type", exact: true }).click();
    await page.getByRole("tab", { name: "Remarks", exact: true }).click();
    await currentSave(page).click();
    await expect(page.locator(".revision-save-status-label")).toHaveText("Saved");
    let requestCount = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.context().route("**/api/projects**", async (route) => {
      if (route.request().method() !== "POST") { await route.fallback(); return; }
      requestCount += 1;
      const submitted = (route.request().postDataJSON() as { project: ProjectData }).project;
      await gate;
      if (outcome === "failure") {
        await route.fulfill({ status: 503, json: { error: "T114 simulated save unavailable" } });
        return;
      }
      const saved = { ...submitted, updatedAt: new Date().toISOString() };
      state.projects = [saved as unknown as Record<string, unknown>];
      await route.fulfill({ json: { ok: true, project: saved, projects: state.projects } });
    });
    const readDraft = () => page.evaluate(() => new Promise<ProjectData[]>((resolve, reject) => {
      const request = indexedDB.open('cfs-drafts', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result; const tx = db.transaction('projects'); const read = tx.objectStore('projects').getAll(); read.onsuccess = () => { resolve(read.result.filter(item => item.project).map(item => item.project)); db.close(); }; };
    }));
    try {
      await currentSave(page).click();
      await expect.poll(() => requestCount).toBe(1);
      await title(page).fill(`Latest ${outcome} draft title`);
      await body(page).fill(`Latest ${outcome} draft body`);
      // Ensure the debounce wrote the newer draft BEFORE the response can
      // clear it (success) or overwrite it with the submitted snapshot (failure).
      await expect.poll(async () => (await readDraft())[0]?.remarks?.[0]?.body).toBe(`Latest ${outcome} draft body`);
      const response = page.waitForResponse((candidate) => candidate.url().includes("/api/projects") && candidate.request().method() === "POST");
      release();
      await (await response).finished();
      await expect(page.locator(".revision-save-status-label")).toHaveText(outcome === "failure" ? "Error" : "Draft");
      await expect.poll(async () => (await readDraft())[0]?.remarks?.[0]?.body).toBe(`Latest ${outcome} draft body`);
      await expect(title(page)).toHaveValue(`Latest ${outcome} draft title`);
      page.once("dialog", (dialog) => dialog.accept());
      await page.reload({ waitUntil: "load" });
      await expect(title(page)).toHaveValue('Before request');
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: '退避を編集へ戻す', exact: true }).click();
      await expect(title(page)).toHaveValue(`Latest ${outcome} draft title`);
      await expect(body(page)).toHaveValue(`Latest ${outcome} draft body`);
      expect((state.projects[0] as unknown as ProjectData).remarks?.[0]?.body).toBe("Original body");
      await page.screenshot({ path: testInfo.outputPath(`${outcome}-draft-reload.png`), fullPage: true });
    } finally {
      release();
    }
  });
}
