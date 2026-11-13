import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { seed } from "./support/scene-backlight-test-project";
import { createEmptyHvacAssignment, createEmptyRoomScene } from "../../app/lib/constants";
import { updateTstatRegistration } from "../../app/lib/tstatOccupancy";
import { SAVE_PROTOCOL_VERSION } from "../../app/lib/projectSaveProtocol";
import type { ProjectData } from "../../app/types";

test.skip(process.env.CFS_DOOR_MASTER_REAL_API !== "1", "Owned real local API lane only.");
test("Master selection, Door wrapping and nonblocking long-name warning survive real local save and reload", async ({ browser, baseURL, storageState }, info) => {
  const root = path.resolve("artifacts/door-master-20261028/server-r1"), dataRoot = path.join(root, "data");
  expect(baseURL).toBe("http://127.0.0.1:3090"); expect(path.resolve(process.env.CFS_APP_DIR ?? "")).toBe(root);
  const files = () => readdirSync(dataRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.relative(dataRoot, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/")).sort();
  expect(files()).toEqual([]); mkdirSync(info.outputDir, { recursive: true });
  writeFileSync(info.outputPath("BASELINE.json"), JSON.stringify({ root, files: [], backup: "No prior owned files" }, null, 2));
  const project = seed(); project.id = `door-master-${randomUUID()}`; project.name = "Door Master Real Local QA";
  project.settings = { programmingName: { tokens: [], bracketStyle: "none", tokenSeparator: "", detailSeparator: " " } };
  project.locations.push({ id: "area-b", name: "Area B", number: "2", code: "B", color: "#eee" });
  const room = project.roomTypes[0], areaId = project.locations[0].id;
  const baseCircuit = project.circuits[0], baseAssignment = room.deviceAssignments[0];
  project.circuits = [49, 50, 51].map((length, index) => ({ ...baseCircuit, id: `name-${length}`, designerNumber: `N${index + 1}`, detail: "名".repeat(length) }));
  room.circuitIds = project.circuits.map((circuit) => circuit.id);
  room.deviceAssignments = project.circuits.map((circuit, index) => ({ ...baseAssignment, id: `light-${index}`, zoneAddress: `Z${index + 1}`, circuitNumber: circuit.designerNumber }));
  room.roomScenes.push({ ...createEmptyRoomScene(), id: "door", kind: "standard", sceneType: "Welcome", triggerCondition: "Door open", settings: [{ circuitId: "name-49", percentage: "Off" }] });
  project.roomTypes[0] = updateTstatRegistration(room, [
    { ...createEmptyHvacAssignment(), id: "master-a", area: areaId },
    { ...createEmptyHvacAssignment(), id: "master-b", area: "area-b", protocol: "FCU" },
    { ...createEmptyHvacAssignment(), id: "slave", area: areaId, protocol: "BACnet", thermostatRole: "Slave" },
  ]);
  const common = project.roomTypes[0].switches.find((entry) => entry.tstatBinding?.areaId === areaId)!;
  common.condition = "Occupied / Vacant"; common.buttonSetting.circuitSettings = [{ circuitId: "name-49", percentage: "Occupied: 50%\nVacant: Off", valueMode: "text" }];
  const originalCommon = JSON.stringify(common);
  const tailOnly = process.env.CFS_DOOR_MASTER_TAIL_ONLY === "1";
  if (tailOnly) project.roomTypes[0].hvacAssignments[2].masterAssignmentId = "master-a";
  const proof: Record<string, unknown> = { realLocal: true, normalEnvironmentTouched: false, cloud: false, syntheticId: project.id, humanInput: false, tailOnly };
  const context = await browser.newContext({ baseURL, storageState, serviceWorkers: "block", viewport: { width: 2400, height: 1200 } });
  const blocked: string[] = [], errors: string[] = []; let created = false;
  try {
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseURL) { blocked.push("External blocked"); await route.abort(); return; }
      if (url.pathname === "/__nextjs_original-stack-frames" && request.method() === "POST") { await route.fulfill({ json: [] }); return; }
      if (url.pathname === "/api/app-update/status") { await route.fulfill({ json: { supported: false, available: false } }); return; }
      if (request.method() === "GET" || (request.method() === "POST" && ["/api/projects", "/api/collaboration/users/register", "/api/collaboration/lock/acquire", "/api/collaboration/lock/heartbeat", "/api/collaboration/lock/release"].includes(url.pathname))) { await route.continue(); return; }
      blocked.push(`${request.method()} ${url.pathname}`); await route.abort();
    });
    expect((await (await context.request.get("/api/sharing/config")).json()).mode).toBe("local");
    expect((await (await context.request.get("/api/projects")).json()).projects).toEqual([]);
    const identityResponse = await context.request.get("/auth/connect"); expect(identityResponse.status()).toBe(200);
    const identity = await identityResponse.json(), sessionId = `${identity.sessionId}:door-master`;
    expect((await context.request.post("/api/collaboration/users/register", { data: { userId: identity.userId, sessionId, displayName: "Synthetic Master Tester" } })).status()).toBe(200);
    expect((await context.request.post("/api/projects", { headers: { "x-cfs-user-id": identity.userId, "x-cfs-session-id": sessionId }, data: { project, createOnly: true, saveProtocol: SAVE_PROTOCOL_VERSION } })).status()).toBe(200); created = true;
    const readBack = async () => {
      const response = await context.request.get("/api/projects"); expect(response.status()).toBe(200);
      const projects = (await response.json()).projects as ProjectData[]; expect(projects.map((entry) => entry.id)).toEqual([project.id]);
      const bytes = readFileSync(path.join(dataRoot, "projects.json")), parsed = JSON.parse(bytes.toString("utf8"));
      expect(Array.isArray(parsed) ? parsed : parsed.projects).toEqual(projects);
      return { project: projects[0], sha: createHash("sha256").update(bytes).digest("hex") };
    };
    const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
    const reviewedLosses: string[] = [];
    page.on("dialog", async (dialog) => {
      const message = dialog.message();
      if (dialog.type() === "confirm" && message.includes("will use") && message.includes("shared controls") && message.endsWith("Continue?")) { await dialog.accept(); return; }
      if (dialog.type() === "confirm" && message.startsWith("A save that reduces data counts was blocked.")) {
        const paths = message.split("\n").filter((line) => line.includes(": Excluded/deleted "));
        if (paths.length && paths.every((line) => /\.hvacAssignments: Excluded\/deleted \d+ items$|\.tstatBinding\.assignmentIds: Excluded\/deleted \d+ items$/.test(line))) {
          reviewedLosses.push(...paths); await dialog.accept(); return;
        }
      }
      errors.push("Unexpected dialog rejected"); await dialog.dismiss();
    });
    const navigate = async () => {
      await page.goto("/"); const card = page.locator("button.screen-card").filter({ hasText: project.name }), back = page.getByRole("button", { name: /Back to Project List/i }).first();
      await expect(back.or(card).first()).toBeVisible({ timeout: 45_000 }); if (await back.isVisible()) await back.click(); await card.click();
      const start = page.getByRole("button", { name: "Start editing", exact: true }); if (await start.isVisible()) await start.click();
      const registration = page.getByRole("dialog", { name: "User Registration", exact: true });
      if (await registration.isVisible()) { await registration.getByRole("textbox", { name: "Display name", exact: true }).fill("Synthetic Master Tester"); await registration.getByRole("button", { name: "Register", exact: true }).click(); await expect(registration).toHaveCount(0); }
      await expect(page.getByRole("button", { name: "Finish editing", exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Room Type", exact: true }).click();
      const roomCard = page.locator("button.screen-card").filter({ hasText: "T140 Room" }); if (await roomCard.isVisible()) await roomCard.click(); else await page.getByRole("tab", { name: "T140 Room", exact: true }).click();
    };
    const hvac = async () => { await page.getByRole("tab", { name: "Switch", exact: true }).click(); await page.getByRole("tablist", { name: "Switch type", exact: true }).getByRole("tab", { name: "Thermostat", exact: true }).click(); };
    const save = async () => {
      const response = page.waitForResponse((entry) => new URL(entry.url()).pathname === "/api/projects" && entry.request().method() === "POST" && entry.status() === 200);
      await page.getByRole("button", { name: "Save current project without a new revision", exact: true }).click();
      const result = await response;
      if (result.status() !== 200) { const error = await result.json(); proof.saveRejection = { status: result.status(), error: error.error, message: error.message, code: error.code }; }
      expect(result.status()).toBe(200); await expect(page.locator(".revision-save-status")).toContainText("Saved");
    };
    await navigate(); await hvac();
    const select = page.getByRole("combobox", { name: "Reference Master TH3", exact: true });
    if (!tailOnly) {
    await expect(select).toHaveValue(""); expect(await select.locator("option").allTextContents()).toEqual(["-", "TH1 / T140 Area / Modbus", "TH2 / Area B / FCU"]);
    await select.selectOption("master-a"); await page.waitForTimeout(1100);
    await page.getByRole("button", { name: "Undo", exact: true }).click(); await expect(select).toHaveValue("");
    await page.getByRole("button", { name: "Redo", exact: true }).click(); await expect(select).toHaveValue("master-a");
    await save(); const saved = await readBack();
    expect(saved.project.roomTypes[0].hvacAssignments[2].masterAssignmentId).toBe("master-a");
    expect(JSON.stringify(saved.project.roomTypes[0].switches.find((entry) => entry.id === common.id))).toBe(originalCommon); proof.editSaveSha = saved.sha;
    await navigate(); await hvac(); await expect(select).toHaveValue("master-a"); proof.reload = true;
    const tstatDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "Excel Export", exact: true }).click();
    const tstatFile = info.outputPath("real-tstat.xlsx"); await (await tstatDownload).saveAs(tstatFile);
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(tstatFile); expect(book.getWorksheet("TSTAT")!.getCell("I4").value).toBe("TH1 / T140 Area / Modbus");
    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    await expect(page.locator(".cfs-programming-name-over-limit")).toHaveCount(1);
    await expect(page.locator(".cfs-programming-name-warning")).toHaveText("51 characters — shorten to 50 or fewer.");
    const nameStyle = await page.locator(".cfs-programming-name-over-limit").evaluate((node) => ({ color: getComputedStyle(node).color, weight: getComputedStyle(node).fontWeight, text: node.textContent }));
    expect(nameStyle).toEqual({ color: "rgb(220, 38, 38)", weight: "700", text: "名".repeat(51) });
    const header = page.locator("th.cfs-switch-head").filter({ hasText: "Door Magnet Scene" }).first(); await expect(header).toBeVisible();
    const wrap = await header.locator("div").first().evaluate((node) => {
      const text = node.firstChild!, value = text.textContent!, words = ["Door", "Magnet", "Scene"];
      return { label: value, style: { break: getComputedStyle(node).wordBreak, wrap: getComputedStyle(node).overflowWrap },
        intact: words.every((word) => { const start = value.indexOf(word); const tops = Array.from(word).map((_, index) => { const range = document.createRange(); range.setStart(text, start + index); range.setEnd(text, start + index + 1); return Math.round(range.getBoundingClientRect().top); }); return new Set(tops).size === 1; }) };
    });
    expect(wrap).toMatchObject({ label: "Door Magnet Scene", style: { break: "normal", wrap: "normal" }, intact: true }); proof.wrap = wrap;
    await page.screenshot({ path: info.outputPath("cfs-warning-door.png"), fullPage: false });
    const exportMenu = page.getByRole("button", { name: "Excel Export", exact: true }); await exportMenu.click();
    const [projectDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Project (All Tabs)", exact: true }).click()]);
    const projectFile = info.outputPath("real-project.xlsx"); await projectDownload.saveAs(projectFile);
    const projectBook = new ExcelJS.Workbook(); await projectBook.xlsx.readFile(projectFile);
    expect(projectBook.worksheets.some((sheet) => sheet.name.includes("Door Magnet Scene"))).toBe(true);
    const projectTstat = projectBook.worksheets.find((sheet) => sheet.name.endsWith(" - TSTAT"))!; expect(projectTstat.getCell("I4").value).toBe("TH1 / T140 Area / Modbus");
    const cfsSheet = projectBook.worksheets.find((sheet) => sheet.name.endsWith(" - CFS"))!;
    const richNames: ExcelJS.Cell[] = []; cfsSheet.eachRow((row) => row.eachCell((cell) => { if (cell.type === ExcelJS.ValueType.RichText && cell.text === "名".repeat(51)) richNames.push(cell); }));
    expect(richNames).toHaveLength(1); const warningFont = (richNames[0].value as ExcelJS.CellRichTextValue).richText[0].font;
    expect(warningFont?.bold).toBe(true); expect(warningFont?.color?.argb?.toUpperCase()).toBe("FFDC2626");
    expect(JSON.stringify(cfsSheet.getSheetValues())).not.toContain("shorten");
    await page.getByRole("button", { name: "Edit", exact: true }).click(); await expect(page.locator(".cfs-programming-name-warning")).toHaveCount(1);
    await page.getByRole("button", { name: "InspectionMode", exact: true }).click(); await page.getByRole("button", { name: "Start Current Revision", exact: true }).click();
    await expect(page.locator(".cfs-programming-name-warning")).toHaveCount(1);
    await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
    const finishResponse = page.waitForResponse((entry) => new URL(entry.url()).pathname === "/api/projects" && entry.request().method() === "POST");
    await page.getByRole("dialog", { name: "Finish InspectionMode", exact: true }).getByRole("button", { name: "Finish Current Revision", exact: true }).click();
    expect((await finishResponse).status()).toBe(200); await expect(page.locator(".revision-save-status")).toContainText("Saved");
    await expect(page.getByRole("dialog", { name: "Finish InspectionMode", exact: true })).toHaveCount(0); proof.warningNonblockingEditInspectionExport = true;
    }
    await hvac(); const table = page.locator("table.master-table").first();
    await table.locator("tbody tr").first().locator("select").nth(1).selectOption("Slave");
    await expect(select).toHaveValue("master-a"); await expect(select.locator("option:checked")).toContainText("not Master");
    await save(); expect((await readBack()).project.roomTypes[0].hvacAssignments[2].masterAssignmentId).toBe("master-a"); proof.roleChangeRetained = true;
    await table.locator("tbody tr").first().locator("select").nth(1).selectOption("Master");
    await table.locator("tbody tr").first().locator("select").nth(2).selectOption("area-b");
    await expect(select.locator("option:checked")).toHaveText("TH1 / Area B / Modbus"); await save();
    const moved = await readBack(); expect(moved.project.roomTypes[0].hvacAssignments[2].masterAssignmentId).toBe("master-a");
    expect(moved.project.roomTypes[0].switches.find((entry) => entry.id === common.id)!.buttonSetting.circuitSettings[0].percentage).toBe("Occupied: 50%\nVacant: Off"); proof.areaMoveRetained = true;
    await table.locator("tbody tr").first().getByRole("button", { name: "Delete Thermostat", exact: true }).click();
    const renumberedSelect = page.getByRole("combobox", { name: "Reference Master TH2", exact: true });
    await expect(renumberedSelect).toHaveValue("master-a"); await expect(renumberedSelect.locator("option:checked")).toHaveText("Unavailable Master");
    await save(); const missing = await readBack(); expect(missing.project.roomTypes[0].hvacAssignments.find((row) => row.id === "slave")!.masterAssignmentId).toBe("master-a");
    await navigate(); await hvac(); await expect(renumberedSelect.locator("option:checked")).toHaveText("Unavailable Master"); proof.missingSaveReloadSha = missing.sha;
    await page.getByRole("button", { name: "Finish editing", exact: true }).click(); await expect(renumberedSelect).toBeDisabled();
    await page.screenshot({ path: info.outputPath("reference-master-readonly.png"), fullPage: false });
    await page.getByRole("tab", { name: "CFS", exact: true }).click(); await expect(page.locator(".cfs-programming-name-warning")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Excel Export", exact: true })).toBeEnabled(); proof.readonlyWarningAndReference = true;
    expect(missing.project.circuits.map((circuit) => circuit.detail)).toEqual([49, 50, 51].map((length) => "名".repeat(length)));
    expect(blocked).toEqual([]); expect(errors).toEqual([]); proof.reviewedLosses = reviewedLosses; proof.status = "passed";
  } catch (error) {
    proof.status = "failed"; proof.failure = error instanceof Error ? error.message : "Unknown test failure"; proof.pageErrors = errors; proof.blockedRequests = blocked;
    throw error;
  } finally {
    await context.close().catch(() => { proof.contextAlreadyClosed = true; }); await new Promise((resolve) => setTimeout(resolve, 500));
    const names = files(); if (names.some((name) => !["projects.json", "collaboration.json"].includes(name))) throw new Error("Owned cleanup found an unknown file.");
    if (existsSync(path.join(dataRoot, "projects.json"))) { const parsed = JSON.parse(readFileSync(path.join(dataRoot, "projects.json"), "utf8")), projects = Array.isArray(parsed) ? parsed : parsed.projects;
      if (!created || !Array.isArray(projects) || projects.some((entry: { id: string }) => entry.id !== project.id)) throw new Error("Cleanup refused unrelated data."); }
    for (const name of names) { const file = path.resolve(dataRoot, name); if (!file.startsWith(`${dataRoot}${path.sep}`)) throw new Error("Cleanup escaped owned root."); unlinkSync(file); }
    expect(files()).toEqual([]); proof.cleanupEmpty = true; writeFileSync(info.outputPath("RESULT.json"), JSON.stringify(proof, null, 2));
  }
});
