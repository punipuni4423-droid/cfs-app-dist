"use client";

import AddRowButton from "./AddRowButton";
import ViewModeBar, { type ViewMode } from "./ViewModeBar";
import TstatOverview from "./TstatOverview";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { byScenePalladiomBacklightTargets } from "../lib/useCfsZoneRows";
import { thermostatCollectionRows, thermostatControlDisplayNumber } from "../lib/tstatOccupancy";
import type { ReactNode } from "react";
import SettingOverlayFrame from "./setting-overlay/SettingOverlayFrame";
import SceneValueSettingPanel from "./setting-overlay/SceneValueSettingPanel";
import BacklightSettingPanel from "./setting-overlay/BacklightSettingPanel";
import type {
  CircuitEntry,
  CfsCircuit,
  CurtainAssignment,
  DeviceAssignment,
  HvacAssignment,
  HvacSeason,
  LocationMaster,
  Scene,
  SceneValueMode,
  BacklightLevelSetting,
  SwitchEntry,
  SwitchKind,
  TriggerMaster,
  RevisionFieldChanges,
} from "../types";
import {
  BACKLIGHT_LEVEL_NAMES,
  SWITCH_KIND_OPTIONS,
  createEmptySwitchEntry,
  normalizeBacklightLevels,
} from "../lib/constants";
import { useDragReorder } from "../lib/useDragReorder";
import { backlightStrongColor } from "../lib/backlightColors";
import { buildSettingLinkGroups } from "../lib/settingLinkGroups";
import DragHandle from "./DragHandle";
import AutoGrowTextarea from "./AutoGrowTextarea";
import Combobox from "./Combobox";
import ResizableMatrixScroll from "./ResizableMatrixScroll";
import { buildSettingTargetGroups, hvacSettingTargets as buildHvacSettingTargets, isLightingOrCcoSettingTarget, settingTargetIds, type SettingTarget } from "../lib/settingTargets";
import HvacSettingPanel from "./HvacSettingPanel";
import {
  buildPirRegistrationCounts,
  dedupeSwitchIds,
  normalizeSwitchPriorityFunctions,
  normalizePirCount,
  normalizeQsmAssignments as normalizeQsmAssignmentsForLocations,
  parsePirAreaNumbers,
  parsePirSelections,
  parseQsmAssignments,
  hasBacklightConfiguration,
  pirInstanceOptionsFrom as buildPirInstanceOptionsFrom,
  supportsPriorityFunction,
  switchPriorityFunctionGroupKey,
  switchGroupId,
  type PirInstanceOption,
} from "../lib/switchSync";
import {
  buildCciAssignmentOptions,
  cciCombinedLabel,
  findContactCciOption,
  syncContactSwitchesWithCciOptions,
  type CciAssignmentOption,
} from "../lib/cciAssignments";
import { selectedSceneIdsForSwitch as selectedSceneIds } from "../lib/cfsValueResolver";
import {
  PICO_BUTTON_COUNT_OPTIONS,
  defaultPicoButtonFunction,
  displayedPicoButtonCount,
  picoAllocationForButtonCount,
  picoButtonLabels,
} from "../lib/picoSpecials";
import {
  bulkModeAppliesToTarget,
  clampPercentValue,
  setSceneSettingValue,
  settingValueForBulkMode,
  stepPercentValue,
  type BulkSettingMode,
} from "../lib/settingValues";
import {
  linkSwitchSettingSelection,
  normalizeSwitchSettingLinksAfterCommit,
  unlinkSwitchSettingSelection,
} from "../lib/switchSettingLinks";
import { createAppId } from '../lib/id';
import { copySwitchButton, reorderSwitchButtonFunction, switchButtonCopyTargets } from "../lib/switchButtonCopy";
import { hasTstatBindingQuarantine } from "../lib/tstatBindingQuarantine";
import OperationActions, { type OperationActionGroup } from "./OperationActions";
import SectionHeading from "./SectionHeading";
import operationStyles from "./OperationActions.module.css";
import { checkedOperationPasteRows, copyOperation, operationPasteTargets, pasteOperation, type OperationClipboard, type OperationScope } from "../lib/switchOperationClipboard";
import OperationPasteDialog from "./OperationPasteDialog";
import { canUseStandardValue, setSceneSettingModes } from "../lib/sceneValueMode";

interface SwitchViewProps {
  hideKindSelector?: boolean;
  thermostatRegistrationPanel?: ReactNode;
  thermostatWarnings?: readonly string[];
  switches: SwitchEntry[];
  scenes: Scene[];
  locations: LocationMaster[];
  circuits: CircuitEntry[];
  activeKind: SwitchKind;
  onActiveKindChange: (next: SwitchKind) => void;
  onChange: (next: SwitchEntry[] | ((current: SwitchEntry[]) => SwitchEntry[])) => void;
  deviceAssignments?: DeviceAssignment[];
  cfsRows?: CfsCircuit[];
  curtainAssignments?: CurtainAssignment[];
  hvacAssignments?: HvacAssignment[];
  hvacSeasons?: HvacSeason[];
  triggerMasters?: TriggerMaster[];
  backlightLevels?: BacklightLevelSetting[];
  onBacklightLevelsChange?: (next: BacklightLevelSetting[]) => void;
  revisionChanges?: RevisionFieldChanges;
  canEdit?: boolean;
  buttonCopyBlocked?: boolean;
  externalSettingRequest?: SwitchSettingOverlayRequest | null;
  overlayHostOnly?: boolean;
}

export interface SwitchSettingOverlayRequest {
  switchId: string;
  tab: "function" | "backlight";
  requestId: number;
}

const PALLADIOM_BUTTON_COUNTS = ["1", "2", "3", "4", "4LR", "5", "6", "7", "8"];

type CciOption = CciAssignmentOption;

interface CciDeviceOption {
  value: string;
  label: string;
}

function getPercent(sw: SwitchEntry, circuitId: string): string {
  return sw.buttonSetting.circuitSettings.find((s) => s.circuitId === circuitId)?.percentage ?? "";
}

function setCircuitSetting(sw: SwitchEntry, circuitId: string, percentage: string, mode?: SceneValueMode): SwitchEntry {
  return {
    ...sw,
    buttonSetting: {
      ...sw.buttonSetting,
      circuitSettings: setSceneSettingValue(sw.buttonSetting.circuitSettings, circuitId, percentage, mode),
    },
  };
}

function isCurtainTarget(target: SettingTarget): boolean {
  return target.isCurtain === true || target.dimmingType === "Curtain";
}

function visibleButtonFunction(sw: SwitchEntry): string {
  const value = sw.buttonFunction.trim();
  if (!value) return "";
  if ((sw.kind === "pir" || sw.kind === "tstat") && value === "PIR") return "";
  if (
    (sw.kind === "lutronPd" || sw.kind === "lutronPico") &&
    value === sw.buttonLabel
  ) {
    return "";
  }
  if (/^Function\s+\d+$/i.test(value)) return "";
  return sw.buttonFunction;
}

// T-35: switch setting link -------------------------------------------------
// T-58: the group color/symbol palette and first-appearance ordering moved to
// app/lib/settingLinkGroups.ts so the CFS header link display shares the
// exact same colors. T-83 moves the mutation rules to switchSettingLinks so
// the CFS Select flow and Switch tab stay aligned.

// ---------------------------------------------------------------------------

function nextQsmNumber(switches: SwitchEntry[]): string {
  const used = switches
    .filter((sw) => sw.kind === "qsm")
    .map((sw) => Number.parseInt(sw.switchNumber.replace(/^QSM\s*/i, ""), 10))
    .filter(Number.isFinite);
  const next = used.length > 0 ? Math.max(...used) + 1 : 1;
  return `QSM${next}`;
}

/** Automatic repairs must not turn display-only Thermostat scaffolds into edits. */
function normalizeNonThermostatRows(rows: SwitchEntry[], normalize: (source: SwitchEntry[]) => SwitchEntry[]): SwitchEntry[] {
  const source = rows.filter(row => row.kind !== "tstat" && !hasTstatBindingQuarantine(row));
  const next = normalize(source);
  if (next === source) return rows;
  let index = 0;
  return rows.map(row => row.kind === "tstat" || hasTstatBindingQuarantine(row) ? row : next[index++]);
}

