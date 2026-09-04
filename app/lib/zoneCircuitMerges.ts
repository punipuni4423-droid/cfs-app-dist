import type { CircuitEntry, DeviceAssignment, Scene, SceneCircuitSetting } from "../types";
import { RESERVED_VALUE } from "./constants";
import { circuitGroupKey, circuitGroupMembers } from "./circuitGroups";

// T-59: a fixed lighting zone may carry up to 5 circuits (1 primary + 4
// additional, DeviceAssignment.additionalCircuitNumbers). These helpers merge
// the additional circuit groups into the primary circuit's representation so
// setting panels and the Area Scene views show one item per zone.

export const MAX_ZONE_CIRCUITS = 5;
export const MAX_ADDITIONAL_ZONE_CIRCUITS = MAX_ZONE_CIRCUITS - 1;

// T-75: single source of the joined circuit-number display of a merged zone
// (" & " with surrounding spaces, e.g. "1 & 4 & 2"). Used by the Device Assign
// summary line and the CFS row model (Designer#/Internal#, Programming Name,
// Excel exports and the Lutron spec follow the row model).
export const ZONE_CIRCUIT_NUMBER_SEPARATOR = " & ";

export function joinZoneCircuitNumbers(values: readonly string[]): string {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .join(ZONE_CIRCUIT_NUMBER_SEPARATOR);
}

// T-88: single source of the joined Detail fallback of a merged zone. While the
// editable zoneDetail is blank, every assigned circuit's Detail is joined with
// " / " (blank details skipped, e.g. "BEd / d / b / e"); an entered zoneDetail
// always wins. Keep this literal here only - callers join via these helpers.
export const ZONE_CIRCUIT_DETAIL_SEPARATOR = " / ";

export function joinZoneCircuitDetails(values: readonly string[]): string {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .join(ZONE_CIRCUIT_DETAIL_SEPARATOR);
}

export function additionalCircuitNumbersOf(
  assignment: Pick<DeviceAssignment, "additionalCircuitNumbers">,
): string[] {
  return (assignment.additionalCircuitNumbers ?? [])
    .map((value) => value.trim())
    .filter((value) => value !== "" && value !== RESERVED_VALUE);
}

export interface ZoneCircuitMerge {
  assignmentId: string;
  // Editable zone Detail ("" while unset - callers fall back to the " / "
  // join of every assigned circuit's Detail, see zoneMergeFallbackDetail).
  zoneDetail: string;
  primaryHead: CircuitEntry;
  primaryMemberIds: string[];
  extraHeads: CircuitEntry[];
  extraMemberIds: string[];
}

// T-88: the display Detail of a merged zone while zoneDetail is blank - the
// " / " join of the primary and additional circuit Details (blank ones
// skipped, "" when every circuit Detail is blank). Computed from the merge
// itself (not from an already-merged target detail) so repeated application
// stays idempotent.
export function zoneMergeFallbackDetail(merge: ZoneCircuitMerge): string {
  return joinZoneCircuitDetails([
    merge.primaryHead.detail,
    ...merge.extraHeads.map((head) => head.detail),
  ]);
}

export interface ZoneCircuitMergeIndex {
  byPrimaryHeadId: Map<string, ZoneCircuitMerge>;
  extraHeadIds: Set<string>;
}

const EMPTY_MERGE_INDEX: ZoneCircuitMergeIndex = {
  byPrimaryHeadId: new Map(),
  extraHeadIds: new Set(),
};

function findCircuitByNumber(
  circuits: readonly CircuitEntry[],
  value: string,
): CircuitEntry | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === RESERVED_VALUE) return undefined;
  return circuits.find(
    (circuit) => circuit.designerNumber === trimmed || circuit.internalNumber === trimmed,
  );
}

function groupHeadOf(circuits: readonly CircuitEntry[], circuit: CircuitEntry): CircuitEntry {
  return circuitGroupMembers(circuits, circuit)[0] ?? circuit;
}

export function buildZoneCircuitMerges(
  circuits: readonly CircuitEntry[],
  deviceAssignments: readonly DeviceAssignment[],
): ZoneCircuitMergeIndex {
  let byPrimaryHeadId: Map<string, ZoneCircuitMerge> | null = null;
  let extraHeadIds: Set<string> | null = null;
  for (const assignment of deviceAssignments) {
    const additionalNumbers = additionalCircuitNumbersOf(assignment);
    if (additionalNumbers.length === 0) continue;
    const primaryMatch = findCircuitByNumber(circuits, assignment.circuitNumber);
    if (!primaryMatch || primaryMatch.dimmingType === "DALI") continue;
    const primaryHead = groupHeadOf(circuits, primaryMatch);
    const seenGroupKeys = new Set([circuitGroupKey(primaryHead)]);
    const extraHeads: CircuitEntry[] = [];
    const extraMemberIds: string[] = [];
    for (const value of additionalNumbers) {
      const match = findCircuitByNumber(circuits, value);
      if (!match || match.dimmingType === "DALI") continue;
      const key = circuitGroupKey(match);
      if (seenGroupKeys.has(key)) continue;
      seenGroupKeys.add(key);
      const head = groupHeadOf(circuits, match);
      extraHeads.push(head);
      for (const member of circuitGroupMembers(circuits, head)) {
        extraMemberIds.push(member.id);
      }
    }
    if (extraHeads.length === 0) continue;
    byPrimaryHeadId = byPrimaryHeadId ?? new Map();
    extraHeadIds = extraHeadIds ?? new Set();
    if (byPrimaryHeadId.has(primaryHead.id)) continue;
    byPrimaryHeadId.set(primaryHead.id, {
      assignmentId: assignment.id,
      zoneDetail: (assignment.zoneDetail ?? "").trim(),
      primaryHead,
      primaryMemberIds: circuitGroupMembers(circuits, primaryHead).map((member) => member.id),
      extraHeads,
      extraMemberIds,
    });
    for (const head of extraHeads) extraHeadIds.add(head.id);
  }
  if (!byPrimaryHeadId || !extraHeadIds) return EMPTY_MERGE_INDEX;
  return { byPrimaryHeadId, extraHeadIds };
}

