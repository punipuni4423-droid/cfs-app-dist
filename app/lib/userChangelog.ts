/** Independent of project storage, schema versions, and the update API. */
export const USER_CHANGELOG_SEEN_KEY = 'cfs-user-changelog-seen-v1';
export const USER_CHANGELOG_DISPLAY_LIMIT = 5;

export interface UserChangelogEntry {
  id: string;
  date: string;
  title: string;
  items: string[];
}

export interface UserChangelogSelection {
  latestId: string | null;
  initialize: boolean;
  visible: UserChangelogEntry[];
  remaining: number;
}

/** Entries are retained in release order, newest first; IDs are opaque. */
export function selectUnreadChangelog(
  entries: readonly UserChangelogEntry[],
  stored: string | null,
): UserChangelogSelection {
  const latestId = entries[0]?.id ?? null;
  const empty = { latestId, initialize: false, visible: [], remaining: 0 };
  if (!latestId) return empty;
  if (stored === null) return { ...empty, visible: entries.slice(0, 1) };
  let lastSeenId: string | null = null;
  try {
    const value: unknown = JSON.parse(stored);
    if (value && typeof value === 'object' && !Array.isArray(value)
      && 'lastSeenId' in value && typeof value.lastSeenId === 'string' && value.lastSeenId.trim()) {
      lastSeenId = value.lastSeenId;
    }
  } catch { /* Invalid state is silently reset; it is not a missing key or project recovery. */ }
  if (lastSeenId === null) return { ...empty, initialize: true };
  const seenIndex = entries.findIndex(entry => entry.id === lastSeenId);
  // A valid unknown ID may have aged out of the retained history.
  const unread = seenIndex < 0 ? entries : entries.slice(0, seenIndex);
  return {
    latestId, initialize: false,
    visible: unread.slice(0, USER_CHANGELOG_DISPLAY_LIMIT),
    remaining: Math.max(0, unread.length - USER_CHANGELOG_DISPLAY_LIMIT),
  };
}

export function saveChangelogSeen(storage: Pick<Storage, 'setItem'>, latestId: string): boolean {
  try {
    storage.setItem(USER_CHANGELOG_SEEN_KEY, JSON.stringify({ lastSeenId: latestId }));
    return true;
  } catch { return false; }
}

export function loadUnreadChangelog(
  entries: readonly UserChangelogEntry[],
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'>,
): UserChangelogSelection {
  try {
    const storage = getStorage();
    const result = selectUnreadChangelog(entries, storage.getItem(USER_CHANGELOG_SEEN_KEY));
    if (result.initialize && result.latestId) saveChangelogSeen(storage, result.latestId);
    return result;
  } catch {
    // Disabled storage must never prevent the project list from opening.
    return { latestId: null, initialize: false, visible: [], remaining: 0 };
  }
}
