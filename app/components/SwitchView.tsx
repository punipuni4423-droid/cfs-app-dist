"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  CircuitEntry,
  CfsCircuit,
  CurtainAssignment,
  DeviceAssignment,
  HvacAssignment,
  HvacSeason,
  LocationMaster,
  Scene,
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
import ActionIconButton from "./ActionIconButton";
import AutoGrowTextarea from "./AutoGrowTextarea";
import Combobox from "./Combobox";
import ResizableMatrixScroll from "./ResizableMatrixScroll";
import { buildSettingTargetGroups, hvacSettingTargets as buildHvacSettingTargets, type SettingTarget } from "../lib/settingTargets";
import HvacSettingPanel from "./HvacSettingPanel";
import CurtainActionButtons from "./CurtainActionButtons";
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
import { createAppId } from '../lib/id';

interface SwitchViewProps {
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
}

const PALLADIOM_BUTTON_COUNTS = ["1", "2", "3", "4", "4LR", "5", "6", "7", "8"];
const BY_SCENE_VALUE = "__byScene";

type CciOption = CciAssignmentOption;

function isByScenePalladiomBacklightTarget(sw: SwitchEntry): boolean {
  return sw.kind === "lutronPd" && sw.backlightCondition.trim() === BY_SCENE_VALUE;
}

interface CciDeviceOption {
  value: string;
  label: string;
}

function getPercent(sw: SwitchEntry, circuitId: string): string {
  return sw.buttonSetting.circuitSettings.find((s) => s.circuitId === circuitId)?.percentage ?? "";
}

function setCircuitSetting(sw: SwitchEntry, circuitId: string, percentage: string): SwitchEntry {
  return {
    ...sw,
    buttonSetting: {
      ...sw.buttonSetting,
      circuitSettings: setSceneSettingValue(sw.buttonSetting.circuitSettings, circuitId, percentage),
    },
  };
}

function isCurtainTarget(target: SettingTarget): boolean {
  return target.isCurtain === true || target.dimmingType === "Curtain";
}

function visibleButtonFunction(sw: SwitchEntry): string {
  const value = sw.buttonFunction.trim();
  if (!value) return "";
  if (
    (sw.kind === "lutronPd" || sw.kind === "lutronPico") &&
    value === sw.buttonLabel
  ) {
    return "";
  }
  if (/^Function\s+\d+$/i.test(value)) return "";
  return sw.buttonFunction;
}

