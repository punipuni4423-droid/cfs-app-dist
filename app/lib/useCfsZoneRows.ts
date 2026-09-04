import { useMemo } from "react";
import type { CfsCircuit, CfsRowKind, CircuitEntry, DeviceAssignment, LocationMaster, RoomType, SwitchEntry } from "../types";
import { BACKLIGHT_LEVEL_NAMES, DALI_ADDRESSES_PER_LINE, DEFAULT_LOCATION_COLORS } from "./constants";
import { areaAddressAssignmentKey } from "./programming";
import { additionalCircuitNumbersOf, joinZoneCircuitDetails, joinZoneCircuitNumbers } from "./zoneCircuitMerges";
import { curtainSettingId, hvacSettingId, isCfsOnlySettingRow } from "./settingTargets";
import { DEFAULT_CFS_ROW_ORDER } from "./cfsRowDisplay";
import {
  BY_SCENE_VALUE,
  OTHER_AREA_ID,
  type CfsDisplayAssignment,
  type CfsSortMode,
  type CfsZoneRow,
  type RowCircuit,
} from "./cfsTableModel";
import { hasMeaningfulBacklightSource, hasSwitchOperationalIdentity } from "./switchSync";
import { PICO_CORRIDOR_ALLOCATION, corridorPicoLedTargets } from "./picoSpecials";

export interface BuildCfsZoneRowsOptions {
  roomType: RoomType;
  circuits: CircuitEntry[];
  locations: LocationMaster[];
  locationById: Map<string, LocationMaster>;
  areaAddressByAssignmentCircuit: Map<string, string>;
  palladiomBySceneTargets: Map<string, SwitchEntry>;
  selectedAreaIds: ReadonlySet<string>;
  hiddenDeviceKeys: ReadonlySet<string>;
  sortMode: CfsSortMode;
  showCciRows?: boolean;
  rowKindOrder?: readonly CfsRowKind[];
  hiddenRowKinds?: ReadonlySet<CfsRowKind>;
}

export function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function fallbackLocationColor(locationId: string, locations: LocationMaster[]): string {
  if (!locationId || locationId === OTHER_AREA_ID) return "";
  const index = locations.findIndex((location) => location.id === locationId);
  if (index < 0) return "";
  return DEFAULT_LOCATION_COLORS[index % DEFAULT_LOCATION_COLORS.length] ?? "";
}

export function rowDimmingValues(row: CfsZoneRow): string[] {
  if (row.circuits.length === 0) {
    if (row.isIoAssignment && row.inputKind) return [row.inputKind];
    if (isPwmControlDevice(row.device)) return ["PWM"];
    return row.inputKind ? [row.inputKind] : ["-"];
  }
  return uniqueValues(
    [...row.circuits, ...(row.zoneExtraCircuits ?? [])].map((item) => item.dimmingType),
  );
}

export function rowNumberValues(row: CfsZoneRow, numberMode: "designer" | "internal"): string[] {
  if (row.isBacklight || row.isHvac || row.isCurtain) return [];
  if (row.circuits.length === 0 && row.isIoAssignment) {
    const value = (row.assignmentValue ?? "").trim();
    return value ? [value] : [];
  }
  if (row.circuits.length === 0 && row.assignmentValue) return ["-"];
  return row.circuits.length === 0
    ? ["Reserved"]
    : uniqueValues(
        row.circuits.map((item) =>
          numberMode === "designer" ? item.designerNumber : item.internalNumber || "auto",
        ),
      );
}

function rowInternalSortLabel(row: CfsZoneRow): string {
  const internalValues = rowNumberValues(row, "internal").filter(
    (value) => value && value !== "Reserved" && value !== "auto" && value !== "-",
  );
  if (internalValues[0]) return internalValues[0];
  const designerValues = rowNumberValues(row, "designer").filter((value) => value && value !== "Reserved" && value !== "-");
  return designerValues[0] ?? "";
}

function compareInternalNumberOrder(a: CfsZoneRow, b: CfsZoneRow): number {
  const aValue = rowInternalSortLabel(a);
  const bValue = rowInternalSortLabel(b);
  const aMissing = !aValue || aValue === "auto";
  const bMissing = !bValue || bValue === "auto";
  if (aMissing !== bMissing) return aMissing ? 1 : -1;
  const internalCompare = aValue.localeCompare(bValue, "en", { numeric: true });
  if (internalCompare !== 0) return internalCompare;
  return compareDeviceOrder(a, b);
}

function compareAreaOrder(
  a: CfsZoneRow,
  b: CfsZoneRow,
  locationOrderById: Map<string, number>,
): number {
  const aIndex = locationOrderById.get(a.locationId);
  const bIndex = locationOrderById.get(b.locationId);
  const aOther = a.locationId === OTHER_AREA_ID || aIndex === undefined;
  const bOther = b.locationId === OTHER_AREA_ID || bIndex === undefined;
  if (aOther !== bOther) return aOther ? 1 : -1;
  if (!aOther && !bOther && aIndex !== bIndex) return aIndex - bIndex;
  return 0;
}

