"use client";

import { Fragment, useMemo, useState } from "react";
import type {
  BacklightLevelSetting,
  CircuitEntry,
  CfsCircuit,
  CurtainAssignment,
  DeviceAssignment,
  HvacAssignment,
  HvacSeason,
  LocationMaster,
  Scene,
  SceneCircuitSetting,
  SwitchEntry,
  TriggerMaster,
  RevisionFieldChanges,
} from "../types";
import { createEmptySwitchEntry, normalizeBacklightLevels } from "../lib/constants";
import { backlightStrongColor } from "../lib/backlightColors";
import { isPalladiomBacklightTarget } from "../lib/useCfsZoneRows";
import { useDragReorder } from "../lib/useDragReorder";
import { selectedSceneIdsForSwitch as selectedSceneIds } from "../lib/cfsValueResolver";
import AutoGrowTextarea from "./AutoGrowTextarea";
import Combobox from "./Combobox";
import { buildSettingTargetGroups, hvacSettingTargets as buildHvacSettingTargets, type SettingTarget } from "../lib/settingTargets";
import HvacSettingPanel from "./HvacSettingPanel";
import CurtainActionButtons from "./CurtainActionButtons";
import ActionIconButton from "./ActionIconButton";
import { createAppId } from '../lib/id';

interface CommandViewProps {
  switches: SwitchEntry[];
  scenes: Scene[];
  locations: LocationMaster[];
  circuits: CircuitEntry[];
  deviceAssignments?: DeviceAssignment[];
  cfsRows?: CfsCircuit[];
  curtainAssignments?: CurtainAssignment[];
  hvacAssignments?: HvacAssignment[];
  hvacSeasons?: HvacSeason[];
  backlightLevels?: BacklightLevelSetting[];
  triggerMasters: TriggerMaster[];
  onChange: (next: SwitchEntry[]) => void;
  revisionChanges?: RevisionFieldChanges;
  canEdit?: boolean;
}

interface SwitchOption {
  value: string;
  groupIds: string[];
  label: string;
  name: string;
  kind: SwitchEntry["kind"];
  buttons: SwitchButtonOption[];
}

interface SwitchButtonOption {
  value: string;
  label: string;
}

function switchGroupId(sw: SwitchEntry): string {
  return sw.switchGroupId || sw.id;
}

function getPercent(sw: SwitchEntry, circuitId: string): string {
  return sw.buttonSetting.circuitSettings.find((s) => s.circuitId === circuitId)?.percentage ?? "";
}

function clampPercent(raw: string): string {
  if (raw.trim() === "") return "";
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return "";
  return String(Math.min(100, Math.max(0, Math.round(n))));
}

function setCircuitSetting(sw: SwitchEntry, circuitId: string, percentage: string): SwitchEntry {
  const trimmed = percentage.trim();
  const existing = sw.buttonSetting.circuitSettings.find((s) => s.circuitId === circuitId);
  let nextSettings: SceneCircuitSetting[];

  if (trimmed === "") {
    nextSettings = sw.buttonSetting.circuitSettings.filter((s) => s.circuitId !== circuitId);
  } else if (existing) {
    nextSettings = sw.buttonSetting.circuitSettings.map((s) =>
      s.circuitId === circuitId ? { ...s, percentage: trimmed } : s,
    );
  } else {
    nextSettings = [...sw.buttonSetting.circuitSettings, { circuitId, percentage: trimmed }];
  }

  return {
    ...sw,
    buttonSetting: { ...sw.buttonSetting, circuitSettings: nextSettings },
  };
}

function isCurtainTarget(target: SettingTarget): boolean {
  return target.isCurtain === true || target.dimmingType === "Curtain";
}