function nextQsmNumber(switches: SwitchEntry[]): string {
  const used = switches
    .filter((sw) => sw.kind === "qsm")
    .map((sw) => Number.parseInt(sw.switchNumber.replace(/^QSM\s*/i, ""), 10))
    .filter(Number.isFinite);
  const next = used.length > 0 ? Math.max(...used) + 1 : 1;
  return `QSM${next}`;
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
}: SwitchViewProps) {
  const [expandedFunctionIds, setExpandedFunctionIds] = useState<Set<string>>(new Set());
  const [expandedBacklightIds, setExpandedBacklightIds] = useState<Set<string>>(new Set());
  const [expandedAreaKeys, setExpandedAreaKeys] = useState<Set<string>>(new Set());
  // Bulk setting: checked row ids and which panel type is applying to them.
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  const [bulkApplyMode, setBulkApplyMode] = useState<"scene" | "backlight" | null>(null);

  useEffect(() => {
    // Selections are per kind tab; keep stale ids from another tab out.
    setBulkSelectedIds(new Set());
    setBulkApplyMode(null);
  }, [activeKind]);
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
    onChange((current) => normalizeSwitchPriorityFunctions(typeof next === "function" ? next(current) : next));
  }

  useEffect(() => {
    const next = dedupeSwitchIds(switches);
    if (next !== switches && canEdit) onChange((current) => dedupeSwitchIds(current));
  }, [switches, onChange, canEdit]);

  const filteredSwitches = useMemo(
    () => switches.filter((s) => s.kind === activeKind),
    [switches, activeKind],
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
    const normalized = normalizeQsmAssignments(switches);
    if (normalized !== switches && canEdit) onChange(normalized);
  }, [normalizeQsmAssignments, switches, onChange, canEdit]);

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
      } else if (sw.backlightCondition === BY_SCENE_VALUE && current.backlightCondition !== BY_SCENE_VALUE) {
        groups.set(key, { ...current, backlightCondition: BY_SCENE_VALUE });
      }
    }
    return Array.from(groups.values());
  }, [switches]);

  const byScenePalladiomSwitches = useMemo(
    () => palladiomSwitches.filter((sw) => isByScenePalladiomBacklightTarget(sw)),
    [palladiomSwitches],
  );

  const effectiveBacklightLevels = useMemo(
    () => normalizeBacklightLevels(roomTypeBacklightLevels),
    [roomTypeBacklightLevels],
  );

  const backlightConditions = useMemo(() => {
    return effectiveBacklightLevels;
  }, [effectiveBacklightLevels]);

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
    const next = syncContactSwitchesWithCciOptions(switches, cciOptions);
    if (next !== switches && canEdit) {
      onChange((current) => syncContactSwitchesWithCciOptions(current, cciOptions));
    }
  }, [cciOptions, switches, onChange, canEdit]);

  const hasButtonCount = activeKind === "lutronPd" || activeKind === "lutronPico";
  const hasCciDeviceColumn = activeKind === "contact";
  const isCommand = activeKind === "command";
  const isPir = activeKind === "pir";
  const isQsm = activeKind === "qsm";
  const hasPriorityColumn = !isCommand && !isPir && !isQsm;
  // Bulk-select column (left of Function Setting). QSM has no setting columns.
  const hasBulkColumn = !isQsm;
  const colCount = (isCommand
    ? 10
    : isPir
      ? 9
      : isQsm
        ? 5
    : 11 + (hasButtonCount ? 2 : 0) + (hasCciDeviceColumn ? 2 : 0) + (hasPriorityColumn ? 1 : 0)) +
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
    if (isCommand) return "Command Name";
    if (activeKind === "pir") return "PIR";
    return "Switch #";
  }

  function switchNameHeader(): string {
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
    commitSwitches(
      switches.map((sw) => {
        if (switchPriorityFunctionGroupKey(sw) !== targetKey) return sw;
        const isSelected = checked && sw.id === row.id;
        return { ...sw, isPriorityFunction: isSelected ? true : undefined };
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

  function handleTargetValueChange(sw: SwitchEntry, target: SettingTarget, raw: string): void {
    const value =
      target.isOnOff ||
      ["Raise", "Lower", "0.5 sec", "Blinking (Short)", "Blinking (Long)"].includes(raw)
        ? raw
        : clampPercentValue(raw);
    updateButtonSetting(sw.id, (current, row) => setCircuitSetting({ ...row, buttonSetting: current }, target.id, value).buttonSetting);
  }

  function stepTargetPercent(sw: SwitchEntry, target: SettingTarget, delta: number): void {
    handleTargetValueChange(sw, target, stepPercentValue(getPercent(sw, target.id), delta));
  }

  function clearCircuitSetting(sw: SwitchEntry, circuitId: string): void {
    updateButtonSetting(sw.id, (current, row) => setCircuitSetting({ ...row, buttonSetting: current }, circuitId, "").buttonSetting);
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
        (next, target) => (!target.isOnOff && !isCurtainTarget(target) ? setCircuitSetting(next, target.id, value) : next),
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
        if (isCurtainTarget(target) && mode !== "clear") return next;
        const value = settingValueForBulkMode(mode, target.isOnOff, areaBulkValues[key] || "");
        return value === null ? next : setCircuitSetting(next, target.id, value);
      }, { ...row, buttonSetting: current }).buttonSetting,
    );
  }

  function canApplyAreaBulkMode(areaTargets: SettingTarget[], mode: BulkSettingMode, key: string): boolean {
    if (mode === "percent" && !clampPercentValue(areaBulkValues[key] || "")) return false;
    return areaTargets.some((target) => !isCurtainTarget(target) && bulkModeAppliesToTarget(mode, target.isOnOff));
  }

  function areaHasSetting(sw: SwitchEntry, area: SettingTarget[]): boolean {
    return area.some((target) => getPercent(sw, target.id).trim() !== "");
  }

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
        return { ...sw, backlightTarget: source.backlightTarget, backlightCondition: source.backlightCondition };
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
    if (groupRows.length === 0) return;
    const newGroupId = createAppId();
    const copiedRows = groupRows.map((row) => ({
      ...row,
      id: createAppId(),
      switchGroupId: newGroupId,
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
    const groupId = switchGroupId(groupRows[0]);
    setExpandedFunctionIds(new Set());
    setExpandedBacklightIds(new Set());
    commitSwitches((current) => normalizeQsmAssignments(current.filter((row) => switchGroupId(row) !== groupId)));
  }

  function removeFunctionRow(row: SwitchEntry, groupRows: SwitchEntry[]): void {
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
    const updateTargets = (targetId: string, checked: boolean): void => {
      const next = new Set(selectedTargets);
      if (checked) next.add(targetId);
      else next.delete(targetId);
      updateSwitch(sw.id, { backlightTarget: Array.from(next).join(",") });
    };

    return (
      <div className="scene-card switch-setting-card">
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
                onClick={() => updateSwitch(sw.id, { backlightTarget: "" })}
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
              onChange={(e) => updateSwitch(sw.id, { backlightCondition: e.target.value })}
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
                onClick={() => updateSwitch(sw.id, { backlightCondition: "" })}
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      <div className="scene-card switch-setting-card">
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
                      const selectedSceneId = sceneForArea(sw, area.id);
                      return (
                        <tr key={area.id}>
                          <td><span className="cell-readonly">{area.name || "(No name)"}</span></td>
                          <td>
                            <select
                              className="cell-input"
                              value={selectedSceneId}
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
                  const areaTargets = area.targets;
                  const bulkKey = areaKey(sw.id, area.id);
                  const open = expandedAreaKeys.has(bulkKey);
                  const hasAreaSetting = areaHasSetting(sw, areaTargets);
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
                        <span className="muted-pill">{areaTargets.length}</span>
                      </button>

                      {open ? (
                        <>
                        <div className="switch-area-bulk-panel">
                          <span className="switch-area-bulk-label">Area bulk</span>
                          <div className="scene-level-control switch-area-bulk-control">
                            <input
                              className="cell-input scene-level-input"
                              type="number"
                              min="0"
                              max="100"
                              step="1"
                              value={areaBulkValues[bulkKey] ?? ""}
                              onChange={(e) => applyAreaBulkPercentValue(sw, areaTargets, bulkKey, e.target.value)}
                              disabled={!canEdit}
                            />
                            <div className="scene-step-grid switch-step-grid" aria-label="Area bulk level adjustment">
                              <button type="button" onClick={() => stepAreaBulkValue(sw, areaTargets, bulkKey, 1)} disabled={!canEdit}>+1</button>
                              <button type="button" onClick={() => stepAreaBulkValue(sw, areaTargets, bulkKey, 10)} disabled={!canEdit}>+10</button>
                              <button type="button" onClick={() => stepAreaBulkValue(sw, areaTargets, bulkKey, -1)} disabled={!canEdit}>-1</button>
                              <button type="button" onClick={() => stepAreaBulkValue(sw, areaTargets, bulkKey, -10)} disabled={!canEdit}>-10</button>
                            </div>
                          </div>
                          <div className="switch-onoff-buttons switch-area-bulk-buttons" role="group" aria-label="Area On Off Uneffected Raise Lower 0.5 sec">
                            <button type="button" onClick={() => applyAreaBulk(sw, areaTargets, "percent", bulkKey)} disabled={!canEdit || !canApplyAreaBulkMode(areaTargets, "percent", bulkKey)}>Apply %</button>
                            <button type="button" onClick={() => applyAreaBulk(sw, areaTargets, "on", bulkKey)} disabled={!canEdit || !canApplyAreaBulkMode(areaTargets, "on", bulkKey)}>On</button>
                            <button type="button" onClick={() => applyAreaBulk(sw, areaTargets, "off", bulkKey)} disabled={!canEdit || !canApplyAreaBulkMode(areaTargets, "off", bulkKey)}>Off</button>
                            <button type="button" onClick={() => applyAreaBulk(sw, areaTargets, "blinkShort", bulkKey)} disabled={!canEdit || !canApplyAreaBulkMode(areaTargets, "blinkShort", bulkKey)}>Blinking (Short)</button>
                            <button type="button" onClick={() => applyAreaBulk(sw, areaTargets, "blinkLong", bulkKey)} disabled={!canEdit || !canApplyAreaBulkMode(areaTargets, "blinkLong", bulkKey)}>Blinking (Long)</button>
                            <button type="button" onClick={() => applyAreaBulk(sw, areaTargets, "raise", bulkKey)} disabled={!canEdit || !canApplyAreaBulkMode(areaTargets, "raise", bulkKey)}>Raise</button>
                            <button type="button" onClick={() => applyAreaBulk(sw, areaTargets, "lower", bulkKey)} disabled={!canEdit || !canApplyAreaBulkMode(areaTargets, "lower", bulkKey)}>Lower</button>
                            <button type="button" onClick={() => applyAreaBulk(sw, areaTargets, "halfSec", bulkKey)} disabled={!canEdit || !canApplyAreaBulkMode(areaTargets, "halfSec", bulkKey)}>0.5 sec</button>
                            <button type="button" onClick={() => applyAreaBulk(sw, areaTargets, "clear", bulkKey)} disabled={!canEdit || !canApplyAreaBulkMode(areaTargets, "clear", bulkKey)}>Uneffected</button>
                          </div>
                        </div>
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
                              {areaTargets.map((target) => {
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
                                        <div className="switch-onoff-buttons" role="group" aria-label="On Off Uneffected 0.5 sec">
                                          {[
                                            ["On", "On"],
                                            ["Off", "Off"],
                                            ["Blinking (Short)", "Blinking (Short)"],
                                            ["Blinking (Long)", "Blinking (Long)"],
                                            ["0.5 sec", "0.5 sec"],
                                            ["", "Uneffected"],
                                          ].map(([nextValue, label]) => (
                                            <button
                                              key={label}
                                              type="button"
                                              className={(nextValue === "" ? value === "" : value === nextValue) ? "is-active" : ""}
                                              onClick={() => handleTargetValueChange(sw, target, nextValue)}
                                              disabled={!canEdit}
                                            >
                                              {label}
                                            </button>
                                          ))}
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
                                            Uneffected
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
                        </>
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
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="card card-padded fade-in">
      <div
        className="scene-area-bar"
        role="tablist"
        aria-label="Switch type"
        style={{ marginBottom: "0.75rem" }}
      >
        {SWITCH_KIND_OPTIONS.map((opt) => (
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
      </div>

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
        {hasBulkColumn ? (
          <>
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
          </>
        ) : null}
      </div>

      <ResizableMatrixScroll className="table-workspace-scroll" variant="large">
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
                {!isCommand && !isPir ? <col className="switch-col-add" /> : null}
                {!isPir ? <col className="switch-col-function" /> : null}
                {hasPriorityColumn ? <col className="switch-col-priority" /> : null}
                <col className="switch-col-condition" />
                <col className="switch-col-bulk-select" />
                <col className="switch-col-setting" />
                <col className="switch-col-setting" />
                <col className="switch-col-row-operation" />
                <col className="switch-col-operation" />
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
                  <th className="col-center">Operation</th>
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
                  {!isCommand && !isPir ? <th className="col-center">+</th> : null}
                  {!isPir ? <th>{isCommand ? "Button" : "Function"}</th> : null}
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
                  <th className="col-center">Row</th>
                  <th className="col-center">Switch</th>
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
                const buttonInfo = new Map<string, { isFirst: boolean; rowSpan: number }>();
                if (hasButtonCount) {
                  for (const row of groupRows) {
                    const label = row.buttonLabel || "-";
                    if (buttonInfo.has(row.id)) continue;
                    const rows = groupRows.filter((candidate) => (candidate.buttonLabel || "-") === label);
                    const span = rows.length;
                    rows.forEach((candidate, idx) => {
                      buttonInfo.set(candidate.id, { isFirst: idx === 0, rowSpan: span });
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
                            <span
                              className="drag-handle"
                              draggable={canEdit}
                              onDragStart={(e) => drag.onDragStart(e, groupId)}
                              onDragEnd={drag.onDragEnd}
                              title="Drag to reorder"
                            >
                              ::
                            </span>
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
                            <ActionIconButton
                              icon="trash"
                              label="Delete QSM"
                              className="btn-danger-ghost"
                              onClick={() => removeSwitchGroup(groupRows)}
                              title="Delete QSM"
                              disabled={!canEdit}
                            />
                          </td>
                        </tr>
                      );
                    })() : groupRows.map((sw, rowIndex) => {
                      const isFirst = rowIndex === 0;
                      const selectedCci = cciSelection(sw);
                      const selectedCciAddresses = cciAddressOptions(selectedCci.deviceKey);
                      const isDragging = drag.draggingKey === groupId;
                      const isDropTarget = drag.dragOverInfo?.targetKey === groupId;
                      const isBeforeDrop = isDropTarget && drag.dragOverInfo?.position === "before" && isFirst;
                      const isAfterDrop = isDropTarget && drag.dragOverInfo?.position === "after" && rowIndex === groupRows.length - 1;
                      const selectedPirOptions = isPir ? selectedPirInstances(sw) : [];
                      return (
                        <Fragment key={`${sw.id}-${rowIndex}`}>
                          <tr
                            className={[
                              isDragging ? "row-dragging" : "",
                              isBeforeDrop ? "drop-before" : "",
                              isAfterDrop ? "drop-after" : "",
                            ].filter(Boolean).join(" ")}
                            onDragOver={(e) => drag.onDragOver(e, groupId)}
                            onDrop={(e) => drag.onDrop(e, groupId)}
                          >
                            {isFirst ? (
                              <td className="col-center drag-handle-cell" rowSpan={groupRowSpan}>
                                <span
                                  className="drag-handle"
                                  draggable={canEdit}
                                  onDragStart={(e) => drag.onDragStart(e, groupId)}
                                  onDragEnd={drag.onDragEnd}
                                  title="Drag to reorder"
                                >
                                  ::
                                </span>
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
                            {hasButtonCount && buttonInfo.get(sw.id)?.isFirst ? (
                              <td rowSpan={buttonInfo.get(sw.id)?.rowSpan ?? 1} className={revisionCellClass(sw.id, ["buttonLabel"])}>
                                <span className="cell-readonly switch-button-badge">
                                  {sw.buttonLabel || "-"}
                                </span>
                              </td>
                            ) : null}
                            {isFirst ? (
                              !hasButtonCount && !isCommand && !isPir ? (
                              <td className="col-center" rowSpan={groupRowSpan}>
                                <button
                                  type="button"
                                  className="btn-add-circuit"
                                  onClick={() => addFunctionRow(groupRows)}
                                  title="Add function"
                                  disabled={!canEdit}
                                >
                                  +
                                </button>
                              </td>
                              ) : null
                            ) : null}
                            {hasButtonCount && buttonInfo.get(sw.id)?.isFirst ? (
                              <td className="col-center" rowSpan={buttonInfo.get(sw.id)?.rowSpan ?? 1}>
                                <button
                                  type="button"
                                  className="btn-add-circuit"
                                  onClick={() => addFunctionRow(groupRows, sw.buttonLabel || "-")}
                                  title="Add function"
                                  disabled={!canEdit}
                                >
                                  +
                                </button>
                              </td>
                            ) : null}
                            {!isPir ? (
                              <td className={revisionCellClass(sw.id, ["buttonFunction"])}>
                                <AutoGrowTextarea
                                  value={visibleButtonFunction(sw)}
                                  onChange={(value) => updateSwitch(sw.id, { buttonFunction: value })}
                                  disabled={!canEdit}
                                />
                              </td>
                            ) : null}
                            {hasPriorityColumn ? (
                              <td className={`col-center ${revisionCellClass(sw.id, ["isPriorityFunction"])}`}>
                                <label
                                  className={`switch-priority-check${sw.isPriorityFunction ? " is-selected" : ""}`}
                                  title={
                                    hasPriorityFunctionChoice(sw)
                                      ? "Prioritize this function when this button has multiple functions."
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
                                onClick={() => openFunctionSetting(sw)}
                              >
                                Setting
                              </button>
                            </td>
                            <td className={`col-center ${revisionCellClass(sw.id, ["backlightTarget", "backlightCondition"])}`}>
                              <button
                                type="button"
                                className={[
                                  "btn",
                                  "btn-primary",
                                  "btn-sm",
                                  "setting-status-button",
                                  hasBacklightSettings(sw) ? "has-setting" : "",
                                ].filter(Boolean).join(" ")}
                                onClick={() => openBacklightSetting(sw)}
                              >
                                Setting
                              </button>
                            </td>
                            <td className="col-center switch-row-operation-cell">
                              <div className="switch-row-operation-stack">
                                <ActionIconButton
                                  icon="minus"
                                  label="Delete Function Row"
                                  className="btn-secondary btn-sm"
                                  onClick={() => removeFunctionRow(sw, groupRows)}
                                  title={
                                    groupRows.length <= 1
                                      ? "Use Delete Switch to remove the last row"
                                      : "Delete this function row"
                                  }
                                  disabled={!canEdit || groupRows.length <= 1}
                                />
                              </div>
                            </td>
                            {isFirst ? (
                              <td className="col-center switch-operation-cell" rowSpan={groupRowSpan}>
                                <div className="switch-operation-stack">
                                  <ActionIconButton
                                    icon="copy"
                                    label="Copy Switch"
                                    className="btn-secondary btn-sm"
                                    onClick={() => copySwitch(groupRows)}
                                    title="Copy Switch"
                                    disabled={!canEdit}
                                  />
                                  <ActionIconButton
                                    icon="trash"
                                    label="Delete Switch"
                                    className="btn-danger-ghost"
                                    onClick={() => removeSwitchGroup(groupRows)}
                                    title="Delete Switch"
                                    disabled={!canEdit}
                                  />
                                </div>
                              </td>
                            ) : null}
                          </tr>
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={colCount}>
                <button className="btn-add-row" onClick={addSwitch} title="Add row" disabled={!canEdit}>
                  + Add Row
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </ResizableMatrixScroll>
      {(() => {
        const activeSetting = switches.find((sw) => expandedFunctionIds.has(sw.id));
        const activeBacklight = switches.find((sw) => expandedBacklightIds.has(sw.id));
        const active = activeSetting ?? activeBacklight;
        if (!active) return null;
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
                <strong>
                  {switchSettingTitle(active)}
                </strong>
                <div className="setting-overlay-actions">
                  <button
                    type="button"
                    className={`btn btn-secondary btn-sm${activeSetting ? " is-active" : ""}`}
                    onClick={() => openFunctionSetting(active)}
                  >
                    Scene Value
                  </button>
                  <button
                    type="button"
                    className={`btn btn-secondary btn-sm${activeBacklight ? " is-active" : ""}`}
                    onClick={() => openBacklightSetting(active)}
                  >
                    Backlight
                  </button>
                  {bulkApplyMode ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => applyBulkSetting(active)}
                      title="Copy this panel's settings to every checked row"
                    >
                      Apply to {bulkSelectedIds.size} rows
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-danger-ghost" onClick={closeSettingOverlay}>
                    Close
                  </button>
                </div>
              </div>
              {activeSetting ? renderSettingPanel(activeSetting) : null}
              {activeBacklight ? renderBacklightSettingPanel(activeBacklight) : null}
            </div>
          </div>
        );
        return typeof document === "undefined" ? null : createPortal(overlay, document.body);
      })()}
      </>
    </section>
  );
}
