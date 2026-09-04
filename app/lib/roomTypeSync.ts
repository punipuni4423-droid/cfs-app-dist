import type { CircuitEntry, DeviceAssignment, DeviceMaster, FixtureMaster, LocationMaster, ProjectData, RoomType } from "../types";
import { syncContactSwitchesWithCciAssignments } from "./cciAssignments";
import { normalizeSceneSettingsByCircuitGroup, sameSceneSettings } from "./circuitGroups";
import { backlightLevelsFromSwitches, normalizeBacklightLevels } from "./constants";
import { syncDeviceAssignmentsWithCircuits } from "./deviceAssignmentSync";
import { buildZoneCircuitMerges, syncSceneSettingsAcrossZoneMerges } from "./zoneCircuitMerges";
import { createAppId } from "./id";
import { ensureRoomScenes } from "./roomScenes";
import { dedupeSwitchIds, normalizeQsmAssignments } from "./switchSync";

interface ProjectRoomTypeSyncContext {
  devices: readonly DeviceMaster[];
  createId?: () => string;
}

interface RoomTypeLinkContext {
  circuits: ProjectData["circuits"];
  fixtures: readonly FixtureMaster[];
  locations: readonly LocationMaster[];
  devices: readonly DeviceMaster[];
  createId?: () => string;
}

function directCircuitIdsForRoomType(
  roomType: Pick<RoomType, "scenes" | "roomScenes" | "switches">,
  projectCircuitIds: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  const collect = (settings: readonly { circuitId?: string }[] | undefined): void => {
    for (const setting of settings ?? []) {
      const circuitId = setting.circuitId;
      if (circuitId && !circuitId.includes(":") && projectCircuitIds.has(circuitId)) {
        ids.add(circuitId);
      }
    }
  };
  for (const scene of roomType.scenes ?? []) collect(scene.settings);
  for (const scene of roomType.roomScenes ?? []) collect(scene.settings);
  for (const sw of roomType.switches ?? []) collect(sw.buttonSetting?.circuitSettings);
  return ids;
}

function cloneProjectData<T>(source: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(source);
  }
  return JSON.parse(JSON.stringify(source)) as T;
}

function remapCircuitTargetId(targetId: string, circuitIdMap: ReadonlyMap<string, string>): string {
  return circuitIdMap.get(targetId) ?? targetId;
}

function remapCircuitEntry(
  circuit: CircuitEntry,
  circuitIdMap: ReadonlyMap<string, string>,
  circuitGroupIdMap: ReadonlyMap<string, string>,
  daliFixtureGroupIdMap: ReadonlyMap<string, string>,
): CircuitEntry {
  return {
    ...cloneProjectData(circuit),
    id: remapCircuitTargetId(circuit.id, circuitIdMap),
    circuitGroupId: circuitGroupIdMap.get(circuit.circuitGroupId) ?? circuit.circuitGroupId,
    daliFixtureGroupId: daliFixtureGroupIdMap.get(circuit.daliFixtureGroupId) ?? circuit.daliFixtureGroupId,
  };
}

function remapCircuitSettings<T extends { circuitId: string }>(
  settings: readonly T[] | undefined,
  circuitIdMap: ReadonlyMap<string, string>,
): T[] {
  return (settings ?? []).map((setting) => ({
    ...cloneProjectData(setting),
    circuitId: remapCircuitTargetId(setting.circuitId, circuitIdMap),
  }));
}

function remapRevisionSnapshot(
  snapshotText: string,
  circuitIdMap: ReadonlyMap<string, string>,
  circuitGroupIdMap: ReadonlyMap<string, string>,
  daliFixtureGroupIdMap: ReadonlyMap<string, string>,
): string {
  try {
    const snapshot = JSON.parse(snapshotText) as Partial<Pick<
      RoomType,
      "scenes" | "roomScenes" | "switches" | "inspectionMarks"
    >> & { circuits?: CircuitEntry[] };
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshotText;
    const remapped = {
      ...snapshot,
      circuits: Array.isArray(snapshot.circuits)
        ? snapshot.circuits.map((circuit) => remapCircuitEntry(circuit, circuitIdMap, circuitGroupIdMap, daliFixtureGroupIdMap))
        : snapshot.circuits,
      scenes: Array.isArray(snapshot.scenes)
        ? snapshot.scenes.map((scene) => ({ ...scene, settings: remapCircuitSettings(scene.settings, circuitIdMap) }))
        : snapshot.scenes,
      roomScenes: Array.isArray(snapshot.roomScenes)
        ? snapshot.roomScenes.map((scene) => ({ ...scene, settings: remapCircuitSettings(scene.settings, circuitIdMap) }))
        : snapshot.roomScenes,
      switches: Array.isArray(snapshot.switches)
        ? snapshot.switches.map((sw) => ({
            ...sw,
            buttonSetting: {
              ...sw.buttonSetting,
              circuitSettings: remapCircuitSettings(sw.buttonSetting?.circuitSettings, circuitIdMap),
            },
          }))
        : snapshot.switches,
      inspectionMarks: Array.isArray(snapshot.inspectionMarks)
        ? snapshot.inspectionMarks.map((mark) => ({ ...mark, targetId: remapCircuitTargetId(mark.targetId, circuitIdMap) }))
        : snapshot.inspectionMarks,
    };
    return JSON.stringify(remapped);
  } catch {
    return snapshotText;
  }
}

