"use client";

import { Fragment } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import SettingOverlayFrame from "./setting-overlay/SettingOverlayFrame";
import SceneValueSettingPanel from "./setting-overlay/SceneValueSettingPanel";
import BacklightSettingPanel from "./setting-overlay/BacklightSettingPanel";
import type {
  CircuitEntry,
  BacklightLevelSetting,
  CfsCircuit,
  CurtainAssignment,
  DeviceAssignment,
  HvacAssignment,
  HvacSeason,
  LocationMaster,
  RevisionFieldChanges,
  RoomScene,
  RoomScenePhase,
  Scene,
  SwitchEntry,
  TriggerMaster,
} from "../types";
import { createEmptyRoomScene, normalizeBacklightLevels } from "../lib/constants";
import { ensureRoomScenes, isPmsScene, sortRoomScenesByGroup } from "../lib/roomScenes";
import { normalizeRoomSceneSettingLinksAfterCommit } from "../lib/roomSceneSettingLinks";
import { byScenePalladiomBacklightTargets, switchGroupId } from "../lib/useCfsZoneRows";
import { useDragReorder } from "../lib/useDragReorder";
import ActionIconButton from "./ActionIconButton";
import DragHandle from "./DragHandle";
import AutoGrowTextarea from "./AutoGrowTextarea";
import Combobox from "./Combobox";
import { buildSettingTargetGroups, hvacSettingTargets as buildHvacSettingTargets, settingTargetIds, type SettingTarget } from "../lib/settingTargets";
import {
  bulkModeAppliesToTarget,
  clampPercentValue,
  setSceneSettingValue,
  settingValueForBulkMode,
  stepPercentValue,
  type BulkSettingMode,
} from "../lib/settingValues";
import HvacSettingPanel from "./HvacSettingPanel";
import { createAppId } from '../lib/id';
import { backlightStrongColor } from "../lib/backlightColors";

export interface RoomSceneSettingOverlayRequest {
  roomSceneId: string;
  tab: "sceneValue" | "backlight";
  requestId: number;
}

interface RoomSceneViewProps {
  roomScenes: RoomScene[];
  circuits: CircuitEntry[];
  scenes?: Scene[];
  hvacAssignments?: HvacAssignment[];
  hvacSeasons?: HvacSeason[];
  deviceAssignments?: DeviceAssignment[];
  cfsRows?: CfsCircuit[];
  curtainAssignments?: CurtainAssignment[];
  switches?: SwitchEntry[];
  backlightLevels?: BacklightLevelSetting[];
  triggerMasters?: TriggerMaster[];
  locations: LocationMaster[];
  onChange: (next: RoomScene[]) => void;
  onSwitchesChange?: (next: SwitchEntry[]) => void;
  revisionChanges?: RevisionFieldChanges;
  canEdit?: boolean;
  overlayHostOnly?: boolean;
  externalSettingRequest?: RoomSceneSettingOverlayRequest | null;
  onEditAreaSceneDefinitions?: (scene: RoomScene) => void;
  canEditAreaSceneDefinitions?: boolean;
}

const PHASES: RoomScenePhase[] = ["Check In", "Check Out"];
function settingValue(scene: RoomScene, circuitId: string): string {
  return scene.settings.find((setting) => setting.circuitId === circuitId)?.percentage ?? "";
}

function selectedAreaSceneId(scene: RoomScene, areaId: string): string {
  return (scene.areaSceneSelections ?? []).find((selection) => selection.areaId === areaId)?.sceneId ?? "";
}

function setAreaSceneSelection(scene: RoomScene, areaId: string, sceneId: string): RoomScene {
  const nextSelections = (scene.areaSceneSelections ?? []).filter((selection) => selection.areaId !== areaId);
  if (sceneId.trim()) nextSelections.push({ areaId, sceneId });
  return { ...scene, areaSceneSelections: nextSelections };
}

function setSetting(scene: RoomScene, circuitId: string, value: string): RoomScene {
  return { ...scene, settings: setSceneSettingValue(scene.settings, circuitId, value) };
}

function isCurtainTarget(target: SettingTarget): boolean {
  return target.isCurtain === true || target.dimmingType === "Curtain";
}

