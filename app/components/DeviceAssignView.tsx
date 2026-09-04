"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import type {
  CircuitEntry,
  CurtainAssignment,
  DeviceAssignment,
  DeviceMaster,
  DryContactEntry,
  FixtureMaster,
  HvacAssignment,
  HvacSeason,
  InputMaster,
  LocationMaster,
  RevisionFieldChanges,
} from "../types";
import {
  createEmptyDeviceAssignment,
  getDeviceAddresses,
  RESERVED_VALUE,
  DALI_ADDRESSES_PER_LINE,
} from "../lib/constants";
import {
  getDaliCircuitUnits as getSyncedDaliCircuitUnits,
  isDeviceDaliModel,
  isInputAssignment,
  normalizeDaliGroupNumbers as normalizeSyncedDaliGroupNumbers,
  rebuildZoneExpansion as rebuildSyncedZoneExpansion,
  syncDeviceAssignmentsWithCircuits,
} from "../lib/deviceAssignmentSync";
import { isLowHighEndEligibleDimmingTypes, resolveLowHighEnd } from "../lib/lowHighEnd";
import {
  additionalCircuitNumbersOf,
  joinZoneCircuitNumbers,
  MAX_ADDITIONAL_ZONE_CIRCUITS,
} from "../lib/zoneCircuitMerges";
import Combobox, { type ComboboxOptionInput } from "./Combobox";
import DuplicationBanner from "./DuplicationBanner";
import DeviceSelectModal from "./DeviceSelectModal";
import CurtainAssignView from "./CurtainAssignView";
import HvacAssignView from "./HvacAssignView";
import ActionIconButton from "./ActionIconButton";
import DragHandle from "./DragHandle";
import AutoGrowTextarea from "./AutoGrowTextarea";
import ResizableMatrixScroll from "./ResizableMatrixScroll";
import { createAppId } from '../lib/id';

interface DeviceAssignViewProps {
  assignments: DeviceAssignment[];
  hvacAssignments: HvacAssignment[];
  hvacSeasons: HvacSeason[];
  curtainAssignments?: CurtainAssignment[];
  devices: DeviceMaster[];
  inputMasters: InputMaster[];
  fixtures: FixtureMaster[];
  locations: LocationMaster[];
  circuits: CircuitEntry[];
  dryContacts: DryContactEntry[];
  onChange: (next: DeviceAssignment[]) => void;
  onHvacAssignmentsChange: (next: HvacAssignment[]) => void;
  onHvacSeasonsChange: (next: HvacSeason[]) => void;
  onCurtainAssignmentsChange?: (next: CurtainAssignment[]) => void;
  revisionChanges?: RevisionFieldChanges;
  curtainRevisionChanges?: RevisionFieldChanges;
  canEdit?: boolean;
}

type CircuitMode = "designer" | "internal";
type DeviceAssignMode = "fixed" | "dali" | "hvac" | "curtain";

const PAIR_SWAP_DT = "application/x-grms-pair-swap";
const DEVICE_ASSIGN_HIDE_RESERVED_KEY = "device-assign-hide-reserved-v1";

function blockKey(a: DeviceAssignment): string {
  return a.deviceGroupId || a.id;
}

function nextDeviceNumber(
  rows: ReadonlyArray<DeviceAssignment>,
  devices: DeviceMaster[],
  model: string,
): string {
  const used = rows
    .filter((a) => a.device === model)
    .map((a) => Number.parseInt(a.deviceNum, 10))
    .filter((n): n is number => Number.isFinite(n));
  const max = used.length === 0 ? 0 : Math.max(...used);
  return String(max + 1);
}

function normalizeAddress(addr: string): string {
  const match = addr.match(/^\d+-(\d+)$/);
  return match ? match[1] : addr;
}

function normalizeControlAddress(addr: string): string {
  return normalizeAddress(addr).replace(/^\d+-/, "");
}

function isCciOrCcoAddress(addr: string): boolean {
  return /^CCI/i.test(normalizeControlAddress(addr)) || /^CCO/i.test(normalizeControlAddress(addr));
}

function isCcoAddress(addr: string): boolean {
  return /^CCO/i.test(normalizeControlAddress(addr));
}

function computeLineNumber(a: DeviceAssignment, allInGroup: DeviceAssignment[]): number {
  const idx = allInGroup.findIndex((x) => x.id === a.id);
  return idx < DALI_ADDRESSES_PER_LINE ? 1 : 2;
}

// T-59: additionalCircuitNumbers / zoneDetail are stored only while the zone
// keeps at least one additional circuit (Reserved / Clear / device change
// removes both together).
function stripZoneExtras(a: DeviceAssignment): DeviceAssignment {
  if (!("additionalCircuitNumbers" in a) && !("zoneDetail" in a)) return a;
  const next = { ...a };
  delete next.additionalCircuitNumbers;
  delete next.zoneDetail;
  return next;
}

// T-59 (spec 8): Swap moves the additional circuits and the zone Detail as a
// whole together with circuitNumber/detail.
function moveZoneExtras(base: DeviceAssignment, source: DeviceAssignment): DeviceAssignment {
  const next = stripZoneExtras(base);
  const hasExtras =
    Array.isArray(source.additionalCircuitNumbers) && source.additionalCircuitNumbers.length > 0;
  if (!hasExtras && !("zoneDetail" in source)) return next;
  const moved = next === base ? { ...next } : next;
  if (hasExtras) moved.additionalCircuitNumbers = [...(source.additionalCircuitNumbers ?? [])];
  if (typeof source.zoneDetail === "string") moved.zoneDetail = source.zoneDetail;
  return moved;
}

