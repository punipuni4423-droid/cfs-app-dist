import { test, expect } from "./support/safe-test";
import ExcelJS from "exceljs";
import type { ProjectData, RoomType } from "../../app/types";
import { createEmptyCircuitEntry, createEmptyDevice, createEmptyDeviceAssignment, createEmptyFixture, createEmptyHvacAssignment, createEmptyLocation, createEmptyRoomScene, createEmptyScene, createEmptySwitchEntry, createNewRoomType } from "../../app/lib/constants";
import { appendProjectExcelSheets } from "../../app/lib/projectExcelExport";
import { appendProjectTables, uniqueProjectExcelSheetName } from "../../app/lib/projectExcelTables";
import { projectPduTables } from "../../app/lib/projectExcelPdu";
import { BASE_COLUMNS, type CfsZoneRow } from "../../app/lib/cfsTableModel";
import type { CfsExcelSheetModel } from "../../app/lib/cfsExcelExport";

function projectFixture(): ProjectData {
  const area = { ...createEmptyLocation(), id: "area", name: "Living", number: "1", code: "L", color: "#aabbcc" };
  const fixture = { ...createEmptyFixture(), fixture: "LED", watt: "8", powerMode: "W" as const, powerFactor: "0.8" };
  const circuit = { ...createEmptyCircuitEntry("1"), id: "circuit-a", designerNumber: "01", internalNumber: "1", dimmingType: "PWM", area: area.id, fixture: fixture.fixture, pcs: "2", detail: "Ceiling" };
  const room = { ...createNewRoomType("A/[Long] Room Type with duplicated prefix abcdefghijk"), id: "room-a", rows: [], circuitIds: [circuit.id] };
  room.scenes = [{ ...createEmptyScene(area.id), id: "area-scene", name: "Relax", settings: [{ circuitId: circuit.id, percentage: "50% when occupied\nOff when vacant", valueMode: "text" }] }];
  room.roomScenes = [
    { ...createEmptyRoomScene(), id: "pms", kind: "pms", sceneType: "From PMS", triggerCondition: "Check In", areaSceneSelections: [{ areaId: area.id, sceneId: "area-scene" }] },
    { ...createEmptyRoomScene(), id: "door", kind: "standard", sceneType: "Welcome", triggerCondition: "Door open", settings: [{ circuitId: circuit.id, percentage: "=SUM(A1:A2)\n@literal", valueMode: "text" }] },
  ];
  room.deviceAssignments = [{ ...createEmptyDeviceAssignment(), id: "a1", device: "Model", deviceNum: "1", deviceGroupId: "g", zoneAddress: "1", circuitNumber: "1" }, { ...createEmptyDeviceAssignment(), id: "a2", device: "Model", deviceNum: "1", deviceGroupId: "g", zoneAddress: "2", circuitNumber: "Reserved" }];
  room.hvacAssignments = [{ ...createEmptyHvacAssignment(), id: "hvac", protocol: "BACnet", thermostatRole: "Master", area: area.id, note: "Day 24°C\nNight 26°C" }];
  room.hvacSeasons = [];
  room.curtainAssignments = [{ id: "curtain", area: area.id, detail: "Drape", action: "Close" }];
  room.dryContacts = [{ id: "dry", area: area.id, circuit: "Door", detail: "Magnet" }];
  room.switches = [
    { ...createEmptySwitchEntry("contact"), id: "switch", switchNumber: "SW1", switchName: "+Literal", buttonFunction: "Scene", condition: "Press", buttonSetting: { sceneId: "", sceneIds: ["area-scene"], circuitSettings: [] } },
    { ...createEmptySwitchEntry("command"), id: "command", switchNumber: "SW1", switchName: "Macro", buttonFunction: "Night", buttonSetting: { sceneId: "", sceneIds: [], circuitSettings: [{ circuitId: circuit.id, percentage: "50\n25", valueMode: "text" }] } },
  ];
  const otherCircuit = { ...circuit, id: "circuit-b", designerNumber: "02", internalNumber: "2", pcs: "3" };
  const otherRoom = { ...createNewRoomType(room.name.toLowerCase()), id: "room-b", rows: [], circuitIds: [otherCircuit.id], scenes: [], roomScenes: [], switches: [], deviceAssignments: [], hvacAssignments: [] };
  return { id: "project", name: "All tabs", updatedAt: "2026-10-27T00:00:00Z", locations: [area], fixtures: [fixture], circuits: [circuit, otherCircuit], roomTypes: [room, otherRoom], remarks: [{ id: "remark", title: "Memo", body: "=literal note", hasTable: true, columns: ["Item", "Value"], rows: [["Condition", "A\nB"]] }] };
}

