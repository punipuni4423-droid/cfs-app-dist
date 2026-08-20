"use client";

import { useRef } from "react";
import type { FixtureMaster } from "../types";
import { DEFAULT_FIXTURE_POWER_FACTOR, FIXTURE_TYPE_OPTIONS, createEmptyFixture } from "../lib/constants";
import {
  csvToFixtures,
  downloadCsv,
  fixtureCsvSignature,
  fixturesToCsv,
  readCsvFileText,
  uniqueByCsvSignature,
} from "../lib/csv";
import { useDragReorder } from "../lib/useDragReorder";
import ActionIconButton from "./ActionIconButton";
import { createAppId } from '../lib/id';

interface FixturesViewProps {
  fixtures: FixtureMaster[];
  onChange: (next: FixtureMaster[]) => void;
}

const MAX_IMPORT_FILE_SIZE = 5 * 1024 * 1024;

export default function FixturesView({ fixtures, onChange }: FixturesViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const drag = useDragReorder(fixtures, onChange, (f) => f.id);

  function update(
    id: string,
    field: keyof Omit<FixtureMaster, "id">,
    value: string,
  ): void {
    const nextValue = field === "powerFactor" ? normalizePowerFactor(value) : value;
    onChange(
      fixtures.map((fx) => (fx.id === id ? { ...fx, [field]: nextValue } : fx)),
    );
  }

  function normalizePowerFactor(value: string): string {
    if (value.trim() === "") return "";
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return "";
    return String(Math.min(1, Math.max(0.1, parsed)));
  }

  function commonPowerFactor(): string {
    if (fixtures.length === 0) return DEFAULT_FIXTURE_POWER_FACTOR;
    const values = Array.from(
      new Set(fixtures.map((fx) => fx.powerFactor || DEFAULT_FIXTURE_POWER_FACTOR)),
    );
    return values.length === 1 ? values[0] : "";
  }

  function updateCommonPowerFactor(value: string): void {
    const nextValue = normalizePowerFactor(value);
    onChange(
      fixtures.map((fx) => ({
        ...fx,
        powerFactor: nextValue,
      })),
    );
  }

  function add(): void {
    onChange([...fixtures, createEmptyFixture()]);
  }

  function remove(id: string): void {
    onChange(fixtures.filter((fx) => fx.id !== id));
  }

  function copy(id: string): void {
    const sourceIndex = fixtures.findIndex((fx) => fx.id === id);
    if (sourceIndex < 0) return;
    const source = fixtures[sourceIndex];
    const copied: FixtureMaster = {
      ...source,
      id: createAppId(),
      fixture: source.fixture.trim() ? `${source.fixture} Copy` : "",
    };
    onChange([
      ...fixtures.slice(0, sourceIndex + 1),
      copied,
      ...fixtures.slice(sourceIndex + 1),
    ]);
  }

  function handleImportFile(file: File): void {
    if (file.size > MAX_IMPORT_FILE_SIZE) {
      window.alert("Select a CSV file of 5 MB or less.");
      return;
    }

    void (async () => {
      try {
        const parsed = await csvToFixtures(await readCsvFileText(file));
        if (parsed.length === 0) {
          window.alert("No valid rows were found. CSV headers: Fixture, Type, Power Mode, VA/W@");
          return;
        }
        const unique = uniqueByCsvSignature(fixtures, parsed, fixtureCsvSignature);
        const append = window.confirm(
          `${parsed.length} fixtures will be imported.` +
            (unique.skipped > 0 ? `\n${unique.skipped} matching rows will be skipped when appending.` : "") +
            "\n\nOK: Append to the existing list\n" +
            "Cancel: Replace the existing list",
        );
        if (!append) {
          onChange(parsed);
          return;
        }
        if (unique.added.length === 0) {
          window.alert("No new fixtures were imported because every row already exists.");
          return;
        }
        onChange([...fixtures, ...unique.added]);
        if (unique.skipped > 0) {
          window.alert(`${unique.added.length} new fixtures were imported. ${unique.skipped} matching rows were skipped.`);
        }
      } catch (e) {
        window.alert("CSV parsing failed: " + String(e));
      }
    })();
  }

  function handleExport(): void {
    const csv = fixturesToCsv(fixtures);
    downloadCsv("fixtures.csv", csv);
  }

  return (
    <section className="card card-padded fade-in">
      <div className="toolbar">
        <button
          className="btn btn-secondary"
          onClick={() => fileInputRef.current?.click()}
        >
          CSV Import
        </button>
        <button className="btn btn-secondary" onClick={handleExport}>
          CSV Export
        </button>
        <span className="muted-pill" aria-live="polite">
          {fixtures.length} items
        </span>
        <span className="toolbar-spacer" />
        <label className="toolbar-field">
          <span>Correction</span>
          <input
            className="cell-input"
            type="number"
            min="0.1"
            max="1"
            step="0.1"
            value={commonPowerFactor()}
            onChange={(e) => updateCommonPowerFactor(e.target.value)}
          />
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportFile(file);
            e.target.value = "";
          }}
        />
      </div>

      <div className="matrix-scroll">
        <table className="matrix-table master-table">
          <thead>
            <tr>
              <th className="col-center" style={{ minWidth: 36 }} aria-label="Reorder" />
              <th className="col-center" style={{ minWidth: 44 }}>
                No
              </th>
              <th style={{ minWidth: 280 }}>Fixture</th>
              <th style={{ minWidth: 130 }}>Type</th>
              <th style={{ minWidth: 110 }}>Mode</th>
              <th style={{ minWidth: 120 }}>VA / W@</th>
              <th style={{ minWidth: 120 }}>Correction</th>
              <th className="col-center" style={{ minWidth: 140 }}>
                Operation
              </th>
            </tr>
          </thead>
          <tbody>
            {fixtures.length === 0 ? (
              <tr>
                <td colSpan={8} className="screen-empty">
                  No fixtures are registered yet. Add one below or use CSV Import.
                </td>
              </tr>
            ) : (
              fixtures.map((fx, index) => {
                const isDragging = drag.draggingKey === fx.id;
                const dropClass =
                  drag.dragOverInfo && drag.dragOverInfo.targetKey === fx.id
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
                    key={fx.id}
                    className={trClass}
                    onDragOver={(e) => drag.onDragOver(e, fx.id)}
                    onDrop={(e) => drag.onDrop(e, fx.id)}
                  >
                    <td className="col-center drag-handle-cell">
                      <span
                        className="drag-handle"
                        draggable
                        onDragStart={(e) => drag.onDragStart(e, fx.id)}
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
                        value={fx.fixture}
                        onChange={(e) => update(fx.id, "fixture", e.target.value)}
                      />
                    </td>
                    <td>
                      <select
                        className="cell-input"
                        value={fx.fixtureType}
                        onChange={(e) =>
                          update(fx.id, "fixtureType", e.target.value)
                        }
                      >
                        {FIXTURE_TYPE_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="cell-input"
                        value={fx.powerMode}
                        onChange={(e) => update(fx.id, "powerMode", e.target.value)}
                      >
                        <option value="VA">VA</option>
                        <option value="W">W</option>
                      </select>
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        type="number"
                        step="any"
                        value={fx.watt}
                        onChange={(e) => update(fx.id, "watt", e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        type="number"
                        min="0.1"
                        max="1"
                        step="0.1"
                        value={fx.powerFactor}
                        onChange={(e) => update(fx.id, "powerFactor", e.target.value)}
                        disabled={fx.powerMode !== "W"}
                      />
                    </td>
                    <td className="col-center fixture-operation-actions">
                      <ActionIconButton
                        icon="copy"
                        label="Copy Fixture"
                        className="btn-secondary btn-sm"
                        onClick={() => copy(fx.id)}
                      />
                      <ActionIconButton
                        icon="trash"
                        label="Delete Fixture"
                        className="btn-danger-ghost btn-sm"
                        onClick={() => remove(fx.id)}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={8}>
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
