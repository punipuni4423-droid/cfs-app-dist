"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HvacAssignment, HvacSeason, LocationMaster } from "../types";
import {
  HVAC_PROTOCOL_OPTIONS,
  HVAC_THERMOSTAT_ROLE_OPTIONS,
  HVAC_TEMPERATURE_OPTIONS,
  createDefaultHvacSeasons,
  createEmptyHvacAssignment,
  createEmptyHvacSeason,
} from "../lib/constants";
import ActionIconButton from "./ActionIconButton";

interface HvacAssignViewProps {
  assignments: HvacAssignment[];
  seasons: HvacSeason[];
  locations: LocationMaster[];
  onAssignmentsChange: (next: HvacAssignment[]) => void;
  onSeasonsChange: (next: HvacSeason[]) => void;
  canEdit?: boolean;
}

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(month: string): number {
  const m = Number.parseInt(month, 10);
  if ([4, 6, 9, 11].includes(m)) return 30;
  if (m === 2) return 29;
  return 31;
}

function monthDayLabel(month: string, day: string): string {
  return `${month || "1"}/${day || "1"}`;
}

function normalizedMonthDay(month: string, day: string): { month: string; day: string } {
  const parsedMonth = Number.parseInt(month, 10);
  const safeMonth = Number.isFinite(parsedMonth)
    ? Math.min(12, Math.max(1, parsedMonth))
    : 1;
  const parsedDay = Number.parseInt(day, 10);
  const safeDay = Number.isFinite(parsedDay)
    ? Math.min(daysInMonth(String(safeMonth)), Math.max(1, parsedDay))
    : 1;
  return { month: String(safeMonth), day: String(safeDay) };
}

function dayOfYear(month: string, day: string): number {
  const safe = normalizedMonthDay(month, day);
  const monthIndex = Number.parseInt(safe.month, 10) - 1;
  const dayNumber = Number.parseInt(safe.day, 10);
  return MONTH_LENGTHS.slice(0, monthIndex).reduce((sum, length) => sum + length, 0) + dayNumber;
}

function monthDayFromDayOfYear(raw: number): { month: string; day: string } {
  let day = ((raw - 1) % 366 + 366) % 366 + 1;
  for (let index = 0; index < MONTH_LENGTHS.length; index += 1) {
    const length = MONTH_LENGTHS[index];
    if (day <= length) {
      return { month: String(index + 1), day: String(day) };
    }
    day -= length;
  }
  return { month: "12", day: "31" };
}

function addDays(month: string, day: string, delta: number): { month: string; day: string } {
  return monthDayFromDayOfYear(dayOfYear(month, day) + delta);
}

function normalizeSeasonBoundaries(rows: HvacSeason[]): HvacSeason[] {
  const normalized = rows.map((row) => {
    const start = normalizedMonthDay(row.startMonth, row.startDay);
    const end = normalizedMonthDay(row.endMonth, row.endDay);
    return {
      ...row,
      startMonth: start.month,
      startDay: start.day,
      endMonth: end.month,
      endDay: end.day,
    };
  });
  if (normalized.length < 2) return normalized;
  return normalized.map((row, index) => {
    const previous = normalized[(index - 1 + normalized.length) % normalized.length];
    const start = addDays(previous.endMonth, previous.endDay, 1);
    return { ...row, startMonth: start.month, startDay: start.day };
  });
}

interface MonthDayPickerProps {
  month: string;
  day: string;
  onChange: (next: { month: string; day: string }) => void;
  disabled?: boolean;
}

interface MonthDayPickerPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

