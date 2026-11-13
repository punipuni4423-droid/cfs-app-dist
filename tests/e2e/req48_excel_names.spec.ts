import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { createEmptyHvacAssignment, createNewRoomType } from "../../app/lib/constants";
import { createNewProject } from "../../app/lib/storage";
import { appendProjectExcelSheets } from "../../app/lib/projectExcelExport";
import { excelExportDatePart, excelRevisionPart, projectExcelFilename, roomTypeExcelFilename, roomTypeIndexLabel, uniqueRoomTypeExcelSheetName } from "../../app/lib/excelExportNames";
import { uniqueExcelSheetName } from "../../app/lib/excelSheetName";

test("RT files and sheet labels include the current revision with an empty fallback", () => {
  const room = { name: "RT-B", revision: " 1.02 " };
  expect(excelRevisionPart(room)).toBe("Rev1.02");
  expect(excelRevisionPart({ revision: "" })).toBe("Rev1.00");
  expect(roomTypeExcelFilename("Sample Hotel", room, "CFS_view")).toBe("Sample_Hotel_RT-B_Rev1.02_CFS_view.xlsx");
  expect(roomTypeExcelFilename("Sample Hotel", room, "TSTAT")).toBe("Sample_Hotel_RT-B_Rev1.02_TSTAT.xlsx");
  expect(roomTypeIndexLabel(room)).toBe("RT-B Rev1.02");
  expect(uniqueRoomTypeExcelSheetName(room, new Set())).toBe("RT-B R1.02");
  expect(uniqueRoomTypeExcelSheetName({ name: "", revision: "" }, new Set(), undefined, "Room 2")).toBe("Room 2 R1.00");
});

test("multi-room filenames use the local export date and retain filename sanitization", () => {
  const date = new Date(2026, 0, 2, 23, 55);
  expect(excelExportDatePart(date)).toBe("20260102");
  expect(projectExcelFilename(" Hotel: North ", "CFS_ALL", date)).toBe("Hotel__North_CFS_ALL_20260102.xlsx");
  expect(projectExcelFilename("Hotel", "Project", date)).toBe("Hotel_Project_20260102.xlsx");
});

test("long RT names keep the R revision and tab suffix even when the sheet names collide", () => {
  const used = new Set<string>();
  const room = { name: "Royal Garden Suite 200m2", revision: "1.01" };
  expect(uniqueRoomTypeExcelSheetName(room, used)).toBe("Royal Garden Suite 200m2 R1.01");
  expect(uniqueRoomTypeExcelSheetName({ ...room, name: room.name + "Extra" }, used)).toBe("Royal Garden Suite 200m2E R1.01");
  expect(uniqueRoomTypeExcelSheetName(room, used, "TSTAT Seasons")).toBe("Royal Gar R1.01 - TSTAT Seasons");
  expect(uniqueRoomTypeExcelSheetName(room, used, "TSTAT Seasons")).toBe("Royal R1.01 - TSTAT Seasons (2)");
  expect(uniqueRoomTypeExcelSheetName({ ...room, name: "Long/Room " + "X".repeat(23) }, used, "TSTAT"))
    .toMatch(/^Long_Room .* R1\.01 - TSTAT$/);
});

test("Remarks room names collide case-insensitively while project Remarks keeps its own sheet", () => {
  const used = new Set<string>();
  expect(uniqueRoomTypeExcelSheetName({ name: "rEmArKs", revision: "1.00" }, used)).toBe("rEmArKs R1.00");
  expect(uniqueRoomTypeExcelSheetName({ name: "Remarks", revision: "1.00" }, used)).toBe("Remarks R1.00 (2)");
  expect(uniqueExcelSheetName("Remarks", "Remarks", used)).toBe("Remarks");
  expect(uniqueExcelSheetName("remarks", "Remarks", used)).toBe("remarks (2)");
});

test("actual Project workbook carries RT Rev through sheets and the Project Index", async () => {
  const project = createNewProject("Sample Hotel");
  const longName = "Royal Garden Suite 200m2";
  project.roomTypes = [
    { ...createNewRoomType("RT-A"), revision: "1.02" },
    { ...createNewRoomType("RT-B"), revision: "" },
    { ...createNewRoomType(longName), revision: "1.01", hvacAssignments: [createEmptyHvacAssignment()] },
  ];
  const workbook = new ExcelJS.Workbook();
  const { index } = appendProjectExcelSheets(workbook, project, {
    devices: [],
    wattPerPdu: 3.3,
    buildCfsModel: () => ({
      visibleBaseColumns: [], visibleFunctionColumns: [], displayedRows: [],
      headerGroups: { switchGroups: [], buttonGroups: [], functionNameGroups: [], conditionGroups: [] },
      mergeInfo: { device: new Map(), dimming: new Map(), designer: new Map(), zone: new Map(), daliGroup: new Map() },
      highlights: { ffe: false, energySaving: false, areaScene: false, individualOverride: false, inspectionMark: false },
      expandedPirHeaderKeys: new Set(),
      resolvers: {
        baseValues: () => [], functionValues: () => [], baseColumnLabel: column => column.label,
        hasChangedBaseCell: () => false, hasChangedFunctionCell: () => false, hasAreaSceneValueCell: () => false,
        hasSceneDifferentOverride: () => false, hasInspectionMarkForCell: () => false, isPriorityTriggerColumn: () => false,
      },
    }),
  });
  expect(index.filter(entry => entry.tab === "CFS")).toEqual([
    expect.objectContaining({ roomType: "RT-A Rev1.02", sheetName: "RT-A R1.02 - CFS" }),
    expect.objectContaining({ roomType: "RT-B Rev1.00", sheetName: "RT-B R1.00 - CFS" }),
    expect.objectContaining({ roomType: longName + " Rev1.01", sheetName: "Royal Garden Suite R1.01 - CFS" }),
  ]);
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(await workbook.xlsx.writeBuffer());
  expect(reloaded.worksheets[0].name).toBe("Project Index");
  expect(reloaded.getWorksheet("RT-A R1.02 - CFS")).toBeDefined();
  expect(reloaded.getWorksheet("RT-B R1.00 - CFS")).toBeDefined();
  expect(reloaded.getWorksheet("Royal Gar R1.01 - TSTAT Seasons")).toBeDefined();
  const seasonsIndex = index.findIndex(entry => entry.roomType === longName + " Rev1.01" && entry.tab === "TSTAT Seasons");
  const indexSheet = reloaded.getWorksheet("Project Index")!;
  expect(seasonsIndex).toBeGreaterThan(-1);
  expect(indexSheet.getCell(seasonsIndex + 5, 1).value).toBe(longName + " Rev1.01");
  expect(indexSheet.getCell(seasonsIndex + 5, 3).hyperlink).toBe("#'Royal Gar R1.01 - TSTAT Seasons'!A1");
});
