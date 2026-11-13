import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { test, expect, type Page } from "./support/safe-test";
import { seed, save } from "./support/scene-backlight-test-project";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";
import { readNativeDraftProject } from "./support/native-project-drafts";
import { createEmptyCircuitEntry, createEmptyDeviceAssignment, createEmptyHvacAssignment, createEmptyRoomScene, createNewRoomType } from "../../app/lib/constants";
import type { ProjectData } from "../../app/types";
import { normalizeProjectSave } from "../../app/lib/storage";
import { setSceneSettingValue } from "../../app/lib/settingValues";
import { normalizeSceneSettingsByCircuitGroup, sameSceneSettings } from "../../app/lib/circuitGroups";
import { formatLevel, hasSetting, normalizeInspectionInput, roomSceneCellValue } from "../../app/lib/cfsValueResolver";
import { settingValuesEqual, canUseStandardValue } from "../../app/lib/sceneValueMode";
import { normalizeRoomSceneSettingLinksAfterCommit } from "../../app/lib/roomSceneSettingLinks";
import { roomSceneColumnGroupLabel, upgradeSceneColumnGroupKeys } from "../../app/lib/cfsSceneColumnGroups";
import { buildRevisionChangeEntries } from "../../app/lib/revisionChanges";

const text = "50% when occupied\nOff when vacant";

function fixture(): ProjectData {
  const project = seed();
  project.id = "scene-text-project"; project.name = "Scene Text Test";
  const room = project.roomTypes[0]; room.name = "Text Room";
  const onoff = { ...createEmptyCircuitEntry("TEXT-ONOFF"), id: "text-onoff", area: project.locations[0].id, dimmingType: "On/Off", detail: "OnOff Text load" };
  project.circuits.push(onoff);
  room.circuitIds = project.circuits.map((circuit) => circuit.id);
  room.deviceAssignments.push({ ...createEmptyDeviceAssignment(), id: "text-onoff-assignment", device: "MQSE-4A1-D", deviceNum: "1", zoneAddress: "Z2", circuitNumber: "TEXT-ONOFF" });
  room.roomScenes[0].settings.push({ circuitId: onoff.id, percentage: "On" });
  room.roomScenes.push({ ...createEmptyRoomScene("Check In", "Door check", "", "Door", "standard"), id: "text-door" });
  room.scenes = [{ id: "text-area-scene", areaId: project.locations[0].id, name: "Text area", settings: [{ circuitId: project.circuits[0].id, percentage: "45" }] }];
  room.hvacAssignments = [{ ...createEmptyHvacAssignment(), id: "text-hvac", area: project.locations[0].id, protocol: "BACnet", thermostatRole: "Master", note: "Summer / Winter note" }];
  const unused = createNewRoomType("Unvisited Room"); unused.roomScenes = []; unused.switches = []; unused.scenes = []; unused.circuitIds = [];
  project.roomTypes.push(unused);
  return project;
}

test("Text mode preserves literal values and standard normalization remains bounded", () => {
  for (const value of [text, "50", "=SUM(A1:A2)\n@note", "25°C\n50%", "  line one\nline two  "]) {
    expect(formatLevel(value, "0-10V", "text")).toBe(value);
    expect(normalizeInspectionInput(value, "0-10V", "text")).toBe(value);
  }
  expect(formatLevel("50 when occupied", "0-10V")).toBe("50 when occupied");
  expect(normalizeInspectionInput("50 when occupied", "0-10V")).toBe("50 when occupied");
  expect(normalizeInspectionInput("120%", "0-10V")).toBe("100");
  expect(formatLevel("50", "0-10V")).toBe("50%");
  expect(settingValuesEqual("50", "text", "50", "standard")).toBe(false);
  expect(settingValuesEqual("50%", "standard", "50", "standard")).toBe(true);
  expect(canUseStandardValue(text, "0-10V")).toBe(false);
});

