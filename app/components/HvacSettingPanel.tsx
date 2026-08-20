"use client";

import { useEffect, useMemo, useState } from "react";
import type { SettingTarget } from "../lib/settingTargets";
import type { HvacSeason } from "../types";

interface HvacSettingPanelProps {
  targets: SettingTarget[];
  getValue: (targetId: string) => string;
  onChange: (targetId: string, value: string) => void;
  onChangeMany?: (updates: Array<{ targetId: string; value: string }>) => void;
  title?: string;
  defaultCollapsed?: boolean;
  resetKey?: string;
  seasons?: HvacSeason[];
  disabled?: boolean;
}

const ON_OFF_OPTIONS = ["", "On", "Off", "Blinking (Short)", "Blinking (Long)"] as const;
const FAN_MODE_OPTIONS = ["", "High", "Middle", "Low", "Auto"] as const;

function numberRange(start: number, end: number, step: number): string[] {
  const values: string[] = [];
  for (let value = start; value <= end + 0.0001; value += step) {
    values.push(Number.isInteger(value) ? String(value) : value.toFixed(1));
  }
  return values;
}

function setpointOptions(target: SettingTarget): string[] {
  const low = Number.parseFloat(target.hvacLowEnd || "20");
  const high = Number.parseFloat(target.hvacHighEnd || "28");
  const safeLow = Number.isFinite(low) ? low : 20;
  const safeHigh = Number.isFinite(high) ? high : 28;
  return ["", ...numberRange(Math.min(safeLow, safeHigh), Math.max(safeLow, safeHigh), 0.5)];
}

function driftOptions(sign: "positive" | "negative"): string[] {
  return [
    "",
    ...numberRange(0, 8, 0.5).map((value) => {
      if (value === "0") return "0";
      return sign === "positive" ? `+${value}` : `-${value}`;
    }),
  ];
}

function clampSetpoint(target: SettingTarget, value: string): string {
  if (!value.trim()) return "";
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return "";
  const options = setpointOptions(target).filter(Boolean).map(Number);
  if (options.length === 0) return "";
  const low = Math.min(...options);
  const high = Math.max(...options);
  const rounded = Math.round(n * 2) / 2;
  const clamped = Math.min(high, Math.max(low, rounded));
  return Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(1);
}

function splitDrift(value: string): { positive: string; negative: string } {
  const [positive = "", negative = ""] = value.split("/");
  return { positive, negative };
}

function joinDrift(positive: string, negative: string): string {
  return [positive, negative].filter(Boolean).join("/");
}

function parseSeasonSetpoints(value: string): Record<string, string> {
  const record: Record<string, string> = {};
  value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const separator = part.includes(":") ? ":" : "=";
      const [name = "", raw = ""] = part.split(separator);
      if (name.trim()) record[name.trim()] = raw.trim();
    });
  return record;
}

function formatSeasonSetpoints(record: Record<string, string>, seasons: HvacSeason[]): string {
  return seasons
    .map((season) => {
      const value = record[season.name]?.trim() ?? "";
      return value ? `${season.name}: ${value}` : "";
    })
    .filter(Boolean)
    .join(" / ");
}

function stepDrift(value: string, delta: number, sign: "positive" | "negative"): string {
  const current = Number.parseFloat(value.replace("+", "")) || 0;
  const next = Math.min(8, Math.max(0, Math.round((current + delta) * 2) / 2));
  if (next === 0) return "0";
  const formatted = Number.isInteger(next) ? String(next) : next.toFixed(1);
  return sign === "positive" ? `+${formatted}` : `-${formatted}`;
}

