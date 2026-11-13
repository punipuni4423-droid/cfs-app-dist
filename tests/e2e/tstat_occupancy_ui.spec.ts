import ExcelJS from "exceljs";
import { test, expect, type Page } from "./support/safe-test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";
import { readNativeDraftProject } from "./support/native-project-drafts";
import { seed, save } from "./support/scene-backlight-test-project";
import { createEmptyHvacAssignment } from "../../app/lib/constants";
import type { ProjectData } from "../../app/types";

const projectId = "tstat-occupancy-ui";
const annotation = "Occupied: 50%\nVacant: Off";
test.use({ actionTimeout: 30_000 });
function fixture(legacy = false) {
  const project = seed(); project.id = projectId; project.name = "TSTAT Occupancy QA";
  project.locations.push({ id: "area-b", name: "Area B", number: "2", code: "B", color: "#eeeeee" });
  if (legacy) project.roomTypes[0].hvacAssignments = [
    { ...createEmptyHvacAssignment(), id: "legacy-th1", area: project.locations[0].id },
    { ...createEmptyHvacAssignment(), id: "legacy-th2", area: project.locations[0].id, thermostatRole: "Slave" },
  ];
  return project;
}
async function navigate(page: Page, viewOnly = false) {
  const card = page.locator("button.screen-card").filter({ hasText: "TSTAT Occupancy QA" });
  const back = page.getByRole("button", { name: /Back to Project List/i }).first();
  await expect(back.or(card).first()).toBeVisible({ timeout: 60_000 });
  if (await back.isVisible()) await back.click();
  await card.click();
  const start = page.getByRole("button", { name: "Start editing", exact: true }); if (!viewOnly && await start.isVisible()) await start.click();
  const registration = page.getByRole("dialog", { name: "User Registration", exact: true });
  if (await registration.isVisible()) { await registration.getByRole("textbox", { name: "Display name", exact: true }).fill("TSTAT QA"); await registration.getByRole("button", { name: "Register", exact: true }).click(); }
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  const room = page.locator("button.screen-card").filter({ hasText: "T140 Room" });
  if (await room.isVisible()) await room.click(); else await page.getByRole("tab", { name: "T140 Room", exact: true }).click();
}
async function hvac(page: Page) {
  await page.getByRole("tab", { name: "Switch", exact: true }).click();
  await page.getByRole("tab", { name: "Thermostat", exact: true }).click();
}
async function setup(page: Page, legacy = false, viewOnly = false) {
  await page.setViewportSize({ width: 2400, height: 1200 });
  await page.context().route("**/api/**", (route) => route.fulfill({ json: {} }));
  const state = await installLocalEditingMocks(page); state.projects = [fixture(legacy) as unknown as Record<string, unknown>];
  if (viewOnly) await page.context().route("**/api/collaboration/status**", (route) => route.fulfill({ json: { enabled: true, mode: "view", lock: null, locks: [], lastUpdatedBy: null, leaseSeconds: 90, heartbeatMs: 20_000, idleMs: 900_000 } }));
  await page.goto("/");
  const user = page.getByRole("button", { name: /^User:/ });
  if (await user.isVisible()) { await user.click(); await page.getByPlaceholder("e.g. Okada").fill("TSTAT QA"); await page.getByRole("button", { name: "Register", exact: true }).click(); }
  await navigate(page, viewOnly); return state;
}
async function draftRoom(page: Page) { return (await readNativeDraftProject(page, projectId))?.roomTypes[0]; }
const tstatRows = (project: ProjectData) => project.roomTypes[0].switches.filter((row) => row.tstatBinding);

test("legacy TSTAT derives one Area control and TH labels without saving new logic", async ({ page }, info) => {
  test.setTimeout(150_000);
  const state = await setup(page, true); const before = JSON.stringify(state.projects);
  await hvac(page);
  const control = page.locator("table.switch-table");
  await expect(control.locator("tbody tr")).toHaveCount(1);
  await expect(control).toContainText("TH1 / TH2");
  expect(tstatRows(state.projects[0] as unknown as ProjectData)).toEqual([]);
  expect((await draftRoom(page))?.switches.filter((row) => row.tstatBinding) ?? []).toEqual([]);
  await page.getByRole("tab", { name: "CFS", exact: true }).click();
  await expect(page.locator("table.cfs-matrix-table thead")).toContainText("TH1 / TH2");
  expect(JSON.stringify(state.projects)).toBe(before);
  await hvac(page);
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Excel Export", exact: true }).click();
  const file = info.outputPath("legacy-tstat.xlsx"); await (await download).saveAs(file);
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(file);
  expect(book.getWorksheet("TSTAT")?.getCell("A2").value).toBe("TH1");
  expect(book.getWorksheet("TSTAT")?.getCell("A3").value).toBe("TH2");
  expect(JSON.stringify(state.projects)).toBe(before);
});