function cfsModel(room: RoomType): CfsExcelSheetModel {
  const row: CfsZoneRow = { id: `row-${room.id}`, orderIndex: 0, device: room.name, deviceNum: "1", zone: "1", group: "", address: "", daliLine: "", isDali: false, location: "Living", locationId: "area", locationColor: "", circuits: [], assignmentValue: "Saved" };
  return {
    visibleBaseColumns: BASE_COLUMNS.filter((column) => column.key === "detail"), visibleFunctionColumns: [], displayedRows: [row],
    headerGroups: { switchGroups: [], buttonGroups: [], functionNameGroups: [], conditionGroups: [] },
    mergeInfo: { device: new Map(), dimming: new Map(), designer: new Map(), zone: new Map(), daliGroup: new Map() },
    highlights: { ffe: false, energySaving: false, areaScene: false, individualOverride: false, inspectionMark: false }, expandedPirHeaderKeys: new Set(),
    resolvers: { baseValues: () => [room.name], functionValues: () => [], baseColumnLabel: (column) => column.label, hasChangedBaseCell: () => false, hasChangedFunctionCell: () => false, hasAreaSceneValueCell: () => false, hasSceneDifferentOverride: () => false, hasInspectionMarkForCell: () => false, isPriorityTriggerColumn: () => false },
  };
}