test("Text mode survives group normalization, link propagation and save normalization", () => {
  const project = fixture(); const room = project.roomTypes[0]; const circuit = project.circuits[0];
  room.scenes[0].settings = setSceneSettingValue([], circuit.id, text, "text");
  const grouped = normalizeSceneSettingsByCircuitGroup(room.scenes[0].settings, project.circuits);
  expect(grouped.find((setting) => setting.circuitId === circuit.id)).toMatchObject({ percentage: text, valueMode: "text" });
  expect(sameSceneSettings(grouped, normalizeSceneSettingsByCircuitGroup(grouped, project.circuits))).toBe(true);
  const previous = room.roomScenes.slice(0, 2).map((scene) => ({ ...scene, settingLinkGroupId: "text-linked" }));
  const next = normalizeRoomSceneSettingLinksAfterCommit(previous, previous.map((scene, index) => index === 0
    ? { ...scene, settings: setSceneSettingValue(scene.settings, circuit.id, "50", "text") } : scene));
  expect(next[1].settings.find((setting) => setting.circuitId === circuit.id)).toMatchObject({ percentage: "50", valueMode: "text" });
  room.roomScenes = next;
  room.inspectionMarks = [{ id: "text-mark", sourceType: "roomScene", sourceId: next[0].id, targetId: circuit.id, scope: "override", label: "Text", previousValue: "37", previousValueMode: "standard", value: "50", valueMode: "text", markedAt: "2026-10-27T00:00:00Z" }];
  const saved = normalizeProjectSave(project);
  expect(saved.roomTypes[0].scenes[0].settings.find((setting) => setting.circuitId === circuit.id)?.valueMode).toBe("text");
  expect(saved.roomTypes[0].inspectionMarks?.[0].valueMode).toBe("text");
  expect(roomSceneCellValue(saved.roomTypes[0].roomScenes[0], circuit, new Map(), true)).toEqual(["50"]);
  expect(normalizeProjectSave(saved)).toEqual(saved);
});

test("DoorMagnet group split preserves legacy order and visibility once", () => {
  const scenes = fixture().roomTypes[0].roomScenes;
  expect(roomSceneColumnGroupLabel(scenes[0])).toBe("Scene");
  expect(roomSceneColumnGroupLabel(scenes[2])).toBe("Door Magnet Scene");
  const old = ["switch\u0000SW1", "scene\u0000Scene", "command\u0000Command"];
  expect(upgradeSceneColumnGroupKeys(old)).toEqual([old[0], old[1], "scene\u0000DoorMagnetScene", old[2]]);
  expect(upgradeSceneColumnGroupKeys(["scene\u0000Scene"], 2)).toEqual(["scene\u0000Scene"]);
  expect(old).toHaveLength(3);
});

test("Empty Text stays inherited and mode-only changes remain visible in revision details", () => {
  const project = fixture(); const room = project.roomTypes[0]; const circuit = project.circuits[0];
  expect(hasSetting([{ circuitId: circuit.id, percentage: "", valueMode: "text" }], circuit.id)).toBe(false);
  const before = room.roomScenes[0];
  const after = { ...before, settings: setSceneSettingValue(before.settings, circuit.id, "37", "text") };
  const entries = buildRevisionChangeEntries({ roomScenes: [before] }, { roomScenes: [after] }, { locations: project.locations, devices: [] });
  expect(entries.some((entry) => entry.before === "37" && entry.after === "Text: 37")).toBe(true);
});