export function rowZoneValues(row: CfsZoneRow): string[] {
  // Curtain rows never carry a zone/address; without this guard they would
  // fall back to "Reserved", which is wrong for Lutron Curtain assignments.
  if (row.isCurtain) return [];
  return [row.address || row.zone || "Reserved"];
}

export function isReservedCfsRow(row: CfsZoneRow): boolean {
  if (row.isIoAssignment && (row.assignmentValue || row.assignmentDetail || row.location)) return false;
  return row.circuits.length === 0 && !row.isHvac && !row.isCurtain && !row.isBacklight && !row.assignmentValue;
}

function isQseIoDevice(device: string): boolean {
  return /QSE[\s-]*IO/.test(device.toUpperCase());
}

function isWciDevice(device: string): boolean {
  const normalized = device.toUpperCase();
  return /(^|[\s-])WCI($|[\s-])/.test(normalized) || /QSE[\s-]*CI[\s-]*WCI/.test(normalized);
}

function hasLightingCircuitLink(row: CfsZoneRow): boolean {
  return row.circuits.some((circuit) => {
    const designerNumber = circuit.designerNumber.trim();
    const dimmingType = circuit.dimmingType.trim().toUpperCase();
    return designerNumber.length > 0 && dimmingType !== "HVAC" && dimmingType !== "BACKLIGHT LOGIC";
  });
}

export function cfsRowKind(row: CfsZoneRow): CfsRowKind {
  if (row.rowKind) return row.rowKind;
  if (row.isBacklight) return "backlight";
  if (row.isHvac) return "hvac";
  if (row.isCurtain) return "curtain";
  if (hasLightingCircuitLink(row)) return "lighting";
  const address = row.address || row.zone;
  if (isCcoAddress(address)) return "cco";
  if (isCciAddress(address)) return "cco";
  return "cco";
}

function isPwmControlDevice(device: string): boolean {
  return /4P\s*20|4P20|PWM/i.test(device);
}

function cfsDimmingTypeForAssignment(device: string, dimmingType: string): string {
  return isPwmControlDevice(device) ? "PWM" : dimmingType || "-";
}

function isFourSControlDevice(device: string): boolean {
  return /4S\d+/i.test(device);
}

function isDeferredAreaSortCcoRow(row: CfsZoneRow): boolean {
  if (hasLightingCircuitLink(row)) return false;
  if (!isCcoAddress(row.address || row.zone)) return false;
  return isQseIoDevice(row.device) || isFourSControlDevice(row.device);
}

function ccoCciSortPriority(row: CfsZoneRow): number {
  const address = row.address || row.zone;
  if (isCcoAddress(address)) return 0;
  if (isCciAddress(address)) return 1;
  return 2;
}

function rowSortPriority(row: CfsZoneRow): number {
  if (row.isHvac) return 900;
  if (row.isCurtain) return 850;
  if (row.isBacklight) return 910;
  if (hasLightingCircuitLink(row)) return 0;
  const address = row.address || row.zone;
  if (isCcoAddress(address)) return 10;
  if (isCciAddress(address)) return 30;
  return 20;
}

function compareRowsWithSortPriority(
  a: CfsZoneRow,
  b: CfsZoneRow,
  compareRegularRows: (left: CfsZoneRow, right: CfsZoneRow) => number,
): number {
  const priorityCompare = rowSortPriority(a) - rowSortPriority(b);
  if (priorityCompare !== 0) return priorityCompare;
  if (a.isHvac || a.isBacklight || b.isHvac || b.isBacklight) {
    return a.orderIndex - b.orderIndex;
  }
  return compareRegularRows(a, b);
}

function deviceSortPriority(row: CfsZoneRow): number {
  if (row.isHvac) return 900;
  if (row.isCurtain) return 850;
  if (row.isBacklight) return 910;

  const normalized = row.device.toUpperCase();
  if (/4A\d*/.test(normalized)) return 10;
  if (/4P\s*20|4P20/.test(normalized)) return 20;
  if (/DAL|DALI/.test(normalized)) return 30;
  if (isFourSControlDevice(normalized)) return 40;
  if (isQseIoDevice(row.device)) {
    const hasLightingLink = hasLightingCircuitLink(row);
    const addressPriority = ccoCciSortPriority(row);
    if (hasLightingLink && addressPriority === 0) return 50;
    if (hasLightingLink) return 55;
    if (addressPriority === 0) return 70;
    if (addressPriority === 1) return 75;
    return 78;
  }
  if (isWciDevice(row.device)) {
    return hasLightingCircuitLink(row) ? 60 : 80;
  }
  return 90;
}

function compareDeviceOrder(a: CfsZoneRow, b: CfsZoneRow): number {
  const priorityCompare = deviceSortPriority(a) - deviceSortPriority(b);
  if (priorityCompare !== 0) return priorityCompare;
  const deviceNumCompare = a.deviceNum.localeCompare(b.deviceNum, "ja", { numeric: true });
  if (deviceNumCompare !== 0) return deviceNumCompare;
  const deviceCompare = a.device.localeCompare(b.device, "ja", { numeric: true });
  if (deviceCompare !== 0) return deviceCompare;
  const controlCompare = ccoCciSortPriority(a) - ccoCciSortPriority(b);
  if (controlCompare !== 0) return controlCompare;
  return a.orderIndex - b.orderIndex;
}