test("registration shares one control, edits Function Trigger Text BL and exports the same TH data", async ({ page }, info) => {
  test.setTimeout(150_000);
  const state = await setup(page); await hvac(page);
  const areaId = fixture().locations[0].id;
  const assignments = page.locator("table.master-table").first();
  await page.getByRole("button", { name: "Add Row (Thermostat)", exact: true }).click();
  await assignments.locator("tbody tr").nth(0).locator("select").nth(2).selectOption(areaId);
  await page.getByRole("button", { name: "Add Row (Thermostat)", exact: true }).click();
  await assignments.locator("tbody tr").nth(1).locator("select").nth(1).selectOption("Slave");
  await assignments.locator("tbody tr").nth(1).locator("select").nth(2).selectOption(areaId);
  const control = page.locator("table.switch-table");
  const row = control.locator("tbody tr").first();
  await expect(control.locator("tbody tr")).toHaveCount(1); await expect(row).toContainText("TH1 / TH2");
  await row.locator("textarea").first().fill("Occupancy");
  await row.getByRole("textbox", { name: "Trigger Condition", exact: true }).fill("Occupied / Vacant");
  await row.getByRole("button", { name: "Setting", exact: true }).first().click();
  const overlay = page.locator(".setting-overlay-panel");
  const target = overlay.locator(".switch-individual-table tbody tr").filter({ hasText: "T140 Light" });
  if (!(await target.isVisible())) await overlay.locator(".switch-area-toggle").filter({ hasText: "T140 Area" }).click();
  await target.getByRole("radio", { name: "Text", exact: true }).click();
  await target.getByRole("textbox", { name: /Text value/ }).fill(annotation);
  await overlay.getByRole("button", { name: "Close", exact: true }).click();
  await row.locator(".setting-status-button").nth(1).click();
  await overlay.locator(".switch-target-option").filter({ hasText: "PD-BY" }).getByRole("checkbox").check();
  await overlay.locator("select").selectOption("masterOn");
  await overlay.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(async () => (await draftRoom(page))?.switches.filter((entry) => entry.tstatBinding).length).toBe(1);
  await save(page);
  const saved = state.projects[0] as unknown as ProjectData;
  expect(saved.roomTypes[0].hvacAssignments.map((entry) => entry.thermostatNumber)).toEqual([1, 2]);
  expect(tstatRows(saved)[0]).toMatchObject({ buttonFunction: "Occupancy", condition: "Occupied / Vacant", backlightCondition: "masterOn" });
  expect(tstatRows(saved)[0].buttonSetting.circuitSettings[0]).toMatchObject({ percentage: annotation, valueMode: "text" });
  await control.screenshot({ path: info.outputPath("tstat-controls.png") });
  await page.reload(); await navigate(page); await hvac(page);
  await expect(page.locator("table.switch-table")).toContainText("TH1 / TH2");
  await page.getByRole("tab", { name: "CFS", exact: true }).click();
  await expect(page.locator("table.cfs-matrix-table")).toContainText(annotation);
  await page.getByRole("button", { name: "Excel Export", exact: true }).click();
  const projectDownload = page.waitForEvent("download"); await page.getByRole("menuitem", { name: "Project (All Tabs)", exact: true }).click();
  const projectFile = info.outputPath("project-th-controls.xlsx"); await (await projectDownload).saveAs(projectFile);
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(projectFile);
  const cells: string[] = []; for (const sheet of book.worksheets) sheet.eachRow((r) => r.eachCell((cell) => cells.push(cell.text)));
  expect(cells).toContain("TH1 / TH2"); expect(cells).toContain("Occupied / Vacant"); expect(cells.some((value) => value.includes(annotation))).toBe(true);
  expect(book.worksheets.find((sheet) => sheet.name.endsWith("TSTAT"))?.getCell("A2").value).toBe("TH1");
  await page.getByRole("button", { name: "Excel Export", exact: true }).click();
  const cfsDownload = page.waitForEvent("download"); await page.getByRole("menuitem", { name: "This Room Type", exact: true }).click();
  const cfsFile = info.outputPath("cfs-th-controls.xlsx"); await (await cfsDownload).saveAs(cfsFile);
  const cfs = new ExcelJS.Workbook(); await cfs.xlsx.readFile(cfsFile);
  const values: string[] = []; cfs.worksheets[0].eachRow((r) => r.eachCell((cell) => values.push(cell.text)));
  expect(values.some((value) => value.includes("TH1 / TH2"))).toBe(true); expect(values.some((value) => value.includes(annotation))).toBe(true);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: /Open Switch Setting Overlay for.*TH1/ }).click();
  const cfsTarget = page.locator(".setting-overlay-panel .switch-individual-table tbody tr").filter({ hasText: "T140 Light" });
  await cfsTarget.getByRole("textbox", { name: /Text value/ }).fill("CFS edited\nStill shared by Area");
  await page.locator(".setting-overlay-panel").getByRole("button", { name: "Close", exact: true }).click();
  await save(page);
  expect(tstatRows(state.projects[0] as unknown as ProjectData)[0].buttonSetting.circuitSettings[0]).toMatchObject({ percentage: "CFS edited\nStill shared by Area", valueMode: "text" });
});