export default function HvacSettingPanel({
  targets,
  getValue,
  onChange,
  onChangeMany,
  title = "HVAC",
  defaultCollapsed = true,
  resetKey = "",
  seasons = [],
  disabled = false,
}: HvacSettingPanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [linkAllHvac, setLinkAllHvac] = useState(false);
  useEffect(() => {
    setCollapsed(defaultCollapsed);
  }, [defaultCollapsed, resetKey]);
  const grouped = useMemo(() => {
    const map = new Map<string, SettingTarget[]>();
    for (const target of targets) {
      if (target.dimmingType !== "HVAC") continue;
      map.set(target.circuitNumber, [...(map.get(target.circuitNumber) ?? []), target]);
    }
    return Array.from(map.entries()).map(([number, items]) => ({ number, items }));
  }, [targets]);

  if (grouped.length === 0) return null;

  function metricKey(target: SettingTarget): string {
    return target.hvacMetric || target.detail || target.id;
  }

  function commitUpdates(updates: Array<{ targetId: string; value: string }>): void {
    if (disabled) return;
    if (updates.length === 0) return;
    if (updates.length > 1 && onChangeMany) {
      onChangeMany(updates);
      return;
    }
    updates.forEach((update) => onChange(update.targetId, update.value));
  }

  function updateLinked(targetId: string, value: string): void {
    if (disabled) return;
    const target = targets.find((item) => item.id === targetId);
    if (!target || !linkAllHvac) {
      onChange(targetId, value);
      return;
    }
    const key = metricKey(target);
    commitUpdates(targets
      .filter((item) => item.dimmingType === "HVAC" && metricKey(item) === key)
      .map((item) => ({ targetId: item.id, value })));
  }

  function toggleLinkAllHvac(checked: boolean): void {
    if (disabled) return;
    setLinkAllHvac(checked);
    if (!checked) return;
    const firstByMetric = new Map<string, SettingTarget>();
    const updates: Array<{ targetId: string; value: string }> = [];
    for (const target of targets) {
      if (target.dimmingType !== "HVAC") continue;
      const key = metricKey(target);
      const first = firstByMetric.get(key);
      if (!first) {
        firstByMetric.set(key, target);
      } else {
        updates.push({ targetId: target.id, value: getValue(first.id) });
      }
    }
    commitUpdates(updates);
  }

  return (
    <div className="hvac-setting-panel">
      <button
        type="button"
        className="switch-area-toggle hvac-setting-toggle"
        onClick={() => setCollapsed((prev) => !prev)}
        aria-expanded={!collapsed}
      >
        <span className="switch-area-caret">{collapsed ? ">" : "v"}</span>
        <span>{title}</span>
        <span className="muted-pill">{grouped.length}</span>
      </button>
      {collapsed ? null : (
        <>
        {grouped.length > 1 ? (
          <label className="cfs-check hvac-link-all">
            <input
              type="checkbox"
              checked={linkAllHvac}
              disabled={disabled}
              onChange={(event) => toggleLinkAllHvac(event.target.checked)}
            />
            Link all HVAC
          </label>
        ) : null}
        <div className="matrix-scroll">
          <table className="matrix-table master-table switch-setting-table hvac-setting-table">
            <colgroup>
              <col className="table-col-hvac-no" />
              <col className="table-col-hvac-item" />
              <col className="table-col-hvac-setting" />
              <col className="table-col-operation-narrow" />
            </colgroup>
            <thead>
              <tr>
                <th>HVAC #</th>
                <th>Item</th>
                <th>Setting</th>
                <th className="col-center">Uneffected</th>
              </tr>
            </thead>
            <tbody>
              {grouped.flatMap((group) =>
                group.items.map((target, index) => {
                  const value = getValue(target.id);
                  return (
                    <tr key={target.id}>
                      {index === 0 ? (
                        <td rowSpan={group.items.length} className="col-center">
                          <span className="cell-readonly">{group.number}</span>
                        </td>
                      ) : null}
                      <td><span className="cell-readonly">{target.detail}</span></td>
                      <td>{renderControl(target, value, updateLinked, seasons, disabled)}</td>
                      <td className="col-center">
                        <button type="button" className="btn-clear-circuit" onClick={() => updateLinked(target.id, "")} disabled={disabled}>
                          Uneffected
                        </button>
                      </td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}

function renderControl(
  target: SettingTarget,
  value: string,
  onChange: (targetId: string, value: string) => void,
  seasons: HvacSeason[],
  disabled: boolean,
) {
  if (target.hvacMetric === "On/Off") {
    return (
      <select className="cell-input" value={value} onChange={(event) => onChange(target.id, event.target.value)} disabled={disabled}>
        {ON_OFF_OPTIONS.map((option) => (
          <option key={option || "Uneffected"} value={option}>{option || "Uneffected"}</option>
        ))}
      </select>
    );
  }

  if (target.hvacMetric === "Setpoint") {
    const options = setpointOptions(target);
    const usableSeasons = seasons.filter((season) => season.name.trim());
    if (usableSeasons.length > 0) {
      const seasonValues = parseSeasonSetpoints(value);
      return (
        <div className="hvac-season-setpoint-grid">
          {usableSeasons.map((season) => {
            const seasonValue = seasonValues[season.name] ?? "";
            const updateSeason = (nextValue: string) => {
              onChange(target.id, formatSeasonSetpoints({ ...seasonValues, [season.name]: nextValue }, usableSeasons));
            };
            return (
              <div key={season.id} className="hvac-season-setpoint-row">
                <span>{season.name}</span>
                <select className="cell-input scene-level-input" value={seasonValue} onChange={(event) => updateSeason(event.target.value)} disabled={disabled}>
                  {options.map((option) => (
                    <option key={`${season.id}-${option || "Uneffected"}`} value={option}>{option || "Uneffected"}</option>
                  ))}
                </select>
                <div className="scene-step-grid switch-step-grid hvac-setpoint-step-grid" aria-label={`${season.name} setpoint adjustment`}>
                  <button type="button" onClick={() => updateSeason(clampSetpoint(target, String(Number.parseFloat(seasonValue || "0") + 0.5)))} disabled={disabled}>+0.5</button>
                  <button type="button" onClick={() => updateSeason(clampSetpoint(target, String(Number.parseFloat(seasonValue || "0") - 0.5)))} disabled={disabled}>-0.5</button>
                </div>
              </div>
            );
          })}
        </div>
      );
    }
    return (
      <div className="scene-level-control hvac-setpoint-control">
        <select className="cell-input scene-level-input" value={value} onChange={(event) => onChange(target.id, event.target.value)} disabled={disabled}>
          {options.map((option) => (
            <option key={option || "Uneffected"} value={option}>{option || "Uneffected"}</option>
          ))}
        </select>
        <div className="scene-step-grid switch-step-grid hvac-setpoint-step-grid" aria-label="Setpoint adjustment">
          <button type="button" onClick={() => onChange(target.id, clampSetpoint(target, String(Number.parseFloat(value || "0") + 0.5)))} disabled={disabled}>+0.5</button>
          <button type="button" onClick={() => onChange(target.id, clampSetpoint(target, String(Number.parseFloat(value || "0") - 0.5)))} disabled={disabled}>-0.5</button>
        </div>
      </div>
    );
  }

  if (target.hvacMetric === "Fan Mode") {
    return (
      <select className="cell-input" value={value} onChange={(event) => onChange(target.id, event.target.value)} disabled={disabled}>
        {FAN_MODE_OPTIONS.map((option) => (
          <option key={option || "Uneffected"} value={option}>{option || "Uneffected"}</option>
        ))}
      </select>
    );
  }

  const drift = splitDrift(value);
  return (
    <div className="hvac-drift-control">
      {(["positive", "negative"] as const).map((sign) => {
        const driftValue = sign === "positive" ? drift.positive : drift.negative;
        const updateDrift = (nextValue: string) => {
          onChange(
            target.id,
            sign === "positive" ? joinDrift(nextValue, drift.negative) : joinDrift(drift.positive, nextValue),
          );
        };
        return (
          <div className="hvac-drift-row" key={sign}>
            <span>{sign === "positive" ? "+" : "-"}</span>
            <select
              className="cell-input"
              value={driftValue}
              onChange={(event) => updateDrift(event.target.value)}
              aria-label={sign === "positive" ? "Positive drift" : "Negative drift"}
              disabled={disabled}
            >
              {driftOptions(sign).map((option) => (
                <option key={`${sign}-${option || "Uneffected"}`} value={option}>{option || "Uneffected"}</option>
              ))}
            </select>
            <div className="scene-step-grid switch-step-grid hvac-setpoint-step-grid" aria-label={`${sign} drift adjustment`}>
              <button type="button" onClick={() => updateDrift(stepDrift(driftValue, 0.5, sign))} disabled={disabled}>+0.5</button>
              <button type="button" onClick={() => updateDrift(stepDrift(driftValue, -0.5, sign))} disabled={disabled}>-0.5</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
