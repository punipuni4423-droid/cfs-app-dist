import { test, expect, type Page, type Locator } from "./support/safe-test";
import { seed } from "./support/scene-backlight-test-project";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";
import { readNativeDraftProject } from "./support/native-project-drafts";
import { createEmptyHvacAssignment, createEmptySwitchEntry } from "../../app/lib/constants";
import { pirInstanceValue } from "../../app/lib/switchSync";
import type { ProjectData } from "../../app/types";

const projectName = "Operation UI QA";

function fixture(): ProjectData {
  const project = seed();
  project.id = "operation-ui-20261028";
  project.name = projectName;
  const pd = { ...createEmptySwitchEntry("lutronPd"), buttonCount: "2" };
  const pico = { ...createEmptySwitchEntry("lutronPico"), buttonCount: "2" };
  const contact = createEmptySwitchEntry("contact");
  project.roomTypes[0].switches = [
    { ...pd, id: "pd-source-1", switchGroupId: "pd-source", switchNumber: "SRC", buttonLabel: "M1", buttonFunction: "Arrival" },
    { ...pd, id: "pd-source-2", switchGroupId: "pd-source", switchNumber: "SRC", buttonLabel: "M1", buttonFunction: "Departure" },
    { ...pd, id: "pd-source-other", switchGroupId: "pd-source", switchNumber: "SRC", buttonLabel: "M2", buttonFunction: "Keep source" },
    { ...pd, id: "pd-target-1", switchGroupId: "pd-target", switchNumber: "DST", buttonLabel: "M1", buttonFunction: "Before copy" },
    { ...pd, id: "pd-target-other", switchGroupId: "pd-target", switchNumber: "DST", buttonLabel: "M2", buttonFunction: "Keep destination" },
    { ...pico, id: "pico-source", switchGroupId: "pico-source", switchNumber: "P1", buttonLabel: "1", buttonFunction: "Pico source" },
    { ...pico, id: "pico-target", switchGroupId: "pico-target", switchNumber: "P2", buttonLabel: "1", buttonFunction: "Pico target" },
    { ...contact, id: "contact-1", switchGroupId: "contact", switchNumber: "CCI1", buttonFunction: "Contact function" },
    { ...contact, id: "contact-2", switchGroupId: "contact", switchNumber: "CCI1", buttonFunction: "Second contact function" },
    { ...createEmptySwitchEntry("pir"), id: "pir-1", switchGroupId: "pir", switchNumber: "t140-area", allocation: JSON.stringify({ "t140-area": "1" }), buttonLabel: JSON.stringify([pirInstanceValue("t140-area", 1)]), buttonFunction: "Occupied" },
    { ...createEmptySwitchEntry("qsm"), id: "qsm-1", switchGroupId: "qsm-1", switchNumber: "QSM1", allocation: JSON.stringify([pirInstanceValue("t140-area", 1)]) },
    { ...createEmptySwitchEntry("qsm"), id: "qsm-2", switchGroupId: "qsm-2", switchNumber: "QSM2", allocation: "[]" },
    { ...createEmptySwitchEntry("command"), id: "command-1", switchName: "Arrival command" },
  ];
  project.roomTypes[0].hvacAssignments = [{ ...createEmptyHvacAssignment(), id: "operation-th-1", thermostatNumber: 1, thermostatRole: "Master", area: "t140-area" }];
  project.roomTypes[0].nextThermostatNumber = 2;
  return project;
}

