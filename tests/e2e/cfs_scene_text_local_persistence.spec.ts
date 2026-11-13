import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { seed } from "./support/scene-backlight-test-project";
import { SAVE_PROTOCOL_VERSION } from "../../app/lib/projectSaveProtocol";
import type { ProjectData } from "../../app/types";

// Opt-in only: the usual routed/mocked feature suite must never execute real writes.
test.skip(process.env.CFS_SCENE_TEXT_REAL_API !== "1", "Requires the explicitly owned real local API lane.");

test("owned real local API retains Text through UI save reload and Inspection save", async ({ browser, baseURL, storageState }, info) => {
  const ownedRoot = path.resolve("artifacts/scene-text-20261027/server");
  expect(baseURL).toBe("http://127.0.0.1:3090");
  expect(path.resolve(process.env.CFS_APP_DIR ?? "")).toBe(ownedRoot);
  expect(path.resolve(process.env.CFS_AUTH_DIR ?? "")).toBe(path.resolve("artifacts/scene-text-20261027/private-auth"));
  const dataRoot = path.join(ownedRoot, "data");
  const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
  const files = () => existsSync(dataRoot) ? readdirSync(dataRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.relative(dataRoot, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/")).sort() : [];
  const baseline = files();
  // The existing server was used only with backend mocks. Refuse any existing record.
  expect(baseline).toEqual([]);
  mkdirSync(info.outputDir, { recursive: true });
  writeFileSync(info.outputPath("baseline.json"), JSON.stringify({ root: ownedRoot, files: [], projectsAbsent: true, backup: "No data files existed; no original bytes to back up." }, null, 2));
  const project = seed(); project.id = `scene-text-real-${randomUUID()}`; project.name = "Scene Text Real Local QA";
  const firstText = "Occupied: 50%\nVacant: Off";
  const inspectionText = "Inspection confirmed\nDoor open: On / closed: Off";
  const context = await browser.newContext({ baseURL, storageState, serviceWorkers: "block", viewport: { width: 2400, height: 1100 } });
  const unexpected: string[] = [];
  const proof: Record<string, unknown> = { syntheticProjectId: project.id, originalFiles: 0, realApi: true, cloud: false, normal3014: false, trace: false, authStorageWritten: false };
  let created = false;
  try {
    await context.route("**/*", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== baseURL) { unexpected.push("external blocked"); await route.abort(); return; }
      if (url.pathname === "/api/app-update/status") { await route.fulfill({ json: { available: false, supported: false } }); return; }
      const postAllowed = ["/api/projects", "/api/collaboration/users/register", "/api/collaboration/lock/acquire", "/api/collaboration/lock/heartbeat", "/api/collaboration/lock/release"].includes(url.pathname);
      if (request.method() === "GET" || (request.method() === "POST" && postAllowed)) { await route.continue(); return; }
      unexpected.push(`${request.method()} ${url.pathname}`); await route.abort();
    });
    const configResponse = await context.request.get("/api/sharing/config"); expect(configResponse.status()).toBe(200);
    const config = await configResponse.json(); expect(config.mode).toBe("local");
    const initialResponse = await context.request.get("/api/projects"); expect(initialResponse.status()).toBe(200);
    expect((await initialResponse.json()).projects).toEqual([]);
    const identityResponse = await context.request.get("/auth/connect"); expect(identityResponse.status()).toBe(200);
    const identity = await identityResponse.json(); const sessionId = `${identity.sessionId}:scene-text-real`;
    expect((await context.request.post("/api/collaboration/users/register", { data: { userId: identity.userId, sessionId, displayName: "Synthetic Text Tester" } })).status()).toBe(200);
    const createResponse = await context.request.post("/api/projects", { headers: { "x-cfs-user-id": identity.userId, "x-cfs-session-id": sessionId }, data: { project, createOnly: true, saveProtocol: SAVE_PROTOCOL_VERSION } });
    expect(createResponse.status()).toBe(200); created = true;
    const readBack = async () => {
      const response = await context.request.get("/api/projects"); expect(response.status()).toBe(200);
      const saved = (await response.json()).projects as ProjectData[]; expect(saved.map((entry) => entry.id)).toEqual([project.id]);
      const disk = readFileSync(path.join(dataRoot, "projects.json"));
      const parsed = JSON.parse(disk.toString("utf8")); const diskProjects = Array.isArray(parsed) ? parsed : parsed.projects;
      expect(diskProjects).toEqual(saved);
      return { project: saved[0], diskSha: hash(disk) };
    };
    proof.created = (await readBack()).diskSha;
    const page = await context.newPage();
    const navigate = async (page: Page) => {
      await page.goto("/");
      const card = page.locator("button.screen-card").filter({ hasText: project.name });
      const back = page.getByRole("button", { name: /Back to Project List/i }).first();
      await expect(back.or(card).first()).toBeVisible({ timeout: 30_000 });
      if (await back.isVisible()) await back.click();
      await card.click();
      const start = page.getByRole("button", { name: "Start editing", exact: true }); if (await start.isVisible()) await start.click();
      const registration = page.getByRole("dialog", { name: "User Registration", exact: true });
      if (await registration.isVisible()) {
        await registration.getByRole("textbox", { name: "Display name", exact: true }).fill("Synthetic Text Tester");
        await registration.getByRole("button", { name: "Register", exact: true }).click();
        await expect(registration).toHaveCount(0);
        if (await start.isVisible()) await start.click();
      }
      await page.getByRole("tab", { name: "Room Type", exact: true }).click();
      const roomCard = page.locator("button.screen-card").filter({ hasText: "T140 Room" });
      if (await roomCard.isVisible()) await roomCard.click();
      else await page.getByRole("tab", { name: "T140 Room", exact: true }).click();
      await page.getByRole("tab", { name: "CFS", exact: true }).click();
      await expect(page.locator("table.cfs-matrix-table")).toBeVisible();
    };
    await navigate(page);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: /Open Scene Setting Overlay for.*T140 Arrival/i }).click();
    const target = page.locator(".setting-overlay-panel .switch-individual-table tbody tr").filter({ hasText: "T140 Light" });
    await target.getByRole("combobox", { name: /Input mode/ }).selectOption("text");
    await target.getByRole("textbox", { name: /Text value/ }).fill(firstText);
    await page.locator(".setting-overlay-panel").getByRole("button", { name: "Close", exact: true }).click();
    const save = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/projects" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Save current project without a new revision", exact: true }).click();
    expect((await save).status()).toBe(200);
    const setting = (value: ProjectData) => value.roomTypes[0].roomScenes[0].settings.find((entry) => entry.circuitId === "t140-light");
    const edited = await readBack(); expect(setting(edited.project)).toMatchObject({ percentage: firstText, valueMode: "text" }); proof.editSave = edited.diskSha;
    await navigate(page);
    const cell = page.locator("table.cfs-matrix-table tbody tr").filter({ hasText: "Z1" }).first();
    await expect(cell).toContainText(firstText);
    proof.browserReload = true;
    await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
    await page.getByRole("button", { name: "Start Current Revision", exact: true }).click();
    await cell.getByRole("button", { name: /Edit Inspection value.*T140 Arrival/ }).click();
    const popover = page.locator(".cfs-inspection-popover:not(.cfs-low-high-popover)");
    await expect(popover.getByRole("textbox", { name: /Text value/ })).toHaveValue(firstText);
    await popover.getByRole("textbox", { name: /Text value/ }).fill(inspectionText);
    await popover.getByRole("button", { name: "OK", exact: true }).click();
    await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
    const inspectionSave = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/projects" && response.request().method() === "POST");
    await page.getByRole("dialog", { name: "Finish InspectionMode", exact: true }).getByRole("button", { name: "Finish Current Revision", exact: true }).click();
    expect((await inspectionSave).status()).toBe(200);
    const inspected = await readBack(); expect(setting(inspected.project)).toMatchObject({ percentage: inspectionText, valueMode: "text" });
    expect(inspected.project.roomTypes[0].inspectionMarks?.some((mark) => mark.value === inspectionText && mark.valueMode === "text" && mark.previousValue === firstText && mark.previousValueMode === "text")).toBe(true);
    proof.inspectionSave = inspected.diskSha;
    await navigate(page); await expect(page.locator("table.cfs-matrix-table tbody tr").filter({ hasText: "Z1" }).first()).toContainText(inspectionText);
    proof.inspectionReload = true; expect(unexpected).toEqual([]); proof.status = "passed";
  } finally {
    // A test timeout may already have closed this context; cleanup still owns the files.
    await context.close().catch(() => { proof.contextAlreadyClosed = true; });
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Restore the empty baseline only after every owned page/request has closed.
    // Never remove unknown files or a project not created by this exact run.
    const present = files(); const allowed = new Set(["projects.json", "collaboration.json"]);
    if (present.some((name) => !allowed.has(name))) throw new Error("Cleanup refused unknown owned-data file; retain evidence.");
    if (existsSync(path.join(dataRoot, "projects.json"))) {
      const parsed = JSON.parse(readFileSync(path.join(dataRoot, "projects.json"), "utf8")); const projects = Array.isArray(parsed) ? parsed : parsed.projects;
      if (!created || !Array.isArray(projects) || projects.some((entry: { id: string }) => entry.id !== project.id)) throw new Error("Cleanup refused unrelated project.");
    }
    for (const relative of present) {
      const absolute = path.resolve(dataRoot, relative);
      if (!absolute.startsWith(`${dataRoot}${path.sep}`)) throw new Error("Cleanup path escaped owned root.");
      unlinkSync(absolute);
    }
    expect(files()).toEqual(baseline); proof.cleanupRestoredEmptyBaseline = true;
    writeFileSync(info.outputPath("RESULT.json"), JSON.stringify(proof, null, 2));
  }
});
