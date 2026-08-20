"use client";

import type { AddressMode, DeviceMaster } from "../types";
import { CONTROL_OPTIONS, createEmptyDevice } from "../lib/constants";
import { useDragReorder } from "../lib/useDragReorder";
import ActionIconButton from "./ActionIconButton";

interface DevicesViewProps {
  devices: DeviceMaster[];
  onChange: (next: DeviceMaster[]) => void;
}

export default function DevicesView({ devices, onChange }: DevicesViewProps) {
  const drag = useDragReorder(devices, onChange, (d) => d.id);

  function update(
    id: string,
    field: keyof Pick<DeviceMaster, "model" | "control" | "abbrev" | "programmingCode" | "lowEnd" | "highEnd" | "addressMode" | "pdu" | "watts">,
    value: string,
  ): void {
    onChange(
      devices.map((d) => (d.id === id ? { ...d, [field]: value } : d)),
    );
  }

  function add(): void {
    onChange([...devices, createEmptyDevice()]);
  }

  function remove(d: DeviceMaster): void {
    if (d.isDefault) return;
    onChange(devices.filter((x) => x.id !== d.id));
  }

  return (
    <section className="card card-padded fade-in">
      <div className="toolbar">
        <span className="toolbar-spacer" />
        <span className="muted-pill" title="Drag handles to reorder">
          :: Drag to reorder
        </span>
      </div>

      <div className="matrix-scroll">
        <table className="matrix-table master-table">
          <thead>
            <tr>
              <th className="col-center" style={{ minWidth: 36 }} aria-label="Reorder" />
              <th className="col-center" style={{ minWidth: 44 }}>
                No
              </th>
              <th style={{ minWidth: 220 }}>Device</th>
              <th style={{ minWidth: 140 }}>Control</th>
              <th style={{ minWidth: 100 }}>Abbrev.</th>
              <th style={{ minWidth: 120 }}>Programming Code</th>
              <th style={{ minWidth: 100 }}>Low End</th>
              <th style={{ minWidth: 100 }}>High End</th>
              <th style={{ minWidth: 110 }}>Address Mode</th>
              <th style={{ minWidth: 90 }}>PDU</th>
              <th style={{ minWidth: 90 }}>VA</th>
              <th className="col-center" style={{ minWidth: 80 }}>
                Operation
              </th>
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 ? (
              <tr>
                <td colSpan={12} className="screen-empty">
                  No devices are registered.
                </td>
              </tr>
            ) : (
              devices.map((d, index) => {
                const isDragging = drag.draggingKey === d.id;
                const dropClass =
                  drag.dragOverInfo && drag.dragOverInfo.targetKey === d.id
                    ? drag.dragOverInfo.position === "before"
                      ? "row-drop-before"
                      : "row-drop-after"
                    : "";
                const trClass = [
                  isDragging ? "row-dragging" : "",
                  dropClass,
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <tr
                    key={d.id}
                    className={trClass}
                    onDragOver={(e) => drag.onDragOver(e, d.id)}
                    onDrop={(e) => drag.onDrop(e, d.id)}
                  >
                    <td className="col-center drag-handle-cell">
                      <span
                        className="drag-handle"
                        draggable
                        onDragStart={(e) => drag.onDragStart(e, d.id)}
                        onDragEnd={drag.onDragEnd}
                        title="Drag to reorder"
                      >
                        ::
                      </span>
                    </td>
                    <td className="col-center">{index + 1}</td>
                    <td>
                      {d.isDefault ? (
                        <span className="cell-readonly">{d.model || "-"}</span>
                      ) : (
                        <input
                          className="cell-input"
                          value={d.model}
                          onChange={(e) => update(d.id, "model", e.target.value)}
                        />
                      )}
                    </td>
                    <td>
                      {d.isDefault ? (
                        <span className="cell-readonly">{d.control || "-"}</span>
                      ) : (
                        <select
                          className="cell-input"
                          value={d.control}
                          onChange={(e) => update(d.id, "control", e.target.value)}
                        >
                          <option value="">-</option>
                          {CONTROL_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        value={d.abbrev}
                        onChange={(e) => update(d.id, "abbrev", e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        value={d.programmingCode}
                        onChange={(e) => update(d.id, "programmingCode", e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        type="number"
                        step="any"
                        value={d.lowEnd}
                        onChange={(e) => update(d.id, "lowEnd", e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        type="number"
                        step="any"
                        value={d.highEnd}
                        onChange={(e) => update(d.id, "highEnd", e.target.value)}
                      />
                    </td>
                    <td>
                      {d.isDefault ? (
                        <span className="cell-readonly">
                          {d.addressMode === "dali" ? "DALI" : "Fixed"}
                        </span>
                      ) : (
                        <select
                          className="cell-input"
                          value={d.addressMode}
                          onChange={(e) => update(d.id, "addressMode", e.target.value as AddressMode)}
                        >
                          <option value="fixed">Fixed</option>
                          <option value="dali">DALI</option>
                        </select>
                      )}
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        value={d.pdu}
                        onChange={(e) => update(d.id, "pdu", e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        type="number"
                        step="any"
                        value={d.watts}
                        onChange={(e) => update(d.id, "watts", e.target.value)}
                      />
                    </td>
                    <td className="col-center">
                      {d.isDefault ? (
                        <span className="muted-pill" title="Default devices cannot be deleted">
                          Default
                        </span>
                      ) : (
                        <ActionIconButton
                          icon="trash"
                          label="Delete Device"
                          className="btn-danger-ghost"
                          onClick={() => remove(d)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={12}>
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