function sortRowsByDeviceSequence(rows: CfsZoneRow[]): CfsZoneRow[] {
  return [...rows].sort(compareDeviceOrder);
}

function sortRowsByAreaSequence(rows: CfsZoneRow[], locations: LocationMaster[]): CfsZoneRow[] {
  const locationOrderById = new Map(locations.map((location, index) => [location.id, index]));
  const deferredCcoRows: CfsZoneRow[] = [];
  const areaSortableRows: CfsZoneRow[] = [];
  rows.forEach((row) => {
    if (isDeferredAreaSortCcoRow(row)) deferredCcoRows.push(row);
    else areaSortableRows.push(row);
  });
  const sortedByArea = areaSortableRows.sort((a, b) => {
    const areaCompare = compareAreaOrder(a, b, locationOrderById);
    if (areaCompare !== 0) return areaCompare;
    return compareRowsWithSortPriority(a, b, compareDeviceOrder);
  });
  return [...sortedByArea, ...sortRowsByDeviceSequence(deferredCcoRows)];
}

export function locationSortValue(location: LocationMaster | undefined): number {
  const parsed = Number.parseFloat(location?.number ?? "");
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function isCciAddress(value: string): boolean {
  return /^CCI/i.test(value.replace(/^\d+-/, ""));
}

export function isCcoAddress(value: string): boolean {
  return /^CCO/i.test(value.replace(/^\d+-/, ""));
}

function isCciOrCcoAddress(value: string): boolean {
  return isCciAddress(value) || isCcoAddress(value);
}

function isCcoOperationDetail(value: string): boolean {
  return /^(sheer|drape)\s+(open|close)$/i.test(value.trim().replace(/\s+/g, " "));
}

function ccoOperationValue(assignment: DeviceAssignment): string {
  const detail = assignment.detail.trim();
  if (isCcoOperationDetail(detail)) return detail;
  const assigned = assignment.circuitNumber.trim();
  return isCcoOperationDetail(assigned) ? assigned : "";
}

function findLocationByName(locations: LocationMaster[], name: string): LocationMaster | undefined {
  const normalized = name.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return undefined;
  return locations.find((location) => location.name.trim().replace(/\s+/g, " ").toLowerCase() === normalized);
}

function ioAssignmentLocation(
  assignment: DeviceAssignment,
  locations: LocationMaster[],
): { id: string; name: string; color: string } {
  const explicitAreaId = assignment.area?.trim() ?? "";
  if (explicitAreaId) {
    const explicitLocation = locations.find((location) => location.id === explicitAreaId);
    if (explicitLocation) {
      return {
        id: explicitLocation.id,
        name: explicitLocation.name,
        color: fallbackLocationColor(explicitLocation.id, locations),
      };
    }
  }

  if (!isCcoAddress(assignment.zoneAddress)) {
    return { id: OTHER_AREA_ID, name: "", color: "" };
  }

  const detail = assignment.detail.trim();
  const operation = ccoOperationValue(assignment);
  const location =
    operation
      ? findLocationByName(locations, "Bedroom")
      : findLocationByName(locations, detail);
  if (!location) return { id: OTHER_AREA_ID, name: "", color: "" };
  return {
    id: location.id,
    name: location.name,
    color: fallbackLocationColor(location.id, locations),
  };
}

function ioAssignmentDetail(assignment: DeviceAssignment, locations: LocationMaster[]): string {
  const detail = assignment.detail.trim();
  if (!isCcoAddress(assignment.zoneAddress)) return isCciAddress(assignment.zoneAddress) ? detail : "";
  const operation = ccoOperationValue(assignment);
  if (operation) return operation;
  if (findLocationByName(locations, detail)) return "";
  if (detail) return detail;
  return "";
}

function joinDetailParts(...values: string[]): string {
  return values.map((value) => value.trim()).filter(Boolean).join(" - ");
}

export function switchGroupId(sw: SwitchEntry): string {
  return sw.switchGroupId || sw.id;
}

export function normalizeBacklightCondition(value: string, source?: SwitchEntry): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return "";
  if (/^light$/i.test(trimmed)) return "";
  if (trimmed === BY_SCENE_VALUE) return "";
  if (/^master\s*on$/i.test(trimmed)) return "Bright";
  const foundDefault = BACKLIGHT_LEVEL_NAMES.find((level) => level.key === trimmed || level.name === trimmed);
  if (foundDefault) return foundDefault.name;
  const foundCustom = source?.backlightLevels?.find((level) => level.key === trimmed || level.name === trimmed);
  return foundCustom?.name || trimmed;
}

export function isBacklightTargetCondition(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return false;
  if (trimmed === BY_SCENE_VALUE) return true;
  return normalizeBacklightCondition(trimmed) === "Base";
}

// "" assignment = By Scene (documented default). Shared by the Switch and
// Command tabs so their Backlight Target lists are always the same set.
export function isByScenePalladiomBacklightTarget(sw: SwitchEntry): boolean {
  return sw.kind === "lutronPd" && sw.backlightAssignment.trim() === "";
}

