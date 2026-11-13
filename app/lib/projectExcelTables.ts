import type { Cell, RichText, Workbook, Worksheet } from "exceljs";
import { CFS_OFF_VALUE_COLOR, isOffLikeDisplayValue } from "./cfsDisplayTextStyle";
import { uniqueExcelSheetName } from "./excelSheetName";

export type ProjectExcelValue = string | number | { text: string; color?: string; bold?: boolean };
export interface ProjectExcelTable {
  title: string;
  titleColor?: string;
  headers: readonly string[];
  rows: readonly (readonly ProjectExcelValue[])[];
  widths?: readonly number[];
  // Only merge a label across an explicitly identified contiguous group.
  groupKeys?: readonly string[];
  mergeColumns?: readonly number[];
}

export function uniqueProjectExcelSheetName(value: string, usedNames: Set<string>): string {
  return uniqueExcelSheetName(value, "Sheet", usedNames);
}

function argb(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const value = color.replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(value)) return `FF${value.toUpperCase()}`;
  return /^[0-9a-f]{8}$/i.test(value) ? value.toUpperCase() : undefined;
}

function writeValue(cell: Cell, value: ProjectExcelValue): string {
  const object = typeof value === "object" ? value : null;
  const text = object ? object.text : String(value);
  const font = { name: "Arial", size: 11, bold: object?.bold ?? false, color: { argb: argb(object?.color) ?? "FF111827" } };
  cell.font = font;
  if (typeof value === "number") {
    cell.value = Number.isFinite(value) ? value : "";
  } else {
    // ExcelJS strings/richText are literal values, including strings beginning
    // with =,+,-,@. Never construct a formula from project-authored text.
    const lines = text.split(/\r\n|\n|\r/);
    if (lines.some(isOffLikeDisplayValue)) {
      const richText: RichText[] = [];
      lines.forEach((line, index) => {
        if (index > 0) richText.push({ text: "\n", font });
        richText.push({ text: line, font: isOffLikeDisplayValue(line) ? { ...font, color: { argb: argb(CFS_OFF_VALUE_COLOR)! } } : font });
      });
      cell.value = { richText };
    } else cell.value = text;
  }
  return text;
}

/** Plain, readable tab tables. Project-wide export ignores temporary UI filters. */
export function appendProjectTables(workbook: Workbook, sheetName: string, tables: readonly ProjectExcelTable[]): Worksheet {
  const sheet = workbook.addWorksheet(sheetName);
  const maxColumns = Math.max(1, ...tables.map((table) => table.headers.length));
  sheet.columns = Array.from({ length: maxColumns }, (_, index) => ({
    width: Math.min(65, Math.max(10, ...tables.map((table) => table.widths?.[index] ?? 18))),
  }));
  sheet.views = [{ state: "frozen", ySplit: 2, showGridLines: false }];
  sheet.pageSetup = { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };
  const edge = { style: "thin" as const, color: { argb: "FFD7E0E5" } };
  let nextRow = 1;
  for (const table of tables) {
    const title = sheet.getCell(nextRow, 1);
    title.value = table.title;
    title.font = { name: "Arial", size: 12, bold: true, color: { argb: argb(table.titleColor) ?? "FF0F6068" } };
    sheet.getRow(nextRow).height = 24;
    if (table.headers.length > 1) sheet.mergeCells(nextRow, 1, nextRow, table.headers.length);
    nextRow += 1;
    table.headers.forEach((header, index) => {
      const cell = sheet.getCell(nextRow, index + 1);
      cell.value = header;
      cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FF334155" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF3F5" } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = { top: edge, left: edge, bottom: edge, right: edge };
    });
    sheet.getRow(nextRow).height = 30;
    const dataStart = nextRow + 1;
    if (table.rows.length === 0) {
      sheet.getCell(dataStart, 1).value = "No records";
      sheet.getCell(dataStart, 1).font = { name: "Arial", size: 11, color: { argb: "FF64748B" } };
    }
    const positions: Array<{ first: number; last: number }> = [];
    let dataEnd = dataStart;
    table.rows.forEach((values) => {
      const row = sheet.getRow(dataEnd);
      let lines = 1;
      table.headers.forEach((_, columnIndex) => {
        const cell = row.getCell(columnIndex + 1);
        const text = writeValue(cell, values[columnIndex] ?? "");
        const width = sheet.getColumn(columnIndex + 1).width ?? 18;
        lines = Math.max(lines, text.split(/\r\n|\r|\n/).reduce((count, line) => count + Math.max(1, Math.ceil(Array.from(line).reduce((sum, char) => sum + (char.codePointAt(0)! > 255 ? 2 : 1), 0) / Math.max(1, width - 2))), 0));
        cell.alignment = { vertical: "top", horizontal: "left", wrapText: true };
        cell.border = { top: edge, left: edge, bottom: edge, right: edge };
      });
      const height = Math.max(22, lines * 15 + 6);
      const span = Math.max(1, Math.ceil(height / 400));
      for (let offset = 0; offset < span; offset += 1) sheet.getRow(dataEnd + offset).height = height / span;
      positions.push({ first: dataEnd, last: dataEnd + span - 1 });
      dataEnd += span;
    });
    const keys = table.groupKeys;
    for (let column = 1; column <= table.headers.length; column += 1) {
      for (let start = 0; start < positions.length;) {
        let end = start + 1;
        if (keys && table.mergeColumns?.includes(column)) {
          while (end < positions.length && keys[start] && keys[end] === keys[start] && JSON.stringify(table.rows[end][column - 1] ?? "") === JSON.stringify(table.rows[start][column - 1] ?? "")) end += 1;
        }
        if (positions[end - 1].last > positions[start].first) sheet.mergeCells(positions[start].first, column, positions[end - 1].last, column);
        start = end;
      }
    }
    nextRow = Math.max(dataStart + 1, dataEnd) + 2;
  }
  sheet.pageSetup.printArea = `A1:${sheet.getColumn(maxColumns).letter}${Math.max(1, nextRow - 2)}`;
  return sheet;
}
