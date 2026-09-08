"use client";

import { useState } from "react";
import type React from "react";

import type { ProjectRemark } from "../types";
import { createAppId } from "../lib/id";
import { useDragReorder } from "../lib/useDragReorder";
import { loadExcelJs } from "../lib/cfsExcelExport";
import { appendRemarksSheet } from "../lib/remarksExcelExport";
import ActionIconButton, { ActionIcon } from "./ActionIconButton";
import DragHandle from "./DragHandle";

type RemarksMode = "edit" | "preview";

interface RemarksViewProps {
  projectName: string;
  remarks: ProjectRemark[];
  onChange: (next: ProjectRemark[]) => void;
}

const TABLE_PRESETS = [
  { id: "flow", label: "Flow", columns: ["Trigger", "Condition", "Action", "Result"] },
  { id: "variable", label: "Variable", columns: ["Variable", "State", "Action"] },
  { id: "rationale", label: "Rationale", columns: ["Target", "Value", "Rationale"] },
  { id: "legend", label: "Legend", columns: ["Symbol", "Meaning"] },
] as const;

const DEFAULT_TABLE_COLUMNS = TABLE_PRESETS[0].columns;

function emptyTableRow(columns: readonly string[]): string[] {
  return columns.map(() => "");
}

function normalizeRows(columns: readonly string[], rows: readonly string[][]): string[][] {
  return rows.map((row) => columns.map((_, index) => row[index] ?? ""));
}

function normalizeRemark(remark: ProjectRemark): ProjectRemark {
  return {
    ...remark,
    columns: [...remark.columns],
    rows: normalizeRows(remark.columns, remark.rows),
  };
}

function createRemark(nextNumber: number): ProjectRemark {
  return {
    id: createAppId(),
    title: `Remark ${nextNumber}`,
    body: "",
    hasTable: false,
    columns: [],
    rows: [],
  };
}

function ensureTable(remark: ProjectRemark): ProjectRemark {
  const columns = remark.columns.length > 0 ? remark.columns : [...DEFAULT_TABLE_COLUMNS];
  const rows = remark.rows.length > 0 ? remark.rows : [emptyTableRow(columns)];
  return normalizeRemark({
    ...remark,
    hasTable: true,
    columns,
    rows,
  });
}

function previewLines(body: string): string[] {
  if (body.trim() === "") return ["No body text."];
  return body.split(/\r?\n/);
}