test("Mixed Inspection mode-only changes preserve each body and explicit clearing remains distinct", () => {
  // Reuse the independent V's extraction approach, without overwriting its failing evidence.
  const source = readFileSync("app/components/CfsView.tsx", "utf8");
  const ast = ts.createSourceFile("CfsView.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && ["inspectionCellModel", "isStandardOnlyInspectionCell", "inspectionSavedText", "changeInspectionCell"].includes(node.name?.text ?? "")) functions.push(node.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast); expect(functions).toHaveLength(4);
  function run(values: string[], modes: ("standard" | "text")[] = ["standard", "standard"]) {
    const refs = values.map((value, index) => ({ key: String(index), targetId: String(index), areaId: "area", sourceType: "roomScene", sourceId: "scene", previousValue: value, previousValueMode: modes[index] }));
    const drafts: Record<string, { value: string; valueMode: string }> = {};
    let history = 0;
    const env = {
      canEdit: true, inspectionMode: true, inspectionSavePendingRef: { current: false }, inspectionDrafts: drafts, inspectionDraftsTouchedRef: { current: false },
      rowTargetIds: () => refs, isReadonlyInspectionTarget: () => false,
      draftForInspectionTarget: (_col: unknown, ref: typeof refs[number]) => env.inspectionDrafts[ref.key],
      rawInspectionValueForTarget: (_col: unknown, id: string) => values[Number(id)], rawInspectionModeForTarget: (_col: unknown, id: string) => modes[Number(id)],
      targetDimmingType: () => "0-10V", normalizeInspectionInput, canUseStandardValue, settingValuesEqual,
      activeInspectionDraftRefsForCell: () => refs,
      sourceValueForInspectionDraft: (_type: unknown, _source: unknown, id: string) => values[Number(id)],
      sourceModeForInspectionDraft: (_type: unknown, _source: unknown, id: string) => modes[Number(id)],
      pushInspectionHistorySnapshot: () => { history++; }, setInspectionBaselineValues: (update: (value: object) => object) => update({}),
      setInspectionDrafts: (update: (value: typeof drafts) => typeof drafts) => { env.inspectionDrafts = update(env.inspectionDrafts); },
    };
    const context = vm.createContext(env);
    vm.runInContext(ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    const model = () => vm.runInContext("inspectionCellModel({}, {roomScene:{},kind:'command'})", context);
    const change = (mode: string, kind = "mode", value = "") => vm.runInContext(`changeInspectionCell({}, {roomScene:{},kind:"command"}, ${JSON.stringify(value)}, ${JSON.stringify(mode)}, ${JSON.stringify(kind)})`, context);
    return { env, model, change, history: () => history };
  }
  for (const values of [["50", "75"], ["0", "Off"]]) {
    const state = run(values);
    expect(state.model().placeholder).toBe("Mixed");
    state.change("text");
    expect(Object.values(state.env.inspectionDrafts).map((draft) => draft.value)).toEqual(values);
    expect(Object.values(state.env.inspectionDrafts).map((draft) => draft.valueMode)).toEqual(["text", "text"]);
    state.change("standard"); expect(state.env.inspectionDrafts).toEqual({});
    state.change("text"); state.change("text", "value", "");
    expect(Object.values(state.env.inspectionDrafts).map((draft) => draft.value)).toEqual(["", ""]);
  }
  const notes = run(["Occupied: 50%", "Vacant: Off"], ["text", "text"]);
  expect(notes.model().standardAllowed).toBe(false);
  notes.change("standard"); expect(notes.env.inspectionDrafts).toEqual({}); expect(notes.history()).toBe(0);
  const numericText = run(["50", "75"], ["text", "text"]);
  numericText.change("standard");
  expect(Object.values(numericText.env.inspectionDrafts).map((draft) => draft.value)).toEqual(["50", "75"]);
  const mixedModes = run(["50", "50"], ["text", "standard"]);
  mixedModes.change("text"); expect(Object.keys(mixedModes.env.inspectionDrafts)).toEqual(["1"]);
});

async function navigate(page: Page) {
  const back = page.getByRole("button", { name: /Back to Project List/i }).first();
  const card = page.locator("button.screen-card").filter({ hasText: "Scene Text Test" });
  await expect(back.or(card).first()).toBeVisible({ timeout: 30_000 });
  if (await back.isVisible()) await back.click();
  await card.click();
  const start = page.getByRole("button", { name: "Start editing", exact: true });
  if (await start.isVisible()) await start.click();
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  const roomCard = page.locator("button.screen-card").filter({ hasText: "Text Room" }).first();
  if (await roomCard.isVisible()) await roomCard.click();
  else await page.getByRole("tab", { name: "Text Room", exact: true }).click();
  await page.getByRole("tab", { name: "CFS", exact: true }).click();
  await expect(page.locator("table.cfs-matrix-table")).toBeVisible();
}

async function setup(page: Page, project = fixture()) {
  await page.setViewportSize({ width: 2400, height: 1100 });
  await page.context().route("**/api/**", (route) => route.fulfill({ json: {} }));
  const state = await installLocalEditingMocks(page); state.projects = [project as unknown as Record<string, unknown>];
  await page.goto("/");
  const user = page.getByRole("button", { name: /^User:/ });
  if (await user.isVisible()) { await user.click(); await page.getByPlaceholder("e.g. Okada").fill("Text QA"); await page.getByRole("button", { name: "Register", exact: true }).click(); }
  await navigate(page); return state;
}

async function currentRoom(page: Page) { return (await readNativeDraftProject(page, "scene-text-project"))?.roomTypes[0]; }
function roomSetting(page: Page) { return page.locator(".setting-overlay-panel .switch-individual-table tbody tr").filter({ hasText: "T140 Light" }); }

test("CFS scene editor shows only lighting values and preserves saved text in project Excel", async ({ page }, info) => {
  test.setTimeout(150_000);
  const project = fixture();
  const lighting = project.roomTypes[0].roomScenes[0].settings.find((setting) => setting.circuitId === "t140-light")!;
  lighting.percentage = text;
  lighting.valueMode = "text";
  const state = await setup(page, project);
  await expect(page.locator("table.cfs-matrix-table thead tr").first()).toContainText("Door Magnet Scene");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: /Open Scene Setting Overlay for.*T140 Arrival/i }).click();
  const target = roomSetting(page);
  await expect(target.getByLabel(/Saved text/)).toHaveText(text, { useInnerText: true });
  await expect(target.getByRole("radio")).toHaveCount(0);
  await expect(target.getByRole("textbox")).toHaveCount(0);
  const onOff = page.locator(".setting-overlay-panel .switch-individual-table tbody tr").filter({ hasText: "OnOff Text load" });
  await expect(onOff.getByRole("radio")).toHaveCount(0);
  await onOff.getByRole("button", { name: "Off", exact: true }).click();
  await page.locator(".setting-overlay-panel").getByRole("button", { name: "Close", exact: true }).click();
  await save(page);
  await page.reload(); await navigate(page);
  const before = JSON.stringify(state.projects);
  const beforeDraft = JSON.stringify(await readNativeDraftProject(page, "scene-text-project"));
  await page.getByRole("button", { name: "Excel Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await expect(page.getByRole("menuitem", { name: "Project (All Tabs)", exact: true })).toHaveAttribute("title", /Unconfirmed Inspection and LowHigh drafts are excluded; confirm them before export/);
  await page.getByRole("menuitem", { name: "Project (All Tabs)", exact: true }).click();
  const output = info.outputPath("project-text-all-tabs.xlsx"); await (await pending).saveAs(output);
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(output);
  const contents: string[] = []; for (const sheet of book.worksheets) sheet.eachRow((row) => row.eachCell((cell) => contents.push(cell.text)));
  expect(contents).toContain(text);
  expect(book.getWorksheet("Project Index")?.getColumn(1).values).toContain("Unvisited Room Rev1.00");
  expect(book.worksheets.some((sheet) => sheet.name.includes("TSTAT"))).toBe(true);
  expect(JSON.stringify(state.projects)).toBe(before);
  expect(JSON.stringify(await readNativeDraftProject(page, "scene-text-project"))).toBe(beforeDraft);
  await page.locator("table.cfs-matrix-table").screenshot({ path: info.outputPath("door-and-text-cfs.png") });
});

test("CFS Inspection uses the standard lighting input and rejects arbitrary text", async ({ page }) => {
  test.setTimeout(120_000);
  const state = await setup(page);
  await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
  await page.getByRole("button", { name: "Start Current Revision", exact: true }).click();
  const cell = page.locator("table.cfs-matrix-table tbody tr").filter({ hasText: "Z1" }).first().getByRole("button", { name: /Edit Inspection value.*T140 Arrival/ });
  await cell.click();
  const popover = page.locator(".cfs-inspection-popover:not(.cfs-low-high-popover)");
  await expect(popover.getByRole("radio")).toHaveCount(0);
  const input = popover.getByRole("textbox", { name: /Inspection value/ });
  await input.fill("not a lighting value");
  await expect(input).toHaveValue("37");
  await input.fill("51");
  await expect(input).toHaveValue("51");
  await popover.getByRole("button", { name: "OK", exact: true }).click();
  await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
  await page.getByRole("dialog", { name: "Finish InspectionMode", exact: true }).getByRole("button", { name: "Finish Current Revision", exact: true }).click();
  await expect.poll(() => (state.projects[0] as unknown as ProjectData).roomTypes[0].roomScenes[0].settings.find((setting) => setting.circuitId === "t140-light")).toMatchObject({ percentage: "51" });
});

test("CFS Area Scene and Switch settings keep saved text visible without a text editor", async ({ page }) => {
  test.setTimeout(120_000);
  const project = fixture();
  const room = project.roomTypes[0];
  room.scenes[0].settings[0] = { circuitId: "t140-light", percentage: text, valueMode: "text" };
  room.roomScenes[0].areaSceneSelections = [{ areaId: project.locations[0].id, sceneId: room.scenes[0].id }];
  room.switches[0].buttonSetting.circuitSettings = [{ circuitId: "t140-light", percentage: "0045", valueMode: "text" }];
  await setup(page, project);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: /Open Scene Setting Overlay for.*T140 Arrival/i }).click();
  await page.locator(".setting-overlay-panel").getByRole("button", { name: "Edit Area Scene definitions", exact: true }).click();
  const areaTarget = page.locator(".setting-overlay-panel table.scene-table tbody tr").filter({ hasText: "T140 Light" });
  await expect(areaTarget.getByLabel(/Saved text/)).toHaveText(text, { useInnerText: true });
  await expect(areaTarget.getByRole("radio")).toHaveCount(0);
  await page.locator(".setting-overlay-panel").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: /Open Switch Setting Overlay for PD-BY \/ By Scene \/ 1/ }).click();
  const switchTarget = roomSetting(page);
  await expect(switchTarget.getByLabel(/Saved text/)).toHaveText("0045");
  await expect(switchTarget.getByRole("radio")).toHaveCount(0);
});

