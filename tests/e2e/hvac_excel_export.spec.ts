import ExcelJS from "exceljs";
import { test, expect } from "./support/safe-test";
import { appendHvacSheets, type HvacExcelSnapshot } from "../../app/lib/hvacExcelExport";
import { createEmptyHvacAssignment } from "../../app/lib/constants";

test("TSTAT Excel preserves assignment order, typed values, seasons and literal long notes", async ({}, testInfo) => {
  const longNote = "@Literal note\n" + "長い注記を保持する ".repeat(220);
  const snapshot: HvacExcelSnapshot = {
    locations: [{ id: "bedroom", name: "Bedroom", number: "1", code: "BR", color: "#ffffff" }],
    assignments: [
      { ...createEmptyHvacAssignment(), id: "master", protocol: "BACnet", thermostatRole: "Master", area: "bedroom", lowEnd: "18", highEnd: "30", summerWinterChange: true, note: "=1+1\nKeep as text" },
      { ...createEmptyHvacAssignment(), id: "slave", protocol: "FCU", thermostatRole: "Slave", area: "", lowEnd: "20", highEnd: "28", summerWinterChange: false, note: longNote },
    ],
    seasons: [{ id: "custom", name: "=Should remain a label", startMonth: "4", startDay: "15", endMonth: "11", endDay: "5" }],
  };
  const before = JSON.stringify(snapshot);
  const book = new ExcelJS.Workbook();
  const sheets = appendHvacSheets(book, snapshot, { assignments: "Room TSTAT", seasons: "Room TSTAT Seasons" });
  expect(sheets.map((sheet) => sheet.name)).toEqual(["Room TSTAT", "Room TSTAT Seasons"]);
  const file = testInfo.outputPath("tstat.xlsx");
  await book.xlsx.writeFile(file);
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.readFile(file);
  const [assignments, seasons] = loaded.worksheets;
  expect(assignments.getRow(1).values).toEqual([undefined, "No", "Control Type", "Master / Slave", "Area", "Low End", "High End", "Summer / Winter", "Note", "Reference Master"]);
  expect(assignments.getRow(2).values).toEqual([undefined, "TH1", "BACnet", "Master", "Bedroom", "18 C", "30 C", "Enabled", "=1+1\nKeep as text", "-"]);
  expect(assignments.getCell("H2").type).toBe(ExcelJS.ValueType.String);
  expect(assignments.getRow(3).values).toEqual([undefined, "TH2", "FCU", "Slave", "-", "20 C", "28 C", "Disabled", longNote, "-"]);
  expect(assignments.getCell("H3").type).toBe(ExcelJS.ValueType.String);
  expect(assignments.getCell("H3").alignment.wrapText).toBe(true);
  expect(assignments.rowCount).toBeGreaterThan(3);
  expect(assignments.getCell(assignments.rowCount, 8).master.address).toBe("H3");
  expect(seasons.getRow(2).values).toEqual([undefined, "=Should remain a label", "4/15", "11/5"]);
  expect(seasons.getCell("A2").type).toBe(ExcelJS.ValueType.String);
  for (const sheet of loaded.worksheets) {
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.getCell("A1").fill).toMatchObject({ type: "pattern", fgColor: { argb: "FFEEF3F5" } });
    expect(sheet.getCell("A2").font.color?.argb).toBe("FF334155");
    expect(sheet.getCell("A2").border.bottom?.style).toBe("thin");
    expect(sheet.pageSetup.orientation).toBe("landscape");
    expect(sheet.pageSetup.printTitlesRow).toBe("1:1");
  }
  expect(JSON.stringify(snapshot)).toBe(before);
});

test("TSTAT Excel shows no assignments and display-default seasons without mutating empty input", async ({}, testInfo) => {
  const snapshot: HvacExcelSnapshot = { assignments: [], seasons: [], locations: [] };
  const book = new ExcelJS.Workbook();
  appendHvacSheets(book, snapshot);
  const file = testInfo.outputPath("tstat-empty.xlsx");
  await book.xlsx.writeFile(file);
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.readFile(file);
  expect(loaded.worksheets.map((sheet) => sheet.name)).toEqual(["TSTAT", "TSTAT Seasons"]);
  expect(loaded.worksheets[0].getCell("A2").value).toBe("No HVAC assignments are registered.");
  expect(loaded.worksheets[0].getCell("H2").master.address).toBe("A2");
  expect(loaded.worksheets[1].getRow(2).values).toEqual([undefined, "Summer", "6/1", "9/30"]);
  expect(loaded.worksheets[1].getRow(3).values).toEqual([undefined, "Winter", "12/1", "3/31"]);
  expect(snapshot).toEqual({ assignments: [], seasons: [], locations: [] });
});
