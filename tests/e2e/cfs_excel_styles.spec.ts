import { test, expect } from "./support/safe-test";
import ExcelJS from "exceljs";
import { appendCfsSheet, type CfsExcelSheetModel } from "../../app/lib/cfsExcelExport";
import { BASE_COLUMNS, type CfsZoneRow, type FunctionColumn } from "../../app/lib/cfsTableModel";
import { createEmptyCircuitEntry } from "../../app/lib/constants";
import { buildSceneNameColors } from "../../app/lib/cfsDisplayTextStyle";
import { SCENE_NAME_LINE_PREFIX } from "../../app/lib/cfsValueResolver";

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
      mergeInfo: { device: new Map(), dimming: new Map(), designer: new Map(), zone: new Map(), daliGroup: new Map() },
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

test("CFS Excel preserves line-specific scene colors and Off blue without coloring ordinary labels", async ({}, testInfo) => {
  const circuit = createEmptyCircuitEntry("1");
  const row: CfsZoneRow = { id: "row", orderIndex: 0, device: "Device", deviceNum: "1", zone: "1", group: "", address: "", daliLine: "", isDali: false, location: "Room", locationId: "area", locationColor: "", circuits: [{ id: circuit.id, designerNumber: "1", internalNumber: "1", dimmingType: "PWM", location: "Room", locationId: "area", locationColor: "", areaAddress: "1", detail: "Light", circuit }] };
  const col: FunctionColumn = { id: "function", category: "scene", switchGroupKey: "scene", buttonKey: "scene", switchNumber: "1", switchName: "Scene", button: "1", functionName: "Scene", condition: "", kind: "scene" };
  const palette = buildSceneNameColors([{ name: "Bright" }, { name: "Off" }, { name: " bright " }, { name: "Relax" }]);
  expect([...palette]).toEqual([["bright", "#b45309"], ["relax", "#0f766e"]]);
  const book = new ExcelJS.Workbook();
  const cases = [
    { name: "scenes", values: [`${SCENE_NAME_LINE_PREFIX}Bright`, "100%", `${SCENE_NAME_LINE_PREFIX}Relax`, "0%"], area: true },
    { name: "off-scene", values: [`${SCENE_NAME_LINE_PREFIX}Off`, "Off"], area: true },
    { name: "mixed", values: ["30%", `${SCENE_NAME_LINE_PREFIX}Relax`, "0"], area: true },
    { name: "ordinary", values: ["Bright", "Off duty", "0.5 sec"], area: false },
    { name: "highlight-hidden", values: [`${SCENE_NAME_LINE_PREFIX}Bright`, "0%"], area: false },
    ...["Off", "0%", "0"].map((value, index) => ({ name: `off-${index}`, values: [value], area: false })),
  ];
  for (const item of cases) {
    appendCfsSheet(book, item.name, {
      sceneNameColors: palette, visibleBaseColumns: BASE_COLUMNS.filter((column) => column.key === "detail"), visibleFunctionColumns: [col], displayedRows: [row],
      headerGroups: { switchGroups: [{ ...col, colSpan: 1 }], buttonGroups: [{ ...col, key: col.id, colSpan: 1 }], functionNameGroups: [{ functionName: "Scene", colSpan: 1 }], conditionGroups: [{ condition: "", colSpan: 1, cols: [col] }] },
      mergeInfo: { device: new Map(), dimming: new Map(), designer: new Map(), zone: new Map(), daliGroup: new Map() },
      highlights: { ffe: false, energySaving: false, areaScene: true, individualOverride: false, inspectionMark: false }, expandedPirHeaderKeys: new Set(),
      resolvers: { baseValues: () => ["Off"], functionValues: () => item.values, baseColumnLabel: (column) => column.label, hasChangedBaseCell: () => false, hasChangedFunctionCell: () => false, hasAreaSceneValueCell: () => item.area, hasSceneDifferentOverride: () => false, hasInspectionMarkForCell: () => false, isPriorityTriggerColumn: () => false },
    });
  }
  const file = testInfo.outputPath("text-colors.xlsx");
  await book.xlsx.writeFile(file);
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.readFile(file);
  const runs = (name: string) => (loaded.getWorksheet(name)!.getCell("B5").value as ExcelJS.CellRichTextValue).richText;
  expect(runs("scenes").map((run) => [run.text, run.font?.color?.argb, Boolean(run.font?.bold)])).toEqual([
    ["Bright", "FFB45309", true], ["\n100%", "FF334155", false], ["\nRelax", "FF0F766E", true], ["\n0%", "FF2563EB", false],
  ]);
  expect(runs("off-scene").map((run) => run.font?.color?.argb)).toEqual(["FF2563EB", "FF2563EB"]);
  expect(runs("mixed").map((run) => Boolean(run.font?.bold))).toEqual([false, true, false]);
  expect(runs("highlight-hidden").map((run) => [run.font?.color?.argb, Boolean(run.font?.bold)])).toEqual([["FF334155", false], ["FF2563EB", false]]);
  expect(loaded.getWorksheet("ordinary")!.getCell("B5").value).toBe("Bright\nOff duty\n0.5 sec");
  for (const sheet of loaded.worksheets) {
    expect(sheet.getCell("A5").font.color?.argb).toBe("FF334155");
    expect(sheet.getCell("B5").alignment.wrapText).toBe(true);
    expect(sheet.getCell("B5").border.right?.style).toBe("medium");
    expect(sheet.getCell("A1").master.address).toBe(sheet.getCell("A4").master.address);
    if (sheet.name.startsWith("off-" ) && sheet.name !== "off-scene") {
      expect(sheet.getCell("B5").type).toBe(ExcelJS.ValueType.String);
      expect(sheet.getCell("B5").font.color?.argb).toBe("FF2563EB");
    }
  }
});
