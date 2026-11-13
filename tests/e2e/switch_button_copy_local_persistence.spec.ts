import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { seed } from "./support/scene-backlight-test-project";
import { createEmptySwitchEntry } from "../../app/lib/constants";
import { SAVE_PROTOCOL_VERSION } from "../../app/lib/projectSaveProtocol";
import type { ProjectData } from "../../app/types";

test.skip(process.env.CFS_BUTTON_COPY_REAL_API !== "1", "Requires the explicitly owned local API lane.");
test.use({ actionTimeout: 15000, navigationTimeout: 20000 });

test("button copy persists through real local API save and browser reload", async ({ browser, baseURL, storageState }, info) => {
  test.setTimeout(150_000);
  const ownedRoot = path.resolve("artifacts/door-master-20261028/server-r1");
  expect(baseURL).toBe("http://127.0.0.1:3090");
  expect(path.resolve(process.env.CFS_APP_DIR ?? "")).toBe(ownedRoot);
  expect(path.resolve(process.env.CFS_AUTH_DIR ?? "")).toBe(path.resolve("artifacts/door-master-20261028/private-auth-r1"));
  const dataRoot = path.join(ownedRoot, "data");
  const files = () => existsSync(dataRoot) ? readdirSync(dataRoot, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => path.relative(dataRoot, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/")).sort() : [];
  expect(files(), "Real API test requires a restored empty owned data root").toEqual([]);
  const project = seed(); project.id = `button-copy-real-${randomUUID()}`; project.name = "Button Copy Real Local QA";
  const base = { ...createEmptySwitchEntry("lutronPd"), buttonCount: "2" };
  const text = "Occupied:50%\nVacant:Off";
  project.roomTypes[0].switches = [
    { ...base, id: "copy-source-a", switchGroupId: "copy-source", switchNumber: "SRC", buttonLabel: "M1", buttonFunction: "Arrival", condition: "Occupied", buttonSetting: { sceneId: "", sceneIds: [], circuitSettings: [{ circuitId: "t140-light", percentage: text, valueMode: "text" }] } },
    { ...base, id: "copy-source-b", switchGroupId: "copy-source", switchNumber: "SRC", buttonLabel: "M1", buttonFunction: "Departure", condition: "Vacant" },
    { ...base, id: "copy-dest", switchGroupId: "copy-destination", switchNumber: "DST", buttonLabel: "M1", buttonFunction: "Old" },
    { ...base, id: "copy-unselected", switchGroupId: "copy-destination", switchNumber: "DST", buttonLabel: "M2", buttonFunction: "Unchanged" },
  ];
  const originalRows = structuredClone(project.roomTypes[0].switches);
  const context = await browser.newContext({ baseURL, storageState, serviceWorkers: "block", viewport: { width: 1800, height: 1100 } });
  const unexpected: string[] = [];
  const proof: Record<string, unknown> = { root: ownedRoot, projectId: project.id, realApi: true, cloud: false, normal3014: false };
  let created = false;
  mkdirSync(info.outputDir, { recursive: true });
  try {
    await context.route("**/*", async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== baseURL) { unexpected.push("external blocked"); await route.abort(); return; }
      if (url.pathname === "/api/app-update/status") { await route.fulfill({ json: { available: false, supported: false } }); return; }
      const allowedPost = ["/api/projects", "/api/collaboration/users/register", "/api/collaboration/lock/acquire", "/api/collaboration/lock/heartbeat", "/api/collaboration/lock/release"].includes(url.pathname);
      if (request.method() === "GET" || (request.method() === "POST" && allowedPost)) { await route.continue(); return; }
      unexpected.push(`${request.method()} ${url.pathname}`); await route.abort();
    });
    const config = await context.request.get("/api/sharing/config"); expect(config.status()).toBe(200); expect((await config.json()).mode).toBe("local");
    const initial = await context.request.get("/api/projects"); expect(initial.status()).toBe(200); expect((await initial.json()).projects).toEqual([]);
    const identityResponse = await context.request.get("/auth/connect"); expect(identityResponse.status()).toBe(200); const identity = await identityResponse.json();
    const sessionId = `${identity.sessionId}:button-copy-real`;
    expect((await context.request.post("/api/collaboration/users/register", { data: { userId: identity.userId, sessionId, displayName: "Button Copy Synthetic Tester" } })).status()).toBe(200);
    const create = await context.request.post("/api/projects", { headers: { "x-cfs-user-id": identity.userId, "x-cfs-session-id": sessionId }, data: { project, createOnly: true, saveProtocol: SAVE_PROTOCOL_VERSION } });
    expect(create.status()).toBe(200); created = true;
    const readBack = async () => {
      const response = await context.request.get("/api/projects"); expect(response.status()).toBe(200);
      const projects = (await response.json()).projects as ProjectData[]; expect(projects.map(entry => entry.id)).toEqual([project.id]);
      const disk = readFileSync(path.join(dataRoot, "projects.json")); const parsed = JSON.parse(disk.toString("utf8"));
      expect(Array.isArray(parsed) ? parsed : parsed.projects).toEqual(projects);
      proof.diskSha = createHash("sha256").update(disk).digest("hex"); return projects[0];
    };
    const page = await context.newPage();
    const navigate = async (page: Page) => {
      await page.goto("/");
      const card = page.locator("button.screen-card").filter({ hasText: project.name });
      const back = page.getByRole("button", { name: /Back to Project List/i }).first();
      await expect(back.or(card).first()).toBeVisible({ timeout: 30000 }); if (await back.isVisible()) await back.click(); await card.click();
      const start = page.getByRole("button", { name: "Start editing", exact: true }); if (await start.isVisible()) await start.click();
      const registration = page.getByRole("dialog", { name: "User Registration", exact: true });
      if (await registration.isVisible()) { await registration.getByRole("textbox", { name: "Display name", exact: true }).fill("Button Copy Synthetic Tester"); await registration.getByRole("button", { name: "Register", exact: true }).click(); }
      await expect(page.getByRole("button", { name: "Finish editing", exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Room Type", exact: true }).click();
      const room = page.locator("button.screen-card").filter({ hasText: "T140 Room" }); if (await room.isVisible()) await room.click(); else await page.getByRole("tab", { name: "T140 Room", exact: true }).click();
      await page.getByRole("tab", { name: "Switch", exact: true }).click(); await page.getByRole("tab", { name: "Palladiom", exact: true }).click();
    };
    await navigate(page);
    const source = page.locator('.switch-table tr[data-switch-row-id="copy-source-a"]');
    await source.getByRole("button", { name: "Copy Button", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Copy Button Settings", exact: true })).toHaveCount(0);
    const destination = page.locator('.switch-table tr[data-switch-row-id="copy-dest"]');
    await expect(source.getByRole("button", { name: "Paste Button", exact: true })).toBeDisabled();
    await destination.getByRole("button", { name: "Paste Button", exact: true }).click();
    const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/projects" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Save current project without a new revision", exact: true }).click(); expect((await savedResponse).status()).toBe(200);
    const saved = await readBack(); const rows = saved.roomTypes[0].switches;
    const target = rows.filter(row => row.switchGroupId === "copy-destination" && row.buttonLabel === "M1");
    expect(target.map(row => row.buttonFunction)).toEqual(["Arrival", "Departure"]);
    expect(target[0].buttonSetting.circuitSettings[0]).toEqual({ circuitId: "t140-light", percentage: text, valueMode: "text" });
    expect(target[0].id).toBe("copy-dest"); expect(target[1].id).not.toBe("copy-source-b");
    for (const id of ["copy-source-a", "copy-source-b", "copy-unselected"]) expect(rows.find(row => row.id === id)).toEqual(originalRows.find(row => row.id === id));
    proof.realApiSave = true;
    await page.reload(); await navigate(page);
    await expect(page.locator(".switch-table")).toContainText("Arrival");
    await expect(page.locator(".switch-table")).toContainText("Departure");
    expect((await readBack()).roomTypes[0].switches).toEqual(rows);
    await page.screenshot({ path: info.outputPath("real-api-reloaded.png"), fullPage: true });
    proof.browserReload = true; expect(unexpected).toEqual([]); proof.status = "passed";
  } finally {
    await context.close().catch(() => { proof.contextAlreadyClosed = true; });
    await new Promise(resolve => setTimeout(resolve, 500));
    const present = files(); const allowed = new Set(["projects.json", "collaboration.json"]);
    if (present.some(name => !allowed.has(name))) throw new Error("Cleanup refused unknown owned-data file.");
    if (existsSync(path.join(dataRoot, "projects.json"))) {
      const parsed = JSON.parse(readFileSync(path.join(dataRoot, "projects.json"), "utf8")); const projects = Array.isArray(parsed) ? parsed : parsed.projects;
      if (!created || !Array.isArray(projects) || projects.some((entry: { id: string }) => entry.id !== project.id)) throw new Error("Cleanup refused unrelated project.");
    }
    for (const relative of present) { const absolute = path.resolve(dataRoot, relative); if (!absolute.startsWith(`${dataRoot}${path.sep}`)) throw new Error("Cleanup escaped owned root."); unlinkSync(absolute); }
    expect(files()).toEqual([]); proof.cleanupRestoredEmptyBaseline = true;
    writeFileSync(info.outputPath("RESULT.json"), JSON.stringify(proof, null, 2));
  }
});
