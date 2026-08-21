"use client";

import type { BacklightLevelSetting, RevisionFieldChanges, RoomScene, SwitchEntry } from "../types";
import { createDefaultBacklightLevels, normalizeBacklightLevels } from "../lib/constants";
import { useDragReorder } from "../lib/useDragReorder";
import ActionIconButton from "./ActionIconButton";
import AutoGrowTextarea from "./AutoGrowTextarea";
import { createAppId } from '../lib/id';

const BY_SCENE_VALUE = "__byScene";

interface BacklightViewProps {
  switches: SwitchEntry[];
  backlightLevels?: BacklightLevelSetting[];
  // Updater form applies against the CURRENT state; array snapshots built from
  // the props could overwrite edits made moments earlier (By-Scene un-setting).
  onChange: (next: SwitchEntry[] | ((current: SwitchEntry[]) => SwitchEntry[])) => void;
  onBacklightLevelsChange?: (
    next: BacklightLevelSetting[] | ((current: BacklightLevelSetting[]) => BacklightLevelSetting[]),
  ) => void;
  roomScenes?: RoomScene[];
  onRoomScenesChange?: (next: RoomScene[] | ((current: RoomScene[]) => RoomScene[])) => void;
  revisionChanges?: RevisionFieldChanges;
  backlightLogicChanged?: boolean;
  canEdit?: boolean;
}

function switchGroupId(sw: SwitchEntry): string {
  return sw.switchGroupId || sw.id;
}

function clampPercent(raw: string): string {
  if (raw.trim() === "") return "";
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return "";
  return String(Math.min(100, Math.max(0, Math.round(n))));
}

function backlightSceneValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return "";
  if (/^light$/i.test(trimmed)) return "";
  if (/^master\s*on$/i.test(trimmed)) return "masterOn";
  const defaults = createDefaultBacklightLevels();
  return defaults.find((level) => level.key === trimmed || level.name === trimmed)?.key ?? trimmed;
}

function palladiomBacklightSceneValue(value: string): string {
  return backlightSceneValue(value) || BY_SCENE_VALUE;
}

// A group's rows can legitimately hold per-row conditions (set from the
// Switch tab), so the assignment dropdown must never present one arbitrary
// row's value as the group value: entry order changes would make the display
// "flip" (e.g. By Scene apparently turning into a level), and re-saving the
// flipped value would wipe the per-row settings.
const MIXED_VALUE = "__mixed";

function groupBacklightSceneValue(entries: SwitchEntry[]): string {
  const values = new Set(
    entries.map((entry) => palladiomBacklightSceneValue(entry.backlightAssignment || BY_SCENE_VALUE)),
  );
  if (values.size === 1) return values.values().next().value ?? BY_SCENE_VALUE;
  return MIXED_VALUE;
}

