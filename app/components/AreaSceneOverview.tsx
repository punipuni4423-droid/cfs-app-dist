"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type {
  CircuitEntry,
  CurtainAssignment,
  DeviceMaster,
  FixtureMaster,
  HvacAssignment,
  LocationMaster,
  ProgrammingNameSettings,
  RoomType,
  Scene,
  SwitchEntry,
} from "../types";
import {
  areaSceneTargetCircuitLabel,
  buildAreaSceneMatrix,
  type AreaSceneCell,
  type AreaSceneGroup,
  type AreaSceneRow,
} from "../lib/areaSceneMatrix";
import {
  BASE_COLUMNS,
  CFS_FUNCTION_COLUMN_WIDTH,
  orderBaseColumns,
  type BaseColumn,
  type BaseColumnKey,
  type CfsSortMode,
  type CfsZoneRow,
} from "../lib/cfsTableModel";
import {
  cfsBaseColumnLabel,
  cfsBaseColumnValues,
  cfsRowProgrammingNameValues,
  type CfsBaseValueContext,
  type CfsNumberMode,
} from "../lib/cfsBaseColumnValues";
import { buildAreaAddressAssignmentMap } from "../lib/programming";
import { buildCfsZoneRows } from "../lib/useCfsZoneRows";
import { downloadCsv, escapeCsvField } from "../lib/csv";
import CfsBaseColumnMenu from "./CfsBaseColumnMenu";
import CfsFilterMenu from "./CfsFilterMenu";

interface AreaSceneOverviewProps {
  scenes: Scene[];
  locations: LocationMaster[];
  circuits: CircuitEntry[];
  hvacAssignments: HvacAssignment[];
  curtainAssignments: CurtainAssignment[];
  switches: SwitchEntry[];
  roomTypeName?: string;
  roomType?: RoomType;
  devices?: DeviceMaster[];
  // T-33: fixture masters for the zone Total VA column ("-" when absent).
  fixtures?: FixtureMaster[];
  programmingNameSettings?: ProgrammingNameSettings;
}

interface AreaSceneDisplayRow {
  id: string;
  source: AreaSceneRow;
  cfsRow?: CfsZoneRow;
}

interface AreaSceneDisplayGroup {
  areaId: string;
  areaName: string;
  rows: AreaSceneDisplayRow[];
}

interface AreaSceneOverviewPrefs {
  sortMode?: CfsSortMode;
  numberMode?: CfsNumberMode;
  hiddenBaseColumns?: BaseColumnKey[];
  baseColumnOrder?: BaseColumnKey[];
}

const AREA_SCENE_OVERVIEW_PREFS_KEY = "cfs-area-scene-overview-prefs-v2";

function sanitizeTestIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function sanitizeFilenamePart(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
}

function todayStamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function isAllEmpty(row: AreaSceneRow): boolean {
  return row.cells.every((cell) => cell.state !== "value");
}

function hasNonUniformApplicableValues(row: AreaSceneRow): boolean {
  const values = row.cells
    .filter((cell) => cell.state !== "na")
    .map((cell) => cell.state === "empty" ? "__empty__" : cell.rawValue.trim());
  return new Set(values).size > 1;
}

function isOffCell(cell: AreaSceneCell): boolean {
  if (cell.state !== "value") return false;
  const raw = cell.rawValue.trim().toLowerCase();
  const display = cell.displayValue.trim().toLowerCase();
  const numericValue = Number(raw);
  return raw === "off" || (raw !== "" && Number.isFinite(numericValue) && numericValue === 0) || display === "0%";
}

function cellClassName(cell: AreaSceneCell): string {
  const classes = ["area-scene-overview-value"];
  if (cell.state === "empty") classes.push("area-scene-overview-empty");
  if (cell.state === "na") classes.push("area-scene-overview-na");
  if (isOffCell(cell)) classes.push("area-scene-overview-off");
  return classes.join(" ");
}

function filteredGroups(
  groups: AreaSceneGroup[],
  hideEmptyRows: boolean,
  showDifferentOnly: boolean,
): AreaSceneGroup[] {
  return groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => {
        if (hideEmptyRows && isAllEmpty(row)) return false;
        if (showDifferentOnly && !hasNonUniformApplicableValues(row)) return false;
        return true;
      }),
    }))
    .filter((group) => group.rows.length > 0);
}

