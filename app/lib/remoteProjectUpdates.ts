import type { CollaborationProjectUpdate } from '../types';

export const PROJECT_UPDATE_LIMIT = 2000;
export function updateTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

/** null means unknown, not an empty authoritative project snapshot. */
export function parseProjectUpdates(value: unknown): CollaborationProjectUpdate[] | null {
  if (!Array.isArray(value) || value.length > PROJECT_UPDATE_LIMIT) return null;
  const ids = new Set<string>();
  const updates: CollaborationProjectUpdate[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id || row.id.length > 200 || ids.has(row.id)) return null;
    ids.add(row.id);
    if (updateTime(row.updatedAt) === null) continue;
    const author = row.lastUpdatedBy && typeof row.lastUpdatedBy === 'object' ? row.lastUpdatedBy as Record<string, unknown> : null;
    if (!author || typeof author.userId !== 'string' || !author.userId.trim() || author.userId.length > 200
      || author.updatedAt !== row.updatedAt) continue;
    updates.push({ id: row.id, updatedAt: row.updatedAt as string, lastUpdatedBy: {
      userId: author.userId, updatedAt: row.updatedAt as string,
      displayName: typeof author.displayName === 'string' && author.displayName.trim() ? author.displayName.trim().slice(0, 120) : 'Another user',
    } });
  }
  return updates;
}

export function mergeProjectUpdates(known: ReadonlyMap<string, CollaborationProjectUpdate>, next: readonly CollaborationProjectUpdate[]) {
  const merged = new Map(known);
  for (const row of next) {
    const previous = merged.get(row.id);
    if (!previous || updateTime(row.updatedAt)! > updateTime(previous.updatedAt)!) merged.set(row.id, row);
  }
  return merged;
}

export function unreadProjectUpdates(known: ReadonlyMap<string, CollaborationProjectUpdate>, baseline: ReadonlyMap<string, string>, userId: string) {
  return new Map([...known].filter(([id, row]) => {
    const time = updateTime(baseline.get(id));
    return time !== null && updateTime(row.updatedAt)! > time && Boolean(row.lastUpdatedBy?.userId) && row.lastUpdatedBy!.userId !== userId;
  }));
}