// One representative row per Palladiom switch group, By Scene only — the
// candidate Target list of the Backlight setting panels.
export function byScenePalladiomBacklightTargets(switches: SwitchEntry[]): SwitchEntry[] {
  const groups = new Map<string, SwitchEntry>();
  for (const sw of switches) {
    if (sw.kind !== "lutronPd") continue;
    const key = switchGroupId(sw);
    if (!groups.has(key)) groups.set(key, sw);
  }
  return Array.from(groups.values()).filter((sw) => isByScenePalladiomBacklightTarget(sw));
}

export function isPalladiomBacklightTarget(sw: SwitchEntry): boolean {
  if (sw.kind !== "lutronPd" || !hasSwitchOperationalIdentity(sw)) return false;
  // Group assignment decides target eligibility ("" = By Scene, or a
  // target-eligible fixed level such as Base). Row-action conditions no
  // longer affect membership.
  const assignment = sw.backlightAssignment.trim();
  return !assignment || isBacklightTargetCondition(assignment);
}

function isDaliControlDevice(device: string): boolean {
  return /DALI|DALUNV|HDAL|2DAL/i.test(device);
}

function isSingleControlPerZoneAssignment(assignment: DeviceAssignment): boolean {
  if (isDaliControlDevice(assignment.device)) return false;
  if (/4A\d*/i.test(assignment.device) || isFourSControlDevice(assignment.device) || /4P\s*20|4P20/i.test(assignment.device)) return true;
  return /QSE-IO/i.test(assignment.device) && /^CCO/i.test(assignment.zoneAddress.trim());
}

function daliLineNumberForAssignment(assignment: DeviceAssignment, assignments: readonly DeviceAssignment[]): number {
  if (!assignment.deviceGroupId) return 1;
  const groupRows = assignments.filter((candidate) => candidate.deviceGroupId === assignment.deviceGroupId);
  const index = groupRows.findIndex((candidate) => candidate.id === assignment.id);
  if (index < 0) return 1;
  return Math.floor(index / DALI_ADDRESSES_PER_LINE) + 1;
}

function assignmentControlKey(assignment: DeviceAssignment): string {
  return [
    assignment.deviceGroupId || assignment.device,
    assignment.device,
    assignment.deviceNum,
    assignment.zoneAddress,
    assignment.group,
    assignment.circuitNumber,
  ].join("\u0000");
}

function cfsDisplayAssignments(assignments: DeviceAssignment[]): CfsDisplayAssignment[] {
  const result: CfsDisplayAssignment[] = [];
  const indexByKey = new Map<string, number>();

  for (const assignment of assignments) {
    if (!isSingleControlPerZoneAssignment(assignment)) {
      result.push({ ...assignment, assignmentIds: [assignment.id] });
      continue;
    }

    const key = assignmentControlKey(assignment);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length);
      result.push({ ...assignment, assignmentIds: [assignment.id] });
      continue;
    }

    const existing = result[existingIndex];
    const detail = uniqueValues([existing.detail, assignment.detail]).join(" / ");
    const area = existing.area || assignment.area || "";
    result[existingIndex] = {
      ...existing,
      area,
      detail,
      assignmentIds: [...existing.assignmentIds, assignment.id],
    };
  }

  return result;
}

function cfsOnlyInputKind(row: CfsCircuit): "CCI" | "CCO" {
  const token = `${row.control} ${row.addressZone}`.trim().toUpperCase();
  return /^CCI/.test(token) || /\bCCI\b/.test(token) ? "CCI" : "CCO";
}

function joinUniqueDetailParts(...values: string[]): string {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result.join(" - ");
}

function cfsOnlyZoneRows(
  roomType: RoomType,
  locations: LocationMaster[],
  locationById: Map<string, LocationMaster>,
  startIndex: number,
): CfsZoneRow[] {
  return roomType.rows
    .filter(isCfsOnlySettingRow)
    .map((row, index): CfsZoneRow => {
      const inputKind = cfsOnlyInputKind(row);
      const locationId = row.area || OTHER_AREA_ID;
      const location = row.area ? locationById.get(row.area) : undefined;
      const assignmentValue = row.fixture.trim() || row.note.trim() || row.designerNumber.trim() || inputKind;
      const assignmentDetail = joinUniqueDetailParts(row.fixture, row.note) || assignmentValue;
      return {
        id: row.id,
        orderIndex: startIndex + index,
        assignmentIds: [row.id],
        device: row.device.trim() || "CFS Only",
        deviceNum: row.deviceNum.trim(),
        zone: row.addressZone.trim() || inputKind,
        group: row.group.trim(),
        address: row.addressZone.trim() || inputKind,
        daliLine: "",
        isDali: false,
        location: location?.name || "Other",
        locationId,
        locationColor: fallbackLocationColor(locationId, locations),
        circuits: [],
        isCci: inputKind === "CCI",
        rowKind: inputKind === "CCI" ? "cco" : "cco",
        assignmentValue,
        assignmentDetail,
        inputKind,
      };
    });
}