export default function CommandView({
  switches,
  scenes,
  locations,
  circuits,
  deviceAssignments = [],
  cfsRows = [],
  curtainAssignments = [],
  hvacAssignments = [],
  hvacSeasons = [],
  backlightLevels,
  triggerMasters,
  onChange,
  revisionChanges = {},
  canEdit = true,
}: CommandViewProps) {
  const [expandedCommandIds, setExpandedCommandIds] = useState<Set<string>>(new Set());
  const [expandedBacklightIds, setExpandedBacklightIds] = useState<Set<string>>(new Set());
  const [expandedAreaKeys, setExpandedAreaKeys] = useState<Set<string>>(new Set());
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  const [bulkApplyMode, setBulkApplyMode] = useState<"scene" | "backlight" | null>(null);
  const drag = useDragReorder(switches, commitCommands, (sw) => sw.id);

  const commands = useMemo(
    () => switches.filter((sw) => sw.kind === "command"),
    [switches],
  );
  const triggerOptions = useMemo(
    () => triggerMasters.map((trigger) => trigger.name.trim()).filter(Boolean),
    [triggerMasters],
  );

  function hasRevisionChange(id: string, fields?: string[]): boolean {
    const changed = revisionChanges[id];
    if (!changed) return false;
    if (!fields) return changed.length > 0;
    return fields.some((field) => changed.includes(field));
  }

  function revisionCellClass(id: string, fields?: string[]): string {
    return hasRevisionChange(id, fields) ? "revision-changed-cell" : "";
  }

  function commitCommands(next: SwitchEntry[]): void {
    if (!canEdit) return;
    onChange(next);
  }

  const switchOptions = useMemo((): SwitchOption[] => {
    const groups = new Map<string, SwitchEntry[]>();
    for (const sw of switches) {
      if (sw.kind === "command" || sw.kind === "qsm") continue;
      const id = switchGroupId(sw);
      groups.set(id, [...(groups.get(id) ?? []), sw]);
    }

    const optionsByValue = new Map<string, SwitchOption>();
    for (const rows of groups.values()) {
      const head = rows[0];
      const name = head.switchName.trim();
      const groupId = switchGroupId(head);
      if (head.kind === "pir") continue;
      const number = head.switchNumber.trim();
      if (!number) continue;
      const value = number;
      const existing = optionsByValue.get(value);
      const buttonMap = new Map<string, string>();
      if (existing) {
        for (const button of existing.buttons) buttonMap.set(button.value, button.label);
      }
      for (const row of rows) {
        const rowButtonValue = row.buttonLabel.trim() || row.buttonFunction.trim();
        if (!rowButtonValue) continue;
        buttonMap.set(rowButtonValue, rowButtonValue);
      }
      optionsByValue.set(value, {
        value,
        groupIds: existing ? Array.from(new Set([...existing.groupIds, groupId])) : [groupId],
        label: number,
        name: existing?.name || name,
        kind: existing?.kind ?? head.kind,
        buttons: Array.from(buttonMap, ([buttonValue, buttonLabel]) => ({ value: buttonValue, label: buttonLabel })),
      });
    }

    return Array.from(optionsByValue.values()).sort((a, b) =>
      a.label.localeCompare(b.label, "en", { numeric: true }),
    );
  }, [switches]);

  const areasWithScenes = useMemo(() => {
    const areaIds = new Set(scenes.map((s) => s.areaId));
    return locations.filter((l) => areaIds.has(l.id));
  }, [scenes, locations]);

  const settingTargetGroups = useMemo(
    () => buildSettingTargetGroups(locations, circuits, deviceAssignments, cfsRows, curtainAssignments, switches),
    [locations, circuits, deviceAssignments, cfsRows, curtainAssignments, switches],
  );
  const hvacSettingTargets = useMemo(
    () => buildHvacSettingTargets(hvacAssignments, locations),
    [hvacAssignments, locations],
  );
  const backlightConditions = useMemo(
    () => normalizeBacklightLevels(backlightLevels),
    [backlightLevels],
  );
  const byScenePalladiomSwitches = useMemo(() => {
    const groups = new Map<string, SwitchEntry>();
    for (const sw of switches) {
      if (sw.kind !== "lutronPd") continue;
      const gid = switchGroupId(sw);
      if (!groups.has(gid)) groups.set(gid, sw);
    }
    return Array.from(groups.values()).filter((sw) => isPalladiomBacklightTarget(sw));
  }, [switches]);

  function addCommand(): void {
    commitCommands([...switches, createEmptySwitchEntry("command")]);
  }

  function update(id: string, fields: Partial<SwitchEntry>): void {
    commitCommands(switches.map((sw) => (sw.id === id ? { ...sw, ...fields } : sw)));
  }

  function remove(id: string): void {
    commitCommands(switches.filter((sw) => sw.id !== id));
  }

  function copyCommand(id: string): void {
    const index = switches.findIndex((sw) => sw.id === id);
    const source = switches[index];
    if (!source) return;
    const copied: SwitchEntry = {
      ...source,
      id: createAppId(),
      switchGroupId: createAppId(),
      buttonSetting: {
        ...source.buttonSetting,
        sceneIds: [...source.buttonSetting.sceneIds],
        circuitSettings: source.buttonSetting.circuitSettings.map((setting) => ({ ...setting })),
      },
      backlightLevels: source.backlightLevels.map((level) => ({ ...level })),
    };
    commitCommands([...switches.slice(0, index + 1), copied, ...switches.slice(index + 1)]);
    setExpandedCommandIds((prev) => new Set([...prev, copied.id]));
  }

  function selectedSwitch(sw: SwitchEntry): SwitchOption | undefined {
    return switchOptions.find(
      (option) => option.value === sw.switchNumber || option.groupIds.includes(sw.switchNumber),
    );
  }

  function sceneForArea(sw: SwitchEntry, areaId: string): string {
    return selectedSceneIds(sw).find((id) => scenes.find((s) => s.id === id)?.areaId === areaId) ?? "";
  }

  function updateButtonSetting(id: string, setting: SwitchEntry["buttonSetting"]): void {
    commitCommands(
      switches.map((sw) =>
        sw.id === id ? { ...sw, buttonSetting: setting } : sw,
      ),
    );
  }

  function setSceneForArea(sw: SwitchEntry, areaId: string, sceneId: string): void {
    const otherSceneIds = selectedSceneIds(sw).filter((id) => {
      const scene = scenes.find((s) => s.id === id);
      return scene && scene.areaId !== areaId;
    });
    const sceneIds = sceneId ? [...otherSceneIds, sceneId] : otherSceneIds;
    updateButtonSetting(sw.id, {
      sceneId: sceneIds[0] ?? "",
      sceneIds,
      circuitSettings: sw.buttonSetting.circuitSettings,
    });
  }

  function handleTargetValueChange(sw: SwitchEntry, target: SettingTarget, raw: string): void {
    const value = target.isOnOff || ["Raise", "Lower", "0.5 sec", "Blinking (Short)", "Blinking (Long)"].includes(raw) ? raw : clampPercent(raw);
    const updated = setCircuitSetting(sw, target.id, value);
    updateButtonSetting(sw.id, updated.buttonSetting);
  }

  function stepTargetPercent(sw: SwitchEntry, target: SettingTarget, delta: number): void {
    const current = Number.parseFloat(getPercent(sw, target.id) || "0");
    handleTargetValueChange(sw, target, String(current + delta));
  }

  function clearCircuitSetting(sw: SwitchEntry, circuitId: string): void {
    const updated = setCircuitSetting(sw, circuitId, "");
    updateButtonSetting(sw.id, updated.buttonSetting);
  }

  function toggleCommand(id: string): void {
    setExpandedCommandIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleBacklight(id: string): void {
    setExpandedBacklightIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function backlightConditionValue(value: string): string {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "-") return "";
    if (/^light$/i.test(trimmed)) return "";
    if (/^master\s*on$/i.test(trimmed)) return "masterOn";
    return backlightConditions.find((level) => level.key === trimmed || level.name === trimmed)?.key ?? trimmed;
  }

  function backlightConditionLabel(raw: string): string {
    const key = backlightConditionValue(raw);
    if (!key) return "";
    return backlightConditions.find((level) => level.key === key)?.name ?? raw.trim();
  }

  function startBulkSetting(mode: "scene" | "backlight"): void {
    const template = commands.find((command) => bulkSelectedIds.has(command.id));
    if (!template) return;
    setBulkApplyMode(mode);
    if (mode === "scene") {
      setExpandedBacklightIds(new Set());
      setExpandedCommandIds(new Set([template.id]));
    } else {
      setExpandedCommandIds(new Set());
      setExpandedBacklightIds(new Set([template.id]));
    }
  }

  function applyBulkSetting(active: SwitchEntry): void {
    const mode = bulkApplyMode;
    if (!mode) return;
    const ids = new Set(bulkSelectedIds);
    commitCommands(
      switches.map((sw) => {
        if (sw.kind !== "command" || !ids.has(sw.id) || sw.id === active.id) return sw;
        if (mode === "scene") {
          return {
            ...sw,
            buttonSetting: JSON.parse(JSON.stringify(active.buttonSetting)) as SwitchEntry["buttonSetting"],
          };
        }
        // Condition only: backlightTarget stays per-command (bulk-copying it
        // would cross-wire target groups, the exact bug fixed on the Switch
        // tab's bulk apply).
        return { ...sw, backlightCondition: active.backlightCondition };
      }),
    );
    setBulkApplyMode(null);
    setBulkSelectedIds(new Set());
    setExpandedCommandIds(new Set());
    setExpandedBacklightIds(new Set());
  }

  function renderBulkApplyBar(mode: "scene" | "backlight", sw: SwitchEntry) {
    if (bulkApplyMode !== mode) return null;
    return (
      <div className="toolbar" style={{ margin: "0.5rem 0.75rem 0" }}>
        <span className="toolbar-spacer" />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!canEdit}
          onClick={() => applyBulkSetting(sw)}
        >
          Apply to {bulkSelectedIds.size} rows
        </button>
      </div>
    );
  }

  function renderBacklightPanel(sw: SwitchEntry) {
    const selectedTargets = new Set(
      sw.backlightTarget.split(",").map((value) => value.trim()).filter(Boolean),
    );
    const updateTargets = (targetId: string, checked: boolean): void => {
      const next = new Set(selectedTargets);
      if (checked) next.add(targetId);
      else next.delete(targetId);
      update(sw.id, { backlightTarget: Array.from(next).join(",") });
    };
    return (
      <div className="scene-card switch-setting-card">
        {renderBulkApplyBar("backlight", sw)}
        <div className="switch-setting-layout switch-backlight-setting-layout">
          <div className="switch-setting-section">
            <div className="switch-setting-title">Target</div>
            <div className="switch-target-list">
              {byScenePalladiomSwitches.length === 0 ? (
                <span className="cell-readonly">No By Scene Palladiom switches.</span>
              ) : (
                byScenePalladiomSwitches.map((target) => {
                  const targetId = switchGroupId(target);
                  return (
                    <label className="switch-target-option" key={targetId}>
                      <input
                        type="checkbox"
                        checked={selectedTargets.has(targetId)}
                        onChange={(e) => updateTargets(targetId, e.target.checked)}
                        disabled={!canEdit}
                      />
                      <span>
                        {[target.switchNumber, target.switchName].filter(Boolean).join(" - ") || "(No switch #)"}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
            {selectedTargets.size > 0 ? (
              <button
                type="button"
                className="btn-clear-circuit"
                style={{ marginTop: "0.5rem" }}
                onClick={() => update(sw.id, { backlightTarget: "" })}
                disabled={!canEdit}
              >
                Clear Target
              </button>
            ) : null}
          </div>
          <div className="switch-setting-section">
            <div className="switch-setting-title">Condition</div>
            <select
              className="cell-input"
              value={backlightConditionValue(sw.backlightCondition)}
              onChange={(e) => update(sw.id, { backlightCondition: e.target.value })}
              disabled={!canEdit}
            >
              <option value="" disabled>Uneffected</option>
              {backlightConditions.map((condition) => (
                <option key={condition.key} value={condition.key}>
                  {condition.name}
                </option>
              ))}
            </select>
            {backlightConditionValue(sw.backlightCondition) ? (
              <button
                type="button"
                className="btn-clear-circuit"
                style={{ marginTop: "0.5rem" }}
                onClick={() => update(sw.id, { backlightCondition: "" })}
                disabled={!canEdit}
              >
                Uneffected
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  function areaKey(commandId: string, areaId: string): string {
    return `${commandId}:${areaId}`;
  }

  function toggleArea(commandId: string, areaId: string): void {
    const key = areaKey(commandId, areaId);
    setExpandedAreaKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderSettingPanel(sw: SwitchEntry) {
    return (
      <div className="scene-card switch-setting-card">
        {renderBulkApplyBar("scene", sw)}
        <div className="switch-setting-layout">
          <div className="switch-setting-section switch-setting-scene-section">
            <div className="switch-setting-title">Area Scene</div>
            <div className="matrix-scroll">
              <table className="matrix-table master-table switch-setting-table switch-scene-table">
                <thead>
                  <tr>
                    <th>Area</th>
                    <th>Scene</th>
                    <th className="col-center">Clear</th>
                  </tr>
                </thead>
                <tbody>
                  {areasWithScenes.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="screen-empty">
                        No areas with scenes are registered.
                      </td>
                    </tr>
                  ) : (
                    areasWithScenes.map((area) => {
                      const areaScenes = scenes.filter((scene) => scene.areaId === area.id);
                      return (
                        <tr key={area.id}>
                          <td><span className="cell-readonly">{area.name || "(No name)"}</span></td>
                          <td>
                            <select
                              className="cell-input"
                              value={sceneForArea(sw, area.id)}
                              onChange={(e) => setSceneForArea(sw, area.id, e.target.value)}
                              disabled={!canEdit}
                            >
                              <option value="">-</option>
                              {areaScenes.map((scene, index) => (
                                <option key={scene.id} value={scene.id}>
                                  {scene.name || `Scene ${index + 1}`}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="col-center">
                            <button
                              type="button"
                              className="btn-clear-circuit"
                              onClick={() => setSceneForArea(sw, area.id, "")}
                              disabled={!canEdit}
                            >
                              Clear
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="switch-setting-section switch-setting-individual-section">
            <div className="switch-setting-title">Individual Override</div>
            <div className="switch-individual-list">
              {settingTargetGroups.length === 0 ? (
                <p className="screen-empty">No circuits are registered.</p>
              ) : (
                settingTargetGroups.map((area) => {
                  const open = expandedAreaKeys.has(areaKey(sw.id, area.id));
                  const hasAreaSetting = area.targets.some((target) => getPercent(sw, target.id).trim() !== "");
                  return (
                    <div className="switch-area-panel" key={area.id}>
                      <button
                        type="button"
                        className={`switch-area-toggle${hasAreaSetting ? " has-setting" : ""}`}
                        onClick={() => toggleArea(sw.id, area.id)}
                        aria-expanded={open}
                      >
                        <span className="switch-area-caret">{open ? "v" : ">"}</span>
                        <span>{area.name || "(No name)"}</span>
                        <span className="muted-pill">{area.targets.length}</span>
                      </button>
                      {open ? (
                        <div className="matrix-scroll">
                          <table className="matrix-table master-table switch-setting-table switch-individual-table">
                            <thead>
                              <tr>
                                <th>Circuit #</th>
                                <th>Dimming Type</th>
                                <th>Detail</th>
                                <th>Override</th>
                              </tr>
                            </thead>
                            <tbody>
                              {area.targets.map((target) => {
                                const value = getPercent(sw, target.id);
                                return (
                                  <tr key={target.id}>
                                    <td><span className="cell-readonly">{target.circuitNumber}</span></td>
                                    <td><span className="cell-readonly">{target.dimmingType || "-"}</span></td>
                                    <td><span className="cell-readonly">{target.detail}</span></td>
                                    <td>
                                      {isCurtainTarget(target) ? (
                                        <CurtainActionButtons
                                          value={value}
                                          onChange={(nextValue) => handleTargetValueChange(sw, target, nextValue)}
                                          disabled={!canEdit}
                                        />
                                      ) : target.isOnOff ? (
                                        <div className="scene-level-control scene-onoff-control switch-override-control">
                                          <select
                                            className="cell-input"
                                            value={value === "On" || value === "Off" || value === "0.5 sec" || value === "Blinking (Short)" || value === "Blinking (Long)" ? value : ""}
                                            onChange={(e) => handleTargetValueChange(sw, target, e.target.value)}
                                            disabled={!canEdit}
                                          >
                                            <option value="">Uneffected</option>
                                            <option value="Off">Off</option>
                                            <option value="On">On</option>
                                            <option value="Blinking (Short)">Blinking (Short)</option>
                                            <option value="Blinking (Long)">Blinking (Long)</option>
                                            <option value="0.5 sec">0.5 sec</option>
                                          </select>
                                          <button
                                            type="button"
                                            className="btn-clear-circuit"
                                            onClick={() => clearCircuitSetting(sw, target.id)}
                                            disabled={!canEdit}
                                          >
                                            Clear
                                          </button>
                                        </div>
                                      ) : (
                                        <div className="scene-level-control switch-override-control">
                                          <input
                                            className="cell-input scene-level-input"
                                            type="text"
                                            min="0"
                                            max="100"
                                            step="1"
                                            value={value}
                                            onChange={(e) => handleTargetValueChange(sw, target, e.target.value)}
                                            disabled={!canEdit}
                                          />
                                          <div className="scene-step-grid switch-step-grid" aria-label="Level adjustment">
                                            <button type="button" onClick={() => stepTargetPercent(sw, target, 1)} disabled={!canEdit}>+1</button>
                                            <button type="button" onClick={() => stepTargetPercent(sw, target, 10)} disabled={!canEdit}>+10</button>
                                            <button type="button" onClick={() => stepTargetPercent(sw, target, -1)} disabled={!canEdit}>-1</button>
                                            <button type="button" onClick={() => stepTargetPercent(sw, target, -10)} disabled={!canEdit}>-10</button>
                                          </div>
                                          <button
                                            type="button"
                                            className="btn-clear-circuit"
                                            onClick={() => clearCircuitSetting(sw, target.id)}
                                            disabled={!canEdit}
                                          >
                                            Clear
                                          </button>
                                          <div className="scene-quick-buttons area-scene-extra-buttons">
                                            {["Raise", "Lower"].map((option) => (
                                              <button
                                                key={option}
                                                type="button"
                                                className={value === option ? "is-active" : ""}
                                                onClick={() => handleTargetValueChange(sw, target, option)}
                                                disabled={!canEdit}
                                              >
                                                {option}
                                              </button>
                                            ))}
                                          </div>
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
            <HvacSettingPanel
              targets={hvacSettingTargets}
              getValue={(targetId) => getPercent(sw, targetId)}
              onChange={(targetId, value) => {
                const updated = setCircuitSetting(sw, targetId, value);
                updateButtonSetting(sw.id, updated.buttonSetting);
              }}
              onChangeMany={(updates) => {
                const updated = updates.reduce(
                  (next, update) => setCircuitSetting(next, update.targetId, update.value),
                  sw,
                );
                updateButtonSetting(sw.id, updated.buttonSetting);
              }}
              defaultCollapsed={!hvacSettingTargets.some((target) => getPercent(sw, target.id).trim() !== "")}
              resetKey={sw.id}
              seasons={hvacSeasons}
              disabled={!canEdit}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="card card-padded fade-in">
      <div className="toolbar">
        <span className="toolbar-spacer" />
        <span className="muted-pill" aria-live="polite">
          {bulkSelectedIds.size} checked
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!canEdit || bulkSelectedIds.size === 0}
          onClick={() => startBulkSetting("scene")}
          title="Open the setting panel and apply it to every checked row"
        >
          Scene Setting
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!canEdit || bulkSelectedIds.size === 0}
          onClick={() => startBulkSetting("backlight")}
          title="Open the backlight setting panel and apply it to every checked row"
        >
          Backlight Setting
        </button>
      </div>
      <div className="matrix-scroll">
        <table className="matrix-table master-table switch-table">
          <colgroup>
            <col className="table-col-drag" />
            <col className="table-col-no" />
            <col className="switch-col-function" />
            <col className="switch-col-number" />
            <col className="switch-col-name" />
            <col className="switch-col-button-label" />
            <col className="switch-col-condition" />
            <col className="switch-col-bulk-select" />
            <col className="switch-col-setting" />
            <col className="switch-col-setting" />
            <col className="switch-col-operation" />
          </colgroup>
          <thead>
            <tr>
              <th />
              <th className="col-center">No</th>
              <th>Command Name</th>
              <th>Switch #</th>
              <th>Switch Name</th>
              <th>Button</th>
              <th>Trigger Condition</th>
              <th className="col-center switch-bulk-select-header">
                <input
                  type="checkbox"
                  aria-label="Select all rows for bulk setting"
                  checked={commands.length > 0 && commands.every((command) => bulkSelectedIds.has(command.id))}
                  disabled={!canEdit || commands.length === 0}
                  onChange={(event) => {
                    setBulkSelectedIds(
                      event.target.checked ? new Set(commands.map((command) => command.id)) : new Set(),
                    );
                  }}
                />
              </th>
              <th className="col-center">Setting</th>
              <th className="col-center">Backlight Setting</th>
              <th className="col-center">Operation</th>
            </tr>
          </thead>
          <tbody>
            {commands.length === 0 ? (
              <tr>
                <td colSpan={11} className="screen-empty">
                  No commands are registered. Add a row below.
                </td>
              </tr>
            ) : (
              commands.map((command, index) => {
                const selected = selectedSwitch(command);
                const selectedSwitchValue = selected?.value ?? "";
                const expanded = expandedCommandIds.has(command.id);
                const isContactSwitch = selected?.kind === "contact";
                const isDragging = drag.draggingKey === command.id;
                const isDropTarget = drag.dragOverInfo?.targetKey === command.id;
                return (
                  <Fragment key={command.id}>
                    <tr
                      className={[
                        isDragging ? "row-dragging" : "",
                        isDropTarget && drag.dragOverInfo?.position === "before" ? "drop-before" : "",
                        isDropTarget && drag.dragOverInfo?.position === "after" ? "drop-after" : "",
                      ].filter(Boolean).join(" ")}
                      onDragOver={(e) => drag.onDragOver(e, command.id)}
                      onDrop={(e) => drag.onDrop(e, command.id)}
                    >
                      <td className="col-center drag-handle-cell">
                        <span
                          className="drag-handle"
                          draggable={canEdit}
                          onDragStart={(e) => drag.onDragStart(e, command.id)}
                          onDragEnd={drag.onDragEnd}
                          title="Drag to reorder"
                        >
                          ::
                        </span>
                      </td>
                      <td className="col-center">{index + 1}</td>
                      <td className={revisionCellClass(command.id, ["switchName"])}>
                        <AutoGrowTextarea
                          value={command.switchName}
                          onChange={(value) => update(command.id, { switchName: value })}
                          disabled={!canEdit}
                        />
                      </td>
                      <td className={revisionCellClass(command.id, ["switchNumber"])}>
                        <select
                          className="cell-input"
                          value={selectedSwitchValue}
                          onChange={(e) => {
                            const nextSwitch = switchOptions.find((option) => option.value === e.target.value);
                            const nextButtonLabel = nextSwitch?.buttons.some((button) => button.value === command.buttonLabel)
                              ? command.buttonLabel
                              : "";
                            update(command.id, {
                              switchNumber: e.target.value,
                              buttonLabel: nextSwitch?.kind === "contact" ? "" : nextButtonLabel,
                            });
                          }}
                          disabled={!canEdit}
                        >
                          <option value="">-</option>
                          {switchOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <span className="cell-readonly">{selected?.name || "-"}</span>
                      </td>
                      <td className={[isContactSwitch ? "cell-reserved" : "", revisionCellClass(command.id, ["buttonLabel"])].filter(Boolean).join(" ")}>
                        {isContactSwitch ? (
                          <span className="cell-readonly">-</span>
                        ) : (
                          <select
                            className="cell-input"
                            value={command.buttonLabel}
                            onChange={(e) => update(command.id, { buttonLabel: e.target.value })}
                            disabled={!canEdit || !selected}
                          >
                            <option value="">-</option>
                            {(selected?.buttons ?? []).map((button) => (
                              <option key={button.value} value={button.value}>
                                {button.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className={revisionCellClass(command.id, ["condition"])}>
                        <Combobox
                          value={command.condition}
                          options={triggerOptions}
                          onChange={(value) => update(command.id, { condition: value })}
                          ariaLabel="Trigger Condition"
                          disabled={!canEdit}
                        />
                      </td>
                      <td className="col-center switch-bulk-select-cell">
                        <input
                          type="checkbox"
                          aria-label="Select row for bulk setting"
                          checked={bulkSelectedIds.has(command.id)}
                          disabled={!canEdit}
                          onChange={(event) => {
                            setBulkSelectedIds((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(command.id);
                              else next.delete(command.id);
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td className={`col-center ${revisionCellClass(command.id, ["buttonSetting"])}`}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => toggleCommand(command.id)}
                        >
                          {expanded ? "Close" : "Setting"}
                        </button>
                      </td>
                      <td className={`col-center ${revisionCellClass(command.id, ["backlightTarget", "backlightCondition"])}`}>
                        {(() => {
                          const label = backlightConditionLabel(command.backlightCondition);
                          const strong = label ? backlightStrongColor(label) : null;
                          const blExpanded = expandedBacklightIds.has(command.id);
                          return (
                            <button
                              type="button"
                              className={[
                                "btn",
                                "btn-primary",
                                "btn-sm",
                                "setting-status-button",
                                label || command.backlightTarget.trim() ? "has-setting" : "",
                              ].filter(Boolean).join(" ")}
                              style={strong ? { backgroundColor: strong, borderColor: strong, color: "#fff" } : undefined}
                              onClick={() => toggleBacklight(command.id)}
                            >
                              {blExpanded ? "Close" : label || "Setting"}
                            </button>
                          );
                        })()}
                      </td>
                      <td className="col-center">
                        <ActionIconButton
                          icon="copy"
                          label="Copy Command"
                          className="btn-secondary btn-sm"
                          onClick={() => copyCommand(command.id)}
                          disabled={!canEdit}
                        />
                        <ActionIconButton
                          icon="trash"
                          label="Delete Command"
                          className="btn-danger-ghost"
                          onClick={() => remove(command.id)}
                          disabled={!canEdit}
                        />
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="switch-setting-row">
                        <td colSpan={11} style={{ padding: 0 }}>
                          {renderSettingPanel(command)}
                        </td>
                      </tr>
                    ) : null}
                    {expandedBacklightIds.has(command.id) ? (
                      <tr className="switch-setting-row">
                        <td colSpan={11} style={{ padding: 0 }}>
                          {renderBacklightPanel(command)}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={11}>
                <button className="btn-add-row" onClick={addCommand} disabled={!canEdit}>
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