function RemarkTableInput({ value, className = "", ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return (
    <div className="remarks-cell-editor">
      {/* The mirror gives the textarea intrinsic dimensions without JavaScript layout measurement. */}
      <span className="remarks-cell-text remarks-cell-measure" aria-hidden="true">{value || "\u00a0"}{"\u00a0"}</span>
      <textarea {...props} value={value} rows={1} className={`cell-input remarks-cell-control ${className}`} />
    </div>
  );
}

export default function RemarksView({ projectName, remarks, onChange }: RemarksViewProps): React.JSX.Element {
  const [mode, setMode] = useState<RemarksMode>("edit");
  const [isExporting, setIsExporting] = useState(false);
  const reorder = useDragReorder<ProjectRemark>(remarks, onChange, (remark) => remark.id);

  async function handleExcelExport(): Promise<void> {
    if (isExporting || remarks.length === 0) return;
    setIsExporting(true);
    try {
      const ExcelJS = await loadExcelJs();
      const workbook = new ExcelJS.Workbook();
      appendRemarksSheet(workbook, "Remarks", remarks);
      const buffer = await workbook.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }));
      try {
        const link = document.createElement("a");
        link.href = url;
        const fileName = projectName.trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_") || "Project";
        link.download = `${fileName}_Remarks.xlsx`;
        link.click();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      console.error("Remarks Excel export failed", error);
      window.alert("Excel export failed. Please try again.");
    } finally {
      setIsExporting(false);
    }
  }

  function commit(next: ProjectRemark[]): void {
    onChange(next.map(normalizeRemark));
  }

  function replaceRemark(nextRemark: ProjectRemark): void {
    commit(remarks.map((remark) => (remark.id === nextRemark.id ? normalizeRemark(nextRemark) : remark)));
  }

  function updateRemark(id: string, patch: Partial<ProjectRemark>): void {
    commit(remarks.map((remark) => (remark.id === id ? normalizeRemark({ ...remark, ...patch }) : remark)));
  }

  function handleAddRemark(): void {
    commit([...remarks, createRemark(remarks.length + 1)]);
  }

  function handleDuplicateRemark(source: ProjectRemark): void {
    const copy: ProjectRemark = {
      ...source,
      id: createAppId(),
      title: `${source.title || "Untitled Remark"} Copy`,
      columns: [...source.columns],
      rows: source.rows.map((row) => [...row]),
    };
    const sourceIndex = remarks.findIndex((remark) => remark.id === source.id);
    const insertAt = sourceIndex >= 0 ? sourceIndex + 1 : remarks.length;
    commit([...remarks.slice(0, insertAt), copy, ...remarks.slice(insertAt)]);
  }

  function handleDeleteRemark(target: ProjectRemark): void {
    if (typeof window !== "undefined" && !window.confirm("Delete this remark?")) return;
    commit(remarks.filter((remark) => remark.id !== target.id));
  }

  function handleApplyPreset(remark: ProjectRemark, columns: readonly string[]): void {
    const nextColumns = [...columns];
    replaceRemark({
      ...remark,
      hasTable: true,
      columns: nextColumns,
      rows: [emptyTableRow(nextColumns)],
    });
  }

  function handleAddColumn(remark: ProjectRemark): void {
    const base = ensureTable(remark);
    const columns = [...base.columns, `Column ${base.columns.length + 1}`];
    const rows = base.rows.length > 0 ? base.rows.map((row) => [...row, ""]) : [emptyTableRow(columns)];
    replaceRemark({ ...base, columns, rows });
  }

  function handleRemoveColumn(remark: ProjectRemark, columnIndex: number): void {
    if (remark.columns.length <= 1) return;
    const columns = remark.columns.filter((_, index) => index !== columnIndex);
    const rows = remark.rows.map((row) => row.filter((_, index) => index !== columnIndex));
    replaceRemark({ ...remark, columns, rows });
  }

  function handleUpdateColumn(remark: ProjectRemark, columnIndex: number, value: string): void {
    const columns = remark.columns.map((column, index) => (index === columnIndex ? value : column));
    replaceRemark({ ...remark, columns });
  }

  function handleAddRow(remark: ProjectRemark): void {
    const base = ensureTable(remark);
    replaceRemark({ ...base, rows: [...base.rows, emptyTableRow(base.columns)] });
  }

  function handleRemoveRow(remark: ProjectRemark, rowIndex: number): void {
    replaceRemark({ ...remark, rows: remark.rows.filter((_, index) => index !== rowIndex) });
  }

  function handleUpdateCell(remark: ProjectRemark, rowIndex: number, columnIndex: number, value: string): void {
    const rows = normalizeRows(remark.columns, remark.rows);
    const nextRows = rows.map((row, currentRowIndex) =>
      currentRowIndex === rowIndex
        ? row.map((cell, currentColumnIndex) => (currentColumnIndex === columnIndex ? value : cell))
        : row,
    );
    replaceRemark({ ...remark, rows: nextRows });
  }

  function dragClassName(remark: ProjectRemark): string {
    const classes = ["remarks-note"];
    if (reorder.draggingKey === remark.id) classes.push("is-dragging");
    if (reorder.dragOverInfo?.targetKey === remark.id) {
      classes.push(`is-drop-${reorder.dragOverInfo.position}`);
    }
    return classes.join(" ");
  }

  return (
    <section className="remarks-view fade-in" data-testid="remarks-view">
      <div className="toolbar remarks-toolbar">
        <h2 className="screen-section-title">Remarks</h2>
        {remarks.length > 0 ? (
          <>
            <span className="muted-pill">{remarks.length === 1 ? "1 remark" : `${remarks.length} remarks`}</span>
            <div className="toolbar-spacer" />
            <div className="cfs-segmented remarks-mode-tabs" role="tablist" aria-label="Remarks view mode">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "edit"}
                className={mode === "edit" ? "is-active" : ""}
                onClick={() => setMode("edit")}
              >
                Edit
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "preview"}
                className={mode === "preview" ? "is-active" : ""}
                onClick={() => setMode("preview")}
              >
                Preview
              </button>
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={handleAddRemark}>
              Add Remark
            </button>
          </>
        ) : <div className="toolbar-spacer" />}
        <button
          type="button"
          className="btn btn-secondary btn-sm remarks-export-button"
          disabled={remarks.length === 0 || isExporting}
          aria-busy={isExporting}
          onClick={() => { void handleExcelExport(); }}
        >
          <ActionIcon name="export" />
          Excel Export
        </button>
      </div>

      {remarks.length === 0 ? (
        <div className="screen-empty remarks-empty">
          <p>No remarks yet.</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={handleAddRemark}>
            Add Remark
          </button>
        </div>
      ) : mode === "preview" ? (
        <div className="remarks-preview-list">
          {remarks.map((remark, index) => (
            <article key={remark.id} className="remarks-preview-note">
              <div className="remarks-preview-kicker">Remark {index + 1}</div>
              <h3>{remark.title || "Untitled Remark"}</h3>
              <div className="remarks-preview-body">
                {previewLines(remark.body).map((line, lineIndex) => (
                  <p key={`${remark.id}-body-${lineIndex}`}>{line || "\u00a0"}</p>
                ))}
              </div>
              {remark.hasTable && remark.columns.length > 0 ? (
                <div className="matrix-scroll remarks-preview-table-wrap">
                  <table className="matrix-table remarks-table">
                    <thead>
                      <tr>
                        {remark.columns.map((column, columnIndex) => (
                          <th key={`${remark.id}-preview-column-${columnIndex}`}>
                            <div className="remarks-cell-text">{column || `Column ${columnIndex + 1}`}</div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {normalizeRows(remark.columns, remark.rows).map((row, rowIndex) => (
                        <tr key={`${remark.id}-preview-row-${rowIndex}`}>
                          {row.map((cell, columnIndex) => (
                            <td key={`${remark.id}-preview-cell-${rowIndex}-${columnIndex}`}>
                              <div className="remarks-cell-text">{cell}</div>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="remarks-edit-list">
          {remarks.map((remark, index) => {
            const tableRemark = remark.hasTable ? ensureTable(remark) : remark;
            return (
              <article
                key={remark.id}
                className={dragClassName(remark)}
                data-drag-reorder-key={remark.id}
                onDragOver={(event) => reorder.onDragOver(event, remark.id)}
                onDrop={(event) => reorder.onDrop(event, remark.id)}
              >
                <div className="remarks-note-header">
                  <DragHandle
                    draggable
                    title="Drag to reorder"
                    aria-label={`Reorder remark ${index + 1}`}
                    onDragStart={(event) => reorder.onDragStart(event, remark.id)}
                    onDragEnd={reorder.onDragEnd}
                    onPointerDown={(event) => reorder.onPointerDown(event, remark.id)}
                  />
                  <div className="remarks-note-fields">
                    <input
                      className="cell-input remarks-title-input"
                      value={remark.title}
                      onChange={(event) => updateRemark(remark.id, { title: event.target.value })}
                      aria-label={`Title for remark ${index + 1}`}
                      placeholder="Title"
                    />
                    <textarea
                      className="cell-input cell-textarea remarks-body-input"
                      value={remark.body}
                      onChange={(event) => updateRemark(remark.id, { body: event.target.value })}
                      aria-label={`Body for remark ${index + 1}`}
                      placeholder="Body"
                    />
                  </div>
                  <div className="remarks-note-actions">
                    <ActionIconButton
                      icon="copy"
                      label="Duplicate remark"
                      className="btn-secondary-ghost"
                      onClick={() => handleDuplicateRemark(remark)}
                    />
                    <ActionIconButton
                      icon="trash"
                      label="Delete remark"
                      className="btn-secondary-ghost"
                      onClick={() => handleDeleteRemark(remark)}
                    />
                  </div>
                </div>

                <div className="remarks-table-panel">
                  <div className="remarks-table-toolbar">
                    <label className="cfs-check remarks-table-toggle">
                      <input
                        type="checkbox"
                        checked={remark.hasTable}
                        onChange={(event) => {
                          if (event.target.checked) replaceRemark(ensureTable(remark));
                          else updateRemark(remark.id, { hasTable: false });
                        }}
                      />
                      <span>Table</span>
                    </label>
                    {remark.hasTable ? (
                      <>
                        <div className="remarks-preset-group" aria-label={`Presets for remark ${index + 1}`}>
                          {TABLE_PRESETS.map((preset) => (
                            <button
                              key={preset.id}
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleApplyPreset(remark, preset.columns)}
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                        <div className="toolbar-spacer" />
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleAddColumn(tableRemark)}>
                          Add Column
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleAddRow(tableRemark)}>
                          Add Row
                        </button>
                      </>
                    ) : null}
                  </div>

                  {remark.hasTable ? (
                    <div className="matrix-scroll remarks-table-wrap">
                      <table className="matrix-table remarks-table" aria-label={`Table for remark ${index + 1}`}>
                        <thead>
                          <tr>
                            {tableRemark.columns.map((column, columnIndex) => (
                              <th key={`${remark.id}-column-${columnIndex}`}>
                                <div className="remarks-column-header">
                                  <RemarkTableInput
                                    className="remarks-column-input"
                                    value={column}
                                    onChange={(event) => handleUpdateColumn(tableRemark, columnIndex, event.target.value)}
                                    aria-label={`Column ${columnIndex + 1} name for remark ${index + 1}`}
                                  />
                                  <ActionIconButton
                                    icon="minus"
                                    label={`Remove column ${columnIndex + 1}`}
                                    className="btn-secondary-ghost"
                                    disabled={tableRemark.columns.length <= 1}
                                    onClick={() => handleRemoveColumn(tableRemark, columnIndex)}
                                  />
                                </div>
                              </th>
                            ))}
                            <th className="col-center">Operation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {normalizeRows(tableRemark.columns, tableRemark.rows).map((row, rowIndex) => (
                            <tr key={`${remark.id}-row-${rowIndex}`}>
                              {row.map((cell, columnIndex) => (
                                <td key={`${remark.id}-cell-${rowIndex}-${columnIndex}`}>
                                  <RemarkTableInput
                                    value={cell}
                                    onChange={(event) =>
                                      handleUpdateCell(tableRemark, rowIndex, columnIndex, event.target.value)
                                    }
                                    aria-label={`Remark ${index + 1} row ${rowIndex + 1} column ${columnIndex + 1}`}
                                  />
                                </td>
                              ))}
                              <td className="col-center">
                                <ActionIconButton
                                  icon="minus"
                                  label={`Remove row ${rowIndex + 1}`}
                                  className="btn-secondary-ghost"
                                  onClick={() => handleRemoveRow(tableRemark, rowIndex)}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