export default function BacklightView({
  switches,
  backlightLevels,
  onChange,
  onBacklightLevelsChange,
  roomScenes = [],
  onRoomScenesChange,
  revisionChanges = {},
  backlightLogicChanged = false,
  canEdit = true,
}: BacklightViewProps) {
  const palladiomSwitches = switches.reduce<SwitchEntry[]>((items, sw) => {
    if (sw.kind !== "lutronPd") return items;
    if (items.some((item) => switchGroupId(item) === switchGroupId(sw))) return items;
    return [...items, sw];
  }, []);
  const canEditBacklightLevels = canEdit && (Boolean(onBacklightLevelsChange) || palladiomSwitches.length > 0);

  const levels = normalizeBacklightLevels(backlightLevels);
  const drag = useDragReorder(levels, updateAllPalladiomLevels, (level) => level.key);
  const assignmentDrag = useDragReorder(switches, commitSwitches, (sw) => sw.id, (sw) => switchGroupId(sw));

  function commitSwitches(next: SwitchEntry[] | ((current: SwitchEntry[]) => SwitchEntry[])): void {
    if (!canEdit) return;
    onChange(next);
  }

  function updateAllPalladiomLevels(nextLevels: BacklightLevelSetting[]): void {
    if (!canEditBacklightLevels) return;
    onBacklightLevelsChange?.(nextLevels);
    if (palladiomSwitches.length > 0) {
      commitSwitches((current) =>
        current.map((sw) =>
          sw.kind === "lutronPd" ? { ...sw, backlightLevels: nextLevels } : sw,
        ),
      );
    }
  }

  function hasRevisionChange(id: string, fields?: string[]): boolean {
    const changed = revisionChanges[id];
    if (!changed) return false;
    if (!fields) return changed.length > 0;
    return fields.some((field) => changed.includes(field));
  }

  function revisionCellClass(id: string, fields?: string[]): string {
    return hasRevisionChange(id, fields) ? "revision-changed-cell" : "";
  }

  function updateLevel(levelKey: string, fields: Partial<BacklightLevelSetting>): void {
    updateAllPalladiomLevels(
      levels.map((level) => (level.key === levelKey ? { ...level, ...fields } : level)),
    );
  }

  function stepLevel(levelKey: string, field: "active" | "inactive", delta: number): void {
    const current = levels.find((level) => level.key === levelKey);
    const value = Number.parseFloat(current?.[field] || "0");
    const next = String(Math.min(100, Math.max(0, Math.round((Number.isFinite(value) ? value : 0) + delta))));
    updateLevel(levelKey, { [field]: next });
  }

  function addBacklightScene(): void {
    const nextIndex = levels.length + 1;
    updateAllPalladiomLevels([
      ...levels,
      {
        key: createAppId(),
        name: `Backlight Scene ${nextIndex}`,
        mode: "Manual",
        active: "100",
        inactive: "20",
      },
    ]);
  }

  function renameLevel(levelKey: string, name: string): void {
    updateLevel(levelKey, { name });
  }

  function removeLevel(levelKey: string): void {
    const removed = levels.find((level) => level.key === levelKey);
    const nextLevels = levels.filter((level) => level.key !== levelKey);
    const matchesRemovedLevel = (value: string): boolean => {
      const condition = value.trim();
      if (!condition) return false;
      if (backlightSceneValue(condition) === levelKey) return true;
      return Boolean(removed?.name && condition.toLowerCase() === removed.name.toLowerCase());
    };
    onBacklightLevelsChange?.(nextLevels);
    commitSwitches((current) =>
      current.map((sw) => {
        const backlightCondition = matchesRemovedLevel(sw.backlightCondition) ? "" : sw.backlightCondition;
        const backlightAssignment = matchesRemovedLevel(sw.backlightAssignment) ? "" : sw.backlightAssignment;
        if (sw.kind !== "lutronPd") {
          return backlightCondition === sw.backlightCondition ? sw : { ...sw, backlightCondition };
        }
        return {
          ...sw,
          backlightLevels: nextLevels,
          backlightCondition,
          backlightAssignment,
        };
      }),
    );
    if (onRoomScenesChange) {
      onRoomScenesChange((current) =>
        current.map((scene) =>
          matchesRemovedLevel(scene.backlightCondition)
            ? { ...scene, backlightCondition: "" }
            : scene,
        ),
      );
    }
  }

  function updatePalladiomAssignment(groupId: string, sceneKey: string): void {
    const assignment = sceneKey === BY_SCENE_VALUE ? "" : sceneKey;
    commitSwitches((current) =>
      current.map((sw) =>
        switchGroupId(sw) === groupId ? { ...sw, backlightAssignment: assignment } : sw,
      ),
    );
  }

  function renderPercentControl(level: BacklightLevelSetting, field: "active" | "inactive") {
    if (level.mode === "DBM") {
      return (
        <span className="cell-readonly">DBM</span>
      );
    }

    return (
      <div className="scene-level-control switch-override-control">
        <input
          className="cell-input scene-level-input"
          type="number"
          min="0"
          max="100"
          value={level[field]}
          onChange={(e) => updateLevel(level.key, { [field]: clampPercent(e.target.value) })}
          disabled={!canEditBacklightLevels}
        />
        <div className="scene-step-grid switch-step-grid">
          <button type="button" onClick={() => stepLevel(level.key, field, 1)} disabled={!canEditBacklightLevels}>+1</button>
          <button type="button" onClick={() => stepLevel(level.key, field, 10)} disabled={!canEditBacklightLevels}>+10</button>
          <button type="button" onClick={() => stepLevel(level.key, field, -1)} disabled={!canEditBacklightLevels}>-1</button>
          <button type="button" onClick={() => stepLevel(level.key, field, -10)} disabled={!canEditBacklightLevels}>-10</button>
        </div>
      </div>
    );
  }

  return (
    <section className="card card-padded fade-in">
      <div className="toolbar">
        <strong>Backlight Logic</strong>
      </div>
      <div className="matrix-scroll">
        <table className="matrix-table master-table switch-table">
          <colgroup>
            {/* Exactly one col per column: an extra col here shifted every
                width by one, squeezing Mode into the Operation width and
                pushing its select over the Active % field. */}
            <col className="table-col-drag" />
            <col className="table-col-no" />
            <col />
            <col className="backlight-col-mode" />
            <col />
            <col />
            <col className="switch-col-operation" />
          </colgroup>
          <thead>
            <tr>
              <th className="col-center" aria-label="Reorder" />
              <th className="col-center">No</th>
              <th>Backlight Scene</th>
              <th>Mode</th>
              <th>Active %</th>
              <th>Inactive %</th>
              <th className="col-center">Operation</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((level, index) => (
              <tr
                key={level.key}
                className={[
                  drag.draggingKey === level.key ? "row-dragging" : "",
                  drag.dragOverInfo?.targetKey === level.key && drag.dragOverInfo.position === "before" ? "drop-before" : "",
                  drag.dragOverInfo?.targetKey === level.key && drag.dragOverInfo.position === "after" ? "drop-after" : "",
                ].filter(Boolean).join(" ")}
                onDragOver={(e) => drag.onDragOver(e, level.key)}
                onDrop={(e) => drag.onDrop(e, level.key)}
              >
                <td className="col-center drag-handle-cell">
                  <span
                    className="drag-handle"
                    draggable={canEditBacklightLevels}
                    onDragStart={(e) => drag.onDragStart(e, level.key)}
                    onDragEnd={drag.onDragEnd}
                    title="Drag to reorder"
                  >
                    ::
                  </span>
                </td>
                <td className="col-center">{index + 1}</td>
                <td className={backlightLogicChanged ? "revision-changed-cell" : ""}>
                  <AutoGrowTextarea
                    value={level.name}
                    onChange={(value) => renameLevel(level.key, value)}
                    disabled={!canEditBacklightLevels}
                  />
                </td>
                <td className={backlightLogicChanged ? "revision-changed-cell" : ""}>
                  <select
                    className="cell-input backlight-mode-select"
                    value={level.mode}
                    onChange={(e) =>
                      updateLevel(level.key, { mode: e.target.value as BacklightLevelSetting["mode"] })
                    }
                    disabled={!canEditBacklightLevels}
                  >
                    <option value="Manual">Manual</option>
                    <option value="DBM">DBM</option>
                  </select>
                </td>
                <td className={backlightLogicChanged ? "revision-changed-cell" : ""}>{renderPercentControl(level, "active")}</td>
                <td className={backlightLogicChanged ? "revision-changed-cell" : ""}>{renderPercentControl(level, "inactive")}</td>
                <td className="col-center">
                  <ActionIconButton
                    icon="trash"
                    label="Delete Backlight Scene"
                    className="btn-danger-ghost"
                    onClick={() => removeLevel(level.key)}
                    disabled={!canEditBacklightLevels}
                    title="Delete"
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={7}>
                <button className="btn-add-row" onClick={addBacklightScene} disabled={!canEditBacklightLevels}>
                  + Backlight Scene Add
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="toolbar" style={{ marginTop: "1rem" }}>
        <strong>Palladiom Backlight Assignment</strong>
        <span className="toolbar-spacer" />
      </div>
      <div className="matrix-scroll">
        <table className="matrix-table master-table switch-table">
          <colgroup>
            <col className="table-col-drag" />
            <col className="table-col-no" />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th className="col-center" aria-label="Reorder" />
              <th className="col-center">No</th>
              <th>Switch #</th>
              <th>Switch Name</th>
              <th>Backlight Scene</th>
            </tr>
          </thead>
          <tbody>
            {palladiomSwitches.length === 0 ? (
              <tr>
                <td colSpan={5} className="screen-empty">
                  Palladiom switches are not registered.
                </td>
              </tr>
            ) : (
              palladiomSwitches.map((sw, index) => (
                <tr
                  key={switchGroupId(sw)}
                  className={[
                    assignmentDrag.draggingKey === switchGroupId(sw) ? "row-dragging" : "",
                    assignmentDrag.dragOverInfo?.targetKey === switchGroupId(sw) &&
                    assignmentDrag.dragOverInfo.position === "before"
                      ? "drop-before"
                      : "",
                    assignmentDrag.dragOverInfo?.targetKey === switchGroupId(sw) &&
                    assignmentDrag.dragOverInfo.position === "after"
                      ? "drop-after"
                      : "",
                  ].filter(Boolean).join(" ")}
                  onDragOver={(e) => assignmentDrag.onDragOver(e, switchGroupId(sw))}
                  onDrop={(e) => assignmentDrag.onDrop(e, switchGroupId(sw))}
                >
                  <td className="col-center drag-handle-cell">
                    <span
                      className="drag-handle"
                      draggable={canEdit}
                      onDragStart={(e) => assignmentDrag.onDragStart(e, switchGroupId(sw))}
                      onDragEnd={assignmentDrag.onDragEnd}
                      title="Drag to reorder"
                    >
                      ::
                    </span>
                  </td>
                  <td className="col-center">{index + 1}</td>
                  <td><span className="cell-readonly">{sw.switchNumber || "-"}</span></td>
                  <td><span className="cell-readonly">{sw.switchName || "-"}</span></td>
                  <td className={revisionCellClass(sw.id, ["backlightCondition"])}>
                    {(() => {
                      const groupEntries = switches.filter(
                        (entry) => entry.kind === "lutronPd" && switchGroupId(entry) === switchGroupId(sw),
                      );
                      const groupValue = groupBacklightSceneValue(groupEntries);
                      return (
                        <select
                          className="cell-input"
                          value={groupValue}
                          onChange={(e) => {
                            if (e.target.value === MIXED_VALUE) return;
                            updatePalladiomAssignment(switchGroupId(sw), e.target.value);
                          }}
                          disabled={!canEdit}
                          title={
                            groupValue === MIXED_VALUE
                              ? "Rows in this switch have different backlight settings (set per row on the Switch tab). Selecting a value here overwrites every row."
                              : undefined
                          }
                        >
                          {groupValue === MIXED_VALUE ? (
                            <option value={MIXED_VALUE} disabled>
                              (Mixed)
                            </option>
                          ) : null}
                          <option value={BY_SCENE_VALUE}>By Scene</option>
                          {levels.map((level) => (
                            <option key={level.key} value={level.key}>
                              {level.name}
                            </option>
                          ))}
                        </select>
                      );
                    })()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
