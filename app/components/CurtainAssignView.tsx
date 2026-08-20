"use client";

import type { CurtainAssignment, LocationMaster, RevisionFieldChanges } from "../types";
import { createEmptyCurtainAssignment } from "../lib/constants";
import { useDragReorder } from "../lib/useDragReorder";
import ActionIconButton from "./ActionIconButton";
import ResizableMatrixScroll from "./ResizableMatrixScroll";
import { createAppId } from "../lib/id";

interface CurtainAssignViewProps {
  assignments: CurtainAssignment[];
  locations: LocationMaster[];
  onChange: (next: CurtainAssignment[]) => void;
  revisionChanges?: RevisionFieldChanges;
  canEdit?: boolean;
}

const COL_COUNT = 5;

export default function CurtainAssignView({
  assignments,
  locations,
  onChange,
  revisionChanges = {},
  canEdit = true,
}: CurtainAssignViewProps): React.JSX.Element {
  const drag = useDragReorder(assignments, onChange, (assignment) => assignment.id);

  function revisionCellClass(id: string, fields?: readonly string[]): string {
    const changed = revisionChanges[id];
    if (!changed) return "";
    if (!fields) return changed.length > 0 ? "revision-changed-cell" : "";
    return changed.includes("__added") || fields.some((field) => changed.includes(field))
      ? "revision-changed-cell"
      : "";
  }

  function addRow(): void {
    if (!canEdit) return;
    onChange([...assignments, createEmptyCurtainAssignment()]);
  }

  function update(id: string, patch: Partial<CurtainAssignment>): void {
    if (!canEdit) return;
    onChange(assignments.map((assignment) => (assignment.id === id ? { ...assignment, ...patch } : assignment)));
  }

  function copyRow(id: string): void {
    if (!canEdit) return;
    const index = assignments.findIndex((assignment) => assignment.id === id);
    const source = assignments[index];
    if (!source) return;
    const copied = { ...source, id: createAppId() };
    onChange([...assignments.slice(0, index + 1), copied, ...assignments.slice(index + 1)]);
  }

  function removeRow(id: string): void {
    if (!canEdit) return;
    onChange(assignments.filter((assignment) => assignment.id !== id));
  }

  return (
    <>
      <div className="toolbar">
        <span className="toolbar-spacer" />
        <span className="muted-pill" title="Drag handles to reorder rows">
          :: Drag to reorder
        </span>
      </div>
      <ResizableMatrixScroll className="table-workspace-scroll" variant="large">
        <table className="matrix-table master-table device-assign-table curtain-assign-table">
          <colgroup>
            <col className="device-assign-col-drag" />
            <col className="device-assign-col-no" />
            <col className="device-assign-col-zone" />
            <col className="device-assign-col-detail" />
            <col className="device-assign-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th className="col-center" style={{ minWidth: 42 }} aria-label="Reorder" />
              <th className="col-center" style={{ minWidth: 44 }}>No</th>
              <th style={{ minWidth: 220 }}>Area</th>
              <th style={{ minWidth: 260 }}>Detail</th>
              <th className="col-center" style={{ minWidth: 96 }}>Operation</th>
            </tr>
          </thead>
          <tbody>
            {assignments.length === 0 ? (
              <tr>
                <td colSpan={COL_COUNT} className="screen-empty">
                  No Lutron Curtain rows are registered yet. Add a row below.
                </td>
              </tr>
            ) : (
              assignments.map((assignment, index) => {
                const areaMatched = locations.some((location) => location.id === assignment.area);
                return (
                  <tr
                    key={assignment.id}
                    className={[
                      drag.draggingKey === assignment.id ? "row-dragging" : "",
                      drag.dragOverInfo?.targetKey === assignment.id && drag.dragOverInfo.position === "before" ? "drop-before" : "",
                      drag.dragOverInfo?.targetKey === assignment.id && drag.dragOverInfo.position === "after" ? "drop-after" : "",
                    ].filter(Boolean).join(" ")}
                    onDragOver={(event) => {
                      if (canEdit) drag.onDragOver(event, assignment.id);
                    }}
                    onDrop={(event) => {
                      if (canEdit) drag.onDrop(event, assignment.id);
                    }}
                  >
                    <td className="col-center drag-handle-cell">
                      <span
                        className="drag-handle"
                        draggable={canEdit}
                        onDragStart={(event) => {
                          if (canEdit) drag.onDragStart(event, assignment.id);
                        }}
                        onDragEnd={drag.onDragEnd}
                        title="Drag to reorder"
                      >
                        ::
                      </span>
                    </td>
                    <td className="col-center">{index + 1}</td>
                    <td className={revisionCellClass(assignment.id, ["area"])}>
                      <select
                        className="cell-input"
                        value={assignment.area}
                        disabled={!canEdit}
                        onChange={(event) => update(assignment.id, { area: event.target.value })}
                      >
                        <option value="">-</option>
                        {!areaMatched && assignment.area ? (
                          <option value={assignment.area}>{assignment.area} (unregistered)</option>
                        ) : null}
                        {locations.map((location) => (
                          <option key={location.id} value={location.id}>
                            {location.name || "(No name)"}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={revisionCellClass(assignment.id, ["detail"])}>
                      <input
                        className="cell-input"
                        aria-label="Lutron Curtain Detail"
                        value={assignment.detail}
                        placeholder="Blackout / Sheer"
                        disabled={!canEdit}
                        onChange={(event) => update(assignment.id, { detail: event.target.value })}
                      />
                    </td>
                    <td className="col-center">
                      <div className="table-actions">
                        <ActionIconButton
                          icon="copy"
                          label="Copy Lutron Curtain"
                          className="btn-secondary-ghost"
                          onClick={() => copyRow(assignment.id)}
                          title="Copy this Lutron Curtain row"
                          disabled={!canEdit}
                        />
                        <ActionIconButton
                          icon="trash"
                          label="Delete Lutron Curtain"
                          className="btn-danger-ghost"
                          onClick={() => removeRow(assignment.id)}
                          disabled={!canEdit}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={COL_COUNT}>
                <button className="btn-add-row" onClick={addRow} title="Add Row" disabled={!canEdit}>
                  + Add Row
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </ResizableMatrixScroll>
    </>
  );
}
