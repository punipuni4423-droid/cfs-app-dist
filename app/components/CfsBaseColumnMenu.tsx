"use client";

import type { BaseColumn, BaseColumnKey } from "../lib/cfsTableModel";

interface CfsBaseColumnMenuProps {
  columns: BaseColumn[];
  hiddenColumns: ReadonlySet<BaseColumnKey>;
  getColumnLabel: (column: BaseColumn) => string;
  onShowAll: () => void;
  onHideAll: () => void;
  onToggleColumn: (key: BaseColumnKey) => void;
  onMoveColumn: (draggedKey: string, targetKey: BaseColumnKey) => void;
  onMoveColumnByOffset: (key: BaseColumnKey, offset: number) => void;
}

export default function CfsBaseColumnMenu({
  columns,
  hiddenColumns,
  getColumnLabel,
  onShowAll,
  onHideAll,
  onToggleColumn,
  onMoveColumn,
  onMoveColumnByOffset,
}: CfsBaseColumnMenuProps): React.JSX.Element {
  return (
    <>
      <div className="cfs-column-actions">
        <button type="button" onClick={onShowAll}>Show all</button>
        <button type="button" onClick={onHideAll}>Hide all</button>
      </div>
      <div className="cfs-column-options cfs-base-column-options">
        {columns.map((column, index) => {
          const label = getColumnLabel(column);
          return (
            <div
              key={column.key}
              className="cfs-base-column-row cfs-draggable-column"
              draggable
              onDragStart={(event) => event.dataTransfer.setData("text/plain", column.key)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                onMoveColumn(event.dataTransfer.getData("text/plain"), column.key);
              }}
              title="Drag to reorder"
            >
              <span className="drag-handle" aria-hidden="true">::</span>
              <input
                type="checkbox"
                checked={!hiddenColumns.has(column.key)}
                onChange={() => onToggleColumn(column.key)}
                aria-label={`Show ${label} column`}
              />
              <span className="cfs-base-column-label">{label}</span>
              <button
                type="button"
                className="cfs-function-group-move"
                disabled={index === 0}
                title="Move up"
                aria-label={`Move ${label} column up`}
                onClick={() => onMoveColumnByOffset(column.key, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="cfs-function-group-move"
                disabled={index === columns.length - 1}
                title="Move down"
                aria-label={`Move ${label} column down`}
                onClick={() => onMoveColumnByOffset(column.key, 1)}
              >
                ↓
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
