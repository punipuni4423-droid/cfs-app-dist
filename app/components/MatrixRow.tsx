"use client";

import { memo } from "react";
import type { CSSProperties, DragEvent } from "react";
import type {
  CfsCircuit,
  CfsField,
  DeviceMaster,
  FixtureMaster,
  LocationMaster,
} from "../types";
import {
  CFS_COLUMNS,
  CIRCUIT_PCS_OPTIONS,
  DEFAULT_LOCATION_COLORS,
  DEVICE_NUM_OPTIONS,
  type CfsColumnDef,
} from "../lib/constants";
import ActionIconButton from "./ActionIconButton";
import Combobox from "./Combobox";

interface MatrixRowProps {
  row: CfsCircuit;
  index: number;
  devices: DeviceMaster[];
  fixtures: FixtureMaster[];
  locations: LocationMaster[];
  isFirstOfBlock: boolean;
  blockKey: string;
  isDragging: boolean;
  dropClass: string;
  onCellChange: (rowId: string, field: CfsField, value: string) => void;
  onDeviceSelect: (rowId: string, deviceModel: string) => void;
  onDelete: (rowId: string) => void;
  onDragStart: (e: DragEvent<HTMLSpanElement>, key: string) => void;
  onDragOver: (e: DragEvent<HTMLTableRowElement>, key: string) => void;
  onDrop: (e: DragEvent<HTMLTableRowElement>, key: string) => void;
  onDragEnd: () => void;
}

function rowDelaySlot(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 5;
}

function MatrixRow({
  row,
  index,
  devices,
  fixtures,
  locations,
  isFirstOfBlock,
  blockKey,
  isDragging,
  dropClass,
  onCellChange,
  onDeviceSelect,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: MatrixRowProps) {
  const style = { "--row-index": rowDelaySlot(row.id) } as CSSProperties;
  const matchedDevice = devices.some((d) => d.model === row.device);
  const matchedFixture = fixtures.some((f) => f.fixture === row.fixture);
  const matchedArea = locations.some((l) => l.name === row.area);
  const areaIndex = locations.findIndex((l) => l.name === row.area);
  const areaColor = areaIndex >= 0 ? DEFAULT_LOCATION_COLORS[areaIndex % DEFAULT_LOCATION_COLORS.length] : "";

  function renderCell(col: CfsColumnDef) {
    if (col.kind === "device-select") {
      return (
        <select
          className="cell-input"
          value={row.device}
          onChange={(e) => onDeviceSelect(row.id, e.target.value)}
        >
          <option value="">—</option>
          {!matchedDevice && row.device ? (
            <option value={row.device}>{row.device} (unregistered)</option>
          ) : null}
          {devices.map((d) => (
            <option key={d.id} value={d.model}>
              {d.model}
            </option>
          ))}
        </select>
      );
    }

    if (col.kind === "devicenum-select") {
      return (
        <select
          className="cell-input"
          value={row.deviceNum}
          onChange={(e) => onCellChange(row.id, "deviceNum", e.target.value)}
        >
          {DEVICE_NUM_OPTIONS.map((opt) => (
            <option key={opt || "blank"} value={opt}>
              {opt || "—"}
            </option>
          ))}
        </select>
      );
    }

    if (col.kind === "fixture-select") {
      return (
        <select
          className="cell-input"
          value={row.fixture}
          onChange={(e) => onCellChange(row.id, "fixture", e.target.value)}
        >
          <option value="">—</option>
          {!matchedFixture && row.fixture ? (
            <option value={row.fixture}>{row.fixture} (unregistered)</option>
          ) : null}
          {fixtures.map((f) => (
            <option key={f.id} value={f.fixture}>
              {f.fixture}
            </option>
          ))}
        </select>
      );
    }

    if (col.kind === "area-select") {
      return (
        <select
          className="cell-input"
          value={row.area}
          onChange={(e) => onCellChange(row.id, "area", e.target.value)}
          style={areaColor ? { background: areaColor } : undefined}
        >
          <option value="">—</option>
          {!matchedArea && row.area ? (
            <option value={row.area}>{row.area} (unregistered)</option>
          ) : null}
          {locations.map((l) => (
            <option
              key={l.id}
              value={l.name}
              style={{ background: DEFAULT_LOCATION_COLORS[locations.indexOf(l) % DEFAULT_LOCATION_COLORS.length] }}
            >
              {l.name}
            </option>
          ))}
        </select>
      );
    }

    if (col.kind === "readonly") {
      return <span className="cell-readonly">{row[col.key] || ""}</span>;
    }

    // Unify pcs UX with CircuitsView via Combobox.
    if (col.key === "pcs") {
      return (
        <Combobox
          value={row.pcs}
          options={CIRCUIT_PCS_OPTIONS}
          onChange={(v) => onCellChange(row.id, "pcs", v)}
          numeric
        />
      );
    }

    return (
      <input
        className="cell-input"
        type={col.type === "number" ? "number" : "text"}
        step={col.type === "number" ? "any" : undefined}
        value={row[col.key]}
        onChange={(event) => onCellChange(row.id, col.key, event.target.value)}
      />
    );
  }

  const trClass = [
    "row-enter",
    isDragging ? "row-dragging" : "",
    dropClass,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <tr
      className={trClass}
      style={style}
      onDragOver={(e) => onDragOver(e, blockKey)}
      onDrop={(e) => onDrop(e, blockKey)}
    >
      <td className="col-center drag-handle-cell">
        {isFirstOfBlock ? (
          <span
            className="drag-handle"
            draggable
            onDragStart={(e) => onDragStart(e, blockKey)}
            onDragEnd={onDragEnd}
            title="Drag to reorder"
            aria-label="Reorder handle"
          >
            ::
          </span>
        ) : null}
      </td>
      <td className="col-center">{index + 1}</td>
      {CFS_COLUMNS.map((col) => (
        <td key={col.key}>{renderCell(col)}</td>
      ))}
      <td className="col-center">
        <ActionIconButton
          icon="trash"
          label="Delete Row"
          className="btn-danger-ghost"
          onClick={() => onDelete(row.id)}
        />
      </td>
    </tr>
  );
}

export default memo(MatrixRow);