const ccoDetails = ["Sheer Open", "Sheer Close", "Drape Open", "Drape Close"];

function ccoFixture() {
  const project = fixture();
  const room = project.roomTypes[0];
  room.deviceAssignments.push(...ccoDetails.map((detail, index) => ({
    ...createEmptyDeviceAssignment(),
    id: `text-cco-${index + 1}`,
    device: "GCU-HOSP",
    deviceNum: "1",
    area: project.locations[0].id,
    zoneAddress: `CCO${index + 1}`,
    detail,
  })));
  return project;
}

function ccoRow(page: Page, detail: string) {
  return page.locator(".setting-overlay-panel .switch-individual-table tbody tr")
    .filter({ has: page.getByText(detail, { exact: true }) });
}

for (const tab of ["Scene", "Switch"] as const) {
  test(`${tab} uses only standard controls for all four CCO rows`, async ({ page }) => {
    await setup(page, ccoFixture());
    await page.getByRole("tab", { name: tab, exact: true }).click();
    if (tab === "Scene") {
      await page.locator(".room-scene-pms-table tbody tr").first()
        .getByRole("button", { name: "Setting", exact: true }).first().click();
    } else {
      await page.locator(".scene-area-chip").filter({ hasText: /^Palladiom$/ }).click();
      await page.locator("tbody tr").filter({ hasText: "PD-BY" }).first()
        .getByRole("button", { name: "Setting", exact: true }).first().click();
    }
    const panel = page.locator(".setting-overlay-panel");
    await panel.getByRole("button", { name: "Scene Value", exact: true }).click();
    const area = panel.getByRole("button", { name: /^> T140 Area/ });
    if (await area.isVisible()) await area.click();
    for (const [index, detail] of ccoDetails.entries()) {
      const row = ccoRow(page, detail);
      await expect(row.getByText(`CCO${index + 1}`, { exact: true })).toBeVisible();
      await expect(row.getByRole("radio")).toHaveCount(0);
      await expect(row.getByRole("textbox")).toHaveCount(0);
      await expect(row.getByRole("button", { name: "On", exact: true })).toBeEnabled();
      await expect(row.getByRole("button", { name: "Off", exact: true })).toBeEnabled();
    }
    const firstCco = ccoRow(page, ccoDetails[0]);
    await firstCco.getByRole("button", { name: "On", exact: true }).click();
    await expect(firstCco.getByRole("button", { name: "On", exact: true })).toHaveClass(/active/);
  });
}

