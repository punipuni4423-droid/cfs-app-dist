import type * as ExcelJSTypes from "exceljs";
import {
  BACKLIGHT_LOGIC_MERGE_KEYS,
  cfsBacklightHeading,
  CFS_FUNCTION_COLUMN_WIDTH,
  buildThermostatAreaMergeInfo,
  type BaseColumn,
  type BaseColumnKey,
  type CfsZoneRow,
  type FunctionColumn,
} from "./cfsTableModel";
import { isSceneNameLine, stripSceneNameLinePrefix } from "./cfsValueResolver";
import { CFS_OFF_VALUE_COLOR, isOffLikeDisplayValue, sceneNameColor } from "./cfsDisplayTextStyle";
import { isReservedCfsRow } from "./useCfsZoneRows";
import { PROGRAMMING_NAME_WARNING_COLOR, programmingNameWarning } from "./programmingNameWarning";

// Excel generation for the CFS matrix, extracted from CfsView so a workbook
// can be built outside the component (single sheet today, per-project
// multi-sheet export later). Header groups, merge maps, and value resolvers
// stay owned by the caller (they are shared with the on-screen table); this
// module consumes them as plain data via CfsExcelSheetModel.

type ExcelFill = { type: "pattern"; pattern: "solid"; fgColor: { argb: string } };
type ExcelCellModel = {
  row: number;
  col: number;
  value: string | number;
  rowSpan?: number;
  colSpan?: number;
  fill?: ExcelFill;
  bold?: boolean;
  fontColor?: string;
  richText?: ExcelJSTypes.RichText[];
  horizontal?: "left" | "center";
};

interface MergeSpanInfo {
  isFirst: boolean;
  rowSpan: number;
}

export interface CfsExcelHeaderGroups {
  switchGroups: ReadonlyArray<{
    colSpan: number;
    switchNumber: string;
    switchName: string;
    kind: FunctionColumn["kind"];
  }>;
  buttonGroups: ReadonlyArray<{
    key: string;
    colSpan: number;
    button: string;
    kind: FunctionColumn["kind"];
    pirLabels?: string[];
  }>;
  functionNameGroups: ReadonlyArray<{ colSpan: number; functionName: string }>;
  conditionGroups: ReadonlyArray<{ colSpan: number; condition: string; cols: FunctionColumn[] }>;
}

export interface CfsExcelSheetModel {
  sceneNameColors?: ReadonlyMap<string, string>;
  visibleBaseColumns: ReadonlyArray<BaseColumn>;
  visibleFunctionColumns: ReadonlyArray<FunctionColumn>;
  displayedRows: ReadonlyArray<CfsZoneRow>;
  headerGroups: CfsExcelHeaderGroups;
  mergeInfo: {
    device: ReadonlyMap<string, MergeSpanInfo>;
    dimming: ReadonlyMap<string, MergeSpanInfo>;
    designer: ReadonlyMap<string, MergeSpanInfo>;
    zone: ReadonlyMap<string, MergeSpanInfo>;
    daliGroup: ReadonlyMap<string, MergeSpanInfo>;
  };
  highlights: {
    ffe: boolean;
    energySaving: boolean;
    areaScene: boolean;
    individualOverride: boolean;
    inspectionMark: boolean;
  };
  expandedPirHeaderKeys: ReadonlySet<string>;
  resolvers: {
    baseValues(row: CfsZoneRow, key: BaseColumnKey): string[];
    functionValues(row: CfsZoneRow, col: FunctionColumn): string[];
    baseColumnLabel(col: BaseColumn): string;
    hasChangedBaseCell(row: CfsZoneRow, key: BaseColumnKey): boolean;
    hasChangedFunctionCell(row: CfsZoneRow, col: FunctionColumn): boolean;
    hasAreaSceneValueCell(row: CfsZoneRow, col: FunctionColumn): boolean;
    hasSceneDifferentOverride(row: CfsZoneRow, col: FunctionColumn): boolean;
    hasInspectionMarkForCell(row: CfsZoneRow, col: FunctionColumn): boolean;
    isPriorityTriggerColumn(col: FunctionColumn): boolean;
  };
}