function corridorPicoLedZoneRows(
  roomType: RoomType,
  locations: LocationMaster[],
  locationById: Map<string, LocationMaster>,
  startIndex: number,
): CfsZoneRow[] {
  const targets = corridorPicoLedTargets(roomType.switches, locations);
  const deviceNumberByGroup = new Map<string, string>();
  for (const target of targets) {
    if (!deviceNumberByGroup.has(target.switchGroupId)) {
      deviceNumberByGroup.set(target.switchGroupId, String(deviceNumberByGroup.size + 1));
    }
  }

  return targets.map((target, index): CfsZoneRow => {
    const location = target.areaId ? locationById.get(target.areaId) : undefined;
    const locationId = location?.id || target.areaId || OTHER_AREA_ID;
    const locationName = location?.name || target.areaName || "Other";
    const locationColor = fallbackLocationColor(locationId, locations);
    const switchNumber = target.switchNumber.trim() || "-";
    const corridorDeviceNumber = deviceNumberByGroup.get(target.switchGroupId) || String(index + 1);
    const circuit: CircuitEntry = {
      id: target.id,
      circuitGroupId: target.switchGroupId,
      daliFixtureGroupId: "",
      designerNumber: "",
      internalNumber: "",
      dimmingType: "On/Off",
      fixture: "",
      pcs: "",
      detail: target.label,
      area: locationId,
      ffe: false,
      energySaving: false,
    };
    return {
      id: target.id,
      orderIndex: startIndex + index,
      assignmentIds: [target.id],
      device: PICO_CORRIDOR_ALLOCATION,
      deviceNum: corridorDeviceNumber,
      zone: switchNumber,
      group: "",
      address: switchNumber,
      daliLine: "",
      isDali: false,
      location: locationName,
      locationId,
      locationColor,
      circuits: [
        {
          id: target.id,
          designerNumber: "",
          internalNumber: "",
          dimmingType: "On/Off",
          location: locationName,
          locationId,
          locationColor,
          areaAddress: "",
          detail: target.label,
          circuit,
        },
      ],
      rowKind: "cco",
      assignmentValue: switchNumber,
      assignmentDetail: target.label,
      inputKind: "CCO",
    };
  });
}

function curtainZoneRows(
  roomType: RoomType,
  locations: LocationMaster[],
  locationById: Map<string, LocationMaster>,
  startIndex: number,
): CfsZoneRow[] {
  return (roomType.curtainAssignments ?? []).map((assignment, assignmentIndex): CfsZoneRow => {
    const locationId = assignment.area || OTHER_AREA_ID;
    const loc = assignment.area ? locationById.get(assignment.area) : undefined;
    const location = loc?.name || "Other";
    const locationColor = fallbackLocationColor(locationId, locations);
    const targetId = curtainSettingId(assignment.id);
    const detail = assignment.detail.trim();
    const circuit: CircuitEntry = {
      id: targetId,
      circuitGroupId: assignment.id,
      daliFixtureGroupId: "",
      designerNumber: "",
      internalNumber: "",
      dimmingType: "Curtain",
      fixture: "",
      pcs: "",
      detail,
      area: assignment.area,
      ffe: false,
      energySaving: false,
    };
    return {
      id: targetId,
      orderIndex: startIndex + assignmentIndex,
      assignmentIds: [assignment.id],
      device: "Lutron Curtain",
      deviceNum: String(assignmentIndex + 1),
      zone: "",
      group: "",
      address: "",
      daliLine: "",
      isDali: false,
      location,
      locationId,
      locationColor,
      circuits: [
        {
          id: targetId,
          designerNumber: "",
          internalNumber: "",
          dimmingType: "Curtain",
          location,
          locationId,
          locationColor,
          areaAddress: "",
          detail,
          circuit,
        },
      ],
      isCurtain: true,
      rowKind: "curtain",
      assignmentValue: "",
      assignmentDetail: detail,
      inputKind: "Curtain",
    };
  });
}

function applyRowKindDisplay(
  rows: CfsZoneRow[],
  rowKindOrder: readonly CfsRowKind[] = DEFAULT_CFS_ROW_ORDER,
  hiddenRowKinds: ReadonlySet<CfsRowKind> = new Set(),
): CfsZoneRow[] {
  const order = new Map<CfsRowKind, number>();
  rowKindOrder.forEach((kind, index) => order.set(kind, index));
  DEFAULT_CFS_ROW_ORDER.forEach((kind, index) => {
    if (!order.has(kind)) order.set(kind, rowKindOrder.length + index);
  });
  return rows
    .filter((row) => !hiddenRowKinds.has(cfsRowKind(row)))
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const kindCompare =
        (order.get(cfsRowKind(a.row)) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(cfsRowKind(b.row)) ?? Number.MAX_SAFE_INTEGER);
      if (kindCompare !== 0) return kindCompare;
      return a.index - b.index;
    })
    .map((item) => item.row);
}

