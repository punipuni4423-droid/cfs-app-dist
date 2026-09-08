import type { Workbook, Worksheet } from "exceljs";
import type { ProjectRemark } from "../types";

const MIN_COLUMN_WIDTH = 8;
const TABLE_WIDTH_BUDGET = 180;
const NOTE_WIDTH = 80;

function textWidth(value: string): number {
  return Array.from(value).reduce((width, character) => width + (character.codePointAt(0)! > 255 ? 2 : 1), 0);
}

function longestLine(value: string): number {
  return Math.max(0, ...value.split(/\r\n|\r|\n/).map(textWidth));
}

function textHeight(value: string, width: number, title: boolean): number {
  const available = Math.max(1, (width - 2) / (title ? 1.5 : 1.15));
  const lines = value.split(/\r\n|\r|\n/).reduce((count, line) => count + Math.max(1, Math.ceil(textWidth(line) / available)), 0);
  return lines * (title ? 20 : 16) + 10;
}

export function appendRemarksSheet(workbook: Workbook, sheetName: string, remarks: readonly ProjectRemark[]): Worksheet {
  const sheet = workbook.addWorksheet(sheetName);
  const columnCount = Math.max(1, ...remarks.filter((remark) => remark.hasTable).map((remark) => remark.columns.length));
  const widths = Array.from({ length: columnCount }, () => MIN_COLUMN_WIDTH);
  for (const remark of remarks) {
    if (!remark.hasTable) continue;
    remark.columns.forEach((column, index) => {
      const values = [column.trim() ? column : `Column ${index + 1}`, ...remark.rows.map((row) => row[index] ?? "")];
      widths[index] = Math.max(widths[index], Math.max(...values.map(longestLine)) + 3);
    });
  }
  // Like Preview's auto table layout, use spare width before wrapping and retain a readable minimum.
  const naturalWidth = widths.reduce((total, width) => total + width, 0);
  const minimumWidth = columnCount * MIN_COLUMN_WIDTH;
  const availableWidth = Math.max(TABLE_WIDTH_BUDGET, minimumWidth);
  if (naturalWidth > availableWidth) {
    const ratio = (availableWidth - minimumWidth) / (naturalWidth - minimumWidth);
    widths.forEach((width, index) => {
      widths[index] = MIN_COLUMN_WIDTH + (width - MIN_COLUMN_WIDTH) * ratio;
    });
  }
  // Extra note-only columns keep short table columns compact while notes stay readable.
  let totalWidth = widths.reduce((total, width) => total + width, 0);
  while (totalWidth < NOTE_WIDTH) {
    const width = Math.min(40, NOTE_WIDTH - totalWidth);
    widths.push(width);
    totalWidth += width;
  }
  sheet.columns = widths.map((width) => ({ width }));
  sheet.views = [{ showGridLines: false }];
  let rowNumber = 1;

  function appendRow(values: string[], table: boolean, title = false, header = false): void {
    const height = Math.max(...values.map((value, index) => textHeight(value, table ? widths[index] : totalWidth, title)));
    // Excel caps individual row heights. Split tall logical rows and merge each cell vertically.
    const rowSpan = Math.max(1, Math.ceil(height / 400));
    const lastRow = rowNumber + rowSpan - 1;
    for (let offset = 0; offset < rowSpan; offset += 1) {
      sheet.getRow(rowNumber + offset).height = height / rowSpan;
    }
    values.forEach((value, index) => {
      const column = table ? index + 1 : 1;
      const lastColumn = table ? column : widths.length;
      const master = sheet.getCell(rowNumber, column);
      master.value = value;
      master.font = { name: "Arial", size: title ? 14 : 11, bold: title || header, color: { argb: "FF111827" } };
      master.alignment = { vertical: "top", horizontal: "left", wrapText: true };
      master.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } };
      if (table) {
        const edge = { style: "thin" as const, color: { argb: "FFD1D5DB" } };
        // Set the four edges once on the region's master, never on merged slaves.
        master.border = { top: edge, bottom: edge, left: edge, right: edge };
      }
      if (rowSpan > 1 || lastColumn > column) sheet.mergeCells(rowNumber, column, lastRow, lastColumn);
    });
    rowNumber = lastRow + 1;
  }

  for (const remark of remarks) {
    appendRow([remark.title.trim() ? remark.title : "Untitled Remark"], false, true);
    appendRow([remark.body], false);
    if (remark.hasTable && remark.columns.length > 0) {
      appendRow(remark.columns.map((column, index) => column.trim() ? column : `Column ${index + 1}`), true, false, true);
      for (const row of remark.rows) appendRow(remark.columns.map((_, index) => row[index] ?? ""), true);
    }
    sheet.getRow(rowNumber).height = 12;
    rowNumber += 1;
  }
  return sheet;
}