function remapRoomTypeCircuitReferences(
  roomType: RoomType,
  circuitIdMap: ReadonlyMap<string, string>,
  circuitGroupIdMap: ReadonlyMap<string, string> = new Map(),
  daliFixtureGroupIdMap: ReadonlyMap<string, string> = new Map(),
): RoomType {
  if (circuitIdMap.size === 0) return roomType;
  return {
    ...roomType,
    scenes: (roomType.scenes ?? []).map((scene) => ({
      ...scene,
      settings: remapCircuitSettings(scene.settings, circuitIdMap),
    })),
    roomScenes: (roomType.roomScenes ?? []).map((scene) => ({
      ...scene,
      settings: remapCircuitSettings(scene.settings, circuitIdMap),
    })),
    switches: (roomType.switches ?? []).map((sw) => ({
      ...sw,
      buttonSetting: {
        ...sw.buttonSetting,
        circuitSettings: remapCircuitSettings(sw.buttonSetting?.circuitSettings, circuitIdMap),
      },
    })),
    inspectionMarks: (roomType.inspectionMarks ?? []).map((mark) => ({
      ...mark,
      targetId: remapCircuitTargetId(mark.targetId, circuitIdMap),
    })),
    revisions: (roomType.revisions ?? []).map((revision) => ({
      ...revision,
      snapshot: remapRevisionSnapshot(revision.snapshot, circuitIdMap, circuitGroupIdMap, daliFixtureGroupIdMap),
    })),
  };
}

function normalizeSceneReferences(roomType: RoomType): RoomType {
  const sceneIds = new Set((roomType.scenes ?? []).map((scene) => scene.id));
  const sceneAreaById = new Map((roomType.scenes ?? []).map((scene) => [scene.id, scene.areaId]));
  let changed = false;
  const switches = (roomType.switches ?? []).map((sw) => {
    const validSceneIds = (sw.buttonSetting?.sceneIds ?? []).filter((sceneId) => sceneIds.has(sceneId));
    const sceneId = sw.buttonSetting?.sceneId && sceneIds.has(sw.buttonSetting.sceneId)
      ? sw.buttonSetting.sceneId
      : validSceneIds[0] ?? "";
    if (
      sceneId === (sw.buttonSetting?.sceneId ?? "") &&
      validSceneIds.length === (sw.buttonSetting?.sceneIds ?? []).length
    ) {
      return sw;
    }
    changed = true;
    return {
      ...sw,
      buttonSetting: {
        ...sw.buttonSetting,
        sceneId,
        sceneIds: validSceneIds,
      },
    };
  });
  const roomScenes = (roomType.roomScenes ?? []).map((scene) => {
    const selections = (scene.areaSceneSelections ?? []).filter((selection) => (
      !selection.sceneId || sceneAreaById.get(selection.sceneId) === selection.areaId
    ));
    if (selections.length === (scene.areaSceneSelections ?? []).length) return scene;
    changed = true;
    return { ...scene, areaSceneSelections: selections };
  });
  return changed ? { ...roomType, switches, roomScenes } : roomType;
}

function normalizeAreaSceneCircuitGroupSettings(
  roomType: RoomType,
  circuits: readonly CircuitEntry[],
): RoomType {
  let changed = false;
  const scenes = (roomType.scenes ?? []).map((scene) => {
    const settings = normalizeSceneSettingsByCircuitGroup(scene.settings, circuits);
    if (sameSceneSettings(settings, scene.settings)) return scene;
    changed = true;
    return { ...scene, settings };
  });
  return changed ? { ...roomType, scenes } : roomType;
}

// T-59: zones carrying additional circuits edit their Area Scene value through
// the primary circuit group; propagate that value to the merged groups so
// "write to every circuit of the zone" holds for the Area Scene tab as well.
function syncZoneMergedSceneSettings(
  roomType: RoomType,
  circuits: readonly CircuitEntry[],
  deviceAssignments: readonly DeviceAssignment[],
): RoomType {
  const currentScenes = roomType.scenes ?? [];
  const scenes = syncSceneSettingsAcrossZoneMerges(
    currentScenes,
    buildZoneCircuitMerges(circuits, deviceAssignments),
  );
  return scenes === currentScenes ? roomType : { ...roomType, scenes };
}