function displayArea(circuit: CircuitEntry, locations: LocationMaster[]): string {
  if (!circuit.area) return "Other";
  return locations.find((loc) => loc.id === circuit.area)?.name || "Other";
}

function trimRepeatedSceneDetailPrefix(sceneType: string, detail: string): string {
  const lastSceneWord = sceneType.trim().split(/\s+/).filter(Boolean).at(-1) ?? "";
  if (!lastSceneWord || !detail.toLowerCase().startsWith(`${lastSceneWord.toLowerCase()} `)) return detail;
  return detail.slice(lastSceneWord.length).trim();
}

function sceneName(scene: RoomScene): string {
  const sceneType = scene.sceneType.trim();
  const detail = trimRepeatedSceneDetailPrefix(sceneType, scene.detail.trim());
  if (sceneType.length === 1 && detail && /^[\p{L}\p{N}]/u.test(detail)) return `${sceneType}${detail}`;
  return [sceneType, detail].filter(Boolean).join(" ");
}

function editableSceneName(scene: RoomScene): string {
  if (!scene.detail) return scene.sceneType;
  return `${scene.sceneType}${scene.sceneType ? " " : ""}${scene.detail}`;
}

export default function RoomSceneView({
  roomScenes,
  circuits,
  scenes = [],
  hvacAssignments = [],
  hvacSeasons = [],
  deviceAssignments = [],
  cfsRows = [],
  curtainAssignments = [],
  switches = [],
  backlightLevels,
  triggerMasters = [],
  locations,
  onChange,
  revisionChanges = {},
  canEdit = true,
  overlayHostOnly = false,
  externalSettingRequest,
  onEditAreaSceneDefinitions,
  canEditAreaSceneDefinitions = false,
}: RoomSceneViewProps) {
  const [expandedId, setExpandedId] = useState<string>("");
  const [expandedBacklightId, setExpandedBacklightId] = useState<string>("");
  const [expandedAreaKeys, setExpandedAreaKeys] = useState<Set<string>>(new Set());
  const [areaBulkValues, setAreaBulkValues] = useState<Record<string, string>>({});
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  const [bulkApplyMode, setBulkApplyMode] = useState<"scene" | "backlight" | null>(null);
  const consumedExternalRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (overlayHostOnly) return;
    const next = ensureRoomScenes(roomScenes);
    if (next !== roomScenes && canEdit) onChange(next);
  }, [roomScenes, onChange, canEdit, overlayHostOnly]);

  const effectiveRoomScenes = useMemo(() => {
    return overlayHostOnly ? roomScenes : ensureRoomScenes(roomScenes);
  }, [roomScenes, overlayHostOnly]);

  const displayCircuits = useMemo(
    () =>
      [...circuits].sort((a, b) => {
        const areaCompare = displayArea(a, locations).localeCompare(displayArea(b, locations), "en", { numeric: true });
        if (areaCompare !== 0) return areaCompare;
        return a.designerNumber.localeCompare(b.designerNumber, "en", { numeric: true });
      }),
    [circuits, locations],
  );
  const drag = useDragReorder(effectiveRoomScenes, commitRoomScenes, (scene) => scene.id);
  const standardScenes = effectiveRoomScenes.filter((scene) => !isPmsScene(scene));
  const pmsScenes = effectiveRoomScenes.filter(isPmsScene);

  function hasRevisionChange(id: string, fields?: string[]): boolean {
    const changed = revisionChanges[id];
    if (!changed) return false;
    if (!fields) return changed.length > 0;
    return fields.some((field) => changed.includes(field));
  }

  function revisionCellClass(id: string, fields?: string[]): string {
    return hasRevisionChange(id, fields) ? "revision-changed-cell" : "";
  }

  const areaGroups = useMemo(
    () => buildSettingTargetGroups(locations, displayCircuits, deviceAssignments, cfsRows, curtainAssignments, switches),
    [locations, displayCircuits, deviceAssignments, cfsRows, curtainAssignments, switches],
  );

  const areasWithScenes = useMemo(() => {
    const areaIds = new Set(scenes.map((scene) => scene.areaId));
    return locations.filter((location) => areaIds.has(location.id));
  }, [locations, scenes]);
  const triggerOptions = useMemo(
    () => triggerMasters.map((trigger) => trigger.name.trim()).filter(Boolean),
    [triggerMasters],
  );
  const hvacSettingTargets = useMemo(
    () => buildHvacSettingTargets(hvacAssignments, locations),
    [hvacAssignments, locations],
  );
  const byScenePalladiomSwitches = useMemo(
    () => byScenePalladiomBacklightTargets(switches),
    [switches],
  );
  const backlightConditions = useMemo(() => {
    return normalizeBacklightLevels(backlightLevels).map(({ key, name }) => ({ key, name }));
  }, [backlightLevels]);

  useEffect(() => {
    if (!externalSettingRequest) return;
    if (!canEdit) {
      setExpandedId("");
      setExpandedBacklightId("");
      setBulkApplyMode(null);
      return;
    }
    if (consumedExternalRequestIdRef.current === externalSettingRequest.requestId) return;
    consumedExternalRequestIdRef.current = externalSettingRequest.requestId;
    setBulkApplyMode(null);
    const active = effectiveRoomScenes.find(scene => scene.id === externalSettingRequest.roomSceneId);
    if (!active) {
      setExpandedId("");
      setExpandedBacklightId("");
      return;
    }
    if (externalSettingRequest.tab === "backlight") {
      setExpandedId("");
      setExpandedBacklightId(active.id);
      return;
    }
    setExpandedBacklightId("");
    setExpandedId(active.id);
    setExpandedAreaKeys(new Set(areaGroups.filter(area => area.targets.some(target =>
      settingTargetIds(target).some(id => settingValue(active, id).trim() !== ""),
    )).map(area => areaKey(active.id, area.id))));
  }, [externalSettingRequest, effectiveRoomScenes, areaGroups, canEdit]);

  function update(id: string, patch: Partial<RoomScene>): void {
    commitRoomScenes(effectiveRoomScenes.map((scene) => (scene.id === id ? { ...scene, ...patch } : scene)));
  }

  function updateSetting(id: string, circuitId: string, value: string): void {
    commitRoomScenes(effectiveRoomScenes.map((scene) => (scene.id === id ? setSetting(scene, circuitId, value) : scene)));
  }

  // One setting row represents a whole circuit group: write to every member
  // row, read the first non-empty member value.
  function updateTargetSetting(id: string, target: SettingTarget, value: string): void {
    commitRoomScenes(
      effectiveRoomScenes.map((scene) =>
        scene.id === id
          ? settingTargetIds(target).reduce((next, circuitId) => setSetting(next, circuitId, value), scene)
          : scene,
      ),
    );
  }

  function settingTargetValue(scene: RoomScene, target: SettingTarget): string {
    for (const circuitId of settingTargetIds(target)) {
      const value = settingValue(scene, circuitId);
      if (value.trim() !== "") return value;
    }
    return "";
  }

  function applyAreaScene(roomScene: RoomScene, areaId: string, areaSceneId: string): void {
    const nextScene = setAreaSceneSelection(roomScene, areaId, areaSceneId);
    commitRoomScenes(effectiveRoomScenes.map((item) => (item.id === roomScene.id ? nextScene : item)));
  }

  function updateSceneName(id: string, value: string): void {
    update(id, { sceneType: value, detail: "" });
  }

  function addScene(): void {
    const scene = createEmptyRoomScene("Check In", "Custom Scene", "");
    commitRoomScenes([...effectiveRoomScenes, scene]);
  }

  function addPmsScene(): void {
    const scene = createEmptyRoomScene("Check In", "From PMS", "", "Check In", "pms");
    commitRoomScenes([...effectiveRoomScenes, scene]);
  }

  function removeScene(id: string): void {
    commitRoomScenes(effectiveRoomScenes.filter((scene) => scene.id !== id));
    if (expandedId === id) setExpandedId("");
  }

  function copyScene(id: string): void {
    const index = effectiveRoomScenes.findIndex((scene) => scene.id === id);
    const source = effectiveRoomScenes[index];
    if (!source) return;
    const copied: RoomScene = {
      ...source,
      id: createAppId(),
      settingLinkGroupId: undefined,
      areaSceneSelections: (source.areaSceneSelections ?? []).map((selection) => ({ ...selection })),
      settings: source.settings.map((setting) => ({ ...setting })),
    };
    commitRoomScenes([...effectiveRoomScenes.slice(0, index + 1), copied, ...effectiveRoomScenes.slice(index + 1)]);
    setExpandedId(copied.id);
  }

  function commitRoomScenes(next: RoomScene[]): void {
    if (!canEdit) return;
    // Keep the stored order grouped as the tab shows it (PMS before Door
    // Magnet) so CFS columns and exports never interleave the groups.
    const sorted = sortRoomScenesByGroup(next);
    onChange(normalizeRoomSceneSettingLinksAfterCommit(effectiveRoomScenes, sorted));
  }

  function areaKey(sceneId: string, areaId: string): string {
    return `${sceneId}:${areaId}`;
  }

  function toggleArea(sceneId: string, areaId: string): void {
    const key = areaKey(sceneId, areaId);
    setExpandedAreaKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function sceneHasSetting(scene: RoomScene): boolean {
    return (scene.areaSceneSelections ?? []).some((selection) => selection.sceneId.trim() !== "") ||
      scene.settings.some((setting) => setting.percentage.trim() !== "");
  }

  function sceneHasBacklight(scene: RoomScene): boolean {
    return scene.backlightCondition.trim() !== "";
  }

  function openSceneSetting(scene: RoomScene): void {
    setExpandedBacklightId("");
    setExpandedId(scene.id);
    setExpandedAreaKeys(() => {
      const next = new Set<string>();
      for (const area of areaGroups) {
        if (area.targets.some((target) => settingTargetValue(scene, target).trim() !== "")) {
          next.add(areaKey(scene.id, area.id));
        }
      }
      return next;
    });
  }

  function openBacklightSetting(scene: RoomScene): void {
    setExpandedId("");
    setExpandedBacklightId(scene.id);
  }

  function closeSettingOverlay(): void {
    setExpandedId("");
    setExpandedBacklightId("");
    setBulkApplyMode(null);
  }

  function startBulkSetting(mode: "scene" | "backlight"): void {
    const template = effectiveRoomScenes.find((scene) => bulkSelectedIds.has(scene.id));
    if (!template) return;
    setBulkApplyMode(mode);
    if (mode === "scene") openSceneSetting(template);
    else openBacklightSetting(template);
  }

  function applyBulkSetting(active: RoomScene): void {
    const mode = bulkApplyMode;
    if (!mode) return;
    const ids = new Set(bulkSelectedIds);
    commitRoomScenes(
      effectiveRoomScenes.map((scene) => {
        if (!ids.has(scene.id) || scene.id === active.id) return scene;
        if (mode === "scene") {
          return {
            ...scene,
            settings: active.settings.map((setting) => ({ ...setting })),
            areaSceneSelections: (active.areaSceneSelections ?? []).map((selection) => ({ ...selection })),
          };
        }
        // Backlight bulk copies the per-scene condition only; the Palladiom
        // group assignment (backlightAssignment) is never touched here.
        return { ...scene, backlightCondition: active.backlightCondition };
      }),
    );
    setBulkApplyMode(null);
    setBulkSelectedIds(new Set());
    closeSettingOverlay();
  }

  function toggleBulkSelected(sceneId: string, checked: boolean): void {
    setBulkSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(sceneId);
      else next.delete(sceneId);
      return next;
    });
  }

  function toggleBulkSelectAll(tableScenes: RoomScene[], checked: boolean): void {
    setBulkSelectedIds((current) => {
      const next = new Set(current);
      for (const scene of tableScenes) {
        if (checked) next.add(scene.id);
        else next.delete(scene.id);
      }
      return next;
    });
  }

  function backlightConditionLabel(raw: string): string {
    const value = raw.trim();
    if (!value) return "";
    const matched = backlightConditions.find((condition) => condition.key === value || condition.name === value);
    return matched ? matched.name : value;
  }

  function renderBacklightStatusButton(scene: RoomScene): ReactNode {
    const label = backlightConditionLabel(scene.backlightCondition);
    const strong = label ? backlightStrongColor(label) : null;
    return (
      <button
        type="button"
        className={[
          "btn",
          "btn-primary",
          "btn-sm",
          "setting-status-button",
          sceneHasBacklight(scene) ? "has-setting" : "",
        ].filter(Boolean).join(" ")}
        style={strong ? { backgroundColor: strong, borderColor: strong, color: "#fff" } : undefined}
        onClick={() => openBacklightSetting(scene)}
      >
        {label || "Setting"}
      </button>
    );
  }

  function renderBulkSelectHeader(tableScenes: RoomScene[]): ReactNode {
    return (
      <th className="col-center switch-bulk-select-header">
        <input
          type="checkbox"
          aria-label="Select all rows for bulk setting"
          checked={tableScenes.length > 0 && tableScenes.every((scene) => bulkSelectedIds.has(scene.id))}
          disabled={!canEdit || tableScenes.length === 0}
          onChange={(event) => toggleBulkSelectAll(tableScenes, event.target.checked)}
        />
      </th>
    );
  }

  function renderBulkSelectCell(scene: RoomScene): ReactNode {
    return (
      <td className="col-center switch-bulk-select-cell">
        <input
          type="checkbox"
          aria-label="Select row for bulk setting"
          checked={bulkSelectedIds.has(scene.id)}
          disabled={!canEdit}
          onChange={(event) => toggleBulkSelected(scene.id, event.target.checked)}
        />
      </td>
    );
  }

  useEffect(() => {
    if (!expandedId && !expandedBacklightId) return;
    function handleEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") closeSettingOverlay();
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [expandedId, expandedBacklightId]);

  useEffect(() => {
    if (!expandedId && !expandedBacklightId) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [expandedId, expandedBacklightId]);

  function stepAreaBulkValue(scene: RoomScene, areaTargets: SettingTarget[], key: string, delta: number): void {
    applyAreaBulkPercentValue(scene, areaTargets, key, stepPercentValue(areaBulkValues[key] || "", delta));
  }

  function applyAreaBulkPercentValue(scene: RoomScene, areaTargets: SettingTarget[], key: string, rawValue: string): void {
    const value = clampPercentValue(rawValue);
    setAreaBulkValues((prev) => ({ ...prev, [key]: value }));
    if (!value) return;
    let nextScene = scene;
    for (const target of areaTargets) {
      if (!target.isOnOff && !isCurtainTarget(target)) {
        nextScene = settingTargetIds(target).reduce((next, circuitId) => setSetting(next, circuitId, value), nextScene);
      }
    }
    commitRoomScenes(effectiveRoomScenes.map((item) => (item.id === scene.id ? nextScene : item)));
  }

  function applyAreaBulk(scene: RoomScene, areaTargets: SettingTarget[], mode: BulkSettingMode, key: string): void {
    let nextScene = scene;
    for (const target of areaTargets) {
      if (isCurtainTarget(target) && mode !== "clear") continue;
      const value = settingValueForBulkMode(mode, target.isOnOff, areaBulkValues[key] || "");
      if (value !== null) {
        nextScene = settingTargetIds(target).reduce((next, circuitId) => setSetting(next, circuitId, value), nextScene);
      }
    }
    commitRoomScenes(effectiveRoomScenes.map((item) => (item.id === scene.id ? nextScene : item)));
  }

  function canApplyAreaBulkMode(areaTargets: SettingTarget[], mode: BulkSettingMode, key: string): boolean {
    if (mode === "percent" && !clampPercentValue(areaBulkValues[key] || "")) return false;
    return areaTargets.some((target) => !isCurtainTarget(target) && bulkModeAppliesToTarget(mode, target.isOnOff));
  }

  function renderSettingPanel(scene: RoomScene): ReactNode {
    return (
      <SceneValueSettingPanel
        areasWithScenes={areasWithScenes} scenes={scenes} targetGroups={areaGroups} canEdit={canEdit}
        sceneForArea={areaId => selectedAreaSceneId(scene, areaId)}
        onSceneForAreaChange={(areaId, sceneId) => applyAreaScene(scene, areaId, sceneId)}
        isAreaExpanded={areaId => expandedAreaKeys.has(areaKey(scene.id, areaId))}
        onAreaToggle={areaId => toggleArea(scene.id, areaId)}
        areaHasSetting={area => area.targets.some(target => settingTargetValue(scene, target).trim() !== "")}
        bulk={{
          value: area => areaBulkValues[areaKey(scene.id, area.id)] ?? "",
          onPercentChange: (area, value) => applyAreaBulkPercentValue(scene, area.targets, areaKey(scene.id, area.id), value),
          onStep: (area, delta) => stepAreaBulkValue(scene, area.targets, areaKey(scene.id, area.id), delta),
          canApply: (area, mode) => canApplyAreaBulkMode(area.targets, mode, areaKey(scene.id, area.id)),
          onApply: (area, mode) => applyAreaBulk(scene, area.targets, mode, areaKey(scene.id, area.id)),
        }}
        valueForTarget={target => settingTargetValue(scene, target)}
        onTargetValueChange={(target, value) => updateTargetSetting(scene.id, target, value)}
        onTargetStep={(target, delta) => updateTargetSetting(scene.id, target, stepPercentValue(settingTargetValue(scene, target), delta))}
        cardClassName="room-scene-setting-card"
        renderValueInput={(target, value) => <AutoGrowTextarea className="scene-level-input" value={value} onChange={next => updateTargetSetting(scene.id, target, next)} disabled={!canEdit} />}
      >
            <HvacSettingPanel
              targets={hvacSettingTargets}
              getValue={(targetId) => settingValue(scene, targetId)}
              onChange={(targetId, value) => updateSetting(scene.id, targetId, value)}
              onChangeMany={(updates) =>
                commitRoomScenes(
                  effectiveRoomScenes.map((item) =>
                    item.id === scene.id
                      ? updates.reduce((next, update) => setSetting(next, update.targetId, update.value), item)
                      : item,
                  ),
                )
              }
              defaultCollapsed={!hvacSettingTargets.some((target) => settingValue(scene, target.id).trim() !== "")}
              resetKey={scene.id}
              seasons={hvacSeasons}
              disabled={!canEdit}
            />
      </SceneValueSettingPanel>
    );
  }

  function renderBacklightPanel(scene: RoomScene): ReactNode {
    return (
      <BacklightSettingPanel
        targets={byScenePalladiomSwitches.map(target => ({ id: switchGroupId(target), label: [target.switchNumber, target.switchName].filter(Boolean).join(" - ") || "(No switch #)" }))}
        selection={{ mode: "readOnly" }}
        condition={scene.backlightCondition}
        conditions={backlightConditions}
        onConditionChange={value => update(scene.id, { backlightCondition: value })}
        canEdit={canEdit}
      />
    );
  }

  function renderSettingOverlay(): ReactNode {
    const activeSetting = effectiveRoomScenes.find(scene => scene.id === expandedId);
    const activeBacklight = effectiveRoomScenes.find(scene => scene.id === expandedBacklightId);
    const active = activeSetting ?? activeBacklight;
    if (!active) return null;
    return (
      <SettingOverlayFrame
        title={sceneName(active) || "Scene Setting"}
        activeTab={activeSetting ? "sceneValue" : "backlight"}
        onTabChange={tab => tab === "sceneValue" ? openSceneSetting(active) : openBacklightSetting(active)}
        onClose={closeSettingOverlay}
        actions={<>
                  {bulkApplyMode ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={!canEdit}
                      onClick={() => applyBulkSetting(active)}
                    >
                      Apply to {bulkSelectedIds.size} rows
                    </button>
                  ) : null}
          {onEditAreaSceneDefinitions ? (
            <button type="button" className="btn btn-secondary btn-sm" disabled={!canEdit || !canEditAreaSceneDefinitions} onClick={() => {
              closeSettingOverlay();
              onEditAreaSceneDefinitions(active);
            }}>Edit Area Scene definitions</button>
          ) : null}
        </>}
      >
        {activeSetting ? renderSettingPanel(activeSetting) : null}
        {activeBacklight ? renderBacklightPanel(activeBacklight) : null}
      </SettingOverlayFrame>
    );
  }

  function handleSceneDragStart(event: DragEvent<HTMLElement>, sceneId: string): void {
    drag.onDragStart(event, sceneId);
  }

  if (overlayHostOnly) return <>{renderSettingOverlay()}</>;

  return (
    <section className="card card-padded fade-in">
      <div className="toolbar room-scene-bulk-toolbar">
        <span className="toolbar-spacer" />
        <span className="muted-pill" aria-live="polite">
          {bulkSelectedIds.size} checked
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!canEdit || bulkSelectedIds.size === 0}
          onClick={() => startBulkSetting("scene")}
          title="Open the scene setting panel and apply it to every checked row"
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
      <div className="scene-section-title">From PMS Scene</div>
      <div className="table-shell">
        <table className="matrix-table switch-table room-scene-table room-scene-pms-table">
          <colgroup>
            <col className="table-col-drag" />
            <col className="table-col-no" />
          </colgroup>
          <thead>
            <tr>
              <th />
              <th>No</th>
              <th>PMS Scene</th>
              <th>Trigger Condition</th>
              {renderBulkSelectHeader(pmsScenes)}
              <th>Setting</th>
              <th>Backlight Setting</th>
              <th>Operation</th>
            </tr>
          </thead>
          <tbody>
            {pmsScenes.length === 0 ? (
              <tr>
                <td colSpan={8} className="screen-empty">No From PMS scenes are registered.</td>
              </tr>
            ) : (
              pmsScenes.map((scene, rowIndex) => {
                const index = effectiveRoomScenes.findIndex((item) => item.id === scene.id);
                const isDropTarget = drag.dragOverInfo?.targetKey === scene.id;
                return (
                  <Fragment key={`${scene.id}-${index}-pms`}>
                    <tr
                      className={[
                        drag.draggingKey === scene.id ? "row-dragging" : "",
                        isDropTarget && drag.dragOverInfo?.position === "before" ? "row-drop-before" : "",
                        isDropTarget && drag.dragOverInfo?.position === "after" ? "row-drop-after" : "",
                      ].filter(Boolean).join(" ")}
                      onDragOver={(event) => drag.onDragOver(event, scene.id)}
                      onDrop={(event) => drag.onDrop(event, scene.id)}
                    >
                      <td className="col-center drag-handle-cell">
                        <DragHandle
                          title="Drag to reorder"
                          draggable={canEdit}
                          onDragStart={(event) => handleSceneDragStart(event, scene.id)}
                          onDragEnd={drag.onDragEnd}
                        />
                      </td>
                      <td className="col-center">{rowIndex + 1}</td>
                      <td className={revisionCellClass(scene.id, ["sceneType", "detail"])}>
                        <AutoGrowTextarea value={editableSceneName(scene)} onChange={(value) => updateSceneName(scene.id, value)} disabled={!canEdit} />
                      </td>
                      <td className={revisionCellClass(scene.id, ["triggerCondition"])}>
                        <Combobox
                          value={scene.triggerCondition}
                          options={triggerOptions}
                          onChange={(value) => update(scene.id, { triggerCondition: value })}
                          ariaLabel="Trigger Condition"
                          disabled={!canEdit}
                        />
                      </td>
                      {renderBulkSelectCell(scene)}
                      <td className={`col-center ${revisionCellClass(scene.id, ["settings"])}`}>
                        <button
                          type="button"
                          className={[
                            "btn",
                            "btn-primary",
                            "btn-sm",
                            "setting-status-button",
                            sceneHasSetting(scene) ? "has-setting" : "",
                          ].filter(Boolean).join(" ")}
                          onClick={() => openSceneSetting(scene)}
                        >
                          Setting
                        </button>
                      </td>
                      <td className={`col-center ${revisionCellClass(scene.id, ["backlightCondition"])}`}>
                        {renderBacklightStatusButton(scene)}
                      </td>
                      <td className="col-center">
                        <ActionIconButton
                          icon="copy"
                          label="Copy Scene"
                          className="btn-secondary btn-sm"
                          onClick={() => copyScene(scene.id)}
                          disabled={!canEdit}
                        />
                        <ActionIconButton
                          icon="trash"
                          label="Delete Scene"
                          className="btn-danger-ghost btn-sm"
                          onClick={() => removeScene(scene.id)}
                          disabled={!canEdit}
                        />
                      </td>
                    </tr>
                  </Fragment>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={8}>
                <button className="btn-add-row" onClick={addPmsScene} title="Add PMS row" disabled={!canEdit}>
                  + Add PMS Row
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="scene-section-title">Door Magnet Scene</div>
      <div className="table-shell">
        <table className="matrix-table switch-table room-scene-table">
          <colgroup>
            <col className="table-col-drag" />
            <col className="table-col-no" />
          </colgroup>
          <thead>
            <tr>
              <th />
              <th>No</th>
              <th>Room Status</th>
              <th>Scene Name</th>
              <th>Trigger Condition</th>
              {renderBulkSelectHeader(standardScenes)}
              <th>Setting</th>
              <th>Backlight Setting</th>
              <th>Operation</th>
            </tr>
          </thead>
          <tbody>
            {standardScenes.map((scene, rowIndex) => {
              const index = effectiveRoomScenes.findIndex((item) => item.id === scene.id);
              const isDropTarget = drag.dragOverInfo?.targetKey === scene.id;
              return (
                <Fragment key={`${scene.id}-${index}`}>
                  <tr
                    key={`${scene.id}-${index}-row`}
                    className={[
                      drag.draggingKey === scene.id ? "row-dragging" : "",
                      isDropTarget && drag.dragOverInfo?.position === "before" ? "row-drop-before" : "",
                      isDropTarget && drag.dragOverInfo?.position === "after" ? "row-drop-after" : "",
                    ].filter(Boolean).join(" ")}
                    onDragOver={(event) => drag.onDragOver(event, scene.id)}
                    onDrop={(event) => drag.onDrop(event, scene.id)}
                  >
                    <td className="col-center drag-handle-cell">
                      <DragHandle
                        title="Drag to reorder"
                        draggable={canEdit}
                        onDragStart={(event) => handleSceneDragStart(event, scene.id)}
                        onDragEnd={drag.onDragEnd}
                      />
                    </td>
                    <td className="col-center">{rowIndex + 1}</td>
                    <td className={revisionCellClass(scene.id, ["phase"])}>
                      <select
                        className="cell-input"
                        value={scene.phase}
                        onChange={(event) => update(scene.id, { phase: event.target.value as RoomScenePhase })}
                        disabled={!canEdit}
                      >
                        {PHASES.map((phase) => (
                          <option key={phase} value={phase}>{phase}</option>
                        ))}
                      </select>
                    </td>
                    <td className={revisionCellClass(scene.id, ["sceneType", "detail"])}>
                      <AutoGrowTextarea value={editableSceneName(scene)} onChange={(value) => updateSceneName(scene.id, value)} disabled={!canEdit} />
                    </td>
                    <td className={revisionCellClass(scene.id, ["triggerCondition"])}>
                      <Combobox
                        value={scene.triggerCondition}
                        options={triggerOptions}
                        onChange={(value) => update(scene.id, { triggerCondition: value })}
                        ariaLabel="Trigger Condition"
                        disabled={!canEdit}
                      />
                    </td>
                    {renderBulkSelectCell(scene)}
                    <td className={`col-center ${revisionCellClass(scene.id, ["settings"])}`}>
                      <button
                        type="button"
                        className={[
                          "btn",
                          "btn-primary",
                          "btn-sm",
                          "setting-status-button",
                          sceneHasSetting(scene) ? "has-setting" : "",
                        ].filter(Boolean).join(" ")}
                        onClick={() => openSceneSetting(scene)}
                      >
                        Setting
                      </button>
                    </td>
                    <td className={`col-center ${revisionCellClass(scene.id, ["backlightCondition"])}`}>
                      {renderBacklightStatusButton(scene)}
                    </td>
                    <td className="col-center">
                      <ActionIconButton
                        icon="copy"
                        label="Copy Scene"
                        className="btn-secondary btn-sm"
                        onClick={() => copyScene(scene.id)}
                        disabled={!canEdit}
                      />
                      <ActionIconButton
                        icon="trash"
                        label="Delete Scene"
                        className="btn-danger-ghost btn-sm"
                        onClick={() => removeScene(scene.id)}
                        disabled={!canEdit}
                      />
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={9}>
                <button className="btn-add-row" onClick={addScene} title="Add row" disabled={!canEdit}>
                  + Add Row
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {renderSettingOverlay()}
    </section>
  );
}
