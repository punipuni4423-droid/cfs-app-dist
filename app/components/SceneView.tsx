"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  CircuitEntry,
  CurtainAssignment,
  DeviceMaster,
  FixtureMaster,
  HvacAssignment,
  HvacSeason,
  LocationMaster,
  ProgrammingNameSettings,
  RevisionFieldChanges,
  RoomType,
  Scene,
  SwitchEntry,
} from "../types";
import { createEmptyScene } from "../lib/constants";
import {
  type SettingTarget,
} from "../lib/settingTargets";
import {
  HVAC_AREA_ID,
  buildAreaSceneAreas,
  buildAreaSceneCircuitHeads,
  buildAreaSceneCurtainTargets,
  buildAreaSceneHvacTargets,
  buildAreaScenePicoLedTargets,
  buildAreaSceneTargets,
  findFirstAreaSceneTargetAreaId,
  type AreaSceneSourceInput,
} from "../lib/areaSceneMatrix";
import { formatLevel } from "../lib/cfsValueResolver";
import {
  bulkModeAppliesToTarget,
  clampPercentValue,
  isOnOffLikeDimmingType,
  setSceneSettingValue,
  settingValueForBulkMode,
  stepPercentValue,
  type BulkSettingMode,
} from "../lib/settingValues";
import {
  normalizeSceneSettingsByCircuitGroup,
  sameSceneSettings,
  sceneSettingValueForCircuitGroup,
  setSceneSettingValueForCircuitGroup,
} from "../lib/circuitGroups";
import ActionIconButton from "./ActionIconButton";
import AreaSceneOverview from "./AreaSceneOverview";
import CurtainActionButtons from "./CurtainActionButtons";
import HvacSettingPanel from "./HvacSettingPanel";
import { createAppId } from '../lib/id';

interface SceneViewProps {
  scenes: Scene[];
  locations: LocationMaster[];
  circuits: CircuitEntry[];
  fixtures: FixtureMaster[];
  hvacAssignments?: HvacAssignment[];
  hvacSeasons?: HvacSeason[];
  curtainAssignments?: CurtainAssignment[];
  switches?: SwitchEntry[];
  onChange: (next: Scene[]) => void;
  revisionChanges?: RevisionFieldChanges;
  canEdit?: boolean;
  roomTypeName?: string;
  roomType?: RoomType;
  devices?: DeviceMaster[];
  programmingNameSettings?: ProgrammingNameSettings;
  externalSettingRequest?: AreaSceneSettingOverlayRequest | null;
  overlayHostOnly?: boolean;
  initialSelectedAreaId?: string;
  initialSelectedSceneId?: string;
  embeddedSettingOverlay?: boolean;
  suppressSceneNormalization?: boolean;
}

export interface AreaSceneSettingOverlayRequest {
  sceneId: string;
  requestId: number;
}

type CircuitMode = "designer" | "internal";
type SceneViewMode = "edit" | "overview";
type FixtureKind = "DL" | "Indirect" | "Mixed" | "Unknown";
type BulkTarget = "all" | "checked" | "dl" | "indirect" | "onOff";
type BulkMode = BulkSettingMode;
type SceneDropPosition = "before" | "after";

type BulkOption<T extends string> = {
  value: T;
  label: string;
};

interface AreaSceneBulkPreviewItem {
  circuit: CircuitEntry;
  rowNumber: string;
  designerNumber: string;
  detail: string;
  currentDisplay: string;
  nextDisplay: string;
  nextValue: string;
}

interface AreaSceneBulkConfirmation {
  sceneId: string;
  targetLabel: string;
  modeLabel: string;
  items: AreaSceneBulkPreviewItem[];
}

const BULK_TARGET_OPTIONS: BulkOption<BulkTarget>[] = [
  { value: "all", label: "All" },
  { value: "checked", label: "Check" },
  { value: "dl", label: "DL" },
  { value: "indirect", label: "Indirect" },
  { value: "onOff", label: "On/Off" },
];