test("ordinary Undo Redo reserves TH numbers after branch registration", async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page); await hvac(page);
  await page.getByRole("button", { name: "Add Row (Thermostat)", exact: true }).click();
  // Existing project history deliberately coalesces edits within 900 ms.
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Add Row (Thermostat)", exact: true }).click();
  await expect.poll(async () => (await draftRoom(page))?.hvacAssignments.map((row) => row.thermostatNumber)).toEqual([1, 2]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await draftRoom(page))?.hvacAssignments.map((row) => row.thermostatNumber)).toEqual([1]);
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Add Row (Thermostat)", exact: true }).click();
  await expect.poll(async () => (await draftRoom(page))?.hvacAssignments.map((row) => row.thermostatNumber)).toEqual([1, 3]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(async () => (await draftRoom(page))?.hvacAssignments.map((row) => row.thermostatNumber)).toEqual([1, 3]);
});

test("view-only TH controls cannot edit Function Trigger settings or registration", async ({ page }, info) => {
  test.setTimeout(90_000);
  const state = await setup(page, true, true); const before = JSON.stringify(state.projects); await hvac(page);
  const control = page.locator("table.switch-table");
  await expect(control.locator("textarea").first()).toBeDisabled();
  await expect(control.getByRole("textbox", { name: "Trigger Condition", exact: true })).toBeDisabled();
  await control.getByRole("button", { name: "Setting", exact: true }).first().click();
  const overlay = page.locator(".setting-overlay-panel");
  const target = overlay.locator(".switch-individual-table tbody tr").filter({ hasText: "T140 Light" });
  if (!(await target.isVisible())) await overlay.locator(".switch-area-toggle").filter({ hasText: "T140 Area" }).click();
  await expect(target.getByRole("radio", { name: "Text", exact: true })).toBeDisabled();
  await overlay.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add Row (Thermostat)", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Excel Export", exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: info.outputPath("view-only-mobile.png") });
  await control.scrollIntoViewIfNeeded();
  expect((await control.locator("..").boundingBox())!.width).toBeLessThanOrEqual(390);
  await control.screenshot({ path: info.outputPath("control-mobile.png") });
  expect(JSON.stringify(state.projects)).toBe(before);
});