function text(cell: ExcelJS.Cell): string {
  return cell.type === ExcelJS.ValueType.RichText ? (cell.value as ExcelJS.CellRichTextValue).richText.map((run) => run.text).join("") : cell.text;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

test("project workbook covers unvisited room types and applicable tabs without mutating its snapshot", async ({}, testInfo) => {
  const snapshot = freeze(projectFixture());
  const before = JSON.stringify(snapshot);
  const calls: string[] = [];
  const workbook = new ExcelJS.Workbook();
  const result = appendProjectExcelSheets(workbook, snapshot, { devices: [], wattPerPdu: 3.3, buildCfsModel: (room) => { calls.push(room.id); return cfsModel(room); } });
  expect(calls).toEqual(["room-a", "room-b"]);
  expect(JSON.stringify(snapshot)).toBe(before);
  expect(workbook.worksheets[0].name).toBe("Project Index");
  const firstRoom = result.index.filter((entry) => entry.roomType === snapshot.roomTypes[0].name + " Rev1.00");
  expect(firstRoom.map((entry) => entry.tab)).toEqual(["PDU", "Circuit", "Dry Contact", "Device Assign", "Curtain", "Area Scene", "Scene", "Door Magnet Scene", "Switch", "Command", "Backlight", "TSTAT", "TSTAT Seasons", "CFS"]);
  expect(firstRoom.every((entry) => entry.status === "Exported")).toBe(true);
  const secondRoom = result.index.filter((entry) => entry.roomType === snapshot.roomTypes[1].name + " Rev1.00");
  expect(secondRoom.find((entry) => entry.tab === "TSTAT")?.note).toContain("No HVAC");
  expect(secondRoom.find((entry) => entry.tab === "Area Scene")?.status).toBe("Not applicable");
  expect(new Set(workbook.worksheets.map((sheet) => sheet.name.toLowerCase())).size).toBe(workbook.worksheets.length);
  expect(workbook.worksheets.every((sheet) => sheet.name.length <= 31 && !/[\[\]:*?\/\\]/.test(sheet.name))).toBe(true);
  const file = testInfo.outputPath("project-all-tabs.xlsx");
  await workbook.xlsx.writeFile(file);
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.readFile(file);
  expect(loaded.worksheets.length).toBe(workbook.worksheets.length);
  const sheet = (tab: string) => loaded.getWorksheet(firstRoom.find((entry) => entry.tab === tab)!.sheetName)!;
  expect(text(sheet("Area Scene").getCell("F3"))).toBe("50% when occupied\nOff when vacant");
  expect(text(sheet("Door Magnet Scene").getCell("F3"))).toContain("=SUM(A1:A2)\n@literal");
  expect(sheet("Door Magnet Scene").getCell("F3").type).not.toBe(ExcelJS.ValueType.Formula);
  expect(text(sheet("Command").getCell("M3"))).toContain("50\n25");
  expect(text(sheet("Switch").getCell("D3"))).toBe("+Literal");
  expect(sheet("Device Assign").getCell("B3").master.address).toBe(sheet("Device Assign").getCell("B4").master.address);
  expect(text(sheet("Circuit").getCell("B3"))).toBe("01");
  expect(text(loaded.getWorksheet(secondRoom.find((entry) => entry.tab === "Circuit")!.sheetName)!.getCell("B3"))).toBe("02");
  expect(sheet("Area Scene").getCell("A1").font.color?.argb).toBe("FFB45309");
  expect(sheet("Area Scene").pageSetup.orientation).toBe("landscape");
  expect(sheet("Area Scene").views[0]).toMatchObject({ state: "frozen", ySplit: 2 });
  expect(loaded.getWorksheet("Project Index")!.getCell("C5").hyperlink).toBe("#'Area'!A1");
});

test("sheet names are safe and unique across reserved names, Unicode, apostrophes and prior sheets", async ({}, testInfo) => {
  const used = new Set<string>();
  const names = ["History", "history", "'", "a".repeat(30) + "😀", "A".repeat(30) + "😀", "A/B:C[D]*E?F\\G", "A\u0000B", "'A'"].map((name) => uniqueProjectExcelSheetName(name, used));
  expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length);
  expect(names.every((name) => name.length <= 31 && !/^[']|[']$|[\uD800-\uDBFF]$|[\x00-\x1f\[\]:*?\/\\]/.test(name))).toBe(true);
  expect(names[0]).toBe("History_");
  const workbook = new ExcelJS.Workbook();
  names.forEach((name) => appendProjectTables(workbook, name, [{ title: "Literal values", headers: ["Text"], rows: [["=1+1"], ["+SUM(A1:A2)"], ["-42"], ["@value"], ["0007"], ["Line1\nOff"], ["Off duty"]] }]));
  const file = testInfo.outputPath("safe-names-and-text.xlsx");
  await workbook.xlsx.writeFile(file);
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.readFile(file);
  for (const sheet of loaded.worksheets) {
    expect(text(sheet.getCell("A3"))).toBe("=1+1"); expect(sheet.getCell("A3").type).toBe(ExcelJS.ValueType.String);
    expect(text(sheet.getCell("A7"))).toBe("0007");
    expect(text(sheet.getCell("A8"))).toBe("Line1\nOff");
    expect((sheet.getCell("A8").value as ExcelJS.CellRichTextValue).richText.at(-1)?.font?.color?.argb).toBe("FF2563EB");
    expect(sheet.getCell("A9").type).toBe(ExcelJS.ValueType.String);
  }
});

test("PDU projection keeps physical keypad counting, Pico kinds and fixture VA correction", async () => {
  const project = projectFixture(); const room = project.roomTypes[0];
  room.switches = [
    { ...createEmptySwitchEntry("lutronPd"), switchNumber: "PD1", switchGroupId: "upper" },
    { ...createEmptySwitchEntry("lutronPd"), switchNumber: "PD1", switchGroupId: "lower" },
    { ...createEmptySwitchEntry("lutronPico"), switchGroupId: "pico1", buttonCount: "Privacy" },
    { ...createEmptySwitchEntry("lutronPico"), switchGroupId: "pico1", buttonCount: "Privacy" },
    { ...createEmptySwitchEntry("lutronPico"), switchGroupId: "pico2", buttonCount: "Corridor" },
  ];
  const devices = [
    { ...createEmptyDevice(), id: "supply", model: "Supply", pdu: "10" },
    { ...createEmptyDevice(), id: "pd", model: "Palladiom", pdu: "-1" },
    { ...createEmptyDevice(), id: "privacy", model: "PrivacyPico", pdu: "-1" },
    { ...createEmptyDevice(), id: "corridor", model: "CorridorPico", pdu: "-1" },
  ];
  room.pduDeviceCounts = [{ deviceId: "supply", quantity: 2 }];
  const tables = projectPduTables(room, devices, project.fixtures, [project.circuits[0]], 3.3);
  expect(tables[0].rows.map((row) => [row[0], row[2]])).toEqual([["Supply", 2], ["Palladiom", 1], ["PrivacyPico", 1], ["CorridorPico", 1]]);
  expect(tables[1].rows[0]).toEqual(["LED", 10, 2, 20]);
  expect(tables[2].rows.find((row) => row[0] === "Total PDU")?.[1]).toBe(17);
  expect(tables[2].rows.find((row) => row[0] === "Combined Total VA")?.[1]).toBe(29.9);
});