export function inferRoomTypeCircuitIds(
  project: Pick<ProjectData, "circuits" | "roomTypes">,
  roomType: Pick<RoomType, "id" | "circuitIds" | "scenes" | "roomScenes" | "switches">,
): string[] {
  if (Array.isArray(roomType.circuitIds)) return roomType.circuitIds;

  const projectCircuitIds = project.circuits.map((circuit) => circuit.id);
  const projectCircuitIdSet = new Set(projectCircuitIds);
  if (project.roomTypes.length <= 1) return projectCircuitIds;

  const directIds = directCircuitIdsForRoomType(roomType, projectCircuitIdSet);
  if (directIds.size > 0) {
    return projectCircuitIds.filter((id) => directIds.has(id));
  }

  const unscopedWithoutDirectRefs = project.roomTypes.filter((candidate) =>
    !Array.isArray(candidate.circuitIds) &&
    directCircuitIdsForRoomType(candidate, projectCircuitIdSet).size === 0
  );
  const claimedByOtherRoomTypes = new Set<string>();
  for (const candidate of project.roomTypes) {
    if (candidate.id === roomType.id || !Array.isArray(candidate.circuitIds)) continue;
    for (const circuitId of candidate.circuitIds) {
      if (projectCircuitIdSet.has(circuitId)) claimedByOtherRoomTypes.add(circuitId);
    }
  }

  if (unscopedWithoutDirectRefs.length === 1 && claimedByOtherRoomTypes.size > 0) {
    return projectCircuitIds.filter((id) => !claimedByOtherRoomTypes.has(id));
  }

  return [];
}

export function normalizeProjectRoomTypeCircuitIds(project: ProjectData): ProjectData {
  let changed = false;
  const roomTypes = project.roomTypes.map((roomType) => {
    if (Array.isArray(roomType.circuitIds)) return roomType;
    changed = true;
    return {
      ...roomType,
      circuitIds: inferRoomTypeCircuitIds(project, roomType),
    };
  });
  const scopedProject = changed ? { ...project, roomTypes } : project;
  return isolateSharedRoomTypeCircuits(scopedProject);
}

export function isolateSharedRoomTypeCircuits(
  project: ProjectData,
  createId: () => string = createAppId,
): ProjectData {
  const circuitById = new Map(project.circuits.map((circuit) => [circuit.id, circuit]));
  const firstOwnerByCircuitId = new Map<string, string>();
  const nextCircuits: CircuitEntry[] = [...project.circuits];
  let changed = false;

  const roomTypes = project.roomTypes.map((roomType) => {
    const sourceIds = Array.isArray(roomType.circuitIds)
      ? roomType.circuitIds
      : inferRoomTypeCircuitIds(project, roomType);
    const seenInRoomType = new Set<string>();
    const circuitIdMap = new Map<string, string>();
    const circuitGroupIdMap = new Map<string, string>();
    const daliFixtureGroupIdMap = new Map<string, string>();
    const circuitIds: string[] = [];

    for (const circuitId of sourceIds) {
      if (seenInRoomType.has(circuitId)) {
        changed = true;
        continue;
      }
      seenInRoomType.add(circuitId);

      const circuit = circuitById.get(circuitId);
      const firstOwner = firstOwnerByCircuitId.get(circuitId);
      if (!circuit || !firstOwner || firstOwner === roomType.id) {
        if (!firstOwner) firstOwnerByCircuitId.set(circuitId, roomType.id);
        circuitIds.push(circuitId);
        continue;
      }

      const nextCircuitId = createId();
      const nextCircuitGroupId = circuit.circuitGroupId
        ? circuitGroupIdMap.get(circuit.circuitGroupId) ?? createId()
        : circuit.circuitGroupId;
      if (circuit.circuitGroupId && !circuitGroupIdMap.has(circuit.circuitGroupId)) {
        circuitGroupIdMap.set(circuit.circuitGroupId, nextCircuitGroupId);
      }
      const nextDaliFixtureGroupId = circuit.daliFixtureGroupId
        ? daliFixtureGroupIdMap.get(circuit.daliFixtureGroupId) ?? createId()
        : circuit.daliFixtureGroupId;
      if (circuit.daliFixtureGroupId && !daliFixtureGroupIdMap.has(circuit.daliFixtureGroupId)) {
        daliFixtureGroupIdMap.set(circuit.daliFixtureGroupId, nextDaliFixtureGroupId);
      }

      const clonedCircuit: CircuitEntry = {
        ...cloneProjectData(circuit),
        id: nextCircuitId,
        circuitGroupId: nextCircuitGroupId,
        daliFixtureGroupId: nextDaliFixtureGroupId,
      };
      nextCircuits.push(clonedCircuit);
      circuitById.set(nextCircuitId, clonedCircuit);
      firstOwnerByCircuitId.set(nextCircuitId, roomType.id);
      circuitIdMap.set(circuitId, nextCircuitId);
      circuitIds.push(nextCircuitId);
      changed = true;
    }

    const scopedRoomType =
      circuitIds.length !== sourceIds.length ||
      circuitIds.some((id, index) => id !== sourceIds[index]) ||
      !Array.isArray(roomType.circuitIds)
        ? { ...roomType, circuitIds }
        : roomType;
    return remapRoomTypeCircuitReferences(scopedRoomType, circuitIdMap, circuitGroupIdMap, daliFixtureGroupIdMap);
  });

  return changed ? { ...project, circuits: nextCircuits, roomTypes } : project;
}