export async function loadExcelJs(): Promise<typeof ExcelJSTypes> {
  const ExcelJSModule = await import("exceljs");
  return (ExcelJSModule.default ?? ExcelJSModule) as typeof ExcelJSTypes;
}

export function appendCfsSheet(
  workbook: ExcelJSTypes.Workbook,
  sheetName: string,
  model: CfsExcelSheetModel,
): void {
  const worksheet = workbook.addWorksheet(sheetName);
  const {
    visibleBaseColumns,
    visibleFunctionColumns,
    displayedRows,
    headerGroups,
    mergeInfo,
    highlights,
    expandedPirHeaderKeys,
    resolvers,
  } = model;
  const thermostatAreaMergeInfo = buildThermostatAreaMergeInfo(displayedRows);
  const backlightHeadings = new Map<number, ExcelCellModel>();

  const headerFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFEEF3F5" } };
  // Border edges: thin matches the faint on-screen cell border; heavy matches
  // the strong .cfs-switch-group-start rule (2px slate) used between switches.
  const thinEdge = { style: "thin" as const, color: { argb: "FFD7E0E5" } };
  const heavyEdge = { style: "medium" as const, color: { argb: "FF334155" } };

  function stackedText(values: string[], placeholder = "-"): string {
    const safeValues = values.length > 0 ? values : [placeholder];
    return safeValues.map((value) => stripSceneNameLinePrefix(value) || placeholder).join("\n");
  }

  function splitHeaderText(value: string): string {
    const parts = value.trim().split(/\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
    return (parts.length > 0 ? parts : ["-"]).join("\n");
  }

  function pirButtonHeaderExportText(group: { button: string; kind: FunctionColumn["kind"]; pirLabels?: string[]; key: string }): string {
    if (group.kind !== "pir" || !group.pirLabels) return splitHeaderText(group.button || "-");
    const labels = group.pirLabels;
    if (labels.length === 0) return "-";
    if (labels.length === 1) return splitHeaderText(labels[0]);
    return expandedPirHeaderKeys.has(group.key)
      ? labels.map((label) => label.replace(/\s+\/\s+/, " ")).join("\n")
      : `${labels.length} PIRs`;
  }

  function rowFill(row: CfsZoneRow, key?: BaseColumnKey): ExcelFill | undefined {
    if (key === "number" || key === "device" || key === "deviceNum" || key === "dimmingType") return undefined;
    const ffe = highlights.ffe && row.circuits.some((item) => item.circuit.ffe);
    const energy = highlights.energySaving && row.circuits.some((item) => item.circuit.energySaving);
    if (ffe && energy) {
      return { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
    }
    if (isReservedCfsRow(row)) {
      return { type: "pattern", pattern: "solid", fgColor: { argb: "FFC4C9CF" } };
    }
    if (ffe) {
      return { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0F2FE" } };
    }
    if (energy) {
      return { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCFCE7" } };
    }
    return undefined;
  }

  function functionHeaderFill(kind: FunctionColumn["kind"]): ExcelFill {
    if (kind === "contact") {
      return { type: "pattern", pattern: "solid", fgColor: { argb: "FFBFE9E9" } };
    }
    if (kind === "lutronPd") {
      return { type: "pattern", pattern: "solid", fgColor: { argb: "FFC9D9FF" } };
    }
    if (kind === "lutronPico") {
      return { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFDCA3" } };
    }
    if (kind === "pir") {
      return { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC8DD" } };
    }
    if (kind === "scene") {
      return { type: "pattern", pattern: "solid", fgColor: { argb: "FFD7F5C8" } };
    }
    if (kind === "command") {
      return { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCC8F5" } };
    }
    return headerFill;
  }

  function changedBaseCell(row: CfsZoneRow, key: BaseColumnKey): boolean {
    return resolvers.hasChangedBaseCell(row, key);
  }

  function bodyBaseCell(row: CfsZoneRow, rowIndex: number, col: BaseColumn, colIndex: number): ExcelCellModel | null {
    const excelRow = 5 + rowIndex;
    const excelCol = colIndex + 1;
    const isChanged = changedBaseCell(row, col.key);
    const changedFill = isChanged ? { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF3B0" } } : undefined;

    if (col.key === "number") {
      return {
        row: excelRow,
        col: excelCol,
        value: rowIndex + 1,
        fill: rowFill(row, col.key),
        horizontal: "center",
      };
    }

    if (row.isBacklight && BACKLIGHT_LOGIC_MERGE_KEYS.includes(col.key)) {
      const visibleBacklightKeys = BACKLIGHT_LOGIC_MERGE_KEYS.filter((key) =>
        visibleBaseColumns.some((visibleCol) => visibleCol.key === key),
      );
      if (col.key !== visibleBacklightKeys[0]) return null;
      const heading: ExcelCellModel = {
        row: excelRow,
        col: excelCol,
        value: cfsBacklightHeading(row),
        colSpan: visibleBacklightKeys.length,
        fill: changedFill ?? rowFill(row, col.key),
        bold: true,
        horizontal: "center",
      };
      backlightHeadings.set(excelRow, heading);
      return heading;
    }

    if (row.isBacklight && col.key === "detail") {
      return { row: excelRow, col: excelCol, value: "-", fill: changedFill ?? rowFill(row, col.key) };
    }

    if (col.key === "device" || col.key === "deviceNum") {
      const info = mergeInfo.device.get(row.id) ?? { isFirst: true, rowSpan: 1 };
      if (!info.isFirst) return null;
      return {
        row: excelRow,
        col: excelCol,
        value: stackedText(resolvers.baseValues(row, col.key)),
        rowSpan: info.rowSpan,
        fill: changedFill ?? rowFill(row, col.key),
        bold: true,
        horizontal: "center",
      };
    }
    if (col.key === "dimmingType") {
      const info = mergeInfo.dimming.get(row.id) ?? { isFirst: true, rowSpan: 1 };
      if (!info.isFirst) return null;
      return {
        row: excelRow,
        col: excelCol,
        value: stackedText(resolvers.baseValues(row, col.key)),
        rowSpan: info.rowSpan,
        fill: changedFill ?? rowFill(row, col.key),
        bold: true,
        horizontal: "center",
      };
    }
    if (col.key === "designerNumber") {
      const info = mergeInfo.designer.get(row.id) ?? { isFirst: true, rowSpan: 1 };
      if (!info.isFirst) return null;
      return {
        row: excelRow,
        col: excelCol,
        value: stackedText(resolvers.baseValues(row, col.key)),
        rowSpan: info.rowSpan,
        fill: changedFill ?? rowFill(row, col.key),
        bold: true,
        horizontal: "center",
      };
    }
    if (col.key === "group" && !row.isDali && visibleBaseColumns[colIndex + 1]?.key === "zone") {
      const info = mergeInfo.zone.get(row.id) ?? { isFirst: true, rowSpan: 1 };
      if (!info.isFirst) return null;
      const groupZoneChangedFill =
        isChanged || resolvers.hasChangedBaseCell(row, "zone")
          ? { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF3B0" } }
          : undefined;
      return {
        row: excelRow,
        col: excelCol,
        value: stackedText(resolvers.baseValues(row, "zone")),
        colSpan: 2,
        rowSpan: info.rowSpan,
        fill: groupZoneChangedFill ?? rowFill(row, col.key),
        horizontal: "center",
      };
    }
    if (col.key === "zone" && !row.isDali && visibleBaseColumns[colIndex - 1]?.key === "group") {
      return null;
    }
    if (col.key === "group" && row.isDali) {
      const info = mergeInfo.daliGroup.get(row.id) ?? { isFirst: true, rowSpan: 1 };
      if (!info.isFirst) return null;
      return {
        row: excelRow,
        col: excelCol,
        value: stackedText(resolvers.baseValues(row, col.key)),
        rowSpan: info.rowSpan,
        fill: changedFill ?? rowFill(row, col.key),
        horizontal: "center",
      };
    }
    if (col.key === "zone") {
      const info = mergeInfo.zone.get(row.id) ?? { isFirst: true, rowSpan: 1 };
      if (!info.isFirst) return null;
      return {
        row: excelRow,
        col: excelCol,
        value: stackedText(resolvers.baseValues(row, col.key)),
        rowSpan: info.rowSpan,
        fill: changedFill ?? rowFill(row, col.key),
        horizontal: "center",
      };
    }
    if (col.key === "area" && row.isHvac) {
      const info = thermostatAreaMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
      if (!info.isFirst) return null;
      return { row: excelRow, col: excelCol, value: stackedText(resolvers.baseValues(row, col.key)),
        rowSpan: info.rowSpan, fill: changedFill ?? rowFill(row, col.key), horizontal: "center" };
    }
    const values = resolvers.baseValues(row, col.key);
    const overlongName = col.key === "programmingName" && values.some((value) => programmingNameWarning(value));
    return {
      row: excelRow,
      col: excelCol,
      value: stackedText(values),
      ...(overlongName ? { richText: values.flatMap((value, index) => [
        ...(index ? [{ text: "\n" }] : []),
        { text: value, ...(programmingNameWarning(value) ? { font: { bold: true, color: { argb: `FF${PROGRAMMING_NAME_WARNING_COLOR.slice(1)}` } } } : {}) },
      ]) } : {}),
      fill: changedFill ?? rowFill(row, col.key),
      horizontal: "center",
    };
  }

  function bodyFunctionCell(row: CfsZoneRow, rowIndex: number, col: FunctionColumn, colIndex: number): ExcelCellModel {
    const values = resolvers.functionValues(row, col);
    const isAreaSceneValue = highlights.areaScene && resolvers.hasAreaSceneValueCell(row, col);
    const emphasizeSceneNames = isAreaSceneValue && values.length > 1;
    const placeholder = row.isBacklight ? "" : "-";
    const lines = (values.length > 0 ? values : [placeholder]).map((value) => {
      const text = stripSceneNameLinePrefix(value);
      const isSceneName = emphasizeSceneNames && isSceneNameLine(value);
      const color = isOffLikeDisplayValue(text)
        ? CFS_OFF_VALUE_COLOR
        : isSceneName && text.trim()
          ? model.sceneNameColors?.get(text.trim().toLowerCase()) ?? sceneNameColor(text)
          : undefined;
      return { text: text || placeholder, bold: isSceneName, color: color ? `FF${color.slice(1).toUpperCase()}` : undefined };
    });
    const styled = lines.some((line) => line.bold || line.color);
    const isChanged = resolvers.hasChangedFunctionCell(row, col);
    const isIndividualOverride = highlights.individualOverride && resolvers.hasSceneDifferentOverride(row, col);
    const isInspectionMarked = highlights.inspectionMark && resolvers.hasInspectionMarkForCell(row, col);
    const fill =
      isIndividualOverride
        ? { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFDE047" } }
        : isChanged
          ? { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF3B0" } }
          : isAreaSceneValue
            ? { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF3E8FF" } }
            : rowFill(row) ?? (isInspectionMarked
              ? { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFEEF6FF" } }
              : undefined);
    return {
      row: 5 + rowIndex,
      col: visibleBaseColumns.length + colIndex + 1,
      value: stackedText(values, placeholder),
      // A scene label and its setting share one cell, but keep independent
      // font runs just like the lines in the on-screen CFS stack.
      richText: styled && lines.length > 1 ? lines.map((line, index) => ({
        text: `${index > 0 ? "\n" : ""}${line.text}`,
        font: { bold: line.bold, color: { argb: line.color ?? "FF334155" } },
      })) : undefined,
      bold: lines.length === 1 && lines[0].bold,
      fontColor: lines.length === 1 ? lines[0].color : undefined,
      fill,
      horizontal: "center",
    };
  }

  const cells: ExcelCellModel[] = [];
  visibleBaseColumns.forEach((col, index) => {
    cells.push({
      row: 1,
      col: index + 1,
      value: resolvers.baseColumnLabel(col),
      rowSpan: 4,
      fill: headerFill,
      bold: true,
      horizontal: "center",
    });
  });
  let headerCol = visibleBaseColumns.length + 1;
  for (const group of headerGroups.switchGroups) {
    cells.push({
      row: 1,
      col: headerCol,
      value: [group.switchNumber, group.switchName].filter(Boolean).join("\n") || "-",
      colSpan: group.colSpan,
      fill: functionHeaderFill(group.kind),
      bold: true,
      horizontal: "center",
    });
    headerCol += group.colSpan;
  }
  headerCol = visibleBaseColumns.length + 1;
  for (const group of headerGroups.buttonGroups) {
    cells.push({
      row: 2,
      col: headerCol,
      value: pirButtonHeaderExportText(group),
      colSpan: group.colSpan,
      fill: headerFill,
      bold: true,
      horizontal: "center",
    });
    headerCol += group.colSpan;
  }
  headerCol = visibleBaseColumns.length + 1;
  for (const group of headerGroups.functionNameGroups) {
    cells.push({
      row: 3,
      col: headerCol,
      value: splitHeaderText(group.functionName || "-"),
      colSpan: group.colSpan,
      fill: headerFill,
      bold: true,
      horizontal: "center",
    });
    headerCol += group.colSpan;
  }
  headerCol = visibleBaseColumns.length + 1;
  for (const group of headerGroups.conditionGroups) {
    cells.push({
      row: 4,
      col: headerCol,
      value: splitHeaderText(group.condition || "-"),
      colSpan: group.colSpan,
      fill: group.cols.some((col) => resolvers.isPriorityTriggerColumn(col))
        ? { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE08A" } }
        : headerFill,
      bold: true,
      horizontal: "center",
    });
    headerCol += group.colSpan;
  }

  if (displayedRows.length === 0) {
    cells.push({
      row: 5,
      col: 1,
      value: "Enter Circuit and Device Assign data to generate the CFS matrix.",
      colSpan: visibleBaseColumns.length + visibleFunctionColumns.length,
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } },
      horizontal: "center",
    });
  } else {
    displayedRows.forEach((row, rowIndex) => {
      visibleBaseColumns.forEach((col, colIndex) => {
        const cell = bodyBaseCell(row, rowIndex, col, colIndex);
        if (cell) cells.push(cell);
      });
      visibleFunctionColumns.forEach((col, colIndex) => {
        cells.push(bodyFunctionCell(row, rowIndex, col, colIndex));
      });
    });
  }

  const maxColWidths = new Map<number, number>();
  visibleBaseColumns.forEach((col, index) => {
    maxColWidths.set(index + 1, Math.min(34, Math.max(7, col.minWidth / 7)));
  });
  visibleFunctionColumns.forEach((_col, index) => {
    const column = visibleBaseColumns.length + index + 1;
    maxColWidths.set(column, Math.min(34, Math.max(7, CFS_FUNCTION_COLUMN_WIDTH / 7)));
  });

  // Heavy edges: switch-to-switch boundaries, the header row band (rows 1-4),
  // the base-column band, and the outer table frame. ExcelJS shares one style
  // per merged range, so borders are computed per cell REGION (row/colSpan),
  // never by overwriting individual grid positions inside a merge.
  const baseColumnCount = visibleBaseColumns.length;
  const totalColumnCount = baseColumnCount + visibleFunctionColumns.length;
  const lastBorderRow = 4 + Math.max(1, displayedRows.length);
  const switchGroupStartCols = new Set<number>();
  {
    let groupStartCol = baseColumnCount + 1;
    for (const group of headerGroups.switchGroups) {
      switchGroupStartCols.add(groupStartCol);
      groupStartCol += group.colSpan;
    }
  }

  for (const cell of cells) {
    const excelCell = worksheet.getCell(cell.row, cell.col);
    excelCell.value = cell.richText ? { richText: cell.richText } : cell.value;
    const regionEndRow = cell.row + (cell.rowSpan ?? 1) - 1;
    const regionEndCol = cell.col + (cell.colSpan ?? 1) - 1;
    excelCell.border = {
      top: cell.row === 1 ? heavyEdge : thinEdge,
      bottom: regionEndRow === lastBorderRow || regionEndRow === 4 ? heavyEdge : thinEdge,
      left:
        cell.col === 1 || cell.col === baseColumnCount + 1 || switchGroupStartCols.has(cell.col)
          ? heavyEdge
          : thinEdge,
      right:
        regionEndCol === totalColumnCount ||
        regionEndCol === baseColumnCount ||
        switchGroupStartCols.has(regionEndCol + 1)
          ? heavyEdge
          : thinEdge,
    };
    excelCell.alignment = {
      horizontal: cell.horizontal ?? "center",
      vertical: "middle",
      wrapText: true,
    };
    excelCell.font = {
      bold: Boolean(cell.bold),
      color: { argb: cell.fontColor ?? "FF334155" },
    };
    if (cell.fill) excelCell.fill = cell.fill;
    const rowSpan = cell.rowSpan ?? 1;
    const colSpan = cell.colSpan ?? 1;
    if (rowSpan > 1 || colSpan > 1) {
      worksheet.mergeCells(cell.row, cell.col, cell.row + rowSpan - 1, cell.col + colSpan - 1);
    }
    // The heading's number list wraps within the existing band width.
    const value = String(cell.value ?? "");
    const text = backlightHeadings.get(cell.row) === cell ? value.split("\n")[0] : value;
    const textWidth = Math.min(36, Math.max(6, Math.max(...text.split("\n").map((line) => line.length)) * 0.85 + 2));
    for (let col = cell.col; col < cell.col + colSpan; col += 1) {
      maxColWidths.set(col, Math.max(maxColWidths.get(col) ?? 0, textWidth));
    }
  }

  for (let rowIndex = 1; rowIndex <= 4; rowIndex += 1) {
    const rowCells = cells.filter((cell) => cell.row === rowIndex);
    const maxLines = rowCells.reduce((max, cell) => Math.max(max, String(cell.value ?? "").split("\n").length), 1);
    worksheet.getRow(rowIndex).height = Math.max(22, Math.min(82, maxLines * 18));
  }
  const bodyRowCount = Math.max(1, displayedRows.length);
  for (let rowIndex = 5; rowIndex < 5 + bodyRowCount; rowIndex += 1) {
    worksheet.getRow(rowIndex).height = 31;
  }

  maxColWidths.forEach((width, index) => {
    worksheet.getColumn(index).width = Math.min(34, Math.max(7, width));
  });

  for (const heading of backlightHeadings.values()) {
    let width = 0;
    for (let col = heading.col; col < heading.col + (heading.colSpan ?? 1); col += 1) {
      width += worksheet.getColumn(col).width ?? 7;
    }
    // Column widths use digit units. Allow space for bold letters and cell
    // padding, and budget by word so Excel wrapping at commas fits the row.
    const capacity = Math.max(1, Math.floor((width - 2) * 0.75));
    let lines = 0;
    for (const line of String(heading.value).split("\n")) {
      lines += 1;
      let used = 0;
      for (const word of line.split(/\s+/)) {
        if (used && used + 1 + word.length > capacity) {
          lines += 1;
          used = 0;
        }
        lines += Math.floor(Math.max(0, word.length - 1) / capacity);
        used = used ? used + 1 + word.length : ((Math.max(1, word.length) - 1) % capacity) + 1;
      }
    }
    worksheet.getRow(heading.row).height = Math.min(409, Math.max(31, lines * 16 + 6));
  }

  worksheet.views = [{ state: "frozen", xSplit: visibleBaseColumns.length, ySplit: 4 }];
}
