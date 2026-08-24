import type { RoomScene } from "../types";
import { createAppId } from './id';

const DEFAULT_TEMPLATES: Array<Pick<RoomScene, "phase" | "sceneType" | "detail" | "triggerCondition">> = [
  { phase: "Check In", sceneType: "Welcome Scene", detail: "", triggerCondition: "Day" },
  { phase: "Check In", sceneType: "Welcome Scene", detail: "", triggerCondition: "Night" },
  { phase: "Check In", sceneType: "Re-entry Scene", detail: "", triggerCondition: "Day" },
  { phase: "Check In", sceneType: "Re-entry Scene", detail: "", triggerCondition: "Night" },
  { phase: "Check In", sceneType: "Unoccupied Scene", detail: "", triggerCondition: "" },
  { phase: "Check Out", sceneType: "Occupied Scene", detail: "", triggerCondition: "" },
  { phase: "Check Out", sceneType: "Unoccupied Scene", detail: "", triggerCondition: "" },
];

function createDefaultRoomSceneId(
  template: Pick<RoomScene, "phase" | "sceneType" | "detail" | "triggerCondition">,
): string {
  return `default-${template.phase}-${template.sceneType}-${template.detail}-${template.triggerCondition}`.replace(/\s+/g, "-");
}

function createDefaultPmsSceneId(triggerCondition: string): string {
  return `default-pms-${triggerCondition}`.replace(/\s+/g, "-");
}

function createDefaultScene(
  template: Pick<RoomScene, "phase" | "sceneType" | "detail" | "triggerCondition">,
): RoomScene {
  return {
    id: createDefaultRoomSceneId(template),
    kind: "standard",
    ...template,
    backlightCondition: "",
    areaSceneSelections: [],
    settings: [],
  };
}

export function defaultRoomScenes(): RoomScene[] {
  return DEFAULT_TEMPLATES.map(createDefaultScene);
}

export function defaultPmsScenes(): RoomScene[] {
  return [
    { phase: "Check In" as const, sceneType: "From PMS", detail: "", triggerCondition: "Check In" },
    { phase: "Check Out" as const, sceneType: "From PMS", detail: "", triggerCondition: "Check Out" },
  ].map((template) => ({
    id: createDefaultPmsSceneId(template.triggerCondition),
    kind: "pms",
    ...template,
    backlightCondition: "",
    areaSceneSelections: [],
    settings: [],
  }));
}

function isLegacyPmsScene(scene: RoomScene): boolean {
  return scene.sceneType.trim().toLowerCase().startsWith("from pms") ||
    scene.triggerCondition.trim().toLowerCase().startsWith("from pms");
}

export function isPmsScene(scene: RoomScene): boolean {
  if (scene.kind === "pms") return true;
  if (scene.kind === "standard") return false;
  return isLegacyPmsScene(scene);
}

function ensureRoomSceneKind(scene: RoomScene): RoomScene {
  if (scene.kind === "pms" || scene.kind === "standard") return scene;
  return { ...scene, kind: isLegacyPmsScene(scene) ? "pms" : "standard" };
}

export function dedupeRoomSceneIds(
  roomScenes: RoomScene[],
  createId: () => string = () => createAppId(),
): RoomScene[] {
  const seen = new Set<string>();
  let changed = false;
  const next = roomScenes.map((scene) => {
    if (!seen.has(scene.id)) {
      seen.add(scene.id);
      return scene;
    }
    changed = true;
    const id = createId();
    seen.add(id);
    return { ...scene, id };
  });
  return changed ? next : roomScenes;
}

// Canonical room-scene order (2026-08-24): PMS scenes always come before the
// Door Magnet (standard) scenes, matching the Scene tab layout, regardless of
// when a row was added. Within each group the insertion order is kept.
export function sortRoomScenesByGroup(roomScenes: RoomScene[]): RoomScene[] {
  const sorted = [...roomScenes.filter(isPmsScene), ...roomScenes.filter((scene) => !isPmsScene(scene))];
  return sorted.every((scene, index) => scene === roomScenes[index]) ? roomScenes : sorted;
}

export function ensureRoomScenes(
  roomScenes: RoomScene[],
  createId?: () => string,
): RoomScene[] {
  const deduped = dedupeRoomSceneIds(roomScenes, createId);
  const normalized = deduped.map(ensureRoomSceneKind);
  const kindsChanged = normalized.some((scene, index) => scene !== deduped[index]);
  const next = kindsChanged ? normalized : deduped;
  if (next.length === 0) return [...defaultPmsScenes(), ...defaultRoomScenes()];
  if (next.some(isPmsScene)) return sortRoomScenesByGroup(next);
  return [...defaultPmsScenes(), ...next];
}
