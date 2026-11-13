import type { SceneCircuitSetting, SwitchEntry } from "../types";
import { supportsPriorityFunction, switchPriorityFunctionGroupKey } from "./switchSync";
import { picoLedSettingId } from "./picoSpecials";

/** Remap only a copied group's own LED targets. Foreign references stay literal. */
export function copiedCircuitSettings(settings: readonly SceneCircuitSetting[], sourceGroup: string, destinationGroup: string): SceneCircuitSetting[] {
  return settings.map(setting => {
    const key = (["mur", "dnd"] as const).find(key => setting.circuitId === picoLedSettingId(sourceGroup, key));
    return { ...setting, circuitId: key ? picoLedSettingId(destinationGroup, key) : setting.circuitId };
  });
}

/** Validate changed rows only; never repair unrelated legacy priority flags. */
export function validOperationPriorities(rows: readonly SwitchEntry[], changed: ReadonlySet<string>): boolean {
  for (const row of rows) {
    if (!changed.has(row.id) || !row.isPriorityFunction) continue;
    if (!supportsPriorityFunction(row)) return false;
    const peers = rows.filter(candidate => supportsPriorityFunction(candidate) && switchPriorityFunctionGroupKey(candidate) === switchPriorityFunctionGroupKey(row));
    if (peers.length < 2 || peers.every(candidate => candidate.isPriorityFunction)) return false;
  }
  return true;
}