// Merges targets built per circuit-group head: drops the standalone targets of
// additional circuits and extends the primary target so writes reach every
// circuit of the zone (settingTargetIds). Generic so AreaSceneTarget keeps its
// extra fields.
export function applyZoneMergesToSettingTargets<
  T extends { id: string; detail: string; groupCircuitIds?: string[] },
>(targets: T[], merges: ZoneCircuitMergeIndex): T[] {
  if (merges.byPrimaryHeadId.size === 0) return targets;
  const result: T[] = [];
  for (const target of targets) {
    if (merges.extraHeadIds.has(target.id)) continue;
    const merge = merges.byPrimaryHeadId.get(target.id);
    if (!merge) {
      result.push(target);
      continue;
    }
    const ids = new Set([
      ...(target.groupCircuitIds && target.groupCircuitIds.length > 0
        ? target.groupCircuitIds
        : [target.id]),
      ...merge.extraMemberIds,
    ]);
    result.push({
      ...target,
      groupCircuitIds: Array.from(ids),
      detail: merge.zoneDetail || zoneMergeFallbackDetail(merge) || target.detail,
    });
  }
  return result;
}

// For circuit-head based lists (Area Scene tab): hide additional heads and show
// the zone Detail on the primary head. Returns the input array when no merge
// applies.
export function mergeZoneCircuitHeads(
  heads: CircuitEntry[],
  merges: ZoneCircuitMergeIndex,
): CircuitEntry[] {
  if (merges.byPrimaryHeadId.size === 0) return heads;
  let changed = false;
  const result: CircuitEntry[] = [];
  for (const head of heads) {
    if (merges.extraHeadIds.has(head.id)) {
      changed = true;
      continue;
    }
    const merge = merges.byPrimaryHeadId.get(head.id);
    const mergedDetail = merge ? merge.zoneDetail || zoneMergeFallbackDetail(merge) : "";
    if (merge && mergedDetail && mergedDetail !== head.detail) {
      changed = true;
      result.push({ ...head, detail: mergedDetail });
      continue;
    }
    result.push(head);
  }
  return changed ? result : heads;
}

function applyValueToCircuitIds(
  settings: readonly SceneCircuitSetting[],
  circuitIds: readonly string[],
  value: string,
): SceneCircuitSetting[] | null {
  const idSet = new Set(circuitIds);
  if (!value) {
    if (!settings.some((setting) => idSet.has(setting.circuitId) && setting.percentage.trim() !== "")) {
      return null;
    }
    return settings.filter((setting) => !idSet.has(setting.circuitId));
  }
  const missing = new Set(circuitIds);
  let changed = false;
  const next = settings.map((setting) => {
    if (!idSet.has(setting.circuitId)) return setting;
    missing.delete(setting.circuitId);
    if (setting.percentage === value) return setting;
    changed = true;
    return { ...setting, percentage: value };
  });
  if (missing.size === 0 && !changed) return null;
  return [
    ...next,
    ...Array.from(missing).map((circuitId) => ({ circuitId, percentage: value })),
  ];
}

// Keeps Area Scene settings of a merged zone in sync: the primary circuit
// group's value (the one the merged row edits) is propagated to the additional
// circuit groups; an empty primary clears them. Only scenes of the primary
// circuit's area are touched so additional circuits keep their own-area scene
// values untouched.
export function syncSceneSettingsAcrossZoneMerges(
  scenes: Scene[],
  merges: ZoneCircuitMergeIndex,
): Scene[] {
  if (merges.byPrimaryHeadId.size === 0) return scenes;
  let changed = false;
  const next = scenes.map((scene) => {
    let settings: SceneCircuitSetting[] | readonly SceneCircuitSetting[] = scene.settings;
    let sceneChanged = false;
    for (const merge of merges.byPrimaryHeadId.values()) {
      if (scene.areaId !== merge.primaryHead.area) continue;
      const valueById = new Map(settings.map((setting) => [setting.circuitId, setting.percentage]));
      const primaryValue =
        merge.primaryMemberIds
          .map((id) => (valueById.get(id) ?? "").trim())
          .find((value) => value !== "") ?? "";
      const updated = applyValueToCircuitIds(settings, merge.extraMemberIds, primaryValue);
      if (updated) {
        settings = updated;
        sceneChanged = true;
      }
    }
    if (!sceneChanged) return scene;
    changed = true;
    return { ...scene, settings: settings as SceneCircuitSetting[] };
  });
  return changed ? next : scenes;
}