test("Command tab retains the text toggle on CCO rows", async ({ page }) => {
  await setup(page, ccoFixture());
  await page.getByRole("tab", { name: "Command", exact: true }).click();
  await page.locator("tbody tr").filter({ has: page.locator(".setting-status-button") }).first()
    .getByRole("button", { name: "Setting", exact: true }).first().click();
  const panel = page.locator(".setting-overlay-panel");
  await panel.getByRole("button", { name: "Scene Value", exact: true }).click();
  await panel.getByRole("button", { name: /^> T140 Area/ }).click();
  const row = ccoRow(page, ccoDetails[0]);
  await expect(row.getByRole("radio", { name: "Standard", exact: true })).toBeVisible();
  await row.getByRole("radio", { name: "Text", exact: true }).click();
  await expect(row.getByRole("textbox", { name: /Text value/ })).toBeEnabled();
});

test("Command's own settings retain the text editor", async ({ page }) => {
  test.setTimeout(90_000);
  const project = fixture();
  const command = project.roomTypes[0].switches.find((entry) => entry.kind === "command")!;
  command.buttonSetting.circuitSettings = [{ circuitId: "t140-light", percentage: text, valueMode: "text" }];
  await setup(page, project);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: /Command Setting Overlay for.*T140 Command/ }).first().click();
  await page.locator(".setting-overlay-panel").getByRole("button", { name: "Scene Value", exact: true }).click();
  await page.locator(".setting-overlay-panel").getByRole("button", { name: /^> T140 Area/ }).click();
  const target = roomSetting(page);
  await expect(target.getByRole("radio", { name: "Text", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(target.getByRole("textbox", { name: /Text value/ })).toHaveValue(text);
});
