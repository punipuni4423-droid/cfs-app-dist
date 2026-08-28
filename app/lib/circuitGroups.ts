import type { CircuitEntry, SceneCircuitSetting } from "../types";

export function circuitGroupKey(circuit: Pick<CircuitEntry, "id" | "circuitGroupId">): string {
  return circuit.circuitGroupId.trim() || circuit.id;
}

/**
 * Sets FFE for every circuit row that uses one of the given fixtures,
 * propagated like the FFE checkbox: whole circuit group plus, for DALI rows,
 * the DALI fixture block. Rows in unrelated groups (including manually
 * checked ones) are never touched. Returns the original array when nothing
 * changes.
 */
export function setFfeOnCircuitsUsingFixtures(
  circuits: CircuitEntry[],
  fixtureNames: readonly string[],
  value: boolean,
): CircuitEntry[] {
  const names = new Set(fixtureNames.map((name) => name.trim()).filter((name) => name !== ""));
  if (names.size === 0) return circuits;
  const seedIds = new Set<string>();
  const groupKeys = new Set<string>();
  const daliBlockIds = new Set<string>();
  for (const circuit of circuits) {
    if (!names.has(circuit.fixture)) continue;
    seedIds.add(circuit.id);
    if (circuit.circuitGroupId.trim() !== "") groupKeys.add(circuitGroupKey(circuit));
    if (circuit.dimmingType === "DALI" && circuit.daliFixtureGroupId !== "") {
      daliBlockIds.add(circuit.daliFixtureGroupId);
    }
  }
  if (seedIds.size === 0) return circuits;
  let changed = false;
  const next = circuits.map((circuit) => {
    const hit =
      seedIds.has(circuit.id) ||
      (circuit.circuitGroupId.trim() !== "" && groupKeys.has(circuitGroupKey(circuit))) ||
      (circuit.daliFixtureGroupId !== "" && daliBlockIds.has(circuit.daliFixtureGroupId));
    if (hit && circuit.ffe !== value) {
      changed = true;
      return { ...circuit, ffe: value };
    }
    return circuit;
  });
  return changed ? next : circuits;
}

export function uniqueCircuitGroupHeads(circuits: readonly CircuitEntry[]): CircuitEntry[] {
  const seen = new Set<string>();
  const heads: CircuitEntry[] = [];
  for (const circuit of circuits) {
    const key = circuitGroupKey(circuit);
    if (seen.has(key)) continue;
    seen.add(key);
    heads.push(circuit);
  }
  return heads;
}

export function circuitGroupMembers(circuits: readonly CircuitEntry[], circuit: CircuitEntry): CircuitEntry[] {
  const key = circuitGroupKey(circuit);
  return circuits.filter((candidate) => circuitGroupKey(candidate) === key);
}

export function sceneSettingValueForCircuitGroup(
  settings: readonly SceneCircuitSetting[],
  circuits: readonly CircuitEntry[],
  circuit: CircuitEntry,
): string {
  const byCircuitId = new Map(settings.map((setting) => [setting.circuitId, setting.percentage]));
  for (const member of circuitGroupMembers(circuits, circuit)) {
    const value = byCircuitId.get(member.id)?.trim();
    if (value) return value;
  }
  return "";
}

export function setSceneSettingValueForCircuitGroup(
  settings: readonly SceneCircuitSetting[],
  circuits: readonly CircuitEntry[],
  circuit: CircuitEntry,
  value: string,
): SceneCircuitSetting[] {
  const targetIds = new Set(circuitGroupMembers(circuits, circuit).map((member) => member.id));
  const trimmed = value.trim();
  const retained = settings
    .filter((setting) => !targetIds.has(setting.circuitId))
    .map((setting) => ({ ...setting }));
  if (!trimmed) return retained;
  return [
    ...retained,
    ...Array.from(targetIds).map((circuitId) => ({ circuitId, percentage: trimmed })),
  ];
}

export function normalizeSceneSettingsByCircuitGroup(
  settings: readonly SceneCircuitSetting[] | undefined,
  circuits: readonly CircuitEntry[],
): SceneCircuitSetting[] {
  const sourceSettings = settings ?? [];
  const circuitById = new Map(circuits.map((circuit) => [circuit.id, circuit]));
  const idsByGroup = new Map<string, string[]>();
  for (const circuit of circuits) {
    const key = circuitGroupKey(circuit);
    const ids = idsByGroup.get(key) ?? [];
    ids.push(circuit.id);
    idsByGroup.set(key, ids);
  }

  const valueByGroup = new Map<string, string>();
  const syntheticSettings: SceneCircuitSetting[] = [];
  for (const setting of sourceSettings) {
    const circuit = circuitById.get(setting.circuitId);
    if (!circuit) {
      syntheticSettings.push({ ...setting });
      continue;
    }
    const value = setting.percentage.trim();
    if (!value) continue;
    const key = circuitGroupKey(circuit);
    if (!valueByGroup.has(key)) valueByGroup.set(key, value);
  }

  const normalized = [...syntheticSettings];
  for (const [key, ids] of idsByGroup.entries()) {
    const value = valueByGroup.get(key);
    if (!value) continue;
    for (const circuitId of ids) {
      normalized.push({ circuitId, percentage: value });
    }
  }
  return normalized;
}

export function sameSceneSettings(
  left: readonly SceneCircuitSetting[] | undefined,
  right: readonly SceneCircuitSetting[] | undefined,
): boolean {
  const normalizeForCompare = (settings: readonly SceneCircuitSetting[] | undefined) =>
    [...(settings ?? [])]
      .map((setting) => ({
        circuitId: setting.circuitId,
        percentage: setting.percentage.trim(),
      }))
      .sort((a, b) =>
        a.circuitId === b.circuitId
          ? a.percentage.localeCompare(b.percentage)
          : a.circuitId.localeCompare(b.circuitId),
      );
  return JSON.stringify(normalizeForCompare(left)) === JSON.stringify(normalizeForCompare(right));
}
