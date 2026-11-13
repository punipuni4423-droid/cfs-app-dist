import type { RoomScene } from "../types";
import { isPmsScene } from "./roomScenes";

export const SCENE_COLUMN_GROUP_VERSION = 2;
export const PMS_SCENE_GROUP_KEY = "scene\u0000Scene";
export const DOOR_MAGNET_SCENE_GROUP_KEY = "scene\u0000DoorMagnetScene";
export const DOOR_MAGNET_SCENE_LABEL = "Door Magnet Scene";

export function roomSceneColumnGroupLabel(scene: RoomScene): string {
  return isPmsScene(scene) ? "Scene" : DOOR_MAGNET_SCENE_LABEL;
}

export function roomSceneColumnGroupKey(scene: RoomScene): string {
  return isPmsScene(scene) ? PMS_SCENE_GROUP_KEY : DOOR_MAGNET_SCENE_GROUP_KEY;
}

// Before version 2, one Scene group controlled both kinds. Expand its saved
// position/visibility once, then let the two groups be controlled separately.
export function upgradeSceneColumnGroupKeys(keys: readonly string[], version?: number): string[] {
  if (version === SCENE_COLUMN_GROUP_VERSION) return [...keys];
  return Array.from(new Set(keys.flatMap((key) =>
    key === PMS_SCENE_GROUP_KEY ? [key, DOOR_MAGNET_SCENE_GROUP_KEY] : [key],
  )));
}
