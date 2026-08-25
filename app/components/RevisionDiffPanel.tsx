"use client";

import { useMemo, useState } from "react";
import type { RoomsSubTab } from "../types";
import {
  filterRevisionChangeEntries,
  groupRevisionChangeEntries,
  revisionChangeEntriesToCsv,
  revisionChangeEntriesToText,
  REVISION_CHANGE_FILTERS,
  type RevisionChangeEntry,
  type RevisionChangeFilter,
} from "../lib/revisionChanges";

const FILTER_LABELS: Record<RevisionChangeFilter, string> = {
  all: "All",
  changed: "Changed",
  added: "Added",
  removed: "Removed",
};

/** Rows shown per tab before the "show all" control appears. */
const COLLAPSED_ROW_LIMIT = 8;

export interface RevisionBaseOption {
  value: string;
  label: string;
}

interface RevisionDiffPanelProps {
  entries: readonly RevisionChangeEntry[];
  /** Shown instead of the table when nothing detailed was detected. */
  summaryText: string;
  roomTypeName: string;
  targetRevisionLabel: string;
  baseRevisionLabel: string;
  baseOptions: readonly RevisionBaseOption[];
  baseValue: string;
  onBaseChange: (value: string) => void;
  onJumpToTab?: (tabId: RoomsSubTab) => void;
}

function downloadCsv(fileName: string, csv: string): void {
  // Excel opens UTF-8 CSV correctly only with a BOM.
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function safeFileNamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "revision";
}