function normalizeDetailMatch(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function assignmentAddressIndex(assignment: DeviceAssignment): number | null {
  const match = assignment.zoneAddress.trim().match(/\d+/);
  if (!match) return null;
  const index = Number.parseInt(match[0], 10) - 1;
  return Number.isFinite(index) && index >= 0 ? index : null;
}

function uniqueCircuitsForAssignment(circuits: CircuitEntry[], assignment: DeviceAssignment): CircuitEntry[] {
  const detail = assignment.detail.trim();
  if (detail && circuits[0]) {
    const normalizedDetail = normalizeDetailMatch(detail);
    const detailMatch = circuits.find((circuit) => normalizeDetailMatch(circuit.detail) === normalizedDetail);
    if (detailMatch) return [detailMatch];
    const addressIndex = assignmentAddressIndex(assignment);
    if (addressIndex !== null && circuits[addressIndex]) return [circuits[addressIndex]];
    return [{ ...circuits[0], detail }];
  }
  const seen = new Set<string>();
  const result: CircuitEntry[] = [];
  for (const circuit of circuits) {
    const key = circuit.circuitGroupId || circuit.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(detail ? { ...circuit, detail } : circuit);
  }
  return result;
}

export function buildCfsZoneRows({
  roomType,
  circuits,
  locations,
  locationById,
  areaAddressByAssignmentCircuit,
  palladiomBySceneTargets,
  selectedAreaIds,
  hiddenDeviceKeys,
  sortMode,
  showCciRows = false,
  rowKindOrder = DEFAULT_CFS_ROW_ORDER,
  hiddenRowKinds = new Set<CfsRowKind>(),
}: BuildCfsZoneRowsOptions): CfsZoneRow[] {
    const displayAssignments = cfsDisplayAssignments(roomType.deviceAssignments)
      .filter((assignment) => showCciRows || !isCciAddress(assignment.zoneAddress));
    const rows: CfsZoneRow[] = displayAssignments
      .filter((assignment) => assignment.device.trim() || assignment.circuitNumber.trim() || assignment.detail.trim())
      .map((assignment, assignmentIndex): CfsZoneRow => {
        const assigned = assignment.circuitNumber.trim();
        const assignmentValue = assigned && assigned !== "Reserved" ? assigned : "";
        const rawMatchedCircuits = assigned
          ? circuits.filter((circuit) => circuit.designerNumber.trim() === assigned)
          : [];
        const matchedCircuits = uniqueCircuitsForAssignment(rawMatchedCircuits, assignment);
        const unlinkedCciCco =
          assignmentValue !== "" &&
          rawMatchedCircuits.length === 0 &&
          isCciOrCcoAddress(assignment.zoneAddress);
        const assignmentDetail = isCciOrCcoAddress(assignment.zoneAddress)
          ? ioAssignmentDetail(assignment, locations)
          : unlinkedCciCco
            ? joinDetailParts(assignmentValue, assignment.detail)
            : assignment.detail;
        const isDaliAssignment = isDaliControlDevice(assignment.device);
        const daliLine = isDaliAssignment
          ? String(daliLineNumberForAssignment(assignment, roomType.deviceAssignments))
          : "";
        const toRowCircuit = (circuit: CircuitEntry): RowCircuit => {
          const dimmingType = cfsDimmingTypeForAssignment(assignment.device, circuit.dimmingType);
          const loc = circuit.area ? locationById.get(circuit.area) : undefined;
          const locationColor = fallbackLocationColor(circuit.area, locations);
          const areaAddressKey = assignment.assignmentIds
            .map((assignmentId) => areaAddressAssignmentKey(assignmentId, circuit.id))
            .find((key) => areaAddressByAssignmentCircuit.has(key));
          return {
            id: circuit.id,
            designerNumber: circuit.designerNumber,
            internalNumber: circuit.internalNumber,
            dimmingType,
            location: loc?.name || "Other",
            locationId: circuit.area || OTHER_AREA_ID,
            locationColor,
            areaAddress: areaAddressKey ? areaAddressByAssignmentCircuit.get(areaAddressKey) ?? "" : "",
            detail: circuit.detail || assignment.detail || "",
            circuit: { ...circuit, dimmingType },
          };
        };
        let rowCircuits = matchedCircuits.map(toRowCircuit);
        const displayedCircuitIds = new Set(rowCircuits.map((item) => item.circuit.id));
        // T-59/T-75: additional circuits of the zone ("+" button) collapse into
        // the primary circuit line (zone Detail, " & "-joined Designer #) and are
        // carried separately for Total VA / Low-High End / target resolution.
        const additionalNumbers = additionalCircuitNumbersOf(assignment);
        const zoneDetailValue = (assignment.zoneDetail ?? "").trim();
        let zoneExtraCircuits: RowCircuit[] = [];
        if (
          additionalNumbers.length > 0 &&
          rowCircuits.length > 0 &&
          !isDaliAssignment &&
          !isCciOrCcoAddress(assignment.zoneAddress)
        ) {
          const seenGroupKeys = new Set(
            matchedCircuits.map((circuit) => circuit.circuitGroupId.trim() || circuit.id),
          );
          const extraEntries: CircuitEntry[] = [];
          for (const value of additionalNumbers) {
            const head = circuits.find((circuit) => circuit.designerNumber.trim() === value);
            if (!head) continue;
            const key = head.circuitGroupId.trim() || head.id;
            if (seenGroupKeys.has(key)) continue;
            seenGroupKeys.add(key);
            extraEntries.push(head);
          }
          if (extraEntries.length > 0) {
            zoneExtraCircuits = extraEntries.map(toRowCircuit);
            const joinNumbers = (primaryValue: string, extraValues: string[]): string =>
              joinZoneCircuitNumbers([primaryValue, ...extraValues]);
            rowCircuits = rowCircuits.map((item) => ({
              ...item,
              designerNumber: joinNumbers(
                item.designerNumber,
                extraEntries.map((entry) => entry.designerNumber),
              ),
              internalNumber: joinNumbers(
                item.internalNumber,
                extraEntries.map((entry) => entry.internalNumber),
              ),
              // T-88: blank zoneDetail falls back to the " / " join of every
              // assigned circuit's Detail (blank details skipped).
              detail:
                zoneDetailValue ||
                joinZoneCircuitDetails([
                  item.detail,
                  ...extraEntries.map((entry) => entry.detail),
                ]),
            }));
          }
        }
        const targetAliasCircuits = (isDaliAssignment
          ? []
          : rawMatchedCircuits
              .filter((circuit) => !displayedCircuitIds.has(circuit.id))
              .map(toRowCircuit)
        ).concat(zoneExtraCircuits);
        const primaryCircuit = rowCircuits[0];
        const isDali = rowCircuits.some((item) => item.dimmingType === "DALI");
        const zoneInputKind = isCciAddress(assignment.zoneAddress)
          ? "CCI"
          : isCcoAddress(assignment.zoneAddress)
            ? "CCO"
            : "";
        const inputKind =
          rowCircuits.length === 0 &&
          zoneInputKind &&
          (assignmentValue || assignment.detail.trim())
            ? zoneInputKind
            : "";
        const isIoAssignment = rowCircuits.length === 0 && Boolean(zoneInputKind);
        const ioLocation = isIoAssignment ? ioAssignmentLocation(assignment, locations) : undefined;
        return {
          id: assignment.id,
          orderIndex: assignmentIndex,
          assignmentIds: assignment.assignmentIds,
          device: assignment.device || "-",
          deviceNum: assignment.deviceNum || "-",
          zone: assignment.zoneAddress || "-",
          group: assignment.group || "-",
          address: assignment.zoneAddress || "-",
          daliLine,
          isDali,
          location: primaryCircuit?.location || ioLocation?.name || "",
          locationId: primaryCircuit?.locationId || ioLocation?.id || OTHER_AREA_ID,
          locationColor: primaryCircuit?.locationColor || ioLocation?.color || "",
          circuits: rowCircuits,
          targetAliasCircuits,
          ...(zoneExtraCircuits.length > 0 ? { zoneExtraCircuits } : {}),
          isCci: isCciAddress(assignment.zoneAddress),
          rowKind: rowCircuits.length > 0 ? "lighting" : "cco",
          assignmentValue,
          assignmentDetail,
          inputKind,
          isIoAssignment,
        };
      });

    const cfsOnlyRows = cfsOnlyZoneRows(roomType, locations, locationById, displayAssignments.length)
      .filter((row) => showCciRows || !row.isCci);

    const corridorPicoLedRows = corridorPicoLedZoneRows(
      roomType,
      locations,
      locationById,
      displayAssignments.length + cfsOnlyRows.length,
    );

    const hvacRows: CfsZoneRow[] = roomType.hvacAssignments.flatMap((assignment, assignmentIndex) => {
      const loc = assignment.area ? locationById.get(assignment.area) : undefined;
      const location = loc?.name || "Other";
      const locationId = assignment.area || OTHER_AREA_ID;
      const locationColor = fallbackLocationColor(locationId, locations);
      return ["On/Off", "Setpoint", "Fan Mode", "Drift"].map((metric) => ({
        id: `${assignment.id}:${metric}`,
        orderIndex: displayAssignments.length + cfsOnlyRows.length + corridorPicoLedRows.length + assignmentIndex,
        device: "HVAC",
        deviceNum: String(assignmentIndex + 1),
        zone: assignment.thermostatRole,
        group: "",
        address: assignment.thermostatRole,
        daliLine: "",
        isDali: false,
        location,
        locationId,
        locationColor,
        circuits: [
          {
            id: `${assignment.id}:${metric}`,
            designerNumber: "",
            internalNumber: "",
            dimmingType: assignment.protocol,
            location,
            locationId,
            locationColor,
            areaAddress: "",
            detail: metric,
            circuit: {
              id: `${assignment.id}:${metric}`,
              circuitGroupId: assignment.id,
              daliFixtureGroupId: "",
              designerNumber: "",
              internalNumber: "",
              dimmingType: assignment.protocol,
              fixture: "",
              pcs: "",
              detail: metric,
              area: assignment.area,
              ffe: false,
              energySaving: false,
            },
          },
        ],
        isHvac: true,
        rowKind: "hvac" as const,
        hvacSettingId: hvacSettingId(assignment.id, metric),
        hvacMetric: metric,
      }));
    });

    const curtainRows = curtainZoneRows(
      roomType,
      locations,
      locationById,
      displayAssignments.length + cfsOnlyRows.length + corridorPicoLedRows.length + hvacRows.length,
    );

    const backlightTargetRows = new Map<string, { target: SwitchEntry; sources: SwitchEntry[]; orderIndex: number }>();
    roomType.switches.forEach((sw, switchIndex) => {
      if (!hasMeaningfulBacklightSource(sw)) return;
      const targetIds = sw.backlightTarget.split(",").map((value) => value.trim()).filter(Boolean);
      if (targetIds.length === 0 || !normalizeBacklightCondition(sw.backlightCondition, sw)) return;
      const targets = targetIds
        .map((targetId) => palladiomBySceneTargets.get(targetId))
        .filter((target): target is SwitchEntry => Boolean(target));
      targets.forEach((target) => {
        const targetGroupId = switchGroupId(target);
        const existing = backlightTargetRows.get(targetGroupId);
        if (existing) {
          existing.sources.push(sw);
        } else {
          backlightTargetRows.set(targetGroupId, {
            target,
            sources: [sw],
            orderIndex: displayAssignments.length + cfsOnlyRows.length + corridorPicoLedRows.length + roomType.hvacAssignments.length + switchIndex,
          });
        }
      });
    });

    const backlightRows: CfsZoneRow[] = Array.from(backlightTargetRows.entries()).map(([targetGroupId, row]) => ({
      id: `backlight:${targetGroupId}`,
      orderIndex: row.orderIndex,
      device: "Backlight Logic",
      deviceNum: "",
      zone: "",
      group: "",
      address: "",
      daliLine: "",
      isDali: false,
      location: "",
      locationId: OTHER_AREA_ID,
      locationColor: "",
      circuits: [],
          isBacklight: true,
          rowKind: "backlight" as const,
      backlightSourceId: row.sources[0]?.id,
      backlightTargetGroupId: targetGroupId,
      backlightValue: normalizeBacklightCondition(row.sources[0]?.backlightCondition ?? "", row.sources[0]),
      backlightTargetLabel: [row.target.switchNumber, row.target.switchName].filter(Boolean).join(" - ") || "-",
    }));
    const backlightRowsWithCircuits: CfsZoneRow[] = backlightRows.map((row) => ({
      ...row,
      circuits: [
        {
          id: row.id,
          designerNumber: "",
          internalNumber: "",
          dimmingType: "Backlight Logic",
          location: "",
          locationId: OTHER_AREA_ID,
          locationColor: "",
          areaAddress: "",
          detail: row.backlightTargetLabel || "-",
          circuit: {
            id: row.id,
            circuitGroupId: row.id,
            daliFixtureGroupId: "",
            designerNumber: "",
            internalNumber: "",
            dimmingType: "Backlight Logic",
            fixture: "",
            pcs: "",
            detail: row.backlightTargetLabel || "-",
            area: "",
            ffe: false,
            energySaving: false,
          },
        },
      ],
    }));

    const allRows = [...rows, ...cfsOnlyRows, ...corridorPicoLedRows, ...curtainRows, ...hvacRows, ...backlightRowsWithCircuits];
    const filtered = selectedAreaIds.size > 0
      ? allRows.filter((row) => selectedAreaIds.has(row.locationId))
      : allRows;
    const deviceFiltered = filtered.filter((row) => !hiddenDeviceKeys.has(`${row.device}\u0000${row.deviceNum}`));
    const sortedByDevice = sortRowsByDeviceSequence(deviceFiltered);

    if (sortMode === "device" || sortMode === "programmingName") {
      return applyRowKindDisplay(sortedByDevice, rowKindOrder, hiddenRowKinds);
    }
    if (sortMode === "internal") {
      return applyRowKindDisplay(
        [...deviceFiltered].sort((a, b) => compareRowsWithSortPriority(a, b, compareInternalNumberOrder)),
        rowKindOrder,
        hiddenRowKinds,
      );
    }
    return applyRowKindDisplay(sortRowsByAreaSequence(deviceFiltered, locations), rowKindOrder, hiddenRowKinds);
}

export function useCfsZoneRows(options: BuildCfsZoneRowsOptions): CfsZoneRow[] {
  const {
    areaAddressByAssignmentCircuit,
    circuits,
    hiddenDeviceKeys,
    locationById,
    locations,
    palladiomBySceneTargets,
    roomType,
    selectedAreaIds,
    showCciRows,
    sortMode,
    rowKindOrder,
    hiddenRowKinds,
  } = options;

  return useMemo<CfsZoneRow[]>(() => buildCfsZoneRows({
    areaAddressByAssignmentCircuit,
    circuits,
    hiddenDeviceKeys,
    locationById,
    locations,
    palladiomBySceneTargets,
    roomType,
    selectedAreaIds,
    showCciRows,
    sortMode,
    rowKindOrder,
    hiddenRowKinds,
  }), [
    areaAddressByAssignmentCircuit,
    circuits,
    hiddenDeviceKeys,
    locationById,
    locations,
    palladiomBySceneTargets,
    roomType,
    selectedAreaIds,
    showCciRows,
    sortMode,
    rowKindOrder,
    hiddenRowKinds,
  ]);
}