test("legacy virtual TH source supports Inspection Undo Redo and Revert without leaving new saved rows", async ({ page }) => {
  test.setTimeout(120_000);
  const state = await setup(page, true); const original = JSON.stringify(state.projects);
  await page.getByRole("tab", { name: "CFS", exact: true }).click();
  await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
  await page.getByRole("button", { name: "Start Current Revision", exact: true }).click();
  const cell = page.locator("table.cfs-matrix-table tbody tr").filter({ hasText: "Z1" }).first().getByRole("button", { name: /Edit Inspection value.*TH1/ });
  await cell.click();
  const popover = page.locator(".cfs-inspection-popover:not(.cfs-low-high-popover)");
  await popover.getByRole("radio", { name: "Text", exact: true }).click();
  const annotationInput = popover.getByRole("textbox", { name: /Text value/ });
  await annotationInput.fill(annotation);
  const standard = popover.getByRole("radio", { name: "Standard", exact: true });
  const cancelClear = page.waitForEvent("dialog").then(async (dialog) => { await dialog.dismiss(); });
  await standard.click(); await cancelClear;
  await expect(annotationInput).toHaveValue(annotation);
  const confirmClear = page.waitForEvent("dialog").then(async (dialog) => { await dialog.accept(); });
  await popover.getByRole("radio", { name: "Text", exact: true }).press("ArrowLeft"); await confirmClear;
  await expect(standard).toHaveAttribute("aria-checked", "true");
  await popover.getByRole("radio", { name: "Text", exact: true }).click();
  await expect(annotationInput).toHaveValue("");
  await annotationInput.fill(annotation);
  await popover.getByRole("button", { name: "OK", exact: true }).click();
  await expect.poll(async () => (await draftRoom(page))?.switches.filter((row) => row.tstatBinding).length).toBe(1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await draftRoom(page))?.switches.filter((row) => row.tstatBinding).length ?? 0).toBe(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(async () => (await draftRoom(page))?.switches.filter((row) => row.tstatBinding).length).toBe(1);
  await page.getByLabel("Inspection draft controls", { exact: true }).getByRole("button", { name: "Revert", exact: true }).click();
  await expect.poll(async () => (await draftRoom(page))?.switches.filter((row) => row.tstatBinding).length ?? 0).toBe(0);
  expect((await draftRoom(page))?.hvacAssignments.some((row) => row.thermostatNumber !== undefined) ?? false).toBe(false);
  expect(JSON.stringify(state.projects)).toBe(original);
});

test("Area move Cancel keeps shared settings and deleting the last member requires confirmation", async ({ page }, info) => {
  test.setTimeout(90_000);
  await setup(page, true); await hvac(page);
  const control = page.locator("table.switch-table");
  await control.locator("tbody tr").first().locator("textarea").first().fill("Keep source action");
  await expect.poll(async () => (await draftRoom(page))?.switches.find((row) => row.tstatBinding)?.buttonFunction).toBe("Keep source action");
  const before = await draftRoom(page); const sourceId = before!.switches.find((row) => row.tstatBinding)!.id;
  const assignments = page.locator("table.master-table").first();
  const select = assignments.locator("tbody tr").nth(1).locator("select").nth(2);
  const cancel = page.waitForEvent("dialog").then(async (dialog) => { expect(dialog.message()).toContain("TH2 will use Area B's shared controls"); await dialog.dismiss(); });
  await select.selectOption("area-b"); await cancel;
  expect(await draftRoom(page)).toEqual(before);
  const accept = page.waitForEvent("dialog").then(async (dialog) => { expect(dialog.message()).toContain("Previously saved controls are retained"); await dialog.accept(); });
  await select.selectOption("area-b"); await accept;
  await expect.poll(async () => (await draftRoom(page))?.switches.find((row) => row.id === sourceId)?.tstatBinding?.assignmentIds).toEqual(["legacy-th1"]);
  expect((await draftRoom(page))?.hvacAssignments.map((row) => row.thermostatNumber)).toEqual([1, 2]);
  const deleteThermostat = assignments.locator("tbody tr").first().getByRole("button", { name: "Delete Thermostat", exact: true });
  const beforeDelete = await draftRoom(page);
  const cancelDelete = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.message()).toContain("remove its configured controls and settings");
    await dialog.dismiss();
  });
  await deleteThermostat.click(); await cancelDelete;
  expect(await draftRoom(page)).toEqual(beforeDelete);
  const acceptDelete = page.waitForEvent("dialog").then(async (dialog) => { await dialog.accept(); });
  await deleteThermostat.click(); await acceptDelete;
  await expect.poll(async () => (await draftRoom(page))?.switches.some((row) => row.id === sourceId)).toBe(false);
  await expect(control).not.toContainText("Keep source action");
  await control.screenshot({ path: info.outputPath("last-member-control-removed.png") });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await draftRoom(page))?.switches.find((row) => row.id === sourceId)?.buttonFunction).toBe("Keep source action");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(async () => (await draftRoom(page))?.switches.some((row) => row.id === sourceId)).toBe(false);
  await page.getByRole("tab", { name: "CFS", exact: true }).click();
  await expect(page.locator("table.cfs-matrix-table")).not.toContainText("Keep source action");
});

