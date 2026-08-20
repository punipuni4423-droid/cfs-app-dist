import type {
  CircuitEntry,
  InspectionMark,
  ProjectData,
  RoomType,
  SceneCircuitSetting,
  SwitchButtonSetting,
} from "../types";
import { createAppId } from "./id";
import { circuitsForRoomType } from "./roomTypeSync";

interface DuplicateRoomTypeOptions {
  createId?: () => string;
  now?: string;
}

export interface DuplicateRoomTypeResult {
  project: ProjectData;
  copy: RoomType;
}

function cloneProjectData<T>(source: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(source);
  }
  return JSON.parse(JSON.stringify(source)) as T;
}

function nextCopyName(source: RoomType, roomTypes: readonly RoomType[]): string {
  const baseName = `${source.name} Copy`;
  let name = baseName;
  let index = 2;
  while (roomTypes.some((rt) => rt.name === name)) {
    name = `${baseName} ${index}`;
    index += 1;
  }
  return name;
}

function rememberMappedId(map: Map<string, string>, sourceId: string, createId: () => string): string {
  const existing = map.get(sourceId);
  if (existing) return existing;
  const id = createId();
  map.set(sourceId, id);
  return id;
}

function mapKnownId(map: Map<string, string>, sourceId: string): string {
  return map.get(sourceId) ?? sourceId;
}

function remapSeparatedIds(value: string | null | undefined, map: Map<string, string>): string {
  if (typeof value !== "string" || !value.trim()) return "";
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => mapKnownId(map, id))
    .join(",");
}

function sourceSwitchGroupId(sw: { id: string; switchGroupId?: string }): string {
  return sw.switchGroupId || sw.id;
}

