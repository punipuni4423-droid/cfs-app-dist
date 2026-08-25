"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { backlightPaleColor } from "../lib/backlightColors";
import CfsLinkMapPanel from "./CfsLinkMapPanel";
import type {
  CircuitEntry,
  CfsRowDisplaySettings,
  CfsRowKind,
  DeviceMaster,
  InspectionMark,
  LocationMaster,
  ProgrammingNameSettings,
  ProgrammingNameToken,
  RevisionFieldChanges,
  RoomType,
  RoomScene,
  Scene,
  SwitchEntry,
} from "../types";
import { buildAreaAddressAssignmentMap, normalizeProgrammingToken } from "../lib/programming";
import { buildCfsLinkageGraph, sourceIdsForIssue, type CfsLinkIssue } from "../lib/cfsLinkageGraph";
import {
  areaSceneDisplayName,
  cellValues,
  isSceneNameLine,
  stripSceneNameLinePrefix,
  formatLevel,
  hasSetting,
  isPercentInspectionType,
  normalizeInspectionInput,
  normalizeLevelForCompare,
  roomSceneCellValue,
  roomSceneHasAreaSceneValue,
  roomSceneSelectedAreaSceneId,
  roomSceneSettingValue,
  roomSceneUsesAreaSceneValue,
  sceneMatchesArea,
  sceneRawValuesForCircuit,
  sceneRawValuesForTarget,
  sceneValueForCircuit,
  selectedSceneIdsForSwitch,
  setSettingsValue,
  switchUsesAreaSceneValue,
} from "../lib/cfsValueResolver";
import {
  BACKLIGHT_LOGIC_MERGE_KEYS,
  BASE_COLUMNS,
  CFS_FUNCTION_COLUMN_WIDTH,
  OTHER_AREA_ID,
  type BaseColumn,
  type BaseColumnKey,
  type CfsSortMode,
  type CfsZoneRow,
  type FunctionColumn,
  type FunctionColumnGroup,
  type MergeInfo,
} from "../lib/cfsTableModel";
import { cfsTargetsForRow, type CfsResolvedTarget } from "../lib/cfsTargets";
import { analyzeStaleHvacLinks, repairStaleHvacLinks } from "../lib/staleHvacLinkRepair";
import {
  buildCfsZoneRows,
  isPalladiomBacklightTarget,
  isReservedCfsRow,
  normalizeBacklightCondition,
  rowDimmingValues,
  rowNumberValues,
  rowZoneValues,
  switchGroupId,
  uniqueValues,
  useCfsZoneRows,
} from "../lib/useCfsZoneRows";
import { useAppSettings } from "../lib/appSettings";
import { createAppId } from '../lib/id';
import {
  PROGRAMMING_NAME_BRACKET_OPTIONS,
  PROGRAMMING_NAME_SEPARATOR_OPTIONS,
  PROGRAMMING_NAME_TOKEN_OPTIONS,
  formatProgrammingName,
  normalizeProgrammingNameSettings,
} from "../lib/programmingNameSettings";
import { isPmsScene, sortRoomScenesByGroup } from "../lib/roomScenes";
import { CFS_ROW_DISPLAY_OPTIONS, normalizeCfsRowDisplaySettings } from "../lib/cfsRowDisplay";
import { normalizeBacklightLevels } from "../lib/constants";
import CfsBaseColumnMenu from "./CfsBaseColumnMenu";
import CfsFilterMenu from "./CfsFilterMenu";

interface CfsViewProps {
  projectName: string;
  roomType: RoomType;
  circuits: CircuitEntry[];
  devices: DeviceMaster[];
  locations: LocationMaster[];
  onScenesChange?: (next: Scene[]) => void;
  onRoomScenesChange?: (next: RoomScene[]) => void;
  onSwitchesChange?: (next: SwitchEntry[]) => void;
  onInspectionMarksChange?: (next: InspectionMark[]) => void;
  programmingNameSettings?: ProgrammingNameSettings;
  onProgrammingNameSettingsChange?: (next: ProgrammingNameSettings) => void;
  onCfsRowDisplayChange?: (next: CfsRowDisplaySettings) => void;
  // Opens the read-only linked CFS sub-window (button hidden when absent).
  onOpenExternalWindow?: () => void;
  onOpenPinnedWindow?: () => void;
  canEdit?: boolean;
  hasRevisionDraft?: boolean;
  onBeforeInspectionStart?: (choice: InspectionRevisionChoice) => boolean;
  onInspectionModeStart?: (roomTypeId: string, payload: InspectionCompletionPayload) => void;
  onInspectionRoomTypeEnter?: (roomTypeId: string, payload: InspectionCompletionPayload) => void;
  onInspectionLiveChange?: (
    roomTypeId: string,
    payload: InspectionCompletionPayload,
    options: { hasDraft: boolean },
  ) => void;
  onCompleteInspection?: (payload: InspectionCompletionPayload, options: InspectionCompletionOptions) => boolean | void;
  inspectionRevisionTargets?: InspectionRevisionTarget[];
  onInspectionRevisionTargetChange?: (
    roomTypeId: string,
    patch: Partial<Pick<InspectionRevisionTarget, "selected" | "revision" | "note">>,
  ) => void;
  onInspectionHistoryChange?: (controls: InspectionHistoryControls) => void;
  revisionDiff?: {
    circuitIds: string[];
    assignmentIds: string[];
    switchIds: string[];
    dryContactIds?: string[];
    circuitFields?: RevisionFieldChanges;
    assignmentFields?: RevisionFieldChanges;
    curtainAssignmentFields?: RevisionFieldChanges;
    switchFields?: RevisionFieldChanges;
    dryContactFields?: RevisionFieldChanges;
    sceneFields?: RevisionFieldChanges;
    roomSceneFields?: RevisionFieldChanges;
    switchTargetFields?: RevisionFieldChanges;
    roomSceneTargetFields?: RevisionFieldChanges;
    cfsRowFields?: RevisionFieldChanges;
    cfsRowDisplayChanged?: boolean;
  } | null;
}

export interface InspectionCompletionPayload {
  scenes: Scene[];
  roomScenes: RoomScene[];
  switches: SwitchEntry[];
  inspectionMarks: InspectionMark[];
}

export type InspectionRevisionChoice = "newRevision" | "sameRevision";

export interface InspectionCompletionOptions {
  saveAsNewRevision: boolean;
}

export interface InspectionRevisionTarget {
  roomTypeId: string;
  name: string;
  currentRevision: string;
  revision: string;
  note: string;
  selected: boolean;
}

type InspectionEditScope = "areaScene" | "override";
type InspectionDraftSource = "areaScene" | "roomScene" | "switch";
type InspectionTarget = CfsResolvedTarget;

interface InspectionDraftRef extends InspectionTarget {
  key: string;
  scope: InspectionEditScope;
  sourceType: InspectionDraftSource;
  sourceId: string;
  label: string;
  previousValue: string;
}

interface InspectionDraft extends InspectionDraftRef {
  value: string;
}

interface InspectionHistorySnapshot {
  drafts: Record<string, InspectionDraft>;
  baselineValues: Record<string, string>;
}

