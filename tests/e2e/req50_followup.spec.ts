import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { groupCfsBacklightRows } from "../../app/lib/cfsBacklightRows";
import { appendCfsSheet } from "../../app/lib/cfsExcelExport";
import { BASE_COLUMNS, type FunctionColumn } from "../../app/lib/cfsTableModel";
import { createEmptyHvacAssignment, createEmptySwitchEntry, createNewRoomType, normalizeBacklightLevels } from "../../app/lib/constants";
import { roomTypeExcelFilename } from "../../app/lib/excelExportNames";
import { appendBacklightExcelSheet } from "../../app/lib/projectExcelExport";
import { deriveTstatOccupancy, isActiveTstatControl, thermostatCollectionRows } from "../../app/lib/tstatOccupancy";
import { buildCfsZoneRows } from "../../app/lib/useCfsZoneRows";
import type { RoomType, SwitchEntry } from "../../app/types";

function palladiom(number: string): SwitchEntry {
  return { ...createEmptySwitchEntry("lutronPd"), id: number, switchGroupId: number, switchNumber: number, switchName: `Panel for ${number}` };
}

function zoneRows(roomType: RoomType, targets: SwitchEntry[] = []) {
  return buildCfsZoneRows({
    roomType,
    circuits: [], locations: [], locationById: new Map(), areaAddressByAssignmentCircuit: new Map(),
    palladiomBySceneTargets: new Map(targets.map(target => [target.id, target])),
    selectedAreaIds: new Set(), hiddenDeviceKeys: new Set(), sortMode: "device",
  });
}

test("Backlight Excel rows put their own switch numbers under the heading", async () => {
  const room = createNewRoomType("RT-A");
  const targets = ["PD-10", "PD-2", "PD-1"].map(palladiom);
  room.switches = [...targets, {
    ...createEmptySwitchEntry("command"), id: "source", switchNumber: "CMD",
    backlightTarget: "PD-1,PD-2,PD-10,PD-1", backlightCondition: "relax",
  }];
  const rows = zoneRows(room, targets).filter(row => row.isBacklight);
  const before = JSON.stringify(rows);
  expect(rows.map(row => row.id).sort()).toEqual(["backlight:PD-1", "backlight:PD-10", "backlight:PD-2"]);
  const source = room.switches.at(-1)!;
  const column: FunctionColumn = {
    id: "source", category: "command", switchGroupKey: "CMD", buttonKey: "1", switchNumber: "CMD",
    switchName: "", button: "1", functionName: "", condition: "", kind: "command", source,
  };
  const grouped = groupCfsBacklightRows(rows, [column], room);
  expect(grouped).toHaveLength(1);
  expect(grouped[0].backlightTargetLabel).toBe("PD-1, PD-2, PD-10");
  expect(grouped[0].backlightMemberRowIds).toEqual(rows.map(row => row.id));
  const hidden: FunctionColumn = { ...column, id: "hidden", source: { ...source, backlightTarget: "PD-10", backlightCondition: "sleep" } };
  const split = groupCfsBacklightRows(rows, [column, hidden], room);
  expect(split.map(row => row.backlightTargetLabel).sort())
    .toEqual(["PD-1, PD-2", "PD-10"]);
  expect(groupCfsBacklightRows(rows, [{ ...column, source: { ...source, backlightCondition: "Unknown level" } }], room)).toHaveLength(3);
  const duplicateNameSource = { ...source, backlightCondition: "Dusk" };
  const duplicateNameRoom = { ...room, backlightLevels: normalizeBacklightLevels([
    { key: "custom-a", name: "Dusk", active: "50" },
    { key: "custom-b", name: "Dusk", active: "70" },
  ]) };
  expect(groupCfsBacklightRows(rows, [{ ...column, source: duplicateNameSource }], duplicateNameRoom)).toHaveLength(3);
  expect(groupCfsBacklightRows(rows, [{ ...column, source: { ...source, backlightCondition: "custom-a" } }], duplicateNameRoom)).toHaveLength(1);
  expect(JSON.stringify(rows)).toBe(before);
  const workbook = new ExcelJS.Workbook();
  const model: Parameters<typeof appendCfsSheet>[2] = {
    visibleBaseColumns: BASE_COLUMNS, visibleFunctionColumns: [], displayedRows: split,
    headerGroups: { switchGroups: [], buttonGroups: [], functionNameGroups: [], conditionGroups: [] },
    mergeInfo: {
      device: new Map(), dimming: new Map(), designer: new Map(), zone: new Map(), daliGroup: new Map(),
    },
    highlights: { ffe: false, energySaving: false, areaScene: false, individualOverride: false, inspectionMark: false },
    expandedPirHeaderKeys: new Set(),
    resolvers: {
      baseValues: (row, key) => key === "detail" ? [row.circuits[0].detail] : [], functionValues: () => [], baseColumnLabel: column => column.label,
      hasChangedBaseCell: () => false, hasChangedFunctionCell: () => false, hasAreaSceneValueCell: () => false,
      hasSceneDifferentOverride: () => false, hasInspectionMarkForCell: () => false, isPriorityTriggerColumn: () => false,
    },
  };
  appendCfsSheet(workbook, "CFS", model);
  const longNumbers = Array.from({ length: 12 }, (_, index) => `PD-${index + 1}`).join(", ");
  appendCfsSheet(workbook, "Narrow", {
    ...model,
    visibleBaseColumns: BASE_COLUMNS.filter(column => ["number", "device", "detail"].includes(column.key)),
    displayedRows: [{ ...grouped[0], backlightTargetLabel: longNumbers }],
  });
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = reopened.getWorksheet("CFS")!;
  const device = BASE_COLUMNS.findIndex(column => column.key === "device") + 1;
  const detail = BASE_COLUMNS.findIndex(column => column.key === "detail") + 1;
  expect(sheet.getCell(5, device).value).toBe("Backlight Logic\nPD-1, PD-2");
  expect(sheet.getCell(6, device).value).toBe("Backlight Logic\nPD-10");
  for (const row of [5, 6]) {
    expect(sheet.getCell(row, detail - 1).master.address).toBe(sheet.getCell(row, device).address);
    expect(sheet.getCell(row, device).alignment.wrapText).toBe(true);
    expect(sheet.getCell(row, detail).value).toBe("-");
    expect(sheet.getRow(row).height).toBeGreaterThan(31);
  }
  expect(sheet.rowCount).toBe(6);
  const narrow = reopened.getWorksheet("Narrow")!;
  expect(narrow.getCell("B5").value).toBe(`Backlight Logic\n${longNumbers}`);
  expect(narrow.getCell("B5").alignment.wrapText).toBe(true);
  expect(narrow.getRow(5).height).toBeGreaterThan(sheet.getRow(5).height!);
});