const BULK_MODE_OPTIONS: BulkOption<BulkMode>[] = [
  { value: "percent", label: "%" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
  { value: "blinkShort", label: "Blinking (Short)" },
  { value: "blinkLong", label: "Blinking (Long)" },
  { value: "halfSec", label: "0.5 sec" },
  { value: "clear", label: "Uneffected" },
  { value: "raise", label: "Raise" },
  { value: "lower", label: "Lower" },
];

function labelForOption<T extends string>(options: BulkOption<T>[], value: T): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function formatBulkPreviewValue(value: string, dimmingType: string): string {
  const trimmed = value.trim();
  return trimmed ? formatLevel(trimmed, dimmingType) : "Uneffected";
}
const PERCENT_LEVEL_VALUES = ["Raise", "Lower"];
const ON_OFF_LEVEL_VALUES = ["On", "Off", "Blinking (Short)", "Blinking (Long)", "0.5 sec", "Uneffected"];

function getSetting(scene: Scene, circuitId: string): string {
  return scene.settings.find((s) => s.circuitId === circuitId)?.percentage ?? "";
}

function setSetting(scene: Scene, circuitId: string, percentage: string): Scene {
  return { ...scene, settings: setSceneSettingValue(scene.settings, circuitId, percentage) };
}

function sceneName(scene: Scene, index: number): string {
  return scene.name.trim() || `Scene ${index + 1}`;
}

function isOnOff(circuit: CircuitEntry): boolean {
  return isOnOffLikeDimmingType(circuit.dimmingType);
}

function fixtureKindLabel(kind: FixtureKind): string {
  if (kind === "DL") return "DL";
  if (kind === "Indirect") return "Indirect";
  if (kind === "Mixed") return "DL & Indirect";
  return "-";
}

export default function SceneView({
  scenes,
  locations,
  circuits,
  fixtures,
  hvacAssignments = [],
  hvacSeasons = [],
  curtainAssignments = [],
  switches = [],
  onChange,
  revisionChanges = {},
  canEdit = true,
  roomTypeName = "",
  roomType,
  devices = [],
  programmingNameSettings,
  externalSettingRequest = null,
  overlayHostOnly = false,
  initialSelectedAreaId = "",
  initialSelectedSceneId = "",
  embeddedSettingOverlay = false,
  suppressSceneNormalization = false,
}: SceneViewProps) {
  const [selectedAreaId, setSelectedAreaId] = useState(initialSelectedAreaId);
  const [selectedSceneId, setSelectedSceneId] = useState(initialSelectedSceneId);
  const [circuitMode, setCircuitMode] = useState<CircuitMode>("designer");
  const [viewMode, setViewMode] = useState<SceneViewMode>("edit");
  const [draggingSceneId, setDraggingSceneId] = useState<string | null>(null);
  const [sceneDragOverInfo, setSceneDragOverInfo] = useState<{
    targetId: string;
    position: SceneDropPosition;
  } | null>(null);
  const [checkedCircuitIds, setCheckedCircuitIds] = useState<Set<string>>(new Set());
  const [bulkValue, setBulkValue] = useState("");
  const [bulkTarget, setBulkTarget] = useState<BulkTarget>("all");
  const [bulkMode, setBulkMode] = useState<BulkMode>("percent");
  const [bulkConfirmation, setBulkConfirmation] = useState<AreaSceneBulkConfirmation | null>(null);
  const [lightingCollapsed, setLightingCollapsed] = useState(false);
  const [settingOverlaySceneId, setSettingOverlaySceneId] = useState<string | null>(null);
  const checkboxDragValueRef = useRef<boolean | null>(null);
  const checkboxDragStartRef = useRef<{
    circuitId: string;
    checked: boolean;
    x: number;
    y: number;
    active: boolean;
  } | null>(null);
  const consumedExternalRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    function activateCheckboxDrag(clientX: number, clientY: number, buttons: number): boolean {
      if (checkboxDragValueRef.current !== null) return true;
      const start = checkboxDragStartRef.current;
      if (!start || buttons !== 1) return false;
      const moved = Math.abs(clientX - start.x) > 3 || Math.abs(clientY - start.y) > 3;
      if (!moved) return false;
      start.active = true;
      checkboxDragValueRef.current = start.checked;
      setCircuitChecked(start.circuitId, start.checked);
      return true;
    }

    function continueCheckboxDragAt(clientX: number, clientY: number): void {
      const checked = checkboxDragValueRef.current;
      if (checked === null || !canEdit) return;
      const target = document.elementFromPoint(clientX, clientY);
      if (!(target instanceof Element)) return;
      const checkbox = target.closest<HTMLInputElement>('input.scene-check[data-circuit-id]');
      const row = target.closest<HTMLElement>("[data-scene-circuit-id]");
      const rowAtPoint = Array.from(document.querySelectorAll<HTMLElement>("[data-scene-circuit-id]")).find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
      });
      const circuitId = checkbox?.dataset.circuitId || row?.dataset.sceneCircuitId || rowAtPoint?.dataset.sceneCircuitId || "";
      if (!circuitId) return;
      setCheckedCircuitIds((prev) => {
        const alreadyChecked = prev.has(circuitId);
        if (alreadyChecked === checked) return prev;
        const next = new Set(prev);
        if (checked) next.add(circuitId);
        else next.delete(circuitId);
        return next;
      });
    }

    function continuePointerCheckboxDrag(event: PointerEvent): void {
      if (!activateCheckboxDrag(event.clientX, event.clientY, event.buttons)) return;
      continueCheckboxDragAt(event.clientX, event.clientY);
    }

    function continueMouseCheckboxDrag(event: MouseEvent): void {
      if (!activateCheckboxDrag(event.clientX, event.clientY, event.buttons)) return;
      continueCheckboxDragAt(event.clientX, event.clientY);
    }

    function finishCheckboxDrag(): void {
      checkboxDragValueRef.current = null;
      window.setTimeout(() => {
        checkboxDragStartRef.current = null;
      }, 50);
    }
    window.addEventListener("pointermove", continuePointerCheckboxDrag);
    window.addEventListener("mousemove", continueMouseCheckboxDrag);
    window.addEventListener("pointerup", finishCheckboxDrag);
    window.addEventListener("mouseup", finishCheckboxDrag);
    return () => {
      window.removeEventListener("pointermove", continuePointerCheckboxDrag);
      window.removeEventListener("mousemove", continueMouseCheckboxDrag);
      window.removeEventListener("pointerup", finishCheckboxDrag);
      window.removeEventListener("mouseup", finishCheckboxDrag);
    };
  }, [canEdit]);

  function hasRevisionChange(id: string, fields?: string[]): boolean {
    const changed = revisionChanges[id];
    if (!changed) return false;
    if (!fields) return changed.length > 0;
    return fields.some((field) => changed.includes(field));
  }

  function revisionCellClass(id: string, fields?: string[]): string {
    return hasRevisionChange(id, fields) ? "revision-changed-cell" : "";
  }

  const deviceAssignments = roomType?.deviceAssignments;
  const areaSceneSource = useMemo<AreaSceneSourceInput>(
    () => ({
      locations,
      circuits,
      hvacAssignments,
      curtainAssignments,
      switches,
      // T-59: merge zones carrying additional circuits into one lighting row.
      deviceAssignments: deviceAssignments ?? [],
    }),
    [locations, circuits, hvacAssignments, curtainAssignments, switches, deviceAssignments],
  );

  const firstTargetAreaId = useMemo(
    () => findFirstAreaSceneTargetAreaId(areaSceneSource),
    [areaSceneSource],
  );

  useEffect(() => {
    if (selectedAreaId === HVAC_AREA_ID && hvacAssignments.length > 0) return;
    const selectedAreaHasTargets =
      selectedAreaId &&
      buildAreaSceneTargets(selectedAreaId, areaSceneSource).length > 0;
    if (selectedAreaHasTargets) return;
    setSelectedAreaId(firstTargetAreaId);
  }, [areaSceneSource, hvacAssignments.length, selectedAreaId, firstTargetAreaId]);

  const availableAreas = useMemo(
    () => buildAreaSceneAreas(areaSceneSource),
    [areaSceneSource],
  );
  const areaCircuits = useMemo(
    () => buildAreaSceneCircuitHeads(selectedAreaId, areaSceneSource),
    [selectedAreaId, areaSceneSource],
  );

  const areaScenes = useMemo(
    () => scenes.filter((s) => s.areaId === selectedAreaId),
    [scenes, selectedAreaId],
  );

  useEffect(() => {
    if (areaScenes.some((s) => s.id === selectedSceneId)) return;
    setSelectedSceneId(areaScenes[0]?.id ?? "");
  }, [areaScenes, selectedSceneId]);

  useEffect(() => {
    const visibleIds = new Set(areaCircuits.map((c) => c.id));
    setCheckedCircuitIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [areaCircuits]);

  useEffect(() => {
    if (!canEdit || overlayHostOnly || suppressSceneNormalization) return;
    let changed = false;
    const normalizedScenes = scenes.map((scene) => {
      const settings = normalizeSceneSettingsByCircuitGroup(scene.settings, circuits);
      if (sameSceneSettings(settings, scene.settings)) return scene;
      changed = true;
      return { ...scene, settings };
    });
    if (changed) onChange(normalizedScenes);
  }, [canEdit, circuits, onChange, scenes, overlayHostOnly, suppressSceneNormalization]);

  const selectedArea = availableAreas.find((l) => l.id === selectedAreaId);
  const isHvacAreaScene = selectedAreaId === HVAC_AREA_ID;
  const areaHvacItems = useMemo(
    () => buildAreaSceneHvacTargets(selectedAreaId, areaSceneSource),
    [selectedAreaId, areaSceneSource],
  );
  const areaCurtainItems = useMemo(
    () => buildAreaSceneCurtainTargets(selectedAreaId, areaSceneSource),
    [selectedAreaId, areaSceneSource],
  );
  const areaPicoLedItems = useMemo(
    () => buildAreaScenePicoLedTargets(selectedAreaId, areaSceneSource),
    [selectedAreaId, areaSceneSource],
  );
  const selectedScene = areaScenes.find((s) => s.id === selectedSceneId);
  const settingOverlayScene = settingOverlaySceneId
    ? scenes.find((scene) => scene.id === settingOverlaySceneId) ?? null
    : null;
  const settingOverlayOpen = Boolean(settingOverlayScene);
  const allAreaCircuitsChecked =
    areaCircuits.length > 0 && areaCircuits.every((c) => checkedCircuitIds.has(c.id));
  const canAddSelectedAreaScene =
    canEdit && selectedAreaId !== "" && (areaCircuits.length > 0 || areaHvacItems.length > 0 || areaCurtainItems.length > 0 || areaPicoLedItems.length > 0);

  useEffect(() => {
    if (!externalSettingRequest) return;
    if (consumedExternalRequestIdRef.current === externalSettingRequest.requestId) return;
    consumedExternalRequestIdRef.current = externalSettingRequest.requestId;

    const scene = scenes.find((candidate) => candidate.id === externalSettingRequest.sceneId);
    if (!scene) {
      setSettingOverlaySceneId(null);
      return;
    }
    setSelectedAreaId(scene.areaId);
    setSelectedSceneId(scene.id);
    setViewMode("edit");
    setSettingOverlaySceneId(scene.id);
  }, [externalSettingRequest, scenes]);

  useEffect(() => {
    if (!settingOverlaySceneId) return;
    if (scenes.some((scene) => scene.id === settingOverlaySceneId)) return;
    setSettingOverlaySceneId(null);
  }, [scenes, settingOverlaySceneId]);

  function closeSettingOverlay(): void {
    setSettingOverlaySceneId(null);
  }

  useEffect(() => {
    if (!settingOverlayOpen || bulkConfirmation) return;
    function handleEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") closeSettingOverlay();
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [settingOverlayOpen, bulkConfirmation]);

  useEffect(() => {
    if (!bulkConfirmation) return;
    function handleEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setBulkConfirmation(null);
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [bulkConfirmation]);

  useEffect(() => {
    if (!settingOverlayOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [settingOverlayOpen]);

  function getAreaCircuitCount(areaId: string): number {
    return (
      buildAreaSceneCircuitHeads(areaId, areaSceneSource).length +
      hvacAssignments.filter((assignment) => assignment.area === areaId).length * 4 +
      curtainAssignments.filter((assignment) => assignment.area === areaId).length +
      buildAreaScenePicoLedTargets(areaId, areaSceneSource).length
    );
  }

  function getAreaSceneCount(areaId: string): number {
    return scenes.reduce((acc, s) => (s.areaId === areaId ? acc + 1 : acc), 0);
  }

  function getCircuitFixtureKind(circuit: CircuitEntry): FixtureKind {
    const groupId = circuit.circuitGroupId.trim();
    const related = groupId
      ? circuits.filter((candidate) => candidate.circuitGroupId.trim() === groupId)
      : [circuit];
    const kinds = new Set<"DL" | "Indirect">();
    for (const entry of related.length > 0 ? related : [circuit]) {
      const type = fixtures.find((fixture) => fixture.fixture === entry.fixture)?.fixtureType;
      if (type === "DL") kinds.add("DL");
      if (type === "Indirect") kinds.add("Indirect");
    }
    if (kinds.has("DL") && kinds.has("Indirect")) return "Mixed";
    if (kinds.has("DL")) return "DL";
    if (kinds.has("Indirect")) return "Indirect";
    return "Unknown";
  }

  function handleAddScene(): void {
    if (!canAddSelectedAreaScene) return;
    const nextScene = createEmptyScene(selectedAreaId);
    onChange([...scenes, nextScene]);
    setSelectedSceneId(nextScene.id);
  }

  function handleCopyScene(): void {
    if (!canEdit) return;
    if (!selectedScene) return;
    const copied: Scene = {
      ...selectedScene,
      id: createAppId(),
      name: `${selectedScene.name.trim() || "Scene"} Copy`,
      settings: selectedScene.settings.map((s) => ({ ...s })),
    };
    const index = scenes.findIndex((s) => s.id === selectedScene.id);
    onChange([...scenes.slice(0, index + 1), copied, ...scenes.slice(index + 1)]);
    setSelectedSceneId(copied.id);
  }

  function handleRemoveScene(): void {
    if (!canEdit) return;
    if (!selectedScene) return;
    const next = scenes.filter((s) => s.id !== selectedScene.id);
    onChange(next);
    setSelectedSceneId(next.find((s) => s.areaId === selectedAreaId)?.id ?? "");
  }

  function handleRenameScene(name: string): void {
    if (!canEdit) return;
    if (!selectedScene) return;
    onChange(scenes.map((s) => (s.id === selectedScene.id ? { ...s, name } : s)));
  }

  function handleSceneDragStart(e: DragEvent<HTMLButtonElement>, sceneId: string): void {
    if (!canEdit) return;
    setDraggingSceneId(sceneId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", sceneId);
  }

  function handleSceneDragOver(e: DragEvent<HTMLButtonElement>, targetId: string): void {
    if (!draggingSceneId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const position: SceneDropPosition =
      e.clientX < rect.left + rect.width / 2 ? "before" : "after";
    setSceneDragOverInfo((prev) =>
      prev?.targetId === targetId && prev.position === position
        ? prev
        : { targetId, position },
    );
  }

  function handleSceneDrop(e: DragEvent<HTMLButtonElement>, targetId: string): void {
    if (!canEdit) return;
    e.preventDefault();
    const draggedId = draggingSceneId ?? e.dataTransfer.getData("text/plain");
    if (!draggedId || draggedId === targetId) {
      setDraggingSceneId(null);
      setSceneDragOverInfo(null);
      return;
    }

    const orderedAreaScenes = [...areaScenes];
    const from = orderedAreaScenes.findIndex((s) => s.id === draggedId);
    const to = orderedAreaScenes.findIndex((s) => s.id === targetId);
    if (from === -1 || to === -1) {
      setDraggingSceneId(null);
      setSceneDragOverInfo(null);
      return;
    }

    const [moved] = orderedAreaScenes.splice(from, 1);
    const targetAfterRemoval = orderedAreaScenes.findIndex((s) => s.id === targetId);
    const insertAfter = sceneDragOverInfo?.targetId === targetId && sceneDragOverInfo.position === "after";
    orderedAreaScenes.splice(targetAfterRemoval + (insertAfter ? 1 : 0), 0, moved);

    const reordered: Scene[] = [];
    let insertedArea = false;
    for (const scene of scenes) {
      if (scene.areaId !== selectedAreaId) {
        reordered.push(scene);
      } else if (!insertedArea) {
        reordered.push(...orderedAreaScenes);
        insertedArea = true;
      }
    }
    onChange(reordered);
    setDraggingSceneId(null);
    setSceneDragOverInfo(null);
  }

  function updateSelectedScene(mutator: (scene: Scene) => Scene): void {
    if (!canEdit) return;
    if (!selectedScene) return;
    onChange(scenes.map((s) => (s.id === selectedScene.id ? mutator(s) : s)));
  }

  function handleSettingChange(circuitId: string, value: string): void {
    updateSelectedScene((scene) => setSetting(scene, circuitId, value));
  }

  function handleCircuitSettingChange(circuit: CircuitEntry, value: string): void {
    updateSelectedScene((scene) => ({
      ...scene,
      settings: setSceneSettingValueForCircuitGroup(scene.settings, circuits, circuit, value),
    }));
  }

  function stepPercent(circuit: CircuitEntry, delta: number): void {
    if (!selectedScene) return;
    handleCircuitSettingChange(
      circuit,
      stepPercentValue(sceneSettingValueForCircuitGroup(selectedScene.settings, circuits, circuit), delta),
    );
  }

  function stepBulk(delta: number): void {
    setBulkPercentValue(stepPercentValue(bulkValue, delta));
  }

  function targetCircuitsForBulk(): CircuitEntry[] {
    if (bulkTarget === "all") {
      return areaCircuits;
    }
    if (bulkTarget === "checked") {
      return areaCircuits.filter((c) => checkedCircuitIds.has(c.id));
    }
    if (bulkTarget === "onOff") {
      return areaCircuits.filter((c) => isOnOff(c));
    }
    if (bulkTarget === "dl") {
      return areaCircuits.filter((c) => {
        const kind = getCircuitFixtureKind(c);
        return kind === "DL" || kind === "Mixed";
      });
    }
    return areaCircuits.filter((c) => {
      const kind = getCircuitFixtureKind(c);
      return kind === "Indirect" || kind === "Mixed";
    });
  }

  function setBulkPercentValue(rawValue: string): void {
    setBulkMode("percent");
    setBulkValue(clampPercentValue(rawValue));
  }

  function buildBulkConfirmation(mode: BulkMode, rawValue = bulkValue): AreaSceneBulkConfirmation | null {
    if (!selectedScene) return null;
    const valueForMode = mode === "percent" ? clampPercentValue(rawValue) : rawValue;
    if (mode === "percent" && !valueForMode) return null;

    const targets = targetCircuitsForBulk()
      .map((circuit) => ({
        circuit,
        value: settingValueForBulkMode(mode, isOnOff(circuit), valueForMode),
      }))
      .filter((item): item is { circuit: CircuitEntry; value: string } => item.value !== null);
    if (targets.length === 0) return null;

    return {
      sceneId: selectedScene.id,
      targetLabel: labelForOption(BULK_TARGET_OPTIONS, bulkTarget),
      modeLabel: mode === "percent" ? `Percent ${valueForMode}%` : labelForOption(BULK_MODE_OPTIONS, mode),
      items: targets.map(({ circuit, value }, index) => ({
        circuit,
        rowNumber: String(index + 1),
        designerNumber: circuit.designerNumber.trim() || "(Unset)",
        detail: circuit.detail.trim() || "-",
        currentDisplay: formatBulkPreviewValue(
          sceneSettingValueForCircuitGroup(selectedScene.settings, circuits, circuit),
          circuit.dimmingType,
        ),
        nextDisplay: formatBulkPreviewValue(value, circuit.dimmingType),
        nextValue: value,
      })),
    };
  }

  function requestBulkApply(mode: BulkMode): void {
    const valueForMode = mode === "percent" ? clampPercentValue(bulkValue) : bulkValue;
    if (mode === "percent") setBulkValue(valueForMode);
    setBulkMode(mode);
    setBulkConfirmation(buildBulkConfirmation(mode, valueForMode));
  }

  function confirmBulkApply(): void {
    if (!bulkConfirmation) return;
    if (!selectedScene || selectedScene.id !== bulkConfirmation.sceneId) {
      setBulkConfirmation(null);
      return;
    }
    const targets = bulkConfirmation.items;
    updateSelectedScene((scene) =>
      targets.reduce(
        (next, item) => ({
          ...next,
          settings: setSceneSettingValueForCircuitGroup(next.settings, circuits, item.circuit, item.nextValue),
        }),
        scene,
      ),
    );
    setBulkConfirmation(null);
  }

  function canApplyBulkMode(mode: BulkMode): boolean {
    if (mode === "percent" && !clampPercentValue(bulkValue)) return false;
    return hasBulkTargetsForMode(mode);
  }

  function hasBulkTargetsForMode(mode: BulkMode): boolean {
    return targetCircuitsForBulk().some((circuit) => bulkModeAppliesToTarget(mode, isOnOff(circuit)));
  }

  function getCircuitLabel(c: CircuitEntry): string {
    const value = circuitMode === "designer" ? c.designerNumber : c.internalNumber;
    return value.trim() || "(Unset)";
  }

  function toggleChecked(circuitId: string, checked: boolean): void {
    setCircuitChecked(circuitId, checked);
  }

  function setCircuitChecked(circuitId: string, checked: boolean): void {
    setCheckedCircuitIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(circuitId);
      else next.delete(circuitId);
      return next;
    });
  }

  function toggleAllChecked(checked: boolean): void {
    setCheckedCircuitIds(checked ? new Set(areaCircuits.map((c) => c.id)) : new Set());
  }

  function circuitIdFromCheckTarget(target: EventTarget | null): string {
    if (!(target instanceof Element)) return "";
    const checkbox = target.closest<HTMLInputElement>('input.scene-check[data-circuit-id]');
    return checkbox?.dataset.circuitId || "";
  }

  function focusCheckTarget(target: EventTarget | null): void {
    if (!(target instanceof Element)) return;
    target.closest<HTMLInputElement>('input.scene-check[data-circuit-id]')?.focus();
  }

  function startCheckboxDrag(circuitId: string): void {
    if (!canEdit || !circuitId) return;
    const nextChecked = !checkedCircuitIds.has(circuitId);
    checkboxDragStartRef.current = {
      circuitId,
      checked: nextChecked,
      x: 0,
      y: 0,
      active: false,
    };
  }

  function handleCheckPointerDragStart(event: ReactPointerEvent<HTMLElement>): void {
    if (event.pointerType === "mouse") return;
    const circuitId = circuitIdFromCheckTarget(event.target);
    if (!circuitId) return;
    focusCheckTarget(event.target);
    startCheckboxDrag(circuitId);
    if (checkboxDragStartRef.current) {
      checkboxDragStartRef.current.x = event.clientX;
      checkboxDragStartRef.current.y = event.clientY;
    }
  }

  function handleCheckMouseDragStart(event: ReactMouseEvent<HTMLElement>): void {
    if (!canEdit || event.button !== 0) return;
    const circuitId = circuitIdFromCheckTarget(event.target);
    if (!circuitId) return;
    focusCheckTarget(event.target);
    startCheckboxDrag(circuitId);
    if (checkboxDragStartRef.current) {
      checkboxDragStartRef.current.x = event.clientX;
      checkboxDragStartRef.current.y = event.clientY;
    }
  }

  function handleCheckClickCapture(event: ReactMouseEvent<HTMLInputElement>): void {
    if (!checkboxDragStartRef.current?.active) return;
    event.preventDefault();
    event.stopPropagation();
    checkboxDragValueRef.current = null;
    checkboxDragStartRef.current = null;
  }

  function handleCheckPointerEnter(circuit: CircuitEntry): void {
    const checked = checkboxDragValueRef.current;
    if (checked === null || !canEdit) return;
    setCircuitChecked(circuit.id, checked);
  }

  function handleCheckMouseDragMove(event: ReactMouseEvent<HTMLElement>): void {
    if (!canEdit) return;
    const circuitId = circuitIdFromCheckTarget(event.target);
    if (!circuitId) return;
    const checked = checkboxDragValueRef.current;
    if (checked === null) return;
    setCircuitChecked(circuitId, checked);
  }

  function handleCheckPointerDragMove(event: ReactPointerEvent<HTMLElement>): void {
    if (!canEdit) return;
    const circuitId = circuitIdFromCheckTarget(event.target);
    if (!circuitId) return;
    const checked = checkboxDragValueRef.current;
    if (checked === null) return;
    setCircuitChecked(circuitId, checked);
  }

  function renderBulkConfirmation(): ReactNode {
    if (!bulkConfirmation) return null;
    const titleId = `scene-bulk-confirm-title-${bulkConfirmation.sceneId}`;
    const overlay = (
      <div className="setting-overlay scene-bulk-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <button
          type="button"
          className="setting-overlay-backdrop"
          aria-label="Cancel bulk change"
          onClick={() => setBulkConfirmation(null)}
        />
        <div className="setting-overlay-panel scene-bulk-confirm-panel">
          <div className="setting-overlay-header">
            <div>
              <strong id={titleId}>Confirm Bulk Change</strong>
              <div className="scene-bulk-confirm-summary">
                <span>Target: {bulkConfirmation.targetLabel}</span>
                <span>Mode: {bulkConfirmation.modeLabel}</span>
                <span>{bulkConfirmation.items.length} targets</span>
              </div>
            </div>
            <div className="setting-overlay-actions">
              <button type="button" className="btn btn-danger-ghost" onClick={() => setBulkConfirmation(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={confirmBulkApply} disabled={!canEdit}>
                Confirm
              </button>
            </div>
          </div>
          <div className="matrix-scroll scene-bulk-confirm-scroll">
            <table className="matrix-table master-table scene-bulk-confirm-table" aria-label="Bulk target preview">
              <thead>
                <tr>
                  <th>No</th>
                  <th>Designer#</th>
                  <th>Detail</th>
                  <th>Current</th>
                  <th>New</th>
                </tr>
              </thead>
              <tbody>
                {bulkConfirmation.items.map((item) => (
                  <tr key={item.circuit.id}>
                    <td className="col-center">{item.rowNumber}</td>
                    <td><span className="cell-readonly">{item.designerNumber}</span></td>
                    <td><span className="cell-readonly">{item.detail}</span></td>
                    <td><span className="cell-readonly">{item.currentDisplay}</span></td>
                    <td><span className="cell-readonly">{item.nextDisplay}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
    return typeof document === "undefined" ? null : createPortal(overlay, document.body);
  }

  function renderSettingOverlay(): ReactNode {
    if (!settingOverlayScene) return null;
    const areaScenesForOverlay = scenes.filter((scene) => scene.areaId === settingOverlayScene.areaId);
    const settingOverlayTitle = sceneName(
      settingOverlayScene,
      Math.max(0, areaScenesForOverlay.findIndex((scene) => scene.id === settingOverlayScene.id)),
    );
    const overlay = (
      <div className="setting-overlay" role="dialog" aria-modal="true">
        <button
          type="button"
          className="setting-overlay-backdrop"
          aria-label="Close settings"
          onClick={closeSettingOverlay}
        />
        <div className="setting-overlay-panel">
          <div className="setting-overlay-header">
            <strong>Area Scene Setting / {settingOverlayTitle}</strong>
            <div className="setting-overlay-actions">
              <button type="button" className="btn btn-danger-ghost" onClick={closeSettingOverlay}>
                Close
              </button>
            </div>
          </div>
          <SceneView
            key={`area-scene-setting-overlay:${settingOverlayScene.id}:${externalSettingRequest?.requestId ?? 0}`}
            scenes={scenes}
            locations={locations}
            circuits={circuits}
            fixtures={fixtures}
            hvacAssignments={hvacAssignments}
            hvacSeasons={hvacSeasons}
            curtainAssignments={curtainAssignments}
            switches={switches}
            onChange={onChange}
            revisionChanges={revisionChanges}
            canEdit={canEdit}
            roomTypeName={roomTypeName}
            roomType={roomType}
            devices={devices}
            programmingNameSettings={programmingNameSettings}
            initialSelectedAreaId={settingOverlayScene.areaId}
            initialSelectedSceneId={settingOverlayScene.id}
            embeddedSettingOverlay
            suppressSceneNormalization
          />
        </div>
      </div>
    );
    return typeof document === "undefined" ? null : createPortal(overlay, document.body);
  }

  if (overlayHostOnly) {
    return <>{renderSettingOverlay()}</>;
  }

  if (locations.length === 0) {
    return (
      <section className="card card-padded fade-in">
        <p className="screen-empty">
          No areas are registered. Create areas in the Area tab first.
        </p>
      </section>
    );
  }

  return (
    <section className={`card card-padded fade-in scene-view${embeddedSettingOverlay ? " scene-view-setting-overlay-content" : ""}`}>
      {!embeddedSettingOverlay ? (
      <div className="scene-view-mode-bar" role="tablist" aria-label="Area Scene view mode">
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === "edit"}
          className={`scene-view-mode-chip${viewMode === "edit" ? " scene-view-mode-chip-active" : ""}`}
          onClick={() => setViewMode("edit")}
          data-testid="area-scene-mode-edit"
        >
          Edit
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === "overview"}
          className={`scene-view-mode-chip${viewMode === "overview" ? " scene-view-mode-chip-active" : ""}`}
          onClick={() => setViewMode("overview")}
          data-testid="area-scene-mode-overview"
        >
          Overview
        </button>
      </div>
      ) : null}

      {!embeddedSettingOverlay && viewMode === "overview" ? (
        <AreaSceneOverview
          scenes={scenes}
          locations={locations}
          circuits={circuits}
          hvacAssignments={hvacAssignments}
          curtainAssignments={curtainAssignments}
          switches={switches}
          roomTypeName={roomTypeName}
          roomType={roomType}
          devices={devices}
          fixtures={fixtures}
          programmingNameSettings={programmingNameSettings}
        />
      ) : (
      <>
      <div className="scene-area-bar" role="tablist" aria-label="Area selection">
        {availableAreas.map((loc) => {
          const active = loc.id === selectedAreaId;
          const areaHighlighted = scenes.some((scene) => scene.areaId === loc.id && hasRevisionChange(scene.id));
          return (
            <button
              key={loc.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`scene-area-chip${active ? " scene-area-chip-active" : ""}${areaHighlighted ? " tab-highlighted" : ""}`}
              onClick={() => setSelectedAreaId(loc.id)}
            >
              <span className="scene-area-chip-name">{loc.name || "(No name)"}</span>
              <span className="scene-area-chip-meta">
                {getAreaCircuitCount(loc.id)} circuits / {getAreaSceneCount(loc.id)} scenes
              </span>
            </button>
          );
        })}
      </div>

      <div className="scene-toolbar">
        <div className="scene-tabs" role="tablist" aria-label="Scene selection">
          {areaScenes.map((scene, index) => {
            const active = scene.id === selectedSceneId;
            return (
              <button
                key={scene.id}
                type="button"
                role="tab"
                draggable={!embeddedSettingOverlay}
                aria-selected={active}
                className={[
                  "scene-tab",
                  active ? "scene-tab-active" : "",
                  draggingSceneId === scene.id ? "scene-tab-dragging" : "",
                  sceneDragOverInfo?.targetId === scene.id && sceneDragOverInfo.position === "before"
                    ? "scene-tab-drop-before"
                    : "",
                  sceneDragOverInfo?.targetId === scene.id && sceneDragOverInfo.position === "after"
                    ? "scene-tab-drop-after"
                    : "",
                  hasRevisionChange(scene.id) ? "tab-highlighted" : "",
                ].filter(Boolean).join(" ")}
                onClick={() => setSelectedSceneId(scene.id)}
                onDragStart={(e) => handleSceneDragStart(e, scene.id)}
                onDragOver={(e) => handleSceneDragOver(e, scene.id)}
                onDrop={(e) => handleSceneDrop(e, scene.id)}
                onDragEnd={() => {
                  setDraggingSceneId(null);
                  setSceneDragOverInfo(null);
                }}
              >
                {sceneName(scene, index)}
              </button>
            );
          })}
        </div>
        <div className="scene-toolbar-actions">
          {!embeddedSettingOverlay ? (
          <>
          <ActionIconButton
            icon="plus"
            label="Add Scene"
            className="btn-secondary"
            onClick={handleAddScene}
            disabled={!canAddSelectedAreaScene}
          />
          <ActionIconButton
            icon="copy"
            label="Copy Scene"
            className="btn-secondary"
            onClick={handleCopyScene}
            disabled={!canEdit || !selectedScene}
          />
          <ActionIconButton
            icon="trash"
            label="Delete Scene"
            className="btn-danger-ghost"
            onClick={handleRemoveScene}
            disabled={!canEdit || !selectedScene}
          />
          </>
          ) : null}
          <button
            type="button"
            className="header-toggle"
            onClick={() =>
              setCircuitMode((prev) => (prev === "designer" ? "internal" : "designer"))
            }
          >
            {circuitMode === "designer" ? "Designer#" : "Internal#"}
          </button>
        </div>
      </div>

      {areaCircuits.length === 0 && areaHvacItems.length === 0 && areaCurtainItems.length === 0 && areaPicoLedItems.length === 0 ? (
        <p className="screen-empty">No circuits, HVAC points, Lutron Curtain rows, or Pico LED targets are assigned to this area.</p>
      ) : (
        <>
        {!selectedScene ? null : (
        <div className="scene-card">
          <div className="scene-card-head">
            <input
              className={`cell-input scene-name-input ${revisionCellClass(selectedScene.id, ["name"])}`}
              value={selectedScene.name}
              onChange={(e) => handleRenameScene(e.target.value)}
              disabled={!canEdit}
            />
            {!isHvacAreaScene ? (
            <AreaSceneBulkPanel
              canEdit={canEdit}
              bulkTarget={bulkTarget}
              bulkMode={bulkMode}
              bulkValue={bulkValue}
              onTargetChange={setBulkTarget}
              onModeChange={setBulkMode}
              onPercentValueChange={setBulkPercentValue}
              onStep={stepBulk}
              onApply={() => requestBulkApply(bulkMode)}
              canApplyMode={canApplyBulkMode}
              hasTargetsForMode={hasBulkTargetsForMode}
            />
            ) : null}
          </div>

          {!isHvacAreaScene ? (
          <>
          <button
            type="button"
            className="switch-area-toggle hvac-setting-toggle"
            onClick={() => setLightingCollapsed((prev) => !prev)}
            aria-expanded={!lightingCollapsed}
          >
            <span className="switch-area-caret">{lightingCollapsed ? ">" : "v"}</span>
            <span>Lighting</span>
            <span className="muted-pill">{areaCircuits.length}</span>
          </button>
          {lightingCollapsed ? null : (
          <div className="matrix-scroll">
            <table className="matrix-table master-table scene-table">
              <thead>
                <tr>
                  <th className="col-center" style={{ minWidth: 64 }}>
                    <input
                      type="checkbox"
                      className="scene-check"
                      checked={allAreaCircuitsChecked}
                      onChange={(e) => toggleAllChecked(e.target.checked)}
                      aria-label="Select all"
                      disabled={!canEdit}
                    />
                  </th>
                  <th style={{ minWidth: 140 }}>Area</th>
                  <th style={{ minWidth: 140 }}>Circuit #</th>
                  <th style={{ minWidth: 130 }}>Dimming Type</th>
                  <th style={{ minWidth: 180 }}>Detail</th>
                  <th style={{ minWidth: 140 }}>Fixture Type</th>
                  <th style={{ minWidth: 220 }}>Level</th>
                </tr>
              </thead>
              <tbody
                onPointerDownCapture={handleCheckPointerDragStart}
                onMouseDownCapture={handleCheckMouseDragStart}
                onPointerMove={handleCheckPointerDragMove}
                onPointerOver={handleCheckPointerDragMove}
                onMouseMove={handleCheckMouseDragMove}
                onMouseOver={handleCheckMouseDragMove}
              >
                {areaCircuits.map((c) => {
                  const value = sceneSettingValueForCircuitGroup(selectedScene.settings, circuits, c);
                  const fixtureKind = getCircuitFixtureKind(c);
                  return (
                    <tr
                      key={c.id}
                      data-scene-circuit-id={c.id}
                      onPointerEnter={() => handleCheckPointerEnter(c)}
                      onMouseEnter={() => handleCheckPointerEnter(c)}
                    >
                      <td className="col-center">
                        <input
                          type="checkbox"
                          className="scene-check"
                          data-circuit-id={c.id}
                          checked={checkedCircuitIds.has(c.id)}
                          onClickCapture={handleCheckClickCapture}
                          onChange={(e) => toggleChecked(c.id, e.target.checked)}
                          onPointerEnter={() => handleCheckPointerEnter(c)}
                          onMouseEnter={() => handleCheckPointerEnter(c)}
                          aria-label={`Use ${getCircuitLabel(c)} as a bulk target`}
                          disabled={!canEdit}
                        />
                      </td>
                      <td className={revisionCellClass(selectedScene.id, ["settings"])}>
                        <span className="cell-readonly">{selectedArea?.name || ""}</span>
                      </td>
                      <td>
                        <span className="cell-readonly">{getCircuitLabel(c)}</span>
                      </td>
                      <td>
                        <span className="cell-readonly">{c.dimmingType || "-"}</span>
                      </td>
                      <td>
                        <span className="cell-readonly">{c.detail}</span>
                      </td>
                      <td>
                        <span className="cell-readonly">{fixtureKindLabel(fixtureKind)}</span>
                      </td>
                      <td>
                        {isOnOff(c) ? (
                          <div className="switch-onoff-buttons scene-onoff-buttons" role="group" aria-label="On Off Uneffected 0.5 sec">
                            {ON_OFF_LEVEL_VALUES.map((option) => (
                              <button
                                key={option}
                                type="button"
                                className={(option === "Uneffected" ? value === "" : value === option) ? "is-active" : ""}
                                onClick={() => handleCircuitSettingChange(c, option === "Uneffected" ? "" : option)}
                                disabled={!canEdit}
                              >
                                {option}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="scene-level-control">
                            <input
                              className="cell-input scene-level-input"
                              type="text"
                              value={value}
                              onChange={(e) =>
                                handleCircuitSettingChange(c, Number.isFinite(Number.parseFloat(e.target.value)) ? clampPercentValue(e.target.value) : e.target.value)
                              }
                              disabled={!canEdit}
                            />
                            <div className="scene-step-grid" aria-label="Level adjustment">
                              <button type="button" onClick={() => stepPercent(c, 1)} disabled={!canEdit}>+1</button>
                              <button type="button" onClick={() => stepPercent(c, 10)} disabled={!canEdit}>+10</button>
                              <button type="button" onClick={() => stepPercent(c, -1)} disabled={!canEdit}>-1</button>
                              <button type="button" onClick={() => stepPercent(c, -10)} disabled={!canEdit}>-10</button>
                            </div>
                            <button
                              type="button"
                              className={`btn-clear-circuit${value === "" ? " is-active" : ""}`}
                              onClick={() => handleCircuitSettingChange(c, "")}
                              disabled={!canEdit}
                            >
                              Uneffected
                            </button>
                            <div className="scene-quick-buttons area-scene-extra-buttons">
                              {PERCENT_LEVEL_VALUES.map((option) => (
                                <button
                                  key={option}
                                  type="button"
                                  className={value === option ? "is-active" : ""}
                                  onClick={() => handleCircuitSettingChange(c, option)}
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
          )}
          </>
          ) : null}

          <HvacSettingPanel
            targets={areaHvacItems}
            getValue={(targetId) => getSetting(selectedScene, targetId)}
            onChange={(targetId, value) => handleSettingChange(targetId, value)}
            onChangeMany={(updates) =>
              updateSelectedScene((scene) =>
                updates.reduce((next, update) => setSetting(next, update.targetId, update.value), scene),
              )
            }
            defaultCollapsed={false}
            resetKey={`${selectedAreaId}:${selectedSceneId}`}
            seasons={hvacSeasons}
            disabled={!canEdit}
          />
          <OnOffSettingPanel
            title="Pico LED"
            targets={areaPicoLedItems}
            getValue={(targetId) => getSetting(selectedScene, targetId)}
            onChange={(targetId, value) => handleSettingChange(targetId, value)}
            disabled={!canEdit}
          />
          <CurtainSettingPanel
            targets={areaCurtainItems}
            getValue={(targetId) => getSetting(selectedScene, targetId)}
            onChange={(targetId, value) => handleSettingChange(targetId, value)}
            disabled={!canEdit}
          />
        </div>
        )}
        </>
      )}
      </>
      )}
      {renderBulkConfirmation()}
    </section>
  );
}

function AreaSceneBulkPanel({
  canEdit,
  bulkTarget,
  bulkMode,
  bulkValue,
  onTargetChange,
  onModeChange,
  onPercentValueChange,
  onStep,
  onApply,
  canApplyMode,
  hasTargetsForMode,
}: {
  canEdit: boolean;
  bulkTarget: BulkTarget;
  bulkMode: BulkMode;
  bulkValue: string;
  onTargetChange: (target: BulkTarget) => void;
  onModeChange: (mode: BulkMode) => void;
  onPercentValueChange: (value: string) => void;
  onStep: (delta: number) => void;
  onApply: () => void;
  canApplyMode: (mode: BulkMode) => boolean;
  hasTargetsForMode: (mode: BulkMode) => boolean;
}): React.JSX.Element {
  return (
    <div className="scene-bulk-panel">
      <div className="scene-bulk-targets" role="group" aria-label="Bulk target">
        {BULK_TARGET_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`scene-bulk-target${bulkTarget === option.value ? " scene-bulk-target-active" : ""}`}
            onClick={() => onTargetChange(option.value)}
            disabled={!canEdit}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="scene-level-control scene-bulk-control">
        <input
          className="cell-input scene-level-input"
          type="number"
          min="0"
          max="100"
          step="1"
          value={bulkValue}
          onChange={(e) => onPercentValueChange(e.target.value)}
          onFocus={() => onModeChange("percent")}
          disabled={!canEdit || !hasTargetsForMode("percent")}
        />
        <div className="scene-step-grid" aria-label="Bulk level adjustment">
          <button type="button" onClick={() => onStep(1)} disabled={!canEdit || !hasTargetsForMode("percent")}>+1</button>
          <button type="button" onClick={() => onStep(10)} disabled={!canEdit || !hasTargetsForMode("percent")}>+10</button>
          <button type="button" onClick={() => onStep(-1)} disabled={!canEdit || !hasTargetsForMode("percent")}>-1</button>
          <button type="button" onClick={() => onStep(-10)} disabled={!canEdit || !hasTargetsForMode("percent")}>-10</button>
        </div>
      </div>
      <div className="scene-bulk-mode-buttons" role="group" aria-label="Percent On Off Blinking Uneffected Raise Lower">
        {BULK_MODE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`scene-bulk-target${bulkMode === option.value ? " scene-bulk-target-active" : ""}`}
            onClick={() => onModeChange(option.value)}
            disabled={!canEdit || !hasTargetsForMode(option.value)}
          >
            {option.label}
          </button>
        ))}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onApply}
          disabled={!canEdit || !canApplyMode(bulkMode)}
        >
          Apply Bulk
        </button>
      </div>
    </div>
  );
}

function OnOffSettingPanel({
  title,
  targets,
  getValue,
  onChange,
  disabled,
}: {
  title: string;
  targets: SettingTarget[];
  getValue: (targetId: string) => string;
  onChange: (targetId: string, value: string) => void;
  disabled: boolean;
}): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false);
  if (targets.length === 0) return null;
  return (
    <div className="hvac-setting-panel curtain-setting-panel">
      <button
        type="button"
        className="switch-area-toggle hvac-setting-toggle"
        onClick={() => setCollapsed((prev) => !prev)}
        aria-expanded={!collapsed}
      >
        <span className="switch-area-caret">{collapsed ? ">" : "v"}</span>
        <span>{title}</span>
        <span className="muted-pill">{targets.length}</span>
      </button>
      {collapsed ? null : (
        <div className="matrix-scroll">
          <table className="matrix-table master-table switch-setting-table curtain-setting-table">
            <thead>
              <tr>
                <th>Switch</th>
                <th>Area</th>
                <th>Target</th>
                <th>Setting</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((target) => {
                const value = getValue(target.id);
                return (
                  <tr key={target.id}>
                    <td className="col-center">{target.circuitNumber}</td>
                    <td><span className="cell-readonly">{target.areaName}</span></td>
                    <td><span className="cell-readonly">{target.detail}</span></td>
                    <td>
                      <div className="switch-onoff-buttons scene-onoff-buttons" role="group" aria-label={`${target.detail} setting`}>
                        {ON_OFF_LEVEL_VALUES.map((option) => (
                          <button
                            key={option}
                            type="button"
                            className={(option === "Uneffected" ? value === "" : value === option) ? "is-active" : ""}
                            onClick={() => onChange(target.id, option === "Uneffected" ? "" : option)}
                            disabled={disabled}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CurtainSettingPanel({
  targets,
  getValue,
  onChange,
  disabled,
}: {
  targets: SettingTarget[];
  getValue: (targetId: string) => string;
  onChange: (targetId: string, value: string) => void;
  disabled: boolean;
}): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false);
  if (targets.length === 0) return null;
  return (
    <div className="hvac-setting-panel curtain-setting-panel">
      <button
        type="button"
        className="switch-area-toggle hvac-setting-toggle"
        onClick={() => setCollapsed((prev) => !prev)}
        aria-expanded={!collapsed}
      >
        <span className="switch-area-caret">{collapsed ? ">" : "v"}</span>
        <span>Lutron Curtain</span>
        <span className="muted-pill">{targets.length}</span>
      </button>
      {collapsed ? null : (
        <div className="matrix-scroll">
          <table className="matrix-table master-table switch-setting-table curtain-setting-table">
            <thead>
              <tr>
                <th>No</th>
                <th>Area</th>
                <th>Detail</th>
                <th>Setting</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((target) => (
                <tr key={target.id}>
                  <td className="col-center">{target.circuitNumber}</td>
                  <td><span className="cell-readonly">{target.areaName}</span></td>
                  <td><span className="cell-readonly">{target.detail}</span></td>
                  <td>
                    <CurtainActionButtons
                      value={getValue(target.id)}
                      onChange={(value) => onChange(target.id, value)}
                      disabled={disabled}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
