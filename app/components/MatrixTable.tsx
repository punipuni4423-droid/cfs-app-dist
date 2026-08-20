"use client";

import { useState } from "react";
import type { DragEvent } from "react";
import type {
  CfsCircuit,
  CfsField,
  DeviceMaster,
  FixtureMaster,
  LocationMaster,
} from "../types";
import { CFS_COLUMNS } from "../lib/constants";
import MatrixRow from "./MatrixRow";

interface MatrixTableProps {
  rows: CfsCircuit[];
  devices: DeviceMaster[];
  fixtures: FixtureMaster[];
  locations: LocationMaster[];
  onChange: (next: CfsCircuit[]) => void;
  onCellChange: (rowId: string, field: CfsField, value: string) => void;
  onDeviceSelect: (rowId: string, deviceModel: string) => void;
  onDeleteRow: (rowId: string) => void;
  onAddRow: () => void;
}

type DropPosition = "before" | "after";

interface DragOverInfo {
  targetKey: string;
  position: DropPosition;
}

function blockKey(r: CfsCircuit): string {
  return r.deviceGroupId || r.id;
}

export default function MatrixTable({
  rows,
  devices,
  fixtures,
  locations,
  onChange,
  onCellChange,
  onDeviceSelect,
  onDeleteRow,
  onAddRow,
}: MatrixTableProps) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dragOverInfo, setDragOverInfo] = useState<DragOverInfo | null>(null);

  function onDragStart(e: DragEvent<HTMLSpanElement>, key: string): void {
    setDraggingKey(key);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", key);
    } catch {
      /* noop */
    }
  }

  function onDragOver(
    e: DragEvent<HTMLTableRowElement>,
    key: string,
  ): void {
    if (!draggingKey) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const target = e.currentTarget;
    const rect = target.getBoundingClientRect();
    const position: DropPosition =
      e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDragOverInfo((prev) => {
      if (prev && prev.targetKey === key && prev.position === position) {
        return prev;
      }
      return { targetKey: key, position };
    });
  }

  function onDrop(
    e: DragEvent<HTMLTableRowElement>,
    targetKey: string,
  ): void {
    e.preventDefault();
    if (!draggingKey || draggingKey === targetKey) {
      setDraggingKey(null);
      setDragOverInfo(null);
      return;
    }
    const fromRows = rows.filter((r) => blockKey(r) === draggingKey);
    const remaining = rows.filter((r) => blockKey(r) !== draggingKey);
    const toIdx = remaining.findIndex((r) => blockKey(r) === targetKey);
    if (toIdx === -1) {
      setDraggingKey(null);
      setDragOverInfo(null);
      return;
    }
    // For block-level reorder we need to insert at the start of the target
    // block (before) or after the LAST row of the target block (after).
    let insertAt = toIdx;
    if (
      dragOverInfo &&
      dragOverInfo.targetKey === targetKey &&
      dragOverInfo.position === "after"
    ) {
      let lastIdx = toIdx;
      for (let i = toIdx + 1; i < remaining.length; i += 1) {
        if (blockKey(remaining[i]) === targetKey) lastIdx = i;
        else break;
      }
      insertAt = lastIdx + 1;
    }
    onChange([
      ...remaining.slice(0, insertAt),
      ...fromRows,
      ...remaining.slice(insertAt),
    ]);
    setDraggingKey(null);
    setDragOverInfo(null);
  }

  function onDragEnd(): void {
    setDraggingKey(null);
    setDragOverInfo(null);
  }

  const totalCols = CFS_COLUMNS.length + 3; // drag handle + No + Operation

  return (
    <div className="matrix-scroll">
      <table className="matrix-table">
        <thead>
          <tr>
            <th className="col-center" style={{ minWidth: 36 }} aria-label="Reorder" />
            <th className="col-center" style={{ minWidth: 44 }}>
              No
            </th>
            {CFS_COLUMNS.map((col) => (
              <th key={col.key} style={{ minWidth: col.minWidth }}>
                {col.label}
              </th>
            ))}
            <th className="col-center" style={{ minWidth: 80 }}>
              Operation
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const groupId = row.deviceGroupId;
            const groupFirstIdx = groupId
              ? rows.findIndex((x) => x.deviceGroupId === groupId)
              : index;
            const isFirstOfBlock = groupId === "" || groupFirstIdx === index;
            const key = blockKey(row);
            const dropClass =
              dragOverInfo && dragOverInfo.targetKey === key
                ? dragOverInfo.position === "before"
                  ? "row-drop-before"
                  : "row-drop-after"
                : "";
            return (
              <MatrixRow
                key={row.id}
                row={row}
                index={index}
                devices={devices}
                fixtures={fixtures}
                locations={locations}
                isFirstOfBlock={isFirstOfBlock}
                blockKey={key}
                isDragging={draggingKey === key}
                dropClass={dropClass}
                onCellChange={onCellChange}
                onDeviceSelect={onDeviceSelect}
                onDelete={onDeleteRow}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDrop={onDrop}
                onDragEnd={onDragEnd}
              />
            );
          })}
        </tbody>
        <tfoot>
          <tr className="add-row-tr">
            <td colSpan={totalCols}>
              <button className="btn-add-row" onClick={onAddRow} title="Add Row">
                + Add Row
              </button>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