function targetMatchesCfsRow(source: AreaSceneRow, cfsRow: CfsZoneRow): boolean {
  if (source.target.kind === "hvac") return cfsRow.hvacSettingId === source.target.id;
  const targetIds = new Set(
    source.target.groupCircuitIds && source.target.groupCircuitIds.length > 0
      ? source.target.groupCircuitIds
      : [source.target.id],
  );
  return [...cfsRow.circuits, ...(cfsRow.targetAliasCircuits ?? [])]
    .some((item) => targetIds.has(item.id) || targetIds.has(item.circuit.id));
}

function expandDisplayGroups(groups: AreaSceneGroup[], cfsRows: CfsZoneRow[]): AreaSceneDisplayGroup[] {
  return groups.map((group) => {
    const rows: AreaSceneDisplayRow[] = [];
    const matchedTargets = new Set<AreaSceneRow>();
    for (const cfsRow of cfsRows) {
      const source = group.rows.find((row) => targetMatchesCfsRow(row, cfsRow));
      if (!source) continue;
      matchedTargets.add(source);
      rows.push({ id: `${source.target.id}\u0000${cfsRow.id}`, source, cfsRow });
    }
    for (const source of group.rows) {
      if (!matchedTargets.has(source)) rows.push({ id: source.target.id, source });
    }
    return { areaId: group.areaId, areaName: group.areaName, rows };
  }).filter((group) => group.rows.length > 0);
}

function fallbackBaseValues(
  row: AreaSceneDisplayRow,
  group: AreaSceneDisplayGroup,
  key: BaseColumnKey,
  numberMode: CfsNumberMode,
): string[] {
  const target = row.source.target;
  switch (key) {
    case "device":
      return [target.kind === "picoLed" ? "Pico LED" : target.kind === "curtain" ? "Lutron Curtain" : target.kind === "hvac" ? "HVAC" : "-"];
    case "deviceNum":
      return target.kind === "lighting" ? [] : [target.circuitNumber || "-"];
    case "dimmingType":
      return [target.hvacMetric || target.dimmingType || "-"];
    case "designerNumber":
      return [areaSceneTargetCircuitLabel(target, numberMode)];
    case "area":
      return [group.areaName];
    case "detail":
      return [target.detail || "-"];
    default:
      return [];
  }
}

