import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { programmingNameCharacterCount, programmingNameWarning } from "../../app/lib/programmingNameWarning";
import { appendCfsSheet, type CfsExcelSheetModel } from "../../app/lib/cfsExcelExport";
import { buildCfsZoneRows } from "../../app/lib/useCfsZoneRows";
import { BASE_COLUMNS } from "../../app/lib/cfsTableModel";
import { seed } from "./support/scene-backlight-test-project";

test("Programming Name warning counts resolved Unicode code points and spaces at the 50 boundary", () => {
  for (const length of [0, 49, 50]) expect(programmingNameWarning("A".repeat(length))).toBeUndefined();
  expect(programmingNameWarning("A".repeat(51))).toBe("51 characters — shorten to 50 or fewer.");
  expect(programmingNameCharacterCount("日".repeat(49) + " 😀")).toBe(51);
  expect(programmingNameWarning("日".repeat(49) + "😀")).toBeUndefined();
  expect(programmingNameWarning("日".repeat(50) + "😀")).toBeDefined();
});

test("CFS xlsx colors only overlong Programming Name runs and never appends warning text", async ({}, info) => {
  const project = seed(), roomType = project.roomTypes[0];
  const rows = buildCfsZoneRows({ roomType, circuits: project.circuits, locations: project.locations,
    locationById: new Map(project.locations.map((row) => [row.id, row])), areaAddressByAssignmentCircuit: new Map(), palladiomBySceneTargets: new Map(),
    selectedAreaIds: new Set(project.locations.map((row) => row.id)), hiddenDeviceKeys: new Set(), sortMode: "device" });
  const names = ["A".repeat(50), "日".repeat(50) + "😀"];
  const model: CfsExcelSheetModel = { visibleBaseColumns: BASE_COLUMNS.filter((column) => column.key === "programmingName"), visibleFunctionColumns: [], displayedRows: rows,
    headerGroups: { switchGroups: [], buttonGroups: [], functionNameGroups: [], conditionGroups: [] },
    mergeInfo: { device: new Map(), dimming: new Map(), designer: new Map(), zone: new Map(), daliGroup: new Map() },
    highlights: { ffe: false, energySaving: false, areaScene: false, individualOverride: false, inspectionMark: false }, expandedPirHeaderKeys: new Set(),
    resolvers: { baseValues: () => names, functionValues: () => [], baseColumnLabel: (column) => column.label, hasChangedBaseCell: () => false, hasChangedFunctionCell: () => false,
      hasAreaSceneValueCell: () => false, hasSceneDifferentOverride: () => false, hasInspectionMarkForCell: () => false, isPriorityTriggerColumn: () => false } };
  expect(rows.length).toBeGreaterThan(0);
  const book = new ExcelJS.Workbook(); appendCfsSheet(book, "CFS", model);
  const file = info.outputPath("name-warning.xlsx"); await book.xlsx.writeFile(file);
  const read = new ExcelJS.Workbook(); await read.xlsx.readFile(file);
  const values: ExcelJS.Cell[] = []; read.worksheets[0].eachRow((row) => row.eachCell((cell) => { if (cell.type === ExcelJS.ValueType.RichText) values.push(cell); }));
  expect(values.length).toBeGreaterThan(0);
  const runs = (values[0].value as ExcelJS.CellRichTextValue).richText;
  expect(runs.map((run) => run.text).join("")).toBe(names.join("\n"));
  expect(runs[0].font?.bold).not.toBe(true); expect(runs[2].font?.bold).toBe(true); expect(runs[2].font?.color?.argb?.toUpperCase()).toBe("FFDC2626");
  expect(JSON.stringify(values[0].value)).not.toContain("shorten");
});
