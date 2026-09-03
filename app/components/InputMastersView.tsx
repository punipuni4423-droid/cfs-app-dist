"use client";

import type { InputMaster } from "../types";
import { createEmptyInputMaster } from "../lib/constants";
import { useDragReorder } from "../lib/useDragReorder";
import ActionIconButton from "./ActionIconButton";
import DragHandle from "./DragHandle";

interface InputMastersViewProps {
  inputMasters: InputMaster[];
  onChange: (next: InputMaster[]) => void;
}

export default function InputMastersView({
  inputMasters,
  onChange,
}: InputMastersViewProps) {
  const drag = useDragReorder(inputMasters, onChange, (m) => m.id);

  function update(id: string, name: string): void {
    onChange(inputMasters.map((m) => (m.id === id ? { ...m, name } : m)));
  }

  function add(): void {
    onChange([...inputMasters, createEmptyInputMaster()]);
  }

  function remove(master: InputMaster): void {
    onChange(inputMasters.filter((m) => m.id !== master.id));
  }

  return (
    <section className="card card-padded fade-in">
      <div className="toolbar">
        <span className="toolbar-spacer" />
        <span className="muted-pill" title="Drag to reorder">
          :: Drag to reorder
        </span>
      </div>

      <div className="matrix-scroll">
        <table className="matrix-table master-table input-master-table">
          <thead>
            <tr>
              <th className="col-center" style={{ minWidth: 36 }} aria-label="Reorder" />
              <th className="col-center" style={{ minWidth: 44 }}>No</th>
              <th style={{ minWidth: 260 }}>Input Master</th>
              <th className="col-center" style={{ minWidth: 90 }}>Operation</th>
            </tr>
          </thead>
          <tbody>
            {inputMasters.length === 0 ? (
              <tr>
                <td colSpan={4} className="screen-empty">
                  No input masters are registered.
                </td>
              </tr>
            ) : (
              inputMasters.map((master, index) => {
                const isDragging = drag.draggingKey === master.id;
                const dropClass =
                  drag.dragOverInfo && drag.dragOverInfo.targetKey === master.id
                    ? drag.dragOverInfo.position === "before"
                      ? "row-drop-before"
                      : "row-drop-after"
                    : "";
                return (
                  <tr
                    key={master.id}
                    className={[isDragging ? "row-dragging" : "", dropClass]
                      .filter(Boolean)
                      .join(" ")}
                    onDragOver={(e) => drag.onDragOver(e, master.id)}
                    onDrop={(e) => drag.onDrop(e, master.id)}
                  >
                    <td className="col-center drag-handle-cell">
                      <DragHandle
                        draggable
                        onDragStart={(e) => drag.onDragStart(e, master.id)}
                        onDragEnd={drag.onDragEnd}
                        title="Drag to reorder"
                      />
                    </td>
                    <td className="col-center">{index + 1}</td>
                    <td>
                      <input
                        className="cell-input"
                        value={master.name}
                        onChange={(e) => update(master.id, e.target.value)}
                      />
                    </td>
                    <td className="col-center">
                      <ActionIconButton
                        icon="trash"
                        label="Delete Input"
                        className="btn-danger-ghost"
                        onClick={() => remove(master)}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={4}>
                <button className="btn-add-row" onClick={add} title="Add Row">
                  + Add Row
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
