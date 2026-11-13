export const CFS_OFF_VALUE_COLOR = "#2563eb";

export function isOffLikeDisplayValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "Off" || trimmed === "0%" || trimmed === "0";
}

// Keep the on-screen CFS palette and Excel scene-name runs in the same order.
const SCENE_NAME_COLORS = [
  "#b45309", "#0f766e", "#7c3aed", "#be185d", "#166534",
  "#0369a1", "#a16207", "#dc2626", "#4d7c0f", "#6d28d9",
];

export function sceneNameColor(name: string): string {
  const normalized = name.trim().toLowerCase();
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
  }
  return SCENE_NAME_COLORS[hash % SCENE_NAME_COLORS.length];
}

export function buildSceneNameColors(scenes: ReadonlyArray<{ name: string }>): Map<string, string> {
  const colors = new Map<string, string>();
  for (const scene of scenes) {
    const key = scene.name.trim().toLowerCase();
    if (!key || isOffLikeDisplayValue(scene.name) || colors.has(key)) continue;
    colors.set(key, SCENE_NAME_COLORS[colors.size % SCENE_NAME_COLORS.length]);
  }
  return colors;
}