interface InspectionHistoryControls {
  active: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

interface InspectionPopoverState {
  rowId: string;
  colId: string;
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

type InspectionDialogState = { kind: "start" | "finish" } | null;
type InspectionSelectionPhase = "off" | "selecting" | "copied";

interface InspectionCellCoord {
  rowId: string;
  colId: string;
}

interface InspectionClipboard {
  width: number;
  height: number;
  values: Array<Array<string | null>>;
}

interface CfsScrollEndSpace {
  inline: number;
  block: number;
}

const INSPECTION_ON_OFF_VALUES = ["On", "Off", "Blinking (Short)", "Blinking (Long)", "0.5 sec", "Uneffected"] as const;
const INSPECTION_CURTAIN_VALUES = ["Open", "Close", "Stop", "Uneffected"] as const;
const INSPECTION_HISTORY_LIMIT = 100;
const INSPECTION_PERCENT_PRESET_VALUES = [
  { label: "0%", value: "0" },
  { label: "100%", value: "100" },
] as const;
const INSPECTION_PERCENT_STEPS = [-10, -1, 1, 10] as const;
const INSPECTION_PERCENT_QUICK_VALUES = ["Raise", "Lower", "Uneffected"] as const;

const CFS_PREFS_KEY = "cfs-view-preferences-v1";
const SHOW_CFS_LINK_ISSUE_SURFACE = false;

function displaySwitchNumber(sw: SwitchEntry): string {
  return sw.switchNumber.trim() || "-";
}

function displaySwitchName(sw: SwitchEntry): string {
  return sw.switchName.trim() || "-";
}

function displayFunctionName(sw: SwitchEntry): string {
  const value = sw.buttonFunction.trim();
  if (value && value !== sw.buttonLabel && !/^Function\s+\d+$/i.test(value)) {
    return value;
  }
  if (sw.buttonLabel.trim()) return sw.buttonLabel.trim();
  return "Function";
}

function displayPirFunctionName(sw: SwitchEntry): string {
  const value = sw.buttonFunction.trim();
  if (!value || value === "PIR" || /^Function\s+\d+$/i.test(value)) return "";
  return value;
}

function commandPirReference(index: number): string {
  return `PIR ${index}`;
}

function formatButtonCondition(buttonLabel: string, condition: string): string {
  const button = buttonLabel.trim();
  const nextCondition = condition.trim();
  if (button && button !== "-") {
    return nextCondition ? `${button} / ${nextCondition}` : button;
  }
  return nextCondition;
}

function normalizeSceneHeaderText(value: string): string {
  const trimmed = value.trim();
  if (/^pms$/i.test(trimmed)) return "From PMS";
  if (/^check-?\s*in$/i.test(trimmed)) return "Check In";
  if (/^check-?\s*out$/i.test(trimmed)) return "Check Out";
  return trimmed;
}

function joinedSceneName(scene: RoomScene): string {
  const sceneType = normalizeSceneHeaderText(scene.sceneType);
  const detail = scene.detail.trim();
  if (sceneType.length === 1 && detail && /^[\p{L}\p{N}]/u.test(detail)) return `${sceneType}${detail}`;
  return [sceneType, detail].filter(Boolean).join(" ");
}

function roomSceneEnteredName(scene: RoomScene): string {
  const sceneType = scene.sceneType.trim();
  const detail = scene.detail.trim();
  if (sceneType.length === 1 && detail && /^[\p{L}\p{N}]/u.test(detail)) return `${sceneType}${detail}`;
  return [sceneType, detail].filter(Boolean).join(" ");
}

function roomSceneFunctionName(scene: RoomScene): string {
  return roomSceneEnteredName(scene) || "Scene";
}

function roomSceneConditionLabel(scene: RoomScene): string {
  return scene.triggerCondition.trim();
}

function roomSceneButtonLabel(scene: RoomScene): string {
  return isPmsScene(scene) ? "From PMS" : normalizeSceneHeaderText(scene.phase);
}

function roomScenePmsFunctionName(scene: RoomScene): string {
  return roomSceneFunctionName(scene);
}

function HeaderSplitText({ value }: { value: string }): ReactNode {
  const text = value.trim();
  const parts = text.split(/\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return <>{text || "-"}</>;
  return (
    <span className="cfs-header-stack">
      {parts.map((part, index) => (
        <span key={`${part}-${index}`}>{part}</span>
      ))}
    </span>
  );
}

function isPriorityTriggerColumn(col: FunctionColumn): boolean {
  return col.category === "switch" && col.source?.isPriorityFunction === true;
}

function PirHeaderText({
  labels,
  expanded,
  onToggle,
}: {
  labels: string[];
  expanded: boolean;
  onToggle: () => void;
}): ReactNode {
  if (labels.length === 0) return "-";
  if (labels.length === 1) {
    const parts = labels[0].split(/\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
    return (
      <span className="cfs-header-stack">
        {parts.map((part, index) => (
          <span key={`${part}-${index}`}>{part}</span>
        ))}
      </span>
    );
  }
  return (
    <span className="cfs-pir-header">
      <button type="button" className="cfs-pir-toggle" onClick={onToggle}>
        {expanded ? "-" : "+"}
      </button>
      <span className="cfs-pir-summary">{labels.length} PIRs</span>
      {expanded ? (
        <span className="cfs-header-stack cfs-pir-expanded-list">
          {labels.map((label, index) => (
            <span key={`${label}-${index}`}>{label.replace(/\s+\/\s+/, " ")}</span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function buildMergeInfo(rows: CfsZoneRow[], keyFor: (row: CfsZoneRow) => string): Map<string, MergeInfo> {
  const map = new Map<string, MergeInfo>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const key = keyFor(row);
    const prev = rows[index - 1];
    if (index > 0 && prev && keyFor(prev) === key) {
      map.set(row.id, { isFirst: false, rowSpan: 0 });
      continue;
    }
    let rowSpan = 1;
    for (let nextIndex = index + 1; nextIndex < rows.length; nextIndex += 1) {
      if (keyFor(rows[nextIndex]) !== key) break;
      rowSpan += 1;
    }
    map.set(row.id, { isFirst: true, rowSpan });
  }
  return map;
}

function buttonGroupKey(sw: SwitchEntry): string {
  if (sw.kind === "contact") {
    return [sw.cciAssignment, sw.allocation].filter(Boolean).join(" / ") || sw.allocation || "-";
  }
  return sw.buttonLabel.trim() || "-";
}

function normalizedSwitchHeaderKey(sw: SwitchEntry, switchNumber: string, switchName: string): string {
  return `${switchNumber.trim() || "-"}\u0000${switchName.trim() || "-"}`;
}

function normalizedColumnGroupKey(category: FunctionColumn["category"], label: string): string {
  return `${category}\u0000${label.trim() || "-"}`;
}

function parsePirAreaNumbers(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function parsePirInstanceValue(value: string): { areaId: string; index: number } | null {
  const [areaId, indexRaw] = value.split("::");
  const index = Number.parseInt(indexRaw ?? "", 10);
  if (!areaId || !Number.isFinite(index) || index < 1) return null;
  return { areaId, index };
}

function parsePirSelections(raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    }
  } catch {
    // Legacy single-selection values are stored as plain strings.
  }
  return [value];
}

function pirInstanceValueLabel(value: string, locations: LocationMaster[], counts: Record<string, string>): string {
  const trimmed = value.trim();
  const selected = parsePirInstanceValue(trimmed);
  if (!selected) return trimmed;
  let globalIndex = 1;
  for (const location of locations) {
    const count = Number.parseInt(counts[location.id] ?? "", 10);
    if (!Number.isFinite(count) || count < 1) continue;
    for (let index = 1; index <= count; index += 1) {
      if (location.id === selected.areaId && index === selected.index) return `PIR${globalIndex} / ${location.name}`;
      globalIndex += 1;
    }
  }
  return trimmed;
}

function pirInstanceLabels(sw: SwitchEntry, locations: LocationMaster[]): string[] {
  const counts = parsePirAreaNumbers(sw.allocation);
  return parsePirSelections(sw.buttonLabel)
    .map((value) => pirInstanceValueLabel(value, locations, counts))
    .filter(Boolean);
}

function pirInstanceLabel(sw: SwitchEntry, locations: LocationMaster[]): string {
  const counts = parsePirAreaNumbers(sw.allocation);
  const selectedLabels = pirInstanceLabels(sw, locations);
  if (selectedLabels.length > 0) return selectedLabels.join(" / ");
  return Object.keys(counts).length > 0 ? "PIR1" : "";
}

function pirAreaNumberSummary(sw: SwitchEntry, locations: LocationMaster[]): string {
  const selectedLabel = pirInstanceLabel(sw, locations);
  if (selectedLabel) return selectedLabel;
  return "-";
}

function pirHeaderLabels(sw: SwitchEntry, locations: LocationMaster[]): string[] {
  const labels = pirInstanceLabels(sw, locations);
  if (labels.length > 0) return labels;
  const fallback = pirAreaNumberSummary(sw, locations);
  return fallback && fallback !== "-" ? [fallback] : [];
}

function isOffLikeDisplayValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "Off" || trimmed === "0%" || trimmed === "0";
}

// Deterministic color per Area Scene NAME: the same scene name gets the same
// color in every area and room type (2026-08-24). Off-like names keep the
// shared blue from the off-value rule instead.
const SCENE_NAME_COLORS = [
  "#b45309", // amber-700
  "#0f766e", // teal-700
  "#7c3aed", // violet-600
  "#be185d", // pink-700
  "#166534", // green-800
  "#0369a1", // sky-700
  "#a16207", // yellow-700
  "#dc2626", // red-600
  "#4d7c0f", // lime-700
  "#6d28d9", // purple-700
];

function sceneNameColor(name: string): string {
  const normalized = name.trim().toLowerCase();
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
  }
  return SCENE_NAME_COLORS[hash % SCENE_NAME_COLORS.length];
}

function renderStack(
  values: string[],
  placeholder = "-",
  options?: { emphasizeSceneNameLines?: boolean; sceneNameColors?: Map<string, string> },
): ReactNode {
  const safeValues = values.length > 0 ? values : [placeholder];
  const title = safeValues.map((value) => stripSceneNameLinePrefix(value) || placeholder).join(" / ");
  return (
    <div className={safeValues.length > 1 ? "cfs-cell-stack" : undefined} title={title}>
      {safeValues.map((value, index) => {
        // Scene-name lines carry an explicit prefix from the value resolver;
        // never infer them from line position (see SCENE_NAME_LINE_PREFIX).
        const sceneName = options?.emphasizeSceneNameLines && isSceneNameLine(value);
        const text = stripSceneNameLinePrefix(value);
        const offLike = isOffLikeDisplayValue(text);
        const nameStyle =
          sceneName && !offLike && text.trim() !== ""
            ? { color: options?.sceneNameColors?.get(text.trim().toLowerCase()) ?? sceneNameColor(text) }
            : undefined;
        return (
          <div
            key={`${text}-${index}`}
            style={nameStyle}
            className={`cfs-cell-line${sceneName ? " cfs-scene-name-line" : ""}${
              offLike ? " cfs-off-value-line" : ""
            }`}
          >
            {text || placeholder}
          </div>
        );
      })}
    </div>
  );
}

function safeExcelFilePart(value: string, fallback: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_") || fallback;
}

function cloneInspectionData<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export default function CfsView({
  projectName,
  roomType,
  circuits,
  devices,
  locations,
  onScenesChange,
  onRoomScenesChange,
  onSwitchesChange,
  onInspectionMarksChange,
  programmingNameSettings,
  onProgrammingNameSettingsChange,
  onCfsRowDisplayChange,
  onOpenExternalWindow,
  onOpenPinnedWindow,
  canEdit = true,
  hasRevisionDraft = false,
  onBeforeInspectionStart,
  onInspectionModeStart,
  onInspectionRoomTypeEnter,
  onInspectionLiveChange,
  onCompleteInspection,
  inspectionRevisionTargets = [],
  onInspectionRevisionTargetChange,
  onInspectionHistoryChange,
  revisionDiff,
}: CfsViewProps) {
  const [sortMode, setSortMode] = useState<CfsSortMode>("device");
  const [selectedAreaIds, setSelectedAreaIds] = useState<Set<string>>(new Set());
  const [numberMode, setNumberMode] = useState<"designer" | "internal">("designer");
  const [hideReservedRows, setHideReservedRows] = useState(false);
  const [showIndividualOverrideHighlight, setShowIndividualOverrideHighlight] = useState(true);
  const [showAreaColorHighlight, setShowAreaColorHighlight] = useState(true);
  // Toggles the automatic pale per-value tint on Backlight Logic cells.
  const [showBacklightColorHighlight, setShowBacklightColorHighlight] = useState(true);
  const [showAreaSceneNames, setShowAreaSceneNames] = useState(true);
  const [showAreaSceneHighlight, setShowAreaSceneHighlight] = useState(true);
  const [showInspectionMarkHighlight, setShowInspectionMarkHighlight] = useState(true);
  const [showFfeHighlight, setShowFfeHighlight] = useState(true);
  const [showEnergySavingHighlight, setShowEnergySavingHighlight] = useState(true);
  const [showCciRows, setShowCciRows] = useState(false);
  const [hiddenDeviceKeys, setHiddenDeviceKeys] = useState<Set<string>>(new Set());
  const [hiddenBaseColumns, setHiddenBaseColumns] = useState<Set<BaseColumnKey>>(new Set());
  const [hiddenFunctionColumns, setHiddenFunctionColumns] = useState<Set<string>>(new Set());
  const [baseColumnOrder, setBaseColumnOrder] = useState<BaseColumnKey[]>([]);
  const [functionColumnGroupOrder, setFunctionColumnGroupOrder] = useState<string[]>([]);
  const [viewerCfsRowDisplayByRoom, setViewerCfsRowDisplayByRoom] = useState<Record<string, CfsRowDisplaySettings>>({});
  const [collapsedFunctionColumnGroupKeys, setCollapsedFunctionColumnGroupKeys] = useState<Set<string>>(new Set());
  const [expandedPirHeaderKeys, setExpandedPirHeaderKeys] = useState<Set<string>>(new Set());
  const [isMaximized, setIsMaximized] = useState(false);
  const [inspectionMode, setInspectionMode] = useState(false);
  const [inspectionEditScope, setInspectionEditScope] = useState<InspectionEditScope>("areaScene");
  const [inspectionDrafts, setInspectionDrafts] = useState<Record<string, InspectionDraft>>({});
  const [inspectionBaselineValues, setInspectionBaselineValues] = useState<Record<string, string>>({});
  const inspectionUndoStackRef = useRef<InspectionHistorySnapshot[]>([]);
  const inspectionRedoStackRef = useRef<InspectionHistorySnapshot[]>([]);
  const [inspectionHistoryVersion, setInspectionHistoryVersion] = useState(0);
  const [inspectionPopover, setInspectionPopover] = useState<InspectionPopoverState | null>(null);
  const [inspectionSessionBaseline, setInspectionSessionBaseline] = useState<InspectionCompletionPayload | null>(null);
  const [inspectionSessionSavedRevision, setInspectionSessionSavedRevision] = useState(false);
  const [inspectionDialog, setInspectionDialog] = useState<InspectionDialogState>(null);
  const [inspectionSelectionPhase, setInspectionSelectionPhase] = useState<InspectionSelectionPhase>("off");
  const [inspectionSelectionStart, setInspectionSelectionStart] = useState<InspectionCellCoord | null>(null);
  const [inspectionSelectionEnd, setInspectionSelectionEnd] = useState<InspectionCellCoord | null>(null);
  const [inspectionPasteTarget, setInspectionPasteTarget] = useState<InspectionCellCoord | null>(null);
  const [inspectionClipboard, setInspectionClipboard] = useState<InspectionClipboard | null>(null);
  const [cfsScrollEndSpace, setCfsScrollEndSpace] = useState<CfsScrollEndSpace>({ inline: 0, block: 352 });
  const [showLinkMap, setShowLinkMap] = useState(false);
  const [repairedLinkTargetIds, setRepairedLinkTargetIds] = useState<Set<string>>(new Set());
  const [lastHvacRepairSummary, setLastHvacRepairSummary] = useState<{ count: number; skipped: number } | null>(null);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const cfsMatrixScrollRef = useRef<HTMLDivElement | null>(null);
  const inspectionPopoverRef = useRef<HTMLDivElement | null>(null);
  const inspectionRoomTypeIdRef = useRef(roomType.id);
  const inspectionDraftsTouchedRef = useRef(false);
  const pointerDraggedFunctionColumnGroupKeyRef = useRef("");
  const mouseDraggedFunctionColumnGroupKeyRef = useRef("");
  const { settings: appSettings } = useAppSettings();
  const activeProgrammingNameSettings = useMemo(
    () => normalizeProgrammingNameSettings(programmingNameSettings),
    [programmingNameSettings],
  );
  const showLinkMapControls = appSettings.adminMode && appSettings.cfsLinkMapEnabled;
  const viewerCfsRowDisplayKey = useMemo(
    () => `${projectName}\u0000${roomType.id}`,
    [projectName, roomType.id],
  );
  const sharedCfsRowDisplay = useMemo(
    () => normalizeCfsRowDisplaySettings(roomType.cfsRowDisplay),
    [roomType.cfsRowDisplay],
  );
  const activeCfsRowDisplay = useMemo(
    () =>
      canEdit
        ? sharedCfsRowDisplay
        : normalizeCfsRowDisplaySettings(viewerCfsRowDisplayByRoom[viewerCfsRowDisplayKey] ?? sharedCfsRowDisplay),
    [canEdit, sharedCfsRowDisplay, viewerCfsRowDisplayByRoom, viewerCfsRowDisplayKey],
  );
  const canChangeCfsRows = canEdit ? Boolean(onCfsRowDisplayChange) : true;
  const orderedCfsRowKinds = activeCfsRowDisplay.order;
  const hiddenCfsRowKindSet = useMemo(
    () => new Set(activeCfsRowDisplay.hidden),
    [activeCfsRowDisplay.hidden],
  );

  const locationById = useMemo(() => new Map(locations.map((loc) => [loc.id, loc])), [locations]);
  const deviceByModel = useMemo(() => new Map(devices.map((device) => [device.model, device])), [devices]);
  const areaAddressByAssignmentCircuit = useMemo(
    () => buildAreaAddressAssignmentMap(roomType.deviceAssignments, circuits, locations),
    [circuits, locations, roomType.deviceAssignments],
  );
  const scenesById = useMemo(() => new Map(roomType.scenes.map((scene) => [scene.id, scene])), [roomType.scenes]);
  const backlightConditionNameByValue = useMemo(() => {
    const names = new Map<string, string>();
    for (const sw of roomType.switches) {
      if (sw.kind !== "lutronPd") continue;
      for (const level of normalizeBacklightLevels(sw.backlightLevels)) {
        names.set(level.key, level.name);
        names.set(level.name, level.name);
      }
    }
    for (const level of normalizeBacklightLevels(roomType.backlightLevels)) {
      names.set(level.key, level.name);
      names.set(level.name, level.name);
    }
    names.set("masterOn", names.get("masterOn") || "Bright");
    names.set("Master On", names.get("masterOn") || "Bright");
    return names;
  }, [roomType.backlightLevels, roomType.switches]);
  const displayBacklightCondition = useCallback(
    (value: string, source?: SwitchEntry): string => {
      const trimmed = value.trim();
      const normalized = normalizeBacklightCondition(value, source);
      if (!normalized) return "";
      return backlightConditionNameByValue.get(trimmed) ?? backlightConditionNameByValue.get(normalized) ?? normalized;
    },
    [backlightConditionNameByValue],
  );
  const linkGraph = useMemo(
    () => buildCfsLinkageGraph({ roomType, circuits, locations }),
    [circuits, locations, roomType],
  );
  const linkIssueTargetIds = useMemo(() => {
    const ids = new Set<string>();
    if (!SHOW_CFS_LINK_ISSUE_SURFACE) return ids;
    for (const issue of linkGraph.issues) {
      if (issue.severity !== "error" || !issue.targetId) continue;
      ids.add(issue.targetId);
    }
    return ids;
  }, [linkGraph]);
  const linkIssueSourceIds = useMemo(() => {
    const ids = new Set<string>();
    if (!SHOW_CFS_LINK_ISSUE_SURFACE) return ids;
    for (const issue of linkGraph.issues) {
      if (issue.severity !== "error") continue;
      sourceIdsForIssue(issue).forEach((id) => ids.add(id));
    }
    return ids;
  }, [linkGraph]);
  const linkIssueRows = useMemo(() => {
    if (!SHOW_CFS_LINK_ISSUE_SURFACE) return [];
    const nodeById = new Map(linkGraph.nodes.map((node) => [node.id, node]));
    const circuitById = new Map(circuits.map((circuit) => [circuit.id, circuit]));
    const assignmentById = new Map(roomType.deviceAssignments.map((assignment) => [assignment.id, assignment]));
    const sceneById = new Map(roomType.scenes.map((scene) => [scene.id, scene]));
    const roomSceneById = new Map(roomType.roomScenes.map((scene) => [scene.id, scene]));
    const switchById = new Map(roomType.switches.map((sw) => [sw.id, sw]));

    function shortId(value: string): string {
      return value.length > 12 ? `${value.slice(0, 8)}...` : value;
    }

    function readableTargetId(value: string): string {
      const hvac = value.match(/^hvac:([^:]+):(.+)$/);
      if (hvac) return `HVAC ${hvac[2]} / ID ${shortId(hvac[1])}`;
      const cco = value.match(/^cco:(.+)$/);
      if (cco) return `CCO target / ID ${shortId(cco[1])}`;
      const cci = value.match(/^cci:(.+)$/);
      if (cci) return `CCI target / ID ${shortId(cci[1])}`;
      const backlight = value.match(/^backlight:(.+)$/);
      if (backlight) return `Backlight target / ID ${shortId(backlight[1])}`;
      return shortId(value);
    }

    function targetLabel(targetId: string | undefined): string {
      if (!targetId) return "-";
      const node = nodeById.get(targetId) ?? nodeById.get(`target:${targetId}`) ?? nodeById.get(`cfs:${targetId}`);
      if (node?.label && node.label !== targetId) return `${node.label} (${readableTargetId(targetId)})`;
      return readableTargetId(targetId);
    }

    function sourceLabel(issue: CfsLinkIssue): string {
      const ids = sourceIdsForIssue(issue);
      if (ids.length === 0) return issue.group;
      const labels = ids.map((id) => {
        const circuit = circuitById.get(id);
        if (circuit) {
          return `Circuit ${circuit.designerNumber || "-"} / ${circuit.detail || circuit.fixture || shortId(id)}`;
        }
        const assignment = assignmentById.get(id);
        if (assignment) {
          return `Device Assign ${assignment.device || "-"} #${assignment.deviceNum || "-"} / ${assignment.zoneAddress || "-"}`;
        }
        const scene = sceneById.get(id);
        if (scene) return `Area Scene ${scene.name || shortId(id)}`;
        const roomScene = roomSceneById.get(id);
        if (roomScene) return `Scene ${roomScene.phase} / ${roomScene.sceneType || "-"} / ${roomScene.detail || "-"}`;
        const sw = switchById.get(id);
        if (sw) {
          const tab = sw.kind === "command" ? "Command" : sw.backlightTarget.trim() ? "Backlight" : "Switch";
          return `${tab} ${sw.switchNumber || "-"} / ${sw.switchName || sw.buttonFunction || sw.buttonLabel || shortId(id)}`;
        }
        return `${issue.group} ${shortId(id)}`;
      });
      return labels.join(" / ");
    }

    function issueTitle(issue: CfsLinkIssue): string {
      if (issue.code === "stale_hvac_target") return "古いHVAC参照が残っています";
      if (issue.code === "missing_target") return "参照先の設定対象が存在しません";
      if (issue.code === "missing_area_scene") return "Sceneが存在しないArea Sceneを参照しています";
      if (issue.code === "missing_switch_scene") return "Switch/Commandが存在しないSceneを参照しています";
      if (issue.code === "missing_backlight_target") return "Backlightの参照先が見つかりません";
      if (issue.code === "backlight_target_not_by_scene") return "Backlight対象がBy Scene/Baseになっていません";
      if (issue.code === "missing_backlight_condition") return "Backlightの条件が未設定です";
      if (issue.code === "missing_backlight_cfs_row") return "Backlight Logic行が生成されていません";
      if (issue.code === "duplicate_switch_column") return "CFS上のSwitch列が重複しています";
      if (issue.code === "dali_ambiguous") return "DALIの紐づけ判定が曖昧です";
      if (issue.code === "designer_missing") return "Designer#の参照先が見つかりません";
      return issue.title;
    }

    function actionHint(issue: CfsLinkIssue): string {
      if (issue.code === "stale_hvac_target") return "Link MapのWarningsでRepair可能か確認し、HVAC/Area Scene/Switchの参照を現行IDへ置き換えてください。";
      if (issue.code === "missing_area_scene" || issue.code === "missing_switch_scene") return "参照元のScene選択を開き、現在存在するArea Sceneを選び直してください。";
      if (issue.code === "missing_target") return "参照元タブでCircuit/HVAC/CCOなどの対象を選び直してください。Circuit自体が存在するだけのIndividual Overrideはエラー扱いしません。";
      if (issue.code === "missing_backlight_target") return "Backlightタブで対象のPalladiom Backlightグループを選び直してください。";
      if (issue.code === "backlight_target_not_by_scene") return "対象グループは存在しますが、BacklightタブでBy Scene/Base対象になっていません。CFS Backlight Logicに出す場合は対象側をBy SceneまたはBaseにしてください。";
      if (issue.code === "missing_backlight_condition") return "BacklightタブでActive/Inactive条件を設定してください。条件が空の場合、CFSのBacklight Logic行は出ません。";
      if (issue.code === "missing_backlight_cfs_row") return "Backlightの対象と条件は有効です。Link Mapで行生成条件を確認し、CFS出力との不整合を調査してください。";
      if (issue.code === "duplicate_switch_column") return "同じSwitch番号、名称、ボタン、条件の列が意図した重複か確認してください。不要ならSwitch側を整理してください。";
      if (issue.code === "dali_ambiguous") return "Device AssignのDetailまたはAddressが、DALI個別灯のどれか一つに絞れるか確認してください。";
      if (issue.code === "designer_missing") return "Device AssignのCircuit/InputとCircuitタブのDesigner#が一致しているか確認してください。";
      return "赤いタブとLink MapのWarningsを確認し、参照元の設定を現在存在する対象へ更新してください。";
    }

    return linkGraph.issues
      .filter((issue) => issue.severity !== "info")
      .sort((a, b) => {
        const severityRank = (issue: CfsLinkIssue) => (issue.severity === "error" ? 0 : 1);
        const rank = severityRank(a) - severityRank(b);
        if (rank !== 0) return rank;
        return `${a.group}:${a.title}:${a.id}`.localeCompare(`${b.group}:${b.title}:${b.id}`, "ja", { numeric: true });
      })
      .map((issue) => ({
        id: issue.id,
        severity: issue.severity,
        title: issueTitle(issue),
        originalTitle: issue.title,
        group: issue.group,
        source: sourceLabel(issue),
        target: targetLabel(issue.targetId),
        detail: issue.detail,
        action: actionHint(issue),
      }));
  }, [circuits, linkGraph, roomType]);
  const inspectionDraftList = useMemo(() => Object.values(inspectionDrafts), [inspectionDrafts]);
  const canInspectionUndo = inspectionMode && inspectionUndoStackRef.current.length > 0;
  const canInspectionRedo = inspectionMode && inspectionRedoStackRef.current.length > 0;
  const inspectionMarkList = useMemo(() => roomType.inspectionMarks ?? [], [roomType.inspectionMarks]);
  const inspectionMarksByKey = useMemo(
    () => new Map(inspectionMarkList.map((mark) => [inspectionDraftKey(mark.sourceType, mark.sourceId, mark.targetId), mark])),
    [inspectionMarkList],
  );
  const staleHvacRepairPlan = useMemo(() => analyzeStaleHvacLinks(roomType), [roomType]);
  const revisionDiffSets = useMemo(() => {
    if (!revisionDiff) return null;
    return {
      circuitIds: new Set(revisionDiff.circuitIds),
      assignmentIds: new Set(revisionDiff.assignmentIds),
      switchIds: new Set(revisionDiff.switchIds),
      dryContactIds: new Set(revisionDiff.dryContactIds ?? []),
      circuitFields: revisionDiff.circuitFields ?? {},
      assignmentFields: revisionDiff.assignmentFields ?? {},
      curtainAssignmentFields: revisionDiff.curtainAssignmentFields ?? {},
      switchFields: revisionDiff.switchFields ?? {},
      dryContactFields: revisionDiff.dryContactFields ?? {},
      sceneFields: revisionDiff.sceneFields ?? {},
      roomSceneFields: revisionDiff.roomSceneFields ?? {},
      switchTargetFields: revisionDiff.switchTargetFields ?? {},
      roomSceneTargetFields: revisionDiff.roomSceneTargetFields ?? {},
      cfsRowIds: new Set(Object.keys(revisionDiff.cfsRowFields ?? {})),
      cfsRowFields: revisionDiff.cfsRowFields ?? {},
    };
  }, [revisionDiff]);
  const palladiomBySceneTargets = useMemo(() => {
    const map = new Map<string, SwitchEntry>();
    for (const sw of roomType.switches) {
      if (sw.kind !== "lutronPd") continue;
      if (!isPalladiomBacklightTarget(sw)) continue;
      const key = switchGroupId(sw);
      if (!map.has(key)) map.set(key, sw);
    }
    return map;
  }, [roomType.switches]);

  useEffect(() => {
    setRepairedLinkTargetIds(new Set());
    setLastHvacRepairSummary(null);
  }, [roomType.id]);

  function handleRepairStaleHvacLinks(): void {
    const result = repairStaleHvacLinks(roomType);
    if (result.repairs.length === 0) {
      setLastHvacRepairSummary({ count: 0, skipped: result.skipped.length });
      return;
    }
    onScenesChange?.(result.scenes);
    onRoomScenesChange?.(result.roomScenes);
    onSwitchesChange?.(result.switches);
    setRepairedLinkTargetIds(new Set(result.repairedTargetIds));
    setLastHvacRepairSummary({ count: result.repairs.length, skipped: result.skipped.length });
  }

  const zoneRows = useCfsZoneRows({
    roomType,
    circuits,
    locations,
    locationById,
    areaAddressByAssignmentCircuit,
    palladiomBySceneTargets,
    selectedAreaIds,
    hiddenDeviceKeys,
    showCciRows,
    sortMode,
    rowKindOrder: orderedCfsRowKinds,
    hiddenRowKinds: hiddenCfsRowKindSet,
  });

  const allZoneRowsForFilters = useMemo(
    () =>
      buildCfsZoneRows({
        roomType,
        circuits,
        locations,
        locationById,
        areaAddressByAssignmentCircuit,
        palladiomBySceneTargets,
        selectedAreaIds: new Set<string>(),
        hiddenDeviceKeys: new Set<string>(),
        showCciRows,
        sortMode: "device",
        rowKindOrder: orderedCfsRowKinds,
        hiddenRowKinds: new Set<CfsRowKind>(),
      }),
    [areaAddressByAssignmentCircuit, circuits, locationById, locations, orderedCfsRowKinds, palladiomBySceneTargets, roomType, showCciRows],
  );

  const availableAreaFilters = useMemo(() => {
    const map = new Map<string, string>();
    const locationIds = new Set(locations.map((location) => location.id));
    for (const row of allZoneRowsForFilters) {
      if (row.isBacklight) continue;
      const rowLocationId = row.locationId || OTHER_AREA_ID;
      const filterId = locationIds.has(rowLocationId) ? rowLocationId : OTHER_AREA_ID;
      const locationName = filterId === OTHER_AREA_ID ? "Other" : row.location || "Other";
      map.set(filterId, locationName);
    }
    const ordered = locations
      .filter((location) => map.has(location.id))
      .map((location) => ({ id: location.id, name: map.get(location.id) ?? location.name }));
    const other = map.has(OTHER_AREA_ID) ? [{ id: OTHER_AREA_ID, name: map.get(OTHER_AREA_ID) ?? "Other" }] : [];
    return [...ordered, ...other];
  }, [allZoneRowsForFilters, locations]);

  const availableDeviceFilters = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of allZoneRowsForFilters) {
      const key = `${row.device}\u0000${row.deviceNum}`;
      const label = row.deviceNum ? `${row.device} #${row.deviceNum}` : row.device;
      map.set(key, label);
    }
    return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
  }, [allZoneRowsForFilters]);

  const pirGroupNumbers = useMemo(() => {
    const map = new Map<string, number>();
    let index = 1;
    for (const sw of roomType.switches) {
      if (sw.kind !== "pir") continue;
      const key = switchGroupId(sw);
      if (map.has(key)) continue;
      map.set(key, index);
      index += 1;
    }
    return map;
  }, [roomType.switches]);

  const switchByCommandReference = useMemo(() => {
    const map = new Map<string, SwitchEntry>();
    for (const sw of roomType.switches) {
      if (sw.kind === "command" || sw.kind === "qsm") continue;
      const groupId = switchGroupId(sw);
      if (!map.has(groupId)) map.set(groupId, sw);
      const number = sw.switchNumber.trim();
      if (number && !map.has(number)) map.set(number, sw);
      if (sw.kind === "pir") {
        const pirIndex = pirGroupNumbers.get(groupId);
        if (pirIndex) {
          const reference = commandPirReference(pirIndex);
          if (!map.has(reference)) map.set(reference, sw);
          const compactReference = reference.replace(/\s+/g, "");
          if (!map.has(compactReference)) map.set(compactReference, sw);
        }
      }
    }
    return map;
  }, [pirGroupNumbers, roomType.switches]);

  const switchRowsByNumber = useMemo(() => {
    const map = new Map<string, SwitchEntry[]>();
    for (const sw of roomType.switches) {
      if (sw.kind === "command" || sw.kind === "qsm") continue;
      const key = sw.switchNumber.trim();
      if (!key) continue;
      map.set(key, [...(map.get(key) ?? []), sw]);
    }
    return map;
  }, [roomType.switches]);

  // Palette order follows the room type's Area Scene registration order so
  // every distinct scene name gets a distinct color (same name = same color
  // across areas). Hash fallback only covers names not registered here.
  const sceneNameColors = useMemo(() => {
    const map = new Map<string, string>();
    let index = 0;
    for (const scene of roomType.scenes) {
      const key = scene.name.trim().toLowerCase();
      if (!key || isOffLikeDisplayValue(scene.name) || map.has(key)) continue;
      map.set(key, SCENE_NAME_COLORS[index % SCENE_NAME_COLORS.length]);
      index += 1;
    }
    return map;
  }, [roomType.scenes]);

  const functionColumns = useMemo<FunctionColumn[]>(() => {
    const sceneColumns: FunctionColumn[] = sortRoomScenesByGroup(roomType.roomScenes)
      .filter((scene) =>
        scene.sceneType.trim() ||
        scene.triggerCondition.trim() ||
        scene.settings.length > 0 ||
        (scene.areaSceneSelections ?? []).some((selection) => selection.sceneId.trim() !== ""),
      )
      .map((scene) => {
        const groupKey = normalizedColumnGroupKey("scene", "Scene");
        return {
          id: `scene:${scene.id}`,
          category: "scene",
          switchGroupKey: groupKey,
          buttonKey: `${groupKey}\u0000${scene.phase}`,
          switchNumber: "Scene",
          switchName: "",
          button: roomSceneButtonLabel(scene),
          functionName: isPmsScene(scene) ? roomScenePmsFunctionName(scene) : roomSceneFunctionName(scene),
          condition: roomSceneConditionLabel(scene),
          kind: "scene",
          roomScene: scene,
        };
      });

    const commandColumns: FunctionColumn[] = roomType.switches
      .filter((sw) => sw.kind === "command" && Boolean(sw.switchName.trim() || sw.buttonFunction.trim()))
      .map((sw) => {
        const groupKey = normalizedColumnGroupKey("command", "Command");
        const commandReference = sw.switchNumber.trim();
        const referencedRows = switchRowsByNumber.get(commandReference) ?? [];
        const referencedSwitch = referencedRows[0] ?? switchByCommandReference.get(commandReference);
        const switchNumber = referencedSwitch ? displaySwitchNumber(referencedSwitch) : sw.switchNumber.trim() || "-";
        const switchName = referencedSwitch ? displaySwitchName(referencedSwitch) : "-";
        const buttonLabel =
          referencedSwitch?.kind === "pir"
            ? parsePirSelections(sw.buttonLabel)
                .map((value) => pirInstanceValueLabel(value, locations, parsePirAreaNumbers(referencedSwitch.allocation)))
                .filter(Boolean)
                .join(" / ")
            : sw.buttonLabel.trim();
        return {
          id: sw.id,
          category: "command" as const,
          switchGroupKey: groupKey,
          buttonKey: `${groupKey}\u0000${switchNumber}\u0000${switchName}`,
          switchNumber: "Command",
          switchName: "",
          button: `${switchNumber} / ${switchName}`,
          functionName: sw.switchName.trim() || displayFunctionName(sw),
          condition: formatButtonCondition(buttonLabel, sw.condition),
          kind: "command",
          source: sw,
        };
      });

    const switchColumns: FunctionColumn[] = roomType.switches
      .filter((sw) => sw.kind !== "command" && sw.kind !== "qsm" && Boolean(sw.switchNumber.trim() || sw.switchName.trim()))
      .map((sw, sourceOrder) => {
        const pirLogicNo = pirGroupNumbers.get(switchGroupId(sw)) ?? 1;
        const resolvedNumber = sw.kind === "pir" ? "PIR" : displaySwitchNumber(sw);
        const resolvedName = sw.kind === "pir" ? "" : displaySwitchName(sw);
        const groupKey = normalizedSwitchHeaderKey(sw, resolvedNumber, resolvedName);
        const pirButton = String(pirLogicNo);
        const pirLabels = sw.kind === "pir" ? pirHeaderLabels(sw, locations) : undefined;
        return {
          id: sw.id,
          category: "switch" as const,
          sourceOrder,
          switchGroupKey: groupKey,
          buttonKey: `${groupKey}\u0000${sw.kind === "pir" ? pirButton : buttonGroupKey(sw)}`,
          switchNumber: resolvedNumber,
          switchName: resolvedName,
          button: sw.kind === "pir" ? pirButton : buttonGroupKey(sw),
          functionName: sw.kind === "pir" ? displayPirFunctionName(sw) : displayFunctionName(sw),
          condition: sw.condition.trim(),
          kind: sw.kind,
          source: sw,
          pirLabels,
        };
      })
      .sort((a, b) => {
        if (a.kind === "pir" && b.kind !== "pir") return 1;
        if (a.kind !== "pir" && b.kind === "pir") return -1;
        const switchCompare = `${a.switchNumber} ${a.switchName}`.localeCompare(
          `${b.switchNumber} ${b.switchName}`,
          "en",
          { numeric: true },
        );
        if (switchCompare !== 0) return switchCompare;
        const buttonCompare = a.button.localeCompare(b.button, "en", { numeric: true });
        if (buttonCompare !== 0) return buttonCompare;
        return (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0);
      });

    return [...sceneColumns, ...commandColumns, ...switchColumns];
  }, [locations, pirGroupNumbers, roomType.roomScenes, roomType.switches, switchByCommandReference, switchRowsByNumber]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CFS_PREFS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        sortMode?: CfsSortMode;
        sortByLocation?: boolean;
        numberMode?: "designer" | "internal";
        hideReservedRows?: boolean;
        showIndividualOverrideHighlight?: boolean;
        showAreaColorHighlight?: boolean;
        showAreaSceneNames?: boolean;
        showAreaSceneHighlight?: boolean;
        showFfeHighlight?: boolean;
        showEnergySavingHighlight?: boolean;
        showInspectionMarkHighlight?: boolean;
        showCciRows?: boolean;
        selectedAreaIds?: string[];
        hiddenDeviceKeys?: string[];
        hiddenBaseColumns?: BaseColumnKey[];
        hiddenFunctionColumns?: string[];
        baseColumnOrder?: BaseColumnKey[];
        functionColumnGroupOrder?: string[];
        viewerCfsRowDisplayByRoom?: Record<string, unknown>;
        showBacklightColorHighlight?: boolean;
      };
      if (parsed.numberMode === "designer" || parsed.numberMode === "internal") {
        setNumberMode(parsed.numberMode);
      }
      if (
        parsed.sortMode === "device" ||
        parsed.sortMode === "area" ||
        parsed.sortMode === "internal" ||
        parsed.sortMode === "programmingName"
      ) {
        setSortMode(parsed.sortMode);
      } else if (parsed.sortByLocation) {
        setSortMode("area");
      }
      setHideReservedRows(Boolean(parsed.hideReservedRows));
      setShowIndividualOverrideHighlight(parsed.showIndividualOverrideHighlight !== false);
      setShowAreaColorHighlight(parsed.showAreaColorHighlight !== false);
      setShowAreaSceneNames(parsed.showAreaSceneNames !== false);
      setShowAreaSceneHighlight(parsed.showAreaSceneHighlight !== false);
      setShowFfeHighlight(parsed.showFfeHighlight !== false);
      setShowEnergySavingHighlight(parsed.showEnergySavingHighlight !== false);
      setShowInspectionMarkHighlight(parsed.showInspectionMarkHighlight !== false);
      setShowCciRows(parsed.showCciRows === true);
      if (Array.isArray(parsed.selectedAreaIds)) setSelectedAreaIds(new Set(parsed.selectedAreaIds));
      if (Array.isArray(parsed.hiddenDeviceKeys)) setHiddenDeviceKeys(new Set(parsed.hiddenDeviceKeys));
      if (Array.isArray(parsed.hiddenBaseColumns)) setHiddenBaseColumns(new Set(parsed.hiddenBaseColumns));
      if (Array.isArray(parsed.hiddenFunctionColumns)) setHiddenFunctionColumns(new Set(parsed.hiddenFunctionColumns));
      if (Array.isArray(parsed.baseColumnOrder)) setBaseColumnOrder(parsed.baseColumnOrder);
      if (Array.isArray(parsed.functionColumnGroupOrder)) setFunctionColumnGroupOrder(parsed.functionColumnGroupOrder);
      setShowBacklightColorHighlight(parsed.showBacklightColorHighlight !== false);
      if (
        parsed.viewerCfsRowDisplayByRoom &&
        typeof parsed.viewerCfsRowDisplayByRoom === "object" &&
        !Array.isArray(parsed.viewerCfsRowDisplayByRoom)
      ) {
        const next: Record<string, CfsRowDisplaySettings> = {};
        for (const [key, value] of Object.entries(parsed.viewerCfsRowDisplayByRoom)) {
          next[key] = normalizeCfsRowDisplaySettings(value);
        }
        setViewerCfsRowDisplayByRoom(next);
      }
    } catch {
      // Ignore invalid saved UI preferences.
    } finally {
      setPrefsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      window.localStorage.setItem(
        CFS_PREFS_KEY,
        JSON.stringify({
          sortMode,
          numberMode,
          hideReservedRows,
          showIndividualOverrideHighlight,
          showAreaColorHighlight,
          showAreaSceneNames,
          showAreaSceneHighlight,
          showFfeHighlight,
          showEnergySavingHighlight,
          showInspectionMarkHighlight,
          showCciRows,
          selectedAreaIds: Array.from(selectedAreaIds),
          hiddenDeviceKeys: Array.from(hiddenDeviceKeys),
          hiddenBaseColumns: Array.from(hiddenBaseColumns),
          hiddenFunctionColumns: Array.from(hiddenFunctionColumns),
          baseColumnOrder,
          functionColumnGroupOrder,
          viewerCfsRowDisplayByRoom,
          showBacklightColorHighlight,
        }),
      );
    } catch {
      // Non-critical UI preference save.
    }
  }, [
    showBacklightColorHighlight,
    baseColumnOrder,
    functionColumnGroupOrder,
    hiddenDeviceKeys,
    hideReservedRows,
    hiddenBaseColumns,
    hiddenFunctionColumns,
    numberMode,
    prefsLoaded,
    selectedAreaIds,
    sortMode,
    showAreaColorHighlight,
    showAreaSceneNames,
    showAreaSceneHighlight,
    showEnergySavingHighlight,
    showFfeHighlight,
    showCciRows,
    showIndividualOverrideHighlight,
    showInspectionMarkHighlight,
    viewerCfsRowDisplayByRoom,
  ]);

