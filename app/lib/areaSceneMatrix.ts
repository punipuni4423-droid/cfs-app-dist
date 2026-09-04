import type {
  CircuitEntry,
  CurtainAssignment,
  DeviceAssignment,
  HvacAssignment,
  LocationMaster,
  Scene,
  SwitchEntry,
} from "../types";
import { formatLevel } from "./cfsValueResolver";
import { OTHER_AREA_ID } from "./cfsTableModel";
import {
  circuitGroupMembers,
  sceneSettingValueForCircuitGroup,
  uniqueCircuitGroupHeads,
} from "./circuitGroups";
import { escapeCsvField } from "./csv";
import {
  circuitSettingTarget,
  curtainSettingTargets,
  hvacSettingTargets,
  picoLedSettingTargets,
  type SettingTarget,
} from "./settingTargets";
import {
  applyZoneMergesToSettingTargets,
  buildZoneCircuitMerges,
  mergeZoneCircuitHeads,
  type ZoneCircuitMergeIndex,
} from "./zoneCircuitMerges";

export const HVAC_AREA_ID = "__hvac_area_scene__";

export interface AreaSceneSourceInput {
  locations: LocationMaster[];
  circuits: CircuitEntry[];
  hvacAssignments: HvacAssignment[];
  curtainAssignments: CurtainAssignment[];
  switches: readonly SwitchEntry[];
  // T-59: device assignments of the room type. When present, zones carrying
  // additional circuits show one merged lighting row (zone Detail name) whose
  // edits reach every merged circuit group.
  deviceAssignments?: DeviceAssignment[];
}

export type AreaSceneTargetKind = "lighting" | "picoLed" | "curtain" | "hvac";
export type AreaSceneCircuitMode = "designer" | "internal";

export interface AreaSceneTarget extends SettingTarget {
  kind: AreaSceneTargetKind;
  circuit?: CircuitEntry;
}

export interface AreaSceneColumn {
  name: string;
  sceneIdByAreaId: Map<string, string>;
  duplicatedAreaIds: Set<string>;
}

export type AreaSceneCellState = "value" | "empty" | "na";

export interface AreaSceneCell {
  state: AreaSceneCellState;
  rawValue: string;
  displayValue: string;
}

export interface AreaSceneRow {
  target: AreaSceneTarget;
  cells: AreaSceneCell[];
}

export interface AreaSceneGroup {
  areaId: string;
  areaName: string;
  rows: AreaSceneRow[];
}

export interface AreaSceneMatrix {
  columns: AreaSceneColumn[];
  groups: AreaSceneGroup[];
}

function picoTargets(input: AreaSceneSourceInput): SettingTarget[] {
  return picoLedSettingTargets(input.switches, input.locations);
}

function zoneMergesOf(input: AreaSceneSourceInput): ZoneCircuitMergeIndex {
  return buildZoneCircuitMerges(input.circuits, input.deviceAssignments ?? []);
}

export function findFirstAreaSceneTargetAreaId(input: AreaSceneSourceInput): string {
  const locationIds = new Set(input.locations.map((location) => location.id));
  for (const circuit of input.circuits) {
    if (circuit.area && locationIds.has(circuit.area)) return circuit.area;
  }
  for (const assignment of input.hvacAssignments) {
    if (assignment.area && locationIds.has(assignment.area)) return assignment.area;
  }
  for (const assignment of input.curtainAssignments) {
    if (assignment.area && locationIds.has(assignment.area)) return assignment.area;
  }
  for (const target of picoTargets(input)) {
    if (target.areaId) return target.areaId;
  }
  return input.locations[0]?.id ?? "";
}