export default function SwitchView({
  switches,
  scenes,
  locations,
  circuits,
  activeKind,
  onActiveKindChange,
  onChange,
  deviceAssignments = [],
  cfsRows = [],
  curtainAssignments = [],
  hvacAssignments = [],
  hvacSeasons = [],
  triggerMasters = [],
  backlightLevels: roomTypeBacklightLevels,
  onBacklightLevelsChange,
  revisionChanges = {},
  canEdit = true,
  buttonCopyBlocked = false,
  externalSettingRequest = null,
  overlayHostOnly = false,
  hideKindSelector = false,
  thermostatRegistrationPanel,
  thermostatWarnings = [],
}: SwitchViewProps) {
  const [expandedFunctionIds, setExpandedFunctionIds] = useState<Set<string>>(new Set());
  const [expandedBacklightIds, setExpandedBacklightIds] = useState<Set<string>>(new Set());
  const [expandedAreaKeys, setExpandedAreaKeys] = useState<Set<string>>(new Set());
  // Bulk setting: checked row ids and which panel type is applying to them.
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  const [bulkApplyMode, setBulkApplyMode] = useState<"scene" | "backlight" | null>(null);
  const [buttonClipboard, setButtonClipboard] = useState<{ sourceId: string; kind: SwitchKind } | null>(null);
  const [pasteError, setPasteError] = useState("");
  const [operationClipboard, setOperationClipboard] = useState<OperationClipboard | null>(null);
  const [pasteScope, setPasteScope] = useState<OperationScope | null>(null);
  const [draggingFunctionId, setDraggingFunctionId] = useState<string | null>(null);
  const [functionDropTarget, setFunctionDropTarget] = useState<{ id: string; position: "before" | "after" } | null>(null);
  const consumedExternalRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (overlayHostOnly) return;
    // Selections are per kind tab; keep stale ids from another tab out.
    setBulkSelectedIds(new Set());
    setBulkApplyMode(null);
    setPasteError("");
    setPasteScope(null);
    setDraggingFunctionId(null);
    setFunctionDropTarget(null);
  }, [activeKind, overlayHostOnly]);
  const [areaBulkValues, setAreaBulkValues] = useState<Record<string, string>>({});
  const drag = useDragReorder(switches, commitSwitches, (sw) => sw.id, (sw) => switchGroupId(sw));

  function hasRevisionChange(id: string, fields?: string[]): boolean {
    const changed = revisionChanges[id];
    if (!changed) return false;
    if (!fields) return changed.length > 0;
    return fields.some((field) => changed.includes(field));
  }

  function revisionCellClass(id: string, fields?: string[]): string {
    return hasRevisionChange(id, fields) ? "revision-changed-cell" : "";
  }

  function commitSwitches(next: SwitchEntry[] | ((current: SwitchEntry[]) => SwitchEntry[])): void {
    if (!canEdit) return;
    // Resolve against the current state so a commit can never overwrite an
    // edit that landed after this component's props were captured.
    // T-35: linked rows are synced inside the same commit so that revision
    // diffs and collaboration saves ride the normal commit path.
    onChange((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      return normalizeSwitchPriorityFunctions(normalizeSwitchSettingLinksAfterCommit(current, resolved));
    });
  }

  useEffect(() => {
    if (overlayHostOnly) return;
    const next = normalizeNonThermostatRows(switches, dedupeSwitchIds);
    if (next !== switches && canEdit) onChange((current) => normalizeNonThermostatRows(current, dedupeSwitchIds));
  }, [switches, onChange, canEdit, overlayHostOnly]);

  const showControlTable = activeKind !== "tstat" || hvacAssignments.length > 0;
  const filteredSwitches = useMemo(
    () => activeKind === "tstat" ? thermostatCollectionRows(switches, hvacAssignments)
      : switches.filter((row) => row.kind === activeKind),
    [switches, activeKind, hvacAssignments],
  );

  const groupedSwitches = useMemo(() => {
    const groups: SwitchEntry[][] = [];
    const indexByGroup = new Map<string, number>();
    for (const sw of filteredSwitches) {
      const key = switchGroupId(sw);
      const existingIndex = indexByGroup.get(key);
      if (existingIndex === undefined) {
        indexByGroup.set(key, groups.length);
        groups.push([sw]);
      } else {
        groups[existingIndex].push(sw);
      }
    }
    return groups;
  }, [filteredSwitches]);

  const groupDisplayNo = useMemo(() => {
    const map = new Map<string, number>();
    groupedSwitches.forEach((group, index) => {
      map.set(switchGroupId(group[0]), index + 1);
    });
    return map;
  }, [groupedSwitches]);

  // T-35: color/symbol per setting link group, ordered by first appearance.
  // T-58: computed by the shared helper so the CFS tab shows identical colors.
  const settingLinkGroups = useMemo(() => buildSettingLinkGroups(switches), [switches]);

  const pirRegistrationCounts = useMemo(
    () => buildPirRegistrationCounts(switches),
    [switches],
  );

  const pirRegisteredAreaIds = useMemo(
    () => new Set(Object.keys(pirRegistrationCounts).filter((areaId) => pirRegistrationCounts[areaId])),
    [pirRegistrationCounts],
  );

  const pirInstanceOptionsFrom = useCallback(
    (areaIds: Set<string>, counts: Record<string, string>): PirInstanceOption[] =>
      buildPirInstanceOptionsFrom(locations, areaIds, counts),
    [locations],
  );

  const normalizeQsmAssignments = useCallback(
    (rows: SwitchEntry[], preferred?: { qsmId: string; pirValue: string }): SwitchEntry[] =>
      normalizeQsmAssignmentsForLocations(rows, locations, preferred),
    [locations],
  );

  const pirRegisteredOptions = useMemo(
    () => pirInstanceOptionsFrom(pirRegisteredAreaIds, pirRegistrationCounts),
    [pirInstanceOptionsFrom, pirRegisteredAreaIds, pirRegistrationCounts],
  );

  useEffect(() => {
    if (overlayHostOnly || hideKindSelector) return;
    const normalized = normalizeNonThermostatRows(switches, normalizeQsmAssignments);
    if (normalized !== switches && canEdit) onChange((current) => normalizeNonThermostatRows(current, normalizeQsmAssignments));
  }, [normalizeQsmAssignments, switches, onChange, canEdit, overlayHostOnly, hideKindSelector]);

  const highlightedKinds = useMemo(() => {
    const kinds = new Set<SwitchKind>();
    switches.forEach((sw) => {
      const changed = revisionChanges[sw.id];
      if (changed?.length) kinds.add(sw.kind);
    });
    return kinds;
  }, [revisionChanges, switches]);

  const areasWithScenes = useMemo(() => {
    const areaIds = new Set(scenes.map((s) => s.areaId));
    return locations.filter((l) => areaIds.has(l.id));
  }, [scenes, locations]);

  const triggerOptions = useMemo(
    () => triggerMasters.map((trigger) => trigger.name.trim()).filter(Boolean),
    [triggerMasters],
  );

  const settingTargetGroups = useMemo(
    () => buildSettingTargetGroups(locations, circuits, deviceAssignments, cfsRows, curtainAssignments, switches),
    [locations, circuits, deviceAssignments, cfsRows, curtainAssignments, switches],
  );
  const hvacSettingTargets = useMemo(
    () => buildHvacSettingTargets(hvacAssignments, locations),
    [hvacAssignments, locations],
  );

  const palladiomSwitches = useMemo(() => {
    const groups = new Map<string, SwitchEntry>();
    for (const sw of switches) {
      if (sw.kind !== "lutronPd") continue;
      const key = switchGroupId(sw);
      const current = groups.get(key);
      if (!current) {
        groups.set(key, sw);
      }
    }
    return Array.from(groups.values());
  }, [switches]);

  const byScenePalladiomSwitches = useMemo(
    () => byScenePalladiomBacklightTargets(switches),
    [switches],
  );

  const effectiveBacklightLevels = useMemo(
    () => normalizeBacklightLevels(roomTypeBacklightLevels),
    [roomTypeBacklightLevels],
  );

  const backlightConditions = useMemo(() => {
    return effectiveBacklightLevels;
  }, [effectiveBacklightLevels]);

  function backlightConditionLabel(raw: string): string {
    const value = raw.trim();
    if (!value) return "";
    const matched = backlightConditions.find((level) => level.key === value || level.name === value);
    return matched ? matched.name : value;
  }

  const cciOptions = useMemo(
    (): CciOption[] => buildCciAssignmentOptions(deviceAssignments),
    [deviceAssignments],
  );

  const cciDeviceOptions = useMemo((): CciDeviceOption[] => {
    const seen = new Set<string>();
    return cciOptions.reduce<CciDeviceOption[]>((items, option) => {
      if (seen.has(option.deviceKey)) return items;
      seen.add(option.deviceKey);
      items.push({ value: option.deviceKey, label: option.deviceKey });
      return items;
    }, []);
  }, [cciOptions]);

  const contactSelectedOption = useCallback(
    (sw: SwitchEntry): CciOption | undefined => findContactCciOption(sw, cciOptions),
    [cciOptions],
  );

  useEffect(() => {
    if (overlayHostOnly || hideKindSelector) return;
    const next = normalizeNonThermostatRows(switches, rows => syncContactSwitchesWithCciOptions(rows, cciOptions));
    if (next !== switches && canEdit) {
      onChange((current) => normalizeNonThermostatRows(current, rows => syncContactSwitchesWithCciOptions(rows, cciOptions)));
    }
  }, [cciOptions, switches, onChange, canEdit, overlayHostOnly, hideKindSelector]);

  const hasButtonCount = activeKind === "lutronPd" || activeKind === "lutronPico";
  const hasCciDeviceColumn = activeKind === "contact";
  const isCommand = activeKind === "command";
  const isPir = activeKind === "pir";
  const isTstat = activeKind === "tstat";
  const [thermostatViewMode, setThermostatViewMode] = useState<ViewMode>("edit");
  const showThermostatOverview = isTstat && thermostatRegistrationPanel != null && thermostatViewMode === "overview";
  const isQsm = activeKind === "qsm";
  const kindOptions = thermostatRegistrationPanel != null
    ? [...SWITCH_KIND_OPTIONS, { value: "tstat" as const, label: "Thermostat" }]
    : SWITCH_KIND_OPTIONS;
  const hasPriorityColumn = !isCommand && !isPir && !isQsm && !isTstat;
  // Bulk-select column (left of Function Setting). QSM has no setting columns.
  const hasBulkColumn = !isQsm;
  const colCount = (isCommand
    ? 10
    : isQsm
      ? 5
      : 10 + (hasButtonCount ? 4 : 0) + (hasCciDeviceColumn ? 2 : 0) + (hasPriorityColumn ? 1 : 0)) +
    (hasBulkColumn ? 1 : 0);

  const priorityFunctionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const sw of filteredSwitches) {
      if (!supportsPriorityFunction(sw)) continue;
      const key = switchPriorityFunctionGroupKey(sw);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [filteredSwitches]);

  function cciSelection(sw: SwitchEntry): { deviceKey: string; address: string } {
    if (sw.cciAssignment && cciDeviceOptions.some((option) => option.value === sw.cciAssignment)) {
      const inferred = cciOptions.find(
        (option) =>
          option.deviceKey === sw.cciAssignment &&
          (option.address === sw.switchNumber ||
            option.assigned === sw.switchNumber ||
            cciCombinedLabel(option) === sw.switchNumber ||
            option.value === sw.switchNumber),
      );
      return {
        deviceKey: sw.cciAssignment,
        address: sw.allocation || inferred?.address || "",
      };
    }
    const oldOption = cciOptions.find(
      (option) =>
        option.value === sw.switchNumber ||
        option.value === sw.cciAssignment ||
        option.assigned === sw.switchNumber ||
        cciCombinedLabel(option) === sw.switchNumber,
    );
    if (oldOption) return { deviceKey: oldOption.deviceKey, address: oldOption.address };
    return { deviceKey: "", address: sw.switchNumber };
  }

  function cciAddressOptions(deviceKey: string): CciOption[] {
    return cciOptions.filter((option) => option.deviceKey === deviceKey);
  }

  function contactSwitchNumberValue(sw: SwitchEntry): string {
    return contactSelectedOption(sw)?.assigned ?? sw.switchNumber;
  }

  function contactSwitchNameValue(sw: SwitchEntry): string {
    return contactSelectedOption(sw)?.detail ?? sw.switchName;
  }

  function buttonLabels(kind: SwitchKind, count: string): string[] {
    if (kind === "lutronPico") {
      return picoButtonLabels(count);
    }
    if (count === "4LR") return ["M1", "M2", "M3", "M4L", "M4R"];
    const n = Number.parseInt(count, 10);
    return Number.isFinite(n) ? Array.from({ length: n }, (_, i) => `M${i + 1}`) : [];
  }

  function addSwitch(): void {
    const next = createEmptySwitchEntry(activeKind);
    if (activeKind === "pir") {
      next.buttonFunction = "PIR";
      next.switchNumber = Array.from(pirRegisteredAreaIds).join(",");
      next.allocation = JSON.stringify(pirRegistrationCounts);
      next.switchName = "";
      next.buttonLabel = JSON.stringify(pirRegisteredOptions[0] ? [pirRegisteredOptions[0].value] : []);
    } else if (activeKind === "qsm") {
      next.switchNumber = nextQsmNumber(switches);
      next.allocation = switches.some((sw) => sw.kind === "qsm")
        ? "[]"
        : JSON.stringify(pirRegisteredOptions.map((option) => option.value));
    }
    commitSwitches((current) => normalizeQsmAssignments([...current, next]));
  }

  function addFunctionRow(groupRows: SwitchEntry[], buttonLabel?: string): void {
    const head = groupRows[0];
    const targetRows = buttonLabel
      ? groupRows.filter((row) => row.buttonLabel === buttonLabel)
      : groupRows;
    const anchor = targetRows[targetRows.length - 1] ?? head;
    const newRow = createEmptySwitchEntry(activeKind);
    const nextRow: SwitchEntry = {
      ...newRow,
      switchGroupId: switchGroupId(anchor),
      switchNumber: head.switchNumber,
      switchName: head.switchName,
      cciAssignment: head.cciAssignment,
      allocation: activeKind === "pir" ? head.allocation : newRow.allocation,
      ...(head.tstatBinding ? { tstatBinding: { ...head.tstatBinding, assignmentIds: [...head.tstatBinding.assignmentIds] } } : {}),
      buttonCount: head.buttonCount,
      buttonLabel: buttonLabel ?? head.buttonLabel,
      buttonFunction: "",
    };
    const lastIndex = switches.findLastIndex((sw) => sw.id === anchor.id);
    commitSwitches([
      ...switches.slice(0, lastIndex + 1),
      nextRow,
      ...switches.slice(lastIndex + 1),
    ]);
  }

  function updateGroupFields(groupId: string, fields: Partial<SwitchEntry>): void {
    commitSwitches(
      switches.map((sw) =>
        switchGroupId(sw) === groupId ? { ...sw, ...fields } : sw,
      ),
    );
  }

  function updateGroup(
    groupId: string,
    field: "switchNumber" | "switchName",
    value: string,
  ): void {
    commitSwitches(
      switches.map((sw) =>
        switchGroupId(sw) === groupId ? { ...sw, [field]: value } : sw,
      ),
    );
  }

  function switchNumberHeader(): string {
    if (isTstat) return "TH";
    if (isCommand) return "Command Name";
    if (activeKind === "pir") return "PIR";
    return "Switch #";
  }

  function switchNameHeader(): string {
    if (isTstat) return "Area";
    if (isCommand) return "Switch #";
    return "Switch Name";
  }

  function pirAreaIds(sw: SwitchEntry): Set<string> {
    return new Set(sw.switchNumber.split(",").map((value) => value.trim()).filter(Boolean));
  }

  function pirAreaNumber(sw: SwitchEntry, areaId: string): string {
    const value = parsePirAreaNumbers(sw.allocation)[areaId] ?? sw.switchName.trim();
    return value || "1";
  }

  function pirInstanceOptions(sw: SwitchEntry): PirInstanceOption[] {
    if (sw.kind === "pir") return pirRegisteredOptions;
    const ids = pirAreaIds(sw);
    const counts = parsePirAreaNumbers(sw.allocation);
    for (const id of ids) {
      if (!counts[id]) counts[id] = pirAreaNumber(sw, id);
    }
    return pirInstanceOptionsFrom(ids, counts);
  }

  function selectedPirInstances(sw: SwitchEntry): PirInstanceOption[] {
    const options = pirInstanceOptions(sw);
    const selectedValues = parsePirSelections(sw.buttonLabel);
    return options.filter((option) => selectedValues.includes(option.value));
  }

  function updatePirRegistration(areaId: string, value: string): void {
    const nextCounts = { ...pirRegistrationCounts };
    const count = normalizePirCount(value);
    if (count) nextCounts[areaId] = count;
    else delete nextCounts[areaId];

    const areaIds = new Set(Object.keys(nextCounts));
    const options = pirInstanceOptionsFrom(areaIds, nextCounts);
    const sharedFields = {
      switchNumber: Array.from(areaIds).join(","),
      allocation: JSON.stringify(nextCounts),
      switchName: "",
    };

    let hasPirRow = false;
    const nextSwitches = switches.map((sw) => {
      if (sw.kind !== "pir") return sw;
      hasPirRow = true;
      const selected = parsePirSelections(sw.buttonLabel).filter((value) =>
        options.some((option) => option.value === value),
      );
      const nextSelected = selected.length > 0 ? selected : options[0] ? [options[0].value] : [];
      return {
        ...sw,
        ...sharedFields,
        buttonLabel: JSON.stringify(nextSelected),
        buttonFunction: sw.buttonFunction || "PIR",
      };
    });

    if (!hasPirRow && options.length > 0) {
      const next = createEmptySwitchEntry("pir");
      nextSwitches.push({
        ...next,
        ...sharedFields,
        buttonLabel: JSON.stringify(options[0] ? [options[0].value] : []),
        buttonFunction: "PIR",
      });
    }

    commitSwitches(nextSwitches);
  }

  function updatePirAssignment(groupId: string, pirValue: string, checked: boolean): void {
    const head = switches.find((sw) => switchGroupId(sw) === groupId);
    if (!head) return;
    const selected = new Set(parsePirSelections(head.buttonLabel));
    if (checked) selected.add(pirValue);
    else selected.delete(pirValue);
    const ordered = pirRegisteredOptions
      .map((option) => option.value)
      .filter((value) => selected.has(value));
    updateGroupFields(groupId, { buttonLabel: JSON.stringify(ordered) });
  }

  function updateQsmAssignment(id: string, pirValue: string, checked: boolean): void {
    if (!checked) {
      const normalized = normalizeQsmAssignments(switches);
      if (normalized !== switches) commitSwitches(normalized);
      return;
    }
    commitSwitches(normalizeQsmAssignments(switches, { qsmId: id, pirValue }));
  }

  function switchSettingTitle(sw: SwitchEntry): string {
    if (sw.kind === "pir") {
      const selected = selectedPirInstances(sw);
      if (selected.length > 0) return selected.map((option) => `${option.label} - ${option.areaName}`).join(" / ");
      return "PIR Setting";
    }
    if (sw.kind === "qsm") return sw.switchNumber.trim() || "QSM Setting";
    return [sw.switchNumber, sw.switchName].filter(Boolean).join(" - ") || "Switch Setting";
  }

  function updateButtonCount(groupRows: SwitchEntry[], count: string): void {
    const head = groupRows[0];
    const groupId = switchGroupId(head);
    const labels = buttonLabels(head.kind, count);
    if (labels.length === 0) {
      commitSwitches(
        switches.map((sw) =>
          switchGroupId(sw) === groupId
            ? { ...sw, buttonCount: count, allocation: head.kind === "lutronPico" ? picoAllocationForButtonCount(count, sw.allocation) : sw.allocation }
            : sw,
        ),
      );
      return;
    }
    const usedIds = new Set<string>();
    const nextRows = labels.flatMap((label, index) => {
      const rowsForLabel = groupRows.filter((row) => row.buttonLabel === label);
      const sourceRows =
        rowsForLabel.length > 0
          ? rowsForLabel
          : [groupRows[index] ?? createEmptySwitchEntry(head.kind)];
      return sourceRows.map((source) => {
        const id = usedIds.has(source.id) ? createAppId() : source.id;
        usedIds.add(id);
        const preservedFunction = source.buttonLabel === label ? visibleButtonFunction(source) : "";
        const defaultFunction = head.kind === "lutronPico" ? defaultPicoButtonFunction(count, label) : "";
        return {
          ...source,
          id,
          switchGroupId: groupId,
          // T-35: a row duplicated for a different button label must not
          // silently join the source row's setting link group.
          settingLinkGroupId: source.buttonLabel === label ? source.settingLinkGroupId : undefined,
          kind: head.kind,
          switchNumber: head.switchNumber,
          switchName: head.switchName,
          cciAssignment: head.cciAssignment,
          buttonCount: count,
          buttonLabel: label,
          allocation: head.kind === "lutronPico" ? picoAllocationForButtonCount(count, head.allocation) : source.allocation,
          buttonFunction: preservedFunction || defaultFunction,
        };
      });
    });
    const result: SwitchEntry[] = [];
    let inserted = false;
    for (const sw of switches) {
      if (switchGroupId(sw) !== groupId) {
        result.push(sw);
      } else if (!inserted) {
        result.push(...nextRows);
        inserted = true;
      }
    }
    commitSwitches(result);
  }

  function updateSwitch(id: string, fields: Partial<SwitchEntry>): void {
    commitSwitches((current) => current.map((sw) => (sw.id === id ? { ...sw, ...fields } : sw)));
  }

  function hasPriorityFunctionChoice(sw: SwitchEntry): boolean {
    if (!supportsPriorityFunction(sw)) return false;
    return (priorityFunctionCounts.get(switchPriorityFunctionGroupKey(sw)) ?? 0) > 1;
  }

  function updatePriorityFunction(row: SwitchEntry, checked: boolean): void {
    const targetKey = switchPriorityFunctionGroupKey(row);
    if (checked) {
      const groupRows = switches.filter(
        (sw) => supportsPriorityFunction(sw) && switchPriorityFunctionGroupKey(sw) === targetKey,
      );
      const checkedCount = groupRows.filter((sw) => (sw.id === row.id ? true : sw.isPriorityFunction === true)).length;
      if (groupRows.length > 1 && checkedCount >= groupRows.length) {
        window.alert(
          "Leave at least one Function unchecked within the same button. Not all Functions can be set to Priority.",
        );
        return;
      }
    }
    commitSwitches(
      switches.map((sw) => {
        if (!supportsPriorityFunction(sw) || switchPriorityFunctionGroupKey(sw) !== targetKey) return sw;
        if (sw.id !== row.id) return sw;
        return { ...sw, isPriorityFunction: checked ? true : undefined };
      }),
    );
  }

  function updateButtonSetting(
    id: string,
    updater: SwitchEntry["buttonSetting"] | ((setting: SwitchEntry["buttonSetting"], row: SwitchEntry) => SwitchEntry["buttonSetting"]),
  ): void {
    commitSwitches(
      switches.map((sw) => {
        if (sw.id !== id) return sw;
        const nextSetting = typeof updater === "function" ? updater(sw.buttonSetting, sw) : updater;
        return { ...sw, buttonSetting: nextSetting };
      }),
    );
  }

  function setSceneForArea(sw: SwitchEntry, areaId: string, sceneId: string): void {
    updateButtonSetting(sw.id, (current, row) => {
      const currentRow = { ...row, buttonSetting: current };
      const otherSceneIds = selectedSceneIds(currentRow).filter((id) => {
        const scene = scenes.find((s) => s.id === id);
        return scene && scene.areaId !== areaId;
      });
      const sceneIds = sceneId ? [...otherSceneIds, sceneId] : otherSceneIds;
      return {
        ...current,
        sceneId: sceneIds[0] ?? "",
        sceneIds,
      };
    });
  }

  function sceneForArea(sw: SwitchEntry, areaId: string): string {
    return selectedSceneIds(sw).find((id) => scenes.find((s) => s.id === id)?.areaId === areaId) ?? "";
  }

  // One setting row represents a whole circuit group; read the first
  // non-empty member value (legacy data may only have some rows filled).
  const getTargetValue = useCallback((sw: SwitchEntry, target: SettingTarget): string => {
    for (const id of settingTargetIds(target)) {
      const value = getPercent(sw, id);
      if (value.trim() !== "") return value;
    }
    return "";
  }, []);

  function targetValueMode(sw: SwitchEntry, target: SettingTarget): SceneValueMode {
    return settingTargetIds(target).some((id) => sw.buttonSetting.circuitSettings.find((setting) => setting.circuitId === id)?.valueMode === "text") ? "text" : "standard";
  }

  function targetAllowsStandard(sw: SwitchEntry, target: SettingTarget): boolean {
    return settingTargetIds(target).every(id => canUseStandardValue(getPercent(sw, id), target.dimmingType));
  }

  function handleTargetModeOnlyChange(sw: SwitchEntry, target: SettingTarget, mode: SceneValueMode): void {
    if (!canEdit || (mode === "standard" && !targetAllowsStandard(sw, target))) return;
    commitSwitches(current => {
      const row = current.find(candidate => candidate.id === sw.id);
      if (!row) return current;
      const circuitSettings = setSceneSettingModes(row.buttonSetting.circuitSettings, settingTargetIds(target), mode, target.dimmingType);
      if (!circuitSettings) return current;
      return current.map(candidate => candidate.id === row.id
        ? { ...candidate, buttonSetting: { ...candidate.buttonSetting, circuitSettings } }
        : candidate);
    });
  }

  function handleTargetValueChange(sw: SwitchEntry, target: SettingTarget, raw: string, mode: SceneValueMode = "standard"): void {
    if (!canEdit) return;
    if (mode === "standard" && !canUseStandardValue(raw, target.dimmingType)) return;
    const value =
      mode === "text" ||
      target.isOnOff ||
      ["Raise", "Lower", "0.5 sec", "Blinking (Short)", "Blinking (Long)"].includes(raw)
        ? raw
        : clampPercentValue(raw);
    updateButtonSetting(sw.id, (current, row) =>
      settingTargetIds(target).reduce(
        (next, id) => setCircuitSetting(next, id, value, mode),
        { ...row, buttonSetting: current },
      ).buttonSetting,
    );
  }

  function stepTargetPercent(sw: SwitchEntry, target: SettingTarget, delta: number): void {
    if (targetValueMode(sw, target) === "text") return;
    handleTargetValueChange(sw, target, stepPercentValue(getTargetValue(sw, target), delta));
  }

  function stepAreaBulkValue(sw: SwitchEntry, areaTargets: SettingTarget[], key: string, delta: number): void {
    applyAreaBulkPercentValue(sw, areaTargets, key, stepPercentValue(areaBulkValues[key] || "", delta));
  }

  function applyAreaBulkPercentValue(
    sw: SwitchEntry,
    areaTargets: SettingTarget[],
    key: string,
    rawValue: string,
  ): void {
    const value = clampPercentValue(rawValue);
    setAreaBulkValues((prev) => ({ ...prev, [key]: value }));
    if (!value) return;
    updateButtonSetting(sw.id, (current, row) =>
      areaTargets.reduce(
        (next, target) =>
          !target.isOnOff && !isCurtainTarget(target) && targetValueMode(next, target) !== "text"
            ? settingTargetIds(target).reduce((acc, id) => setCircuitSetting(acc, id, value), next)
            : next,
        { ...row, buttonSetting: current },
      ).buttonSetting,
    );
  }

  function applyAreaBulk(
    sw: SwitchEntry,
    areaTargets: SettingTarget[],
    mode: BulkSettingMode,
    key: string,
  ): void {
    updateButtonSetting(sw.id, (current, row) =>
      areaTargets.reduce((next, target) => {
        if (targetValueMode(next, target) === "text" && (mode !== "clear" || isLightingOrCcoSettingTarget(target))) return next;
        if (isCurtainTarget(target) && mode !== "clear") return next;
        const value = settingValueForBulkMode(mode, target.isOnOff, areaBulkValues[key] || "");
        return value === null
          ? next
          : settingTargetIds(target).reduce((acc, id) => setCircuitSetting(acc, id, value, "standard"), next);
      }, { ...row, buttonSetting: current }).buttonSetting,
    );
  }

  function canApplyAreaBulkMode(areaTargets: SettingTarget[], mode: BulkSettingMode, key: string): boolean {
    if (mode === "percent" && !clampPercentValue(areaBulkValues[key] || "")) return false;
    return areaTargets.some((target) => !isCurtainTarget(target) && bulkModeAppliesToTarget(mode, target.isOnOff));
  }

  const areaHasSetting = useCallback((sw: SwitchEntry, area: SettingTarget[]): boolean => {
    return area.some((target) => getTargetValue(sw, target).trim() !== "");
  }, [getTargetValue]);

  function bulkTemplateRow(): SwitchEntry | null {
    return filteredSwitches.find((sw) => bulkSelectedIds.has(sw.id)) ?? null;
  }

  function startBulkSetting(mode: "scene" | "backlight"): void {
    const template = bulkTemplateRow();
    if (!template) return;
    setBulkApplyMode(mode);
    if (mode === "scene") openFunctionSetting(template);
    else openBacklightSetting(template);
  }

  // T-35: create/join a permanent setting link from the checked rows. The
  // checked-first row acts as the template; its settings are synced to every
  // member with the applyBulkSetting copy rules (buttonSetting deep copy,
  // backlight CONDITION only — backlightTarget is never copied).
  function linkSelectedSwitches(): void {
    const template = bulkTemplateRow();
    if (!template || bulkSelectedIds.size < 2) return;
    const ids = new Set(bulkSelectedIds);
    commitSwitches((current) => linkSwitchSettingSelection(current, ids, createAppId, template.id));
    setBulkSelectedIds(new Set());
  }

  // T-35: remove only the checked rows from their link group. A group left
  // with a single member dissolves via clearSingletonSwitchSettingLinks.
  function unlinkSelectedSwitches(): void {
    const ids = new Set(bulkSelectedIds);
    if (ids.size === 0) return;
    commitSwitches((current) => unlinkSwitchSettingSelection(current, ids));
    setBulkSelectedIds(new Set());
  }

  function applyBulkSetting(active: SwitchEntry): void {
    const mode = bulkApplyMode;
    if (!mode) return;
    const ids = new Set(bulkSelectedIds);
    commitSwitches((current) => {
      const source = current.find((sw) => sw.id === active.id) ?? active;
      return current.map((sw) => {
        if (!ids.has(sw.id) || sw.id === source.id) return sw;
        if (mode === "scene") {
          return { ...sw, buttonSetting: JSON.parse(JSON.stringify(source.buttonSetting)) as SwitchEntry["buttonSetting"] };
        }
        // Copy the CONDITION only. backlightTarget points at switch-specific
        // circuit groups; bulk-copying it cross-wired or wiped targets on the
        // other rows, breaking their CFS backlight display and settings.
        return { ...sw, backlightCondition: source.backlightCondition };
      });
    });
    setBulkApplyMode(null);
    setBulkSelectedIds(new Set());
    closeSettingOverlay();
  }

  function openFunctionSetting(sw: SwitchEntry): void {
    setExpandedBacklightIds(new Set());
    setExpandedFunctionIds(new Set([sw.id]));
    setExpandedAreaKeys(() => {
      const next = new Set<string>();
      for (const area of settingTargetGroups) {
        if (areaHasSetting(sw, area.targets)) next.add(areaKey(sw.id, area.id));
      }
      return next;
    });
  }

  function openBacklightSetting(sw: SwitchEntry): void {
    setExpandedFunctionIds(new Set());
    setExpandedBacklightIds(new Set([sw.id]));
  }

  function closeSettingOverlay(): void {
    setExpandedFunctionIds(new Set());
    setExpandedBacklightIds(new Set());
    setBulkApplyMode(null);
  }

  useEffect(() => {
    if (!externalSettingRequest) return;
    if (consumedExternalRequestIdRef.current === externalSettingRequest.requestId) return;
    consumedExternalRequestIdRef.current = externalSettingRequest.requestId;

    const active = switches.find((sw) => sw.id === externalSettingRequest.switchId);
    if (!active) {
      setExpandedFunctionIds(new Set());
      setExpandedBacklightIds(new Set());
      setBulkApplyMode(null);
      return;
    }

    if (externalSettingRequest.tab === "backlight") {
      setExpandedFunctionIds(new Set());
      setExpandedBacklightIds(new Set([active.id]));
      return;
    }

    setExpandedBacklightIds(new Set());
    setExpandedFunctionIds(new Set([active.id]));
    setExpandedAreaKeys(() => {
      const next = new Set<string>();
      for (const area of settingTargetGroups) {
        if (areaHasSetting(active, area.targets)) next.add(`${active.id}:${area.id}`);
      }
      return next;
    });
  }, [areaHasSetting, externalSettingRequest, settingTargetGroups, switches]);

  useEffect(() => {
    if (expandedFunctionIds.size === 0 && expandedBacklightIds.size === 0) return;
    function handleEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") closeSettingOverlay();
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [expandedFunctionIds, expandedBacklightIds]);

  useEffect(() => {
    if (expandedFunctionIds.size === 0 && expandedBacklightIds.size === 0) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [expandedFunctionIds, expandedBacklightIds]);

  function hasButtonSettings(sw: SwitchEntry): boolean {
    return selectedSceneIds(sw).length > 0 || sw.buttonSetting.circuitSettings.length > 0;
  }

  function hasBacklightSettings(sw: SwitchEntry): boolean {
    return hasBacklightConfiguration(sw);
  }

  function copySwitch(groupRows: SwitchEntry[]): void {
    if (groupRows.some(hasTstatBindingQuarantine)) return;
    if (groupRows.length === 0) return;
    const newGroupId = createAppId();
    const copiedRows = groupRows.map((row) => ({
      ...row,
      id: createAppId(),
      switchGroupId: newGroupId,
      // T-35: copies never inherit the setting link (prevents accidental
      // propagation into the source group).
      settingLinkGroupId: undefined,
      switchNumber: row.switchNumber ? `${row.switchNumber} Copy` : row.switchNumber,
      buttonSetting: {
        ...row.buttonSetting,
        sceneIds: [...row.buttonSetting.sceneIds],
        circuitSettings: row.buttonSetting.circuitSettings.map((setting) => ({ ...setting })),
      },
      backlightLevels: row.backlightLevels.map((level) => ({ ...level })),
    }));
    const lastIndex = switches.findLastIndex((sw) => switchGroupId(sw) === switchGroupId(groupRows[0]));
    commitSwitches([
      ...switches.slice(0, lastIndex + 1),
      ...copiedRows,
      ...switches.slice(lastIndex + 1),
    ]);
  }


  function removeSwitchGroup(groupRows: SwitchEntry[]): void {
    if (groupRows.some(hasTstatBindingQuarantine)) return;
    if (!canEdit || buttonCopyBlocked) return;
    const groupId = switchGroupId(groupRows[0]);
    setExpandedFunctionIds(new Set());
    setExpandedBacklightIds(new Set());
    commitSwitches((current) => normalizeQsmAssignments(current.filter((row) => switchGroupId(row) !== groupId)));
  }

  function removeFunctionRow(row: SwitchEntry, groupRows: SwitchEntry[]): void {
    if (hasTstatBindingQuarantine(row)) return;
    if (!canEdit || buttonCopyBlocked) return;
    if (groupRows.length <= 1) return;
    setExpandedFunctionIds((prev) => {
      if (!prev.has(row.id)) return prev;
      const next = new Set(prev);
      next.delete(row.id);
      return next;
    });
    setExpandedBacklightIds((prev) => {
      if (!prev.has(row.id)) return prev;
      const next = new Set(prev);
      next.delete(row.id);
      return next;
    });
    commitSwitches((current) => normalizeQsmAssignments(current.filter((item) => item.id !== row.id)));
  }

  function isCopiedAction(sw: SwitchEntry, scope: OperationScope): boolean {
    if (operationClipboard?.scope !== scope || operationClipboard.kind !== sw.kind) return false;
    return scope === "function"
      ? operationClipboard.sourceId === sw.id
      : operationClipboard.sourceGroupId === switchGroupId(sw);
  }

  function isCopiedButton(sw: SwitchEntry): boolean {
    return copiedButtonRow?.kind === sw.kind && switchGroupId(copiedButtonRow) === switchGroupId(sw)
      && copiedButtonRow.buttonLabel === sw.buttonLabel;
  }

  function copyAction(sw: SwitchEntry, scope: OperationScope): void {
    if (!canEdit || buttonCopyBlocked) return;
    if (isCopiedAction(sw, scope)) {
      cancelCopy();
      return;
    }
    const clipboard = copyOperation(switches, sw.id, scope, locations);
    if (!clipboard) return;
    setButtonClipboard(null);
    setOperationClipboard(clipboard);
    setPasteScope(null);
    setPasteError("");
  }

  function copyButton(sw: SwitchEntry): void {
    if (!canEdit || buttonCopyBlocked || hasTstatBindingQuarantine(sw)) return;
    if (isCopiedButton(sw)) {
      cancelCopy();
      return;
    }
    setOperationClipboard(null);
    setButtonClipboard({ sourceId: sw.id, kind: sw.kind });
    setPasteScope(null);
    setPasteError("");
  }

  function cancelCopy(): void {
    if (!canEdit) return;
    setOperationClipboard(null);
    setButtonClipboard(null);
    setPasteScope(null);
    setPasteError("");
  }

  function pasteActions(ids: string[]): boolean {
    if (!canEdit || buttonCopyBlocked || !operationClipboard || pasteScope !== operationClipboard.scope) return false;
    const next = pasteOperation(switches, operationClipboard, ids, createAppId);
    if (next === switches) return false;
    commitSwitches(current => pasteOperation(current, operationClipboard, ids, createAppId));
    setPasteScope(null); return true;
  }
  const functionClipboard = operationClipboard?.scope === "function" ? operationClipboard : null;
  const directClipboard = buttonClipboard ?? functionClipboard;
  const copiedButtonRow = buttonClipboard ? switches.find(row => row.id === buttonClipboard.sourceId) : undefined;
  const directPasteTargets = useMemo(() => {
    const targets = buttonClipboard
      ? switchButtonCopyTargets(switches, buttonClipboard.sourceId)
      : functionClipboard ? operationPasteTargets(switches, functionClipboard) : [];
    return new Map(targets.map(target => [target.id, target]));
  }, [switches, buttonClipboard, functionClipboard]);
  const checkedPaste = checkedOperationPasteRows(bulkSelectedIds, directPasteTargets);
  const toolbarPasteIds = new Set(directClipboard?.kind === activeKind ? checkedPaste.ids : []);
  const directPasteLabel = buttonClipboard ? "Paste Button" : "Paste Function";

  function pasteDirect(ids: string[], clearChecked: boolean): void {
    if (!canEdit || buttonCopyBlocked || !directClipboard || directClipboard.kind !== activeKind || !ids.length) return;
    const blockedTarget = ids.find(id => !directPasteTargets.has(id) || directPasteTargets.get(id)?.reason);
    if (blockedTarget) {
      setPasteError(directPasteTargets.get(blockedTarget)?.reason ?? "This row cannot receive the copied settings.");
      return;
    }
    const apply = (current: SwitchEntry[]) => buttonClipboard
      ? copySwitchButton(current, buttonClipboard.sourceId, ids, createAppId)
      : functionClipboard ? pasteOperation(current, functionClipboard, ids, createAppId) : current;
    const next = apply(switches);
    if (next === switches) {
      setPasteError("Paste could not be applied. Check priority and destination compatibility.");
      return;
    }
    commitSwitches(current => current === switches ? next : apply(current));
    cancelCopy();
    if (clearChecked) setBulkSelectedIds(new Set());
  }

  function functionOperations(sw: SwitchEntry, groupRows: SwitchEntry[], isFirst: boolean, isButtonFirst: boolean): OperationActionGroup[] {
    const blocked = !canEdit || buttonCopyBlocked || hasTstatBindingQuarantine(sw);
    const copied = isCopiedAction(sw, "function");
    const target = functionClipboard ? directPasteTargets.get(sw.id) : undefined;
    const pasteReason = target?.reason ?? (target ? undefined : "This row cannot receive the copied settings.");
    const groups: OperationActionGroup[] = [{
      id: "function",
      actions: [{ id: "copy-function", icon: "copy", label: "Copy Function", "aria-pressed": copied, className: "btn-secondary btn-sm switch-copy-source", onClick: () => copyAction(sw, "function"), disabled: blocked },
      { id: "paste-function", icon: "paste", label: "Paste Function", title: functionClipboard ? pasteReason : undefined,
        className: functionClipboard && toolbarPasteIds.has(sw.id) ? "btn-secondary btn-sm switch-paste-in-toolbar" : "btn-secondary btn-sm",
        onClick: () => pasteDirect([sw.id], false),
        disabled: blocked || !functionClipboard || Boolean(pasteReason) }, {
        id: "remove-function",
        icon: "minus",
        label: "Delete Function Row",
        className: "btn-secondary btn-sm",
        onClick: () => removeFunctionRow(sw, groupRows),
        title: groupRows.length <= 1 ? "Use Delete Switch to remove the last row" : "Delete this function row",
        disabled: blocked || groupRows.length <= 1,
      }],
    }];
    if ((!hasButtonCount && !isCommand && isFirst) || (hasButtonCount && isButtonFirst)) groups[0].actions = [...groups[0].actions, {
      id: "add-function", icon: "plus", label: "Add Function", className: "btn-secondary btn-sm", onClick: () => { if (!blocked) addFunctionRow(groupRows, hasButtonCount ? sw.buttonLabel || "-" : undefined); }, disabled: blocked,
    }];
    return groups;
  }

  function buttonOperations(sw: SwitchEntry, buttonRows: SwitchEntry[]): OperationActionGroup[] {
    const blocked = !canEdit || buttonCopyBlocked || buttonRows.some(hasTstatBindingQuarantine)
      || !sw.buttonLabel.trim() || sw.buttonLabel === "-";
    const copied = isCopiedButton(sw);
    const target = buttonClipboard ? directPasteTargets.get(sw.id) : undefined;
    return [{
      id: "button",
      actions: [
        { id: "copy-button", icon: "copy", label: "Copy Button", "aria-pressed": copied,
          className: "btn-secondary btn-sm switch-copy-source", onClick: () => copyButton(sw), disabled: blocked },
        { id: "paste-button", icon: "paste", label: "Paste Button",
          className: buttonClipboard && toolbarPasteIds.has(sw.id) ? "btn-secondary btn-sm switch-paste-in-toolbar" : "btn-secondary btn-sm",
          title: buttonClipboard ? target?.reason ?? (target ? undefined : "This button cannot receive the copied settings.") : undefined,
          onClick: () => pasteDirect([sw.id], false), disabled: blocked || !target || Boolean(target.reason) },
      ],
    }];
  }

  function moveButtonFunction(source: string, target: string, position: "before" | "after"): void {
    if (!canEdit || buttonCopyBlocked || reorderSwitchButtonFunction(switches, source, target, position) === switches) return;
    commitSwitches(current => reorderSwitchButtonFunction(current, source, target, position));
  }
  function switchOperations(sw: SwitchEntry, groupRows: SwitchEntry[]): OperationActionGroup[] {
    const blocked = !canEdit || buttonCopyBlocked || groupRows.some(hasTstatBindingQuarantine);
    return [{
        id: "device",
        label: isTstat ? "Area control" : undefined,
        actions: [{ id: "copy-switch", icon: "copy", label: "Copy Switch Settings",
          "aria-pressed": isCopiedAction(sw, "switch"),
          className: "btn-secondary btn-sm switch-copy-source", onClick: () => copyAction(sw, "switch"), disabled: blocked },
        { id: "paste-switch", icon: "paste", label: "Paste Switch Settings", className: "btn-secondary btn-sm", onClick: () => setPasteScope("switch"), disabled: blocked || operationClipboard?.scope !== "switch" || operationClipboard.kind !== sw.kind }, {
          id: "copy-device",
          icon: "copy",
          label: "Duplicate Switch",
          title: "Create a new switch with the same registration and functions",
          className: "btn-secondary btn-sm",
          onClick: () => { if (!blocked) copySwitch(groupRows); },
          disabled: blocked || Boolean(sw.tstatBinding),
        }, {
          id: "remove-device",
          icon: "trash",
          label: "Delete Switch",
          className: "btn-danger-ghost",
          onClick: () => removeSwitchGroup(groupRows),
          title: sw.tstatBinding ? "Remove Thermostats in the registration table; Area controls are retained" : "Delete this switch and all its functions",
          disabled: blocked || Boolean(sw.tstatBinding),
        }],
      }];
  }

  function backlightConditionValue(value: string): string {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "-") return "";
    if (/^light$/i.test(trimmed)) return "";
    if (/^master\s*on$/i.test(trimmed)) return "masterOn";
    return BACKLIGHT_LEVEL_NAMES.find((level) => level.key === trimmed || level.name === trimmed)?.key ?? trimmed;
  }

  function updateBacklightLevel(
    groupId: string,
    levelKey: string,
    fields: Partial<BacklightLevelSetting>,
  ): void {
    const head = switches.find((sw) => switchGroupId(sw) === groupId);
    if (!head) return;
    const nextLevels = effectiveBacklightLevels.map((level) =>
      level.key === levelKey ? { ...level, ...fields } : level,
    );
    onBacklightLevelsChange?.(nextLevels);
    commitSwitches(
      switches.map((sw) =>
        sw.kind === "lutronPd" ? { ...sw, backlightLevels: nextLevels } : sw,
      ),
    );
  }

  function renderPercentControl(
    groupId: string,
    level: BacklightLevelSetting,
    field: "active" | "inactive",
  ): ReactNode {
    return (
      <input
        className="cell-input scene-level-input"
        type="number"
        min="0"
        max="100"
        value={level[field]}
        onChange={(e) => updateBacklightLevel(groupId, level.key, { [field]: clampPercentValue(e.target.value) })}
        disabled={!canEdit}
      />
    );
  }

  function renderBacklightSettingPanel(sw: SwitchEntry): ReactNode {
    const selectedTargets = new Set(
      sw.backlightTarget.split(",").map((value) => value.trim()).filter(Boolean),
    );

    return (
      <BacklightSettingPanel
        targets={byScenePalladiomSwitches.map(target => ({ id: switchGroupId(target), label: [target.switchNumber, target.switchName].filter(Boolean).join(" - ") || "(No switch #)" }))}
        selection={{ mode: "editable", selectedIds: selectedTargets,
          onChange: next => updateSwitch(sw.id, { backlightTarget: Array.from(next).join(",") }) }}
        condition={backlightConditionValue(sw.backlightCondition)}
        conditions={backlightConditions}
        onConditionChange={value => updateSwitch(sw.id, { backlightCondition: value })}
        canEdit={canEdit}
      />
    );
  }
  function renderBacklightTab(): ReactNode {
    return (
      <>
        <div className="matrix-scroll">
          <table className="matrix-table master-table switch-table">
            <thead>
              <tr>
                <th>Switch #</th>
                <th>Switch Name</th>
                <th>Logic</th>
                <th>Mode</th>
                <th>Active %</th>
                <th>Inactive %</th>
              </tr>
            </thead>
            <tbody>
              {palladiomSwitches.length === 0 ? (
                <tr>
                  <td colSpan={6} className="screen-empty">
                    Palladiom switches are not registered.
                  </td>
                </tr>
              ) : (
                palladiomSwitches.flatMap((sw) => {
                  const groupId = switchGroupId(sw);
                  const levels = effectiveBacklightLevels;
                  return levels.map((level, index) => (
                    <tr key={`${groupId}-${level.key}`}>
                      {index === 0 ? (
                        <>
                          <td rowSpan={levels.length}>
                            <span className="cell-readonly">{sw.switchNumber || "-"}</span>
                          </td>
                          <td rowSpan={levels.length}>
                            <span className="cell-readonly">{sw.switchName || "-"}</span>
                          </td>
                        </>
                      ) : null}
                      <td><span className="cell-readonly">{level.name}</span></td>
                      <td>
                        <select
                          className="cell-input backlight-mode-select"
                          value={level.mode}
                          onChange={(e) =>
                            updateBacklightLevel(groupId, level.key, {
                              mode: e.target.value as BacklightLevelSetting["mode"],
                            })
                          }
                        >
                          <option value="Manual">Manual</option>
                          <option value="DBM">DBM</option>
                        </select>
                      </td>
                      <td>{renderPercentControl(groupId, level, "active")}</td>
                      <td>{renderPercentControl(groupId, level, "inactive")}</td>
                    </tr>
                  ));
                })
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  function areaKey(functionId: string, areaId: string): string {
    return `${functionId}:${areaId}`;
  }

  function toggleArea(functionId: string, areaId: string): void {
    const key = areaKey(functionId, areaId);
    setExpandedAreaKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderSettingPanel(sw: SwitchEntry): ReactNode {
    return (
      <SceneValueSettingPanel
        standardLightingAndCcoOnly
        areasWithScenes={areasWithScenes} scenes={scenes} targetGroups={settingTargetGroups} canEdit={canEdit}
        sceneForArea={areaId => sceneForArea(sw, areaId)}
        onSceneForAreaChange={(areaId, sceneId) => setSceneForArea(sw, areaId, sceneId)}
        isAreaExpanded={areaId => expandedAreaKeys.has(areaKey(sw.id, areaId))}
        onAreaToggle={areaId => toggleArea(sw.id, areaId)}
        areaHasSetting={area => areaHasSetting(sw, area.targets)}
        bulk={{
          value: area => areaBulkValues[areaKey(sw.id, area.id)] ?? "",
          onPercentChange: (area, value) => applyAreaBulkPercentValue(sw, area.targets, areaKey(sw.id, area.id), value),
          onStep: (area, delta) => stepAreaBulkValue(sw, area.targets, areaKey(sw.id, area.id), delta),
          canApply: (area, mode) => canApplyAreaBulkMode(area.targets, mode, areaKey(sw.id, area.id)),
          onApply: (area, mode) => applyAreaBulk(sw, area.targets, mode, areaKey(sw.id, area.id)),
        }}
        valueForTarget={target => getTargetValue(sw, target)}
        onTargetValueChange={(target, value) => handleTargetValueChange(sw, target, value)}
        modeForTarget={target => targetValueMode(sw, target)}
        onTargetModeChange={(target, value, mode) => handleTargetValueChange(sw, target, value, mode)}
        onTargetModeOnlyChange={(target, mode) => handleTargetModeOnlyChange(sw, target, mode)}
        standardAllowedForTarget={target => targetAllowsStandard(sw, target)}
        onTargetStep={(target, delta) => stepTargetPercent(sw, target, delta)}
      >
            <HvacSettingPanel
              targets={hvacSettingTargets}
              getValue={(targetId) => getPercent(sw, targetId)}
              onChange={(targetId, value) => {
                updateButtonSetting(sw.id, (current, row) => setCircuitSetting({ ...row, buttonSetting: current }, targetId, value).buttonSetting);
              }}
              onChangeMany={(updates) => {
                updateButtonSetting(sw.id, (current, row) =>
                  updates.reduce(
                    (next, update) => setCircuitSetting(next, update.targetId, update.value),
                    { ...row, buttonSetting: current },
                  ).buttonSetting,
                );
              }}
              defaultCollapsed={!hvacSettingTargets.some((target) => getPercent(sw, target.id).trim() !== "")}
              resetKey={sw.id}
              seasons={hvacSeasons}
              disabled={!canEdit}
            />
      </SceneValueSettingPanel>
    );
  }

  function renderSettingOverlay(): ReactNode {
    const activeSetting = switches.find((sw) => expandedFunctionIds.has(sw.id));
    const activeBacklight = switches.find((sw) => expandedBacklightIds.has(sw.id));
    const active = activeSetting ?? activeBacklight;
    if (!active) return null;
    return (
      <SettingOverlayFrame
        title={switchSettingTitle(active)}
        activeTab={activeSetting ? "sceneValue" : "backlight"}
        onTabChange={tab => tab === "sceneValue" ? openFunctionSetting(active) : openBacklightSetting(active)}
        onClose={closeSettingOverlay}
        actions={<>              {bulkApplyMode ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => applyBulkSetting(active)}
                  title="Copy this panel's settings to every checked row"
                >
                  Apply to {bulkSelectedIds.size} rows
                </button>
              ) : null}</>}
      >
        {activeSetting ? renderSettingPanel(activeSetting) : null}
        {activeBacklight ? renderBacklightSettingPanel(activeBacklight) : null}
      </SettingOverlayFrame>
    );
  }

  if (overlayHostOnly) {
    return <>{renderSettingOverlay()}</>;
  }

  return (
    <section className="card card-padded fade-in">
      {pasteError ? <p className="muted-text" role="alert">{pasteError}</p> : null}
      {directClipboard?.kind === activeKind && checkedPaste.reasons.length > 0
        ? <p className="sr-only" role="status">{checkedPaste.reasons.join(" ")}</p> : null}
      {pasteScope && operationClipboard?.scope === pasteScope && operationClipboard.kind === activeKind ? <OperationPasteDialog key={`${pasteScope}:${operationClipboard.sourceId}`} clipboard={operationClipboard} targets={operationPasteTargets(switches, operationClipboard, locations)} canEdit={canEdit && !buttonCopyBlocked} onClose={() => setPasteScope(null)} onPaste={pasteActions} /> : null}
      {!hideKindSelector ? <div
        className="scene-area-bar"
        role="tablist"
        aria-label="Switch type"
        style={{ marginBottom: "0.75rem" }}
      >
        {kindOptions.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={activeKind === opt.value}
            className={`scene-area-chip${activeKind === opt.value ? " scene-area-chip-active" : ""}${highlightedKinds.has(opt.value) ? " tab-highlighted" : ""}`}
            onClick={() => {
              onActiveKindChange(opt.value);
              setExpandedFunctionIds(new Set());
              setExpandedBacklightIds(new Set());
            }}
          >
            {opt.label}
          </button>
        ))}
      </div> : null}

      {isTstat && thermostatRegistrationPanel != null ? (
        <ViewModeBar ariaLabel="Thermostat view mode" mode={thermostatViewMode}
          onChange={setThermostatViewMode} testIdPrefix="thermostat-mode" />
      ) : null}
      {showThermostatOverview ? (
        <TstatOverview assignments={hvacAssignments} seasons={hvacSeasons} locations={locations} />
      ) : null}
      <div hidden={showThermostatOverview}>
      {isTstat && thermostatRegistrationPanel != null ? (
        <section aria-label="Thermostat registration">
          {thermostatRegistrationPanel}
          <SectionHeading>Thermostat Collection</SectionHeading>
          {thermostatWarnings.map(warning => <p className="muted-text" key={warning}>{warning}</p>)}
          {!showControlTable ? <p className="muted-text">Register a thermostat to show its controls.</p> : null}
        </section>
      ) : null}

      <>
      {isPir ? (
        <div className="pir-registration-panel">
          <div className="pir-registration-heading">
            <span className="section-subtitle">PIR Registration</span>
            <span className="muted-pill">{pirRegisteredOptions.length} PIRs</span>
          </div>
          <div className="matrix-scroll pir-registration-scroll">
            <table className="matrix-table master-table pir-registration-table">
              <colgroup>
                <col className="pir-registration-col-area" />
                <col className="pir-registration-col-qty" />
                <col />
                <col className="pir-registration-col-operation" />
              </colgroup>
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Qty</th>
                  <th>Registered PIR</th>
                  <th className="col-center">Operation</th>
                </tr>
              </thead>
              <tbody>
                {locations.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="screen-empty compact">
                      No areas are registered.
                    </td>
                  </tr>
                ) : (
                  locations.map((location) => {
                    const count = pirRegistrationCounts[location.id] ?? "";
                    const instances = pirRegisteredOptions.filter((option) => option.areaId === location.id);
                    return (
                      <tr key={location.id}>
                        <td>
                          <span className="cell-readonly">{location.name}</span>
                        </td>
                        <td>
                          <AutoGrowTextarea
                            value={count}
                            onChange={(value) => updatePirRegistration(location.id, value)}
                            disabled={!canEdit}
                          />
                        </td>
                        <td>
                          {instances.length > 0 ? (
                            <div className="pir-registration-chip-list">
                              {instances.map((option) => (
                                <span key={option.value} className="muted-pill">
                                  {option.label}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="cell-readonly">-</span>
                          )}
                        </td>
                        <td className="col-center">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => updatePirRegistration(location.id, "")}
                            disabled={!canEdit || !count}
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
      ) : null}

      {isQsm && pirRegisteredOptions.length > 0 ? (
        <p className="qsm-assignment-note">
          Each PIR must be assigned to exactly one QSM. Select another QSM to move the PIR.
        </p>
      ) : null}

      <div className="toolbar">
        <span className="muted-pill" aria-live="polite">
          {filteredSwitches.length} items
        </span>
        {hasBulkColumn && showControlTable ? (
          <>
            <span className="toolbar-spacer" />
            <button type="button" className="btn btn-secondary btn-sm switch-bulk-paste"
              style={{ visibility: directClipboard?.kind === activeKind && bulkSelectedIds.size > 0 ? "visible" : "hidden" }}
              title={checkedPaste.reasons.length ? checkedPaste.reasons.join(" ") : undefined}
              disabled={!canEdit || buttonCopyBlocked || directClipboard?.kind !== activeKind || checkedPaste.ids.length === 0}
              onClick={() => pasteDirect(checkedPaste.ids, true)}>
              {directPasteLabel} to {checkedPaste.ids.length} {checkedPaste.ids.length === 1 ? "row" : "rows"}
            </button>
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
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!canEdit || bulkSelectedIds.size < 2}
              onClick={linkSelectedSwitches}
              title="Link the checked switches so their Function/Backlight settings stay in sync permanently"
            >
              Link
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={
                !canEdit ||
                !filteredSwitches.some((sw) => bulkSelectedIds.has(sw.id) && sw.settingLinkGroupId)
              }
              onClick={unlinkSelectedSwitches}
              title="Remove the checked switches from their setting link group"
            >
              Unlink
            </button>
          </>
        ) : null}
        <button type="button" className={`btn btn-sm ${buttonClipboard || operationClipboard ? "btn-primary" : "btn-secondary"}`}
          title="Clear copied settings" disabled={!canEdit || (!buttonClipboard && !operationClipboard)}
          onClick={cancelCopy}>Clear</button>
      </div>

      {showControlTable ? <ResizableMatrixScroll className="table-workspace-scroll" variant="large">
        <table className="matrix-table master-table switch-table">
          <colgroup>
            <col className="table-col-drag" />
            <col className="table-col-no" />
            {isQsm ? (
              <>
                <col className="switch-col-qsm" />
                <col className="switch-col-qsm-pirs" />
                <col className="switch-col-operation" />
              </>
            ) : (
              <>
                {hasCciDeviceColumn ? <col className="switch-col-cci" /> : null}
                {hasCciDeviceColumn ? <col className="switch-col-cci-number" /> : null}
                {isPir ? (
                  <>
                    <col className="switch-col-pir" />
                    <col className="switch-col-pir-location" />
                  </>
                ) : (
                  <>
                    <col className="switch-col-number" />
                    <col className="switch-col-name" />
                  </>
                )}
                {hasButtonCount ? <col className="switch-col-button-count" /> : null}
                {hasButtonCount ? <col className="switch-col-button-label" /> : null}
                {hasButtonCount ? <col className="switch-col-function-drag" /> : null}
                <col className="switch-col-function" />
                {hasPriorityColumn ? <col className="switch-col-priority" /> : null}
                <col className="switch-col-condition" />
                <col className="switch-col-bulk-select" />
                <col className="switch-col-setting" />
                <col className="switch-col-setting" />
                <col className={operationStyles.column} />
                {hasButtonCount ? <col className="switch-col-button-operation" /> : null}
                <col className={operationStyles.column} />
              </>
            )}
          </colgroup>
          <thead>
            <tr>
              <th />
              <th className="col-center">No</th>
              {isQsm ? (
                <>
                  <th>QSM</th>
                  <th>Assigned PIR</th>
                  <th className="col-center">Switch Operation</th>
                </>
              ) : (
                <>
                  {hasCciDeviceColumn ? <th>Device</th> : null}
                  {hasCciDeviceColumn ? <th>CCI Number</th> : null}
                  {isPir ? (
                    <>
                      <th>PIR</th>
                      <th>Location</th>
                    </>
                  ) : (
                    <>
                      <th>{switchNumberHeader()}</th>
                      <th>{switchNameHeader()}</th>
                    </>
                  )}
                  {hasButtonCount ? <th>Buttons</th> : null}
                  {hasButtonCount ? <th>Button</th> : null}
                  {hasButtonCount ? <th aria-label="Function order" /> : null}
                  <th>{isCommand ? "Button" : "Function"}</th>
                  {hasPriorityColumn ? <th className="col-center">Priority</th> : null}
                  <th>Trigger Condition</th>
                  <th className="col-center switch-bulk-select-header">
                    <input
                      type="checkbox"
                      aria-label="Select all rows for bulk setting"
                      checked={filteredSwitches.length > 0 && filteredSwitches.every((sw) => bulkSelectedIds.has(sw.id))}
                      disabled={!canEdit || filteredSwitches.length === 0}
                      onChange={(event) => {
                        setBulkSelectedIds(
                          event.target.checked ? new Set(filteredSwitches.map((sw) => sw.id)) : new Set(),
                        );
                      }}
                    />
                  </th>
                  <th className="col-center">Function Setting</th>
                  <th className="col-center">Backlight Setting</th>
                  <th className="col-center">Function Operation</th>
                  {hasButtonCount ? <th className="col-center">Button Operation</th> : null}
                  <th className="col-center">Switch Operation</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {groupedSwitches.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="screen-empty">
                  No switches are registered. Add a row below.
                </td>
              </tr>
            ) : (
              groupedSwitches.map((groupRows) => {
                const groupId = switchGroupId(groupRows[0]);
                const groupRowSpan = groupRows.length;
                const buttonInfo = new Map<string, { index: number; rows: SwitchEntry[] }>();
                if (hasButtonCount) {
                  for (const row of groupRows) {
                    const label = row.buttonLabel || "-";
                    if (buttonInfo.has(row.id)) continue;
                    const rows = groupRows.filter((candidate) => (candidate.buttonLabel || "-") === label);
                    rows.forEach((candidate, idx) => {
                      buttonInfo.set(candidate.id, { index: idx, rows });
                    });
                  }
                }
                return (
                  <Fragment key={groupId}>
                    {isQsm ? (() => {
                      const sw = groupRows[0];
                      const isDragging = drag.draggingKey === groupId;
                      const isDropTarget = drag.dragOverInfo?.targetKey === groupId;
                      const assigned = new Set(parseQsmAssignments(sw.allocation));
                      return (
                        <tr
                          className={[
                            isDragging ? "row-dragging" : "",
                            isDropTarget && drag.dragOverInfo?.position === "before" ? "drop-before" : "",
                            isDropTarget && drag.dragOverInfo?.position === "after" ? "drop-after" : "",
                          ].filter(Boolean).join(" ")}
                          onDragOver={(e) => drag.onDragOver(e, groupId)}
                          onDrop={(e) => drag.onDrop(e, groupId)}
                        >
                          <td className="col-center drag-handle-cell">
                            <DragHandle
                              draggable={canEdit}
                              onDragStart={(e) => drag.onDragStart(e, groupId)}
                              onDragEnd={drag.onDragEnd}
                              title="Drag to reorder"
                            />
                          </td>
                          <td className="col-center">{groupDisplayNo.get(groupId) ?? ""}</td>
                          <td>
                            <span className="cell-readonly qsm-name-badge">
                              {sw.switchNumber.trim() || `QSM${groupDisplayNo.get(groupId) ?? ""}`}
                            </span>
                          </td>
                          <td>
                            {pirRegisteredOptions.length > 0 ? (
                              <div className="qsm-pir-check-list">
                                {pirRegisteredOptions.map((option) => {
                                  const isAssigned = assigned.has(option.value);
                                  return (
                                    <label
                                      key={option.value}
                                      className={`qsm-pir-check${isAssigned ? " is-assigned" : ""}`}
                                      title={
                                        isAssigned
                                          ? "This PIR is assigned to this QSM. Select another QSM to move it."
                                          : "Assign this PIR to this QSM."
                                      }
                                    >
                                      <input
                                        type="checkbox"
                                        checked={isAssigned}
                                        onClick={(event) => {
                                          if (isAssigned) event.preventDefault();
                                        }}
                                        onChange={(event) => updateQsmAssignment(sw.id, option.value, event.target.checked)}
                                        disabled={!canEdit}
                                      />
                                      <span>{option.label}</span>
                                      <span className="qsm-pir-area">{option.areaName}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            ) : (
                              <span className="cell-readonly">No PIRs registered.</span>
                            )}
                          </td>
                          <td className="col-center">
                            <OperationActions groups={[{
                              id: "qsm",
                              actions: [{ id: "duplicate-qsm", icon: "copy", label: "Duplicate QSM", title: "Create an independent QSM registration without copying PIR assignments", className: "btn-secondary btn-sm", onClick: () => { if (canEdit && !buttonCopyBlocked) addSwitch(); }, disabled: !canEdit || buttonCopyBlocked }, { id: "remove-qsm", icon: "trash", label: "Delete QSM", className: "btn-danger-ghost", onClick: () => removeSwitchGroup(groupRows), disabled: !canEdit || buttonCopyBlocked }],
                            }]} />
                            <small className="muted-text">Function / Paste not applicable: QSM registration only.</small>
                          </td>
                        </tr>
                      );
                    })() : groupRows.map((sw, rowIndex) => {
                      const isFirst = rowIndex === 0;
                      const button = buttonInfo.get(sw.id);
                      const canMoveFunction = canEdit && !buttonCopyBlocked && Boolean(button && button.rows.length > 1
                        && sw.buttonLabel.trim() && sw.buttonLabel !== "-" && !button.rows.some(hasTstatBindingQuarantine));
                      const selectedCci = cciSelection(sw);
                      const selectedCciAddresses = cciAddressOptions(selectedCci.deviceKey);
                      const isDragging = drag.draggingKey === groupId;
                      const isDropTarget = drag.dragOverInfo?.targetKey === groupId;
                      const isBeforeDrop = draggingFunctionId
                        ? functionDropTarget?.id === sw.id && functionDropTarget.position === "before"
                        : isDropTarget && drag.dragOverInfo?.position === "before" && isFirst;
                      const isAfterDrop = draggingFunctionId
                        ? functionDropTarget?.id === sw.id && functionDropTarget.position === "after"
                        : isDropTarget && drag.dragOverInfo?.position === "after" && rowIndex === groupRows.length - 1;
                      const selectedPirOptions = isPir ? selectedPirInstances(sw) : [];
                      // T-35: group color/symbol for permanently linked rows.
                      // T-62: the 🔗 checkbox-cell badge was removed; linked
                      // rows are identified by the Setting button text
                      // ("Link A" = group symbol) plus the group color.
                      const linkInfo = sw.settingLinkGroupId
                        ? settingLinkGroups.get(sw.settingLinkGroupId)
                        : undefined;
                      return (
                        <Fragment key={sw.id}>
                          <tr
                            data-switch-row-id={sw.id}
                            className={[
                              isDragging || draggingFunctionId === sw.id ? "row-dragging" : "",
                              isBeforeDrop ? "drop-before" : "",
                              isAfterDrop ? "drop-after" : "",
                            ].filter(Boolean).join(" ")}
                            onDragOver={(e) => {
                              if (!draggingFunctionId) return drag.onDragOver(e, groupId);
                              if (!canMoveFunction || draggingFunctionId === sw.id || !button?.rows.some(row => row.id === draggingFunctionId)) {
                                setFunctionDropTarget(null);
                                return;
                              }
                              e.preventDefault();
                              const rect = e.currentTarget.getBoundingClientRect();
                              const position = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
                              setFunctionDropTarget(current => current?.id === sw.id && current.position === position
                                ? current : { id: sw.id, position });
                            }}
                            onDragLeave={(e) => {
                              if (draggingFunctionId && e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) {
                                setFunctionDropTarget(current => current?.id === sw.id ? null : current);
                              }
                            }}
                            onDrop={(e) => {
                              if (!draggingFunctionId) return drag.onDrop(e, groupId);
                              e.preventDefault();
                              const rect = e.currentTarget.getBoundingClientRect();
                              moveButtonFunction(draggingFunctionId, sw.id, e.clientY < rect.top + rect.height / 2 ? "before" : "after");
                              setDraggingFunctionId(null);
                              setFunctionDropTarget(null);
                            }}
                          >
                            {isFirst ? (
                              <td className="col-center drag-handle-cell" rowSpan={groupRowSpan}>
                                <DragHandle
                                  draggable={canEdit}
                                  onDragStart={(e) => drag.onDragStart(e, groupId)}
                                  onDragEnd={drag.onDragEnd}
                                  title="Drag to reorder"
                                />
                              </td>
                            ) : null}
                            {isFirst ? (
                              <td className="col-center" rowSpan={groupRowSpan}>
                                {groupDisplayNo.get(groupId) ?? ""}
                              </td>
                            ) : null}
                            {hasCciDeviceColumn && isFirst ? (
                              <td rowSpan={groupRowSpan} className={revisionCellClass(sw.id, ["cciAssignment"])}>
                                <select
                                  className="cell-input"
                                  value={selectedCci.deviceKey}
                                  onChange={(e) => {
                                    updateGroupFields(groupId, {
                                      cciAssignment: e.target.value,
                                      allocation: "",
                                      switchNumber: "",
                                      switchName: "",
                                    });
                                  }}
                                  disabled={!canEdit}
                                >
                                  <option value="">-</option>
                                  {cciDeviceOptions.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            ) : null}
                            {isFirst ? (
                              <td rowSpan={groupRowSpan} className={revisionCellClass(sw.id, ["allocation", "switchNumber"])}>
                                {activeKind === "contact" ? (
                                  <select
                                    className="cell-input"
                                    value={selectedCci.address}
                                    onChange={(e) => {
                                      const selected = selectedCciAddresses.find((option) => option.address === e.target.value);
                                      updateGroupFields(groupId, {
                                        allocation: e.target.value,
                                        switchNumber: selected?.assigned ?? "",
                                        switchName: selected?.detail ?? "",
                                        cciAssignment: selected?.deviceKey ?? selectedCci.deviceKey,
                                      });
                                    }}
                                    disabled={!canEdit || !selectedCci.deviceKey}
                                  >
                                    <option value="">-</option>
                                    {selectedCciAddresses.map((option) => (
                                      <option key={option.value} value={option.address}>
                                        {option.label}
                                      </option>
                                    ))}
                                  </select>
                                 ) : isTstat && sw.tstatBinding ? (
                                   <span className="cell-readonly">{thermostatControlDisplayNumber(sw, hvacAssignments) || "Unassigned TSTAT"}</span>
                                 ) : isCommand ? (
                                   <AutoGrowTextarea
                                     value={sw.switchName}
                                     onChange={(value) => updateGroup(groupId, "switchName", value)}
                                     disabled={!canEdit}
                                   />
                                 ) : isPir ? (
                                  pirRegisteredOptions.length > 0 ? (
                                    <div className="pir-logic-check-list">
                                      {pirRegisteredOptions.map((option) => {
                                        const checked = selectedPirOptions.some((selected) => selected.value === option.value);
                                        return (
                                          <label key={option.value} className="pir-logic-check">
                                            <input
                                              type="checkbox"
                                              checked={checked}
                                              onChange={(event) => updatePirAssignment(groupId, option.value, event.target.checked)}
                                              disabled={!canEdit}
                                            />
                                            <span>{option.label}</span>
                                          </label>
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    <span className="cell-readonly">No PIRs registered.</span>
                                  )
                                  ) : (
                                   <AutoGrowTextarea
                                     value={sw.switchNumber}
                                    onChange={(value) => updateGroup(groupId, "switchNumber", value)}
                                    disabled={!canEdit}
                                  />
                                )}
                              </td>
                            ) : null}
                            {isFirst && isPir ? (
                              <td rowSpan={groupRowSpan} className={revisionCellClass(sw.id, ["buttonLabel"])}>
                                {selectedPirOptions.length > 0 ? (
                                  <div className="pir-location-chip-list">
                                    {Array.from(new Map(selectedPirOptions.map((option) => [option.areaId, option.areaName])).entries()).map(([areaId, areaName]) => (
                                      <span key={areaId} className="pir-location-chip">
                                        {areaName}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="cell-readonly">-</span>
                                )}
                              </td>
                            ) : null}
                            {isFirst && !isPir ? (
                              <td rowSpan={groupRowSpan} className={revisionCellClass(sw.id, ["switchName", "switchNumber"])}>
                                {activeKind === "contact" ? (
                                  <AutoGrowTextarea
                                    value={contactSwitchNumberValue(sw)}
                                    onChange={(value) => updateGroup(groupId, "switchNumber", value)}
                                    disabled={!canEdit || Boolean(contactSelectedOption(sw))}
                                  />
                                ) : isCommand ? (
                                  <AutoGrowTextarea
                                    value={sw.switchNumber}
                                    onChange={(value) => updateGroup(groupId, "switchNumber", value)}
                                    disabled={!canEdit}
                                  />
                                ) : isTstat && sw.tstatBinding ? (
                                  <span className="cell-readonly">{locations.find((area) => area.id === sw.tstatBinding?.areaId)?.name || "Unassigned"}</span>
                                ) : (
                                  <AutoGrowTextarea
                                    value={sw.switchName}
                                    onChange={(value) => updateGroup(groupId, "switchName", value)}
                                    disabled={!canEdit}
                                  />
                                )}
                              </td>
                            ) : null}
                            {activeKind === "contact" && isFirst ? (
                              <td rowSpan={groupRowSpan} className={revisionCellClass(sw.id, ["switchName"])}>
                                <AutoGrowTextarea
                                  value={contactSwitchNameValue(sw)}
                                  onChange={(value) => updateGroup(groupId, "switchName", value)}
                                  disabled={!canEdit || Boolean(contactSelectedOption(sw))}
                                />
                              </td>
                            ) : null}
                            {hasButtonCount && isFirst ? (
                              <td rowSpan={groupRowSpan} className={revisionCellClass(sw.id, ["buttonCount"])}>
                                <select
                                  className="cell-input"
                                  value={activeKind === "lutronPico" ? displayedPicoButtonCount(sw) : sw.buttonCount}
                                  onChange={(e) => updateButtonCount(groupRows, e.target.value)}
                                  disabled={!canEdit}
                                >
                                  <option value="">-</option>
                                  {(activeKind === "lutronPico"
                                    ? PICO_BUTTON_COUNT_OPTIONS
                                    : PALLADIOM_BUTTON_COUNTS
                                  ).map((count) => (
                                    <option key={count} value={count}>
                                      {count}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            ) : null}
                            {button?.index === 0 ? (
                              <td rowSpan={button.rows.length} className={revisionCellClass(sw.id, ["buttonLabel"])}>
                                <span className="cell-readonly switch-button-badge">
                                  {sw.buttonLabel || "-"}
                                </span>
                              </td>
                            ) : null}
                            {button ? (
                              <td className="col-center drag-handle-cell">
                                <DragHandle
                                  draggable={canMoveFunction}
                                  tabIndex={canMoveFunction ? 0 : undefined}
                                  glyph="⋮⋮"
                                  aria-label="Reorder Function with Up and Down"
                                  title="Drag or use Up and Down to reorder this Function"
                                  onDragStart={(event) => {
                                    event.stopPropagation();
                                    if (!canMoveFunction) { event.preventDefault(); return; }
                                    event.dataTransfer.effectAllowed = "move";
                                    event.dataTransfer.setData("text/plain", sw.id);
                                    setDraggingFunctionId(sw.id);
                                  }}
                                  onDragEnd={() => {
                                    setDraggingFunctionId(null);
                                    setFunctionDropTarget(null);
                                  }}
                                  onKeyDown={(event) => {
                                    if (!canMoveFunction || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    const up = event.key === "ArrowUp";
                                    const target = button.rows[button.index + (up ? -1 : 1)];
                                    if (target) moveButtonFunction(sw.id, target.id, up ? "before" : "after");
                                  }}
                                />
                              </td>
                            ) : null}
                            <td className={revisionCellClass(sw.id, ["buttonFunction"])}>
                              <AutoGrowTextarea
                                value={visibleButtonFunction(sw)}
                                onChange={(value) => updateSwitch(sw.id, { buttonFunction: value })}
                                disabled={!canEdit}
                              />
                            </td>
                            {hasPriorityColumn ? (
                              <td className={`col-center ${revisionCellClass(sw.id, ["isPriorityFunction"])}`}>
                                <label
                                  className={`switch-priority-check${sw.isPriorityFunction ? " is-selected" : ""}`}
                                  title={
                                    hasPriorityFunctionChoice(sw)
                                      ? "Prioritize this function when this button has multiple functions. At least one function on the same button must remain unchecked."
                                      : "Available when the same button has multiple function rows."
                                  }
                                >
                                  <input
                                    type="checkbox"
                                    checked={sw.isPriorityFunction === true}
                                    onChange={(event) => updatePriorityFunction(sw, event.target.checked)}
                                    disabled={!canEdit || !hasPriorityFunctionChoice(sw)}
                                    aria-label={`Priority function for ${[
                                      sw.switchNumber,
                                      sw.switchName,
                                      sw.buttonLabel,
                                      visibleButtonFunction(sw) || sw.buttonFunction || "Function",
                                    ].filter(Boolean).join(" / ")}`}
                                  />
                                </label>
                              </td>
                            ) : null}
                            <td className={revisionCellClass(sw.id, ["condition"])}>
                              <Combobox
                                value={sw.condition}
                                options={triggerOptions}
                                onChange={(value) => updateSwitch(sw.id, { condition: value })}
                                ariaLabel="Trigger Condition"
                                disabled={!canEdit}
                              />
                            </td>
                            <td className="col-center switch-bulk-select-cell">
                              <input
                                type="checkbox"
                                aria-label={`Select row for bulk setting`}
                                checked={bulkSelectedIds.has(sw.id)}
                                disabled={!canEdit}
                                onChange={(event) => {
                                  setBulkSelectedIds((current) => {
                                    const next = new Set(current);
                                    if (event.target.checked) next.add(sw.id);
                                    else next.delete(sw.id);
                                    return next;
                                  });
                                }}
                              />
                            </td>
                            <td className={`col-center ${revisionCellClass(sw.id, ["buttonSetting"])}`}>
                              <button
                                type="button"
                                className={[
                                  "btn",
                                  "btn-primary",
                                  "btn-sm",
                                  "setting-status-button",
                                  hasButtonSettings(sw) ? "has-setting" : "",
                                ].filter(Boolean).join(" ")}
                                style={
                                  linkInfo && hasButtonSettings(sw)
                                    ? { backgroundColor: linkInfo.color, borderColor: linkInfo.color, color: "#fff" }
                                    : undefined
                                }
                                onClick={() => openFunctionSetting(sw)}
                                title={
                                  linkInfo
                                    ? `Setting link group ${linkInfo.symbol}: Function/Backlight settings stay in sync`
                                    : undefined
                                }
                              >
                                {linkInfo ? `Link ${linkInfo.symbol}` : "Setting"}
                              </button>
                            </td>
                            <td className={`col-center ${revisionCellClass(sw.id, ["backlightTarget", "backlightCondition"])}`}>
                              {(() => {
                                const label = backlightConditionLabel(sw.backlightCondition);
                                const strong = label ? backlightStrongColor(label) : null;
                                return (
                                  <button
                                    type="button"
                                    className={[
                                      "btn",
                                      "btn-primary",
                                      "btn-sm",
                                      "setting-status-button",
                                      hasBacklightSettings(sw) ? "has-setting" : "",
                                    ].filter(Boolean).join(" ")}
                                    style={
                                      linkInfo && hasBacklightSettings(sw)
                                        ? { backgroundColor: linkInfo.color, borderColor: linkInfo.color, color: "#fff" }
                                        : strong
                                          ? { backgroundColor: strong, borderColor: strong, color: "#fff" }
                                          : undefined
                                    }
                                    onClick={() => openBacklightSetting(sw)}
                                    title={
                                      linkInfo
                                        ? `Setting link group ${linkInfo.symbol}: Function/Backlight settings stay in sync`
                                        : undefined
                                    }
                                  >
                                    {/* T-62: linked rows show the group symbol; the
                                        synced condition label stays visible after it
                                        ("Link A · Relax") since the column is wide
                                        enough for the short level names. */}
                                    {linkInfo
                                      ? label
                                        ? `Link ${linkInfo.symbol} · ${label}`
                                        : `Link ${linkInfo.symbol}`
                                      : label || "Setting"}
                                  </button>
                                );
                              })()}
                            </td>
                            <td className="col-center switch-operation-cell">
                              <OperationActions groups={functionOperations(sw, groupRows, isFirst, button?.index === 0)} />
                            </td>
                            {button?.index === 0 ? (
                              <td className="col-center switch-operation-cell" rowSpan={button.rows.length}>
                                <OperationActions groups={buttonOperations(sw, button.rows)} />
                              </td>
                            ) : null}
                            {isFirst ? <td className="col-center switch-operation-cell" rowSpan={groupRowSpan}><OperationActions groups={switchOperations(sw, groupRows)} /></td> : null}
                          </tr>
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })
            )}
          </tbody>
          {!isTstat ? <AddRowButton colSpan={colCount} onClick={addSwitch} disabled={!canEdit} title="Add row" /> : null}
        </table>
      </ResizableMatrixScroll> : null}
      {showThermostatOverview ? null : renderSettingOverlay()}
      </>
      </div>
    </section>
  );
}