  useEffect(() => {
    if (showLinkMapControls) return;
    setShowLinkMap(false);
  }, [showLinkMapControls]);

  useEffect(() => {
    if (!isMaximized) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMaximized]);

  useEffect(() => {
    setInspectionDrafts({});
    setInspectionBaselineValues({});
    clearInspectionHistory();
    setInspectionPopover(null);
    setInspectionSessionBaseline(null);
    setInspectionSessionSavedRevision(false);
    setInspectionDialog(null);
    setInspectionSelectionPhase("off");
    setInspectionSelectionStart(null);
    setInspectionSelectionEnd(null);
    setInspectionPasteTarget(null);
    setInspectionClipboard(null);
  }, [roomType.id]);

  useEffect(() => {
    if (inspectionMode) return;
    setInspectionPopover(null);
    setInspectionDialog(null);
    clearInspectionHistory();
    setInspectionSelectionPhase("off");
    setInspectionSelectionStart(null);
    setInspectionSelectionEnd(null);
    setInspectionPasteTarget(null);
    setInspectionClipboard(null);
  }, [inspectionMode]);

  useEffect(() => {
    setInspectionPopover(null);
  }, [inspectionEditScope]);

  useEffect(() => {
    if (!inspectionMode) return;
    setInspectionSelectionPhase("off");
    setInspectionSelectionStart(null);
    setInspectionSelectionEnd(null);
    setInspectionPasteTarget(null);
    setInspectionClipboard(null);
  }, [hiddenCfsRowKindSet, hiddenDeviceKeys, hiddenFunctionColumns, hideReservedRows, inspectionMode, selectedAreaIds, showCciRows]);

  useEffect(() => {
    if (!inspectionPopover) return;
    function closeOnOutsideClick(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (inspectionPopoverRef.current?.contains(target)) return;
      setInspectionPopover(null);
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") setInspectionPopover(null);
    }
    const openedAt = Date.now();
    function closeOnScroll(event: Event): void {
      // Layout settling right after the popover opens (selected-cell class,
      // sticky offsets) can emit scroll events on the matrix container;
      // closing on those made the popover appear to never open. Only user
      // scrolling after the settle window should dismiss it, and scrolls
      // inside the popover itself (its own body) never should.
      if (Date.now() - openedAt < 400) return;
      const target = event.target;
      if (target instanceof Node && inspectionPopoverRef.current?.contains(target)) return;
      setInspectionPopover(null);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", closeOnScroll);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", closeOnScroll);
    };
  }, [inspectionPopover]);

  const orderedBaseColumns = useMemo(() => {
    const byKey = new Map(BASE_COLUMNS.map((col) => [col.key, col]));
    const ordered = baseColumnOrder
      .map((key) => byKey.get(key))
      .filter((col): col is BaseColumn => Boolean(col));
    const orderedKeys = new Set(ordered.map((col) => col.key));
    return [...ordered, ...BASE_COLUMNS.filter((col) => !orderedKeys.has(col.key))];
  }, [baseColumnOrder]);
  const visibleBaseColumns = orderedBaseColumns.filter((col) => !hiddenBaseColumns.has(col.key));
  const visibleBaseColumnWidth = visibleBaseColumns.reduce((sum, col) => sum + col.minWidth, 0);
  const functionColumnGroups = useMemo<FunctionColumnGroup[]>(() => {
    const groups: FunctionColumnGroup[] = [];
    for (const col of functionColumns) {
      const current = groups.find((group) => group.key === col.switchGroupKey);
      if (current) {
        current.columns.push(col);
        continue;
      }
      groups.push({
        key: col.switchGroupKey,
        label: [col.switchNumber, col.switchName].filter(Boolean).join(" ") || col.switchNumber || col.switchName || "-",
        kind: col.kind,
        columns: [col],
      });
    }
    return groups;
  }, [functionColumns]);
  const orderedFunctionColumnGroups = useMemo(() => {
    const byKey = new Map(functionColumnGroups.map((group) => [group.key, group]));
    const ordered = functionColumnGroupOrder
      .map((key) => byKey.get(key))
      .filter((group): group is FunctionColumnGroup => Boolean(group));
    const orderedKeys = new Set(ordered.map((group) => group.key));
    return [...ordered, ...functionColumnGroups.filter((group) => !orderedKeys.has(group.key))];
  }, [functionColumnGroupOrder, functionColumnGroups]);
  const orderedFunctionColumns = useMemo(
    () => orderedFunctionColumnGroups.flatMap((group) => group.columns),
    [orderedFunctionColumnGroups],
  );
  const visibleFunctionColumns = orderedFunctionColumns.filter((col) => !hiddenFunctionColumns.has(col.id));
  const hiddenFunctionColumnList = orderedFunctionColumns.filter((col) => hiddenFunctionColumns.has(col.id));
  const displaySortedRows =
    sortMode === "programmingName"
      ? zoneRows
          .map((row, index) => ({
            row,
            index,
            label: rowProgrammingNameValues(row).find((value) => value.trim()) ?? "",
          }))
          .sort((a, b) => {
            const aMissing = !a.label;
            const bMissing = !b.label;
            if (aMissing !== bMissing) return aMissing ? 1 : -1;
            const labelCompare = a.label.localeCompare(b.label, "en", { numeric: true });
            if (labelCompare !== 0) return labelCompare;
            return a.index - b.index;
          })
          .map((item) => item.row)
      : zoneRows;
  const displayedRows = hideReservedRows
    ? displaySortedRows.filter((row) => !isReservedCfsRow(row))
    : displaySortedRows;
  const inspectionSelectionRect = useMemo(() => {
    if (!inspectionSelectionStart || !inspectionSelectionEnd) return null;
    const startRowIndex = displayedRows.findIndex((row) => row.id === inspectionSelectionStart.rowId);
    const endRowIndex = displayedRows.findIndex((row) => row.id === inspectionSelectionEnd.rowId);
    const startColIndex = visibleFunctionColumns.findIndex((col) => col.id === inspectionSelectionStart.colId);
    const endColIndex = visibleFunctionColumns.findIndex((col) => col.id === inspectionSelectionEnd.colId);
    if (startRowIndex < 0 || endRowIndex < 0 || startColIndex < 0 || endColIndex < 0) return null;
    return {
      top: Math.min(startRowIndex, endRowIndex),
      bottom: Math.max(startRowIndex, endRowIndex),
      left: Math.min(startColIndex, endColIndex),
      right: Math.max(startColIndex, endColIndex),
    };
  }, [displayedRows, inspectionSelectionEnd, inspectionSelectionStart, visibleFunctionColumns]);
  const selectedInspectionCellCount = inspectionSelectionRect
    ? (inspectionSelectionRect.bottom - inspectionSelectionRect.top + 1) *
      (inspectionSelectionRect.right - inspectionSelectionRect.left + 1)
    : 0;

  function isInspectionCellSelected(rowId: string, colId: string): boolean {
    if (!inspectionSelectionRect) return false;
    const rowIndex = displayedRows.findIndex((row) => row.id === rowId);
    const colIndex = visibleFunctionColumns.findIndex((col) => col.id === colId);
    return (
      rowIndex >= inspectionSelectionRect.top &&
      rowIndex <= inspectionSelectionRect.bottom &&
      colIndex >= inspectionSelectionRect.left &&
      colIndex <= inspectionSelectionRect.right
    );
  }

  const resetInspectionSelection = useCallback((options: { keepClipboard?: boolean } = {}): void => {
    setInspectionSelectionPhase("off");
    setInspectionSelectionStart(null);
    setInspectionSelectionEnd(null);
    setInspectionPasteTarget(null);
    if (!options.keepClipboard) setInspectionClipboard(null);
  }, []);

  function clearInspectionHistory(): void {
    inspectionUndoStackRef.current = [];
    inspectionRedoStackRef.current = [];
    setInspectionHistoryVersion((value) => value + 1);
  }

  function currentInspectionHistorySnapshot(): InspectionHistorySnapshot {
    return {
      drafts: cloneInspectionData(inspectionDrafts),
      baselineValues: cloneInspectionData(inspectionBaselineValues),
    };
  }

  function inspectionHistorySnapshotsEqual(
    before: InspectionHistorySnapshot | undefined,
    after: InspectionHistorySnapshot,
  ): boolean {
    if (!before) return false;
    return JSON.stringify(before) === JSON.stringify(after);
  }

  function pushInspectionHistorySnapshot(): void {
    if (!inspectionMode) return;
    const snapshot = currentInspectionHistorySnapshot();
    if (inspectionHistorySnapshotsEqual(inspectionUndoStackRef.current.at(-1), snapshot)) return;
    inspectionUndoStackRef.current = [
      ...inspectionUndoStackRef.current.slice(-(INSPECTION_HISTORY_LIMIT - 1)),
      snapshot,
    ];
    inspectionRedoStackRef.current = [];
    setInspectionHistoryVersion((value) => value + 1);
  }

  function restoreInspectionHistorySnapshot(snapshot: InspectionHistorySnapshot): void {
    inspectionDraftsTouchedRef.current = true;
    setInspectionDrafts(cloneInspectionData(snapshot.drafts));
    setInspectionBaselineValues(cloneInspectionData(snapshot.baselineValues));
    setInspectionPopover(null);
    resetInspectionSelection({ keepClipboard: true });
  }

  function undoInspectionHistory(): void {
    const previous = inspectionUndoStackRef.current.at(-1);
    if (!inspectionMode || !previous) return;
    inspectionUndoStackRef.current = inspectionUndoStackRef.current.slice(0, -1);
    inspectionRedoStackRef.current = [
      ...inspectionRedoStackRef.current.slice(-(INSPECTION_HISTORY_LIMIT - 1)),
      currentInspectionHistorySnapshot(),
    ];
    setInspectionHistoryVersion((value) => value + 1);
    restoreInspectionHistorySnapshot(previous);
  }

  function redoInspectionHistory(): void {
    const next = inspectionRedoStackRef.current.at(-1);
    if (!inspectionMode || !next) return;
    inspectionRedoStackRef.current = inspectionRedoStackRef.current.slice(0, -1);
    inspectionUndoStackRef.current = [
      ...inspectionUndoStackRef.current.slice(-(INSPECTION_HISTORY_LIMIT - 1)),
      currentInspectionHistorySnapshot(),
    ];
    setInspectionHistoryVersion((value) => value + 1);
    restoreInspectionHistorySnapshot(next);
  }

  useEffect(() => {
    onInspectionHistoryChange?.({
      active: inspectionMode,
      canUndo: canInspectionUndo,
      canRedo: canInspectionRedo,
      undo: undoInspectionHistory,
      redo: redoInspectionHistory,
    });
  // History handlers intentionally close over the same render state tracked by these status dependencies.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    canInspectionRedo,
    canInspectionUndo,
    inspectionBaselineValues,
    inspectionDrafts,
    inspectionHistoryVersion,
    inspectionMode,
    onInspectionHistoryChange,
  ]);

  useEffect(() => {
    return () => {
      onInspectionHistoryChange?.({
        active: false,
        canUndo: false,
        canRedo: false,
        undo: () => undefined,
        redo: () => undefined,
      });
    };
  }, [onInspectionHistoryChange]);

  function selectionCopyEnabled(): boolean {
    if (!inspectionSelectionRect) return false;
    for (let rowIndex = inspectionSelectionRect.top; rowIndex <= inspectionSelectionRect.bottom; rowIndex += 1) {
      const row = displayedRows[rowIndex];
      for (let colIndex = inspectionSelectionRect.left; colIndex <= inspectionSelectionRect.right; colIndex += 1) {
        const col = visibleFunctionColumns[colIndex];
        if (row && col && inspectionCellModel(row, col).editable) return true;
      }
    }
    return false;
  }

  function selectInspectionCell(row: CfsZoneRow, col: FunctionColumn): void {
    const coord = { rowId: row.id, colId: col.id };
    if (inspectionSelectionPhase === "copied") {
      setInspectionPasteTarget(coord);
      setInspectionSelectionStart(coord);
      setInspectionSelectionEnd(coord);
      setInspectionPopover(null);
      return;
    }
    if (!inspectionSelectionStart || inspectionSelectionPhase === "off") {
      setInspectionSelectionPhase("selecting");
      setInspectionSelectionStart(coord);
      setInspectionSelectionEnd(coord);
      setInspectionPasteTarget(null);
      setInspectionPopover(null);
      return;
    }
    setInspectionSelectionEnd(coord);
    setInspectionPasteTarget(null);
    setInspectionPopover(null);
  }

  function copyInspectionSelection(): void {
    if (!inspectionSelectionRect) return;
    const values: Array<Array<string | null>> = [];
    for (let rowIndex = inspectionSelectionRect.top; rowIndex <= inspectionSelectionRect.bottom; rowIndex += 1) {
      const row = displayedRows[rowIndex];
      const line: Array<string | null> = [];
      for (let colIndex = inspectionSelectionRect.left; colIndex <= inspectionSelectionRect.right; colIndex += 1) {
        const col = visibleFunctionColumns[colIndex];
        if (!row || !col) {
          line.push(null);
          continue;
        }
        const model = inspectionCellModel(row, col);
        line.push(model.editable && model.placeholder !== "Mixed" ? model.value : null);
      }
      values.push(line);
    }
    setInspectionClipboard({
      width: inspectionSelectionRect.right - inspectionSelectionRect.left + 1,
      height: inspectionSelectionRect.bottom - inspectionSelectionRect.top + 1,
      values,
    });
    setInspectionSelectionPhase("copied");
    setInspectionPasteTarget(null);
    setInspectionPopover(null);
  }

  function pasteInspectionSelection(): void {
    if (!inspectionClipboard || !inspectionPasteTarget) return;
    const startRowIndex = displayedRows.findIndex((row) => row.id === inspectionPasteTarget.rowId);
    const startColIndex = visibleFunctionColumns.findIndex((col) => col.id === inspectionPasteTarget.colId);
    if (startRowIndex < 0 || startColIndex < 0) return;
    for (let rowOffset = 0; rowOffset < inspectionClipboard.values.length; rowOffset += 1) {
      const row = displayedRows[startRowIndex + rowOffset];
      if (!row) continue;
      const line = inspectionClipboard.values[rowOffset] ?? [];
      for (let colOffset = 0; colOffset < line.length; colOffset += 1) {
        const col = visibleFunctionColumns[startColIndex + colOffset];
        if (!col) continue;
        const value = line[colOffset];
        if (value === null || value === undefined) continue;
        changeInspectionCell(row, col, value);
      }
    }
  }

  const stickyOffsets = useMemo(() => {
    let left = 0;
    return new Map(
      visibleBaseColumns.map((col) => {
        const offset = left;
        left += col.minWidth;
        return [col.key, offset] as const;
      }),
    );
  }, [visibleBaseColumns]);
  const switchHeaderGroups = useMemo(() => {
    const groups: Array<{ key: string; colSpan: number; switchNumber: string; switchName: string; kind: FunctionColumn["kind"] }> = [];
    for (const col of visibleFunctionColumns) {
      const current = groups.at(-1);
      if (current && current.key === col.switchGroupKey) {
        current.colSpan += 1;
      } else {
        groups.push({
          key: col.switchGroupKey,
          colSpan: 1,
          switchNumber: col.switchNumber,
          switchName: col.switchName,
          kind: col.kind,
        });
      }
    }
    return groups;
  }, [visibleFunctionColumns]);
  // First column of each switch block: used to draw a strong vertical rule so
  // adjacent switches (and their colored header blocks) are clearly separated.
  const switchGroupStartColIds = useMemo(() => {
    const ids = new Set<string>();
    let previousSwitchKey: string | null = null;
    for (const col of visibleFunctionColumns) {
      if (col.switchGroupKey !== previousSwitchKey) ids.add(col.id);
      previousSwitchKey = col.switchGroupKey;
    }
    return ids;
  }, [visibleFunctionColumns]);

  // Header rows 2-4 merge ADJACENT cells with the same displayed text inside
  // the same switch block, so shared labels render once and only the level
  // where values diverge splits into separate cells (e.g. two From PMS scenes
  // share one "From PMS" cell and one scene-name cell, branching only at the
  // trigger-condition row). Merging is display-based on purpose: distinct
  // scenes/switches with identical labels read as one shared branch.
  const buttonHeaderGroups = useMemo(() => {
    const groups: Array<{
      key: string;
      colSpan: number;
      button: string;
      kind: FunctionColumn["kind"];
      pirLabels?: string[];
      startsSwitchGroup: boolean;
      cols: FunctionColumn[];
    }> = [];
    let previousSwitchKey: string | null = null;
    for (const col of visibleFunctionColumns) {
      const startsSwitchGroup = col.switchGroupKey !== previousSwitchKey;
      previousSwitchKey = col.switchGroupKey;
      const key = `${col.switchGroupKey}\u0000${col.button.trim() || "-"}`;
      const current = groups.at(-1);
      if (current && current.key === key) {
        current.colSpan += 1;
        current.cols.push(col);
      } else {
        groups.push({
          key,
          colSpan: 1,
          button: col.button,
          kind: col.kind,
          pirLabels: col.pirLabels,
          startsSwitchGroup,
          cols: [col],
        });
      }
    }
    return groups;
  }, [visibleFunctionColumns]);
  const functionNameHeaderGroups = useMemo(() => {
    const groups: Array<{
      key: string;
      colSpan: number;
      functionName: string;
      kind: FunctionColumn["kind"];
      pirLabels?: string[];
      startsSwitchGroup?: boolean;
      cols: FunctionColumn[];
    }> = [];
    let previousSwitchKey: string | null = null;
    for (const col of visibleFunctionColumns) {
      const startsSwitchGroup = col.switchGroupKey !== previousSwitchKey;
      previousSwitchKey = col.switchGroupKey;
      const key = `${col.switchGroupKey}\u0000${col.button.trim() || "-"}\u0000${col.functionName.trim() || "-"}\u0000${(col.pirLabels ?? []).join("|")}`;
      const current = groups.at(-1);
      if (current && current.key === key) {
        current.colSpan += 1;
        current.cols.push(col);
      } else {
        groups.push({
          key,
          colSpan: 1,
          startsSwitchGroup,
          functionName: col.functionName,
          kind: col.kind,
          pirLabels: col.pirLabels,
          cols: [col],
        });
      }
    }
    return groups;
  }, [visibleFunctionColumns]);
  const conditionHeaderGroups = useMemo(() => {
    const groups: Array<{ key: string; colSpan: number; condition: string; startsSwitchGroup: boolean; cols: FunctionColumn[] }> = [];
    let previousSwitchKey: string | null = null;
    for (const col of visibleFunctionColumns) {
      const startsSwitchGroup = col.switchGroupKey !== previousSwitchKey;
      previousSwitchKey = col.switchGroupKey;
      const key = `${col.switchGroupKey}\u0000${col.button.trim() || "-"}\u0000${col.functionName.trim() || "-"}\u0000${(col.pirLabels ?? []).join("|")}\u0000${col.condition.trim() || "-"}`;
      const current = groups.at(-1);
      if (current && current.key === key) {
        current.colSpan += 1;
        current.cols.push(col);
      } else {
        groups.push({
          key,
          colSpan: 1,
          condition: col.condition,
          startsSwitchGroup,
          cols: [col],
        });
      }
    }
    return groups;
  }, [visibleFunctionColumns]);
  const deviceMergeInfo = useMemo(
    () => buildMergeInfo(displayedRows, (row) => `${row.device}\u0000${row.deviceNum}`),
    [displayedRows],
  );
  const dimmingMergeInfo = useMemo(
    () => buildMergeInfo(displayedRows, (row) => `${row.device}\u0000${row.deviceNum}\u0000${rowDimmingValues(row).join("|")}`),
    [displayedRows],
  );
  const designerMergeInfo = useMemo(
    () => buildMergeInfo(displayedRows, (row) => `${row.device}\u0000${row.deviceNum}\u0000${rowNumberValues(row, numberMode).join("|")}`),
    [displayedRows, numberMode],
  );
  const zoneMergeInfo = useMemo(
    () => buildMergeInfo(displayedRows, (row) => `${row.device}\u0000${row.deviceNum}\u0000${row.group}\u0000${rowZoneValues(row).join("|")}`),
    [displayedRows],
  );
  const daliGroupMergeInfo = useMemo(() => {
    const map = new Map<string, { isFirst: boolean; rowSpan: number }>();
    for (let index = 0; index < displayedRows.length; index += 1) {
      const row = displayedRows[index];
      if (!row.isDali) {
        map.set(row.id, { isFirst: true, rowSpan: 1 });
        continue;
      }
      const key = `${row.device}\u0000${row.deviceNum}\u0000${row.group || ""}`;
      const prev = displayedRows[index - 1];
      const prevKey = prev?.isDali ? `${prev.device}\u0000${prev.deviceNum}\u0000${prev.group || ""}` : "";
      if (index > 0 && prevKey === key) {
        map.set(row.id, { isFirst: false, rowSpan: 0 });
        continue;
      }
      let rowSpan = 1;
      for (let nextIndex = index + 1; nextIndex < displayedRows.length; nextIndex += 1) {
        const next = displayedRows[nextIndex];
        const nextKey = next.isDali ? `${next.device}\u0000${next.deviceNum}\u0000${next.group || ""}` : "";
        if (nextKey !== key) break;
        rowSpan += 1;
      }
      map.set(row.id, { isFirst: true, rowSpan });
    }
    return map;
  }, [displayedRows]);
  const backlightMergeInfo = useMemo(() => {
    const map = new Map<string, { isFirst: boolean; rowSpan: number }>();
    for (let index = 0; index < displayedRows.length; index += 1) {
      const row = displayedRows[index];
      if (!row.isBacklight) {
        map.set(row.id, { isFirst: true, rowSpan: 1 });
        continue;
      }
      const prev = displayedRows[index - 1];
      if (index > 0 && prev?.isBacklight) {
        map.set(row.id, { isFirst: false, rowSpan: 0 });
        continue;
      }
      let rowSpan = 1;
      for (let nextIndex = index + 1; nextIndex < displayedRows.length; nextIndex += 1) {
        if (!displayedRows[nextIndex].isBacklight) break;
        rowSpan += 1;
      }
      map.set(row.id, { isFirst: true, rowSpan });
    }
    return map;
  }, [displayedRows]);