async function open(page: Page, viewOnly = false, project = fixture()) {
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.context().route("**/api/**", route => route.fulfill({ json: {} }));
  const state = await installLocalEditingMocks(page);
  state.projects = [project as unknown as Record<string, unknown>];
  if (viewOnly) await page.context().route("**/api/collaboration/status**", route => route.fulfill({ json: { enabled: true, mode: "view", lock: null, locks: [], lastUpdatedBy: null, leaseSeconds: 90, heartbeatMs: 20000, idleMs: 900000 } }));
  await page.goto("/");
  await page.locator("button.screen-card").filter({ hasText: projectName }).click();
  const start = page.getByRole("button", { name: "Start editing", exact: true });
  if (!viewOnly && await start.isVisible()) await start.click();
  const registration = page.getByRole("dialog", { name: "User Registration", exact: true });
  if (await registration.isVisible()) {
    await registration.getByRole("textbox", { name: "Display name", exact: true }).fill("Operation QA");
    await registration.getByRole("button", { name: "Register", exact: true }).click();
  }
  if (!viewOnly) await expect(page.getByRole("button", { name: "Save current project without a new revision", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  const roomCard = page.locator("button.screen-card").filter({ hasText: "T140 Room" });
  if (await roomCard.isVisible()) await roomCard.click();
  else await page.getByRole("tab", { name: "T140 Room", exact: true }).click();
  await page.getByRole("tab", { name: "Switch", exact: true }).click();
  return state;
}

async function assertOperationGrid(table: Locator, columns: number) {
  const headers = await table.locator("thead th").allTextContents();
  expect(headers.map(text => text.trim())).toContain("Operation");
  expect(headers.map(text => text.trim())).not.toContain("Row");
  expect(headers.map(text => text.trim())).not.toContain("Switch");
  expect(headers.filter(text => text.trim() === "Operation")).toHaveLength(1);
  const coverage = await table.evaluate((element) => {
    const expected = element.querySelectorAll("colgroup col").length;
    const remaining: number[] = [];
    const widths: number[] = [];
    for (const row of Array.from(element.querySelectorAll("tbody tr"))) {
      const filled = remaining.map(value => value > 0);
      for (let index = 0; index < remaining.length; index++) remaining[index] = Math.max(0, remaining[index] - 1);
      let column = 0;
      for (const cell of Array.from(row.querySelectorAll<HTMLTableCellElement>(":scope > td"))) {
        while (filled[column]) column++;
        for (let offset = 0; offset < cell.colSpan; offset++) {
          filled[column + offset] = true;
          remaining[column + offset] = cell.rowSpan - 1;
        }
        column += cell.colSpan;
      }
      widths.push(filled.filter(Boolean).length);
    }
    return { expected, widths };
  });
  expect(coverage.expected).toBe(columns);
  expect(coverage.widths.length).toBeGreaterThan(0);
  expect(coverage.widths.every(width => width === columns)).toBe(true);
}

async function revealAreaOverride(page: Page) {
  const area = page.locator(".setting-overlay .switch-area-panel").first().getByRole("button", { name: /T140 Area/ });
  if (await area.getAttribute("aria-expanded") === "false") await area.click();
  await expect(page.locator(".setting-overlay .scene-value-mode-control").first()).toBeVisible();
}

test("Operation unifies switch kinds and keeps button, function and device action scopes", async ({ page }, info) => {
  test.setTimeout(120_000);
  await open(page);
  for (const [kind, columns] of [["Palladiom", 16], ["CCI", 14], ["Pico", 16], ["PIR", 11], ["QSM", 5], ["Thermostat", 11]] as const) {
    await page.getByRole("tab", { name: kind, exact: true }).click();
    await assertOperationGrid(page.locator(".switch-table"), columns);
    if (kind === "QSM") await expect(page.getByRole("button", { name: "Delete QSM", exact: true })).toHaveCount(2);
    if (kind === "Thermostat") {
      await expect(page.getByRole("region", { name: "Thermostat registration", exact: true })).toBeVisible();
      await expect(page.locator(".switch-table").getByRole("button", { name: "Delete Switch", exact: true })).toBeDisabled();
    }
  }
  await page.getByRole("tab", { name: "Palladiom", exact: true }).click();
  const table = page.locator(".switch-table");
  await expect(table.getByRole("button", { name: "Copy Button", exact: true })).toHaveCount(4);
  const firstRow = table.locator("tbody tr").first();
  const firstButtonOperation = firstRow.locator("td").filter({ has: page.getByRole("button", { name: "Copy Button", exact: true }) });
  await expect(firstButtonOperation).toHaveAttribute("rowspan", "2");
  await expect(firstRow.getByRole("button", { name: "Copy Function", exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: "Copy Switch Settings", exact: true })).toHaveCount(2);
  await expect(table.locator("tbody tr").nth(1).getByRole("button", { name: /Copy Button|Copy Switch|Delete Switch/ })).toHaveCount(0);
  await firstButtonOperation.getByRole("button", { name: "Copy Button", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Copy Button Settings", exact: true })).toHaveCount(0);
  await expect(table.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await expect(firstButtonOperation.getByRole("button", { name: "Paste Button", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  const secondRow = table.locator("tbody tr").nth(1);
  const firstId = await firstRow.getAttribute("data-switch-row-id");
  const secondId = await secondRow.getAttribute("data-switch-row-id");
  expect(firstId).toBeTruthy();
  expect(secondId).toBeTruthy();
  await secondRow.getByLabel("Reorder Function with Up and Down").press("ArrowUp");
  await expect(firstRow).toHaveAttribute("data-switch-row-id", secondId!);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(firstRow).toHaveAttribute("data-switch-row-id", firstId!);
  const handle = secondRow.getByLabel("Reorder Function with Up and Down");
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const firstRowBox = (await firstRow.boundingBox())!;
  const beforeFirst = { dataTransfer, clientY: firstRowBox.y + 1 };
  await handle.dispatchEvent("dragstart", { dataTransfer });
  await firstRow.dispatchEvent("dragover", beforeFirst);
  await expect(firstRow).toHaveClass(/drop-before/);
  await firstRow.dispatchEvent("dragover", { dataTransfer, clientY: firstRowBox.y + firstRowBox.height - 1 });
  await expect(firstRow).toHaveClass(/drop-after/);
  await firstRow.dispatchEvent("dragover", beforeFirst);
  await firstRow.dispatchEvent("drop", beforeFirst);
  await expect(firstRow).toHaveAttribute("data-switch-row-id", secondId!);
  await expect(table.locator(".drop-before, .drop-after")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(firstRow).toHaveAttribute("data-switch-row-id", firstId!);
  await dataTransfer.dispose();
  await page.screenshot({ path: info.outputPath("operation-scopes.png"), fullPage: true });
  await page.getByRole("tab", { name: "Command", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy Command", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete Command", exact: true })).toBeVisible();
});

test("readonly Operation actions stay disabled across button, function and QSM scopes", async ({ page }) => {
  test.setTimeout(90_000);
  const state = await open(page, true);
  const before = JSON.stringify(state.projects);
  for (const kind of ["Palladiom", "CCI", "Pico", "PIR", "QSM", "Thermostat"]) {
    await page.getByRole("tab", { name: kind, exact: true }).click();
    const operations = page.locator(".switch-table .switch-operation-stack button");
    for (const button of await operations.all()) await expect(button).toBeDisabled();
  }
  expect(JSON.stringify(state.projects)).toBe(before);
});

test("Switch and Command mode-only controls preserve every mixed group value", async ({ page }) => {
  test.setTimeout(120_000);
  const project = fixture();
  const secondCircuit = { ...project.circuits[0], id: "operation-light-2", detail: "Second group member" };
  project.circuits.push(secondCircuit);
  project.roomTypes[0].circuitIds = [...(project.roomTypes[0].circuitIds ?? []), secondCircuit.id];
  const settings = [{ circuitId: "t140-light", percentage: "20" }, { circuitId: secondCircuit.id, percentage: "80" }];
  for (const row of project.roomTypes[0].switches) {
    if (row.id === "pd-source-1" || row.id === "command-1") row.buttonSetting = { sceneId: "", sceneIds: [], circuitSettings: settings.map(setting => ({ ...setting })) };
  }
  const invalidCommand = {
    ...createEmptySwitchEntry("command"), id: "command-invalid", switchName: "Mixed text command",
    buttonSetting: { sceneId: "", sceneIds: [], circuitSettings: [{ circuitId: "t140-light", percentage: "20", valueMode: "text" as const }, { circuitId: secondCircuit.id, percentage: "Vacant: Off", valueMode: "text" as const }] },
  };
  project.roomTypes[0].switches.push(invalidCommand);
  await open(page, false, project);
  for (const [tab, rowId] of [["Switch", "pd-source-1"], ["Command", "command-1"]] as const) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    if (tab === "Switch") await page.getByRole("tab", { name: "Palladiom", exact: true }).click();
    await page.locator("table.master-table tbody tr").first().getByRole("button", { name: "Setting", exact: true }).first().click();
    await revealAreaOverride(page);
    const control = page.locator(".setting-overlay .scene-value-mode-control").first();
    await control.getByRole("radio", { name: "Text", exact: true }).click();
    await expect.poll(async () => {
      const draft = await readNativeDraftProject(page, project.id);
      return draft?.roomTypes[0].switches.find(row => row.id === rowId)?.buttonSetting.circuitSettings;
    }).toEqual(settings.map(setting => ({ ...setting, valueMode: "text" })));
    await control.getByRole("radio", { name: "Standard", exact: true }).click();
    await expect.poll(async () => {
      const draft = await readNativeDraftProject(page, project.id);
      return draft?.roomTypes[0].switches.find(row => row.id === rowId)?.buttonSetting.circuitSettings.map(setting => ({ circuitId: setting.circuitId, percentage: setting.percentage, mode: setting.valueMode ?? "standard" }));
    }).toEqual(settings.map(setting => ({ ...setting, mode: "standard" })));
    await page.locator(".setting-overlay-panel").getByRole("button", { name: "Close", exact: true }).click();
  }
  await page.locator("table.master-table tbody tr").nth(1).getByRole("button", { name: "Setting", exact: true }).first().click();
  await revealAreaOverride(page);
  const invalidControl = page.locator(".setting-overlay .scene-value-mode-control").first();
  await expect(invalidControl.getByRole("radio", { name: "Standard", exact: true })).toBeDisabled();
  await expect(invalidControl.getByRole("radio", { name: "Text", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.locator(".setting-overlay-panel").getByRole("button", { name: "Close", exact: true }).click();
});
