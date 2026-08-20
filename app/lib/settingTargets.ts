import type { CfsCircuit, CircuitEntry, CurtainAssignment, DeviceAssignment, HvacAssignment, LocationMaster, SwitchEntry } from "../types";
import { corridorPicoLedTargets } from "./picoSpecials";
import { isOnOffLikeDimmingType } from "./settingValues";

export const HVAC_METRICS = ["On/Off", "Setpoint", "Fan Mode", "Drift"] as const;

export interface SettingTarget {
  id: string;
  areaId: string;
  areaName: string;
  circuitNumber: string;
  dimmingType: string;
  detail: string;
  isOnOff: boolean;
  hvacAssignmentId?: string;
  hvacMetric?: typeof HVAC_METRICS[number];
  hvacLowEnd?: string;
  hvacHighEnd?: string;
  isCurtain?: boolean;
  curtainAssignmentId?: string;
  curtainAction?: CurtainAssignment["action"];
}

export interface SettingTargetGroup {
  id: string;
  name: string;
  targets: SettingTarget[];
}

export const OTHER_AREA_ID = "__other__";

export function hvacSettingId(assignmentId: string, metric: string): string {
  return `hvac:${assignmentId}:${metric}`;
}

export function curtainSettingId(assignmentId: string): string {
  return `curtain:${assignmentId}`;
}

export function circuitSettingTarget(
  circuit: CircuitEntry,
  locations: LocationMaster[],
): SettingTarget {
  const area = locations.find((location) => location.id === circuit.area);
  return {
    id: circuit.id,
    areaId: circuit.area || OTHER_AREA_ID,
    areaName: area?.name || "Other",
    circuitNumber: circuit.designerNumber.trim() || circuit.internalNumber.trim() || "-",
    dimmingType: circuit.dimmingType || "-",
    detail: circuit.detail || "-",
    isOnOff: isOnOffLikeDimmingType(circuit.dimmingType),
  };
}

export function hvacSettingTargets(
  hvacAssignments: HvacAssignment[],
  locations: LocationMaster[],
): SettingTarget[] {
  return hvacAssignments.flatMap((assignment, assignmentIndex) => {
    const area = locations.find((location) => location.id === assignment.area);
    return HVAC_METRICS.map((metric) => ({
      id: hvacSettingId(assignment.id, metric),
      areaId: assignment.area || OTHER_AREA_ID,
      areaName: area?.name || "Other",
      circuitNumber: String(assignmentIndex + 1),
      dimmingType: "HVAC",
      detail: metric,
      isOnOff: metric === "On/Off",
      hvacAssignmentId: assignment.id,
      hvacMetric: metric,
      hvacLowEnd: assignment.lowEnd,
      hvacHighEnd: assignment.highEnd,
    }));
  });
}

export function ccoSettingTargets(
  deviceAssignments: DeviceAssignment[],
  locations: LocationMaster[] = [],
): SettingTarget[] {
  return deviceAssignments
    .filter((assignment) => /^CCO/i.test(assignment.zoneAddress.trim()))
    .filter((assignment) => {
      const value = assignment.circuitNumber.trim();
      const detail = assignment.detail.trim();
      return (value !== "" && value.toLowerCase() !== "reserved") || detail !== "";
    })
    .map((assignment) => {
      const value = assignment.circuitNumber.trim();
      const hasAssignedValue = value !== "" && value.toLowerCase() !== "reserved";
      const fallback = assignment.zoneAddress.trim() || "CCO";
      const detail = assignment.detail.trim() || (hasAssignedValue ? value : fallback);
      const area = locations.find((location) => location.id === assignment.area);
      return {
        id: `cco:${assignment.id}`,
        areaId: assignment.area || OTHER_AREA_ID,
        areaName: area?.name || "Other",
        circuitNumber: hasAssignedValue ? value : fallback,
        dimmingType: "CCO",
        detail,
        isOnOff: true,
      };
    });
}