  useLayoutEffect(() => {
    function recomputeScrollEndSpace(): void {
      const scroller = cfsMatrixScrollRef.current;
      const table = tableRef.current;
      if (!scroller || !table) return;
      // Single-scroll layout: fit the container to the rest of the viewport
      // so the page itself does not need to scroll (maximized mode keeps its
      // flex-driven size).
      if (!isMaximized) {
        const rect = scroller.getBoundingClientRect();
        // Chrome below the container (card padding, shell padding) also has
        // to fit into the viewport for the page to stop scrolling. Measure it
        // from the shell's content bottom - documentElement.scrollHeight is
        // floored at the viewport height and would ratchet the fit down.
        const shellBottom = scroller.closest("main")?.getBoundingClientRect().bottom ?? rect.bottom;
        const belowGap = Math.max(0, shellBottom - rect.bottom);
        const fit = Math.max(384, Math.floor(window.innerHeight - rect.top - belowGap));
        const current = Number.parseFloat(scroller.style.blockSize || "0");
        if (Math.abs(current - fit) >= 2) {
          scroller.style.blockSize = `${fit}px`;
          // The container is a flex item (flex: 1 1 auto): without a max the
          // flex-grow stretches it past the inline height.
          scroller.style.maxBlockSize = `${fit}px`;
        }
      } else if (scroller.style.blockSize) {
        scroller.style.blockSize = "";
        scroller.style.maxBlockSize = "";
      }
      const headerHeight = table.tHead?.getBoundingClientRect().height ?? 0;
      const bodyRows = Array.from(table.tBodies[0]?.rows ?? []).filter((row) => !row.classList.contains("cfs-scroll-end-row"));
      const lastBodyRow = bodyRows.at(-1);
      const rowHeight = lastBodyRow?.getBoundingClientRect().height ?? bodyRows[0]?.getBoundingClientRect().height ?? 0;
      const trailingColumnWidth = visibleFunctionColumns.length > 0 ? CFS_FUNCTION_COLUMN_WIDTH : 0;
      const inline = visibleFunctionColumns.length > 0
        ? Math.max(0, Math.ceil(scroller.clientWidth - visibleBaseColumnWidth - trailingColumnWidth))
        : 0;
      const block = rowHeight > 0 ? Math.max(0, Math.ceil(scroller.clientHeight - headerHeight - rowHeight)) : 0;
      setCfsScrollEndSpace((prev) => {
        if (Math.abs(prev.inline - inline) < 1 && Math.abs(prev.block - block) < 1) return prev;
        return { inline, block };
      });
    }

    recomputeScrollEndSpace();
    const frame = requestAnimationFrame(recomputeScrollEndSpace);
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(recomputeScrollEndSpace) : null;
    if (resizeObserver) {
      if (cfsMatrixScrollRef.current) resizeObserver.observe(cfsMatrixScrollRef.current);
      if (tableRef.current) resizeObserver.observe(tableRef.current);
      if (tableRef.current?.tHead) resizeObserver.observe(tableRef.current.tHead);
      // Content above the matrix (toolbar rows wrapping, banners) moves the
      // container's top edge; body size tracks those layout shifts.
      resizeObserver.observe(document.body);
    }
    window.addEventListener("resize", recomputeScrollEndSpace);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", recomputeScrollEndSpace);
    };
  }, [
    displayedRows.length,
    expandedPirHeaderKeys,
    isMaximized,
    visibleBaseColumnWidth,
    visibleFunctionColumns.length,
  ]);

  function toggleBaseColumn(key: BaseColumnKey): void {
    setHiddenBaseColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function commitCfsRowDisplay(next: CfsRowDisplaySettings): void {
    const normalized = normalizeCfsRowDisplaySettings(next);
    if (canEdit) {
      if (onCfsRowDisplayChange) onCfsRowDisplayChange(normalized);
      return;
    }
    setViewerCfsRowDisplayByRoom((prev) => ({
      ...prev,
      [viewerCfsRowDisplayKey]: normalized,
    }));
  }

  function toggleCfsRowKind(kind: CfsRowKind): void {
    const hidden = new Set(activeCfsRowDisplay.hidden);
    if (hidden.has(kind)) hidden.delete(kind);
    else hidden.add(kind);
    commitCfsRowDisplay({ ...activeCfsRowDisplay, hidden: Array.from(hidden) });
  }

  function setAllCfsRowKindsVisible(visible: boolean): void {
    commitCfsRowDisplay({
      ...activeCfsRowDisplay,
      hidden: visible ? [] : CFS_ROW_DISPLAY_OPTIONS.map((option) => option.id),
    });
  }

  function moveCfsRowKind(draggedKind: string, targetKind: CfsRowKind): void {
    if (draggedKind === targetKind) return;
    const order = [...orderedCfsRowKinds];
    const from = order.indexOf(draggedKind as CfsRowKind);
    const to = order.indexOf(targetKind);
    if (from < 0 || to < 0) return;
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    commitCfsRowDisplay({ ...activeCfsRowDisplay, order });
  }

  function moveCfsRowKindByOffset(kind: CfsRowKind, offset: number): void {
    const order = [...orderedCfsRowKinds];
    const from = order.indexOf(kind);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= order.length) return;
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    commitCfsRowDisplay({ ...activeCfsRowDisplay, order });
  }

  function toggleFunctionColumn(id: string): void {
    setHiddenFunctionColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function functionColumnDetailLabel(col: FunctionColumn): string {
    return [col.button, col.functionName, col.condition]
      .map((part) => part.trim())
      .filter((part) => part && part !== "-")
      .join(" / ") || "-";
  }

  function toggleFunctionColumnGroup(group: FunctionColumnGroup): void {
    setHiddenFunctionColumns((prev) => {
      const next = new Set(prev);
      const allVisible = group.columns.every((col) => !next.has(col.id));
      for (const col of group.columns) {
        if (allVisible) next.add(col.id);
        else next.delete(col.id);
      }
      return next;
    });
  }

  function toggleFunctionColumnGroupCollapsed(key: string): void {
    setCollapsedFunctionColumnGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function collapseAllFunctionColumnGroups(): void {
    setCollapsedFunctionColumnGroupKeys(new Set(orderedFunctionColumnGroups.map((group) => group.key)));
  }

  function moveBaseColumn(draggedKey: string, targetKey: BaseColumnKey): void {
    if (draggedKey === targetKey) return;
    setBaseColumnOrder(() => {
      const keys = orderedBaseColumns.map((col) => col.key);
      const from = keys.indexOf(draggedKey as BaseColumnKey);
      const to = keys.indexOf(targetKey);
      if (from < 0 || to < 0) return keys;
      const [moved] = keys.splice(from, 1);
      keys.splice(to, 0, moved);
      return keys;
    });
  }

  function moveBaseColumnByOffset(key: BaseColumnKey, offset: number): void {
    setBaseColumnOrder(() => {
      const keys = orderedBaseColumns.map((col) => col.key);
      const from = keys.indexOf(key);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= keys.length) return keys;
      const [moved] = keys.splice(from, 1);
      keys.splice(to, 0, moved);
      return keys;
    });
  }

  const moveFunctionColumnGroup = useCallback((draggedKey: string, targetKey: string): void => {
    if (draggedKey === targetKey) return;
    setFunctionColumnGroupOrder(() => {
      const keys = orderedFunctionColumnGroups.map((group) => group.key);
      const from = keys.indexOf(draggedKey);
      const to = keys.indexOf(targetKey);
      if (from < 0 || to < 0) return keys;
      const [moved] = keys.splice(from, 1);
      keys.splice(to, 0, moved);
      return keys;
    });
  }, [orderedFunctionColumnGroups]);

  const moveFunctionColumnGroupByOffset = useCallback((key: string, offset: number): void => {
    setFunctionColumnGroupOrder(() => {
      const keys = orderedFunctionColumnGroups.map((group) => group.key);
      const from = keys.indexOf(key);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= keys.length) return keys;
      const [moved] = keys.splice(from, 1);
      keys.splice(to, 0, moved);
      return keys;
    });
  }, [orderedFunctionColumnGroups]);

  function handleFunctionColumnGroupPointerDown(event: ReactPointerEvent, key: string): void {
    if (event.button !== 0) return;
    pointerDraggedFunctionColumnGroupKeyRef.current = key;
  }

  function handleFunctionColumnGroupMouseDown(event: ReactMouseEvent, key: string): void {
    if (event.button !== 0) return;
    mouseDraggedFunctionColumnGroupKeyRef.current = key;
  }

  function handleFunctionColumnGroupMouseMove(event: ReactMouseEvent, key: string): void {
    if (event.buttons !== 1) return;
    mouseDraggedFunctionColumnGroupKeyRef.current ||= key;
  }

  function handleFunctionColumnGroupMouseEnter(targetKey: string): void {
    const draggedKey = mouseDraggedFunctionColumnGroupKeyRef.current || pointerDraggedFunctionColumnGroupKeyRef.current;
    if (!draggedKey || draggedKey === targetKey) return;
    moveFunctionColumnGroup(draggedKey, targetKey);
    mouseDraggedFunctionColumnGroupKeyRef.current = targetKey;
    pointerDraggedFunctionColumnGroupKeyRef.current = targetKey;
  }

  useEffect(() => {
    function handlePointerUp(event: PointerEvent): void {
      const draggedKey = pointerDraggedFunctionColumnGroupKeyRef.current;
      if (!draggedKey) return;
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-function-group-key]");
      const targetKey = target?.dataset.functionGroupKey ?? "";
      if (targetKey) moveFunctionColumnGroup(draggedKey, targetKey);
      pointerDraggedFunctionColumnGroupKeyRef.current = "";
    }
    document.addEventListener("pointerup", handlePointerUp);
    return () => document.removeEventListener("pointerup", handlePointerUp);
  }, [moveFunctionColumnGroup]);

  useEffect(() => {
    function handleMouseDown(event: MouseEvent): void {
      if (event.button !== 0) return;
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-function-group-key]")
        : null;
      const header = event.target instanceof Element
        ? event.target.closest(".cfs-function-group-header")
        : null;
      const key = target?.dataset.functionGroupKey ?? "";
      if (key && header) mouseDraggedFunctionColumnGroupKeyRef.current = key;
    }
    function handleMouseMove(event: MouseEvent): void {
      const draggedKey = mouseDraggedFunctionColumnGroupKeyRef.current;
      if (!draggedKey || event.buttons !== 1) return;
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-function-group-key]");
      const targetKey = target?.dataset.functionGroupKey ?? "";
      if (!targetKey || targetKey === draggedKey) return;
      moveFunctionColumnGroup(draggedKey, targetKey);
      mouseDraggedFunctionColumnGroupKeyRef.current = targetKey;
    }
    function handleMouseUp(event: MouseEvent): void {
      const draggedKey = mouseDraggedFunctionColumnGroupKeyRef.current;
      if (!draggedKey) return;
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-function-group-key]");
      const targetKey = target?.dataset.functionGroupKey ?? "";
      if (targetKey) moveFunctionColumnGroup(draggedKey, targetKey);
      mouseDraggedFunctionColumnGroupKeyRef.current = "";
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [moveFunctionColumnGroup]);

  async function exportVisibleCfsToExcel(): Promise<void> {
    const ExcelJSModule = await import("exceljs");
    const ExcelJS = ExcelJSModule.default ?? ExcelJSModule;
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("CFS View");

    type ExcelFill = { type: "pattern"; pattern: "solid"; fgColor: { argb: string } };
    type ExcelCellModel = {
      row: number;
      col: number;
      value: string | number;
      rowSpan?: number;
      colSpan?: number;
      fill?: ExcelFill;
      bold?: boolean;
      fontColor?: string;
      horizontal?: "left" | "center";
    };

    const headerFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFEEF3F5" } };
    // Border edges: thin matches the faint on-screen cell border; heavy matches
    // the strong .cfs-switch-group-start rule (2px slate) used between switches.
    const thinEdge = { style: "thin" as const, color: { argb: "FFD7E0E5" } };
    const heavyEdge = { style: "medium" as const, color: { argb: "FF334155" } };

    function stackedText(values: string[], placeholder = "-"): string {
      const safeValues = values.length > 0 ? values : [placeholder];
      return safeValues.map((value) => stripSceneNameLinePrefix(value) || placeholder).join("\n");
    }

    function splitHeaderText(value: string): string {
      const parts = value.trim().split(/\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
      return (parts.length > 0 ? parts : ["-"]).join("\n");
    }

    function pirButtonHeaderExportText(group: { button: string; kind: FunctionColumn["kind"]; pirLabels?: string[]; key: string }): string {
      if (group.kind !== "pir" || !group.pirLabels) return splitHeaderText(group.button || "-");
      const labels = group.pirLabels;
      if (labels.length === 0) return "-";
      if (labels.length === 1) return splitHeaderText(labels[0]);
      return expandedPirHeaderKeys.has(group.key)
        ? labels.map((label) => label.replace(/\s+\/\s+/, " ")).join("\n")
        : `${labels.length} PIRs`;
    }

    function rowFill(row: CfsZoneRow, isNoColumn = false): ExcelFill | undefined {
      const ffe = showFfeHighlight && row.circuits.some((item) => item.circuit.ffe);
      const energy = showEnergySavingHighlight && row.circuits.some((item) => item.circuit.energySaving);
      if (ffe && energy) {
        return { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
      }
      if (ffe) {
        return { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0F2FE" } };
      }
      if (energy) {
        return { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCFCE7" } };
      }
      if (isReservedCfsRow(row) && !isNoColumn) {
        return { type: "pattern", pattern: "solid", fgColor: { argb: "FFC4C9CF" } };
      }
      return undefined;
    }

    function functionHeaderFill(kind: FunctionColumn["kind"]): ExcelFill {
      if (kind === "contact") {
        return { type: "pattern", pattern: "solid", fgColor: { argb: "FFBFE9E9" } };
      }
      if (kind === "lutronPd") {
        return { type: "pattern", pattern: "solid", fgColor: { argb: "FFC9D9FF" } };
      }
      if (kind === "lutronPico") {
        return { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFDCA3" } };
      }
      if (kind === "pir") {
        return { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC8DD" } };
      }
      if (kind === "scene") {
        return { type: "pattern", pattern: "solid", fgColor: { argb: "FFD7F5C8" } };
      }
      if (kind === "command") {
        return { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCC8F5" } };
      }
      return headerFill;
    }

    function changedBaseCell(row: CfsZoneRow, key: BaseColumnKey): boolean {
      return hasChangedBaseCell(row, key);
    }

    function bodyBaseCell(row: CfsZoneRow, rowIndex: number, col: BaseColumn, colIndex: number): ExcelCellModel | null {
      const excelRow = 5 + rowIndex;
      const excelCol = colIndex + 1;
      const isChanged = changedBaseCell(row, col.key);
      const changedFill = isChanged ? { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF3B0" } } : undefined;

      if (col.key === "number") {
        return {
          row: excelRow,
          col: excelCol,
          value: rowIndex + 1,
          fill: rowFill(row, true),
          horizontal: "center",
        };
      }

      if (row.isBacklight && BACKLIGHT_LOGIC_MERGE_KEYS.includes(col.key)) {
        const mergeInfo = backlightMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
        if (!mergeInfo.isFirst) return null;
        const visibleBacklightKeys = BACKLIGHT_LOGIC_MERGE_KEYS.filter((key) =>
          visibleBaseColumns.some((visibleCol) => visibleCol.key === key),
        );
        if (col.key !== visibleBacklightKeys[0]) return null;
        return {
          row: excelRow,
          col: excelCol,
          value: "Backlight Logic",
          colSpan: visibleBacklightKeys.length,
          rowSpan: mergeInfo.rowSpan,
          fill: changedFill ?? rowFill(row),
          bold: true,
          horizontal: "center",
        };
      }

      if (col.key === "device" || col.key === "deviceNum") {
        const info = deviceMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
        if (!info.isFirst) return null;
        return {
          row: excelRow,
          col: excelCol,
          value: stackedText(baseValues(row, col.key)),
          rowSpan: info.rowSpan,
          fill: changedFill ?? rowFill(row),
          bold: true,
          horizontal: "center",
        };
      }
      if (col.key === "dimmingType") {
        const info = dimmingMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
        if (!info.isFirst) return null;
        return {
          row: excelRow,
          col: excelCol,
          value: stackedText(baseValues(row, col.key)),
          rowSpan: info.rowSpan,
          fill: changedFill ?? rowFill(row),
          bold: true,
          horizontal: "center",
        };
      }
      if (col.key === "designerNumber") {
        const info = designerMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
        if (!info.isFirst) return null;
        return {
          row: excelRow,
          col: excelCol,
          value: stackedText(baseValues(row, col.key)),
          rowSpan: info.rowSpan,
          fill: changedFill ?? rowFill(row),
          bold: true,
          horizontal: "center",
        };
      }
      if (col.key === "group" && !row.isDali && visibleBaseColumns[colIndex + 1]?.key === "zone") {
        const info = zoneMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
        if (!info.isFirst) return null;
        const groupZoneChangedFill =
          isChanged || hasChangedBaseCell(row, "zone")
            ? { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF3B0" } }
            : undefined;
        return {
          row: excelRow,
          col: excelCol,
          value: stackedText(baseValues(row, "zone")),
          colSpan: 2,
          rowSpan: info.rowSpan,
          fill: groupZoneChangedFill ?? rowFill(row),
          horizontal: "center",
        };
      }
      if (col.key === "zone" && !row.isDali && visibleBaseColumns[colIndex - 1]?.key === "group") {
        return null;
      }
      if (col.key === "group" && row.isDali) {
        const info = daliGroupMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
        if (!info.isFirst) return null;
        return {
          row: excelRow,
          col: excelCol,
          value: stackedText(baseValues(row, col.key)),
          rowSpan: info.rowSpan,
          fill: changedFill ?? rowFill(row),
          horizontal: "center",
        };
      }
      if (col.key === "zone") {
        const info = zoneMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
        if (!info.isFirst) return null;
        return {
          row: excelRow,
          col: excelCol,
          value: stackedText(baseValues(row, col.key)),
          rowSpan: info.rowSpan,
          fill: changedFill ?? rowFill(row),
          horizontal: "center",
        };
      }
      return {
        row: excelRow,
        col: excelCol,
        value: stackedText(baseValues(row, col.key)),
        fill: changedFill ?? rowFill(row),
        horizontal: "center",
      };
    }

    function bodyFunctionCell(row: CfsZoneRow, rowIndex: number, col: FunctionColumn, colIndex: number): ExcelCellModel {
      const values = functionValues(row, col);
      const isAreaSceneValue = showAreaSceneHighlight && hasAreaSceneValueCell(row, col);
      const isChanged = hasChangedFunctionCell(row, col);
      const isIndividualOverride = showIndividualOverrideHighlight && hasSceneDifferentOverride(row, col);
      const isInspectionMarked = showInspectionMarkHighlight && hasInspectionMarkForCell(row, col);
      const fill =
        isInspectionMarked
          ? { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFEEF6FF" } }
          : isIndividualOverride
          ? { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFEF08A" } }
          : isChanged
            ? { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF3B0" } }
            : isAreaSceneValue
              ? { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF3E8FF" } }
              : rowFill(row);
      return {
        row: 5 + rowIndex,
        col: visibleBaseColumns.length + colIndex + 1,
        value: stackedText(values, row.isBacklight ? "" : "-"),
        fill,
        horizontal: "center",
      };
    }

    const cells: ExcelCellModel[] = [];
    visibleBaseColumns.forEach((col, index) => {
      cells.push({
        row: 1,
        col: index + 1,
        value: baseColumnLabel(col),
        rowSpan: 4,
        fill: headerFill,
        bold: true,
        horizontal: "center",
      });
    });
    let headerCol = visibleBaseColumns.length + 1;
    for (const group of switchHeaderGroups) {
      cells.push({
        row: 1,
        col: headerCol,
        value: [group.switchNumber, group.switchName].filter(Boolean).join("\n") || "-",
        colSpan: group.colSpan,
        fill: functionHeaderFill(group.kind),
        bold: true,
        horizontal: "center",
      });
      headerCol += group.colSpan;
    }
    headerCol = visibleBaseColumns.length + 1;
    for (const group of buttonHeaderGroups) {
      cells.push({
        row: 2,
        col: headerCol,
        value: pirButtonHeaderExportText(group),
        colSpan: group.colSpan,
        fill: headerFill,
        bold: true,
        horizontal: "center",
      });
      headerCol += group.colSpan;
    }
    headerCol = visibleBaseColumns.length + 1;
    for (const group of functionNameHeaderGroups) {
      cells.push({
        row: 3,
        col: headerCol,
        value: splitHeaderText(group.functionName || "-"),
        colSpan: group.colSpan,
        fill: headerFill,
        bold: true,
        horizontal: "center",
      });
      headerCol += group.colSpan;
    }
    headerCol = visibleBaseColumns.length + 1;
    for (const group of conditionHeaderGroups) {
      cells.push({
        row: 4,
        col: headerCol,
        value: splitHeaderText(group.condition || "-"),
        colSpan: group.colSpan,
        fill: group.cols.some(isPriorityTriggerColumn)
          ? { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE08A" } }
          : headerFill,
        bold: true,
        horizontal: "center",
      });
      headerCol += group.colSpan;
    }

    if (displayedRows.length === 0) {
      cells.push({
        row: 5,
        col: 1,
        value: "Enter Circuit and Device Assign data to generate the CFS matrix.",
        colSpan: visibleBaseColumns.length + visibleFunctionColumns.length,
        fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } },
        horizontal: "center",
      });
    } else {
      displayedRows.forEach((row, rowIndex) => {
        visibleBaseColumns.forEach((col, colIndex) => {
          const cell = bodyBaseCell(row, rowIndex, col, colIndex);
          if (cell) cells.push(cell);
        });
        visibleFunctionColumns.forEach((col, colIndex) => {
          cells.push(bodyFunctionCell(row, rowIndex, col, colIndex));
        });
      });
    }

    const maxColWidths = new Map<number, number>();
    visibleBaseColumns.forEach((col, index) => {
      maxColWidths.set(index + 1, Math.min(34, Math.max(7, col.minWidth / 7)));
    });
    visibleFunctionColumns.forEach((_col, index) => {
      const column = visibleBaseColumns.length + index + 1;
      maxColWidths.set(column, Math.min(34, Math.max(7, CFS_FUNCTION_COLUMN_WIDTH / 7)));
    });

    // Heavy edges: switch-to-switch boundaries, the header row band (rows 1-4),
    // the base-column band, and the outer table frame. ExcelJS shares one style
    // per merged range, so borders are computed per cell REGION (row/colSpan),
    // never by overwriting individual grid positions inside a merge.
    const baseColumnCount = visibleBaseColumns.length;
    const totalColumnCount = baseColumnCount + visibleFunctionColumns.length;
    const lastBorderRow = 4 + Math.max(1, displayedRows.length);
    const switchGroupStartCols = new Set<number>();
    {
      let groupStartCol = baseColumnCount + 1;
      for (const group of switchHeaderGroups) {
        switchGroupStartCols.add(groupStartCol);
        groupStartCol += group.colSpan;
      }
    }

    for (const cell of cells) {
      const excelCell = worksheet.getCell(cell.row, cell.col);
      excelCell.value = cell.value;
      const regionEndRow = cell.row + (cell.rowSpan ?? 1) - 1;
      const regionEndCol = cell.col + (cell.colSpan ?? 1) - 1;
      excelCell.border = {
        top: cell.row === 1 ? heavyEdge : thinEdge,
        bottom: regionEndRow === lastBorderRow || regionEndRow === 4 ? heavyEdge : thinEdge,
        left:
          cell.col === 1 || cell.col === baseColumnCount + 1 || switchGroupStartCols.has(cell.col)
            ? heavyEdge
            : thinEdge,
        right:
          regionEndCol === totalColumnCount ||
          regionEndCol === baseColumnCount ||
          switchGroupStartCols.has(regionEndCol + 1)
            ? heavyEdge
            : thinEdge,
      };
      excelCell.alignment = {
        horizontal: cell.horizontal ?? "center",
        vertical: "middle",
        wrapText: true,
      };
      excelCell.font = {
        bold: Boolean(cell.bold),
        color: { argb: cell.fontColor ?? "FF334155" },
      };
      if (cell.fill) excelCell.fill = cell.fill;
      const rowSpan = cell.rowSpan ?? 1;
      const colSpan = cell.colSpan ?? 1;
      if (rowSpan > 1 || colSpan > 1) {
        worksheet.mergeCells(cell.row, cell.col, cell.row + rowSpan - 1, cell.col + colSpan - 1);
      }
      const text = String(cell.value ?? "");
      const textWidth = Math.min(36, Math.max(6, Math.max(...text.split("\n").map((line) => line.length)) * 0.85 + 2));
      for (let col = cell.col; col < cell.col + colSpan; col += 1) {
        maxColWidths.set(col, Math.max(maxColWidths.get(col) ?? 0, textWidth));
      }
    }

    for (let rowIndex = 1; rowIndex <= 4; rowIndex += 1) {
      const rowCells = cells.filter((cell) => cell.row === rowIndex);
      const maxLines = rowCells.reduce((max, cell) => Math.max(max, String(cell.value ?? "").split("\n").length), 1);
      worksheet.getRow(rowIndex).height = Math.max(22, Math.min(82, maxLines * 18));
    }
    const bodyRowCount = Math.max(1, displayedRows.length);
    for (let rowIndex = 5; rowIndex < 5 + bodyRowCount; rowIndex += 1) {
      worksheet.getRow(rowIndex).height = 31;
    }

    maxColWidths.forEach((width, index) => {
      worksheet.getColumn(index).width = Math.min(34, Math.max(7, width));
    });

    worksheet.views = [{ state: "frozen", xSplit: visibleBaseColumns.length, ySplit: 4 }];
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeExcelFilePart(projectName, "Project")}_${safeExcelFilePart(roomType.name, "Room")}_CFS_view.xlsx`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function rowAreaAddressValues(row: CfsZoneRow): string[] {
    return row.circuits.map((item) => item.areaAddress || "-");
  }

  function programmingAreaToken(item: CfsZoneRow["circuits"][number]): string {
    const location = locationById.get(item.locationId);
    return normalizeProgrammingToken(location?.code || item.location || "");
  }

  function isOtherProgrammingLocation(item: CfsZoneRow["circuits"][number]): boolean {
    return item.locationId === OTHER_AREA_ID || item.location.trim().toLowerCase() === "other";
  }

  function programmingLocationNumberToken(item: CfsZoneRow["circuits"][number]): string {
    const locationNumber = locationById.get(item.locationId)?.number.trim() ?? "";
    return isOtherProgrammingLocation(item) ? locationNumber || "99" : locationNumber;
  }

  function programmingAreaTokenForName(item: CfsZoneRow["circuits"][number], locationNumber: string): string {
    if (!isOtherProgrammingLocation(item)) return programmingAreaToken(item);
    return activeProgrammingNameSettings.tokens.includes("locationNumber") ? "" : locationNumber || "99";
  }

  function programmingAddressToken(item: CfsZoneRow["circuits"][number]): string {
    const rawAddress = normalizeProgrammingToken(item.areaAddress);
    if (!rawAddress) return "";
    const area = programmingAreaToken(item);
    if (area && rawAddress.toUpperCase().startsWith(area.toUpperCase())) {
      return rawAddress.slice(area.length);
    }
    return rawAddress;
  }

  function normalizeZoneNumber(value: string): string {
    return normalizeProgrammingToken(value).replace(/^ZN/, "");
  }

  function normalizeControlAddressToken(value: string): string {
    const zone = normalizeZoneNumber(value);
    const cco = zone.match(/^CCO(\d*)$/);
    if (cco) return `O${cco[1] ?? ""}`;
    const cci = zone.match(/^CCI(\d*)$/);
    if (cci) return `I${cci[1] ?? ""}`;
    return zone;
  }

  function deviceProgrammingToken(row: CfsZoneRow): string {
    const device = deviceByModel.get(row.device);
    const code = normalizeProgrammingToken(device?.programmingCode || device?.abbrev || row.device);
    const deviceNum = normalizeProgrammingToken(row.deviceNum === "-" ? "" : row.deviceNum);
    const prefix = `${code}${deviceNum}`;
    if (row.isDali) {
      const line = normalizeProgrammingToken(row.daliLine);
      const group = normalizeProgrammingToken(row.group === "-" ? "" : row.group);
      const address = normalizeZoneNumber(row.zone === "-" ? "" : row.zone);
      const route = (/2D/i.test(code) ? [line, group, address] : [group, address])
        .filter(Boolean)
        .join("-");
      return route ? `${prefix}-${route}` : prefix;
    }
    const zone = normalizeControlAddressToken(row.zone === "-" ? "" : row.zone);
    return zone ? `${prefix}-${zone}` : prefix;
  }

  function rowProgrammingNameValues(row: CfsZoneRow): string[] {
    if (row.isBacklight || row.isHvac || row.isCurtain || row.circuits.length === 0) return [];
    const deviceToken = deviceProgrammingToken(row);
    return row.circuits.map((item) => {
      const locationNumber = programmingLocationNumberToken(item);
      const designerNumber = item.designerNumber.trim();
      const detail = item.detail.trim();
      return formatProgrammingName(
        {
          locationNumber,
          designerNumber,
          area: programmingAreaTokenForName(item, locationNumber),
          address: programmingAddressToken(item),
          device: deviceToken,
        },
        detail,
        activeProgrammingNameSettings,
      );
    });
  }

  function programmingNamePreview(): string {
    const row = displayedRows.find(
      (candidate) => !candidate.isBacklight && !candidate.isHvac && !candidate.isCurtain && candidate.circuits.length > 0,
    );
    if (row) {
      return rowProgrammingNameValues(row).find((value) => value.trim()) || "-";
    }
    return formatProgrammingName(
      {
        locationNumber: "16",
        designerNumber: "2",
        area: "BM",
        address: "1",
        device: "A1-ZN1",
      },
      "Foyer DL",
      activeProgrammingNameSettings,
    );
  }

  function baseColumnLabel(col: BaseColumn): string {
    return col.key === "designerNumber" ? (numberMode === "designer" ? "Designer #" : "Internal #") : col.label;
  }

  function functionColumnLabel(col: FunctionColumn): string {
    return [col.switchNumber, col.switchName, functionColumnDetailLabel(col)]
      .map((part) => part.trim())
      .filter((part) => part && part !== "-")
      .join(" / ") || "-";
  }

  function rowTargetIds(row: CfsZoneRow): InspectionTarget[] {
    return cfsTargetsForRow(row);
  }

  function isCcoInspectionTarget(target: InspectionTarget): boolean {
    return target.targetId.startsWith("cco:") || target.dimmingType === "CCO";
  }

  function isReadonlyInspectionTarget(target: InspectionTarget): boolean {
    return target.targetId.startsWith("cci:") || target.targetId.startsWith("hvac:") || target.dimmingType === "CCI";
  }

  function isOnOffInspectionType(dimmingType: string): boolean {
    return dimmingType === "On/Off" || dimmingType === "Switch" || dimmingType === "CCO" || dimmingType === "Curtain";
  }

  function hasLinkIssueTargetRow(row: CfsZoneRow): boolean {
    if (linkIssueTargetIds.size === 0) return false;
    return rowTargetIds(row).some((target) => linkIssueTargetIds.has(target.targetId));
  }

  function hasLinkIssueFunctionColumn(col: FunctionColumn): boolean {
    if (linkIssueSourceIds.size === 0) return false;
    return Boolean(
      (col.roomScene && linkIssueSourceIds.has(col.roomScene.id)) ||
      (col.source && linkIssueSourceIds.has(col.source.id)),
    );
  }

  function hasLinkIssueFunctionCell(row: CfsZoneRow, col: FunctionColumn): boolean {
    return hasLinkIssueTargetRow(row) || hasLinkIssueFunctionColumn(col);
  }

  function targetDimmingType(row: CfsZoneRow): string {
    const targets = rowTargetIds(row);
    if (targets.length > 0 && targets.every((target) => target.dimmingType === "Curtain")) return "Curtain";
    if (targets.length > 0 && targets.every(isCcoInspectionTarget)) return "CCO";
    const target = targets[0];
    return target?.dimmingType || "Level";
  }

  function sceneIdsForSwitchTarget(sw: SwitchEntry, _targetId: string, areaId: string): string[] {
    return selectedSceneIdsForSwitch(sw)
      .map((sceneId) => scenesById.get(sceneId))
      .filter((scene): scene is Scene => scene !== undefined && sceneMatchesArea(scene, areaId))
      .map((scene) => scene.id);
  }

  function inspectionDraftKey(sourceType: InspectionDraftSource, sourceId: string, targetId: string): string {
    return `${sourceType}:${sourceId}:${targetId}`;
  }

  function sourceValueFromInspectionPayload(
    payload: Pick<InspectionCompletionPayload, "scenes" | "roomScenes" | "switches">,
    sourceType: InspectionDraftSource,
    sourceId: string,
    targetId: string,
  ): string {
    if (sourceType === "areaScene") {
      return payload.scenes
        .find((scene) => scene.id === sourceId)
        ?.settings.find((setting) => setting.circuitId === targetId)
        ?.percentage.trim() ?? "";
    }
    if (sourceType === "roomScene") {
      return payload.roomScenes
        .find((scene) => scene.id === sourceId)
        ?.settings.find((setting) => setting.circuitId === targetId)
        ?.percentage.trim() ?? "";
    }
    return payload.switches
      .find((sw) => sw.id === sourceId)
      ?.buttonSetting.circuitSettings.find((setting) => setting.circuitId === targetId)
      ?.percentage.trim() ?? "";
  }

  function sourceValueForInspectionDraft(sourceType: InspectionDraftSource, sourceId: string, targetId: string): string {
    return sourceValueFromInspectionPayload(
      { scenes: roomType.scenes, roomScenes: roomType.roomScenes, switches: roomType.switches },
      sourceType,
      sourceId,
      targetId,
    );
  }

  function inspectionSessionStartValueForDraft(
    sourceType: InspectionDraftSource,
    sourceId: string,
    targetId: string,
  ): string {
    if (!inspectionSessionBaseline) return sourceValueForInspectionDraft(sourceType, sourceId, targetId);
    return sourceValueFromInspectionPayload(inspectionSessionBaseline, sourceType, sourceId, targetId);
  }

  function buildInspectionDraftRef(
    sourceType: InspectionDraftSource,
    sourceId: string,
    label: string,
    target: InspectionTarget,
    scope: InspectionEditScope,
  ): InspectionDraftRef {
    return {
      ...target,
      key: inspectionDraftKey(sourceType, sourceId, target.targetId),
      scope,
      sourceType,
      sourceId,
      label,
      previousValue: inspectionSessionStartValueForDraft(sourceType, sourceId, target.targetId),
    };
  }

  function inspectionDraftRefsForTarget(
    col: FunctionColumn,
    target: InspectionTarget,
    scope: InspectionEditScope,
  ): InspectionDraftRef[] {
    if (col.roomScene) {
      const directExists = hasSetting(col.roomScene.settings, target.targetId);
      const areaSceneId = roomSceneSelectedAreaSceneId(col.roomScene, target.areaId);
      const areaScene = areaSceneId ? scenesById.get(areaSceneId) : undefined;
      if (scope === "areaScene" && !directExists && areaScene) {
        return [buildInspectionDraftRef("areaScene", areaScene.id, areaScene.name || "Area Scene", target, scope)];
      }
      const label = joinedSceneName(col.roomScene);
      return [buildInspectionDraftRef("roomScene", col.roomScene.id, label || "Scene Override", target, "override")];
    }

    if (!col.source) return [];
    const directExists = hasSetting(col.source.buttonSetting.circuitSettings, target.targetId);
    const sceneIds = sceneIdsForSwitchTarget(col.source, target.targetId, target.areaId);
    if (scope === "areaScene" && !directExists && sceneIds.length > 0) {
      return sceneIds
        .map((sceneId) => scenesById.get(sceneId))
        .filter((scene): scene is Scene => Boolean(scene))
        .map((scene) => buildInspectionDraftRef("areaScene", scene.id, scene.name || "Area Scene", target, scope));
    }
    return [buildInspectionDraftRef("switch", col.source.id, functionColumnLabel(col), target, "override")];
  }

  function uniqueInspectionDraftRefs(refs: InspectionDraftRef[]): InspectionDraftRef[] {
    const seen = new Set<string>();
    return refs.filter((ref) => {
      if (seen.has(ref.key)) return false;
      seen.add(ref.key);
      return true;
    });
  }

  function activeInspectionDraftRefsForCell(row: CfsZoneRow, col: FunctionColumn): InspectionDraftRef[] {
    return uniqueInspectionDraftRefs(
      rowTargetIds(row).flatMap((target) => inspectionDraftRefsForTarget(col, target, inspectionEditScope)),
    );
  }

  function allInspectionDraftRefsForCell(row: CfsZoneRow, col: FunctionColumn): InspectionDraftRef[] {
    const targets = rowTargetIds(row);
    return uniqueInspectionDraftRefs(
      targets.flatMap((target) => [
        ...inspectionDraftRefsForTarget(col, target, "override"),
        ...inspectionDraftRefsForTarget(col, target, "areaScene"),
      ]),
    );
  }

  function draftForInspectionTarget(col: FunctionColumn, target: InspectionTarget): InspectionDraft | undefined {
    const refs = uniqueInspectionDraftRefs([
      ...inspectionDraftRefsForTarget(col, target, "override"),
      ...inspectionDraftRefsForTarget(col, target, "areaScene"),
    ]);
    for (const ref of refs) {
      const draft = inspectionDrafts[ref.key];
      if (draft) return draft;
    }
    return undefined;
  }

  function rawInspectionValueForTarget(col: FunctionColumn, targetId: string, areaId: string): string {
    if (col.roomScene) {
      const direct = col.roomScene.settings.find((setting) => setting.circuitId === targetId)?.percentage.trim() ?? "";
      if (direct) return direct;
      const areaSceneId = roomSceneSelectedAreaSceneId(col.roomScene, areaId);
      const areaScene = scenesById.get(areaSceneId);
      return areaScene ? sceneValueForCircuit(areaScene, targetId) : "";
    }
    if (!col.source) return "";
    const direct = col.source.buttonSetting.circuitSettings
      .find((setting) => setting.circuitId === targetId)
      ?.percentage.trim() ?? "";
    if (direct) return direct;
    const sceneIds = sceneIdsForSwitchTarget(col.source, targetId, areaId);
    return sceneIds
      .map((sceneId) => {
        const scene = scenesById.get(sceneId);
        return scene ? sceneValueForCircuit(scene, targetId) : "";
      })
      .find(Boolean) ?? "";
  }

  function inspectionCellModel(row: CfsZoneRow, col: FunctionColumn): {
    editable: boolean;
    value: string;
    placeholder: string;
    dimmingType: string;
  } {
    if (row.isBacklight || row.isHvac || row.isCci) return { editable: false, value: "", placeholder: "-", dimmingType: "" };
    if (!col.roomScene && !col.source) return { editable: false, value: "", placeholder: "-", dimmingType: "" };
    const targets = rowTargetIds(row);
    if (targets.length === 0) return { editable: false, value: "", placeholder: "-", dimmingType: "" };
    if (targets.some(isReadonlyInspectionTarget)) return { editable: false, value: "", placeholder: "-", dimmingType: "" };
    const rawValues = uniqueValues(
      targets.map((target) => {
        const draft = draftForInspectionTarget(col, target);
        return draft?.value ?? rawInspectionValueForTarget(col, target.targetId, target.areaId);
      }),
    );
    const dimmingType = targetDimmingType(row);
    if (rawValues.length <= 1) {
      return { editable: true, value: rawValues[0] ?? "", placeholder: "Uneffected", dimmingType };
    }
    return { editable: true, value: "", placeholder: "Mixed", dimmingType };
  }

  function inspectionOriginalDisplayValue(row: CfsZoneRow, col: FunctionColumn, dimmingType: string): string {
    const refs = activeInspectionDraftRefsForCell(row, col);
    if (refs.length === 0) return "Uneffected";
    const values = Array.from(
      new Set(refs.map((ref) => (inspectionBaselineValues[ref.key] ?? ref.previousValue).trim())),
    );
    if (values.length > 1) return "Mixed";
    const value = values[0] ?? "";
    return value ? formatInspectionValue(value, dimmingType) : "Uneffected";
  }

  function updateSceneValue(nextScenes: Scene[], sceneId: string, targetId: string, value: string): Scene[] {
    return nextScenes.map((scene) =>
      scene.id === sceneId ? { ...scene, settings: setSettingsValue(scene.settings, targetId, value) } : scene,
    );
  }

  function updateRoomSceneValue(nextRoomScenes: RoomScene[], roomSceneId: string, targetId: string, value: string): RoomScene[] {
    return nextRoomScenes.map((scene) =>
      scene.id === roomSceneId ? { ...scene, settings: setSettingsValue(scene.settings, targetId, value) } : scene,
    );
  }

  function updateSwitchValue(nextSwitches: SwitchEntry[], switchId: string, targetId: string, value: string): SwitchEntry[] {
    return nextSwitches.map((sw) =>
      sw.id === switchId
        ? {
            ...sw,
            buttonSetting: {
              ...sw.buttonSetting,
              circuitSettings: setSettingsValue(sw.buttonSetting.circuitSettings, targetId, value),
            },
          }
        : sw,
    );
  }

  function inspectionMarksWithDrafts(drafts: InspectionDraft[]): InspectionMark[] {
    const markedAt = new Date().toISOString();
    const byKey = new Map(
      (inspectionSessionBaseline?.inspectionMarks ?? inspectionMarkList).map((mark) => [
        inspectionDraftKey(mark.sourceType, mark.sourceId, mark.targetId),
        mark,
      ]),
    );
    for (const draft of drafts) {
      const key = inspectionDraftKey(draft.sourceType, draft.sourceId, draft.targetId);
      const existing = byKey.get(key);
      byKey.set(key, {
        id: existing?.id ?? createAppId(),
        sourceType: draft.sourceType,
        sourceId: draft.sourceId,
        targetId: draft.targetId,
        scope: draft.scope === "areaScene" ? "areaScene" : "override",
        label: draft.label,
        previousValue: draft.previousValue,
        value: draft.value,
        markedAt,
      });
    }
    return Array.from(byKey.values()).sort((a, b) => a.markedAt.localeCompare(b.markedAt));
  }

  function captureInspectionSessionBaseline(): InspectionCompletionPayload {
    return {
      scenes: cloneInspectionData(roomType.scenes),
      roomScenes: cloneInspectionData(roomType.roomScenes),
      switches: cloneInspectionData(roomType.switches),
      inspectionMarks: cloneInspectionData(inspectionMarkList),
    };
  }

  function buildInspectionAppliedState(drafts: InspectionDraft[] = inspectionDraftList): InspectionCompletionPayload {
    let nextScenes = inspectionSessionBaseline?.scenes ?? roomType.scenes;
    let nextRoomScenes = inspectionSessionBaseline?.roomScenes ?? roomType.roomScenes;
    let nextSwitches = inspectionSessionBaseline?.switches ?? roomType.switches;

    for (const draft of drafts) {
      if (draft.sourceType === "areaScene") {
        nextScenes = updateSceneValue(nextScenes, draft.sourceId, draft.targetId, draft.value);
      } else if (draft.sourceType === "roomScene") {
        nextRoomScenes = updateRoomSceneValue(nextRoomScenes, draft.sourceId, draft.targetId, draft.value);
      } else {
        nextSwitches = updateSwitchValue(nextSwitches, draft.sourceId, draft.targetId, draft.value);
      }
    }

    return {
      scenes: nextScenes,
      roomScenes: nextRoomScenes,
      switches: nextSwitches,
      inspectionMarks: drafts.length > 0
        ? inspectionMarksWithDrafts(drafts)
        : inspectionSessionBaseline?.inspectionMarks ?? inspectionMarkList,
    };
  }

  function changeInspectionCell(row: CfsZoneRow, col: FunctionColumn, value: string): void {
    const model = inspectionCellModel(row, col);
    if (!model.editable) return;
    const normalizedValue = normalizeInspectionInput(value, model.dimmingType);
    const refs = activeInspectionDraftRefsForCell(row, col);
    if (refs.length === 0) return;
    const changesValue = refs.some((ref) => {
      const currentValue = inspectionDrafts[ref.key]?.value ?? sourceValueForInspectionDraft(ref.sourceType, ref.sourceId, ref.targetId);
      return normalizeLevelForCompare(currentValue) !== normalizeLevelForCompare(normalizedValue);
    });
    if (!changesValue) return;

    pushInspectionHistorySnapshot();
    setInspectionBaselineValues((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const ref of refs) {
        if (Object.prototype.hasOwnProperty.call(next, ref.key)) continue;
        next[ref.key] = ref.previousValue;
        changed = true;
      }
      return changed ? next : prev;
    });

    inspectionDraftsTouchedRef.current = true;
    setInspectionDrafts((prev) => {
      const next = { ...prev };
      for (const ref of refs) {
        if (normalizeLevelForCompare(normalizedValue) === normalizeLevelForCompare(ref.previousValue)) {
          delete next[ref.key];
        } else {
          next[ref.key] = { ...ref, value: normalizedValue };
        }
      }
      return next;
    });
  }

  function resetInspectionPopoverCell(row: CfsZoneRow, col: FunctionColumn): void {
    const refs = allInspectionDraftRefsForCell(row, col);
    if (refs.length > 0) {
      pushInspectionHistorySnapshot();
      setInspectionDrafts((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const ref of refs) {
          const sessionStartValue = inspectionSessionStartValueForDraft(ref.sourceType, ref.sourceId, ref.targetId);
          const currentSourceValue = sourceValueForInspectionDraft(ref.sourceType, ref.sourceId, ref.targetId);
          const sourceAlreadyMatchesSessionStart =
            normalizeLevelForCompare(currentSourceValue) === normalizeLevelForCompare(sessionStartValue);
          if (sourceAlreadyMatchesSessionStart) {
            if (Object.prototype.hasOwnProperty.call(next, ref.key)) {
              delete next[ref.key];
              changed = true;
            }
          } else {
            const resetDraft: InspectionDraft = {
              ...ref,
              previousValue: sessionStartValue,
              value: sessionStartValue,
            };
            const existing = next[ref.key];
            if (
              !existing ||
              normalizeLevelForCompare(existing.value) !== normalizeLevelForCompare(resetDraft.value) ||
              normalizeLevelForCompare(existing.previousValue) !== normalizeLevelForCompare(resetDraft.previousValue)
            ) {
              next[ref.key] = resetDraft;
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });
      setInspectionBaselineValues((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const ref of refs) {
          const sessionStartValue = inspectionSessionStartValueForDraft(ref.sourceType, ref.sourceId, ref.targetId);
          const currentSourceValue = sourceValueForInspectionDraft(ref.sourceType, ref.sourceId, ref.targetId);
          const sourceAlreadyMatchesSessionStart =
            normalizeLevelForCompare(currentSourceValue) === normalizeLevelForCompare(sessionStartValue);
          if (sourceAlreadyMatchesSessionStart) {
            if (Object.prototype.hasOwnProperty.call(next, ref.key)) {
              delete next[ref.key];
              changed = true;
            }
          } else if (next[ref.key] !== sessionStartValue) {
            next[ref.key] = sessionStartValue;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
    setInspectionPopover(null);
  }

  const clearInspectionLocalSession = useCallback((): void => {
    setInspectionDrafts({});
    setInspectionBaselineValues({});
    clearInspectionHistory();
    setInspectionPopover(null);
    setInspectionMode(false);
    setInspectionSessionBaseline(null);
    setInspectionSessionSavedRevision(false);
    setInspectionDialog(null);
    inspectionDraftsTouchedRef.current = false;
    resetInspectionSelection();
  }, [resetInspectionSelection]);

  function restoreInspectionSessionBaseline(): void {
    const baseline = inspectionSessionBaseline;
    if (baseline) {
      onScenesChange?.(cloneInspectionData(baseline.scenes));
      onRoomScenesChange?.(cloneInspectionData(baseline.roomScenes));
      onSwitchesChange?.(cloneInspectionData(baseline.switches));
      onInspectionMarksChange?.(cloneInspectionData(baseline.inspectionMarks));
    }
    clearInspectionLocalSession();
  }

  function cancelInspectionSession(): void {
    restoreInspectionSessionBaseline();
  }

  useEffect(() => {
    if (!inspectionMode) {
      inspectionRoomTypeIdRef.current = roomType.id;
      return;
    }
    if (inspectionRoomTypeIdRef.current === roomType.id) return;
    const previousRoomTypeId = inspectionRoomTypeIdRef.current;
    if (inspectionDraftsTouchedRef.current) {
      onInspectionLiveChange?.(previousRoomTypeId, buildInspectionAppliedState(inspectionDraftList), {
        hasDraft: inspectionDraftList.length > 0,
      });
    }
    inspectionRoomTypeIdRef.current = roomType.id;
    const baseline = captureInspectionSessionBaseline();
    setInspectionSessionBaseline(baseline);
    setInspectionDrafts({});
    setInspectionBaselineValues({});
    clearInspectionHistory();
    setInspectionPopover(null);
    inspectionDraftsTouchedRef.current = false;
    resetInspectionSelection();
    onInspectionRoomTypeEnter?.(roomType.id, baseline);
  }, [inspectionMode, inspectionDraftList, onInspectionLiveChange, onInspectionRoomTypeEnter, resetInspectionSelection, roomType.id]);

  useEffect(() => {
    if (!inspectionMode || !inspectionDraftsTouchedRef.current) return;
    onInspectionLiveChange?.(roomType.id, buildInspectionAppliedState(inspectionDraftList), {
      hasDraft: inspectionDraftList.length > 0,
    });
  }, [inspectionMode, inspectionDraftList, onInspectionLiveChange, roomType.id]);

  useEffect(() => {
    if (!inspectionMode || canEdit) return;
    clearInspectionLocalSession();
  }, [canEdit, clearInspectionLocalSession, inspectionMode]);

  function startInspectionMode(): void {
    setInspectionDialog({ kind: "start" });
  }

  function beginInspectionMode(choice: InspectionRevisionChoice): void {
    if (onBeforeInspectionStart && !onBeforeInspectionStart(choice)) return;
    const baseline = captureInspectionSessionBaseline();
    inspectionRoomTypeIdRef.current = roomType.id;
    inspectionDraftsTouchedRef.current = false;
    setInspectionSessionBaseline(baseline);
    setInspectionDrafts({});
    setInspectionBaselineValues({});
    clearInspectionHistory();
    setInspectionPopover(null);
    setInspectionDialog(null);
    resetInspectionSelection();
    setShowInspectionMarkHighlight(true);
    setInspectionSessionSavedRevision(choice === "newRevision");
    setInspectionMode(true);
    onInspectionModeStart?.(roomType.id, baseline);
  }

  function completeInspectionSession(): void {
    setInspectionDialog({ kind: "finish" });
  }

  function finishInspectionSession(saveAsNewRevision: boolean): void {
    const next = buildInspectionAppliedState(inspectionDraftList);
    if (onCompleteInspection) {
      const completed = onCompleteInspection(next, { saveAsNewRevision });
      if (completed === false) return;
    } else {
      if (next.scenes !== roomType.scenes) onScenesChange?.(next.scenes);
      if (next.roomScenes !== roomType.roomScenes) onRoomScenesChange?.(next.roomScenes);
      if (next.switches !== roomType.switches) onSwitchesChange?.(next.switches);
      onInspectionMarksChange?.(next.inspectionMarks);
    }
    setInspectionDrafts({});
    setInspectionBaselineValues({});
    clearInspectionHistory();
    setInspectionPopover(null);
    setInspectionSessionBaseline(null);
    setInspectionSessionSavedRevision(false);
    setInspectionDialog(null);
    inspectionDraftsTouchedRef.current = false;
    resetInspectionSelection();
    setShowInspectionMarkHighlight(true);
    setInspectionMode(false);
  }

  function inspectionDraftSummaryForCell(row: CfsZoneRow, col: FunctionColumn): {
    hasDraft: boolean;
    hasChanged: boolean;
    scope: InspectionEditScope | "";
  } {
    const refs = allInspectionDraftRefsForCell(row, col);
    const drafts = refs
      .map((ref) => inspectionDrafts[ref.key])
      .filter((draft): draft is InspectionDraft => Boolean(draft));
    const changedRefs = refs.filter((ref) => {
      const baseline = inspectionBaselineValues[ref.key];
      if (baseline === undefined) return Boolean(inspectionDrafts[ref.key]);
      const draft = inspectionDrafts[ref.key];
      const current = draft?.value ?? sourceValueForInspectionDraft(ref.sourceType, ref.sourceId, ref.targetId);
      return normalizeLevelForCompare(current) !== normalizeLevelForCompare(baseline);
    });
    if (drafts.length === 0 && changedRefs.length === 0) {
      return { hasDraft: false, hasChanged: false, scope: "" };
    }
    const scopedRefs = drafts.length > 0 ? drafts : changedRefs;
    return {
      hasDraft: drafts.length > 0,
      hasChanged: changedRefs.length > 0,
      scope: scopedRefs.some((ref) => ref.sourceType !== "areaScene" || ref.scope === "override") ? "override" : "areaScene",
    };
  }

  function hasInspectionMarkForCell(row: CfsZoneRow, col: FunctionColumn): boolean {
    return allInspectionDraftRefsForCell(row, col).some((ref) => inspectionMarksByKey.has(ref.key));
  }

  function inspectionPopoverPosition(trigger: HTMLElement, dimmingType: string): InspectionPopoverState {
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(Math.max(rect.width + 104, 268), viewportWidth - margin * 2);
    const expectedHeight = isPercentInspectionType(dimmingType) ? 286 : 292;
    const maxHeight = Math.min(expectedHeight, viewportHeight - margin * 2);
    const spaceBelow = viewportHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const flipUp = spaceBelow < expectedHeight && spaceAbove > spaceBelow;
    const rawTop = flipUp ? rect.top - maxHeight - 6 : rect.bottom + 6;
    return {
      rowId: "",
      colId: "",
      top: Math.max(margin, Math.min(rawTop, viewportHeight - maxHeight - margin)),
      left: Math.max(margin, Math.min(rect.left, viewportWidth - width - margin)),
      width,
      maxHeight,
    };
  }

  function openInspectionPopover(row: CfsZoneRow, col: FunctionColumn, event: ReactMouseEvent<HTMLElement>): void {
    const model = inspectionCellModel(row, col);
    if (!model.editable) return;
    const position = inspectionPopoverPosition(event.currentTarget, model.dimmingType);
    setInspectionPopover({ ...position, rowId: row.id, colId: col.id });
  }

  function formatInspectionValue(value: string, dimmingType: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return isOnOffInspectionType(dimmingType) ? trimmed : formatLevel(trimmed, dimmingType);
  }

  function inspectionPercentNumber(value: string): number {
    const numeric = Number.parseFloat(value.trim().replace(/%$/, ""));
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function stepInspectionPercent(row: CfsZoneRow, col: FunctionColumn, delta: number): void {
    const model = inspectionCellModel(row, col);
    if (!model.editable || !isPercentInspectionType(model.dimmingType)) return;
    const nextValue = Math.min(100, Math.max(0, Math.round(inspectionPercentNumber(model.value) + delta)));
    changeInspectionCell(row, col, String(nextValue));
  }

  function inspectionChoiceValue(label: string): string {
    return label === "Uneffected" ? "" : label;
  }

  function renderInspectionCellContent(
    row: CfsZoneRow,
    col: FunctionColumn,
    values: string[],
    isAreaSceneValue: boolean,
  ): ReactNode {
    const content = renderStack(values, row.isBacklight ? "" : "-", {
      emphasizeSceneNameLines: isAreaSceneValue && values.length > 1,
      sceneNameColors,
    });
    const model = inspectionCellModel(row, col);
    if (!model.editable) return content;
    const active = inspectionPopover?.rowId === row.id && inspectionPopover.colId === col.id;
    const selected = isInspectionCellSelected(row.id, col.id);
    const pasteTarget = inspectionPasteTarget?.rowId === row.id && inspectionPasteTarget.colId === col.id;
    return (
      <button
        type="button"
        className={`cfs-inspection-cell-trigger${active ? " is-active" : ""}${selected ? " is-selected" : ""}${
          pasteTarget ? " is-paste-target" : ""
        }`}
        aria-label={`Edit Inspection value ${functionColumnLabel(col)}`}
        aria-haspopup="dialog"
        aria-expanded={active}
        onClick={(event) => {
          if (inspectionSelectionPhase !== "off") {
            event.preventDefault();
            selectInspectionCell(row, col);
            return;
          }
          openInspectionPopover(row, col, event);
        }}
      >
        {content}
      </button>
    );
  }

  function renderInspectionPopover(): ReactNode {
    if (!inspectionMode || !inspectionPopover || typeof document === "undefined") return null;
    const row = displayedRows.find((item) => item.id === inspectionPopover.rowId);
    const col = visibleFunctionColumns.find((item) => item.id === inspectionPopover.colId);
    if (!row || !col) return null;
    const model = inspectionCellModel(row, col);
    if (!model.editable) return null;
    const originalValue = inspectionOriginalDisplayValue(row, col, model.dimmingType);
    const title = functionColumnLabel(col);
    const popover = (
      <div
        ref={inspectionPopoverRef}
        className="cfs-inspection-popover"
        role="dialog"
        aria-label={`Inspection editor ${title}`}
        style={{
          position: "fixed",
          top: inspectionPopover.top,
          left: inspectionPopover.left,
          width: inspectionPopover.width,
          maxHeight: inspectionPopover.maxHeight,
          zIndex: 7000,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="cfs-inspection-popover-head">
          <div className="cfs-inspection-popover-title" title={title}>{title}</div>
          <div className="cfs-inspection-current-value" title="Original value">{originalValue}</div>
        </div>
        {isPercentInspectionType(model.dimmingType) ? (
          <div className="cfs-inspection-popover-body">
            <input
              className="cfs-inspection-input cfs-inspection-popover-input"
              type="text"
              value={model.value}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              aria-label={`Inspection value ${title}`}
              onChange={(event) => changeInspectionCell(row, col, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") setInspectionPopover(null);
              }}
            />
            <div className="cfs-inspection-percent-preset-grid" aria-label="Level preset values">
              {INSPECTION_PERCENT_PRESET_VALUES.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  className={`cfs-inspection-choice-button${preset.value === model.value ? " is-selected" : ""}`}
                  onClick={() => changeInspectionCell(row, col, preset.value)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="cfs-inspection-step-grid" aria-label="Level adjustment">
              {INSPECTION_PERCENT_STEPS.map((step) => (
                <button
                  key={step}
                  type="button"
                  className="cfs-inspection-step-button"
                  onClick={() => stepInspectionPercent(row, col, step)}
                >
                  {step > 0 ? `+${step}` : step}
                </button>
              ))}
            </div>
            <div className="cfs-inspection-quick-grid" aria-label="Level quick values">
              {INSPECTION_PERCENT_QUICK_VALUES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className={`cfs-inspection-choice-button${
                    inspectionChoiceValue(choice) === model.value ? " is-selected" : ""
                  }`}
                  onClick={() => changeInspectionCell(row, col, inspectionChoiceValue(choice))}
                >
                  {choice}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div
            className="cfs-inspection-choice-grid"
            role="group"
            aria-label={model.dimmingType === "Curtain" ? "Open Close Stop Uneffected" : "On Off Uneffected 0.5 sec"}
          >
            {(model.dimmingType === "Curtain" ? INSPECTION_CURTAIN_VALUES : INSPECTION_ON_OFF_VALUES).map((choice) => (
              <button
                key={choice}
                type="button"
                className={`cfs-inspection-choice-button${
                  inspectionChoiceValue(choice) === model.value ? " is-selected" : ""
                }`}
                onClick={() => changeInspectionCell(row, col, inspectionChoiceValue(choice))}
              >
                {choice}
              </button>
            ))}
          </div>
        )}
        <div className="cfs-inspection-popover-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setInspectionPopover(null)}>
            OK
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => resetInspectionPopoverCell(row, col)}>
            Reset
          </button>
        </div>
      </div>
    );
    return createPortal(popover, document.body);
  }

  function renderInspectionRevisionDialog(): ReactNode {
    if (!inspectionDialog || typeof document === "undefined") return null;
    const isStart = inspectionDialog.kind === "start";
    const alreadySaved = !isStart && inspectionSessionSavedRevision;
    const showRevisionTargets = !isStart && !alreadySaved && inspectionRevisionTargets.length > 0;
    const selectedRevisionTargetCount = inspectionRevisionTargets.filter((target) => target.selected).length;
    const canSaveNewRevision = !showRevisionTargets || selectedRevisionTargetCount > 0;
    const title = isStart ? "Start InspectionMode" : "Finish InspectionMode";
    const message = isStart
      ? hasRevisionDraft
        ? "The current revision has draft changes. Choose how to handle the revision before starting InspectionMode."
        : "Choose whether to save a new revision before starting InspectionMode."
      : alreadySaved
        ? "This InspectionMode session already started after saving a new revision. Finish it in the current revision."
        : "Choose whether to save the inspection result as a new revision before finishing.";
    const dialog = (
      <div className="cfs-inspection-dialog-backdrop" role="presentation">
        <div
          className="cfs-inspection-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="cfs-inspection-dialog-head">
            <strong>{title}</strong>
            <span>{inspectionDraftList.length} draft / {inspectionMarkList.length} mark</span>
          </div>
          <p>{message}</p>
          {showRevisionTargets ? (
            <div className="cfs-inspection-dialog-targets">
              <div className="revision-batch-summary cfs-inspection-target-summary">
                <span>{selectedRevisionTargetCount} / {inspectionRevisionTargets.length} room types selected for revision save.</span>
                <small>Unchecked room types keep their inspection edits as draft data without creating a new revision.</small>
              </div>
              <div className="revision-batch-table-wrap cfs-inspection-target-table-wrap">
                <table className="mini-table revision-batch-table cfs-inspection-target-table">
                  <thead>
                    <tr>
                      <th className="revision-batch-select-heading">Save</th>
                      <th>Room Type</th>
                      <th>Current Revision</th>
                      <th>Update Revision</th>
                      <th>Memo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inspectionRevisionTargets.map((target) => (
                      <tr key={target.roomTypeId} className={target.selected ? "" : "is-unselected"}>
                        <td className="revision-batch-select-cell">
                          <label className="revision-batch-row-check">
                            <input
                              type="checkbox"
                              checked={target.selected}
                              onChange={(event) =>
                                onInspectionRevisionTargetChange?.(target.roomTypeId, { selected: event.target.checked })
                              }
                            />
                            <span>Save</span>
                          </label>
                        </td>
                        <td>
                          <span className="revision-batch-room-name">{target.name}</span>
                        </td>
                        <td>{target.currentRevision}</td>
                        <td>
                          <input
                            className="revision-batch-revision-input"
                            type="text"
                            value={target.revision}
                            disabled={!target.selected}
                            onChange={(event) =>
                              onInspectionRevisionTargetChange?.(target.roomTypeId, { revision: event.target.value })
                            }
                          />
                        </td>
                        <td>
                          <textarea
                            className="revision-batch-note-input"
                            value={target.note}
                            disabled={!target.selected}
                            rows={2}
                            placeholder="Memo"
                            onChange={(event) =>
                              onInspectionRevisionTargetChange?.(target.roomTypeId, { note: event.target.value })
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="cfs-inspection-dialog-target">
              <span>Revision target</span>
              <strong>{roomType.name || "Current Room Type"}</strong>
              <small>
                {isStart
                  ? "The current room type revision is handled before InspectionMode starts."
                  : "No other room type has inspection edits in this session."}
              </small>
            </div>
          )}
          <div className="cfs-inspection-dialog-actions">
            {isStart ? (
              <>
                <button type="button" className="btn btn-primary" onClick={() => beginInspectionMode("newRevision")}>
                  Save New Revision & Start
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => beginInspectionMode("sameRevision")}>
                  Start Current Revision
                </button>
              </>
            ) : (
              <>
                {!alreadySaved ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!canSaveNewRevision}
                    onClick={() => finishInspectionSession(true)}
                  >
                    Save New Revision & Finish
                  </button>
                ) : null}
                <button type="button" className="btn btn-secondary" onClick={() => finishInspectionSession(false)}>
                  Finish Current Revision
                </button>
              </>
            )}
            <button type="button" className="btn btn-secondary" onClick={() => setInspectionDialog(null)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
    return createPortal(dialog, document.body);
  }

  function baseValues(row: CfsZoneRow, key: BaseColumnKey): string[] {
    if (row.isBacklight) {
      switch (key) {
        case "device":
        case "deviceNum":
        case "dimmingType":
        case "group":
        case "zone":
        case "designerNumber":
        case "area":
        case "areaAddress":
          return key === "device" ? ["Backlight Logic"] : [];
        case "detail":
          return row.circuits.map((item) => item.detail || "-");
        case "programmingName":
          return [];
        default:
          return [];
      }
    }
    if (row.isHvac) {
      switch (key) {
        case "designerNumber":
        case "group":
        case "areaAddress":
        case "programmingName":
          return [];
        case "zone":
          return rowZoneValues(row);
        case "dimmingType":
          return rowDimmingValues(row);
        case "detail":
          return row.circuits.map((item) => item.detail || "-");
        case "area":
          return [row.location];
        case "device":
        case "deviceNum":
          return [String(row[key] ?? "")];
        default:
          return [];
      }
    }
    switch (key) {
      case "designerNumber":
        return rowNumberValues(row, numberMode);
      case "areaAddress":
        return rowAreaAddressValues(row);
      case "programmingName":
        return rowProgrammingNameValues(row);
      case "dimmingType":
        return rowDimmingValues(row);
      case "area":
        return row.location ? [row.location] : [];
      case "detail":
        if (row.circuits.length === 0 && row.isIoAssignment) {
          const ioDetail = row.assignmentDetail || row.assignmentValue || "";
          return ioDetail ? [ioDetail] : [];
        }
        return row.circuits.length === 0
          ? [row.assignmentDetail || row.assignmentValue || "-"]
          : row.circuits.map((item) => item.detail || item.designerNumber || item.internalNumber || "-");
      case "zone":
        return rowZoneValues(row);
      case "group":
        return row.isDali ? [row.group || "Reserved"] : [];
      case "number":
        return [];
      case "device":
      case "deviceNum":
        return [String(row[key] ?? "")];
      default:
        return [];
    }
  }

  function inspectionAreaSceneNameForTarget(
    col: FunctionColumn,
    target: InspectionTarget,
    draft: InspectionDraft | undefined,
  ): string {
    if (!showAreaSceneNames) return "";
    if (draft) {
      if (draft.sourceType !== "areaScene") return "";
      const scene = scenesById.get(draft.sourceId);
      return scene ? areaSceneDisplayName(scene) : "";
    }
    if (col.roomScene) {
      const direct = col.roomScene.settings.find((setting) => setting.circuitId === target.targetId)?.percentage.trim() ?? "";
      if (direct) return "";
      const areaSceneId = roomSceneSelectedAreaSceneId(col.roomScene, target.areaId);
      const areaScene = scenesById.get(areaSceneId);
      return areaScene ? areaSceneDisplayName(areaScene) : "";
    }
    if (!col.source) return "";
    const direct = col.source.buttonSetting.circuitSettings
      .find((setting) => setting.circuitId === target.targetId)
      ?.percentage.trim() ?? "";
    if (direct) return "";
    const sceneId = sceneIdsForSwitchTarget(col.source, target.targetId, target.areaId).find((id) => {
      const scene = scenesById.get(id);
      return scene ? sceneValueForCircuit(scene, target.targetId).trim() !== "" : false;
    });
    const scene = sceneId ? scenesById.get(sceneId) : undefined;
    return scene ? areaSceneDisplayName(scene) : "";
  }

  function inspectionDisplayValues(row: CfsZoneRow, col: FunctionColumn): string[] | null {
    if (!inspectionMode) return null;
    const targets = rowTargetIds(row);
    if (targets.length === 0) return null;
    const hasDraft = targets.some((target) => Boolean(draftForInspectionTarget(col, target)));
    if (!hasDraft) return null;
    return uniqueValues(
      targets.flatMap((target) => {
        const draft = draftForInspectionTarget(col, target);
        const rawValue = draft?.value ?? rawInspectionValueForTarget(col, target.targetId, target.areaId);
        const formattedValue = formatInspectionValue(rawValue, target.dimmingType);
        if (!formattedValue) return [];
        const sceneName = inspectionAreaSceneNameForTarget(col, target, draft);
        return sceneName ? [sceneName, formattedValue] : [formattedValue];
      }),
    );
  }

  function targetDisplayValues(row: CfsZoneRow, col: FunctionColumn): string[] {
    const targets = rowTargetIds(row);
    if (targets.length === 0) return [""];
    return uniqueValues(
      targets.flatMap((target) => {
        const rawValue = rawInspectionValueForTarget(col, target.targetId, target.areaId);
        const formattedValue = formatInspectionValue(rawValue, target.dimmingType);
        if (!formattedValue) return [];
        const sceneName = inspectionAreaSceneNameForTarget(col, target, undefined);
        return sceneName ? [sceneName, formattedValue] : [formattedValue];
      }),
    );
  }

  function rawFunctionValues(row: CfsZoneRow, col: FunctionColumn): string[] {
    const draftValues = inspectionDisplayValues(row, col);
    if (draftValues) return draftValues.length > 0 ? draftValues : [""];
    if (row.isBacklight) {
      if (col.roomScene) {
        const condition = displayBacklightCondition(col.roomScene.backlightCondition);
        return condition ? [condition] : [""];
      }
      if (!col.source || !row.backlightTargetGroupId) return [""];
      const targetIds = col.source.backlightTarget.split(",").map((value) => value.trim()).filter(Boolean);
      const condition = displayBacklightCondition(col.source.backlightCondition, col.source);
      return targetIds.includes(row.backlightTargetGroupId) && condition ? [condition] : [""];
    }
    if (row.isHvac && row.hvacSettingId) {
      const dimmingType = row.hvacMetric || "HVAC";
      if (col.roomScene) {
        return [roomSceneSettingValue(col.roomScene, row.hvacSettingId, dimmingType) || ""];
      }
      if (!col.source) return [""];
      const direct = col.source.buttonSetting.circuitSettings
        .find((setting) => setting.circuitId === row.hvacSettingId)
        ?.percentage ?? "";
      if (direct.trim()) return [formatLevel(direct, dimmingType)];
      return sceneRawValuesForTarget(col.source, row.hvacSettingId, row.locationId, scenesById)
        .map((value) => formatLevel(value, dimmingType))
        .filter(Boolean);
    }
    if (row.circuits.length === 0) {
      const targets = rowTargetIds(row);
      return targets.length > 0 && targets.every(isCcoInspectionTarget)
        ? targetDisplayValues(row, col)
        : [""];
    }
    if (col.roomScene) {
      return row.circuits.flatMap((item) => roomSceneCellValue(col.roomScene!, item.circuit, scenesById, showAreaSceneNames));
    }
    if (!col.source) return [""];
    return row.circuits.flatMap((item) => cellValues(col.source!, item.circuit, scenesById, showAreaSceneNames));
  }

  // Cells a scene names but does not set stay "-": the dash means "nothing
  // operates here" (2026-08-22 decision — an "Uneffected" label was tried and
  // rejected).
  function functionValues(row: CfsZoneRow, col: FunctionColumn): string[] {
    const values = rawFunctionValues(row, col);
    if (row.isBacklight) return values;
    return values.some((value) => value.trim() !== "") ? values : ["-"];
  }

  function hasRepairedLinkCell(row: CfsZoneRow, values: string[]): boolean {
    if (repairedLinkTargetIds.size === 0) return false;
    const visibleValue = values.some((value) => {
      const trimmed = value.trim();
      return trimmed !== "" && trimmed !== "-";
    });
    if (!visibleValue) return false;
    return rowTargetIds(row).some((target) => repairedLinkTargetIds.has(target.targetId));
  }

  function hasSceneDifferentOverride(row: CfsZoneRow, col: FunctionColumn): boolean {
    if (col.roomScene) {
      if (row.isBacklight || row.isHvac || row.circuits.length === 0) return false;
      return row.circuits.some((item) => {
        const direct = col.roomScene!.settings
          .find((setting) => setting.circuitId === item.circuit.id)
          ?.percentage.trim() ?? "";
        return direct !== "" && roomSceneHasAreaSceneValue(col.roomScene!, item.circuit, scenesById);
      });
    }
    const sw = col.source;
    if (!sw) return false;
    if (row.isBacklight || row.circuits.length === 0) return false;
    return row.circuits.some((item) => {
      const direct = sw.buttonSetting.circuitSettings
        .find((setting) => setting.circuitId === item.circuit.id)
        ?.percentage.trim() ?? "";
      if (!direct) return false;
      const sceneValues = sceneRawValuesForCircuit(sw, item.circuit, scenesById);
      if (sceneValues.length === 0) return false;
      const normalizedDirect = normalizeLevelForCompare(direct);
      return sceneValues.some((sceneValue) => normalizeLevelForCompare(sceneValue) !== normalizedDirect);
    });
  }

  function hasRevisionFields(changes: RevisionFieldChanges | undefined, id: string, fields?: readonly string[]): boolean {
    const changed = changes?.[id];
    if (!changed) return false;
    if (!fields) return changed.length > 0;
    return fields.some((field) => changed.includes(field));
  }

  function hasAddedRevisionRow(changes: RevisionFieldChanges | undefined, id: string): boolean {
    const changed = changes?.[id];
    return Boolean(changed?.includes("__added"));
  }

  function hasChangedAssignmentField(row: CfsZoneRow, fields?: readonly string[]): boolean {
    if (!revisionDiffSets) return false;
    const changes = row.isCurtain ? revisionDiffSets.curtainAssignmentFields : revisionDiffSets.assignmentFields;
    return Boolean(row.assignmentIds?.some((id) => hasRevisionFields(changes, id, fields)));
  }

  function hasAddedAssignmentRow(row: CfsZoneRow): boolean {
    if (!revisionDiffSets) return false;
    const changes = row.isCurtain ? revisionDiffSets.curtainAssignmentFields : revisionDiffSets.assignmentFields;
    return Boolean(row.assignmentIds?.some((id) => hasAddedRevisionRow(changes, id)));
  }

  function hasChangedCircuitField(row: CfsZoneRow, fields?: readonly string[]): boolean {
    if (!revisionDiffSets) return false;
    return row.circuits.some((item) => hasRevisionFields(revisionDiffSets.circuitFields, item.id, fields));
  }

  function hasChangedCfsRowField(row: CfsZoneRow, fields?: readonly string[]): boolean {
    if (!revisionDiffSets) return false;
    return hasRevisionFields(revisionDiffSets.cfsRowFields, row.id, fields);
  }

  function hasChangedBaseCell(row: CfsZoneRow, key: BaseColumnKey): boolean {
    if (!revisionDiffSets) return false;
    if (key !== "number" && hasChangedCfsRowField(row, ["__added"])) return true;
    if (hasAddedAssignmentRow(row)) return key !== "number";
    if (row.circuits.some((item) => hasAddedRevisionRow(revisionDiffSets.circuitFields, item.id))) return key !== "number";
    if (row.isCurtain && hasChangedAssignmentField(row)) return key !== "number";

    switch (key) {
      case "device":
        return hasChangedAssignmentField(row, ["device"]) || hasChangedCfsRowField(row, ["device"]);
      case "deviceNum":
        return hasChangedAssignmentField(row, ["deviceNum"]) || hasChangedCfsRowField(row, ["deviceNum"]);
      case "dimmingType":
        return hasChangedCircuitField(row, ["dimmingType"]) || hasChangedCfsRowField(row, ["control"]);
      case "group":
        return hasChangedAssignmentField(row, ["group"]) || hasChangedCfsRowField(row, ["group"]);
      case "zone":
        return hasChangedAssignmentField(row, ["zoneAddress"]) || hasChangedCfsRowField(row, ["addressZone"]);
      case "designerNumber":
        return hasChangedCircuitField(row, ["designerNumber", "internalNumber"]) || hasChangedAssignmentField(row, ["circuitNumber"]) || hasChangedCfsRowField(row, ["designerNumber"]);
      case "area":
        return hasChangedCircuitField(row, ["area"]) || hasChangedAssignmentField(row, ["area"]) || hasChangedCfsRowField(row, ["area"]);
      case "areaAddress":
        return hasChangedCfsRowField(row, ["areaAddress"]);
      case "detail":
        return (
          hasChangedCircuitField(row, ["detail", "fixture"]) ||
          hasChangedAssignmentField(row, ["detail"]) ||
          (row.inputKind === "CCO" && hasChangedAssignmentField(row, ["circuitNumber"])) ||
          hasChangedCfsRowField(row, ["note", "fixture"])
        );
      case "programmingName":
        return (
          hasChangedCircuitField(row, ["designerNumber", "internalNumber", "area", "detail"]) ||
          hasChangedAssignmentField(row, ["circuitNumber", "detail", "zoneAddress"]) ||
          hasChangedCfsRowField(row, ["designerNumber", "area", "addressZone", "note", "fixture"])
        );
      case "number":
      default:
        return false;
    }
  }

  function hasChangedFunctionCell(row: CfsZoneRow, col: FunctionColumn): boolean {
    if (!revisionDiffSets) return false;
    if (row.circuits.some((item) => hasAddedRevisionRow(revisionDiffSets.circuitFields, item.id))) return true;
    if (hasAddedAssignmentRow(row)) return true;
    if (hasChangedAreaSceneReferenceCell(row, col)) return true;
    const targetIds = rowTargetIds(row).map((target) => target.targetId);
    if (col.roomScene) {
      if (hasAddedRevisionRow(revisionDiffSets.roomSceneFields, col.roomScene.id)) return true;
      return targetIds.some((targetId) => hasRevisionFields(revisionDiffSets.roomSceneTargetFields, col.roomScene!.id, [targetId]));
    }
    if (col.source) {
      if (hasAddedRevisionRow(revisionDiffSets.switchFields, col.source.id)) return true;
      return targetIds.some((targetId) => hasRevisionFields(revisionDiffSets.switchTargetFields, col.source!.id, [targetId]));
    }
    return false;
  }

  function hasChangedAreaSceneReferenceCell(row: CfsZoneRow, col: FunctionColumn): boolean {
    if (!revisionDiffSets || row.isBacklight) return false;
    return rowTargetIds(row).some((target) => {
      if (col.roomScene) {
        if (hasSetting(col.roomScene.settings, target.targetId)) return false;
        const areaSceneId = roomSceneSelectedAreaSceneId(col.roomScene, target.areaId);
        return areaSceneId ? hasRevisionFields(revisionDiffSets.sceneFields, areaSceneId) : false;
      }
      if (col.source) {
        if (hasSetting(col.source.buttonSetting.circuitSettings, target.targetId)) return false;
        return sceneIdsForSwitchTarget(col.source, target.targetId, target.areaId).some((sceneId) =>
          hasRevisionFields(revisionDiffSets.sceneFields, sceneId),
        );
      }
      return false;
    });
  }

  function hasChangedFunctionColumnFields(col: FunctionColumn, fields?: readonly string[]): boolean {
    if (!revisionDiffSets) return false;
    if (col.roomScene) return hasRevisionFields(revisionDiffSets.roomSceneFields, col.roomScene.id, fields);
    if (col.source) return hasRevisionFields(revisionDiffSets.switchFields, col.source.id, fields);
    return false;
  }

  function hasChangedGroupedFunctionFields(
    groupKey: string,
    columnKey: (col: FunctionColumn) => string,
    fields?: readonly string[],
  ): boolean {
    return visibleFunctionColumns
      .filter((col) => columnKey(col) === groupKey)
      .some((col) => hasChangedFunctionColumnFields(col, fields));
  }

  function hasAreaSceneValueCell(row: CfsZoneRow, col: FunctionColumn): boolean {
    if (row.isBacklight) return false;
    if (row.isHvac && row.hvacSettingId) {
      return col.source ? switchUsesAreaSceneValue(col.source, row.hvacSettingId, row.locationId, scenesById) : false;
    }
    if (row.circuits.length === 0) return false;
    if (col.roomScene) {
      return row.circuits.some((item) => roomSceneUsesAreaSceneValue(col.roomScene!, item.circuit, scenesById));
    }
    if (col.source) {
      return row.circuits.some((item) => switchUsesAreaSceneValue(col.source!, item.circuit.id, item.circuit.area, scenesById));
    }
    return false;
  }

  const hasHighlightLegend =
    showIndividualOverrideHighlight ||
    showAreaSceneHighlight ||
    repairedLinkTargetIds.size > 0 ||
    showFfeHighlight ||
    showEnergySavingHighlight ||
    (showInspectionMarkHighlight && inspectionMarkList.length > 0);

  function toggleInspectionMode(): void {
    if (inspectionMode) {
      completeInspectionSession();
      return;
    }
    startInspectionMode();
  }

  function commitProgrammingNameSettings(next: ProgrammingNameSettings): void {
    if (!canEdit || !onProgrammingNameSettingsChange) return;
    onProgrammingNameSettingsChange(normalizeProgrammingNameSettings(next));
  }

  function toggleProgrammingNameToken(token: ProgrammingNameToken): void {
    const tokens = activeProgrammingNameSettings.tokens.includes(token)
      ? activeProgrammingNameSettings.tokens.filter((item) => item !== token)
      : [...activeProgrammingNameSettings.tokens, token];
    commitProgrammingNameSettings({
      ...activeProgrammingNameSettings,
      tokens,
    });
  }

  function moveProgrammingNameToken(token: ProgrammingNameToken, offset: number): void {
    const tokens = [...activeProgrammingNameSettings.tokens];
    const index = tokens.indexOf(token);
    if (index < 0) return;
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= tokens.length) return;
    const [moved] = tokens.splice(index, 1);
    tokens.splice(nextIndex, 0, moved);
    commitProgrammingNameSettings({ ...activeProgrammingNameSettings, tokens });
  }

  function updateProgrammingNameSetting<K extends keyof ProgrammingNameSettings>(
    key: K,
    value: ProgrammingNameSettings[K],
  ): void {
    commitProgrammingNameSettings({ ...activeProgrammingNameSettings, [key]: value });
  }

  const orderedProgrammingNameTokenOptions = [
    ...activeProgrammingNameSettings.tokens
      .map((token) => PROGRAMMING_NAME_TOKEN_OPTIONS.find((option) => option.id === token))
      .filter((option): option is (typeof PROGRAMMING_NAME_TOKEN_OPTIONS)[number] => Boolean(option)),
    ...PROGRAMMING_NAME_TOKEN_OPTIONS.filter((option) => !activeProgrammingNameSettings.tokens.includes(option.id)),
  ];

  return (
    <section className={`card card-padded fade-in cfs-matrix-card${isMaximized ? " is-maximized" : ""}${inspectionMode ? " is-inspection-mode" : ""}`}>
      <div className="cfs-matrix-toolbar">
        <div className="cfs-matrix-primary-row">
          <div className="cfs-matrix-controls">
          <CfsFilterMenu
            label="Rows"
            toolbarOrder={0}
            wide
            panelMinWidth={360}
            panelMaxHeight={520}
            highlighted={Boolean(revisionDiff?.cfsRowDisplayChanged)}
          >
            <div className="cfs-column-actions">
              <button type="button" onClick={() => setAllCfsRowKindsVisible(true)} disabled={!canChangeCfsRows}>
                Show all
              </button>
              <button type="button" onClick={() => setAllCfsRowKindsVisible(false)} disabled={!canChangeCfsRows}>
                Hide all
              </button>
            </div>
            <div className="cfs-column-options cfs-base-column-options">
              {orderedCfsRowKinds.map((kind, rowIndex) => {
                const option = CFS_ROW_DISPLAY_OPTIONS.find((item) => item.id === kind);
                const label = option?.label ?? kind;
                return (
                  <div
                    key={kind}
                    className="cfs-base-column-row cfs-draggable-column"
                    draggable={canChangeCfsRows}
                    onDragStart={(event) => event.dataTransfer.setData("text/plain", kind)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      moveCfsRowKind(event.dataTransfer.getData("text/plain"), kind);
                    }}
                    title="Drag to reorder"
                  >
                    <span className="drag-handle" aria-hidden="true">::</span>
                    <input
                      type="checkbox"
                      aria-label={`Show ${label} rows`}
                      checked={!hiddenCfsRowKindSet.has(kind)}
                      disabled={!canChangeCfsRows}
                      onChange={() => toggleCfsRowKind(kind)}
                    />
                    <span className="cfs-base-column-label">{label}</span>
                    <button
                      type="button"
                      className="cfs-function-group-move"
                      disabled={!canChangeCfsRows || rowIndex === 0}
                      aria-label={`Move ${label} row up`}
                      title="Move up"
                      onClick={() => moveCfsRowKindByOffset(kind, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="cfs-function-group-move"
                      disabled={!canChangeCfsRows || rowIndex === orderedCfsRowKinds.length - 1}
                      aria-label={`Move ${label} row down`}
                      title="Move down"
                      onClick={() => moveCfsRowKindByOffset(kind, 1)}
                    >
                      ↓
                    </button>
                  </div>
                );
              })}
            </div>
          </CfsFilterMenu>
          <CfsFilterMenu label="Areas" displayLabel="Area" toolbarOrder={4}>
            <div className="cfs-column-actions">
              <button type="button" onClick={() => setSelectedAreaIds(new Set())}>Show all</button>
              <button type="button" onClick={() => setSelectedAreaIds(new Set(["__none__"]))}>Hide all</button>
            </div>
            {availableAreaFilters.map((area) => (
              <label key={area.id} className="cfs-check">
                <input
                  type="checkbox"
                  checked={selectedAreaIds.size === 0 || selectedAreaIds.has(area.id)}
                  onChange={() => {
                    setSelectedAreaIds((prev) => {
                      const next = new Set(prev);
                      if (next.size === 0) {
                        availableAreaFilters.forEach((item) => next.add(item.id));
                      }
                      if (next.has(area.id)) next.delete(area.id);
                      else next.add(area.id);
                      return next.size === availableAreaFilters.length ? new Set() : next;
                    });
                  }}
                />
                {area.name}
              </label>
            ))}
          </CfsFilterMenu>
          <CfsFilterMenu label="Devices" displayLabel="Device" toolbarOrder={3}>
            <div className="cfs-column-actions">
              <button type="button" onClick={() => setHiddenDeviceKeys(new Set())}>Show all</button>
              <button type="button" onClick={() => setHiddenDeviceKeys(new Set(availableDeviceFilters.map((device) => device.id)))}>
                Hide all
              </button>
              <button
                type="button"
                aria-pressed={showCciRows}
                onClick={() => setShowCciRows((prev) => !prev)}
              >
                {showCciRows ? "Hide CCI" : "Show CCI"}
              </button>
            </div>
            {availableDeviceFilters.map((device) => (
              <label key={device.id} className="cfs-check">
                <input
                  type="checkbox"
                  checked={!hiddenDeviceKeys.has(device.id)}
                  onChange={() => {
                    setHiddenDeviceKeys((prev) => {
                      const next = new Set(prev);
                      if (next.has(device.id)) next.delete(device.id);
                      else next.add(device.id);
                      return next;
                    });
                  }}
                />
                {device.label}
              </label>
            ))}
          </CfsFilterMenu>
          <CfsFilterMenu label="Base Columns" displayLabel="Base" toolbarOrder={1} wide panelMinWidth={360} panelMaxHeight={720}>
            <CfsBaseColumnMenu
              columns={orderedBaseColumns}
              hiddenColumns={hiddenBaseColumns}
              getColumnLabel={baseColumnLabel}
              onShowAll={() => setHiddenBaseColumns(new Set())}
              onHideAll={() => setHiddenBaseColumns(new Set(BASE_COLUMNS.map((column) => column.key)))}
              onToggleColumn={toggleBaseColumn}
              onMoveColumn={moveBaseColumn}
              onMoveColumnByOffset={moveBaseColumnByOffset}
            />
          </CfsFilterMenu>
          <CfsFilterMenu label="Programming Name" toolbarOrder={6} wide panelMinWidth={680} panelMaxHeight={720}>
            <div className="cfs-programming-settings">
              <div className="cfs-menu-section">
                <div className="cfs-menu-title">Combination</div>
                <div className="cfs-programming-token-list">
                  {orderedProgrammingNameTokenOptions.map((option) => {
                    const active = activeProgrammingNameSettings.tokens.includes(option.id);
                    const tokenIndex = activeProgrammingNameSettings.tokens.indexOf(option.id);
                    return (
                      <div key={option.id} className={`cfs-programming-token-row${active ? "" : " is-muted"}`}>
                        <span className="cfs-programming-token-position" aria-label={active ? `Order ${tokenIndex + 1}` : "Not used"}>
                          {active ? tokenIndex + 1 : "-"}
                        </span>
                        <label className="cfs-check">
                          <input
                            type="checkbox"
                            checked={active}
                            disabled={!canEdit || !onProgrammingNameSettingsChange}
                            onChange={() => toggleProgrammingNameToken(option.id)}
                          />
                          {option.label}
                        </label>
                        <div className="cfs-programming-token-actions">
                          <button
                            type="button"
                            className="cfs-function-group-move"
                            disabled={!canEdit || !onProgrammingNameSettingsChange || !active || tokenIndex <= 0}
                            title="Move up"
                            onClick={() => moveProgrammingNameToken(option.id, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="cfs-function-group-move"
                            disabled={
                              !canEdit ||
                              !onProgrammingNameSettingsChange ||
                              !active ||
                              tokenIndex < 0 ||
                              tokenIndex >= activeProgrammingNameSettings.tokens.length - 1
                            }
                            title="Move down"
                            onClick={() => moveProgrammingNameToken(option.id, 1)}
                          >
                            ↓
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="cfs-programming-setting-grid">
                <label className="cfs-programming-field">
                  <span>Bracket</span>
                  <select
                    value={activeProgrammingNameSettings.bracketStyle}
                    disabled={!canEdit || !onProgrammingNameSettingsChange}
                    onChange={(event) =>
                      updateProgrammingNameSetting(
                        "bracketStyle",
                        event.target.value as ProgrammingNameSettings["bracketStyle"],
                      )
                    }
                  >
                    {PROGRAMMING_NAME_BRACKET_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="cfs-programming-field">
                  <span>Token separator</span>
                  <select
                    value={activeProgrammingNameSettings.tokenSeparator}
                    disabled={!canEdit || !onProgrammingNameSettingsChange}
                    onChange={(event) => updateProgrammingNameSetting("tokenSeparator", event.target.value)}
                  >
                    {PROGRAMMING_NAME_SEPARATOR_OPTIONS.map((option) => (
                      <option key={option.label} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="cfs-programming-field">
                  <span>Detail separator</span>
                  <select
                    value={activeProgrammingNameSettings.detailSeparator}
                    disabled={!canEdit || !onProgrammingNameSettingsChange}
                    onChange={(event) => updateProgrammingNameSetting("detailSeparator", event.target.value)}
                  >
                    {PROGRAMMING_NAME_SEPARATOR_OPTIONS.map((option) => (
                      <option key={option.label} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="cfs-programming-field cfs-programming-custom-separator">
                  <span>Custom detail separator</span>
                  <input
                    value={activeProgrammingNameSettings.detailSeparator}
                    maxLength={8}
                    disabled={!canEdit || !onProgrammingNameSettingsChange}
                    onChange={(event) => updateProgrammingNameSetting("detailSeparator", event.target.value)}
                  />
                </label>
              </div>
              <div className="cfs-programming-preview" aria-label="Programming name preview">
                <span>Preview</span>
                <strong>{programmingNamePreview()}</strong>
              </div>
            </div>
          </CfsFilterMenu>
          <CfsFilterMenu
            label="Function Columns"
            displayLabel="Function"
            toolbarOrder={2}
            wide
            panelMinWidth={620}
            panelMaxHeight={680}
            onOpen={collapseAllFunctionColumnGroups}
          >
            <div className="cfs-column-actions">
              <button type="button" onClick={() => setHiddenFunctionColumns(new Set())}>Show all</button>
              <button
                type="button"
                onClick={() => setHiddenFunctionColumns(new Set(orderedFunctionColumns.map((col) => col.id)))}
              >
                Hide all
              </button>
            </div>
            <div className="cfs-column-options cfs-function-group-list">
              {orderedFunctionColumnGroups.map((group, groupIndex) => {
                const visibleCount = group.columns.filter((col) => !hiddenFunctionColumns.has(col.id)).length;
                const allVisible = visibleCount === group.columns.length;
                const isCollapsed = collapsedFunctionColumnGroupKeys.has(group.key);
                return (
                  <div
                    key={group.key}
                    className={`cfs-function-group-panel cfs-switch-kind-${group.kind}`}
                    data-function-group-key={group.key}
                    onMouseEnter={() => handleFunctionColumnGroupMouseEnter(group.key)}
                  >
                    <div
                      className="cfs-function-group-header"
                      onMouseDown={(event) => handleFunctionColumnGroupMouseDown(event, group.key)}
                      onMouseMove={(event) => handleFunctionColumnGroupMouseMove(event, group.key)}
                      onPointerDown={(event) => handleFunctionColumnGroupPointerDown(event, group.key)}
                      title="Drag to reorder"
                    >
                      <span
                        className="drag-handle cfs-function-group-drag"
                        aria-hidden="true"
                        onMouseDown={(event) => handleFunctionColumnGroupMouseDown(event, group.key)}
                        onMouseMove={(event) => handleFunctionColumnGroupMouseMove(event, group.key)}
                        onPointerDown={(event) => handleFunctionColumnGroupPointerDown(event, group.key)}
                      >
                        ::
                      </span>
                      <input
                        type="checkbox"
                        aria-label={`${group.label} visible`}
                        checked={allVisible}
                        onChange={() => toggleFunctionColumnGroup(group)}
                      />
                      <button
                        type="button"
                        className="cfs-function-group-toggle"
                        aria-expanded={!isCollapsed}
                        onClick={() => toggleFunctionColumnGroupCollapsed(group.key)}
                      >
                        {isCollapsed ? "+" : "-"}
                      </button>
                      <span className="cfs-function-group-label">{group.label}</span>
                      <button
                        type="button"
                        className="cfs-function-group-move"
                        disabled={groupIndex === 0}
                        title="Move up"
                        onClick={() => moveFunctionColumnGroupByOffset(group.key, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="cfs-function-group-move"
                        disabled={groupIndex === orderedFunctionColumnGroups.length - 1}
                        title="Move down"
                        onClick={() => moveFunctionColumnGroupByOffset(group.key, 1)}
                      >
                        ↓
                      </button>
                      <span className="cfs-function-group-count">
                        {visibleCount}/{group.columns.length}
                      </span>
                    </div>
                    {!isCollapsed ? (
                      <div className="cfs-function-group-children">
                        {group.columns.map((col) => (
                          <label key={col.id} className="cfs-check cfs-function-group-child">
                            <input
                              type="checkbox"
                              checked={!hiddenFunctionColumns.has(col.id)}
                              onChange={() => toggleFunctionColumn(col.id)}
                            />
                            {functionColumnDetailLabel(col)}
                          </label>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </CfsFilterMenu>
          <CfsFilterMenu label="Display" toolbarOrder={5} wide panelMinWidth={520}>
          <div className="cfs-menu-section">
            <div className="cfs-menu-title">Sort</div>
            <div className="cfs-segmented cfs-menu-segmented" aria-label="CFS sort mode">
              <button
                type="button"
                className={sortMode === "device" ? "is-active" : ""}
                onClick={() => setSortMode("device")}
              >
                Device
              </button>
              <button
                type="button"
                className={sortMode === "area" ? "is-active" : ""}
                onClick={() => setSortMode("area")}
              >
                Area
              </button>
              <button
                type="button"
                className={sortMode === "internal" ? "is-active" : ""}
                onClick={() => setSortMode("internal")}
              >
                Internal#
              </button>
              <button
                type="button"
                className={sortMode === "programmingName" ? "is-active" : ""}
                onClick={() => setSortMode("programmingName")}
              >
                Programming Name
              </button>
            </div>
          </div>
          <div className="cfs-menu-section">
            <div className="cfs-menu-title">Number Display</div>
            <div className="cfs-segmented cfs-menu-segmented" aria-label="Number display">
              <button
                type="button"
                className={numberMode === "designer" ? "is-active" : ""}
                onClick={() => setNumberMode("designer")}
              >
                Designer#
              </button>
              <button
                type="button"
                className={numberMode === "internal" ? "is-active" : ""}
                onClick={() => setNumberMode("internal")}
              >
                Internal#
              </button>
            </div>
          </div>
          <label className="cfs-check">
            <input
              type="checkbox"
              checked={hideReservedRows}
              onChange={(e) => setHideReservedRows(e.target.checked)}
            />
            Hide Reserved
          </label>
          <label className="cfs-check">
            <input
              type="checkbox"
              checked={showAreaSceneNames}
              onChange={(e) => setShowAreaSceneNames(e.target.checked)}
            />
            Area Scene Name
            </label>
          </CfsFilterMenu>
          <CfsFilterMenu label="Highlights" toolbarOrder={7} wide>
            <label className="cfs-check">
              <input
                type="checkbox"
                checked={showAreaColorHighlight}
                onChange={(e) => setShowAreaColorHighlight(e.target.checked)}
              />
              <span className="cfs-highlight-swatch cfs-highlight-swatch-area-color" aria-hidden="true" />
              Area Auto Color
            </label>
            <label className="cfs-check">
              <input
                type="checkbox"
                checked={showIndividualOverrideHighlight}
                onChange={(e) => setShowIndividualOverrideHighlight(e.target.checked)}
              />
              <span className="cfs-highlight-swatch cfs-highlight-swatch-override" aria-hidden="true" />
              Individual Override
            </label>
            <label className="cfs-check">
              <input
                type="checkbox"
                checked={showAreaSceneHighlight}
                onChange={(e) => setShowAreaSceneHighlight(e.target.checked)}
              />
              <span className="cfs-highlight-swatch cfs-highlight-swatch-area-scene" aria-hidden="true" />
              Area Scene Value
            </label>
            <label className="cfs-check">
              <input
                type="checkbox"
                checked={showInspectionMarkHighlight}
                onChange={(e) => setShowInspectionMarkHighlight(e.target.checked)}
                disabled={inspectionMarkList.length === 0}
              />
              <span className="cfs-highlight-swatch cfs-highlight-swatch-inspection" aria-hidden="true" />
              Inspection Marks
            </label>
            <label className="cfs-check">
              <input
                type="checkbox"
                checked={showFfeHighlight}
                onChange={(e) => setShowFfeHighlight(e.target.checked)}
              />
              <span className="cfs-highlight-swatch cfs-highlight-swatch-ffe" aria-hidden="true" />
              FFE
            </label>
            <label className="cfs-check">
              <input
                type="checkbox"
                checked={showEnergySavingHighlight}
                onChange={(e) => setShowEnergySavingHighlight(e.target.checked)}
              />
              <span className="cfs-highlight-swatch cfs-highlight-swatch-energy" aria-hidden="true" />
              Energy Saving
            </label>
            <label className="cfs-check">
              <input
                type="checkbox"
                checked={showBacklightColorHighlight}
                onChange={(e) => setShowBacklightColorHighlight(e.target.checked)}
              />
              <span className="cfs-highlight-swatch cfs-highlight-swatch-backlight" aria-hidden="true" />
              Backlight Logic Color
            </label>
          </CfsFilterMenu>
          </div>
          <div className="cfs-matrix-actions">
            <button
              type="button"
              className={`btn btn-secondary cfs-inspection-toggle${inspectionMode ? " is-active" : ""}`}
              onClick={toggleInspectionMode}
              disabled={!canEdit}
              title="Edit CFS values and synchronize Scene/Switch settings"
            >
              InspectionMode
            </button>
            {showLinkMapControls ? (
              <button
                type="button"
                className="btn btn-secondary cfs-link-map-trigger"
                onClick={() => setShowLinkMap(true)}
                title="Open CFS linkage map and diagnostics"
              >
                Link Map
              </button>
            ) : null}
            {onOpenExternalWindow ? (
              <button
                type="button"
                className="btn btn-secondary cfs-sub-window-trigger"
                onClick={onOpenExternalWindow}
                title="Open a read-only linked CFS view in a separate window"
              >
                Sub Window
              </button>
            ) : null}
            {onOpenPinnedWindow ? (
              <button
                type="button"
                className="btn btn-secondary cfs-pinned-window-trigger"
                onClick={onOpenPinnedWindow}
                title="Open a read-only CFS view fixed to one room type (switchable inside the window)"
              >
                Fixed Window
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                void exportVisibleCfsToExcel().catch((error) => {
                  console.error("CFS visible export failed", error);
                  window.alert("Excel export failed. Please try again.");
                });
              }}
            >
              Excel Export
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setIsMaximized((prev) => !prev)}>
              {isMaximized ? "Exit Maximize" : "Maximize"}
            </button>
          </div>
        </div>
        {inspectionMode ? (
          <div className="cfs-inspection-draft-bar" aria-label="Inspection draft controls">
            <div className="cfs-inspection-scope-toggle" role="group" aria-label="Inspection edit scope">
              <button
                type="button"
                className={inspectionEditScope === "areaScene" ? "is-active" : ""}
                onClick={() => setInspectionEditScope("areaScene")}
                title="Linked mode: edit the Area Scene value used by linked cells"
              >
                Linked
              </button>
              <button
                type="button"
                className={inspectionEditScope === "override" ? "is-active" : ""}
                onClick={() => setInspectionEditScope("override")}
                title="Unlink mode: write the selected CFS cell as an override"
              >
                Unlink
              </button>
            </div>
            <span className="cfs-inspection-draft-count">{inspectionDraftList.length} draft</span>
            <span className="cfs-inspection-mark-count">{inspectionMarkList.length} mark</span>
            <div className="cfs-inspection-selection-tools" role="group" aria-label="Inspection selection tools">
              <button
                type="button"
                className={`btn btn-secondary${inspectionSelectionPhase !== "off" ? " is-active" : ""}`}
                aria-pressed={inspectionSelectionPhase !== "off"}
                onClick={() => {
                  if (inspectionSelectionPhase === "off") {
                    setInspectionSelectionPhase("selecting");
                    setInspectionSelectionStart(null);
                    setInspectionSelectionEnd(null);
                    setInspectionPasteTarget(null);
                    setInspectionPopover(null);
                    return;
                  }
                  if (inspectionSelectionPhase === "copied") {
                    setInspectionSelectionPhase("selecting");
                    setInspectionSelectionStart(null);
                    setInspectionSelectionEnd(null);
                    setInspectionPasteTarget(null);
                    setInspectionPopover(null);
                    return;
                  }
                  resetInspectionSelection({ keepClipboard: true });
                }}
                title="Select a cell. Select another cell to make a range."
              >
                {inspectionSelectionPhase === "copied" ? "Target" : inspectionSelectionPhase === "selecting" ? "Selecting" : "Select"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!selectionCopyEnabled()}
                onClick={copyInspectionSelection}
                title="Copy the selected InspectionMode cell or range"
              >
                Copy
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!inspectionClipboard || !inspectionPasteTarget}
                onClick={pasteInspectionSelection}
                title="Paste the copied range starting at the selected target cell"
              >
                Paste
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!inspectionSelectionStart && !inspectionClipboard}
                onClick={() => resetInspectionSelection()}
                title="Clear the current selection and copied range"
              >
                Clear
              </button>
            </div>
            {selectedInspectionCellCount > 0 || inspectionClipboard ? (
              <span className="cfs-inspection-selection-status" aria-live="polite">
                {inspectionClipboard
                  ? `${inspectionClipboard.width}x${inspectionClipboard.height} copied`
                  : `${selectedInspectionCellCount} selected`}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={cancelInspectionSession}
              title="Revert the whole InspectionMode session to the values from before it started"
            >
              Revert
            </button>
          </div>
        ) : null}
          {hasHighlightLegend ? (
            <div className="cfs-highlight-legend" aria-label="Active highlight legend">
              {showIndividualOverrideHighlight ? (
                <span className="cfs-highlight-legend-chip">
                  <span className="cfs-highlight-swatch cfs-highlight-swatch-override" aria-hidden="true" />
                  Individual Override
                </span>
              ) : null}
              {showAreaSceneHighlight ? (
                <span className="cfs-highlight-legend-chip">
                  <span className="cfs-highlight-swatch cfs-highlight-swatch-area-scene" aria-hidden="true" />
                  Area Scene Value
                </span>
              ) : null}
              {repairedLinkTargetIds.size > 0 ? (
                <span className="cfs-highlight-legend-chip">
                  <span className="cfs-highlight-swatch cfs-highlight-swatch-repaired" aria-hidden="true" />
                  Repaired Links
                </span>
              ) : null}
              {showFfeHighlight ? (
                <span className="cfs-highlight-legend-chip">
                  <span className="cfs-highlight-swatch cfs-highlight-swatch-ffe" aria-hidden="true" />
                  FFE
                </span>
              ) : null}
              {showEnergySavingHighlight ? (
                <span className="cfs-highlight-legend-chip">
                  <span className="cfs-highlight-swatch cfs-highlight-swatch-energy" aria-hidden="true" />
                  Energy Saving
                </span>
              ) : null}
              {showInspectionMarkHighlight && inspectionMarkList.length > 0 ? (
                <span className="cfs-highlight-legend-chip">
                  <span className="cfs-highlight-swatch cfs-highlight-swatch-inspection" aria-hidden="true" />
                  Inspection Mark
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

      {showLinkMapControls && linkIssueRows.length > 0 ? (
        <section className="cfs-link-issue-list" aria-label="CFS link issue list">
          <div className="cfs-link-issue-list-head">
            <div>
              <span className="cfs-link-issue-kicker">Link Issues</span>
              <h3>リンク診断リスト</h3>
              <p>
                赤く表示されているタブ・セルの理由です。場所、対象、対応目安を確認してください。
              </p>
            </div>
            <div className="cfs-link-issue-summary-actions">
              <span className="cfs-link-issue-count">
                {linkGraph.summary.errors} error / {linkGraph.summary.warnings} warning
              </span>
              {showLinkMapControls ? (
                <button type="button" className="btn btn-secondary" onClick={() => setShowLinkMap(true)}>
                  Open Link Map
                </button>
              ) : null}
            </div>
          </div>
          <ol className="cfs-link-issue-items">
            {linkIssueRows.map((issue, index) => (
              <li key={issue.id} className={`cfs-link-issue-item cfs-link-issue-item-${issue.severity}`}>
                <div className="cfs-link-issue-number">{index + 1}</div>
                <div className="cfs-link-issue-main">
                  <div className="cfs-link-issue-title-row">
                    <span className={`cfs-link-issue-badge cfs-link-issue-badge-${issue.severity}`}>
                      {issue.severity === "error" ? "Error" : "Warning"}
                    </span>
                    <strong>{issue.title}</strong>
                  </div>
                  <small>{issue.originalTitle}</small>
                  <p>{issue.detail}</p>
                </div>
                <div className="cfs-link-issue-meta">
                  <div>
                    <span>場所</span>
                    <code>{issue.group} / {issue.source}</code>
                  </div>
                  <div>
                    <span>対象</span>
                    <code>{issue.target}</code>
                  </div>
                  <div>
                    <span>対応目安</span>
                    <em>{issue.action}</em>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {showLinkMap && showLinkMapControls ? (
        <CfsLinkMapPanel
          graph={linkGraph}
          roomTypeName={roomType.name}
          staleHvacRepairPlan={staleHvacRepairPlan}
          lastHvacRepairSummary={lastHvacRepairSummary}
          onRepairStaleHvacLinks={handleRepairStaleHvacLinks}
          onClose={() => setShowLinkMap(false)}
        />
      ) : null}

      {hiddenFunctionColumnList.length > 0 ? (
        <div className="cfs-hidden-column-strip" aria-label="Hidden CFS columns">
          <div className="cfs-hidden-column-group">
            <span className="cfs-hidden-column-label">Function</span>
            {hiddenFunctionColumnList.map((col) => (
              <button
                key={col.id}
                type="button"
                className="cfs-hidden-column-button"
                title={`Show ${functionColumnLabel(col)}`}
                onClick={() => toggleFunctionColumn(col.id)}
              >
                + {functionColumnLabel(col)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="matrix-scroll cfs-matrix-scroll" ref={cfsMatrixScrollRef}>
        <table ref={tableRef} className="matrix-table cfs-matrix-table">
          <colgroup>
            {visibleBaseColumns.map((col) => (
              <col key={col.key} style={{ width: col.minWidth }} />
            ))}
            {visibleFunctionColumns.map((col) => (
              <col key={col.id} style={{ width: CFS_FUNCTION_COLUMN_WIDTH }} />
            ))}
            <col className="cfs-scroll-end-inline-col" style={{ width: cfsScrollEndSpace.inline }} />
          </colgroup>
          <thead>
            <tr>
              {visibleBaseColumns.map((col) => (
                <th
                  key={col.key}
                  className={`cfs-sticky-base cfs-base-head cfs-base-${col.key}`}
                  style={{ minWidth: col.minWidth, width: col.minWidth, left: stickyOffsets.get(col.key) ?? 0 }}
                  rowSpan={4}
                >
                  <div className="cfs-base-head-content">
                    <button
                      type="button"
                      className="cfs-base-head-hide-button"
                      aria-label={`Hide ${baseColumnLabel(col)}`}
                      title={`Hide ${baseColumnLabel(col)}`}
                      onClick={() => toggleBaseColumn(col.key)}
                    >
                      -
                    </button>
                    <span>{baseColumnLabel(col)}</span>
                  </div>
                </th>
              ))}
              {switchHeaderGroups.map((group, index) => (
                <th
                  key={`${group.key}-${index}`}
                  className={`cfs-function-head cfs-switch-head cfs-switch-group-start cfs-switch-kind-${group.kind}${
                    hasChangedGroupedFunctionFields(group.key, (col) => col.switchGroupKey, [
                      "switchNumber",
                      "switchName",
                      "phase",
                      "sceneType",
                      "detail",
                    ])
                      ? " revision-changed-cell"
                      : ""
                  }`}
                  colSpan={group.colSpan}
                >
                  <div>{group.switchNumber}</div>
                  {group.switchName ? <strong>{group.switchName}</strong> : null}
                </th>
              ))}
              <th className="cfs-scroll-end-inline-cell" aria-hidden="true" />
            </tr>
            <tr>
              {buttonHeaderGroups.map((group, index) => (
                <th
                  key={`${group.key}-${index}`}
                  className={`cfs-function-head cfs-button-head${group.startsSwitchGroup ? " cfs-switch-group-start" : ""}${
                    group.cols.some((col) =>
                      hasChangedFunctionColumnFields(col, ["buttonLabel", "allocation", "buttonCount", "phase"]),
                    )
                      ? " revision-changed-cell"
                      : ""
                  }`}
                  colSpan={group.colSpan}
                >
                  {group.kind === "pir" && group.pirLabels ? (
                    <PirHeaderText
                      labels={group.pirLabels}
                      expanded={expandedPirHeaderKeys.has(group.key)}
                      onToggle={() =>
                        setExpandedPirHeaderKeys((prev) => {
                          const next = new Set(prev);
                          if (next.has(group.key)) next.delete(group.key);
                          else next.add(group.key);
                          return next;
                        })
                      }
                    />
                  ) : (
                    <HeaderSplitText value={group.button} />
                  )}
                </th>
              ))}
              <th className="cfs-scroll-end-inline-cell" aria-hidden="true" />
            </tr>
            <tr>
              {functionNameHeaderGroups.map((group, index) => (
                <th
                  key={`${group.key}-${index}`}
                  className={`cfs-function-head cfs-function-name-head${group.startsSwitchGroup ? " cfs-switch-group-start" : ""}${
                    group.cols.some((col) =>
                      hasChangedFunctionColumnFields(col, ["buttonFunction", "kind", "sceneType", "detail"]),
                    )
                      ? " revision-changed-cell"
                      : ""
                  }`}
                  colSpan={group.colSpan}
                >
                  <HeaderSplitText value={group.functionName || "-"} />
                </th>
              ))}
              <th className="cfs-scroll-end-inline-cell" aria-hidden="true" />
            </tr>
            <tr>
              {conditionHeaderGroups.map((group, index) => {
                const isPriority = group.cols.some(isPriorityTriggerColumn);
                return (
                  <th
                    key={`${group.key}-${index}`}
                    colSpan={group.colSpan}
                    className={`cfs-function-head cfs-condition-head${group.startsSwitchGroup ? " cfs-switch-group-start" : ""}${
                      isPriority ? " cfs-priority-trigger-cell" : ""
                    }${
                      group.cols.some(hasLinkIssueFunctionColumn) ? " cfs-link-error-cell" : ""
                    }${
                      group.cols.some((col) =>
                        hasChangedFunctionColumnFields(col, ["condition", "isPriorityFunction", "triggerCondition"]),
                      )
                        ? " revision-changed-cell"
                        : ""
                    }`}
                    title={isPriority ? "Priority function trigger" : undefined}
                  >
                    <HeaderSplitText value={group.condition || "-"} />
                  </th>
                );
              })}
              <th className="cfs-scroll-end-inline-cell" aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {displayedRows.length === 0 ? (
              <tr>
                <td className="screen-empty" colSpan={visibleBaseColumns.length + visibleFunctionColumns.length + 1}>
                  Enter Circuit and Device Assign data to generate the CFS matrix.
                </td>
              </tr>
            ) : (
              <>
                {displayedRows.map((row, index) => {
                  // Area Auto Color paints only the boundaries of contiguous
                  // area blocks in DISPLAY order (so sorting/filtering keeps
                  // the rule visually consistent): the top edge where the
                  // previous displayed row belongs to a different area, and
                  // the bottom edge where the next one does. A single-row
                  // block gets both edges.
                  const previousDisplayedRow = index > 0 ? displayedRows[index - 1] : null;
                  const nextDisplayedRow = index < displayedRows.length - 1 ? displayedRows[index + 1] : null;
                  const areaTopColor =
                    row.locationColor && (!previousDisplayedRow || previousDisplayedRow.locationId !== row.locationId)
                      ? row.locationColor
                      : "transparent";
                  const areaBottomColor =
                    row.locationColor && (!nextDisplayedRow || nextDisplayedRow.locationId !== row.locationId)
                      ? row.locationColor
                      : "transparent";
                  // A rowSpan-merged cell belongs to the merge group's first
                  // row, but its bottom edge sits at the last covered row.
                  // Override the bottom stripe variable per merged cell so the
                  // area boundary reaches the left merged columns too.
                  const mergedBottomStyle = (rowSpan: number): Record<string, string> | undefined => {
                    const lastIndex = Math.min(index + Math.max(rowSpan, 1) - 1, displayedRows.length - 1);
                    if (lastIndex === index) return undefined;
                    const lastRow = displayedRows[lastIndex];
                    const afterLast = lastIndex + 1 < displayedRows.length ? displayedRows[lastIndex + 1] : null;
                    const color =
                      lastRow.locationColor && (!afterLast || afterLast.locationId !== lastRow.locationId)
                        ? lastRow.locationColor
                        : "transparent";
                    return { ["--row-area-bottom-color"]: color };
                  };
                  return (
                  <tr
                    key={row.id}
                    className={[
                      "cfs-fixture-row",
                      isReservedCfsRow(row) ? "cfs-reserved-row" : "",
                      row.isHvac ? "cfs-hvac-row" : "",
                      row.isCurtain ? "cfs-curtain-row" : "",
                      row.isBacklight ? "cfs-backlight-row" : "",
                      showAreaColorHighlight && row.locationColor ? "cfs-area-color-row" : "",
                      showFfeHighlight && row.circuits.some((item) => item.circuit.ffe) ? "cfs-ffe-row" : "",
                      showEnergySavingHighlight && row.circuits.some((item) => item.circuit.energySaving) ? "cfs-energy-row" : "",
                      hasLinkIssueTargetRow(row) ? "cfs-link-error-row" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={
                      row.locationColor
                        ? {
                            ["--row-location-color" as string]: row.locationColor,
                            ["--row-area-top-color" as string]: areaTopColor,
                            ["--row-area-bottom-color" as string]: areaBottomColor,
                          }
                        : undefined
                    }
                  >
                    {visibleBaseColumns.map((col, colIndex) => {
                    const isChangedBaseCell = hasChangedBaseCell(row, col.key);
                      if (col.key === "number") {
                        return (
                          <td
                            key={col.key}
                            className="cfs-sticky-base col-center cfs-no-col"
                            style={{ left: stickyOffsets.get(col.key) ?? 0 }}
                          >
                            {index + 1}
                          </td>
                        );
                      }
                      if (row.isBacklight && BACKLIGHT_LOGIC_MERGE_KEYS.includes(col.key)) {
                        const mergeInfo = backlightMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
                        if (!mergeInfo.isFirst) return null;
                        const visibleBacklightKeys = BACKLIGHT_LOGIC_MERGE_KEYS.filter((key) =>
                          visibleBaseColumns.some((visibleCol) => visibleCol.key === key),
                        );
                        if (col.key !== visibleBacklightKeys[0]) return null;
                        const width = visibleBaseColumns
                          .filter((visibleCol) => BACKLIGHT_LOGIC_MERGE_KEYS.includes(visibleCol.key))
                          .reduce((sum, visibleCol) => sum + visibleCol.minWidth, 0);
                        return (
                          <td
                            key={col.key}
                            className={`cfs-sticky-base cfs-merged-cell cfs-base-${col.key}${
                              isChangedBaseCell ? " revision-changed-cell" : ""
                            }`}
                            style={{ minWidth: width, width, left: stickyOffsets.get(col.key) ?? 0, ...mergedBottomStyle(mergeInfo.rowSpan) }}
                            colSpan={visibleBacklightKeys.length}
                            rowSpan={mergeInfo.rowSpan}
                          >
                            Backlight Logic
                          </td>
                        );
                      }
                      if (col.key === "device" || col.key === "deviceNum") {
                        const info = deviceMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
                        if (!info.isFirst) return null;
                        return (
                          <td
                            key={col.key}
                            className={`cfs-sticky-base cfs-merged-cell cfs-base-${col.key}${
                              isChangedBaseCell ? " revision-changed-cell" : ""
                            }`}
                            style={{ left: stickyOffsets.get(col.key) ?? 0, ...mergedBottomStyle(info.rowSpan) }}
                            rowSpan={info.rowSpan}
                          >
                            {renderStack(baseValues(row, col.key))}
                          </td>
                        );
                      }
                      if (col.key === "dimmingType") {
                        const info = dimmingMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
                        if (!info.isFirst) return null;
                        return (
                          <td
                            key={col.key}
                            className={`cfs-sticky-base cfs-merged-cell cfs-base-${col.key}${
                              isChangedBaseCell ? " revision-changed-cell" : ""
                            }`}
                            style={{ left: stickyOffsets.get(col.key) ?? 0, ...mergedBottomStyle(info.rowSpan) }}
                            rowSpan={info.rowSpan}
                          >
                            {renderStack(baseValues(row, col.key))}
                          </td>
                        );
                      }
                      if (col.key === "designerNumber") {
                        const info = designerMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
                        if (!info.isFirst) return null;
                        return (
                          <td
                            key={col.key}
                            className={`cfs-sticky-base cfs-merged-cell cfs-base-${col.key}${
                              isChangedBaseCell ? " revision-changed-cell" : ""
                            }`}
                            style={{ left: stickyOffsets.get(col.key) ?? 0, ...mergedBottomStyle(info.rowSpan) }}
                            rowSpan={info.rowSpan}
                          >
                            {renderStack(baseValues(row, col.key))}
                          </td>
                        );
                      }
                      if (col.key === "group" && !row.isDali && visibleBaseColumns[colIndex + 1]?.key === "zone") {
                        const info = zoneMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
                        if (!info.isFirst) return null;
                        const isChangedGroupZoneCell = isChangedBaseCell || hasChangedBaseCell(row, "zone");
                        return (
                          <td
                            key={col.key}
                            className={`cfs-sticky-base cfs-base-${col.key}${
                              isChangedGroupZoneCell ? " revision-changed-cell" : ""
                            }`}
                            style={{ left: stickyOffsets.get(col.key) ?? 0, ...mergedBottomStyle(info.rowSpan) }}
                            colSpan={2}
                            rowSpan={info.rowSpan}
                          >
                            {renderStack(baseValues(row, "zone"))}
                          </td>
                        );
                      }
                      if (col.key === "zone" && !row.isDali && visibleBaseColumns[colIndex - 1]?.key === "group") {
                        return null;
                      }
                      if (col.key === "group" && row.isDali) {
                        const info = daliGroupMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
                        if (!info.isFirst) return null;
                        return (
                          <td
                            key={col.key}
                            className={`cfs-sticky-base cfs-base-${col.key}${
                              isChangedBaseCell ? " revision-changed-cell" : ""
                            }`}
                            style={{ left: stickyOffsets.get(col.key) ?? 0, ...mergedBottomStyle(info.rowSpan) }}
                            rowSpan={info.rowSpan}
                          >
                            {renderStack(baseValues(row, col.key))}
                          </td>
                        );
                      }
                      if (col.key === "zone") {
                        const info = zoneMergeInfo.get(row.id) ?? { isFirst: true, rowSpan: 1 };
                        if (!info.isFirst) return null;
                        return (
                          <td
                            key={col.key}
                            className={`cfs-sticky-base cfs-base-${col.key}${
                              isChangedBaseCell ? " revision-changed-cell" : ""
                            }`}
                            style={{ left: stickyOffsets.get(col.key) ?? 0, ...mergedBottomStyle(info.rowSpan) }}
                            rowSpan={info.rowSpan}
                          >
                            {renderStack(baseValues(row, col.key))}
                          </td>
                        );
                      }
                      return (
                        <td
                          key={col.key}
                          className={`cfs-sticky-base cfs-base-${col.key}${col.key === "area" ? " cfs-location-cell" : ""}${
                            isChangedBaseCell ? " revision-changed-cell" : ""
                          }`}
                          style={{ left: stickyOffsets.get(col.key) ?? 0 }}
                        >
                          {renderStack(baseValues(row, col.key))}
                        </td>
                      );
                    })}
                    {visibleFunctionColumns.map((col) => {
                      const values = functionValues(row, col);
                      const isAreaSceneValue = showAreaSceneHighlight && hasAreaSceneValueCell(row, col);
                      const isRepairedLink = hasRepairedLinkCell(row, values);
                      const isLinkIssueCell = hasLinkIssueFunctionCell(row, col);
                      const hasInspectionMark = showInspectionMarkHighlight && hasInspectionMarkForCell(row, col);
                      const inspectionDraftSummary = inspectionMode
                        ? inspectionDraftSummaryForCell(row, col)
                        : { hasDraft: false, hasChanged: false, scope: "" };
                      const isSelectedInspectionCell = inspectionMode && isInspectionCellSelected(row.id, col.id);
                      const isPasteTargetCell =
                        inspectionMode &&
                        inspectionPasteTarget?.rowId === row.id &&
                        inspectionPasteTarget.colId === col.id;
                      // Pale per-value tint for Backlight Logic cells. Inline
                      // style would mask highlight classes, so skip it when a
                      // highlight state owns the cell background.
                      let backlightTint: CSSProperties | undefined;
                      if (
                        row.isBacklight &&
                        !inspectionMode &&
                        !hasChangedFunctionCell(row, col) &&
                        !isAreaSceneValue &&
                        !hasInspectionMark &&
                        !isLinkIssueCell
                      ) {
                        const tintValue = showBacklightColorHighlight
                          ? values.find((value) => value.trim() !== "" && value.trim() !== "-")
                          : undefined;
                        const pale = tintValue ? backlightPaleColor(tintValue) : null;
                        if (pale) backlightTint = { backgroundColor: pale };
                      }
                      return (
                        <td
                          key={col.id}
                          style={backlightTint}
                          className={`cfs-function-cell${switchGroupStartColIds.has(col.id) ? " cfs-switch-group-start" : ""}${hasChangedFunctionCell(row, col) ? " revision-changed-cell" : ""}${
                            isAreaSceneValue ? " cfs-area-scene-value-cell" : ""
                          }${
                            isRepairedLink ? " cfs-repaired-link-cell" : ""
                          }${
                            showIndividualOverrideHighlight && hasSceneDifferentOverride(row, col) ? " cfs-individual-override-cell" : ""
                          }${
                            inspectionDraftSummary.hasDraft ? " cfs-inspection-draft-cell" : ""
                          }${
                            inspectionDraftSummary.hasChanged ? " cfs-inspection-changed-cell" : ""
                          }${
                            inspectionDraftSummary.scope === "areaScene" ? " cfs-inspection-draft-area-scene" : ""
                          }${
                            inspectionDraftSummary.scope === "override" ? " cfs-inspection-draft-override" : ""
                          }${
                            hasInspectionMark ? " cfs-inspection-marked-cell" : ""
                          }${
                            isSelectedInspectionCell ? " cfs-inspection-selected-cell" : ""
                          }${
                            isPasteTargetCell ? " cfs-inspection-paste-target-cell" : ""
                          }${
                            isLinkIssueCell ? " cfs-link-error-cell" : ""
                          }`}
                        >
                          {inspectionMode
                            ? renderInspectionCellContent(row, col, values, isAreaSceneValue)
                            : renderStack(values, row.isBacklight ? "" : "-", {
                                emphasizeSceneNameLines: isAreaSceneValue && values.length > 1,
                                sceneNameColors,
                              })}
                        </td>
                      );
                    })}
                    <td className="cfs-scroll-end-inline-cell" aria-hidden="true" />
                  </tr>
                  );
                })}
                <tr className="cfs-scroll-end-row" aria-hidden="true">
                  <td colSpan={visibleBaseColumns.length + visibleFunctionColumns.length + 1}>
                    <div className="cfs-scroll-end-spacer" style={{ blockSize: cfsScrollEndSpace.block }} />
                  </td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
      {renderInspectionPopover()}
      {renderInspectionRevisionDialog()}
    </section>
  );
}