test("long multiline settings retain text and readable row heights without overlapping group merges", async ({}, testInfo) => {
  const value = Array.from({ length: 60 }, (_, index) => `Condition ${index + 1}: 50%`).join("\n");
  const workbook = new ExcelJS.Workbook();
  appendProjectTables(workbook, "Long Text", [
    { title: "First section", headers: ["Device", "Value"], widths: [18, 40], rows: [["Device A", value], ["Device A", "Off"]], groupKeys: ["g", "g"], mergeColumns: [1] },
    { title: "Next section", headers: ["Text"], rows: [["=literal"]] },
  ]);
  const file = testInfo.outputPath("long-text.xlsx"); await workbook.xlsx.writeFile(file);
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.readFile(file);
  const sheet = loaded.getWorksheet("Long Text")!;
  expect(text(sheet.getCell("B3"))).toBe(value);
  expect(sheet.getCell("B3").master.address).toBe(sheet.getCell("B5").master.address);
  expect(sheet.getCell("A3").master.address).toBe(sheet.getCell("A6").master.address);
  expect(text(sheet.getCell("B6"))).toBe("Off");
  expect(text(sheet.getCell("A9"))).toBe("Next section");
  sheet.eachRow((row) => expect(row.height ?? 0).toBeLessThanOrEqual(409));
});

test("project sheets use HVAC metric units while preserving Text and standard lighting values", async ({}, testInfo) => {
  const snapshot = projectFixture();
  const room = snapshot.roomTypes[0];
  snapshot.roomTypes = [room];
  const switchCircuit = { ...snapshot.circuits[0], id: "onoff", internalNumber: "3", designerNumber: "03", dimmingType: "On/Off", detail: "Relay" };
  snapshot.circuits.push(switchCircuit);
  room.circuitIds!.push(switchCircuit.id);
  const standardSettings = [
    { circuitId: "hvac:hvac:Setpoint", percentage: "24" },
    { circuitId: "hvac:hvac:Drift", percentage: "2" },
    { circuitId: "hvac:hvac:On/Off", percentage: "Off" },
    { circuitId: "circuit-a", percentage: "50" },
    { circuitId: "onoff", percentage: "Off" },
  ];
  const textSettings = [
    { circuitId: "hvac:hvac:Setpoint", percentage: "24\n26", valueMode: "text" as const },
    { circuitId: "hvac:hvac:Drift", percentage: "2", valueMode: "text" as const },
    { circuitId: "circuit-a", percentage: "50", valueMode: "text" as const },
  ];
  room.scenes[0].settings = standardSettings;
  room.roomScenes[0].settings = standardSettings;
  room.roomScenes[1].settings = textSettings;
  room.switches[0].buttonSetting.circuitSettings = standardSettings;
  room.switches[1].buttonSetting.circuitSettings = textSettings;
  const before = JSON.stringify(freeze(snapshot));
  const book = new ExcelJS.Workbook();
  const result = appendProjectExcelSheets(book, snapshot, { devices: [], wattPerPdu: 3.3, buildCfsModel: cfsModel });
  const file = testInfo.outputPath("hvac-metric-and-text.xlsx"); await book.xlsx.writeFile(file);
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.readFile(file);
  const sheet = (tab: string) => loaded.getWorksheet(result.index.find((entry) => entry.roomType === `${room.name} Rev1.00` && entry.tab === tab)!.sheetName)!;
  const values = (tab: string) => {
    const found: string[] = [];
    sheet(tab).eachRow((row) => row.eachCell((cell) => found.push(text(cell))));
    return found;
  };
  expect(values("Area Scene")).toContain("24°C");
  expect(values("Area Scene")).toContain("2°C");
  expect(values("Area Scene")).toContain("50%");
  expect(values("Area Scene")).toContain("Off");
  for (const tab of ["Scene", "Switch"]) {
    const combined = values(tab).join("\n");
    expect(combined).toContain("Setpoint\n24°C");
    expect(combined).toContain("Drift\n2°C");
    expect(combined).toContain("Ceiling\n50%");
    expect(combined).not.toContain("24%"); expect(combined).not.toContain("Drift\n2%");
  }
  for (const tab of ["Door Magnet Scene", "Command"]) {
    const combined = values(tab).join("\n");
    expect(combined).toContain("Setpoint\n24\n26");
    expect(combined).toContain("Drift\n2");
    expect(combined).toContain("Ceiling\n50");
    expect(combined).not.toContain("24°C"); expect(combined).not.toContain("50%");
  }
  expect(JSON.stringify(snapshot)).toBe(before);
});

