"use client";

import { useMemo, useState } from "react";
import type { ProjectData, RoomType } from "../types";
import {
  buildCfsLutronBridgeExport,
  type CfsLutronBridgeExport,
  type CfsLutronBridgeWarning,
} from "../lib/lutronBridgeExport";

type SpecPanel = "summary" | "warnings" | "json";

interface LutronSpecViewProps {
  project: ProjectData;
  roomType: RoomType;
}

function safeFilePart(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "cfs";
}

function buildFilename(payload: CfsLutronBridgeExport): string {
  const roomName = payload.rooms[0]?.sourceRoomTypeName ?? "room-type";
  return [
    safeFilePart(payload.sourceProjectName),
    safeFilePart(roomName),
    "ld-export.json",
  ].join("_");
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function warningClass(warning: CfsLutronBridgeWarning): string {
  return `lutron-warning-row lutron-warning-${warning.severity}`;
}

function formatGeneratedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-US");
}

function mappingEntries(payload: CfsLutronBridgeExport): Array<[string, string]> {
  return Object.entries(payload.templateMappings).sort(([left], [right]) => {
    if (left === "_default") return -1;
    if (right === "_default") return 1;
    return left.localeCompare(right, "en", { numeric: true });
  });
}

export default function LutronSpecView({
  project,
  roomType,
}: LutronSpecViewProps): React.JSX.Element {
  const [panel, setPanel] = useState<SpecPanel>("summary");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const payload = useMemo(
    () => buildCfsLutronBridgeExport({ project, roomTypeIds: [roomType.id] }),
    [project, roomType.id],
  );
  const payloadJson = useMemo(() => JSON.stringify(payload, null, 2), [payload]);
  const filename = useMemo(() => buildFilename(payload), [payload]);
  const errorCount = payload.warnings.filter((warning) => warning.severity === "error").length;
  const noticeCount = payload.warnings.length;
  const visibleRooms = payload.rooms.slice(0, 12);
  const visibleMappings = mappingEntries(payload).slice(0, 12);

  async function copyJson(): Promise<void> {
    try {
      await navigator.clipboard.writeText(payloadJson);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  const summaryItems = [
    ["Rooms", payload.summary.rooms],
    ["Room Types", payload.summary.roomTypes],
    ["Template Mappings", payload.summary.templateMappings],
    ["Warnings", payload.summary.warnings],
  ] as const;

  return (
    <section className="lutron-spec-view fade-in">
      <header className="lutron-spec-header">
        <div>
          <p className="lutron-spec-kicker">Lutron Designer</p>
          <h2>LD Export JSON</h2>
          <div className="lutron-spec-meta">
            <span>{payload.sourceProjectName}</span>
            <span>{roomType.name}</span>
            <span>Revision {roomType.revision || "1.00"}</span>
            <span>{formatGeneratedAt(payload.exportedAt)}</span>
          </div>
        </div>
        <div className="lutron-spec-actions">
          <button type="button" className="btn btn-secondary" onClick={copyJson}>
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Select JSON" : "Copy LD JSON"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => downloadText(filename, payloadJson)}
          >
            Download LD JSON
          </button>
        </div>
      </header>

      <div className="lutron-spec-status-strip">
        <span className="lutron-status-pill lutron-status-ok">Read Only</span>
        <span className="lutron-status-pill">Bridge JSON</span>
        <span className="lutron-status-pill">Additive</span>
        <span className="lutron-status-pill lutron-status-locked">Reassign Off</span>
        <span className={errorCount > 0 ? "lutron-status-pill lutron-status-danger" : "lutron-status-pill"}>
          {noticeCount} {noticeCount === 1 ? "Notice" : "Notices"}
        </span>
      </div>

      <div className="cfs-segmented lutron-spec-segmented" role="tablist" aria-label="LD export panels">
        <button
          type="button"
          className={panel === "summary" ? "is-active" : ""}
          aria-selected={panel === "summary"}
          role="tab"
          onClick={() => setPanel("summary")}
        >
          Summary
        </button>
        <button
          type="button"
          className={panel === "warnings" ? "is-active" : ""}
          aria-selected={panel === "warnings"}
          role="tab"
          onClick={() => setPanel("warnings")}
        >
          Warnings
        </button>
        <button
          type="button"
          className={panel === "json" ? "is-active" : ""}
          aria-selected={panel === "json"}
          role="tab"
          onClick={() => setPanel("json")}
        >
          JSON
        </button>
      </div>

      {panel === "summary" ? (
        <div className="lutron-spec-panel">
          <div className="lutron-spec-summary-grid">
            {summaryItems.map(([label, value]) => (
              <div className="lutron-spec-kpi" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>

          <section className="lutron-spec-section">
            <div className="lutron-spec-section-head">
              <h3>Rooms</h3>
              <span>{payload.rooms.length} rows</span>
            </div>
            <div className="matrix-scroll pdu-scroll">
              <table className="matrix-table lutron-spec-table">
                <thead>
                  <tr>
                    <th>Floor</th>
                    <th>Room</th>
                    <th>Room Type Key</th>
                    <th>Template</th>
                    <th>Source Revision</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRooms.map((room) => (
                    <tr key={room.sourceRoomTypeId}>
                      <td>{room.floorName}</td>
                      <td>{room.name}</td>
                      <td>{room.roomType}</td>
                      <td>{payload.templateMappings[room.roomType] || payload.templateMappings._default}</td>
                      <td>{room.sourceRoomTypeRevision}</td>
                    </tr>
                  ))}
                  {visibleRooms.length === 0 ? (
                    <tr>
                      <td colSpan={5}>No target rooms.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="lutron-spec-section">
            <div className="lutron-spec-section-head">
              <h3>Template Mappings</h3>
              <span>{mappingEntries(payload).length} rows</span>
            </div>
            <div className="matrix-scroll pdu-scroll">
              <table className="matrix-table lutron-spec-table">
                <thead>
                  <tr>
                    <th>Room Type Key</th>
                    <th>Lutron Template Name</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleMappings.map(([key, value]) => (
                    <tr key={key}>
                      <td>{key}</td>
                      <td>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}

      {panel === "warnings" ? (
        <div className="lutron-spec-panel">
          {payload.warnings.length === 0 ? (
            <div className="screen-empty compact">No warnings.</div>
          ) : (
            <div className="lutron-warning-list">
              {payload.warnings.map((warning, index) => (
                <div className={warningClass(warning)} key={`${warning.code}-${warning.sourceId ?? index}`}>
                  <span>{warning.severity}</span>
                  <strong>{warning.code}</strong>
                  <p>{warning.message}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {panel === "json" ? (
        <div className="lutron-spec-panel">
          <pre className="lutron-json-preview" data-testid="lutron-json-preview">{payloadJson}</pre>
        </div>
      ) : null}
    </section>
  );
}
