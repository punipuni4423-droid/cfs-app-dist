import type { CircuitEntry, DeviceAssignment, DeviceMaster, FixtureMaster } from "../types";
import {
  createEmptyDeviceAssignment,
  inferAddressMode,
} from "./constants";
import { createAppId } from './id';

interface DeviceAssignmentSyncContext {
  circuits: readonly CircuitEntry[];
  devices: readonly DeviceMaster[];
  fixtures: readonly FixtureMaster[];
  createId?: () => string;
}

function createDefaultId(): string {
  return createAppId();
}

function normalizeAddress(addr: string): string {
  const match = addr.match(/^\d+-(\d+)$/);
  return match ? match[1] : addr;
}

function circuitQuantity(circuit: CircuitEntry, fixtures: readonly FixtureMaster[]): number {
  const fixtureType = fixtures.find((fixture) => fixture.fixture === circuit.fixture)?.fixtureType;
  if (fixtureType === "Indirect") return 1;
  const count = Number.parseInt(circuit.pcs, 10);
  return Number.isFinite(count) && count > 0 ? count : 1;
}

function daliFixtureKey(circuit: CircuitEntry): string {
  return circuit.daliFixtureGroupId || circuit.id;
}

export function isDeviceDaliModel(model: string, devices: readonly DeviceMaster[]): boolean {
  const device = devices.find((item) => item.model === model);
  return device ? device.addressMode === "dali" : inferAddressMode(model) === "dali";
}

function isPwmDevice(model: string, devices: readonly DeviceMaster[]): boolean {
  const device = devices.find((item) => item.model === model);
  return device?.control === "PWM" || /4P\s*20|4P20|PWM/i.test(model);
}

function allowedDimmingTypesForDevice(model: string, devices: readonly DeviceMaster[]): Set<string> {
  if (isDeviceDaliModel(model, devices)) return new Set(["DALI"]);
  if (/4A1/i.test(model)) return new Set(["Phase"]);
  if (/4S1/i.test(model)) return new Set(["On/Off"]);
  if (isPwmDevice(model, devices)) return new Set(["On/Off", "PWM"]);
  return new Set(["On/Off", "Phase", "PWM"]);
}

function isCircuitAllowedForDevice(
  circuit: CircuitEntry,
  model: string,
  devices: readonly DeviceMaster[],
): boolean {
  if (!model) return true;
  return allowedDimmingTypesForDevice(model, devices).has(circuit.dimmingType);
}

export function isInputAssignment(
  assignment: DeviceAssignment,
  devices: readonly DeviceMaster[],
): boolean {
  const device = devices.find((item) => item.model === assignment.device);
  return device?.control === "Input" || /^CCI/i.test(normalizeAddress(assignment.zoneAddress));
}

function isCcoAssignment(assignment: DeviceAssignment): boolean {
  return /^CCO/i.test(normalizeAddress(assignment.zoneAddress));
}

function findCircuitGroupEntries(
  value: string,
  model: string,
  circuits: readonly CircuitEntry[],
  devices: readonly DeviceMaster[],
): CircuitEntry[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const firstMatch = circuits.find(
    (circuit) =>
      isCircuitAllowedForDevice(circuit, model, devices) &&
      (circuit.designerNumber === trimmed || circuit.internalNumber === trimmed),
  );
  if (!firstMatch) return [];
  return circuits.filter((circuit) => circuit.circuitGroupId === firstMatch.circuitGroupId);
}

export function getDaliCircuitUnits(
  value: string,
  model: string,
  context: DeviceAssignmentSyncContext,
): { detail: string }[] {
  const entries = findCircuitGroupEntries(value, model, context.circuits, context.devices);
  if (entries.length === 0) return [];
  const units: { detail: string }[] = [];
  const seenBlocks = new Set<string>();
  for (const entry of entries) {
    const blockKey = daliFixtureKey(entry);
    if (seenBlocks.has(blockKey)) continue;
    seenBlocks.add(blockKey);
    const blockEntries = entries.filter((candidate) => daliFixtureKey(candidate) === blockKey);
    const head = blockEntries[0];
    const quantity = circuitQuantity(head, context.fixtures);
    for (let index = 0; index < quantity; index += 1) {
      units.push({ detail: blockEntries[index]?.detail || head.detail });
    }
  }
  return units;
}