export default function RevisionDiffPanel({
  entries,
  summaryText,
  roomTypeName,
  targetRevisionLabel,
  baseRevisionLabel,
  baseOptions,
  baseValue,
  onBaseChange,
  onJumpToTab,
}: RevisionDiffPanelProps): React.JSX.Element {
  const [filter, setFilter] = useState<RevisionChangeFilter>("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  const filteredEntries = useMemo(() => filterRevisionChangeEntries(entries, filter), [entries, filter]);
  const groups = useMemo(() => groupRevisionChangeEntries(filteredEntries), [filteredEntries]);
  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    let changed = 0;
    for (const entry of entries) {
      if (entry.kind === "added") added += 1;
      else if (entry.kind === "removed") removed += 1;
      else changed += 1;
    }
    return { added, removed, changed, total: entries.length };
  }, [entries]);

  const comparisonLabel = `${baseRevisionLabel} → ${targetRevisionLabel}`;

  async function handleCopy(): Promise<void> {
    const text = [`${roomTypeName} ${comparisonLabel}`, "", revisionChangeEntriesToText(filteredEntries)].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be blocked; the CSV button remains available.
      setCopied(false);
    }
  }

  function handleCsv(): void {
    const csv = revisionChangeEntriesToCsv(filteredEntries, {
      roomTypeName,
      baseRevision: baseRevisionLabel,
      targetRevision: targetRevisionLabel,
    });
    downloadCsv(
      `revision-diff-${safeFileNamePart(roomTypeName)}-${safeFileNamePart(baseRevisionLabel)}-to-${safeFileNamePart(targetRevisionLabel)}.csv`,
      csv,
    );
  }

  return (
    <div className="revision-diff-panel">
      <div className="revision-diff-toolbar">
        <div className="revision-diff-compare">
          <label>
            <span className="revision-diff-compare-label">Compare from</span>
            <select
              className="revision-diff-select"
              value={baseValue}
              onChange={(event) => onBaseChange(event.target.value)}
              aria-label={`Comparison base for revision ${targetRevisionLabel}`}
            >
              {baseOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <span className="revision-diff-arrow">→</span>
          <span className="revision-diff-target">{targetRevisionLabel}</span>
        </div>

        <div className="revision-diff-counts" aria-label="Detected change counts">
          <span className="revision-diff-count total">{totals.total}</span>
          {totals.changed > 0 ? <span className="revision-diff-count changed">~{totals.changed}</span> : null}
          {totals.added > 0 ? <span className="revision-diff-count added">+{totals.added}</span> : null}
          {totals.removed > 0 ? <span className="revision-diff-count removed">-{totals.removed}</span> : null}
        </div>

        <div className="revision-diff-filters" role="group" aria-label="Change type filter">
          {REVISION_CHANGE_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              className={`revision-diff-chip${filter === value ? " is-active" : ""}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {FILTER_LABELS[value]}
            </button>
          ))}
        </div>

        <div className="revision-diff-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleCopy} disabled={filteredEntries.length === 0}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleCsv} disabled={filteredEntries.length === 0}>
            CSV
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="revision-diff-empty">{summaryText}</div>
      ) : filteredEntries.length === 0 ? (
        <div className="revision-diff-empty">No changes match this filter.</div>
      ) : (
        <div className="revision-diff-groups">
          {groups.map((group) => {
            const collapsed = collapsedGroups[group.key] ?? false;
            const expanded = expandedGroups[group.key] ?? false;
            const visibleRows = expanded ? group.rows : group.rows.slice(0, COLLAPSED_ROW_LIMIT);
            const hiddenRowCount = group.rows.length - visibleRows.length;
            return (
              <section key={group.key} className="revision-diff-group">
                <header className="revision-diff-group-header">
                  <button
                    type="button"
                    className="revision-diff-toggle"
                    aria-expanded={!collapsed}
                    onClick={() =>
                      setCollapsedGroups((prev) => ({ ...prev, [group.key]: !collapsed }))
                    }
                  >
                    <span className="revision-diff-caret" aria-hidden="true">{collapsed ? "▶" : "▼"}</span>
                    <span className="revision-diff-group-label">{group.label}</span>
                    <span className="revision-diff-group-count">{group.entryCount}</span>
                  </button>
                  {onJumpToTab ? (
                    <button
                      type="button"
                      className="revision-diff-jump"
                      onClick={() => onJumpToTab(group.tabId)}
                      title={`Open the ${group.label} tab`}
                    >
                      Open tab
                    </button>
                  ) : null}
                </header>

                {collapsed ? null : (
                  <>
                    <table className="revision-diff-table">
                      <thead>
                        <tr>
                          <th scope="col">Target</th>
                          <th scope="col">Field</th>
                          <th scope="col">Before</th>
                          <th scope="col">After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleRows.map((row) =>
                          row.entries.map((entry, entryIndex) => (
                            <tr key={entry.key} className={`revision-diff-row is-${entry.kind}`}>
                              {entryIndex === 0 ? (
                                <th scope="row" rowSpan={row.entries.length} className="revision-diff-target-cell">
                                  {row.rowLabel}
                                </th>
                              ) : null}
                              {entry.kind === "changed" ? (
                                <>
                                  <td className="revision-diff-field-cell">{entry.fieldLabel}</td>
                                  <td className="revision-diff-before">{entry.before}</td>
                                  <td className="revision-diff-after">{entry.after}</td>
                                </>
                              ) : (
                                <>
                                  <td className="revision-diff-field-cell">
                                    <span className={`revision-diff-badge ${entry.kind}`}>
                                      {entry.kind === "added" ? "Added" : "Removed"}
                                    </span>
                                  </td>
                                  <td className="revision-diff-rowchange" colSpan={2}>
                                    {entry.kind === "added"
                                      ? "Row added in this revision"
                                      : "Row removed in this revision"}
                                  </td>
                                </>
                              )}
                            </tr>
                          )),
                        )}
                      </tbody>
                    </table>
                    {hiddenRowCount > 0 ? (
                      <button
                        type="button"
                        className="revision-diff-more"
                        onClick={() => setExpandedGroups((prev) => ({ ...prev, [group.key]: true }))}
                      >
                        Show {hiddenRowCount} more rows
                      </button>
                    ) : null}
                    {expanded && group.rows.length > COLLAPSED_ROW_LIMIT ? (
                      <button
                        type="button"
                        className="revision-diff-more"
                        onClick={() => setExpandedGroups((prev) => ({ ...prev, [group.key]: false }))}
                      >
                        Show fewer rows
                      </button>
                    ) : null}
                  </>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