test("project Device Assign distinguishes DALI line 1 and 2 within each complete device group", async ({}, testInfo) => {
  const snapshot = projectFixture(); const room = snapshot.roomTypes[0]; snapshot.roomTypes = [room];
  const dali = (group: string, index: number) => ({ ...createEmptyDeviceAssignment(), id: `${group}-${index}`, deviceGroupId: group, device: "QSN2-2DALUNV-D", deviceNum: group === "A" ? "1" : "2", zoneAddress: String(index % 64 + 1), circuitNumber: "Reserved", detail: `${group}-${index + 1}` });
  const fixed = (name: string) => ({ ...createEmptyDeviceAssignment(), id: name, deviceGroupId: "A", device: "Fixed Model", deviceNum: "3", zoneAddress: "1", circuitNumber: "Reserved", detail: name });
  const groupA = Array.from({ length: 128 }, (_, index) => dali("A", index));
  const groupB = Array.from({ length: 65 }, (_, index) => dali("B", index));
  room.deviceAssignments = [fixed("Fixed first"), ...groupA.slice(0, 64), fixed("Fixed middle"), groupB[0], ...groupA.slice(64), ...groupB.slice(1), fixed("Fixed last"), { ...dali("ungrouped", 0), deviceGroupId: "", detail: "Ungrouped DALI" }];
  const devices = [{ ...createEmptyDevice(), model: "QSN2-2DALUNV-D", addressMode: "dali" as const }, { ...createEmptyDevice(), model: "Fixed Model", addressMode: "fixed" as const }];
  const before = JSON.stringify(freeze(snapshot));
  const book = new ExcelJS.Workbook();
  const result = appendProjectExcelSheets(book, snapshot, { devices, wattPerPdu: 3.3, buildCfsModel: cfsModel });
  const file = testInfo.outputPath("dali-line-groups.xlsx"); await book.xlsx.writeFile(file);
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.readFile(file);
  const sheet = loaded.getWorksheet(result.index.find((entry) => entry.tab === "Device Assign")!.sheetName)!;
  const headers = Array.from({ length: sheet.columnCount }, (_, index) => sheet.getCell(2, index + 1).text);
  expect(headers.indexOf("LINE")).toBeGreaterThan(0);
  const column = (name: string) => headers.indexOf(name) + 1;
  const byDetail = new Map<string, ExcelJS.Row>();
  sheet.eachRow((row) => byDetail.set(text(row.getCell(column("Detail"))), row));
  for (const [label, line] of [["A-1", "1"], ["A-65", "2"], ["B-1", "1"], ["B-65", "2"]]) {
    const row = byDetail.get(label)!;
    expect(text(row.getCell(column("LINE"))), label).toBe(line);
    expect(text(row.getCell(column("Zone / Address"))), label).toBe("1");
  }
  expect(text(byDetail.get("A-64")!.getCell(column("LINE")))).toBe("1");
  expect(text(byDetail.get("A-128")!.getCell(column("LINE")))).toBe("2");
  for (const label of ["Fixed first", "Fixed middle", "Fixed last", "Ungrouped DALI"]) expect(text(byDetail.get(label)!.getCell(column("LINE"))), label).toBe("");
  expect(JSON.stringify(snapshot)).toBe(before);
});
