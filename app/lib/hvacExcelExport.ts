import type { Workbook, Worksheet } from "exceljs";
import type { HvacAssignment, HvacSeason, LocationMaster } from "../types";
import { createDefaultHvacSeasons } from "./constants";
import { thermostatNumberForAssignment } from "./tstatOccupancy";
import { tstatMasterReference } from "./tstatMasterReference";

export interface HvacExcelSnapshot {
  assignments: readonly HvacAssignment[];
  seasons: readonly HvacSeason[];
  locations: readonly LocationMaster[];
}

export interface HvacExcelSheetNames {
  assignments: string;
  seasons: string;
}

const HEADER_COLOR = "FFEEF3F5";
const TEXT_COLOR = "FF334155";
const BORDER_COLOR = "FFD7E0E5";

function displayWidth(text: string): number {
  return Array.from(text).reduce((width, char) => width + ((char.codePointAt(0) ?? 0) > 255 ? 2 : 1), 0);
}

function appendTable(
  workbook: Workbook,
  name: string,
  headers: string[],
  widths: number[],
  rows: Array<Array<string | number>>,
  emptyMessage?: string,
): Worksheet {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = widths.map((width) => ({ width }));
  const edge = { style: "thin" as const, color: { argb: BORDER_COLOR } };
  const header = sheet.addRow(headers);
  header.height = 28;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: TEXT_COLOR } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_COLOR } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { top: edge, bottom: edge, left: edge, right: edge };
  });

  function addBodyRow(values: Array<string | number>, empty = false): void {
    const lineCount = empty ? 1 : Math.max(1, ...values.map((value, index) => String(value).split(/\r\n|\r|\n/)
      .reduce((lines, line) => lines + Math.max(1, Math.ceil(displayWidth(line) / Math.max(1, widths[index] - 2))), 0)));
    const height = Math.max(28, lineCount * 16 + 8);
    const rowSpan = Math.max(1, Math.ceil(height / 400));
    const firstRow = sheet.rowCount + 1;
    for (let offset = 0; offset < rowSpan; offset += 1) sheet.getRow(firstRow + offset).height = height / rowSpan;
    values.forEach((value, index) => {
      const cell = sheet.getCell(firstRow, index + 1);
      // Assigning a string keeps notes/labels beginning with =, +, -, or @
      // literal; never construct Excel formula objects from user text.
      cell.value = value;
      cell.font = { color: { argb: TEXT_COLOR } };
      cell.alignment = { horizontal: headers[index] === "Note" || headers[index] === "Reference Master" ? "left" : "center", vertical: "middle", wrapText: true };
      cell.border = { top: edge, bottom: edge, left: edge, right: edge };
      if (empty) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      if (rowSpan > 1) sheet.mergeCells(firstRow, index + 1, firstRow + rowSpan - 1, index + 1);
    });
  }

  if (rows.length === 0 && emptyMessage) {
    addBodyRow([emptyMessage], true);
    sheet.mergeCells(2, 1, 2, headers.length);
  } else {
    rows.forEach((row) => addBodyRow(row));
  }
  sheet.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  sheet.pageSetup = { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  sheet.pageSetup.printTitlesRow = "1:1";
  return sheet;
}

// Both the individual TSTAT export and project-wide export call this builder.
// The caller owns workbook-wide sheet-name uniqueness; input arrays are read only.
export function appendHvacSheets(
  workbook: Workbook,
  snapshot: HvacExcelSnapshot,
  sheetNames: HvacExcelSheetNames = { assignments: "TSTAT", seasons: "TSTAT Seasons" },
): Worksheet[] {
  const areaNames = new Map(snapshot.locations.map((location) => [location.id, location.name || "(No name)"]));
  const assignmentRows = snapshot.assignments.map((row) => [
    thermostatNumberForAssignment(snapshot.assignments, row.id), row.protocol, row.thermostatRole, areaNames.get(row.area) ?? "-",
    `${row.lowEnd} C`, `${row.highEnd} C`, row.summerWinterChange ? "Enabled" : "Disabled", row.note,
    tstatMasterReference(row, snapshot.assignments, snapshot.locations).label,
  ]);
  const seasons = snapshot.seasons.length > 0 ? snapshot.seasons : createDefaultHvacSeasons();
  const seasonRows = seasons.map((row) => [row.name, `${row.startMonth || "1"}/${row.startDay || "1"}`, `${row.endMonth || "1"}/${row.endDay || "1"}`]);
  return [
    appendTable(workbook, sheetNames.assignments,
      ["No", "Control Type", "Master / Slave", "Area", "Low End", "High End", "Summer / Winter", "Note", "Reference Master"],
      [8, 22, 18, 26, 17, 17, 24, 40, 36], assignmentRows, "No HVAC assignments are registered."),
    appendTable(workbook, sheetNames.seasons, ["Season", "Start Date", "End Date"], [24, 24, 24], seasonRows),
  ];
}