export function rebuildZoneExpansion(
  list: DeviceAssignment[],
  primaryId: string,
  context: DeviceAssignmentSyncContext,
): DeviceAssignment[] {
  const primary = list.find((assignment) => assignment.id === primaryId);
  if (!primary || !primary.deviceGroupId || !primary.zoneAddress) return list;
  if (isDeviceDaliModel(primary.device, context.devices)) return list;
  if (isInputAssignment(primary, context.devices)) return list;
  if (isCcoAssignment(primary)) return list;

  const value = primary.circuitNumber.trim();
  const entries = value
    ? findCircuitGroupEntries(value, primary.device, context.circuits, context.devices)
    : [];
  const detailValue = primary.detail || entries[0]?.detail || "";
  const currentZoneRows = list.filter(
    (assignment) =>
      assignment.deviceGroupId === primary.deviceGroupId &&
      assignment.zoneAddress === primary.zoneAddress,
  );
  const expectedCount = Math.max(entries.length, value ? 1 : 0);
  if (currentZoneRows.length === expectedCount) {
    const allMatch = currentZoneRows.every((assignment) => assignment.detail === detailValue);
    if (allMatch) return list;
  }

  const filtered = list.filter((assignment) => {
    if (assignment.id === primaryId) return true;
    return !(
      assignment.deviceGroupId === primary.deviceGroupId &&
      assignment.zoneAddress === primary.zoneAddress
    );
  });

  if (!value || entries.length <= 1) {
    if (entries.length === 1 && primary.detail !== detailValue) {
      return filtered.map((assignment) =>
        assignment.id === primaryId ? { ...assignment, detail: detailValue } : assignment,
      );
    }
    return filtered;
  }

  const createId = context.createId ?? createDefaultId;
  const result: DeviceAssignment[] = [];
  for (const assignment of filtered) {
    result.push(assignment.id === primaryId ? { ...assignment, detail: detailValue } : assignment);
    if (assignment.id !== primaryId) continue;
    for (let index = 1; index < entries.length; index += 1) {
      result.push({
        ...createEmptyDeviceAssignment(),
        id: createId(),
        deviceGroupId: primary.deviceGroupId,
        device: primary.device,
        deviceNum: primary.deviceNum,
        zoneAddress: primary.zoneAddress,
        circuitNumber: value,
        detail: detailValue,
      });
    }
  }
  return result;
}

export function normalizeDaliGroupNumbers(
  list: DeviceAssignment[],
  devices: readonly DeviceMaster[],
): DeviceAssignment[] {
  const groupMap = new Map<string, string>();
  const counters = new Map<string, number>();
  let changed = false;
  const next = list.map((assignment) => {
    if (!assignment.deviceGroupId || !assignment.group || !isDeviceDaliModel(assignment.device, devices)) {
      return assignment;
    }
    const key = `${assignment.deviceGroupId}::${assignment.group}`;
    let nextGroup = groupMap.get(key);
    if (!nextGroup) {
      const nextCount = (counters.get(assignment.deviceGroupId) ?? 0) + 1;
      counters.set(assignment.deviceGroupId, nextCount);
      nextGroup = String(nextCount);
      groupMap.set(key, nextGroup);
    }
    if (assignment.group === nextGroup) return assignment;
    changed = true;
    return { ...assignment, group: nextGroup };
  });
  return changed ? next : list;
}

export function syncDeviceAssignmentsWithCircuits(
  assignments: DeviceAssignment[],
  context: DeviceAssignmentSyncContext,
): DeviceAssignment[] {
  if (assignments.length === 0) return assignments;

  const processed = new Set<string>();
  let list = assignments;
  let changed = false;

  for (const assignment of assignments) {
    if (!assignment.deviceGroupId || !assignment.circuitNumber.trim()) continue;
    if (isInputAssignment(assignment, context.devices)) continue;
    if (isCcoAssignment(assignment)) continue;

    if (!isDeviceDaliModel(assignment.device, context.devices) && assignment.zoneAddress) {
      const key = `${assignment.deviceGroupId}::${assignment.zoneAddress}`;
      if (processed.has(key)) continue;
      const primaryIndex = assignments.findIndex(
        (candidate) =>
          candidate.deviceGroupId === assignment.deviceGroupId &&
          candidate.zoneAddress === assignment.zoneAddress,
      );
      if (assignments[primaryIndex]?.id !== assignment.id) continue;
      processed.add(key);
      const previous = list;
      list = rebuildZoneExpansion(list, assignment.id, context);
      if (list !== previous) changed = true;
    }

    if (isDeviceDaliModel(assignment.device, context.devices) && assignment.group) {
      const key = `dali::${assignment.deviceGroupId}::${assignment.group}`;
      if (processed.has(key)) continue;
      processed.add(key);
      const groupRows = list.filter(
        (candidate) =>
          candidate.deviceGroupId === assignment.deviceGroupId &&
          candidate.group === assignment.group,
      );
      const units = getDaliCircuitUnits(assignment.circuitNumber, assignment.device, context);
      if (units.length === 0 || groupRows.length !== units.length) continue;
      const detailChanged = groupRows.some((row, index) => row.detail !== units[index]?.detail);
      if (!detailChanged) continue;
      changed = true;
      const idSet = new Set(groupRows.map((row) => row.id));
      let index = 0;
      list = list.map((row) => {
        if (!idSet.has(row.id)) return row;
        const unit = units[index];
        index += 1;
        return unit ? { ...row, detail: unit.detail } : row;
      });
    }
  }

  const normalized = normalizeDaliGroupNumbers(list, context.devices);
  if (normalized !== list) changed = true;
  return changed ? normalized : assignments;
}
