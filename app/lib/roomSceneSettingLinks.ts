import type { RoomScene } from "../types";

/**
 * Permanent setting-link behavior for RoomScene.settingLinkGroupId.
 * Linked Scene columns sync Area Scene selections, Individual Override values,
 * and Backlight condition. RoomScene identity fields stay local.
 */
export function propagateRoomSceneSettingLinks(previous: RoomScene[], next: RoomScene[]): RoomScene[] {
  const prevById = new Map(previous.map((scene) => [scene.id, scene]));
  const settingSourceByGroup = new Map<string, { selections: string; settings: string }>();
  const backlightSourceByGroup = new Map<string, string>();

  for (const scene of next) {
    const groupId = scene.settingLinkGroupId;
    if (!groupId) continue;
    const prev = prevById.get(scene.id);
    if (!prev) continue;

    if (!settingSourceByGroup.has(groupId)) {
      const selections = JSON.stringify(scene.areaSceneSelections ?? []);
      const settings = JSON.stringify(scene.settings);
      if (
        selections !== JSON.stringify(prev.areaSceneSelections ?? []) ||
        settings !== JSON.stringify(prev.settings)
      ) {
        settingSourceByGroup.set(groupId, { selections, settings });
      }
    }
    if (!backlightSourceByGroup.has(groupId) && scene.backlightCondition !== prev.backlightCondition) {
      backlightSourceByGroup.set(groupId, scene.backlightCondition);
    }
  }

  if (settingSourceByGroup.size === 0 && backlightSourceByGroup.size === 0) return next;

  return next.map((scene) => {
    const groupId = scene.settingLinkGroupId;
    if (!groupId) return scene;

    let result = scene;
    const settingSource = settingSourceByGroup.get(groupId);
    if (settingSource) {
      const selections = JSON.parse(settingSource.selections) as RoomScene["areaSceneSelections"];
      const settings = JSON.parse(settingSource.settings) as RoomScene["settings"];
      if (
        JSON.stringify(result.areaSceneSelections ?? []) !== settingSource.selections ||
        JSON.stringify(result.settings) !== settingSource.settings
      ) {
        result = { ...result, areaSceneSelections: selections, settings };
      }
    }

    const backlightCondition = backlightSourceByGroup.get(groupId);
    if (backlightCondition !== undefined && result.backlightCondition !== backlightCondition) {
      result = { ...result, backlightCondition };
    }

    return result;
  });
}

/** A room-scene setting-link group with fewer than two members dissolves. */
export function clearSingletonRoomSceneSettingLinks(rows: RoomScene[]): RoomScene[] {
  const counts = new Map<string, number>();
  for (const scene of rows) {
    if (!scene.settingLinkGroupId) continue;
    counts.set(scene.settingLinkGroupId, (counts.get(scene.settingLinkGroupId) ?? 0) + 1);
  }

  let changed = false;
  const next = rows.map((scene) => {
    if (scene.settingLinkGroupId && (counts.get(scene.settingLinkGroupId) ?? 0) <= 1) {
      changed = true;
      return { ...scene, settingLinkGroupId: undefined };
    }
    return scene;
  });
  return changed ? next : rows;
}

export function normalizeRoomSceneSettingLinksAfterCommit(
  previous: RoomScene[],
  next: RoomScene[],
): RoomScene[] {
  return clearSingletonRoomSceneSettingLinks(propagateRoomSceneSettingLinks(previous, next));
}

export function linkRoomSceneSettingSelection(
  current: RoomScene[],
  selectedIds: ReadonlySet<string>,
  makeGroupId: () => string,
  templateId?: string,
): RoomScene[] {
  const selected = current.filter((scene) => selectedIds.has(scene.id));
  if (selected.length < 2) return current;

  const groupId = selected.find((scene) => scene.settingLinkGroupId)?.settingLinkGroupId ?? makeGroupId();
  const selectedGroupIds = new Set(
    selected.map((scene) => scene.settingLinkGroupId).filter((value): value is string => Boolean(value)),
  );
  const source = current.find((scene) => scene.id === templateId) ?? selected[0];
  const serializedSelections = JSON.stringify(source.areaSceneSelections ?? []);
  const serializedSettings = JSON.stringify(source.settings);

  return current.map((scene) => {
    const joinsSelection =
      selectedIds.has(scene.id) ||
      (Boolean(scene.settingLinkGroupId) && selectedGroupIds.has(scene.settingLinkGroupId as string));
    if (!joinsSelection) return scene;
    if (scene.id === source.id) return { ...scene, settingLinkGroupId: groupId };
    return {
      ...scene,
      settingLinkGroupId: groupId,
      areaSceneSelections: JSON.parse(serializedSelections) as RoomScene["areaSceneSelections"],
      settings: JSON.parse(serializedSettings) as RoomScene["settings"],
      backlightCondition: source.backlightCondition,
    };
  });
}

export function unlinkRoomSceneSettingSelection(
  current: RoomScene[],
  selectedIds: ReadonlySet<string>,
): RoomScene[] {
  if (selectedIds.size === 0) return current;
  return current.map((scene) =>
    selectedIds.has(scene.id) && scene.settingLinkGroupId ? { ...scene, settingLinkGroupId: undefined } : scene,
  );
}