export default function DeviceAssignView({
  assignments,
  hvacAssignments,
  hvacSeasons,
  curtainAssignments = [],
  devices,
  inputMasters,
  fixtures,
  locations,
  circuits,
  dryContacts,
  onChange,
  onHvacAssignmentsChange,
  onHvacSeasonsChange,
  onCurtainAssignmentsChange,
  revisionChanges = {},
  curtainRevisionChanges = {},
  canEdit = true,
}: DeviceAssignViewProps) {
  const [circuitMode, setCircuitMode] = useState<CircuitMode>("designer");
  const [deviceAssignMode, setDeviceAssignMode] =
    useState<DeviceAssignMode>("fixed");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );
  const [hideReserved, setHideReserved] = useState(false);
  const [showDeviceModal, setShowDeviceModal] = useState(false);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [blockDragOverInfo, setBlockDragOverInfo] = useState<{
    targetKey: string;
    position: "before" | "after";
  } | null>(null);
  const [swapSourceId, setSwapSourceId] = useState<string | null>(null);
  // T-59: zones showing one empty "additional circuit" combobox after "+"
  // was pressed (UI-only; the value is stored once a circuit is selected).
  const [pendingExtraSlotIds, setPendingExtraSlotIds] = useState<Set<string>>(new Set());
  const scrollPosRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (scrollPosRef.current === null) return;
    const target = scrollPosRef.current;
    scrollPosRef.current = null;
    window.scrollTo({ top: target, behavior: "auto" });
    requestAnimationFrame(() => {
      window.scrollTo({ top: target, behavior: "auto" });
      requestAnimationFrame(() => {
        window.scrollTo({ top: target, behavior: "auto" });
      });
    });
  }, [collapsedGroups]);

  useEffect(() => {
    try {
      setHideReserved(window.localStorage.getItem(DEVICE_ASSIGN_HIDE_RESERVED_KEY) === "1");
    } catch {
      // UI preference only.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(DEVICE_ASSIGN_HIDE_RESERVED_KEY, hideReserved ? "1" : "0");
    } catch {
      // UI preference only.
    }
  }, [hideReserved]);

  // ---- device mode helpers ----
  function isDeviceDali(model: string): boolean {
    return isDeviceDaliModel(model, devices);
  }

  function isPwmDevice(model: string): boolean {
    const dev = findDeviceByModel(model);
    return dev?.control === "PWM" || /4P\s*20|4P20|PWM/i.test(model);
  }

  function allowedDimmingTypesForDevice(model: string): Set<string> {
    if (isDeviceDali(model)) return new Set(["DALI"]);
    if (/4A1/i.test(model)) return new Set(["Phase"]);
    if (/4S1/i.test(model)) return new Set(["On/Off"]);
    if (isPwmDevice(model)) return new Set(["On/Off", "PWM"]);
    return new Set(["On/Off", "Phase", "PWM"]);
  }

  function isCircuitAllowedForDevice(circuit: CircuitEntry, model: string): boolean {
    if (!model) return deviceAssignMode === "dali"
      ? circuit.dimmingType === "DALI"
      : circuit.dimmingType !== "DALI";
    return allowedDimmingTypesForDevice(model).has(circuit.dimmingType);
  }

  function hasRevisionChange(id: string, fields?: readonly string[]): boolean {
    const changed = revisionChanges[id];
    if (!changed) return false;
    if (!fields) return changed.length > 0;
    return changed.includes("__added") || fields.some((field) => changed.includes(field));
  }

  function revisionCellClass(row: DeviceAssignment, fields?: readonly string[]): string {
    return hasRevisionChange(row.id, fields) ? "revision-changed-cell" : "";
  }

  const tabDevices = useMemo(
    () =>
      devices
        .filter((d) => getDeviceAddresses(d.model).length > 0)
        .filter((d) =>
          deviceAssignMode === "dali"
            ? d.addressMode === "dali"
            : d.addressMode !== "dali",
        ),
    [devices, deviceAssignMode],
  );

  // T-32: master fallback for the Low End / High End columns.
  const deviceByModel = useMemo(
    () => new Map(devices.map((d) => [d.model, d])),
    [devices],
  );

  function assignedCircuitLabel(circuitNumber: string): string {
    const labels = assignments
      .filter((assignment) => {
        const value = assignment.circuitNumber.trim();
        if (value && value !== RESERVED_VALUE && value === circuitNumber) return true;
        // T-59: additional circuits of a zone count as "in use" too.
        return additionalCircuitNumbersOf(assignment).includes(circuitNumber);
      })
      .map((assignment) => {
        const device = assignment.device.trim();
        const deviceNum = assignment.deviceNum.trim();
        const address = normalizeAddress(assignment.zoneAddress).trim();
        return [
          deviceNum ? `${device}/${deviceNum}` : device,
          address,
        ].filter(Boolean).join(" ");
      })
      .filter(Boolean);
    return Array.from(new Set(labels)).join(", ");
  }

  function circuitOptionsForDevice(model: string): ComboboxOptionInput[] {
    const set = new Set<string>();
    for (const c of circuits) {
      if (!isCircuitAllowedForDevice(c, model)) continue;
      const v = circuitMode === "designer" ? c.designerNumber : c.internalNumber;
      const t = v.trim();
      if (t) set.add(t);
    }
    return Array.from(set).sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    }).map((value) => {
      const assigned = assignedCircuitLabel(value);
      return assigned ? { value, label: `${value} - ${assigned}` } : value;
    });
  }

  const areaNameById = useMemo(
    () => new Map(locations.map((location) => [location.id, location.name || "(No name)"])),
    [locations],
  );

  function dryContactOptions(): ComboboxOptionInput[] {
    const seen = new Set<string>();
    const options: ComboboxOptionInput[] = [];
    for (const entry of dryContacts) {
        const value = entry.circuit.trim();
        const key = value.toLowerCase();
        if (!value || seen.has(key)) continue;
        seen.add(key);
        const suffix = [
          areaNameById.get(entry.area) || "",
          entry.detail.trim(),
        ].filter(Boolean).join(" / ");
        options.push(suffix ? { value, label: `${value} - ${suffix}` } : value);
    }
    return options;
  }

  function findDryContact(value: string): DryContactEntry | undefined {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    return dryContacts.find((entry) => entry.circuit.trim().toLowerCase() === normalized);
  }

  function findMatchingCircuit(value: string, model = ""): CircuitEntry | undefined {
    const v = value.trim();
    if (!v) return undefined;
    return circuits.find((c) =>
      isCircuitAllowedForDevice(c, model) &&
      (circuitMode === "designer"
        ? c.designerNumber === v
        : c.internalNumber === v),
    );
  }

  function findDeviceByModel(model: string): DeviceMaster | undefined {
    return devices.find((d) => d.model === model);
  }

  function isInputRow(a: DeviceAssignment): boolean {
    return isInputAssignment(a, devices);
  }

  function inputMasterOptions(): ComboboxOptionInput[] {
    const optionMap = new Map<string, { details: Set<string>; addresses: Set<string>; isCurrent: boolean }>();
    const ensureOption = (value: string): { details: Set<string>; addresses: Set<string>; isCurrent: boolean } => {
      const existing = optionMap.get(value);
      if (existing) return existing;
      const created = { details: new Set<string>(), addresses: new Set<string>(), isCurrent: false };
      optionMap.set(value, created);
      return created;
    };

    for (const master of inputMasters) {
      const name = master.name.trim();
      if (name) ensureOption(name);
    }

    for (const assignment of assignments) {
      if (!isInputRow(assignment)) continue;
      const value = assignment.circuitNumber.trim();
      if (!value || value === RESERVED_VALUE) continue;
      const option = ensureOption(value);
      option.isCurrent = true;
      const detail = assignment.detail.trim();
      const address = normalizeAddress(assignment.zoneAddress).trim();
      if (detail) option.details.add(detail);
      if (address) option.addresses.add(address);
    }

    return Array.from(optionMap.entries()).map(([value, info]) => {
      if (!info.isCurrent) return value;
      const details = Array.from(info.details);
      const addresses = Array.from(info.addresses);
      const suffix = [
        details.length > 0 ? details.join(" / ") : "",
        addresses.length > 0 ? `(${addresses.join(", ")})` : "",
      ].filter(Boolean).join(" ");
      return suffix ? { value, label: `${value} - ${suffix}` } : value;
    });
  }

  function getDaliCircuitUnits(value: string, model: string): { detail: string }[] {
    return getSyncedDaliCircuitUnits(value, model, { circuits, devices, fixtures });
  }

  // ---- Non-DALI (fixed) expansion logic ----
  function rebuildZoneExpansion(
    list: DeviceAssignment[],
    primaryId: string,
  ): DeviceAssignment[] {
    return rebuildSyncedZoneExpansion(list, primaryId, { circuits, devices, fixtures });
  }

  // ---- DALI circuit assignment logic ----
  // Fills consecutive existing address rows without inserting new ones.
  function applyDaliCircuitAssign(
    list: DeviceAssignment[],
    rowId: string,
    rawValue: string,
  ): DeviceAssignment[] {
    const target = list.find((a) => a.id === rowId);
    if (!target || !target.deviceGroupId) return list;

    const value = rawValue.trim();

    // If the row had a previous group assignment, clear all rows in that group.
    const oldGroup = target.group;
    let working = list;
    if (oldGroup) {
      working = working.map((a) => {
        if (
          a.deviceGroupId === target.deviceGroupId &&
          a.group === oldGroup
        ) {
          return { ...a, circuitNumber: RESERVED_VALUE, area: "", detail: "", group: "" };
        }
        return a;
      });
    }

    if (!value || value === RESERVED_VALUE) {
      return normalizeDaliGroupNumbers(
        working.map((a) =>
          a.id === rowId
            ? { ...a, circuitNumber: RESERVED_VALUE, area: "", detail: "", group: "" }
            : a,
        ),
      );
    }

    const units = getDaliCircuitUnits(value, target.device);
    const count = Math.max(units.length, 1);

    // All rows in the device group (in order).
    const groupRows = working.filter(
      (a) => a.deviceGroupId === target.deviceGroupId,
    );
    const startIdx = groupRows.findIndex((a) => a.id === rowId);
    if (startIdx === -1) return working;

    if (startIdx + count > groupRows.length) {
      // Not enough address rows available.
      return working;
    }

    // Calculate next group number.
    let maxGroup = 0;
    for (const a of groupRows) {
      const g = Number.parseInt(a.group, 10);
      if (Number.isFinite(g) && g > maxGroup) maxGroup = g;
    }
    const newGroup = String(maxGroup + 1);

    const fillIds = new Set<string>();
    for (let i = 0; i < count; i++) {
      fillIds.add(groupRows[startIdx + i].id);
    }

    return normalizeDaliGroupNumbers(working.map((a) => {
      if (!fillIds.has(a.id)) return a;
      const idx =
        groupRows.findIndex((x) => x.id === a.id) - startIdx;
      const unit = units[idx];
      return {
        ...a,
        circuitNumber: value,
        detail: unit?.detail ?? "",
        group: newGroup,
      };
    }));
  }

  function normalizeDaliGroupNumbers(list: DeviceAssignment[]): DeviceAssignment[] {
    return normalizeSyncedDaliGroupNumbers(list, devices);
  }

  function clearCircuitAssignment(row: DeviceAssignment): void {
    if (!canEdit) return;
    if (!row.deviceGroupId) {
      onChange(
        assignments.map((a) =>
          a.id === row.id
            ? { ...a, circuitNumber: RESERVED_VALUE, area: "", detail: "", group: "" }
            : a,
        ),
      );
      return;
    }

    if (isDeviceDali(row.device)) {
      const next = normalizeDaliGroupNumbers(
        assignments.map((a) => {
          const sameDaliGroup =
            row.group &&
            a.deviceGroupId === row.deviceGroupId &&
            a.group === row.group;
          if (a.id !== row.id && !sameDaliGroup) return a;
          return { ...a, circuitNumber: RESERVED_VALUE, area: "", detail: "", group: "" };
        }),
      );
      onChange(next);
      return;
    }

    let next = assignments.map((a) => {
      const sameZone =
        a.deviceGroupId === row.deviceGroupId &&
        a.zoneAddress === row.zoneAddress;
      if (!sameZone) return a;
      return a.id === row.id
        ? // T-59: Clear also removes the additional circuits and zone Detail.
          stripZoneExtras({ ...a, circuitNumber: RESERVED_VALUE, area: "", detail: "", group: "" })
        : a;
    });
    next = rebuildZoneExpansion(next, row.id);
    onChange(next);
  }

  // ---- Update ----
  function update(
    id: string,
    field: keyof Omit<DeviceAssignment, "id" | "deviceGroupId">,
    value: string,
  ): void {
    if (!canEdit) return;
    const target = assignments.find((a) => a.id === id);
    if (!target) return;
    if (
      field === "detail" &&
      (target.circuitNumber.trim() === "" || target.circuitNumber === RESERVED_VALUE)
    ) {
      return;
    }
    const effectiveValue =
      field === "circuitNumber" && value.trim() === ""
        ? RESERVED_VALUE
        : value;
    const groupField = field === "device" || field === "deviceNum";
    const propagateToGroup = groupField && target.deviceGroupId !== "";
    const propagateFixedDetail =
      field === "detail" &&
      target.deviceGroupId !== "" &&
      target.circuitNumber.trim() !== "" &&
      !isDeviceDali(target.device);

    let nextList: DeviceAssignment[] = assignments.map((a) => {
      const isTarget = a.id === id;
      const isInGroup =
        propagateToGroup && a.deviceGroupId === target.deviceGroupId;
      const isSameFixedCircuit =
        propagateFixedDetail &&
        a.deviceGroupId === target.deviceGroupId &&
        a.circuitNumber === target.circuitNumber;
      if (!isTarget && !isInGroup && !isSameFixedCircuit) return a;
      const updated = { ...a, [field]: effectiveValue };
      if (isTarget && field === "circuitNumber") {
        if (isCcoAddress(target.zoneAddress)) {
          updated.circuitNumber = effectiveValue;
          updated.group = "";
          if (effectiveValue === RESERVED_VALUE) {
            updated.detail = "";
            updated.area = "";
          } else {
            const dryContact = findDryContact(effectiveValue);
            if (dryContact) {
              updated.area = dryContact.area;
              updated.detail = dryContact.detail.trim() || dryContact.circuit.trim();
            } else {
              const previousDryContact = findDryContact(target.circuitNumber);
              const previousAutoDetail = previousDryContact
                ? previousDryContact.detail.trim() || previousDryContact.circuit.trim()
                : "";
              updated.area = "";
              if (!updated.detail.trim() || (previousAutoDetail && updated.detail === previousAutoDetail)) {
                updated.detail = "";
              }
            }
          }
        } else if (isInputRow(target)) {
          updated.circuitNumber = effectiveValue;
          if (effectiveValue === RESERVED_VALUE) updated.detail = "";
          updated.group = "";
        } else {
          const match = findMatchingCircuit(effectiveValue, target.device);
          if (effectiveValue === RESERVED_VALUE) {
            updated.detail = "";
            updated.group = "";
            // T-59: Reserved clears the additional circuits and zone Detail.
            delete updated.additionalCircuitNumbers;
            delete updated.zoneDetail;
          } else if (match) {
            updated.detail = match.detail;
          } else if (isCciOrCcoAddress(target.zoneAddress)) {
            const previousMatch = findMatchingCircuit(target.circuitNumber, target.device);
            if (previousMatch?.detail && updated.detail === previousMatch.detail) {
              updated.detail = "";
            }
          }
          // T-59: the primary circuit may not duplicate an additional one.
          if (effectiveValue !== RESERVED_VALUE && updated.additionalCircuitNumbers) {
            const remaining = updated.additionalCircuitNumbers.filter(
              (entry) => entry.trim() !== effectiveValue.trim(),
            );
            if (remaining.length === 0) {
              delete updated.additionalCircuitNumbers;
              delete updated.zoneDetail;
            } else if (remaining.length !== updated.additionalCircuitNumbers.length) {
              updated.additionalCircuitNumbers = remaining;
            }
          }
        }
      }
      if (
        field === "device" &&
        updated.circuitNumber.trim() !== "" &&
        updated.circuitNumber !== RESERVED_VALUE &&
        !isInputRow(updated) &&
        !isCcoAddress(updated.zoneAddress) &&
        !findMatchingCircuit(updated.circuitNumber, effectiveValue)
      ) {
          updated.detail = "";
          updated.circuitNumber = RESERVED_VALUE;
          updated.group = "";
          // T-59: an incompatible device clears the whole zone assignment.
          delete updated.additionalCircuitNumbers;
          delete updated.zoneDetail;
      }
      if (
        field === "device" &&
        updated.additionalCircuitNumbers &&
        !isInputRow(updated) &&
        !isCcoAddress(updated.zoneAddress)
      ) {
        // T-59: drop additional circuits the new device cannot drive.
        const remaining = updated.additionalCircuitNumbers.filter((entry) =>
          findMatchingCircuit(entry, effectiveValue),
        );
        if (remaining.length === 0) {
          delete updated.additionalCircuitNumbers;
          delete updated.zoneDetail;
        } else if (remaining.length !== updated.additionalCircuitNumbers.length) {
          updated.additionalCircuitNumbers = remaining;
        }
      }
      return updated;
    });

    if (field === "circuitNumber" && target.deviceGroupId && !isInputRow(target) && !isCcoAddress(target.zoneAddress)) {
      if (isDeviceDali(target.device)) {
        nextList = applyDaliCircuitAssign(nextList, id, effectiveValue);
      } else if (target.zoneAddress) {
        nextList = rebuildZoneExpansion(nextList, id);
      }
    }

    onChange(nextList);
  }

  // T-32: Low/High End override. A non-empty value is stored on the row; an
  // empty value removes the key so the DeviceMaster default shows again.
  function updateEndOverride(
    id: string,
    field: "lowEnd" | "highEnd",
    value: string,
  ): void {
    if (!canEdit) return;
    onChange(
      assignments.map((a) => {
        if (a.id !== id) return a;
        if (value.trim() === "") {
          if (!(field in a)) return a;
          const next = { ...a };
          delete next[field];
          return next;
        }
        return { ...a, [field]: value };
      }),
    );
  }

  // ---- T-59: additional circuits per zone ("+" button, max 5 in total) ----
  function additionalCircuitOptions(a: DeviceAssignment, currentValue: string): ComboboxOptionInput[] {
    const used = new Set([a.circuitNumber.trim(), ...additionalCircuitNumbersOf(a)]);
    used.delete(currentValue);
    return circuitOptionsForDevice(a.device).filter((option) => {
      const value = typeof option === "string" ? option : option.value;
      return !used.has(value);
    });
  }

  function addExtraSlot(id: string): void {
    if (!canEdit) return;
    setPendingExtraSlotIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function removeExtraSlot(id: string): void {
    setPendingExtraSlotIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  // index >= 0 edits/removes a stored additional circuit; index -1 confirms
  // the pending slot. An empty value removes the entry; removing the last one
  // also removes zoneDetail (spec 3). T-89: zoneDetail is never auto-filled
  // (former spec 2 removed) - while it stays blank the " / " join of the live
  // circuit Details is displayed, and only user input pins a fixed value.
  function setAdditionalCircuit(id: string, index: number, value: string): void {
    if (!canEdit) return;
    const trimmed = value.trim();
    onChange(
      assignments.map((a) => {
        if (a.id !== id) return a;
        const current = a.additionalCircuitNumbers ?? [];
        let nextValues: string[] | null = null;
        if (index < 0) {
          if (!trimmed || trimmed === RESERVED_VALUE) return a;
          if (current.includes(trimmed) || a.circuitNumber.trim() === trimmed) return a;
          if (current.length >= MAX_ADDITIONAL_ZONE_CIRCUITS) return a;
          nextValues = [...current, trimmed];
        } else if (!trimmed || trimmed === RESERVED_VALUE) {
          nextValues = current.filter((_, i) => i !== index);
        } else {
          if (current.some((entry, i) => i !== index && entry === trimmed)) return a;
          if (a.circuitNumber.trim() === trimmed) return a;
          nextValues = current.map((entry, i) => (i === index ? trimmed : entry));
        }
        if (nextValues.length === 0) return stripZoneExtras(a);
        return { ...a, additionalCircuitNumbers: nextValues };
      }),
    );
    if (trimmed && trimmed !== RESERVED_VALUE) removeExtraSlot(id);
  }

  function removeAdditionalCircuit(id: string, index: number): void {
    setAdditionalCircuit(id, index, "");
  }

  function updateZoneDetail(id: string, value: string): void {
    if (!canEdit) return;
    onChange(
      assignments.map((a) => (a.id === id ? { ...a, zoneDetail: value } : a)),
    );
  }

  // ---- Renumber device numbers per mode (1, 2, 3...) ----
  function renumberDeviceNums(list: DeviceAssignment[]): DeviceAssignment[] {
    const modelCounters = new Map<string, number>();
    const groupNumMap = new Map<string, string>();
    for (const a of list) {
      if (!a.device || !a.deviceGroupId) continue;
      if (groupNumMap.has(a.deviceGroupId)) continue;
      const count = (modelCounters.get(a.device) ?? 0) + 1;
      modelCounters.set(a.device, count);
      groupNumMap.set(a.deviceGroupId, String(count));
    }
    return list.map((a) => {
      if (!a.device || !a.deviceGroupId) return a;
      const newNum = groupNumMap.get(a.deviceGroupId);
      if (newNum && a.deviceNum !== newNum) return { ...a, deviceNum: newNum };
      return a;
    });
  }

  function removeBlock(a: DeviceAssignment): void {
    if (!canEdit) return;
    if (a.deviceGroupId) {
      const remaining = assignments.filter(
        (x) => x.deviceGroupId !== a.deviceGroupId,
      );
      onChange(renumberDeviceNums(remaining));
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        next.delete(a.deviceGroupId);
        return next;
      });
      return;
    }
    const remaining = assignments.filter((x) => x.id !== a.id);
    onChange(renumberDeviceNums(remaining));
  }

  function toggleCircuitMode(): void {
    if (!canEdit) return;
    const prev = circuitMode;
    const next: CircuitMode = prev === "designer" ? "internal" : "designer";
    const convertValue = (value: string): string => {
      const v = value.trim();
      if (!v) return value;
      const match = circuits.find((c) =>
        prev === "designer" ? c.designerNumber === v : c.internalNumber === v,
      );
      if (!match) return value;
      const newVal =
        next === "designer" ? match.designerNumber : match.internalNumber;
      return newVal || value;
    };
    const converted = assignments.map((a) => {
      if (isCcoAddress(a.zoneAddress)) return a;
      const newPrimary = a.circuitNumber.trim() === "" ? a.circuitNumber : convertValue(a.circuitNumber);
      // T-59: additional circuits convert together with the primary one.
      const extras = a.additionalCircuitNumbers;
      const newExtras = extras && extras.length > 0 ? extras.map(convertValue) : undefined;
      const primaryChanged = newPrimary !== a.circuitNumber;
      const extrasChanged =
        !!extras && !!newExtras && newExtras.some((value, index) => value !== extras[index]);
      if (!primaryChanged && !extrasChanged) return a;
      const updated = { ...a };
      if (primaryChanged) updated.circuitNumber = newPrimary;
      if (extrasChanged && newExtras) updated.additionalCircuitNumbers = newExtras;
      return updated;
    });
    onChange(converted);
    setCircuitMode(next);
  }

  function toggleCollapse(groupId: string): void {
    scrollPosRef.current = window.scrollY;
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  // ---- Device select (creates address rows for any device) ----
  function handleDeviceSelect(rowId: string, deviceModel: string): void {
    if (!canEdit) return;
    const dev = findDeviceByModel(deviceModel);
    if (!dev) {
      onChange(
        assignments.map((a) =>
          a.id === rowId
            ? { ...a, device: deviceModel, deviceGroupId: "" }
            : a,
        ),
      );
      return;
    }

    const target = assignments.find((a) => a.id === rowId);
    if (!target) return;
    if (target.deviceGroupId && target.device === dev.model) return;

    const addresses = getDeviceAddresses(dev.model);

    if (target.deviceGroupId) {
      const groupSize = assignments.filter(
        (a) => a.deviceGroupId === target.deviceGroupId,
      ).length;
      const newSize = addresses.length || 1;
      if (
        !window.confirm(
          `Replace the current device group (${groupSize} rows) with "${dev.model}" (${newSize} rows). Continue?`,
        )
      ) {
        return;
      }
    } else if (addresses.length > 10) {
      if (
        !window.confirm(
          `Device "${dev.model}" will add ${addresses.length} rows. Continue?`,
        )
      ) {
        return;
      }
    }

    const baseNum = nextDeviceNumber(
      assignments.filter(
        (a) =>
          a.id !== rowId &&
          (!target.deviceGroupId ||
            a.deviceGroupId !== target.deviceGroupId),
      ),
      devices,
      dev.model,
    );

    if (addresses.length === 0) {
      onChange(
        assignments.map((a) =>
          a.id === rowId
            ? {
                ...a,
                device: dev.model,
                deviceNum: baseNum,
                deviceGroupId: "",
              }
            : a,
        ),
      );
      return;
    }

    const newGroupId = createAppId();
    const expandedRows: DeviceAssignment[] = addresses.map((addr, i) => ({
      ...createEmptyDeviceAssignment(),
      id: i === 0 ? rowId : createAppId(),
      deviceGroupId: newGroupId,
      device: dev.model,
      deviceNum: baseNum,
      zoneAddress: addr,
      circuitNumber: RESERVED_VALUE,
    }));

    if (target.deviceGroupId) {
      const groupId = target.deviceGroupId;
      const result: DeviceAssignment[] = [];
      let inserted = false;
      for (const a of assignments) {
        if (a.deviceGroupId === groupId) {
          if (!inserted) {
            result.push(...expandedRows);
            inserted = true;
          }
          continue;
        }
        result.push(a);
      }
      onChange(result);
      return;
    }

    const idx = assignments.findIndex((a) => a.id === rowId);
    if (idx === -1) return;
    onChange([
      ...assignments.slice(0, idx),
      ...expandedRows,
      ...assignments.slice(idx + 1),
    ]);
  }

  // ---- Block-level DnD reorder ----
  function handleDragStart(e: DragEvent<HTMLSpanElement>, key: string): void {
    if (!canEdit) return;
    setDraggingKey(key);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", key);
    } catch {
      /* noop */
    }
  }

  function handleDragOver(
    e: DragEvent<HTMLTableRowElement>,
    targetKey: string,
  ): void {
    if (!canEdit) return;
    const types = e.dataTransfer.types;
    const isPairSwap = types && Array.from(types).includes(PAIR_SWAP_DT);
    if (!draggingKey && !swapSourceId && !isPairSwap) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!draggingKey || isPairSwap) return;
    const target = e.currentTarget;
    const rect = target.getBoundingClientRect();
    const position: "before" | "after" =
      e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setBlockDragOverInfo((prev) => {
      if (
        prev &&
        prev.targetKey === targetKey &&
        prev.position === position
      ) {
        return prev;
      }
      return { targetKey, position };
    });
  }

  function handleDrop(
    e: DragEvent<HTMLTableRowElement>,
    targetKey: string,
  ): void {
    e.preventDefault();
    if (!canEdit) {
      setDraggingKey(null);
      setBlockDragOverInfo(null);
      return;
    }
    if (!draggingKey || draggingKey === targetKey) {
      setDraggingKey(null);
      setBlockDragOverInfo(null);
      return;
    }
    const fromRows = assignments.filter((r) => blockKey(r) === draggingKey);
    const remaining = assignments.filter((r) => blockKey(r) !== draggingKey);
    const toIdx = remaining.findIndex((r) => blockKey(r) === targetKey);
    if (toIdx === -1) {
      setDraggingKey(null);
      setBlockDragOverInfo(null);
      return;
    }
    let insertAt = toIdx;
    if (
      blockDragOverInfo &&
      blockDragOverInfo.targetKey === targetKey &&
      blockDragOverInfo.position === "after"
    ) {
      let lastIdx = toIdx;
      for (let i = toIdx + 1; i < remaining.length; i += 1) {
        if (blockKey(remaining[i]) === targetKey) lastIdx = i;
        else break;
      }
      insertAt = lastIdx + 1;
    }
    onChange([
      ...remaining.slice(0, insertAt),
      ...fromRows,
      ...remaining.slice(insertAt),
    ]);
    setDraggingKey(null);
    setBlockDragOverInfo(null);
  }

  function handleDragEnd(): void {
    setDraggingKey(null);
    setBlockDragOverInfo(null);
    setSwapSourceId(null);
  }

  // ---- Pair-swap DnD (non-DALI only) ----
  function handlePairSwapDragStart(
    e: DragEvent<HTMLSpanElement>,
    rowId: string,
  ): void {
    if (!canEdit) return;
    setSwapSourceId(rowId);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData(PAIR_SWAP_DT, rowId);
    } catch {
      /* noop */
    }
    e.stopPropagation();
  }

  function handlePairSwapDragOver(
    e: DragEvent<HTMLSpanElement>,
    targetRow: DeviceAssignment,
  ): void {
    if (!canEdit) return;
    if (!swapSourceId) return;
    const from = assignments.find((a) => a.id === swapSourceId);
    if (!from) return;
    if (
      from.deviceGroupId === "" ||
      from.deviceGroupId !== targetRow.deviceGroupId ||
      from.id === targetRow.id
    ) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    e.stopPropagation();
  }

  function handlePairSwapDrop(
    e: DragEvent<HTMLSpanElement>,
    targetRow: DeviceAssignment,
  ): void {
    e.preventDefault();
    e.stopPropagation();
    if (!canEdit) {
      setSwapSourceId(null);
      return;
    }
    const fromId = swapSourceId;
    setSwapSourceId(null);
    if (!fromId) return;
    performSwap(fromId, targetRow.id);
  }

  function performSwap(fromId: string, toId: string): void {
    if (!canEdit) return;
    const from = assignments.find((a) => a.id === fromId);
    const to = assignments.find((a) => a.id === toId);
    if (!from || !to || from.id === to.id) return;
    if (from.deviceGroupId !== to.deviceGroupId || from.deviceGroupId === "") {
      return;
    }
    if (isDeviceDali(from.device) || isDeviceDali(to.device)) {
      performDaliGroupSwap(from, to);
      return;
    }
    let nextList = assignments.map((a) => {
      if (a.id === fromId) {
        // T-59: additional circuits + zone Detail move with the swap.
        return moveZoneExtras({ ...a, circuitNumber: to.circuitNumber, detail: to.detail }, to);
      }
      if (a.id === toId) {
        return moveZoneExtras({ ...a, circuitNumber: from.circuitNumber, detail: from.detail }, from);
      }
      return a;
    });
    nextList = rebuildZoneExpansion(nextList, fromId);
    nextList = rebuildZoneExpansion(nextList, toId);
    onChange(nextList);
  }

  function performDaliGroupSwap(
    from: DeviceAssignment,
    to: DeviceAssignment,
  ): void {
    if (!canEdit) return;
    if (!from.group || !to.group || from.group === to.group) return;
    if (!isDeviceDali(from.device) || !isDeviceDali(to.device)) return;
    const fromRows = assignments.filter(
      (a) => a.deviceGroupId === from.deviceGroupId && a.group === from.group,
    );
    const toRows = assignments.filter(
      (a) => a.deviceGroupId === to.deviceGroupId && a.group === to.group,
    );
    if (fromRows.length === 0 || toRows.length === 0) return;
    const fromCircuit = fromRows[0].circuitNumber;
    const toCircuit = toRows[0].circuitNumber;
    const fromDetails = fromRows.map((row) => row.detail);
    const toDetails = toRows.map((row) => row.detail);
    const nextList = assignments.map((a) => {
      if (a.deviceGroupId === from.deviceGroupId && a.group === from.group) {
        const idx = fromRows.findIndex((row) => row.id === a.id);
        return {
          ...a,
          circuitNumber: toCircuit,
          detail: toDetails[idx] ?? toDetails[0] ?? "",
        };
      }
      if (a.deviceGroupId === to.deviceGroupId && a.group === to.group) {
        const idx = toRows.findIndex((row) => row.id === a.id);
        return {
          ...a,
          circuitNumber: fromCircuit,
          detail: fromDetails[idx] ?? fromDetails[0] ?? "",
        };
      }
      return a;
    });
    onChange(normalizeDaliGroupNumbers(nextList));
  }

  // ---- Auto-sync refs ----
  const assignmentsRef = useRef(assignments);
  assignmentsRef.current = assignments;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Auto-sync expansion rows when circuit entries or device rules change.
  useEffect(() => {
    if (!canEdit) return;
    const current = assignmentsRef.current;
    const next = syncDeviceAssignmentsWithCircuits(current, { circuits, devices, fixtures });
    if (next !== current) onChangeRef.current(next);
  }, [canEdit, circuits, devices, fixtures]);

  // ---- Computed: visible / tab-filtered ----
  const visible = useMemo(() => {
    const matchesCurrentMode = (assignment: DeviceAssignment): boolean => {
      if (!assignment.device) return true;
      return deviceAssignMode === "dali"
        ? isDeviceDali(assignment.device)
        : !isDeviceDali(assignment.device);
    };
    const remainsVisibleWhenCollapsed = (assignment: DeviceAssignment): boolean => {
      if (!matchesCurrentMode(assignment)) return false;
      return !hideReserved || (assignment.circuitNumber !== RESERVED_VALUE && assignment.circuitNumber.trim() !== "");
    };

    return assignments.filter((a, i) => {
      if (!a.deviceGroupId) return true;
      if (!collapsedGroups.has(a.deviceGroupId)) return true;
      const firstIdx = assignments.findIndex(
        (x) => x.deviceGroupId === a.deviceGroupId && remainsVisibleWhenCollapsed(x),
      );
      return firstIdx === i;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignments, collapsedGroups, deviceAssignMode, devices, hideReserved]);

  const tabVisible = useMemo(() => {
    return visible.filter((a) => {
      if (!a.device) return true; // empty rows show in active tab
      const inTab = deviceAssignMode === "dali"
        ? isDeviceDali(a.device)
        : !isDeviceDali(a.device);
      if (!inTab) return false;
      if (hideReserved && (a.circuitNumber === RESERVED_VALUE || a.circuitNumber.trim() === "")) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, deviceAssignMode, devices, hideReserved]);

  const visibleBlockSize = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of tabVisible) {
      const k = blockKey(a);
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  }, [tabVisible]);

  const visibleBlockFirstRowIds = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of tabVisible) {
      const k = blockKey(a);
      if (!map.has(k)) map.set(k, a.id);
    }
    return map;
  }, [tabVisible]);

  // Expansion row IDs (non-DALI: rows sharing zoneAddress after first occurrence)
  const expansionRowIds = useMemo(() => {
    const ids = new Set<string>();
    const seen = new Map<string, string>();
    for (const a of assignments) {
      if (!a.deviceGroupId || !a.zoneAddress) continue;
      if (isDeviceDali(a.device)) continue;
      const key = `${a.deviceGroupId}::${a.zoneAddress}`;
      if (seen.has(key)) {
        ids.add(a.id);
      } else {
        seen.set(key, a.id);
      }
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignments, devices]);

  // Unique zone count per device group (for pair-swap handle).
  const uniqueZonesPerGroup = useMemo(() => {
    const groupZones = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (!a.deviceGroupId || !a.zoneAddress) continue;
      let zones = groupZones.get(a.deviceGroupId);
      if (!zones) {
        zones = new Set();
        groupZones.set(a.deviceGroupId, zones);
      }
      zones.add(a.zoneAddress);
    }
    const map = new Map<string, number>();
    for (const [gid, zones] of groupZones) {
      map.set(gid, zones.size);
    }
    return map;
  }, [assignments]);

  // DALI: first row ID per group (for editable circuit cell).
  const daliGroupHeadIds = useMemo(() => {
    const heads = new Set<string>();
    const seen = new Set<string>();
    for (const a of assignments) {
      if (!a.deviceGroupId || !a.group || !isDeviceDali(a.device)) continue;
      const key = `${a.deviceGroupId}::${a.group}`;
      if (!seen.has(key)) {
        seen.add(key);
        heads.add(a.id);
      }
    }
    return heads;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignments, devices]);

  const dupCircuit = useMemo(() => {
    // Only check within the current tab's assignments.
    const tabAssigns = assignments.filter((a) => {
      if (!a.device) return false;
      return deviceAssignMode === "dali"
        ? isDeviceDali(a.device)
        : !isDeviceDali(a.device);
    });
    // Count unique (deviceGroupId, circuitNumber) pairs — expansion rows and
    // DALI group rows sharing the same circuit within one device group count as
    // a single occurrence, not duplicates.
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (const a of tabAssigns) {
      if (isInputRow(a)) continue;
      if (isCcoAddress(a.zoneAddress)) continue;
      const v = a.circuitNumber.trim();
      if (!v || v === RESERVED_VALUE) continue;
      const dedup = isDeviceDali(a.device)
        ? a.deviceGroupId
          ? `${a.deviceGroupId}::${a.group || a.id}::${v}`
          : `${a.id}::${v}`
        : a.deviceGroupId && a.zoneAddress
          ? `${a.deviceGroupId}::${a.zoneAddress}::${v}`
          : `${a.id}::${v}`;
      if (!seen.has(dedup)) {
        seen.add(dedup);
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      // T-59: additional circuits of the zone join the duplicate check.
      if (!isDeviceDali(a.device)) {
        for (const extra of additionalCircuitNumbersOf(a)) {
          const extraDedup =
            a.deviceGroupId && a.zoneAddress
              ? `${a.deviceGroupId}::${a.zoneAddress}::${extra}`
              : `${a.id}::${extra}`;
          if (seen.has(extraDedup)) continue;
          seen.add(extraDedup);
          counts.set(extra, (counts.get(extra) ?? 0) + 1);
        }
      }
    }
    const dup = new Set<string>();
    for (const [v, n] of counts) if (n > 1) dup.add(v);
    return dup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignments, deviceAssignMode, devices]);

  const circuitBannerItems = useMemo(
    () =>
      Array.from(dupCircuit)
        .sort()
        .map((v) => `'${v}'  is used in multiple rows`),
    [dupCircuit],
  );

  const daliAddressBannerItems = useMemo(() => {
    if (deviceAssignMode !== "dali") return [];

    const rowsByGroup = new Map<string, DeviceAssignment[]>();
    for (const a of assignments) {
      if (!a.deviceGroupId || !a.device || !isDeviceDali(a.device)) continue;
      let groupRows = rowsByGroup.get(a.deviceGroupId);
      if (!groupRows) {
        groupRows = [];
        rowsByGroup.set(a.deviceGroupId, groupRows);
      }
      groupRows.push(a);
    }

    const usage = new Map<string, Map<string, string>>();
    for (const [deviceGroupId, groupRows] of rowsByGroup) {
      const head = groupRows[0];
      const deviceLabel = `${head.device}${head.deviceNum ? ` #${head.deviceNum}` : ""}`;
      for (const row of groupRows) {
        const address = normalizeAddress(row.zoneAddress).trim();
        if (!address) continue;
        const line = computeLineNumber(row, groupRows);
        const key = `${line}::${address}`;
        let devicesAtAddress = usage.get(key);
        if (!devicesAtAddress) {
          devicesAtAddress = new Map();
          usage.set(key, devicesAtAddress);
        }
        devicesAtAddress.set(deviceGroupId, deviceLabel);
      }
    }

    const items: string[] = [];
    for (const [key, devicesAtAddress] of usage) {
      if (devicesAtAddress.size < 2) continue;
      const [line, address] = key.split("::");
      items.push(
        `LINE ${line} address ${address} overlaps: ${Array.from(devicesAtAddress.values()).join(", ")}`,
      );
    }

    const sorted = items.sort((a, b) => a.localeCompare(b));
    if (sorted.length <= 8) return sorted;
    return [...sorted.slice(0, 8), `...and ${sorted.length - 8} more duplicate addresses`];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignments, deviceAssignMode, devices]);

  // DALI LINE block info: for each DALI visible row, track line number and rowSpan
  const lineBlockInfo = useMemo(() => {
    const info = new Map<string, { lineNumber: number; isFirst: boolean; rowSpan: number }>();
    if (deviceAssignMode !== "dali") return info;

    // Group visible DALI rows by deviceGroupId
    const groupedRows = new Map<string, DeviceAssignment[]>();
    for (const a of tabVisible) {
      if (!a.deviceGroupId || !a.device || !isDeviceDali(a.device)) continue;
      let rows = groupedRows.get(a.deviceGroupId);
      if (!rows) {
        rows = [];
        groupedRows.set(a.deviceGroupId, rows);
      }
      rows.push(a);
    }

    // All rows in assignments per group (for line computation)
    const allGroupRows = new Map<string, DeviceAssignment[]>();
    for (const a of assignments) {
      if (!a.deviceGroupId || !a.device || !isDeviceDali(a.device)) continue;
      let rows = allGroupRows.get(a.deviceGroupId);
      if (!rows) {
        rows = [];
        allGroupRows.set(a.deviceGroupId, rows);
      }
      rows.push(a);
    }

    for (const [gid, visibleRows] of groupedRows) {
      const allInGroup = allGroupRows.get(gid) ?? [];
      // Compute line number for each visible row
      const lineRows = new Map<number, DeviceAssignment[]>();
      for (const a of visibleRows) {
        const line = computeLineNumber(a, allInGroup);
        let lr = lineRows.get(line);
        if (!lr) {
          lr = [];
          lineRows.set(line, lr);
        }
        lr.push(a);
      }

      for (const [line, rows] of lineRows) {
        for (let i = 0; i < rows.length; i++) {
          info.set(rows[i].id, {
            lineNumber: line,
            isFirst: i === 0,
            rowSpan: rows.length,
          });
        }
      }
    }
    return info;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabVisible, assignments, deviceAssignMode, devices]);

  // DALI Group column merge info
  const daliGroupBlockInfo = useMemo(() => {
    const info = new Map<string, { isFirst: boolean; rowSpan: number }>();
    if (deviceAssignMode !== "dali") return info;

    // Group consecutive visible DALI rows that share the same device, group, and line.
    let currentBlockIds: string[] = [];
    let currentDeviceGroup = "";
    let currentGroup = "";
    let currentLine = -1;

    const flush = () => {
      if (currentBlockIds.length > 0 && currentGroup) {
        for (let i = 0; i < currentBlockIds.length; i++) {
          info.set(currentBlockIds[i], {
            isFirst: i === 0,
            rowSpan: currentBlockIds.length,
          });
        }
      }
      currentBlockIds = [];
    };

    for (const a of tabVisible) {
      if (!a.device || !isDeviceDali(a.device)) {
        flush();
        currentDeviceGroup = "";
        currentGroup = "";
        currentLine = -1;
        continue;
      }
      const lineInfo = lineBlockInfo.get(a.id);
      const line = lineInfo?.lineNumber ?? -1;
      const grp = a.group;
      const devGroup = a.deviceGroupId;

      if (
        grp &&
        devGroup === currentDeviceGroup &&
        grp === currentGroup &&
        line === currentLine
      ) {
        currentBlockIds.push(a.id);
      } else {
        flush();
        currentDeviceGroup = devGroup;
        currentGroup = grp;
        currentLine = line;
        currentBlockIds = grp ? [a.id] : [];
      }
    }
    flush();

    return info;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabVisible, deviceAssignMode, devices, lineBlockInfo]);

  const isDali = deviceAssignMode === "dali";
  const isHvac = deviceAssignMode === "hvac";
  const isCurtain = deviceAssignMode === "curtain";
  // T-32: +2 for the Low End / High End columns (placed before Zone / Address).
  const colCount = isDali ? 14 : 11;

  // Zone/Address merge info for non-DALI
  const zoneBlockInfo = useMemo(() => {
    if (isDali) return new Map<string, { isFirst: boolean; rowSpan: number }>();
    const info = new Map<string, { isFirst: boolean; rowSpan: number }>();
    // Group consecutive visible rows by (deviceGroupId, zoneAddress)
    let currentKey = "";
    let currentIds: string[] = [];

    const flush = () => {
      for (let i = 0; i < currentIds.length; i++) {
        info.set(currentIds[i], { isFirst: i === 0, rowSpan: currentIds.length });
      }
      currentIds = [];
    };

    for (const a of tabVisible) {
      const k = a.deviceGroupId && a.zoneAddress ? `${a.deviceGroupId}::${a.zoneAddress}` : "";
      if (k && k === currentKey) {
        currentIds.push(a.id);
      } else {
        flush();
        currentKey = k;
        currentIds = k ? [a.id] : [];
      }
    }
    flush();
    return info;
  }, [tabVisible, isDali]);

  // Circuit# merge info for non-DALI.
  // Keep blocks scoped to each zone so default Reserved rows stay editable per zone.
  const circuitBlockInfo = useMemo(() => {
    const info = new Map<string, { isFirst: boolean; rowSpan: number }>();
    let currentKey = "";
    let currentIds: string[] = [];

    const flush = () => {
      for (let i = 0; i < currentIds.length; i++) {
        info.set(currentIds[i], { isFirst: i === 0, rowSpan: currentIds.length });
      }
      currentIds = [];
    };

    for (const a of tabVisible) {
      const cn = a.circuitNumber.trim();
      const zone = a.zoneAddress.trim();
      const k = a.deviceGroupId && zone && cn ? `${a.deviceGroupId}::${zone}::${cn}` : "";
      if (k && k === currentKey) {
        currentIds.push(a.id);
      } else {
        flush();
        currentKey = k;
        currentIds = k ? [a.id] : [];
      }
    }
    flush();
    return info;
  }, [tabVisible]);

  // T-55 (was T-32): per-row eligibility for the Low End / High End columns.
  // A zone (deviceGroupId + zoneAddress; expansion rows included) shows the
  // master default and accepts an override only when it has at least one
  // linked circuit whose Circuit-tab Dimming Type is DALI, PWM or Phase.
  // Unassigned / Reserved / Input / CCI/CCO rows and On/Off-only zones
  // display "-" (existing overrides are hidden, never deleted).
  const zoneEndEligibleById = useMemo(() => {
    const map = new Map<string, boolean>();
    const zoneKeyOf = (a: DeviceAssignment): string =>
      a.deviceGroupId && a.zoneAddress ? `${a.deviceGroupId}::${a.zoneAddress}` : a.id;
    const resolveTypes = (a: DeviceAssignment): string[] => {
      const value = a.circuitNumber.trim();
      if (!value || value === RESERVED_VALUE) return [];
      if (isInputRow(a) || isCciOrCcoAddress(a.zoneAddress)) return [];
      const types: string[] = [];
      const match = findMatchingCircuit(value, a.device);
      if (match) types.push(match.dimmingType);
      // T-59: additional circuits of the zone join the eligibility check.
      for (const extra of additionalCircuitNumbersOf(a)) {
        const extraMatch = findMatchingCircuit(extra, a.device);
        if (extraMatch) types.push(extraMatch.dimmingType);
      }
      return types;
    };
    const typesByZone = new Map<string, string[]>();
    for (const a of tabVisible) {
      const key = zoneKeyOf(a);
      const list = typesByZone.get(key) ?? [];
      list.push(...resolveTypes(a));
      typesByZone.set(key, list);
    }
    for (const a of tabVisible) {
      map.set(a.id, isLowHighEndEligibleDimmingTypes(typesByZone.get(zoneKeyOf(a)) ?? []));
    }
    return map;
    // resolveTypes uses component helpers that depend on circuits/mode/devices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabVisible, circuits, circuitMode, devices, deviceAssignMode]);

  const blockDisplayNo = useMemo(() => {
    const map = new Map<string, number>();
    let counter = 1;
    for (const a of tabVisible) {
      const k = blockKey(a);
      if (!map.has(k)) {
        map.set(k, counter);
        counter++;
      }
    }
    return map;
  }, [tabVisible]);

  function addDeviceFromModal(device: DeviceMaster): void {
    if (!canEdit) {
      setShowDeviceModal(false);
      return;
    }
    const newRowId = createAppId();
    const addresses = getDeviceAddresses(device.model);
    if (addresses.length === 0) {
      setShowDeviceModal(false);
      return;
    }
    const baseNum = nextDeviceNumber(assignments, devices, device.model);

    const newGroupId = createAppId();
    const expandedRows: DeviceAssignment[] = addresses.map((addr, i) => ({
      ...createEmptyDeviceAssignment(),
      id: i === 0 ? newRowId : createAppId(),
      deviceGroupId: newGroupId,
      device: device.model,
      deviceNum: baseNum,
      zoneAddress: addr,
      circuitNumber: RESERVED_VALUE,
    }));
    onChange([...assignments, ...expandedRows]);
    setShowDeviceModal(false);
  }

  return (
    <section className="card card-padded fade-in">
      {/* Sub-tab bar */}
      <div
        className="scene-area-bar"
        role="tablist"
        aria-label="Device mode"
        style={{ marginBottom: "0.75rem" }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={deviceAssignMode === "fixed"}
          className={`scene-area-chip${deviceAssignMode === "fixed" ? " scene-area-chip-active" : ""}`}
          onClick={() => setDeviceAssignMode("fixed")}
        >
          On/Off / Dimming
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={deviceAssignMode === "dali"}
          className={`scene-area-chip${deviceAssignMode === "dali" ? " scene-area-chip-active" : ""}`}
          onClick={() => setDeviceAssignMode("dali")}
        >
          DALI
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={deviceAssignMode === "hvac"}
          className={`scene-area-chip${deviceAssignMode === "hvac" ? " scene-area-chip-active" : ""}`}
          onClick={() => setDeviceAssignMode("hvac")}
        >
          HVAC
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={deviceAssignMode === "curtain"}
          className={`scene-area-chip${deviceAssignMode === "curtain" ? " scene-area-chip-active" : ""}`}
          onClick={() => setDeviceAssignMode("curtain")}
        >
          Lutron Curtain
        </button>
      </div>

      {isHvac ? (
        <HvacAssignView
          assignments={hvacAssignments}
          seasons={hvacSeasons}
          locations={locations}
          onAssignmentsChange={onHvacAssignmentsChange}
          onSeasonsChange={onHvacSeasonsChange}
          canEdit={canEdit}
        />
      ) : isCurtain ? (
        <CurtainAssignView
          assignments={curtainAssignments}
          locations={locations}
          onChange={onCurtainAssignmentsChange ?? (() => undefined)}
          revisionChanges={curtainRevisionChanges}
          canEdit={canEdit}
        />
      ) : (
        <>
      <div className="toolbar">
        <span className="toolbar-spacer" />
        {!isDali && (
          <span
            className="muted-pill"
            title="Drag handles to reorder groups"
          >
            :: Drag to reorder
          </span>
        )}
        <button
          type="button"
          className="btn btn-secondary reserved-toggle-button"
          onClick={() => setHideReserved((prev) => !prev)}
        >
          {hideReserved ? "Show Reserved" : "Hide Reserved"}
        </button>
      </div>

      <DuplicationBanner
        title="Duplicate Circuit #"
        items={circuitBannerItems}
      />
      <DuplicationBanner
        title="Duplicate DALI Address"
        items={daliAddressBannerItems}
      />

      <ResizableMatrixScroll className="table-workspace-scroll" variant="large">
        <table className="matrix-table master-table device-assign-table">
          <colgroup>
            <col className="device-assign-col-drag" />
            <col className="device-assign-col-no" />
            <col className="device-assign-col-device" />
            <col className="device-assign-col-device-num" />
            {isDali && <col className="device-assign-col-line" />}
            {isDali && <col className="device-assign-col-group" />}
            <col className="device-assign-col-low-end" />
            <col className="device-assign-col-high-end" />
            <col className="device-assign-col-zone" />
            <col className="device-assign-col-swap" />
            <col className="device-assign-col-circuit" />
            <col className="device-assign-col-detail" />
            <col className="device-assign-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th
                className="col-center"
                style={{ minWidth: 42 }}
                aria-label="Reorder"
              />
              <th className="col-center" style={{ minWidth: 44 }}>
                No
              </th>
              <th style={{ minWidth: 230 }}>Device</th>
              <th style={{ minWidth: 90 }}>Device #</th>
              {isDali && (
                <th className="col-center" style={{ minWidth: 60 }}>
                  LINE
                </th>
              )}
              {isDali && (
                <th className="col-center" style={{ minWidth: 70 }}>
                  Group
                </th>
              )}
              <th style={{ minWidth: 78 }}>Low End</th>
              <th style={{ minWidth: 78 }}>High End</th>
              <th style={{ minWidth: 130 }}>
                {isDali ? "Address" : "Zone / Address"}
              </th>
              <th className="col-center" style={{ minWidth: 36 }} aria-label="Swap" />
              <th style={{ minWidth: 200 }}>
                <div className="th-with-toggle">
                  <span>Circuit # / Input</span>
                  <button
                    type="button"
                    className="header-toggle"
                    onClick={toggleCircuitMode}
                    disabled={!canEdit}
                    title="Designer / Internal toggle"
                  >
                    {circuitMode === "designer" ? "Designer#" : "Internal#"}
                  </button>
                </div>
              </th>
              <th style={{ minWidth: 220 }}>Detail</th>
              <th className="col-center" style={{ minWidth: 100 }}>
                Operation
              </th>
            </tr>
          </thead>
          <tbody>
            {tabVisible.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="screen-empty">
                  No devices are registered yet. Add a device below.
                </td>
              </tr>
            ) : (
              tabVisible.map((a) => {
                const groupId = a.deviceGroupId;
                const collapsed =
                  groupId !== "" && collapsedGroups.has(groupId);
                const key = blockKey(a);
                const isFirstOfBlock =
                  visibleBlockFirstRowIds.get(key) === a.id;
                const isEmpty = a.device === "";
                const matched = tabDevices.some(
                  (d) => d.model === a.device,
                );

                const isBlockDragging = draggingKey === key;
                const isSwapSource = swapSourceId === a.id;
                const dropClass =
                  blockDragOverInfo && blockDragOverInfo.targetKey === key
                    ? blockDragOverInfo.position === "before"
                      ? "row-drop-before"
                      : "row-drop-after"
                    : "";
                const isReserved = a.circuitNumber === RESERVED_VALUE || a.circuitNumber.trim() === "";
                const inputRow = isInputRow(a);
                const ccoRow = isCcoAddress(a.zoneAddress);
                const trClass = [
                  collapsed ? "row-collapsed" : "",
                  isBlockDragging || isSwapSource ? "row-dragging" : "",
                  dropClass,
                ]
                  .filter(Boolean)
                  .join(" ");

                const circuitDup =
                  !inputRow &&
                  !ccoRow &&
                  ((a.circuitNumber.trim() !== "" &&
                    dupCircuit.has(a.circuitNumber.trim())) ||
                    additionalCircuitNumbersOf(a).some((value) => dupCircuit.has(value)));

                const isExpansion = !isDali && !inputRow && expansionRowIds.has(a.id);
                const isDaliGroupRow = isDali && !!a.group;
                const isDaliGroupHead = isDali && daliGroupHeadIds.has(a.id);
                const isDaliReadOnly =
                  isDali && isDaliGroupRow && !isDaliGroupHead;

                // Pair-swap handle. Non-DALI swaps zone assignments; DALI swaps
                // whole circuit groups.
                const zoneCount = uniqueZonesPerGroup.get(groupId) ?? 0;
                const daliGroupInfo = isDali ? daliGroupBlockInfo.get(a.id) : undefined;
                const showPairSwapHandle =
                  groupId !== "" &&
                  !isEmpty &&
                  (isDali
                    ? !!a.group && !!daliGroupInfo?.isFirst
                    : !isExpansion && zoneCount > 1) &&
                  !collapsed;

                const blockVisibleRows = visibleBlockSize.get(key) ?? 1;

                // Can edit circuit: non-DALI primary row, or DALI empty / group head
                const canEditCircuit =
                  !isEmpty &&
                  !collapsed &&
                  (isDali
                    ? !isDaliReadOnly
                    : !isExpansion);

                return (
                  <tr
                    key={a.id}
                    className={trClass}
                    onDragOver={(e) => handleDragOver(e, key)}
                    onDrop={(e) => handleDrop(e, key)}
                  >
                    {/* Drag handle */}
                    {isFirstOfBlock && (
                      <td className="col-center drag-handle-cell" rowSpan={blockVisibleRows}>
                        {!isEmpty ? (
                          <DragHandle
                            draggable={canEdit}
                            onDragStart={(e) => handleDragStart(e, key)}
                            onDragEnd={handleDragEnd}
                            title="Drag to reorder group"
                            aria-label="Group reorder handle"
                          />
                        ) : null}
                      </td>
                    )}

                    {/* No */}
                    {isFirstOfBlock && (
                      <td
                        className="col-center"
                        rowSpan={blockVisibleRows}
                        style={{ verticalAlign: "middle" }}
                      >
                        {blockDisplayNo.get(key) ?? ""}
                      </td>
                    )}

                    {/* Device */}
                    {isFirstOfBlock ? (
                      <td
                        className={revisionCellClass(a, ["device"])}
                        rowSpan={blockVisibleRows}
                        style={{ verticalAlign: "top" }}
                      >
                        <div className="device-cell">
                          {groupId !== "" ? (
                            <button
                              type="button"
                            className="collapse-toggle"
                            title={collapsed ? "Expand" : "Collapse"}
                              aria-label={
                                collapsed ? "Expand" : "Collapse"
                              }
                            onClick={() => toggleCollapse(groupId)}
                          >
                              {collapsed ? "▶" : "▼"}
                            </button>
                          ) : (
                            <span
                              className="collapse-spacer"
                              aria-hidden
                            />
                          )}
                          <select
                            className="cell-input"
                            value={a.device}
                            onChange={(e) =>
                              handleDeviceSelect(a.id, e.target.value)
                            }
                            disabled={collapsed || !canEdit}
                          >
                            <option value="">—</option>
                            {!matched && a.device ? (
                              <option value={a.device}>
                                {a.device} (unregistered)
                              </option>
                            ) : null}
                            {tabDevices.map((d) => (
                              <option key={d.id} value={d.model}>
                                {d.model}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>
                    ) : null}

                    {/* Device # */}
                    {isFirstOfBlock ? (
                      <td
                        className={revisionCellClass(a, ["deviceNum"])}
                        rowSpan={blockVisibleRows}
                        style={{ verticalAlign: "top" }}
                      >
                        <input
                          className="cell-input"
                          type="number"
                          min="1"
                          step="1"
                          value={a.deviceNum}
                          onChange={(e) =>
                            update(a.id, "deviceNum", e.target.value)
                          }
                          disabled={isEmpty || !canEdit}
                          aria-label="Device number"
                        />
                      </td>
                    ) : null}

                    {/* LINE (DALI only) - before Group */}
                    {isDali && (() => {
                      const li = lineBlockInfo.get(a.id);
                      if (!li || !li.isFirst) return null;
                      return (
                        <td
                          className={[
                            "col-center",
                            collapsed ? "cell-collapsed-muted" : "",
                            revisionCellClass(a, ["group"]),
                          ].filter(Boolean).join(" ")}
                          rowSpan={li.rowSpan}
                        >
                          <span className="cell-readonly">
                            {collapsed ? "" : li.lineNumber}
                          </span>
                        </td>
                      );
                    })()}

                    {/* Group (DALI only) - before Address */}
                    {isDali && (() => {
                      const gi = daliGroupBlockInfo.get(a.id);
                      if (gi && !gi.isFirst) return null;
                      return (
                        <td
                          className={[
                            "col-center",
                            collapsed ? "cell-collapsed-muted" : "",
                            revisionCellClass(a, ["group"]),
                          ].filter(Boolean).join(" ")}
                          rowSpan={gi?.rowSpan ?? 1}
                        >
                          <span className="cell-readonly">
                            {collapsed ? "" : a.group}
                          </span>
                        </td>
                      );
                    })()}

                    {/* Low End / High End (T-32) - keep as one self-contained
                        block so a future column move stays a small change.
                        Merge structure mirrors the Zone / Address cell. */}
                    {(() => {
                      const zi = zoneBlockInfo.get(a.id);
                      if (!collapsed && zi && !zi.isFirst) return null;
                      const rowSpan = collapsed ? 1 : zi?.rowSpan ?? 1;
                      const endEligible = zoneEndEligibleById.get(a.id) ?? false;
                      const resolved = resolveLowHighEnd(a, a.device, deviceByModel);
                      return (["lowEnd", "highEnd"] as const).map((field) => (
                        <td
                          key={field}
                          rowSpan={rowSpan}
                          className={[
                            collapsed ? "cell-collapsed-muted" : "",
                            revisionCellClass(a, [field]),
                          ].filter(Boolean).join(" ") || undefined}
                        >
                          {collapsed ? (
                            <span className="cell-readonly" />
                          ) : !endEligible ? (
                            <span className="cell-readonly device-assign-end-na">-</span>
                          ) : (
                            <input
                              className="cell-input"
                              type="number"
                              step="any"
                              value={resolved[field]}
                              onChange={(e) =>
                                updateEndOverride(a.id, field, e.target.value)
                              }
                              disabled={isEmpty || !canEdit}
                              aria-label={field === "lowEnd" ? "Low End" : "High End"}
                            />
                          )}
                        </td>
                      ));
                    })()}

                    {/* Zone / Address */}
                    {(() => {
                      const zi = zoneBlockInfo.get(a.id);
                      if (!collapsed && zi && !zi.isFirst) return null;
                      return (
                        <td
                          rowSpan={collapsed ? 1 : zi?.rowSpan ?? 1}
                          className={[
                            collapsed ? "cell-collapsed-muted" : "",
                            revisionCellClass(a, ["zoneAddress"]),
                          ].filter(Boolean).join(" ") || undefined}
                        >
                          <span className="cell-readonly">
                            {collapsed ? "" : normalizeAddress(a.zoneAddress)}
                          </span>
                        </td>
                      );
                    })()}

                    {/* Swap handle */}
                    {(() => {
                      const ci = isDali ? daliGroupBlockInfo.get(a.id) : circuitBlockInfo.get(a.id);
                      if (ci && !ci.isFirst) return null;
                      return (
                        <td
                          className={[
                            "col-center",
                            collapsed ? "cell-collapsed-muted" : "",
                          ].filter(Boolean).join(" ")}
                          rowSpan={ci?.rowSpan ?? 1}
                        >
                          {showPairSwapHandle ? (
                            <span
                              className="pair-swap-handle"
                              draggable={canEdit}
                              onDragStart={(e) => handlePairSwapDragStart(e, a.id)}
                              onDragOver={(e) => handlePairSwapDragOver(e, a)}
                              onDrop={(e) => handlePairSwapDrop(e, a)}
                              onDragEnd={handleDragEnd}
                              title="Swap Circuit#/Detail with another zone in this group"
                              aria-label="Pair swap handle"
                            >
                              ↔
                            </span>
                          ) : null}
                        </td>
                      );
                    })()}

                    {/* Circuit # / Input */}
                    {(() => {
                      const mergeInfo = isDali ? daliGroupBlockInfo.get(a.id) : circuitBlockInfo.get(a.id);
                      if (mergeInfo && !mergeInfo.isFirst) return null;
                      return (
                        <td
                          rowSpan={mergeInfo?.rowSpan ?? 1}
                          className={[
                            collapsed ? "cell-collapsed-muted" : "",
                            circuitDup ? "cell-duplicate" : "",
                            isReserved ? "cell-reserved" : "",
                            revisionCellClass(a, ["circuitNumber", "area", "additionalCircuitNumbers"]),
                          ].filter(Boolean).join(" ") || undefined}
                        >
                          {collapsed ? (
                            <span className="cell-readonly" />
                          ) : !canEditCircuit ? (
                            <span className="cell-readonly">
                              {a.circuitNumber}
                            </span>
                          ) : inputRow ? (
                            <div className="circuit-cell">
                              <Combobox
                                value={isReserved ? "" : a.circuitNumber}
                                options={inputMasterOptions()}
                                onChange={(v) =>
                                  update(a.id, "circuitNumber", v)
                                }
                                disabled={isEmpty || !canEdit}
                              />
                              {!isEmpty &&
                              !collapsed &&
                              a.circuitNumber.trim() !== "" &&
                              a.circuitNumber !== RESERVED_VALUE ? (
                                <button
                                  type="button"
                                  className="btn-clear-circuit"
                                  onClick={() => clearCircuitAssignment(a)}
                                  disabled={!canEdit}
                                >
                                  Clear
                                </button>
                              ) : null}
                            </div>
                          ) : ccoRow ? (
                            <div className="circuit-cell">
                              <Combobox
                                value={isReserved ? "" : a.circuitNumber}
                                options={dryContactOptions()}
                                onChange={(v) =>
                                  update(a.id, "circuitNumber", v)
                                }
                                disabled={isEmpty || !canEdit}
                              />
                              {!isEmpty &&
                              !collapsed &&
                              a.circuitNumber.trim() !== "" &&
                              a.circuitNumber !== RESERVED_VALUE ? (
                                <button
                                  type="button"
                                  className="btn-clear-circuit"
                                  onClick={() => clearCircuitAssignment(a)}
                                  disabled={!canEdit}
                                >
                                  Clear
                                </button>
                              ) : null}
                            </div>
                          ) : (
                            (() => {
                              // T-59/T-75: fixed lighting zones may carry up
                              // to 4 additional circuits. With additional
                              // circuits the top line is a read-only " & "
                              // summary of every assigned Circuit # (plus the
                              // "+" button) and the following lines are one
                              // assign row per circuit.
                              const extraValues = additionalCircuitNumbersOf(a);
                              const showZoneExtras =
                                !isDali && !isReserved && canEditCircuit;
                              const hasPendingSlot =
                                showZoneExtras && pendingExtraSlotIds.has(a.id);
                              const canAddExtra =
                                showZoneExtras &&
                                canEdit &&
                                !hasPendingSlot &&
                                extraValues.length < MAX_ADDITIONAL_ZONE_CIRCUITS;
                              const hasZoneStack =
                                showZoneExtras && extraValues.length > 0;
                              const stackedMode = hasZoneStack || hasPendingSlot;
                              const addButton = canAddExtra ? (
                                <button
                                  type="button"
                                  className="btn-clear-circuit btn-add-zone-circuit"
                                  onClick={() => addExtraSlot(a.id)}
                                  title="Assign another circuit to this zone (max 5)"
                                  aria-label="Add circuit to this zone"
                                >
                                  +
                                </button>
                              ) : null;
                              return (
                                <div className="circuit-cell-stack">
                                  {hasZoneStack ? (
                                    <div
                                      className="circuit-cell zone-line zone-circuit-summary"
                                      title="Circuits assigned to this zone"
                                    >
                                      <span className="cell-readonly zone-circuit-summary-text">
                                        {joinZoneCircuitNumbers([
                                          a.circuitNumber,
                                          ...extraValues,
                                        ])}
                                      </span>
                                      {addButton}
                                    </div>
                                  ) : null}
                                  <div
                                    className={
                                      stackedMode
                                        ? "circuit-cell zone-line zone-assign-line"
                                        : "circuit-cell"
                                    }
                                  >
                                    <Combobox
                                      value={isReserved ? "" : a.circuitNumber}
                                      options={circuitOptionsForDevice(a.device)}
                                      onChange={(v) =>
                                        update(a.id, "circuitNumber", v)
                                      }
                                      disabled={isEmpty || !canEdit}
                                    />
                                    {!isEmpty &&
                                    !collapsed &&
                                    a.circuitNumber.trim() !== "" &&
                                    a.circuitNumber !== RESERVED_VALUE ? (
                                      <button
                                        type="button"
                                        className="btn-clear-circuit"
                                        onClick={() => clearCircuitAssignment(a)}
                                        disabled={!canEdit}
                                      >
                                        Clear
                                      </button>
                                    ) : null}
                                    {hasZoneStack ? null : addButton}
                                  </div>
                                  {showZoneExtras
                                    ? extraValues.map((value, index) => (
                                        <div
                                          className="circuit-cell zone-line zone-assign-line zone-extra-circuit"
                                          key={`${a.id}-extra-${index}`}
                                        >
                                          <Combobox
                                            value={value}
                                            options={additionalCircuitOptions(a, value)}
                                            onChange={(v) =>
                                              setAdditionalCircuit(a.id, index, v)
                                            }
                                            disabled={!canEdit}
                                          />
                                          <button
                                            type="button"
                                            className="btn-clear-circuit"
                                            onClick={() =>
                                              removeAdditionalCircuit(a.id, index)
                                            }
                                            disabled={!canEdit}
                                            title="Remove this circuit from the zone"
                                            aria-label="Remove additional circuit"
                                          >
                                            −
                                          </button>
                                        </div>
                                      ))
                                    : null}
                                  {hasPendingSlot ? (
                                    <div className="circuit-cell zone-line zone-assign-line zone-extra-circuit">
                                      <Combobox
                                        value=""
                                        options={additionalCircuitOptions(a, "")}
                                        onChange={(v) =>
                                          setAdditionalCircuit(a.id, -1, v)
                                        }
                                        disabled={!canEdit}
                                      />
                                      <button
                                        type="button"
                                        className="btn-clear-circuit"
                                        onClick={() => removeExtraSlot(a.id)}
                                        title="Cancel adding a circuit"
                                        aria-label="Cancel adding a circuit"
                                      >
                                        −
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })()
                  )}
                </td>
                      );
                    })()}

                    {/* Detail */}
                    {(() => {
                      const detailMergeInfo = isDali ? undefined : circuitBlockInfo.get(a.id);
                      if (detailMergeInfo && !detailMergeInfo.isFirst) return null;
                      const detailDisabled = isEmpty || isReserved;
                      return (
                    <td
                      rowSpan={detailMergeInfo?.rowSpan ?? 1}
                      className={
                        [
                          collapsed ? "cell-collapsed-muted" : "",
                          !collapsed && isReserved ? "cell-reserved" : "",
                          revisionCellClass(a, ["detail", "zoneDetail"]),
                        ].filter(Boolean).join(" ") || undefined
                      }
                    >
                      {collapsed ? (
                        <span className="cell-readonly" />
                      ) : inputRow ? (
                        <div className="cell-with-clear">
                          <AutoGrowTextarea
                            value={a.detail}
                            onChange={(value) => update(a.id, "detail", value)}
                            disabled={detailDisabled || !canEdit}
                          />
                          {a.detail.trim() && !isReserved ? (
                            <button type="button" className="btn-clear-circuit" onClick={() => update(a.id, "detail", "")} disabled={!canEdit}>
                              Clear
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        (() => {
                          // T-59: zones with additional circuits show
                          // circuit 1 / additional circuit Details read-only
                          // and edit the zone Detail on the last line.
                          const extraValues = additionalCircuitNumbersOf(a);
                          if (extraValues.length === 0 || isDali) {
                            return (
                              <div className="cell-with-clear">
                                <AutoGrowTextarea
                                  value={a.detail}
                                  onChange={(value) => update(a.id, "detail", value)}
                                  disabled={detailDisabled || !canEdit}
                                />
                                {a.detail.trim() && !isReserved ? (
                                  <button type="button" className="btn-clear-circuit" onClick={() => update(a.id, "detail", "")} disabled={!canEdit}>
                                    Clear
                                  </button>
                                ) : null}
                              </div>
                            );
                          }
                          // T-75: line 1 = editable zone Detail (next to the
                          // " & " summary), following lines = the read-only
                          // Detail of each assigned circuit.
                          return (
                            <div className="zone-detail-stack">
                              <div
                                className="zone-detail-edit zone-line"
                                title="Zone Detail (shown in CFS and setting panels)"
                              >
                                <AutoGrowTextarea
                                  value={a.zoneDetail ?? ""}
                                  onChange={(value) => updateZoneDetail(a.id, value)}
                                  disabled={!canEdit}
                                />
                              </div>
                              <div
                                className="zone-detail-line zone-line"
                                title="Circuit 1 Detail (edit in the Circuit tab)"
                              >
                                {/* T-89: live circuit-master Detail (same as the
                                    additional circuit lines below), not the
                                    assignment.detail copy. */}
                                <span className="cell-readonly">
                                  {findMatchingCircuit(a.circuitNumber, a.device)?.detail || "-"}
                                </span>
                              </div>
                              {extraValues.map((value, index) => (
                                <div
                                  className="zone-detail-line zone-line"
                                  key={`${a.id}-extra-detail-${index}`}
                                  title={`Circuit ${index + 2} Detail (edit in the Circuit tab)`}
                                >
                                  <span className="cell-readonly">
                                    {findMatchingCircuit(value, a.device)?.detail || "-"}
                                  </span>
                                </div>
                              ))}
                            </div>
                          );
                        })()
                      )}
                    </td>
                      );
                    })()}

                    {/* Actions */}
                    {isFirstOfBlock ? (
                    <td
                      className="col-center"
                      rowSpan={blockVisibleRows}
                      style={{ verticalAlign: "top" }}
                    >
                      {!isEmpty ? (
                        <ActionIconButton
                          icon="trash"
                          label={groupId !== "" ? "Delete Device" : "Delete Assignment"}
                          className="btn-danger-ghost"
                          onClick={() => removeBlock(a)}
                          disabled={!canEdit}
                          title={
                            groupId !== ""
                              ? "Delete this device"
                              : "Delete"
                          }
                        />
                      ) : (
                        <ActionIconButton
                          icon="trash"
                          label="Delete Assignment"
                          className="btn-danger-ghost"
                          onClick={() => removeBlock(a)}
                          disabled={!canEdit}
                          title="Delete"
                        />
                      )}
                    </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={colCount}>
                <button
                  className="btn-add-row"
                  onClick={() => setShowDeviceModal(true)}
                  title="Add device"
                  disabled={!canEdit}
                >
                  + Add Device
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </ResizableMatrixScroll>
        </>
      )}

      {showDeviceModal && (
        <DeviceSelectModal
          devices={tabDevices}
          onSelect={addDeviceFromModal}
          onClose={() => setShowDeviceModal(false)}
        />
      )}
    </section>
  );
}
