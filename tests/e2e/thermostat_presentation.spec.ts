import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { createEmptyHvacAssignment, createEmptyLocation, createNewRoomType } from "../../app/lib/constants";
import { buildCfsZoneRows } from "../../app/lib/useCfsZoneRows";
import { BASE_COLUMNS, buildThermostatAreaMergeInfo, cfsDeviceFilterKey } from "../../app/lib/cfsTableModel";
import type { CfsZoneRow } from "../../app/lib/cfsTableModel";
import { appendCfsSheet, type CfsExcelSheetModel } from "../../app/lib/cfsExcelExport";
import { updateTstatRegistration } from "../../app/lib/tstatOccupancy";

function fixture(hiddenDeviceKeys = new Set<string>()) {
  const area = { ...createEmptyLocation(), id: "area", name: "Shared Area" };
  const roomType = updateTstatRegistration(createNewRoomType("Room"), [
    { ...createEmptyHvacAssignment(), id: "physical-master", area: area.id },
    { ...createEmptyHvacAssignment(), id: "physical-slave", area: area.id, thermostatRole: "Slave", masterAssignmentId: "physical-master" },
  ]);
  return buildCfsZoneRows({ roomType, circuits: [], locations: [area], locationById: new Map([[area.id, area]]),
    areaAddressByAssignmentCircuit: new Map(), palladiomBySceneTargets: new Map(), selectedAreaIds: new Set([area.id]), hiddenDeviceKeys, sortMode: "device" });
}

test("Thermostat Area merges per physical stable assignment, not shared Area, and old filter keys still work", () => {
  const rows = fixture(); expect(rows).toHaveLength(8);
  const map = buildThermostatAreaMergeInfo(rows);
  expect(map.get(rows[0].id)).toEqual({ isFirst: true, rowSpan: 4 });
  expect(map.get(rows[4].id)).toEqual({ isFirst: true, rowSpan: 4 });
  expect([...map.values()].filter((item) => item.isFirst)).toHaveLength(2);
  expect(cfsDeviceFilterKey(rows[0])).toBe("HVAC\u00001");
  expect(fixture(new Set(["HVAC\u00001"]))).toHaveLength(4);
  expect(fixture(new Set(["HVAC\u00001"])).every((row) => row.circuits[0].circuit.circuitGroupId === "physical-slave")).toBe(true);
  expect(buildThermostatAreaMergeInfo([rows[0], rows[2]]).get(rows[0].id)?.rowSpan).toBe(2);
});

test("lighting, another physical Thermostat and interrupted sections never merge together", () => {
  const rows = fixture();
  const lighting: CfsZoneRow = { ...rows[0], id: "lighting", isHvac: false, device: "Thermostat" };
  const map = buildThermostatAreaMergeInfo([rows[0], lighting, rows[1], rows[4]]);
  for (const row of [rows[0], lighting, rows[1], rows[4]]) expect(map.get(row.id)).toEqual({ isFirst: true, rowSpan: 1 });
  const unknown = { ...rows[0], id: "unknown", circuits: [] };
  expect(buildThermostatAreaMergeInfo([unknown, { ...unknown, id: "unknown-2" }]).get(unknown.id)?.rowSpan).toBe(1);
});

test("actual xlsx uses the same physical Area merges and keeps name red-bold without comments or changed values", async ({}, info) => {
  const rows = fixture(), columns = BASE_COLUMNS.filter((column) => ["device", "area", "detail", "programmingName"].includes(column.key));
  const longName = "日".repeat(50) + "😀";
  const model: CfsExcelSheetModel = { visibleBaseColumns: columns, visibleFunctionColumns: [], displayedRows: rows,
    headerGroups: { switchGroups: [], buttonGroups: [], functionNameGroups: [], conditionGroups: [] },
    mergeInfo: { device: new Map(), dimming: new Map(), designer: new Map(), zone: new Map(), daliGroup: new Map() },
    highlights: { ffe: false, energySaving: false, areaScene: false, individualOverride: false, inspectionMark: false }, expandedPirHeaderKeys: new Set(),
    resolvers: { baseValues: (row, key) => key === "area" ? [row.location] : key === "device" ? [row.device] : key === "detail" ? [row.hvacMetric ?? ""] : [longName],
      functionValues: () => [], baseColumnLabel: (column) => column.label, hasChangedBaseCell: () => false, hasChangedFunctionCell: () => false,
      hasAreaSceneValueCell: () => false, hasSceneDifferentOverride: () => false, hasInspectionMarkForCell: () => false, isPriorityTriggerColumn: () => false } };
  const book = new ExcelJS.Workbook(); appendCfsSheet(book, "CFS", model);
  const file = info.outputPath("thermostat-area.xlsx"); await book.xlsx.writeFile(file);
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.readFile(file); const sheet = loaded.worksheets[0];
  expect(sheet.model.merges).toContain("B5:B8"); expect(sheet.model.merges).toContain("B9:B12");
  expect(sheet.getCell("A5").value).toBe("Thermostat"); expect(sheet.getCell("B5").value).toBe("Shared Area");
  const name = sheet.getCell("D5"); expect(name.text).toBe(longName); expect(name.note).toBeUndefined();
  const runs = (name.value as ExcelJS.CellRichTextValue).richText; expect(runs[0].font?.bold).toBe(true);
  expect(runs[0].font?.color?.argb?.toUpperCase()).toBe("FFDC2626"); expect(name.text).not.toContain("shorten");
});