function uniqueDisplayValues(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function csvForDisplay(
  groups: AreaSceneDisplayGroup[],
  sceneColumns: Array<{ name: string }>,
  baseColumns: BaseColumn[],
  numberMode: CfsNumberMode,
  context: CfsBaseValueContext,
): string {
  let rowNumber = 0;
  const rows: string[][] = [];
  for (const group of groups) {
    for (const row of group.rows) {
      rowNumber += 1;
      const baseValues = baseColumns.map((column) => {
        if (column.key === "number") return String(rowNumber);
        const values = row.cfsRow
          ? cfsBaseColumnValues(row.cfsRow, column.key, numberMode, context)
          : fallbackBaseValues(row, group, column.key, numberMode);
        return uniqueDisplayValues(values).join(" / ");
      });
      rows.push([
        ...baseValues,
        ...row.source.cells.map((cell) => cell.state === "na" ? "-" : cell.state === "empty" ? "" : cell.displayValue),
      ]);
    }
  }
  const header = [
    ...baseColumns.map((column) => cfsBaseColumnLabel(column, numberMode)),
    ...sceneColumns.map((column) => column.name),
  ];
  return [header, ...rows].map((row) => row.map(escapeCsvField).join(",")).join("\r\n");
}

function renderBaseValues(values: string[]): JSX.Element {
  const visible = uniqueDisplayValues(values);
  if (visible.length === 0) return <>-</>;
  return (
    <>
      {visible.map((value, index) => (
        <span key={`${value}-${index}`} className="area-scene-overview-base-line">{value}</span>
      ))}
    </>
  );
}

export default function AreaSceneOverview({
  scenes,
  locations,
  circuits,
  hvacAssignments,
  curtainAssignments,
  switches,
  roomTypeName = "",
  roomType,
  devices = [],
  fixtures = [],
  programmingNameSettings,
}: AreaSceneOverviewProps): JSX.Element {
  const matrix = useMemo(
    () => buildAreaSceneMatrix({ scenes, locations, circuits, hvacAssignments, curtainAssignments, switches }),
    [scenes, locations, circuits, hvacAssignments, curtainAssignments, switches],
  );
  const [hideEmptyRows, setHideEmptyRows] = useState(false);
  const [showDifferentOnly, setShowDifferentOnly] = useState(false);
  const [collapsedAreaIds, setCollapsedAreaIds] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<CfsSortMode>("area");
  const [numberMode, setNumberMode] = useState<CfsNumberMode>("designer");
  const [hiddenBaseColumns, setHiddenBaseColumns] = useState<Set<BaseColumnKey>>(new Set());
  const [baseColumnOrder, setBaseColumnOrder] = useState<BaseColumnKey[]>([]);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(AREA_SCENE_OVERVIEW_PREFS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as AreaSceneOverviewPrefs;
      if (
        parsed.sortMode === "device" ||
        parsed.sortMode === "area" ||
        parsed.sortMode === "internal" ||
        parsed.sortMode === "programmingName"
      ) {
        setSortMode(parsed.sortMode);
      }
      if (parsed.numberMode === "designer" || parsed.numberMode === "internal") setNumberMode(parsed.numberMode);
      const validKeys = new Set(BASE_COLUMNS.map((column) => column.key));
      if (Array.isArray(parsed.hiddenBaseColumns)) {
        setHiddenBaseColumns(new Set(parsed.hiddenBaseColumns.filter((key) => validKeys.has(key))));
      }
      if (Array.isArray(parsed.baseColumnOrder)) {
        setBaseColumnOrder(parsed.baseColumnOrder.filter((key) => validKeys.has(key)));
      }
    } catch {
      // Invalid UI preferences fall back to the CFS-aligned defaults.
    } finally {
      setPrefsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      window.localStorage.setItem(
        AREA_SCENE_OVERVIEW_PREFS_KEY,
        JSON.stringify({
          sortMode,
          numberMode,
          hiddenBaseColumns: Array.from(hiddenBaseColumns),
          baseColumnOrder,
        } satisfies AreaSceneOverviewPrefs),
      );
    } catch {
      // UI preferences are non-critical.
    }
  }, [baseColumnOrder, hiddenBaseColumns, numberMode, prefsLoaded, sortMode]);

  // T-33: orderBaseColumns inserts the new zone columns right after Type for
  // saved orders that predate them (instead of appending at the end).
  const orderedBaseColumns = useMemo(() => orderBaseColumns(baseColumnOrder), [baseColumnOrder]);
  const visibleBaseColumns = orderedBaseColumns.filter((column) => !hiddenBaseColumns.has(column.key));
  const stickyOffsets = useMemo(() => {
    const offsets = new Map<BaseColumnKey, number>();
    let left = 0;
    for (const column of visibleBaseColumns) {
      offsets.set(column.key, left);
      left += column.minWidth;
    }
    return offsets;
  }, [visibleBaseColumns]);

  const baseContext = useMemo<CfsBaseValueContext>(
    () => ({
      locations,
      devices,
      programmingNameSettings,
      // T-33: sources for the zone Total VA / Low End / High End columns.
      circuits,
      fixtures,
      deviceAssignments: roomType?.deviceAssignments,
    }),
    [circuits, devices, fixtures, locations, programmingNameSettings, roomType?.deviceAssignments],
  );
  const cfsRows = useMemo(() => {
    if (!roomType) return [];
    const locationById = new Map(locations.map((location) => [location.id, location]));
    const areaAddressByAssignmentCircuit = buildAreaAddressAssignmentMap(roomType.deviceAssignments, circuits, locations);
    const rows = buildCfsZoneRows({
      roomType,
      circuits,
      locations,
      locationById,
      areaAddressByAssignmentCircuit,
      palladiomBySceneTargets: new Map<string, SwitchEntry>(),
      selectedAreaIds: new Set<string>(),
      hiddenDeviceKeys: new Set<string>(),
      sortMode: sortMode === "programmingName" ? "device" : sortMode,
      showCciRows: false,
      hiddenRowKinds: new Set(),
    });
    if (sortMode !== "programmingName") return rows;
    return rows
      .map((row, index) => ({
        row,
        index,
        label: cfsRowProgrammingNameValues(row, baseContext).find((value) => value.trim()) ?? "",
      }))
      .sort((a, b) => {
        const aMissing = !a.label;
        const bMissing = !b.label;
        if (aMissing !== bMissing) return aMissing ? 1 : -1;
        const labelCompare = a.label.localeCompare(b.label, "en", { numeric: true });
        return labelCompare !== 0 ? labelCompare : a.index - b.index;
      })
      .map((item) => item.row);
  }, [baseContext, circuits, locations, roomType, sortMode]);

  const visibleGroups = useMemo(
    () => filteredGroups(matrix.groups, hideEmptyRows, showDifferentOnly),
    [matrix.groups, hideEmptyRows, showDifferentOnly],
  );
  const displayGroups = useMemo(() => expandDisplayGroups(visibleGroups, cfsRows), [cfsRows, visibleGroups]);
  const visibleRowCount = displayGroups.reduce((count, group) => count + group.rows.length, 0);
  const tableMinWidth = visibleBaseColumns.reduce((sum, column) => sum + column.minWidth, 0)
    + matrix.columns.length * CFS_FUNCTION_COLUMN_WIDTH;

  function toggleAreaCollapsed(areaId: string): void {
    setCollapsedAreaIds((prev) => {
      const next = new Set(prev);
      if (next.has(areaId)) next.delete(areaId);
      else next.add(areaId);
      return next;
    });
  }

  function toggleBaseColumn(key: BaseColumnKey): void {
    setHiddenBaseColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function moveBaseColumn(draggedKey: string, targetKey: BaseColumnKey): void {
    if (draggedKey === targetKey) return;
    setBaseColumnOrder(() => {
      const keys = orderedBaseColumns.map((column) => column.key);
      const from = keys.indexOf(draggedKey as BaseColumnKey);
      const to = keys.indexOf(targetKey);
      if (from < 0 || to < 0) return keys;
      const [moved] = keys.splice(from, 1);
      keys.splice(to, 0, moved);
      return keys;
    });
  }

  function moveBaseColumnByOffset(key: BaseColumnKey, offset: number): void {
    setBaseColumnOrder(() => {
      const keys = orderedBaseColumns.map((column) => column.key);
      const from = keys.indexOf(key);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= keys.length) return keys;
      const [moved] = keys.splice(from, 1);
      keys.splice(to, 0, moved);
      return keys;
    });
  }

  function handleDownloadCsv(): void {
    const base = sanitizeFilenamePart(roomTypeName) || "AreaScene";
    downloadCsv(
      `AreaScene_${base}_${todayStamp()}.csv`,
      csvForDisplay(displayGroups, matrix.columns, visibleBaseColumns, numberMode, baseContext),
    );
  }

  let renderedRowNumber = 0;
  return (
    <div className="area-scene-overview" data-testid="area-scene-overview">
      <div className="area-scene-overview-toolbar cfs-matrix-toolbar">
        <div className="area-scene-overview-actions cfs-matrix-controls">
          <CfsFilterMenu
            label="Base Columns"
            displayLabel="Base"
            wide
            panelMinWidth={360}
            panelMaxHeight={720}
            testId="area-scene-base-menu"
          >
            <CfsBaseColumnMenu
              columns={orderedBaseColumns}
              hiddenColumns={hiddenBaseColumns}
              getColumnLabel={(column) => cfsBaseColumnLabel(column, numberMode)}
              onShowAll={() => setHiddenBaseColumns(new Set())}
              onHideAll={() => setHiddenBaseColumns(new Set(BASE_COLUMNS.map((column) => column.key)))}
              onToggleColumn={toggleBaseColumn}
              onMoveColumn={moveBaseColumn}
              onMoveColumnByOffset={moveBaseColumnByOffset}
            />
          </CfsFilterMenu>
          <CfsFilterMenu
            label="Display"
            wide
            panelMinWidth={520}
            testId="area-scene-display-menu"
          >
            <>
              <div className="cfs-menu-section">
                <div className="cfs-menu-title">Sort</div>
                <div className="cfs-segmented cfs-menu-segmented" aria-label="Area Scene sort mode">
                  {([
                    ["device", "Device"],
                    ["area", "Area"],
                    ["internal", "Internal #"],
                    ["programmingName", "Programming Name"],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      className={sortMode === mode ? "is-active" : ""}
                      onClick={() => setSortMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="cfs-menu-section">
                <div className="cfs-menu-title">Number Display</div>
                <div className="cfs-segmented cfs-menu-segmented" aria-label="Area Scene number display">
                  <button
                    type="button"
                    className={numberMode === "designer" ? "is-active" : ""}
                    onClick={() => setNumberMode("designer")}
                  >
                    Designer #
                  </button>
                  <button
                    type="button"
                    className={numberMode === "internal" ? "is-active" : ""}
                    onClick={() => setNumberMode("internal")}
                  >
                    Internal #
                  </button>
                </div>
              </div>
              <label className="cfs-check">
                <input type="checkbox" checked={hideEmptyRows} onChange={(event) => setHideEmptyRows(event.target.checked)} />
                Hide Unset Rows
              </label>
              <label className="cfs-check">
                <input type="checkbox" checked={showDifferentOnly} onChange={(event) => setShowDifferentOnly(event.target.checked)} />
                Differences Only
              </label>
            </>
          </CfsFilterMenu>
          <button type="button" className="btn btn-secondary" onClick={handleDownloadCsv}>CSV Export</button>
          <span className="muted-pill">{visibleRowCount} rows</span>
        </div>
      </div>

      {matrix.columns.length === 0 || visibleRowCount === 0 ? (
        <p className="screen-empty">No Area Scene values match the current filters.</p>
      ) : (
        <div className="matrix-scroll area-scene-overview-scroll" data-testid="area-scene-overview-scroll">
          <table
            className="matrix-table master-table area-scene-overview-table"
            data-testid="area-scene-overview-table"
            style={{ minWidth: `${tableMinWidth}px` }}
          >
            <colgroup>
              {visibleBaseColumns.map((column) => <col key={column.key} style={{ width: column.minWidth }} />)}
              {matrix.columns.map((column) => <col key={column.name} style={{ width: CFS_FUNCTION_COLUMN_WIDTH }} />)}
            </colgroup>
            <thead>
              <tr>
                {visibleBaseColumns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className="area-scene-overview-sticky cfs-base-head"
                    style={{ left: stickyOffsets.get(column.key) ?? 0 }}
                    data-base-column={column.key}
                  >
                    <div className="cfs-base-head-content">
                      <button
                        type="button"
                        className="cfs-base-head-hide-button"
                        title={`Hide ${cfsBaseColumnLabel(column, numberMode)}`}
                        aria-label={`Hide ${cfsBaseColumnLabel(column, numberMode)}`}
                        onClick={() => toggleBaseColumn(column.key)}
                      >
                        -
                      </button>
                      <span>{cfsBaseColumnLabel(column, numberMode)}</span>
                    </div>
                  </th>
                ))}
                {matrix.columns.map((column) => (
                  <th key={column.name} scope="col">
                    <span>{column.name}</span>
                    {column.duplicatedAreaIds.size > 0 ? (
                      <span
                        className="area-scene-overview-dup"
                        title="Duplicate scene name in the same area"
                        aria-label="Duplicate scene name in the same area"
                      >
                        *
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayGroups.map((group) => (
                <Fragment key={group.areaId}>
                  <tr
                    className="area-scene-overview-group-row"
                    data-testid={`area-scene-group-${sanitizeTestIdPart(group.areaId)}`}
                    data-collapsed={collapsedAreaIds.has(group.areaId) ? "true" : "false"}
                  >
                    <th scope="colgroup" colSpan={visibleBaseColumns.length + matrix.columns.length}>
                      <span className="area-scene-overview-group-label">
                        <button
                          type="button"
                          className="collapse-toggle"
                          title={`${collapsedAreaIds.has(group.areaId) ? "Expand" : "Collapse"} ${group.areaName}`}
                          aria-label={`${collapsedAreaIds.has(group.areaId) ? "Expand" : "Collapse"} ${group.areaName}`}
                          aria-expanded={!collapsedAreaIds.has(group.areaId)}
                          onClick={() => toggleAreaCollapsed(group.areaId)}
                        >
                          {collapsedAreaIds.has(group.areaId) ? "▶" : "▼"}
                        </button>
                        <span>{group.areaName}</span>
                        <span className="muted-pill">{group.rows.length}</span>
                      </span>
                    </th>
                  </tr>
                  {collapsedAreaIds.has(group.areaId) ? null : group.rows.map((row) => {
                    renderedRowNumber += 1;
                    const rowNumber = renderedRowNumber;
                    const targetTestId = sanitizeTestIdPart(row.source.target.id);
                    return (
                      <tr
                        key={`${group.areaId}-${row.id}`}
                        data-area-id={group.areaId}
                        data-target-id={row.source.target.id}
                        data-cfs-row-id={row.cfsRow?.id}
                      >
                        {visibleBaseColumns.map((column) => {
                          const values = column.key === "number"
                            ? [String(rowNumber)]
                            : row.cfsRow
                              ? cfsBaseColumnValues(row.cfsRow, column.key, numberMode, baseContext)
                              : fallbackBaseValues(row, group, column.key, numberMode);
                          return (
                            <td
                              key={column.key}
                              className="area-scene-overview-sticky area-scene-overview-base-cell"
                              style={{ left: stickyOffsets.get(column.key) ?? 0 }}
                              data-base-column={column.key}
                            >
                              {renderBaseValues(values)}
                            </td>
                          );
                        })}
                        {row.source.cells.map((cell, index) => (
                          <td
                            key={`${row.id}-${matrix.columns[index]?.name ?? index}`}
                            className={cellClassName(cell)}
                            data-testid={`area-scene-cell-${targetTestId}-${index}`}
                            aria-label={cell.state === "na" ? "not applicable" : undefined}
                          >
                            {cell.state === "value" ? cell.displayValue : cell.state === "empty" ? "-" : ""}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
