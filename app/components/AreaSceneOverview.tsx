"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type {
  CircuitEntry,
  CurtainAssignment,
  HvacAssignment,
  LocationMaster,
  Scene,
  SwitchEntry,
} from "../types";
import {
  areaSceneMatrixToCsv,
  areaSceneTargetCircuitLabel,
  buildAreaSceneMatrix,
  type AreaSceneCell,
  type AreaSceneCircuitMode,
  type AreaSceneGroup,
} from "../lib/areaSceneMatrix";
import { downloadCsv } from "../lib/csv";

interface AreaSceneOverviewProps {
  scenes: Scene[];
  locations: LocationMaster[];
  circuits: CircuitEntry[];
  hvacAssignments: HvacAssignment[];
  curtainAssignments: CurtainAssignment[];
  switches: SwitchEntry[];
  roomTypeName?: string;
}

const STICKY_WIDTHS = [150, 110, 130, 220] as const;
const STICKY_OFFSETS = STICKY_WIDTHS.reduce<number[]>((offsets, width, index) => {
  offsets.push(index === 0 ? 0 : offsets[index - 1] + STICKY_WIDTHS[index - 1]);
  return offsets;
}, []);

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

function isAllEmpty(row: AreaSceneGroup["rows"][number]): boolean {
  return row.cells.every((cell) => cell.state !== "value");
}

function hasNonUniformApplicableValues(row: AreaSceneGroup["rows"][number]): boolean {
  const values = row.cells
    .filter((cell) => cell.state !== "na")
    .map((cell) => cell.state === "empty" ? "__empty__" : cell.rawValue.trim());
  return new Set(values).size > 1;
}

