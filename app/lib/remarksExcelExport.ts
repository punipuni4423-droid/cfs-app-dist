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

function tableWidths(remark: ProjectRemark): number[] {
  const widths = remark.columns.map((column, index) => {
    const values = [column.trim() ? column : `Column ${index + 1}`, ...remark.rows.map((row) => row[index] ?? "")];
    return Math.max(MIN_COLUMN_WIDTH, Math.max(...values.map(longestLine)) + 3);
  });
  // Like Preview's auto table layout, use spare width before wrapping and retain a readable minimum.
  const naturalWidth = widths.reduce((total, width) => total + width, 0);
  const minimumWidth = widths.length * MIN_COLUMN_WIDTH;
  const availableWidth = Math.max(TABLE_WIDTH_BUDGET, minimumWidth);
  if (naturalWidth > availableWidth) {
    const ratio = (availableWidth - minimumWidth) / (naturalWidth - minimumWidth);
    widths.forEach((width, index) => {
      widths[index] = MIN_COLUMN_WIDTH + (width - MIN_COLUMN_WIDTH) * ratio;
    });
  }
  return widths;
}

export function appendRemarksSheet(workbook: Workbook, sheetName: string, remarks: readonly ProjectRemark[]): Worksheet {
  const sheet = workbook.addWorksheet(sheetName);
  const layouts = remarks.map((remark) => remark.hasTable ? tableWidths(remark) : []);
  const boundariesFor = (widths: readonly number[]) => widths.reduce<number[]>((ends, width) => [...ends, ends[ends.length - 1] + width], [0]);
  const tableBoundaries = layouts.map(boundariesFor);
  // Excel columns are sheet-wide. Subdivide at every table boundary and merge
  // logical cells across those subdivisions so each table retains its own widths.
  const boundaries = tableBoundaries.flat().sort((a, b) => a - b)
    .reduce<number[]>((accepted, value) => {
      if (accepted.length === 0 || value - accepted[accepted.length - 1] > 1e-7) accepted.push(value);
      return accepted;
    }, []);
  if (boundaries.length === 0) boundaries.push(0);
  if (boundaries.length === 1) boundaries.push(MIN_COLUMN_WIDTH);
  let totalWidth = boundaries[boundaries.length - 1];
  // Extra note-only columns keep short table columns compact while notes stay readable.
  while (totalWidth < NOTE_WIDTH) {
    const width = Math.min(40, NOTE_WIDTH - totalWidth);
    totalWidth += width;
    boundaries.push(totalWidth);
  }
  const widths = boundaries.slice(1).map((end, index) => end - boundaries[index]);
  const boundaryIndex = (value: number) => boundaries.findIndex((boundary) => Math.abs(boundary - value) < 1e-7);
  sheet.columns = widths.map((width) => ({ width }));
  sheet.views = [{ showGridLines: false }];
  let rowNumber = 1;

  function appendRow(values: string[], layout?: readonly number[], title = false, header = false): void {
    const table = Boolean(layout);
    const ends = layout ? boundariesFor(layout) : [];
    const height = Math.max(...values.map((value, index) => textHeight(value, layout ? layout[index] : totalWidth, title)));
    // Excel caps individual row heights. Split tall logical rows and merge each cell vertically.
    const rowSpan = Math.max(1, Math.ceil(height / 400));
    const lastRow = rowNumber + rowSpan - 1;
    for (let offset = 0; offset < rowSpan; offset += 1) {
      sheet.getRow(rowNumber + offset).height = height / rowSpan;
    }
    values.forEach((value, index) => {
      const column = table ? boundaryIndex(ends[index]) + 1 : 1;
      const lastColumn = table ? boundaryIndex(ends[index + 1]) : widths.length;
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

  for (const [index, remark] of remarks.entries()) {
    appendRow([remark.title.trim() ? remark.title : "Untitled Remark"], undefined, true);
    appendRow([remark.body]);
    if (remark.hasTable && remark.columns.length > 0) {
      appendRow(remark.columns.map((column, index) => column.trim() ? column : `Column ${index + 1}`), layouts[index], false, true);
      for (const row of remark.rows) appendRow(remark.columns.map((_, index) => row[index] ?? ""), layouts[index]);
    }
    sheet.getRow(rowNumber).height = 12;
    rowNumber += 1;
  }
  return sheet;
}