function MonthDayPicker({ month, day, onChange, disabled = false }: MonthDayPickerProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<MonthDayPickerPosition | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const safeMonth = month || "1";
  const safeDay = day || "1";
  const dayOptions = Array.from({ length: daysInMonth(safeMonth) }, (_, i) => String(i + 1));

  useEffect(() => {
    setMounted(true);
  }, []);

  useLayoutEffect(() => {
    if (!open || disabled) return;
    function recompute(): void {
      const trigger = wrapRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const desiredWidth = Math.max(240, rect.width);
      const measuredHeight = pickerRef.current?.offsetHeight || 126;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      const flipUp = spaceBelow < measuredHeight && spaceAbove > spaceBelow;
      const availableHeight = Math.max(112, flipUp ? spaceAbove : spaceBelow);
      const maxHeight = Math.min(260, availableHeight);
      const rawTop = flipUp ? rect.top - Math.min(measuredHeight, maxHeight) - 4 : rect.bottom + 4;
      const rawLeft = rect.left;
      setPos({
        top: Math.max(margin, Math.min(rawTop, window.innerHeight - maxHeight - margin)),
        left: Math.max(margin, Math.min(rawLeft, window.innerWidth - desiredWidth - margin)),
        width: desiredWidth,
        maxHeight,
      });
    }
    recompute();
    const raf = requestAnimationFrame(recompute);
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [disabled, open, safeMonth, safeDay]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (wrapRef.current?.contains(target)) return;
      if (pickerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  function updateMonth(nextMonth: string): void {
    if (disabled) return;
    const maxDay = daysInMonth(nextMonth);
    const nextDay = String(Math.min(Number.parseInt(safeDay, 10) || 1, maxDay));
    onChange({ month: nextMonth, day: nextDay });
  }

  const picker =
    open && pos ? (
      <div
        ref={pickerRef}
        className="month-day-picker-popover"
        style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
          width: pos.width,
          maxHeight: pos.maxHeight,
          zIndex: 6000,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="month-day-picker-grid">
          <label>
            <span className="sr-only">Month</span>
            <select
              className="cell-input"
              value={safeMonth}
              disabled={disabled}
              onChange={(e) => updateMonth(e.target.value)}
            >
              {MONTH_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  Month {option}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Day</span>
            <select
              className="cell-input"
              value={safeDay}
              disabled={disabled}
              onChange={(e) => onChange({ month: safeMonth, day: e.target.value })}
            >
              {dayOptions.map((option) => (
                <option key={option} value={option}>
                  Day {option}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="month-day-picker-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>
            OK
          </button>
        </div>
      </div>
    ) : null;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="cell-input"
        style={{ textAlign: "left", width: "100%" }}
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev);
        }}
        disabled={disabled}
      >
        {monthDayLabel(safeMonth, safeDay)}
      </button>
      {mounted && picker ? createPortal(picker, document.body) : null}
    </div>
  );
}

export default function HvacAssignView({
  assignments,
  seasons,
  locations,
  onAssignmentsChange,
  onSeasonsChange,
  canEdit = true,
}: HvacAssignViewProps) {
  const visibleSeasons = seasons.length > 0 ? seasons : createDefaultHvacSeasons();
  const [linkAllHvac, setLinkAllHvac] = useState(false);

  function updateAssignment(id: string, patch: Partial<HvacAssignment>): void {
    if (!canEdit) return;
    const linkedPatch: Partial<HvacAssignment> = {};
    if (linkAllHvac) {
      if (patch.protocol !== undefined) linkedPatch.protocol = patch.protocol;
      if (patch.lowEnd !== undefined) linkedPatch.lowEnd = patch.lowEnd;
      if (patch.highEnd !== undefined) linkedPatch.highEnd = patch.highEnd;
      if (patch.summerWinterChange !== undefined) linkedPatch.summerWinterChange = patch.summerWinterChange;
    }
    const hasLinkedPatch = Object.keys(linkedPatch).length > 0;
    onAssignmentsChange(
      assignments.map((row) =>
        row.id === id
          ? { ...row, ...patch }
          : hasLinkedPatch
            ? { ...row, ...linkedPatch }
            : row,
      ),
    );
  }

  function addAssignment(): void {
    if (!canEdit) return;
    onAssignmentsChange([...assignments, createEmptyHvacAssignment()]);
  }

  function deleteAssignment(id: string): void {
    if (!canEdit) return;
    const next = assignments.filter((row) => row.id !== id);
    onAssignmentsChange(next);
  }

  function updateSeason(id: string, patch: Partial<HvacSeason>): void {
    if (!canEdit) return;
    onSeasonsChange(normalizeSeasonBoundaries(visibleSeasons.map((row) => (row.id === id ? { ...row, ...patch } : row))));
  }

  function updateSeasonDate(
    id: string,
    edge: "start" | "end",
    next: { month: string; day: string },
  ): void {
    if (!canEdit) return;
    const index = visibleSeasons.findIndex((row) => row.id === id);
    if (index === -1) return;
    const rows = visibleSeasons.map((row) => ({ ...row }));
    if (edge === "start") {
      rows[index].startMonth = next.month;
      rows[index].startDay = next.day;
      if (rows.length > 1) {
        const previousIndex = (index - 1 + rows.length) % rows.length;
        const previousEnd = addDays(next.month, next.day, -1);
        rows[previousIndex].endMonth = previousEnd.month;
        rows[previousIndex].endDay = previousEnd.day;
      }
    } else {
      rows[index].endMonth = next.month;
      rows[index].endDay = next.day;
      if (rows.length > 1) {
        const nextIndex = (index + 1) % rows.length;
        const nextStart = addDays(next.month, next.day, 1);
        rows[nextIndex].startMonth = nextStart.month;
        rows[nextIndex].startDay = nextStart.day;
      }
    }
    onSeasonsChange(normalizeSeasonBoundaries(rows));
  }

  function addSeason(): void {
    if (!canEdit) return;
    const last = visibleSeasons.at(-1);
    const first = visibleSeasons[0];
    const start = last ? addDays(last.endMonth, last.endDay, 1) : { month: "1", day: "1" };
    const end = first ? addDays(first.startMonth, first.startDay, -1) : { month: "12", day: "31" };
    onSeasonsChange(normalizeSeasonBoundaries([
      ...visibleSeasons,
      {
        ...createEmptyHvacSeason(),
        name: `Season ${visibleSeasons.length + 1}`,
        startMonth: start.month,
        startDay: start.day,
        endMonth: end.month,
        endDay: end.day,
      },
    ]));
  }

  function deleteSeason(id: string): void {
    if (!canEdit) return;
    const next = visibleSeasons.filter((row) => row.id !== id);
    onSeasonsChange(next.length > 0 ? normalizeSeasonBoundaries(next) : createDefaultHvacSeasons());
  }

  return (
    <>
      <div className="toolbar">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={linkAllHvac}
            onChange={(event) => setLinkAllHvac(event.target.checked)}
            disabled={!canEdit}
          />
          Link all HVAC
        </label>
      </div>

      <div className="matrix-scroll">
        <table className="matrix-table master-table">
          <thead>
            <tr>
              <th style={{ minWidth: 64 }}>No</th>
              <th style={{ minWidth: 150 }}>Control Type</th>
              <th style={{ minWidth: 120 }}>Master / Slave</th>
              <th style={{ minWidth: 180 }}>Area</th>
              <th style={{ minWidth: 120 }}>Low End</th>
              <th style={{ minWidth: 120 }}>High End</th>
              <th style={{ minWidth: 170 }}>Summer / Winter</th>
              <th style={{ minWidth: 220 }}>Note</th>
              <th className="col-center" style={{ minWidth: 90 }}>Operation</th>
            </tr>
          </thead>
          <tbody>
            {assignments.length === 0 ? (
              <tr>
                <td colSpan={9} className="screen-empty">
                  No HVAC assignments are registered. Add one below.
                </td>
              </tr>
            ) : (
              assignments.map((row, index) => (
                <tr key={row.id}>
                  <td className="col-center">{index + 1}</td>
                  <td>
                    <select
                      className="cell-input"
                      value={row.protocol}
                      disabled={!canEdit}
                      onChange={(e) =>
                        updateAssignment(row.id, {
                          protocol: e.target.value as HvacAssignment["protocol"],
                        })
                      }
                    >
                      {HVAC_PROTOCOL_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="cell-input"
                      value={row.thermostatRole}
                      disabled={!canEdit}
                      onChange={(e) =>
                        updateAssignment(row.id, {
                          thermostatRole: e.target.value as HvacAssignment["thermostatRole"],
                        })
                      }
                    >
                      {HVAC_THERMOSTAT_ROLE_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="cell-input"
                      value={row.area}
                      disabled={!canEdit}
                      onChange={(e) => updateAssignment(row.id, { area: e.target.value })}
                    >
                      <option value="">-</option>
                      {locations.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.name || "(No name)"}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="cell-input"
                      value={row.lowEnd}
                      disabled={!canEdit}
                      onChange={(e) => updateAssignment(row.id, { lowEnd: e.target.value })}
                    >
                      {HVAC_TEMPERATURE_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option} C</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="cell-input"
                      value={row.highEnd}
                      disabled={!canEdit}
                      onChange={(e) => updateAssignment(row.id, { highEnd: e.target.value })}
                    >
                      {HVAC_TEMPERATURE_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option} C</option>
                      ))}
                    </select>
                  </td>
                  <td className="col-center">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={row.summerWinterChange}
                        disabled={!canEdit}
                        onChange={(e) =>
                          updateAssignment(row.id, { summerWinterChange: e.target.checked })
                        }
                      />
                      Enable
                    </label>
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      value={row.note}
                      disabled={!canEdit}
                      onChange={(e) => updateAssignment(row.id, { note: e.target.value })}
                    />
                  </td>
                  <td className="col-center">
                    <ActionIconButton
                      icon="trash"
                      label="Delete HVAC"
                      className="btn-danger-ghost"
                      onClick={() => deleteAssignment(row.id)}
                      disabled={!canEdit}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={9}>
                <button type="button" className="btn-add-row" onClick={addAssignment} disabled={!canEdit}>
                  + HVAC Add
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="screen-section" style={{ marginTop: "1rem" }}>
        <div className="toolbar">
          <strong>Season Schedule</strong>
          <span className="toolbar-spacer" />
          <button type="button" className="btn btn-secondary btn-sm" onClick={addSeason} disabled={!canEdit}>
            + Season
          </button>
        </div>
        <div className="matrix-scroll">
          <table className="matrix-table master-table">
            <thead>
              <tr>
                <th style={{ minWidth: 160 }}>Season</th>
                <th style={{ minWidth: 170 }}>Start Date</th>
                <th style={{ minWidth: 170 }}>End Date</th>
                <th className="col-center" style={{ minWidth: 90 }}>Operation</th>
              </tr>
            </thead>
            <tbody>
              {visibleSeasons.map((row) => (
                <tr key={row.id}>
                  <td>
                    <input
                      className="cell-input"
                      value={row.name}
                      disabled={!canEdit}
                      onChange={(e) => updateSeason(row.id, { name: e.target.value })}
                    />
                  </td>
                  <td>
                    <MonthDayPicker
                      month={row.startMonth}
                      day={row.startDay}
                      disabled={!canEdit}
                      onChange={(next) => updateSeasonDate(row.id, "start", next)}
                    />
                  </td>
                  <td>
                    <MonthDayPicker
                      month={row.endMonth}
                      day={row.endDay}
                      disabled={!canEdit}
                      onChange={(next) => updateSeasonDate(row.id, "end", next)}
                    />
                  </td>
                  <td className="col-center">
                    <ActionIconButton
                      icon="trash"
                      label="Delete Season"
                      className="btn-danger-ghost"
                      onClick={() => deleteSeason(row.id)}
                      disabled={!canEdit}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