function isOffCell(cell: AreaSceneCell): boolean {
  if (cell.state !== "value") return false;
  const raw = cell.rawValue.trim().toLowerCase();
  const display = cell.displayValue.trim().toLowerCase();
  return raw === "off" || raw === "0" || display === "0%";
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
  selectedAreaIds: Set<string>,
  hideEmptyRows: boolean,
  showDifferentOnly: boolean,
): AreaSceneGroup[] {
  return groups
    .filter((group) => selectedAreaIds.has(group.areaId))
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

export default function AreaSceneOverview({
  scenes,
  locations,
  circuits,
  hvacAssignments,
  curtainAssignments,
  switches,
  roomTypeName = "",
}: AreaSceneOverviewProps): JSX.Element {
  const matrix = useMemo(
    () => buildAreaSceneMatrix({
      scenes,
      locations,
      circuits,
      hvacAssignments,
      curtainAssignments,
      switches,
    }),
    [scenes, locations, circuits, hvacAssignments, curtainAssignments, switches],
  );
  const areaIdsKey = matrix.groups.map((group) => group.areaId).join("\u0000");
  const allAreaIds = useMemo(() => areaIdsKey === "" ? [] : areaIdsKey.split("\u0000"), [areaIdsKey]);
  const [selectedAreaIds, setSelectedAreaIds] = useState<Set<string>>(() => new Set(allAreaIds));
  const [hideEmptyRows, setHideEmptyRows] = useState(false);
  const [showDifferentOnly, setShowDifferentOnly] = useState(false);
  const [circuitMode, setCircuitMode] = useState<AreaSceneCircuitMode>("designer");

  useEffect(() => {
    setSelectedAreaIds(new Set(allAreaIds));
  }, [areaIdsKey, allAreaIds]);

  const visibleGroups = useMemo(
    () => filteredGroups(matrix.groups, selectedAreaIds, hideEmptyRows, showDifferentOnly),
    [matrix.groups, selectedAreaIds, hideEmptyRows, showDifferentOnly],
  );
  const visibleRowCount = visibleGroups.reduce((count, group) => count + group.rows.length, 0);
  const allSelected = selectedAreaIds.size === allAreaIds.length;

  function toggleArea(areaId: string): void {
    setSelectedAreaIds((prev) => {
      const next = new Set(prev);
      if (next.has(areaId)) next.delete(areaId);
      else next.add(areaId);
      return next;
    });
  }

  function handleDownloadCsv(): void {
    const base = sanitizeFilenamePart(roomTypeName) || "AreaScene";
    downloadCsv(
      `AreaScene_${base}_${todayStamp()}.csv`,
      areaSceneMatrixToCsv(matrix, { circuitMode, groups: visibleGroups }),
    );
  }

  return (
    <div className="area-scene-overview" data-testid="area-scene-overview">
      <div className="area-scene-overview-toolbar">
        <div className="area-scene-overview-area-filter" aria-label="Area filter">
          <button
            type="button"
            className={`scene-area-chip area-scene-overview-filter-chip${allSelected ? " scene-area-chip-active" : ""}`}
            onClick={() => setSelectedAreaIds(new Set(allAreaIds))}
          >
            <span className="scene-area-chip-name">全て</span>
            <span className="scene-area-chip-meta">{matrix.groups.length} areas</span>
          </button>
          {matrix.groups.map((group) => {
            const active = selectedAreaIds.has(group.areaId);
            return (
              <button
                key={group.areaId}
                type="button"
                className={`scene-area-chip area-scene-overview-filter-chip${active ? " scene-area-chip-active" : ""}`}
                onClick={() => toggleArea(group.areaId)}
              >
                <span className="scene-area-chip-name">{group.areaName}</span>
                <span className="scene-area-chip-meta">{group.rows.length} targets</span>
              </button>
            );
          })}
        </div>
        <div className="area-scene-overview-actions">
          <button
            type="button"
            className={`header-toggle${hideEmptyRows ? " is-active" : ""}`}
            onClick={() => setHideEmptyRows((prev) => !prev)}
            aria-pressed={hideEmptyRows}
          >
            未設定行を隠す
          </button>
          <button
            type="button"
            className={`header-toggle${showDifferentOnly ? " is-active" : ""}`}
            onClick={() => setShowDifferentOnly((prev) => !prev)}
            aria-pressed={showDifferentOnly}
          >
            差分行のみ
          </button>
          <button
            type="button"
            className="header-toggle"
            onClick={() => setCircuitMode((prev) => prev === "designer" ? "internal" : "designer")}
          >
            {circuitMode === "designer" ? "Designer#" : "Internal#"}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleDownloadCsv}>
            CSV
          </button>
          <span className="muted-pill">{visibleRowCount} rows</span>
        </div>
      </div>

      {matrix.columns.length === 0 || visibleRowCount === 0 ? (
        <p className="screen-empty">No Area Scene values match the current filters.</p>
      ) : (
        <div className="matrix-scroll area-scene-overview-scroll">
          <table
            className="matrix-table master-table area-scene-overview-table"
            data-testid="area-scene-overview-table"
            style={{ minWidth: `${STICKY_WIDTHS.reduce((sum, width) => sum + width, 0) + matrix.columns.length * 150}px` }}
          >
            <colgroup>
              {STICKY_WIDTHS.map((width, index) => (
                <col key={`fixed-${index}`} style={{ width }} />
              ))}
              {matrix.columns.map((column) => (
                <col key={column.name} style={{ width: 150 }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {["Area", "Circuit #", "Type", "Detail"].map((label, index) => (
                  <th
                    key={label}
                    scope="col"
                    className="area-scene-overview-sticky"
                    style={{ left: STICKY_OFFSETS[index] }}
                  >
                    {label}
                  </th>
                ))}
                {matrix.columns.map((column) => (
                  <th key={column.name} scope="col">
                    <span>{column.name}</span>
                    {column.duplicatedAreaIds.size > 0 ? (
                      <span
                        className="area-scene-overview-dup"
                        title="同名シーンが複数あります"
                        aria-label="同名シーンが複数あります"
                      >
                        *
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleGroups.map((group) => (
                <Fragment key={group.areaId}>
                  <tr
                    key={`${group.areaId}-group`}
                    className="area-scene-overview-group-row"
                    data-testid={`area-scene-group-${sanitizeTestIdPart(group.areaId)}`}
                  >
                    <th scope="colgroup" colSpan={4 + matrix.columns.length}>
                      <span>{group.areaName}</span>
                      <span className="muted-pill">{group.rows.length}</span>
                    </th>
                  </tr>
                  {group.rows.map((row) => {
                    const targetTestId = sanitizeTestIdPart(row.target.id);
                    return (
                      <tr
                        key={`${group.areaId}-${row.target.id}`}
                        data-area-id={group.areaId}
                        data-target-id={row.target.id}
                      >
                        <td className="area-scene-overview-sticky" style={{ left: STICKY_OFFSETS[0] }}>
                          {group.areaName}
                        </td>
                        <td className="area-scene-overview-sticky" style={{ left: STICKY_OFFSETS[1] }}>
                          {areaSceneTargetCircuitLabel(row.target, circuitMode)}
                        </td>
                        <td className="area-scene-overview-sticky" style={{ left: STICKY_OFFSETS[2] }}>
                          {row.target.dimmingType || "-"}
                        </td>
                        <td className="area-scene-overview-sticky" style={{ left: STICKY_OFFSETS[3] }}>
                          {row.target.detail || "-"}
                        </td>
                        {row.cells.map((cell, index) => (
                          <td
                            key={`${row.target.id}-${matrix.columns[index]?.name ?? index}`}
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
