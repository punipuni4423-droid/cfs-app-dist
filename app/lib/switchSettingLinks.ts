import type { SwitchEntry } from "../types";

/**
 * Shared permanent setting-link behavior for SwitchEntry.settingLinkGroupId.
 * Function settings are deep-copied, Backlight copies the condition only, and
 * backlightTarget is intentionally switch-local wiring.
 */
export function propagateSwitchSettingLinks(previous: SwitchEntry[], next: SwitchEntry[]): SwitchEntry[] {
  const prevById = new Map(previous.map((sw) => [sw.id, sw]));
  const sceneSourceByGroup = new Map<string, string>();
  const backlightSourceByGroup = new Map<string, string>();

  for (const sw of next) {
    const groupId = sw.settingLinkGroupId;
    if (!groupId) continue;
    const prev = prevById.get(sw.id);
    if (!prev) continue;

    if (!sceneSourceByGroup.has(groupId)) {
      const serialized = JSON.stringify(sw.buttonSetting);
      if (serialized !== JSON.stringify(prev.buttonSetting)) {
        sceneSourceByGroup.set(groupId, serialized);
      }
    }
    if (!backlightSourceByGroup.has(groupId) && sw.backlightCondition !== prev.backlightCondition) {
      backlightSourceByGroup.set(groupId, sw.backlightCondition);
    }
  }

  if (sceneSourceByGroup.size === 0 && backlightSourceByGroup.size === 0) return next;

  return next.map((sw) => {
    const groupId = sw.settingLinkGroupId;
    if (!groupId) return sw;

    let result = sw;
    const sceneSetting = sceneSourceByGroup.get(groupId);
    if (sceneSetting !== undefined && JSON.stringify(result.buttonSetting) !== sceneSetting) {
      result = { ...result, buttonSetting: JSON.parse(sceneSetting) as SwitchEntry["buttonSetting"] };
    }

    const backlightCondition = backlightSourceByGroup.get(groupId);
    if (backlightCondition !== undefined && result.backlightCondition !== backlightCondition) {
      result = { ...result, backlightCondition };
    }

    return result;
  });
}

/** A setting-link group with fewer than two members dissolves. */
export function clearSingletonSwitchSettingLinks(rows: SwitchEntry[]): SwitchEntry[] {
  const counts = new Map<string, number>();
  for (const sw of rows) {
    if (!sw.settingLinkGroupId) continue;
    counts.set(sw.settingLinkGroupId, (counts.get(sw.settingLinkGroupId) ?? 0) + 1);
  }

  let changed = false;
  const next = rows.map((sw) => {
    if (sw.settingLinkGroupId && (counts.get(sw.settingLinkGroupId) ?? 0) <= 1) {
      changed = true;
      return { ...sw, settingLinkGroupId: undefined };
    }
    return sw;
  });
  return changed ? next : rows;
}

export function normalizeSwitchSettingLinksAfterCommit(
  previous: SwitchEntry[],
  next: SwitchEntry[],
): SwitchEntry[] {
  return clearSingletonSwitchSettingLinks(propagateSwitchSettingLinks(previous, next));
}

export function linkSwitchSettingSelection(
  current: SwitchEntry[],
  selectedIds: ReadonlySet<string>,
  makeGroupId: () => string,
  templateId?: string,
): SwitchEntry[] {
  const selected = current.filter((sw) => selectedIds.has(sw.id));
  if (selected.length < 2) return current;

  const groupId = selected.find((sw) => sw.settingLinkGroupId)?.settingLinkGroupId ?? makeGroupId();
  const selectedGroupIds = new Set(
    selected.map((sw) => sw.settingLinkGroupId).filter((value): value is string => Boolean(value)),
  );
  const source = current.find((sw) => sw.id === templateId) ?? selected[0];
  const serializedSetting = JSON.stringify(source.buttonSetting);

  return current.map((sw) => {
    const joinsSelection =
      selectedIds.has(sw.id) ||
      (Boolean(sw.settingLinkGroupId) && selectedGroupIds.has(sw.settingLinkGroupId as string));
    if (!joinsSelection) return sw;
    if (sw.id === source.id) return { ...sw, settingLinkGroupId: groupId };
    return {
      ...sw,
      settingLinkGroupId: groupId,
      buttonSetting: JSON.parse(serializedSetting) as SwitchEntry["buttonSetting"],
      backlightCondition: source.backlightCondition,
    };
  });
}

export function unlinkSwitchSettingSelection(
  current: SwitchEntry[],
  selectedIds: ReadonlySet<string>,
): SwitchEntry[] {
  if (selectedIds.size === 0) return current;
  return current.map((sw) =>
    selectedIds.has(sw.id) && sw.settingLinkGroupId ? { ...sw, settingLinkGroupId: undefined } : sw,
  );
}
