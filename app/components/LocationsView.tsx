"use client";

import type { LocationMaster } from "../types";
import { createEmptyLocation, DEFAULT_LOCATION_COLORS } from "../lib/constants";
import { deriveAreaCode, nextUniqueAreaCode, normalizeAreaCode } from "../lib/programming";
import { useDragReorder } from "../lib/useDragReorder";
import ActionIconButton from "./ActionIconButton";

interface LocationsViewProps {
  locations: LocationMaster[];
  onChange: (next: LocationMaster[]) => void;
}

export default function LocationsView({ locations, onChange }: LocationsViewProps) {
  const drag = useDragReorder(locations, onChange, (l) => l.id);

  function colorOptions(current: string): string[] {
    const options = [...DEFAULT_LOCATION_COLORS];
    return current && !options.includes(current) ? [current, ...options] : options;
  }

  function update(
    id: string,
    field: keyof Omit<LocationMaster, "id">,
    value: string,
  ): void {
    onChange(
      locations.map((loc) => (loc.id === id ? { ...loc, [field]: value } : loc)),
    );
  }

  function usedCodes(exceptId?: string): Set<string> {
    return new Set(
      locations
        .filter((loc) => loc.id !== exceptId)
        .map((loc) => normalizeAreaCode(loc.code))
        .filter(Boolean),
    );
  }

  function updateName(id: string, value: string): void {
    onChange(
      locations.map((loc) => {
        if (loc.id !== id) return loc;
        const currentCode = normalizeAreaCode(loc.code);
        const previousAutoCode = deriveAreaCode(loc.name);
        const shouldAutoUpdateCode = !currentCode || currentCode === previousAutoCode;
        return {
          ...loc,
          name: value,
          code: shouldAutoUpdateCode ? nextUniqueAreaCode(value, usedCodes(id)) : loc.code,
        };
      }),
    );
  }

  function updateCode(id: string, value: string): void {
    onChange(
      locations.map((loc) => {
        if (loc.id !== id) return loc;
        const normalized = normalizeAreaCode(value);
        return {
          ...loc,
          code: normalized
            ? nextUniqueAreaCode(normalized, usedCodes(id))
            : nextUniqueAreaCode(loc.name, usedCodes(id)),
        };
      }),
    );
  }

  function nextAreaName(): string {
    const usedNames = new Set(locations.map((loc) => loc.name.trim()));
    let index = locations.length + 1;
    let name = `Area ${index}`;
    while (usedNames.has(name)) {
      index += 1;
      name = `Area ${index}`;
    }
    return name;
  }

  function nextAreaNumber(): string {
    const maxNumber = Math.max(
      0,
      ...locations.map((loc) => Number(loc.number)).filter(Number.isFinite),
    );
    return String(maxNumber + 1);
  }

  function add(): void {
    const name = nextAreaName();
    onChange([
      ...locations,
      {
        ...createEmptyLocation(),
        name,
        number: nextAreaNumber(),
        code: nextUniqueAreaCode(name, usedCodes()),
        color: DEFAULT_LOCATION_COLORS[locations.length % DEFAULT_LOCATION_COLORS.length] ?? "",
      },
    ]);
  }

  function remove(id: string): void {
    onChange(locations.filter((loc) => loc.id !== id));
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
              <th className="col-center" style={{ minWidth: 44 }}>No</th>
              <th style={{ minWidth: 220 }}>Area</th>
              <th style={{ minWidth: 80 }}>#</th>
              <th style={{ minWidth: 100 }}>Code</th>
              <th style={{ minWidth: 150 }}>Color</th>
              <th className="col-center" style={{ minWidth: 80 }}>Operation</th>
            </tr>
          </thead>
          <tbody>
            {locations.length === 0 ? (
              <tr>
                <td colSpan={7} className="screen-empty">
                  No areas are registered yet. Add a row below.
                </td>
              </tr>
            ) : (
              locations.map((loc, index) => {
                const isDragging = drag.draggingKey === loc.id;
                const dropClass =
                  drag.dragOverInfo && drag.dragOverInfo.targetKey === loc.id
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
                    key={loc.id}
                    className={trClass}
                    style={loc.color ? { backgroundColor: loc.color } : undefined}
                    onDragOver={(e) => drag.onDragOver(e, loc.id)}
                    onDrop={(e) => drag.onDrop(e, loc.id)}
                  >
                    <td className="col-center drag-handle-cell">
                      <span
                        className="drag-handle"
                        draggable
                        onDragStart={(e) => drag.onDragStart(e, loc.id)}
                        onDragEnd={drag.onDragEnd}
                        title="Drag to reorder"
                      >
                        ::
                      </span>
                    </td>
                    <td className="col-center">{index + 1}</td>
                    <td>
                      <input
                        className="cell-input"
                        value={loc.name}
                        onChange={(e) => updateName(loc.id, e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        value={loc.number}
                        onChange={(e) => update(loc.id, "number", e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        value={loc.code || deriveAreaCode(loc.name)}
                        onChange={(e) => updateCode(loc.id, e.target.value)}
                        maxLength={2}
                      />
                    </td>
                    <td className="color-cell">
                      <span className="color-swatch" style={{ backgroundColor: loc.color || "transparent" }} />
                      <select
                        className="color-select"
                        value={loc.color}
                        onChange={(e) => update(loc.id, "color", e.target.value)}
                        aria-label={`Area color for ${loc.name || `Area ${index + 1}`}`}
                      >
                        <option value="">None</option>
                        {colorOptions(loc.color).map((color) => (
                          <option key={color} value={color}>
                            {color}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="col-center">
                      <ActionIconButton
                        icon="trash"
                        label="Delete Area"
                        className="btn-danger-ghost"
                        onClick={() => remove(loc.id)}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={7}>
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