test("the Backlight workbook round-trips edited levels and one assignment per switch group", async () => {
  const room = { ...createNewRoomType("RT-A"), revision: "1.05" };
  room.backlightLevels = normalizeBacklightLevels([{ key: "base", name: "Evening Base", mode: "Manual", active: "55", inactive: "15" }]);
  const first = palladiom("PD-1");
  const second = { ...palladiom("PD-2"), backlightAssignment: "base" };
  room.switches = [first, { ...first, id: "function-two" }, second, createEmptySwitchEntry("lutronPico")];
  const before = JSON.stringify(room);
  const workbook = new ExcelJS.Workbook();
  appendBacklightExcelSheet(workbook, room);
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = reloaded.getWorksheet("Backlight")!;
  expect(sheet.getCell("A1").value).toBe("Backlight Scenes");
  expect(sheet.getRow(3).values).toEqual([undefined, 1, "Evening Base", "Manual", "55", "15"]);
  expect(sheet.getColumn(2).values.filter(value => value === "PD-1")).toHaveLength(1);
  const switchRows: string[][] = [];
  sheet.eachRow(row => {
    if (row.getCell(2).text.startsWith("PD-")) switchRows.push([row.getCell(2).text, row.getCell(4).text]);
  });
  expect(switchRows).toEqual([["PD-1", "By Scene"], ["PD-2", "Evening Base"]]);
  expect(roomTypeExcelFilename("Sample Hotel", room, "Backlight")).toBe("Sample_Hotel_RT-A_Rev1.05_Backlight.xlsx");
  expect(JSON.stringify(room)).toBe(before);
});

test("Thermostat Collection ignores two orphan TH1 entries without changing the saved room", () => {
  const room = createNewRoomType("RT-A");
  const legacy = { ...createEmptySwitchEntry("tstat"), id: "legacy", switchNumber: "TH-1", switchName: "Thermostat rta", condition: "Keep legacy" };
  const removed = {
    ...createEmptySwitchEntry("tstat"), id: "removed", switchNumber: "TH1", switchName: "Sample Bedroom",
    tstatBinding: { areaId: "old-area", assignmentIds: ["removed-device"] },
  };
  room.switches = [legacy, removed];
  expect(thermostatCollectionRows(deriveTstatOccupancy(room).switches, [])).toEqual([]);
  room.hvacAssignments = [2, 3, 4].map(thermostatNumber => ({
    ...createEmptyHvacAssignment(), id: `physical-${thermostatNumber}`, thermostatNumber, area: "",
  }));
  const before = JSON.stringify(room);
  const derived = deriveTstatOccupancy(room);
  const collection = thermostatCollectionRows(derived.switches, room.hvacAssignments);
  expect(collection.map(row => row.switchNumber)).toEqual(["TH2", "TH3", "TH4"]);
  expect(derived.switches).toEqual(expect.arrayContaining([legacy, removed]));
  expect(JSON.stringify(room)).toBe(before);
});

test("a registered unassigned Thermostat has physical rows, and its control requires an Area", () => {
  const room = createNewRoomType("Room");
  expect(zoneRows(room).filter(row => row.isHvac)).toEqual([]);
  room.hvacAssignments = [{ ...createEmptyHvacAssignment(), id: "unit", area: "" }];
  expect(zoneRows(room).filter(row => row.isHvac).map(row => [row.location, row.hvacMetric])).toEqual([
    ["Other", "On/Off"], ["Other", "Setpoint"], ["Other", "Fan Mode"], ["Other", "Drift"],
  ]);
  const unassigned = deriveTstatOccupancy(room).switches;
  expect(thermostatCollectionRows(unassigned, room.hvacAssignments)).toHaveLength(1);
  expect(isActiveTstatControl(unassigned[0], room.hvacAssignments, unassigned)).toBe(false);
  room.hvacAssignments[0].area = "area";
  const assigned = deriveTstatOccupancy(room).switches;
  expect(isActiveTstatControl(assigned[0], room.hvacAssignments, assigned)).toBe(true);
});
