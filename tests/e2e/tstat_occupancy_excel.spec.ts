import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { createEmptyHvacAssignment, createEmptySwitchEntry, createNewRoomType } from "../../app/lib/constants";
import { createNewProject } from "../../app/lib/storage";
import { updateTstatRegistration } from "../../app/lib/tstatOccupancy";
import { appendProjectExcelSheets } from "../../app/lib/projectExcelExport";
import { BASE_COLUMNS } from "../../app/lib/cfsTableModel";
import type { CfsExcelSheetModel } from "../../app/lib/cfsExcelExport";

test("Project xlsx resolves TH command IDs, retains legacy labels and excludes unresolved internal IDs", async ({}, info) => {
  const project = createNewProject("TH workbook");
  const room = updateTstatRegistration(createNewRoomType("TH Room"), [{ ...createEmptyHvacAssignment(), area: project.locations[0].id }]);
  const group = room.switches[0].switchGroupId;
  room.switches.push({ ...createEmptySwitchEntry("command"), switchNumber: group, switchName: "Known TH command" });
  room.switches.push({ ...createEmptySwitchEntry("command"), switchNumber: "tstat-control:missing", switchName: "Missing TH command" });
  room.switches.push({ ...createEmptySwitchEntry("command"), switchNumber: "SW1", switchName: "Legacy command" });
  project.roomTypes = [room]; const before = JSON.stringify(project);
  const model: CfsExcelSheetModel = {
    visibleBaseColumns: BASE_COLUMNS.filter((column) => column.key === "detail"), visibleFunctionColumns: [], displayedRows: [],
    headerGroups: { switchGroups: [], buttonGroups: [], functionNameGroups: [], conditionGroups: [] },
    mergeInfo: { device: new Map(), dimming: new Map(), designer: new Map(), zone: new Map(), daliGroup: new Map() },
    highlights: { ffe: false, energySaving: false, areaScene: false, individualOverride: false, inspectionMark: false }, expandedPirHeaderKeys: new Set(),
    resolvers: { baseValues: () => [], functionValues: () => [], baseColumnLabel: (column) => column.label, hasChangedBaseCell: () => false, hasChangedFunctionCell: () => false, hasAreaSceneValueCell: () => false, hasSceneDifferentOverride: () => false, hasInspectionMarkForCell: () => false, isPriorityTriggerColumn: () => false },
  };
  const book = new ExcelJS.Workbook(); appendProjectExcelSheets(book, project, { devices: [], wattPerPdu: 3.3, buildCfsModel: () => model });
  const output = info.outputPath("th-command-project.xlsx"); await book.xlsx.writeFile(output);
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.readFile(output);
  const text: string[] = []; for (const sheet of loaded.worksheets) sheet.eachRow((row) => row.eachCell((cell) => text.push(cell.text)));
  expect(text).toContain("TH1"); expect(text).toContain("SW1"); expect(text).toContain("Unresolved control");
  expect(text.some((value) => value.includes("tstat-control:"))).toBe(false);
  expect(text).not.toContain(group); expect(JSON.stringify(project)).toBe(before);
});