export function duplicateRoomType(
  project: ProjectData,
  sourceRoomTypeId: string,
  options: DuplicateRoomTypeOptions = {},
): DuplicateRoomTypeResult | null {
  const source = project.roomTypes.find((rt) => rt.id === sourceRoomTypeId);
  if (!source) return null;

  const createId = options.createId ?? createAppId;
  const now = options.now ?? new Date().toISOString();
  const sourceCircuits = circuitsForRoomType(project, source);
  const sourceRows = source.rows ?? [];
  const sourceDryContacts = source.dryContacts ?? [];
  const sourceDeviceAssignments = source.deviceAssignments ?? [];
  const sourceHvacAssignments = source.hvacAssignments ?? [];
  const sourceHvacSeasons = source.hvacSeasons ?? [];
  const sourceCurtainAssignments = source.curtainAssignments ?? [];
  const sourceScenes = source.scenes ?? [];
  const sourceRoomScenes = source.roomScenes ?? [];
  const sourceSwitches = source.switches ?? [];
  const sourceInspectionMarks = source.inspectionMarks ?? [];

  const circuitIdMap = new Map<string, string>();
  const circuitGroupIdMap = new Map<string, string>();
  const daliFixtureGroupIdMap = new Map<string, string>();
  const cfsRowIdMap = new Map<string, string>();
  const cfsRowGroupIdMap = new Map<string, string>();
  const dryContactIdMap = new Map<string, string>();
  const deviceAssignmentIdMap = new Map<string, string>();
  const deviceGroupIdMap = new Map<string, string>();
  const hvacAssignmentIdMap = new Map<string, string>();
  const hvacSeasonIdMap = new Map<string, string>();
  const curtainAssignmentIdMap = new Map<string, string>();
  const sceneIdMap = new Map<string, string>();
  const roomSceneIdMap = new Map<string, string>();
  const switchIdMap = new Map<string, string>();
  const switchGroupIdMap = new Map<string, string>();
  const inspectionMarkIdMap = new Map<string, string>();

  sourceCircuits.forEach((circuit) => {
    circuitIdMap.set(circuit.id, createId());
    if (circuit.circuitGroupId) rememberMappedId(circuitGroupIdMap, circuit.circuitGroupId, createId);
    if (circuit.daliFixtureGroupId) rememberMappedId(daliFixtureGroupIdMap, circuit.daliFixtureGroupId, createId);
  });
  sourceRows.forEach((row) => {
    cfsRowIdMap.set(row.id, createId());
    if (row.deviceGroupId) rememberMappedId(cfsRowGroupIdMap, row.deviceGroupId, createId);
  });
  sourceDryContacts.forEach((entry) => dryContactIdMap.set(entry.id, createId()));
  sourceDeviceAssignments.forEach((assignment) => {
    deviceAssignmentIdMap.set(assignment.id, createId());
    if (assignment.deviceGroupId) rememberMappedId(deviceGroupIdMap, assignment.deviceGroupId, createId);
  });
  sourceHvacAssignments.forEach((assignment) => hvacAssignmentIdMap.set(assignment.id, createId()));
  sourceHvacSeasons.forEach((season) => hvacSeasonIdMap.set(season.id, createId()));
  sourceCurtainAssignments.forEach((assignment) => curtainAssignmentIdMap.set(assignment.id, createId()));
  sourceScenes.forEach((scene) => sceneIdMap.set(scene.id, createId()));
  sourceRoomScenes.forEach((scene) => roomSceneIdMap.set(scene.id, createId()));
  sourceSwitches.forEach((sw) => {
    const copiedSwitchId = createId();
    const copiedGroupId = sw.switchGroupId
      ? rememberMappedId(switchGroupIdMap, sw.switchGroupId, createId)
      : copiedSwitchId;
    switchIdMap.set(sw.id, copiedSwitchId);
    switchGroupIdMap.set(sourceSwitchGroupId(sw), copiedGroupId);
    if (!switchGroupIdMap.has(sw.id)) switchGroupIdMap.set(sw.id, copiedGroupId);
  });
  sourceInspectionMarks.forEach((mark) => inspectionMarkIdMap.set(mark.id, createId()));

  const remapTargetId = (targetId: string): string => {
    const circuitId = circuitIdMap.get(targetId);
    if (circuitId) return circuitId;

    const hvac = targetId.match(/^hvac:([^:]+):(.+)$/);
    if (hvac) {
      const assignmentId = hvacAssignmentIdMap.get(hvac[1]);
      return assignmentId ? `hvac:${assignmentId}:${hvac[2]}` : targetId;
    }

    const io = targetId.match(/^(cco|cci):(.+)$/);
    if (io) {
      const assignmentId = deviceAssignmentIdMap.get(io[2]) ?? cfsRowIdMap.get(io[2]);
      return assignmentId ? `${io[1]}:${assignmentId}` : targetId;
    }

    const curtain = targetId.match(/^curtain:(.+)$/);
    if (curtain) {
      const assignmentId = curtainAssignmentIdMap.get(curtain[1]);
      return assignmentId ? `curtain:${assignmentId}` : targetId;
    }

    const picoLed = targetId.match(/^pico-led:([^:]+):(.+)$/);
    if (picoLed) {
      const groupId = switchGroupIdMap.get(picoLed[1]);
      return groupId ? `pico-led:${groupId}:${picoLed[2]}` : targetId;
    }

    return targetId;
  };

  const remapSettings = (settings: SceneCircuitSetting[] = []): SceneCircuitSetting[] =>
    settings.map((setting) => ({
      ...cloneProjectData(setting),
      circuitId: remapTargetId(setting.circuitId),
    }));

  const remapButtonSetting = (setting: SwitchButtonSetting): SwitchButtonSetting => {
    const sceneIds = (setting.sceneIds ?? []).map((sceneId) => mapKnownId(sceneIdMap, sceneId));
    const sceneId = setting.sceneId ? mapKnownId(sceneIdMap, setting.sceneId) : sceneIds[0] ?? "";
    return {
      ...cloneProjectData(setting),
      sceneId,
      sceneIds,
      circuitSettings: remapSettings(setting.circuitSettings ?? []),
    };
  };

  const copiedCircuits: CircuitEntry[] = sourceCircuits.map((circuit) => ({
    ...cloneProjectData(circuit),
    id: mapKnownId(circuitIdMap, circuit.id),
    circuitGroupId: circuit.circuitGroupId ? mapKnownId(circuitGroupIdMap, circuit.circuitGroupId) : circuit.circuitGroupId,
    daliFixtureGroupId: circuit.daliFixtureGroupId
      ? mapKnownId(daliFixtureGroupIdMap, circuit.daliFixtureGroupId)
      : circuit.daliFixtureGroupId,
  }));

  const copiedScenes = sourceScenes.map((scene) => ({
    ...cloneProjectData(scene),
    id: mapKnownId(sceneIdMap, scene.id),
    settings: remapSettings(scene.settings),
  }));

  const copiedRoomScenes = sourceRoomScenes.map((scene) => ({
    ...cloneProjectData(scene),
    id: mapKnownId(roomSceneIdMap, scene.id),
    areaSceneSelections: (scene.areaSceneSelections ?? []).map((selection) => ({
      ...cloneProjectData(selection),
      sceneId: mapKnownId(sceneIdMap, selection.sceneId),
    })),
    settings: remapSettings(scene.settings),
  }));

  const remapInspectionSourceId = (mark: InspectionMark): string => {
    if (mark.sourceType === "areaScene") return mapKnownId(sceneIdMap, mark.sourceId);
    if (mark.sourceType === "roomScene") return mapKnownId(roomSceneIdMap, mark.sourceId);
    if (mark.sourceType === "switch") return mapKnownId(switchIdMap, mark.sourceId);
    return mark.sourceId;
  };

  const copy: RoomType = {
    ...cloneProjectData(source),
    id: createId(),
    name: nextCopyName(source, project.roomTypes),
    updatedAt: now,
    circuitIds: copiedCircuits.map((circuit) => circuit.id),
    revision: "1.00",
    revisions: [],
    rows: sourceRows.map((row) => ({
      ...cloneProjectData(row),
      id: mapKnownId(cfsRowIdMap, row.id),
      deviceGroupId: row.deviceGroupId ? mapKnownId(cfsRowGroupIdMap, row.deviceGroupId) : row.deviceGroupId,
    })),
    dryContacts: sourceDryContacts.map((entry) => ({
      ...cloneProjectData(entry),
      id: mapKnownId(dryContactIdMap, entry.id),
    })),
    deviceAssignments: sourceDeviceAssignments.map((assignment) => ({
      ...cloneProjectData(assignment),
      id: mapKnownId(deviceAssignmentIdMap, assignment.id),
      deviceGroupId: assignment.deviceGroupId
        ? mapKnownId(deviceGroupIdMap, assignment.deviceGroupId)
        : assignment.deviceGroupId,
    })),
    hvacAssignments: sourceHvacAssignments.map((assignment) => ({
      ...cloneProjectData(assignment),
      id: mapKnownId(hvacAssignmentIdMap, assignment.id),
    })),
    hvacSeasons: sourceHvacSeasons.map((season) => ({
      ...cloneProjectData(season),
      id: mapKnownId(hvacSeasonIdMap, season.id),
    })),
    curtainAssignments: sourceCurtainAssignments.map((assignment) => ({
      ...cloneProjectData(assignment),
      id: mapKnownId(curtainAssignmentIdMap, assignment.id),
    })),
    scenes: copiedScenes,
    roomScenes: copiedRoomScenes,
    switches: sourceSwitches.map((sw) => ({
      ...cloneProjectData(sw),
      id: mapKnownId(switchIdMap, sw.id),
      switchGroupId: sw.switchGroupId ? mapKnownId(switchGroupIdMap, sw.switchGroupId) : sw.switchGroupId,
      buttonSetting: remapButtonSetting(sw.buttonSetting),
      backlightTarget: remapSeparatedIds(sw.backlightTarget, switchGroupIdMap),
    })),
    inspectionMarks: sourceInspectionMarks.map((mark) => ({
      ...cloneProjectData(mark),
      id: mapKnownId(inspectionMarkIdMap, mark.id),
      sourceId: remapInspectionSourceId(mark),
      targetId: remapTargetId(mark.targetId),
    })),
  };

  const existingRoomTypes = project.roomTypes.map((roomType) =>
    roomType.id !== source.id || Array.isArray(roomType.circuitIds)
      ? roomType
      : {
          ...roomType,
          circuitIds: sourceCircuits.map((circuit) => circuit.id),
        },
  );

  return {
    project: {
      ...project,
      circuits: [...project.circuits, ...copiedCircuits],
      roomTypes: [...existingRoomTypes, copy],
    },
    copy,
  };
}