export function curtainSettingTargets(
  curtainAssignments: CurtainAssignment[] = [],
  locations: LocationMaster[] = [],
): SettingTarget[] {
  return curtainAssignments.map((assignment, index) => {
    const area = locations.find((location) => location.id === assignment.area);
    const detail = assignment.detail.trim() || "-";
    return {
      id: curtainSettingId(assignment.id),
      areaId: assignment.area || OTHER_AREA_ID,
      areaName: area?.name || "Other",
      circuitNumber: String(index + 1),
      dimmingType: "Curtain",
      detail,
      isOnOff: true,
      isCurtain: true,
      curtainAssignmentId: assignment.id,
      curtainAction: assignment.action,
    };
  });
}

export function picoLedSettingTargets(
  switches: readonly SwitchEntry[] = [],
  locations: LocationMaster[] = [],
): SettingTarget[] {
  return corridorPicoLedTargets(switches, locations).map((target) => ({
    id: target.id,
    areaId: target.areaId,
    areaName: target.areaName,
    circuitNumber: target.switchNumber || "-",
    dimmingType: "On/Off",
    detail: target.label,
    isOnOff: true,
  }));
}

export function isCfsOnlySettingRow(row: CfsCircuit): boolean {
  return (
    row.deviceAuto.trim().toUpperCase() === "CFS_ONLY" ||
    row.control.trim().toLowerCase() === "cfs only"
  );
}

function cfsOnlyInputKind(row: CfsCircuit): "CCI" | "CCO" {
  const token = `${row.control} ${row.addressZone}`.trim().toUpperCase();
  return /^CCI/.test(token) || /\bCCI\b/.test(token) ? "CCI" : "CCO";
}

export function cfsOnlySettingTargets(
  rows: CfsCircuit[] = [],
  locations: LocationMaster[] = [],
): SettingTarget[] {
  return rows
    .filter(isCfsOnlySettingRow)
    .filter((row) => cfsOnlyInputKind(row) !== "CCI")
    .map((row) => {
      const inputKind = cfsOnlyInputKind(row);
      const area = locations.find((location) => location.id === row.area);
      const label = row.fixture.trim() || row.note.trim() || row.designerNumber.trim() || inputKind;
      return {
        id: `${inputKind.toLowerCase()}:${row.id}`,
        areaId: row.area || OTHER_AREA_ID,
        areaName: area?.name || "Other",
        circuitNumber: label,
        dimmingType: inputKind,
        detail: row.note.trim() || row.fixture.trim() || "-",
        isOnOff: inputKind === "CCO",
      };
    });
}

export function buildSettingTargetGroups(
  locations: LocationMaster[],
  circuits: CircuitEntry[],
  deviceAssignments: DeviceAssignment[] = [],
  cfsOnlyRows: CfsCircuit[] = [],
  curtainAssignments: CurtainAssignment[] = [],
  switches: readonly SwitchEntry[] = [],
): SettingTargetGroup[] {
  const targets = [
    ...circuits.map((circuit) => circuitSettingTarget(circuit, locations)),
    ...ccoSettingTargets(deviceAssignments, locations),
    ...cfsOnlySettingTargets(cfsOnlyRows, locations),
    ...curtainSettingTargets(curtainAssignments, locations),
    ...picoLedSettingTargets(switches, locations),
  ];
  const byArea = new Map<string, SettingTarget[]>();
  for (const target of targets) {
    byArea.set(target.areaId, [...(byArea.get(target.areaId) ?? []), target]);
  }

  const groups = locations
    .map((location) => ({
      id: location.id,
      name: location.name || "(No name)",
      targets: byArea.get(location.id) ?? [],
    }))
    .filter((group) => group.targets.length > 0);

  const otherTargets = byArea.get(OTHER_AREA_ID) ?? [];
  if (otherTargets.length > 0) {
    groups.push({ id: OTHER_AREA_ID, name: "Other", targets: otherTargets });
  }
  return groups;
}