test("adding and deleting same-Area TSTATs keeps the authored control and reuses the compacted next number", async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, true); await hvac(page);
  const control = page.locator("table.switch-table");
  await control.locator("tbody tr").first().locator("textarea").first().fill("Shared action stays");
  await expect.poll(async () => (await draftRoom(page))?.switches.find((row) => row.tstatBinding)?.buttonFunction).toBe("Shared action stays");
  const original = (await draftRoom(page))!.switches.find((row) => row.tstatBinding)!;
  const assignments = page.locator("table.master-table").first();
  for (const expected of [3, 3]) {
    await page.getByRole("button", { name: "Add Row (Thermostat)", exact: true }).click();
    const accept = page.waitForEvent("dialog").then(async (dialog) => { await dialog.accept(); });
    await assignments.locator("tbody tr").last().locator("select").nth(2).selectOption(fixture().locations[0].id); await accept;
    await expect(control.locator("tbody tr")).toHaveCount(1);
    await expect.poll(async () => (await draftRoom(page))?.hvacAssignments.at(-1)?.thermostatNumber).toBe(expected);
    const current = (await draftRoom(page))!;
    expect(current.hvacAssignments.at(-1)?.thermostatNumber).toBe(expected);
    expect(current.switches.find((row) => row.id === original.id)?.buttonFunction).toBe("Shared action stays");
    await assignments.locator("tbody tr").last().getByRole("button", { name: "Delete Thermostat", exact: true }).click();
    await expect.poll(async () => (await draftRoom(page))?.hvacAssignments.length).toBe(2);
  }
  expect((await draftRoom(page))?.hvacAssignments.map((row) => row.thermostatNumber)).toEqual([1, 2]);
});


test("Thermostat and Backlight Overview show read-only summaries and return to the same editor", async ({ page }) => {
  const state = await setup(page, true);
  const original = JSON.stringify(state.projects);
  await hvac(page);
  const registration = page.getByRole("region", { name: "Thermostat registration", exact: true });
  const linkAll = registration.getByRole("checkbox", { name: "Link all Thermostats", exact: true });
  await linkAll.check();
  const thermostatModes = page.getByRole("tablist", { name: "Thermostat view mode", exact: true });
  await thermostatModes.getByRole("tab", { name: "Overview", exact: true }).click();
  const summary = page.getByRole("region", { name: "Thermostat overview", exact: true });
  await expect(summary.getByRole("table").first().locator("tbody tr td:first-child")).toHaveText(["TH1", "TH2"]);
  await expect(summary.getByRole("table")).toHaveCount(2);
  await expect(summary.getByRole("heading", { name: "Thermostat Collection", exact: true })).toHaveCount(0);
  await expect(summary.getByRole("heading", { name: "Season Schedule", exact: true })).toBeVisible();
  await expect(summary.getByRole("button")).toHaveCount(0);
  await expect(registration).toBeHidden();
  await thermostatModes.getByRole("tab", { name: "Edit", exact: true }).click();
  await expect(linkAll).toBeChecked();

  await page.getByRole("tab", { name: "Backlight", exact: true }).click();
  const backlightModes = page.getByRole("tablist", { name: "Backlight view mode", exact: true });
  await backlightModes.getByRole("tab", { name: "Overview", exact: true }).click();
  const backlight = page.getByRole("region", { name: "Backlight overview", exact: true });
  await expect(backlight.getByRole("heading", { name: "Stored Backlight Rules", exact: true })).toBeVisible();
  await expect(backlight.getByRole("heading", { name: "Room Scene Backlight Conditions", exact: true })).toBeVisible();
  await expect(backlight.getByRole("button")).toHaveCount(0);
  await backlightModes.getByRole("tab", { name: "Edit", exact: true }).click();
  await expect(backlight).toHaveCount(0);
  expect(JSON.stringify(state.projects)).toBe(original);
});
