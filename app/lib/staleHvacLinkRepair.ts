import type { HvacAssignment, RoomScene, RoomType, Scene, SceneCircuitSetting, SwitchEntry } from "../types";
import { HVAC_METRICS, hvacSettingId } from "./settingTargets";

type RepairSourceType = "Area Scene" | "Scene" | "Switch";
type HvacRole = "Master" | "Slave" | "";

interface ParsedHvacTarget {
  assignmentId: string;
  metric: string;
}

export interface StaleHvacRepairItem {
  sourceType: RepairSourceType;
  sourceId: string;
  sourceName: string;
  oldTargetId: string;
  newTargetId: string;
  metric: string;
  value: string;
}

export interface StaleHvacRepairSkip {
  sourceType: RepairSourceType;
  sourceId: string;
  sourceName: string;
  oldTargetId: string;
  metric: string;
  value: string;
  reason: string;
}

export interface StaleHvacRepairPlan {
  staleCount: number;
  repairs: StaleHvacRepairItem[];
  skipped: StaleHvacRepairSkip[];
  replacements: Map<string, string>;
}

export interface StaleHvacRepairResult extends StaleHvacRepairPlan {
  scenes: Scene[];
  roomScenes: RoomScene[];
  switches: SwitchEntry[];
  repairedTargetIds: string[];
}

function parseHvacTarget(targetId: string): ParsedHvacTarget | null {
  const match = targetId.match(/^hvac:([^:]+):(.+)$/);
  if (!match) return null;
  return { assignmentId: match[1], metric: match[2] };
}

function inferHvacRole(assignment: Partial<HvacAssignment>): HvacRole {
  if (assignment.thermostatRole === "Master" || assignment.thermostatRole === "Slave") {
    return assignment.thermostatRole;
  }
  const note = (assignment.note ?? "").toLowerCase();
  if (/\bslave\b|sub/.test(note)) return "Slave";
  if (/\bmaster\b|\bmain\b/.test(note)) return "Master";
  return "";
}

function samePhysicalHvac(a: Partial<HvacAssignment>, b: HvacAssignment): boolean {
  return (
    (a.area ?? "") === b.area &&
    (a.protocol ?? "") === b.protocol &&
    (a.lowEnd ?? "") === b.lowEnd &&
    (a.highEnd ?? "") === b.highEnd &&
    Boolean(a.summerWinterChange) === Boolean(b.summerWinterChange)
  );
}