export function buildAreaSceneAreas(input: AreaSceneSourceInput): LocationMaster[] {
  const firstTargetOrder = new Map<string, number>();
  input.circuits.forEach((circuit, index) => {
    if (circuit.area && !firstTargetOrder.has(circuit.area)) firstTargetOrder.set(circuit.area, index);
  });
  input.hvacAssignments.forEach((assignment, index) => {
    if (assignment.area && !firstTargetOrder.has(assignment.area)) {
      firstTargetOrder.set(assignment.area, input.circuits.length + index);
    }
  });
  input.curtainAssignments.forEach((assignment, index) => {
    if (assignment.area && !firstTargetOrder.has(assignment.area)) {
      firstTargetOrder.set(assignment.area, input.circuits.length + input.hvacAssignments.length + index);
    }
  });
  const picoLedTargets = picoTargets(input);
  picoLedTargets.forEach((target, index) => {
    if (target.areaId && !firstTargetOrder.has(target.areaId)) {
      firstTargetOrder.set(target.areaId, input.circuits.length + input.hvacAssignments.length + input.curtainAssignments.length + index);
    }
  });

  const base = input.locations
    .filter((loc) =>
      input.circuits.some((circuit) => circuit.area === loc.id) ||
      input.hvacAssignments.some((assignment) => assignment.area === loc.id) ||
      input.curtainAssignments.some((assignment) => assignment.area === loc.id) ||
      picoLedTargets.some((target) => target.areaId === loc.id)
    )
    .sort((a, b) => (firstTargetOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (firstTargetOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER));

  const withOther = picoLedTargets.some((target) => target.areaId === OTHER_AREA_ID)
    ? [...base, { id: OTHER_AREA_ID, name: "Other", number: "", code: "", color: "" }]
    : base;

  return input.hvacAssignments.length > 0
    ? [...withOther, { id: HVAC_AREA_ID, name: "HVAC", number: "", code: "HV", color: "" }]
    : withOther;
}

export function buildAreaSceneCircuitHeads(areaId: string, input: AreaSceneSourceInput): CircuitEntry[] {
  if (areaId === HVAC_AREA_ID) return [];
  const heads = uniqueCircuitGroupHeads(input.circuits.filter((circuit) => circuit.area === areaId));
  return mergeZoneCircuitHeads(heads, zoneMergesOf(input));
}

export function buildAreaSceneHvacTargets(areaId: string, input: AreaSceneSourceInput): AreaSceneTarget[] {
  const assignments = areaId === HVAC_AREA_ID
    ? input.hvacAssignments
    : input.hvacAssignments.filter((assignment) => assignment.area === areaId);
  return hvacSettingTargets(assignments, input.locations).map((target) => ({ ...target, kind: "hvac" }));
}

export function buildAreaSceneCurtainTargets(areaId: string, input: AreaSceneSourceInput): AreaSceneTarget[] {
  const assignments = areaId === HVAC_AREA_ID
    ? []
    : input.curtainAssignments.filter((assignment) => assignment.area === areaId);
  return curtainSettingTargets(assignments, input.locations).map((target) => ({ ...target, kind: "curtain" }));
}

export function buildAreaScenePicoLedTargets(areaId: string, input: AreaSceneSourceInput): AreaSceneTarget[] {
  if (areaId === HVAC_AREA_ID) return [];
  return picoTargets(input)
    .filter((target) => target.areaId === areaId)
    .map((target) => ({ ...target, kind: "picoLed" }));
}

export function buildAreaSceneTargets(areaId: string, input: AreaSceneSourceInput): AreaSceneTarget[] {
  if (!areaId) return [];
  const lighting = applyZoneMergesToSettingTargets(
    buildAreaSceneCircuitHeads(areaId, input).map((circuit) => ({
      ...circuitSettingTarget(circuit, input.locations),
      groupCircuitIds: circuitGroupMembers(input.circuits, circuit).map((member) => member.id),
      kind: "lighting" as const,
      circuit,
    })),
    zoneMergesOf(input),
  );
  return [
    ...lighting,
    ...buildAreaScenePicoLedTargets(areaId, input),
    ...buildAreaSceneCurtainTargets(areaId, input),
    ...buildAreaSceneHvacTargets(areaId, input),
  ];
}

function sceneDisplayName(scene: Scene, indexInArea: number): string {
  return scene.name.trim() || `Scene ${indexInArea + 1}`;
}

function buildAreaSceneColumns(scenes: Scene[]): AreaSceneColumn[] {
  const columns: AreaSceneColumn[] = [];
  const columnByName = new Map<string, AreaSceneColumn>();
  const areaSceneIndex = new Map<string, number>();

  for (const scene of scenes) {
    const indexInArea = areaSceneIndex.get(scene.areaId) ?? 0;
    areaSceneIndex.set(scene.areaId, indexInArea + 1);
    const name = sceneDisplayName(scene, indexInArea);
    let column = columnByName.get(name);
    if (!column) {
      column = {
        name,
        sceneIdByAreaId: new Map<string, string>(),
        duplicatedAreaIds: new Set<string>(),
      };
      columnByName.set(name, column);
      columns.push(column);
    }
    if (column.sceneIdByAreaId.has(scene.areaId)) {
      column.duplicatedAreaIds.add(scene.areaId);
      continue;
    }
    column.sceneIdByAreaId.set(scene.areaId, scene.id);
  }

  return columns;
}

function settingValueForTarget(scene: Scene, target: AreaSceneTarget, circuits: CircuitEntry[]): string {
  if (target.kind === "lighting" && target.circuit) {
    return sceneSettingValueForCircuitGroup(scene.settings, circuits, target.circuit);
  }
  return scene.settings.find((setting) => setting.circuitId === target.id)?.percentage ?? "";
}

function displayDimmingType(target: AreaSceneTarget): string {
  return target.hvacMetric || target.dimmingType;
}

function cellForScene(scene: Scene | undefined, target: AreaSceneTarget, circuits: CircuitEntry[]): AreaSceneCell {
  if (!scene) return { state: "na", rawValue: "", displayValue: "" };
  const rawValue = settingValueForTarget(scene, target, circuits).trim();
  if (!rawValue) return { state: "empty", rawValue: "", displayValue: "" };
  return {
    state: "value",
    rawValue,
    displayValue: formatLevel(rawValue, displayDimmingType(target)),
  };
}

export function buildAreaSceneMatrix(
  input: AreaSceneSourceInput & { scenes: Scene[] },
): AreaSceneMatrix {
  const columns = buildAreaSceneColumns(input.scenes);
  const sceneById = new Map(input.scenes.map((scene) => [scene.id, scene]));
  const groups = buildAreaSceneAreas(input).map((area) => {
    const rows = buildAreaSceneTargets(area.id, input)
      .map((target) => ({
        target,
        cells: columns.map((column) =>
          cellForScene(sceneById.get(column.sceneIdByAreaId.get(area.id) ?? ""), target, input.circuits),
        ),
      }))
      .filter((row) => {
        if (area.id === HVAC_AREA_ID || row.target.kind !== "hvac") return true;
        return row.cells.some((cell) => cell.state === "value");
      });
    return {
      areaId: area.id,
      areaName: area.name || "(No name)",
      rows,
    };
  });

  return { columns, groups };
}

export function areaSceneTargetCircuitLabel(
  target: AreaSceneTarget,
  circuitMode: AreaSceneCircuitMode,
): string {
  if (target.kind === "lighting" && target.circuit) {
    const value = circuitMode === "designer"
      ? target.circuit.designerNumber
      : target.circuit.internalNumber;
    return value.trim() || "(Unset)";
  }
  return target.circuitNumber || "-";
}

export function areaSceneMatrixToCsv(
  matrix: AreaSceneMatrix,
  options: {
    circuitMode?: AreaSceneCircuitMode;
    groups?: AreaSceneGroup[];
  } = {},
): string {
  const circuitMode = options.circuitMode ?? "designer";
  const groups = options.groups ?? matrix.groups;
  const header = ["Area", "Circuit #", "Type", "Detail", ...matrix.columns.map((column) => column.name)];
  const rows = groups.flatMap((group) =>
    group.rows.map((row) => [
      group.areaName,
      areaSceneTargetCircuitLabel(row.target, circuitMode),
      row.target.dimmingType || "-",
      row.target.detail || "-",
      ...row.cells.map((cell) => {
        if (cell.state === "na") return "-";
        if (cell.state === "empty") return "";
        return cell.displayValue;
      }),
    ]),
  );
  return [header, ...rows]
    .map((row) => row.map(escapeCsvField).join(","))
    .join("\r\n");
}