export function circuitsForRoomType(
  project: Pick<ProjectData, "circuits" | "roomTypes">,
  roomType: Pick<RoomType, "id" | "circuitIds" | "scenes" | "roomScenes" | "switches"> | null | undefined,
): CircuitEntry[] {
  if (!roomType) return project.circuits;
  const circuitIds = inferRoomTypeCircuitIds(project, roomType);
  if (circuitIds.length === 0) return [];
  const circuitById = new Map(project.circuits.map((circuit) => [circuit.id, circuit]));
  return circuitIds
    .map((circuitId) => circuitById.get(circuitId))
    .filter((circuit): circuit is CircuitEntry => Boolean(circuit));
}

export function syncRoomTypeLinks(
  roomType: RoomType,
  context: RoomTypeLinkContext,
): RoomType {
  const deviceAssignments = syncDeviceAssignmentsWithCircuits(roomType.deviceAssignments, {
    circuits: context.circuits,
    devices: context.devices,
    fixtures: context.fixtures,
    createId: context.createId,
  });

  const sceneScopedRoomType = syncZoneMergedSceneSettings(
    normalizeAreaSceneCircuitGroupSettings(
      normalizeSceneReferences(roomType),
      context.circuits,
    ),
    context.circuits,
    deviceAssignments,
  );
  let switches = dedupeSwitchIds(sceneScopedRoomType.switches, context.createId);
  switches = syncContactSwitchesWithCciAssignments(switches, deviceAssignments);
  switches = normalizeQsmAssignments(switches, context.locations);
  const backlightLevels = Array.isArray(roomType.backlightLevels)
    ? normalizeBacklightLevels(roomType.backlightLevels)
    : backlightLevelsFromSwitches(switches);
  const backlightLevelsSignature = JSON.stringify(backlightLevels);
  let backlightSwitchChanged = false;
  const syncedBacklightSwitches = switches.map((sw) => {
    if (sw.kind !== "lutronPd") return sw;
    if (JSON.stringify(normalizeBacklightLevels(sw.backlightLevels)) === backlightLevelsSignature) return sw;
    backlightSwitchChanged = true;
    return { ...sw, backlightLevels };
  });
  if (backlightSwitchChanged) {
    switches = syncedBacklightSwitches;
  }

  const roomScenes = ensureRoomScenes(sceneScopedRoomType.roomScenes, context.createId);
  const roomTypeBacklightLevelsChanged =
    JSON.stringify(roomType.backlightLevels ?? []) !== backlightLevelsSignature;

  if (
    sceneScopedRoomType === roomType &&
    deviceAssignments === roomType.deviceAssignments &&
    switches === sceneScopedRoomType.switches &&
    roomScenes === sceneScopedRoomType.roomScenes &&
    !backlightSwitchChanged &&
    !roomTypeBacklightLevelsChanged
  ) {
    return roomType;
  }

  return {
    ...sceneScopedRoomType,
    deviceAssignments,
    backlightLevels,
    switches,
    roomScenes,
  };
}

export function syncProjectRoomTypeLinks(
  project: ProjectData,
  context: ProjectRoomTypeSyncContext,
): ProjectData {
  const scopedProject = normalizeProjectRoomTypeCircuitIds(project);
  let changed = scopedProject !== project;
  const roomTypes = scopedProject.roomTypes.map((roomType) => {
    const next = syncRoomTypeLinks(roomType, {
      circuits: circuitsForRoomType(scopedProject, roomType),
      fixtures: scopedProject.fixtures,
      locations: scopedProject.locations,
      devices: context.devices,
      createId: context.createId,
    });
    if (next !== roomType) changed = true;
    return next;
  });
  return changed ? { ...scopedProject, roomTypes } : project;
}
