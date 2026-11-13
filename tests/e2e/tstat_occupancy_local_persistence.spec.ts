import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { seed } from "./support/scene-backlight-test-project";
import { SAVE_PROTOCOL_VERSION } from "../../app/lib/projectSaveProtocol";
import type { ProjectData } from "../../app/types";

test.skip(process.env.CFS_TSTAT_REAL_API !== "1", "Explicit owned TSTAT API lane only.");
test("registered Area TSTAT controls persist through real local API and Inspection save", async ({ browser, baseURL, storageState }, info) => {
  const root = path.resolve("artifacts/tstat-occupancy-20261027/server-r1"); const dataRoot = path.join(root, "data");
  expect(baseURL).toBe("http://127.0.0.1:3090"); expect(path.resolve(process.env.CFS_APP_DIR ?? "")).toBe(root);
  const files = () => existsSync(dataRoot) ? readdirSync(dataRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.relative(dataRoot, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/")).sort() : [];
  expect(files()).toEqual([]); mkdirSync(info.outputDir, { recursive: true });
  writeFileSync(info.outputPath("BASELINE.json"), JSON.stringify({ root, files: [], backup: "Original files absent" }, null, 2));
  const project = seed(); project.id = `tstat-real-${randomUUID()}`; project.name = "TSTAT Real Local QA";
  const body = "Occupied: 50%\nVacant: Off"; const inspectedBody = "Inspection: occupied 60%\nVacant Off";
  const proof: Record<string, unknown> = { root, syntheticId: project.id, realLocal: true, cloud: false, trace: false, authStorageWritten: false };
  const context = await browser.newContext({ baseURL, storageState, serviceWorkers: "block", viewport: { width: 2400, height: 1200 } });
  const blocked: string[] = []; let created = false;
  try {
    await context.route("**/*", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== baseURL) { blocked.push("External blocked"); await route.abort(); return; }
      if (url.pathname === "/api/app-update/status") { await route.fulfill({ json: { supported: false, available: false } }); return; }
      if (request.method() === "GET" || (request.method() === "POST" && ["/api/projects", "/api/collaboration/users/register", "/api/collaboration/lock/acquire", "/api/collaboration/lock/heartbeat", "/api/collaboration/lock/release"].includes(url.pathname))) { await route.continue(); return; }
      blocked.push(`${request.method()} ${url.pathname}`); await route.abort();
    });
    const config = await context.request.get("/api/sharing/config"); expect(config.status()).toBe(200); expect((await config.json()).mode).toBe("local");
    const first = await context.request.get("/api/projects"); expect(first.status()).toBe(200); expect((await first.json()).projects).toEqual([]);
    const identityResponse = await context.request.get("/auth/connect"); expect(identityResponse.status()).toBe(200);
    const identity = await identityResponse.json(); const sessionId = `${identity.sessionId}:tstat-real`;
    expect((await context.request.post("/api/collaboration/users/register", { data: { userId: identity.userId, sessionId, displayName: "Synthetic TSTAT Tester" } })).status()).toBe(200);
    const create = await context.request.post("/api/projects", { headers: { "x-cfs-user-id": identity.userId, "x-cfs-session-id": sessionId }, data: { project, createOnly: true, saveProtocol: SAVE_PROTOCOL_VERSION } });
    expect(create.status()).toBe(200); created = true;
    const readBack = async () => {
      const response = await context.request.get("/api/projects"); expect(response.status()).toBe(200);
      const projects = (await response.json()).projects as ProjectData[]; expect(projects.map((row) => row.id)).toEqual([project.id]);
      const bytes = readFileSync(path.join(dataRoot, "projects.json")); const parsed = JSON.parse(bytes.toString("utf8"));
      expect(Array.isArray(parsed) ? parsed : parsed.projects).toEqual(projects);
      return { project: projects[0], sha: createHash("sha256").update(bytes).digest("hex") };
    };
    const page = await context.newPage();
    const navigate = async () => {
      await page.goto("/");
      const card = page.locator("button.screen-card").filter({ hasText: project.name }); const back = page.getByRole("button", { name: /Back to Project List/i }).first();
      await expect(back.or(card).first()).toBeVisible({ timeout: 30_000 }); if (await back.isVisible()) await back.click(); await card.click();
      const start = page.getByRole("button", { name: "Start editing", exact: true }); if (await start.isVisible()) await start.click();
      const registration = page.getByRole("dialog", { name: "User Registration", exact: true });
      if (await registration.isVisible()) { await registration.getByRole("textbox", { name: "Display name", exact: true }).fill("Synthetic TSTAT Tester"); await registration.getByRole("button", { name: "Register", exact: true }).click(); await expect(registration).toHaveCount(0); if (await start.isVisible()) await start.click(); }
      await page.getByRole("tab", { name: "Room Type", exact: true }).click();
      const roomCard = page.locator("button.screen-card").filter({ hasText: "T140 Room" }); if (await roomCard.isVisible()) await roomCard.click(); else await page.getByRole("tab", { name: "T140 Room", exact: true }).click();
    };
    await navigate(); await page.getByRole("tab", { name: "Switch", exact: true }).click(); await page.getByRole("tablist", { name: "Switch type", exact: true }).getByRole("tab", { name: "Thermostat", exact: true }).click();
    const table = page.locator("table.master-table").first();
    for (let index = 0; index < 2; index++) {
      await page.getByRole("button", { name: "Add Row (Thermostat)", exact: true }).click();
      if (index) await table.locator("tbody tr").nth(index).locator("select").nth(1).selectOption("Slave");
      await table.locator("tbody tr").nth(index).locator("select").nth(2).selectOption(project.locations[0].id);
    }
    const control = page.getByRole("region", { name: "TSTAT Control", exact: true }); await expect(control.locator("tbody tr")).toHaveCount(1);
    const row = control.locator("tbody tr").first(); await expect(row).toContainText("TH1 / TH2");
    await row.locator("textarea").first().fill("Occupancy"); await row.getByRole("textbox", { name: "Trigger Condition", exact: true }).fill("Occupied / Vacant");
    await row.getByRole("button", { name: "Setting", exact: true }).first().click();
    const overlay = page.locator(".setting-overlay-panel"); const target = overlay.locator(".switch-individual-table tbody tr").filter({ hasText: "T140 Light" });
    if (!(await target.isVisible())) await overlay.locator(".switch-area-toggle").filter({ hasText: "T140 Area" }).click();
    await target.getByRole("radio", { name: "Text", exact: true }).click(); await target.getByRole("textbox", { name: /Text value/ }).fill(body);
    await overlay.getByRole("button", { name: "Close", exact: true }).click();
    const save = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/projects" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Save current project without a new revision", exact: true }).click(); expect((await save).status()).toBe(200);
    const saved = await readBack(); const savedRoom = saved.project.roomTypes[0]; const sources = savedRoom.switches.filter((entry) => entry.tstatBinding);
    expect(savedRoom.hvacAssignments.map((entry) => entry.thermostatNumber)).toEqual([1, 2]); expect(sources).toHaveLength(1);
    expect(sources[0].tstatBinding?.assignmentIds).toEqual(savedRoom.hvacAssignments.map((entry) => entry.id)); expect(sources[0]).toMatchObject({ buttonFunction: "Occupancy", condition: "Occupied / Vacant" });
    expect(sources[0].buttonSetting.circuitSettings[0]).toMatchObject({ percentage: body, valueMode: "text" }); proof.editSave = saved.sha;
    await navigate(); await page.getByRole("tab", { name: "CFS", exact: true }).click(); await expect(page.locator("table.cfs-matrix-table")).toContainText(body); proof.reload = true;
    await page.getByRole("button", { name: "InspectionMode", exact: true }).click(); await page.getByRole("button", { name: "Start Current Revision", exact: true }).click();
    const cell = page.locator("table.cfs-matrix-table tbody tr").filter({ hasText: "Z1" }).first().getByRole("button", { name: /Edit Inspection value.*TH1/ });
    await cell.click(); const popover = page.locator(".cfs-inspection-popover:not(.cfs-low-high-popover)");
    await expect(popover.getByRole("textbox", { name: /Text value/ })).toHaveValue(body); await popover.getByRole("textbox", { name: /Text value/ }).fill(inspectedBody);
    await popover.getByRole("button", { name: "OK", exact: true }).click(); await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
    const inspectionSave = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/projects" && response.request().method() === "POST");
    await page.getByRole("dialog", { name: "Finish InspectionMode", exact: true }).getByRole("button", { name: "Finish Current Revision", exact: true }).click(); expect((await inspectionSave).status()).toBe(200);
    const inspected = await readBack(); expect(inspected.project.roomTypes[0].switches.find((entry) => entry.id === sources[0].id)?.buttonSetting.circuitSettings[0]).toMatchObject({ percentage: inspectedBody, valueMode: "text" });
    expect(inspected.project.roomTypes[0].inspectionMarks.some((mark) => mark.sourceId === sources[0].id && mark.value === inspectedBody && mark.previousValue === body && mark.valueMode === "text" && mark.previousValueMode === "text")).toBe(true);
    expect(inspected.project.roomTypes[0].hvacAssignments.map((entry) => entry.thermostatNumber)).toEqual([1, 2]); proof.inspectionSave = inspected.sha;
    await navigate(); await page.getByRole("tab", { name: "CFS", exact: true }).click(); await expect(page.locator("table.cfs-matrix-table")).toContainText(inspectedBody); proof.inspectionReload = true;
    expect(blocked).toEqual([]); proof.status = "passed";
  } finally {
    await context.close().catch(() => { proof.contextAlreadyClosed = true; }); await new Promise((resolve) => setTimeout(resolve, 500));
    const names = files(); if (names.some((name) => !["projects.json", "collaboration.json"].includes(name))) throw new Error("Cleanup refused unknown file.");
    if (existsSync(path.join(dataRoot, "projects.json"))) {
      const parsed = JSON.parse(readFileSync(path.join(dataRoot, "projects.json"), "utf8")); const projects = Array.isArray(parsed) ? parsed : parsed.projects;
      if (!created || !Array.isArray(projects) || projects.some((entry: { id: string }) => entry.id !== project.id)) throw new Error("Cleanup refused unrelated project.");
    }
    for (const name of names) { const file = path.resolve(dataRoot, name); if (!file.startsWith(`${dataRoot}${path.sep}`)) throw new Error("Cleanup escaped root."); unlinkSync(file); }
    expect(files()).toEqual([]); proof.cleanupEmpty = true; writeFileSync(info.outputPath("RESULT.json"), JSON.stringify(proof, null, 2));
  }
});
