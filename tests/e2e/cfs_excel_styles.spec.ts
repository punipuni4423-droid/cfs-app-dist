import { test, expect } from "./support/safe-test";
import ExcelJS from "exceljs";
import { appendCfsSheet, type CfsExcelSheetModel } from "../../app/lib/cfsExcelExport";
import { BASE_COLUMNS, type CfsZoneRow, type FunctionColumn } from "../../app/lib/cfsTableModel";
import { createEmptyCircuitEntry } from "../../app/lib/constants";

test("CFS Excel matches column exclusions and overlapping highlight priority", async ({}, testInfo) => {
  const circuit = { ...createEmptyCircuitEntry("1"), ffe: true, energySaving: true };
  const row: CfsZoneRow = { id: "row", orderIndex: 0, device: "Device", deviceNum: "1", zone: "1", group: "", address: "", daliLine: "", isDali: false, location: "Room", locationId: "area", locationColor: "", circuits: [{ id: circuit.id, designerNumber: "1", internalNumber: "1", dimmingType: "PWM", location: "Room", locationId: "area", locationColor: "", areaAddress: "1", detail: "Light", circuit }] };
  const col: FunctionColumn = { id: "function", category: "scene", switchGroupKey: "scene", buttonKey: "scene", switchNumber: "1", switchName: "Scene", button: "1", functionName: "Scene", condition: "", kind: "scene" };
  const book = new ExcelJS.Workbook();
  for (const variant of ["ffe", "energy", "both", "reserved", "inspection", "row-inspection", "area-inspection", "changed-inspection", "override-inspection", "changed-base"] as const) {
    const base = BASE_COLUMNS.filter((column) => ["number", "device", "deviceNum", "dimmingType", "designerNumber"].includes(column.key));
    const model: CfsExcelSheetModel = {
      visibleBaseColumns: base, visibleFunctionColumns: [col], displayedRows: [variant === "reserved" ? { ...row, circuits: [] } : row],
      headerGroups: { switchGroups: [{ ...col, colSpan: 1 }], buttonGroups: [{ ...col, key: col.id, colSpan: 1 }], functionNameGroups: [{ functionName: "Scene", colSpan: 1 }], conditionGroups: [{ condition: "", colSpan: 1, cols: [col] }] },
      mergeInfo: { device: new Map(), dimming: new Map(), designer: new Map(), zone: new Map(), daliGroup: new Map(), backlight: new Map() },
      highlights: { ffe: ["ffe", "both", "row-inspection", "changed-base"].includes(variant), energySaving: ["energy", "both"].includes(variant), areaScene: true, individualOverride: true, inspectionMark: true }, expandedPirHeaderKeys: new Set(),
      resolvers: { baseValues: () => ["1"], functionValues: () => ["50%"], baseColumnLabel: (column) => column.label, hasChangedBaseCell: () => variant === "changed-base", hasChangedFunctionCell: () => variant === "changed-inspection" || variant === "override-inspection", hasAreaSceneValueCell: () => variant === "area-inspection", hasSceneDifferentOverride: () => variant === "override-inspection", hasInspectionMarkForCell: () => variant.includes("inspection"), isPriorityTriggerColumn: () => false },
    };
    appendCfsSheet(book, variant, model);
  }
  const file = testInfo.outputPath("highlight-cases.xlsx");
  await book.xlsx.writeFile(file);
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.readFile(file);
  const expected: Record<string, string> = { ffe: "FFE0F2FE", energy: "FFDCFCE7", both: "FFDBEAFE", reserved: "FFC4C9CF", inspection: "FFEEF6FF", "row-inspection": "FFE0F2FE", "area-inspection": "FFF3E8FF", "changed-inspection": "FFFFF3B0", "override-inspection": "FFFDE047" };
  const fill = (cell: ExcelJS.Cell) => cell.fill.type === "pattern" ? cell.fill.fgColor?.argb : undefined;
  for (const sheet of loaded.worksheets) {
    for (let column = 1; column <= 4; column += 1) {
      expect.soft(fill(sheet.getCell(5, column)), `${sheet.name}/excluded ${column}`).toBe(sheet.name === "changed-base" && column > 1 ? "FFFFF3B0" : undefined);
    }
    if (expected[sheet.name]) expect.soft(fill(sheet.getCell("F5")), sheet.name).toBe(expected[sheet.name]);
    if (["ffe", "energy", "both", "reserved"].includes(sheet.name)) expect.soft(fill(sheet.getCell("E5"))).toBe(expected[sheet.name]);
    expect(sheet.getCell("F5").border.right?.style).toBe("medium");
    expect(sheet.getCell("A1").master.address).toBe(sheet.getCell("A4").master.address);
  }
});