function parseSnapshot(value: string): Partial<RoomType> | null {
  try {
    const parsed = JSON.parse(value || "{}") as Partial<RoomType>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function historicalHvacAssignments(roomType: RoomType): HvacAssignment[] {
  const currentIds = new Set(roomType.hvacAssignments.map((assignment) => assignment.id));
  const byId = new Map<string, HvacAssignment>();
  for (const revision of [...(roomType.revisions ?? [])].reverse()) {
    const snapshot = parseSnapshot(revision.snapshot);
    for (const assignment of snapshot?.hvacAssignments ?? []) {
      if (!assignment.id || currentIds.has(assignment.id) || byId.has(assignment.id)) continue;
      byId.set(assignment.id, assignment);
    }
  }
  return Array.from(byId.values());
}

function buildReplacementMap(roomType: RoomType): Map<string, string> {
  const replacements = new Map<string, string>();
  const historical = historicalHvacAssignments(roomType);

  for (const oldAssignment of historical) {
    const oldRole = inferHvacRole(oldAssignment);
    const physicalMatches = roomType.hvacAssignments.filter((current) => samePhysicalHvac(oldAssignment, current));
    const roleMatch = oldRole
      ? physicalMatches.find((current) => inferHvacRole(current) === oldRole)
      : undefined;
    if (roleMatch) {
      replacements.set(oldAssignment.id, roleMatch.id);
      continue;
    }

    const oldGroup = historical.filter((candidate) => samePhysicalHvac(candidate, oldAssignment));
    const oldIndex = oldGroup.findIndex((candidate) => candidate.id === oldAssignment.id);
    if (oldIndex >= 0 && physicalMatches[oldIndex]) {
      replacements.set(oldAssignment.id, physicalMatches[oldIndex].id);
    }
  }

  return replacements;
}

function currentTargetIds(roomType: RoomType): Set<string> {
  const ids = new Set<string>();
  for (const assignment of roomType.hvacAssignments) {
    for (const metric of HVAC_METRICS) {
      ids.add(hvacSettingId(assignment.id, metric));
    }
  }
  return ids;
}

function sourceName(sourceType: RepairSourceType, item: Scene | RoomScene | SwitchEntry): string {
  if (sourceType === "Area Scene") {
    const scene = item as Scene;
    return scene.name || scene.id.slice(0, 8);
  }
  if (sourceType === "Scene") {
    const scene = item as RoomScene;
    return [scene.phase, scene.sceneType, scene.detail].filter(Boolean).join(" / ") || scene.id.slice(0, 8);
  }
  const sw = item as SwitchEntry;
  return [sw.switchNumber, sw.switchName, sw.buttonFunction || sw.buttonLabel].filter(Boolean).join(" / ") || sw.id.slice(0, 8);
}

function collectPlanForSettings(params: {
  settings: SceneCircuitSetting[];
  sourceType: RepairSourceType;
  sourceId: string;
  sourceName: string;
  currentIds: Set<string>;
  assignmentReplacements: Map<string, string>;
  repairs: StaleHvacRepairItem[];
  skipped: StaleHvacRepairSkip[];
  targetReplacements: Map<string, string>;
}): void {
  for (const setting of params.settings) {
    const parsed = parseHvacTarget(setting.circuitId);
    if (!parsed || params.currentIds.has(setting.circuitId)) continue;
    const nextAssignmentId = params.assignmentReplacements.get(parsed.assignmentId);
    if (!nextAssignmentId) {
      params.skipped.push({
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        sourceName: params.sourceName,
        oldTargetId: setting.circuitId,
        metric: parsed.metric,
        value: setting.percentage,
        reason: "No matching current HVAC assignment was found.",
      });
      continue;
    }
    const nextTargetId = hvacSettingId(nextAssignmentId, parsed.metric);
    if (!params.currentIds.has(nextTargetId)) {
      params.skipped.push({
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        sourceName: params.sourceName,
        oldTargetId: setting.circuitId,
        metric: parsed.metric,
        value: setting.percentage,
        reason: "The mapped HVAC metric does not exist in the current target index.",
      });
      continue;
    }
    params.targetReplacements.set(setting.circuitId, nextTargetId);
    params.repairs.push({
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      sourceName: params.sourceName,
      oldTargetId: setting.circuitId,
      newTargetId: nextTargetId,
      metric: parsed.metric,
      value: setting.percentage,
    });
  }
}

export function analyzeStaleHvacLinks(roomType: RoomType): StaleHvacRepairPlan {
  const currentIds = currentTargetIds(roomType);
  const assignmentReplacements = buildReplacementMap(roomType);
  const replacements = new Map<string, string>();
  const repairs: StaleHvacRepairItem[] = [];
  const skipped: StaleHvacRepairSkip[] = [];

  for (const scene of roomType.scenes) {
    collectPlanForSettings({
      settings: scene.settings,
      sourceType: "Area Scene",
      sourceId: scene.id,
      sourceName: sourceName("Area Scene", scene),
      currentIds,
      assignmentReplacements,
      repairs,
      skipped,
      targetReplacements: replacements,
    });
  }

  for (const scene of roomType.roomScenes) {
    collectPlanForSettings({
      settings: scene.settings,
      sourceType: "Scene",
      sourceId: scene.id,
      sourceName: sourceName("Scene", scene),
      currentIds,
      assignmentReplacements,
      repairs,
      skipped,
      targetReplacements: replacements,
    });
  }

  for (const sw of roomType.switches) {
    collectPlanForSettings({
      settings: sw.buttonSetting.circuitSettings,
      sourceType: "Switch",
      sourceId: sw.id,
      sourceName: sourceName("Switch", sw),
      currentIds,
      assignmentReplacements,
      repairs,
      skipped,
      targetReplacements: replacements,
    });
  }

  return {
    staleCount: repairs.length + skipped.length,
    repairs,
    skipped,
    replacements,
  };
}

function repairSettings(settings: SceneCircuitSetting[], replacements: Map<string, string>): SceneCircuitSetting[] {
  let changed = false;
  const byTarget = new Map<string, SceneCircuitSetting>();
  const orderedTargets: string[] = [];

  for (const setting of settings) {
    const nextTarget = replacements.get(setting.circuitId) ?? setting.circuitId;
    if (nextTarget !== setting.circuitId) changed = true;
    const existing = byTarget.get(nextTarget);
    if (existing) {
      if (!existing.percentage.trim() && setting.percentage.trim()) {
        byTarget.set(nextTarget, { ...setting, circuitId: nextTarget });
        changed = true;
      }
      continue;
    }
    orderedTargets.push(nextTarget);
    byTarget.set(nextTarget, nextTarget === setting.circuitId ? setting : { ...setting, circuitId: nextTarget });
  }

  if (!changed) return settings;
  return orderedTargets.map((target) => byTarget.get(target)!);
}

export function repairStaleHvacLinks(roomType: RoomType): StaleHvacRepairResult {
  const plan = analyzeStaleHvacLinks(roomType);
  if (plan.repairs.length === 0) {
    return {
      ...plan,
      scenes: roomType.scenes,
      roomScenes: roomType.roomScenes,
      switches: roomType.switches,
      repairedTargetIds: [],
    };
  }

  const scenes = roomType.scenes.map((scene) => ({
    ...scene,
    settings: repairSettings(scene.settings, plan.replacements),
  }));
  const roomScenes = roomType.roomScenes.map((scene) => ({
    ...scene,
    settings: repairSettings(scene.settings, plan.replacements),
  }));
  const switches = roomType.switches.map((sw) => ({
    ...sw,
    buttonSetting: {
      ...sw.buttonSetting,
      circuitSettings: repairSettings(sw.buttonSetting.circuitSettings, plan.replacements),
    },
  }));

  return {
    ...plan,
    scenes,
    roomScenes,
    switches,
    repairedTargetIds: Array.from(new Set(plan.repairs.map((item) => item.newTargetId))),
  };
}
