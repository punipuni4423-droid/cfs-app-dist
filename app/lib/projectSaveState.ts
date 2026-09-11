import type { ProjectData } from "../types";
import { valuesDiffer } from "./canonicalJson";

export interface ProjectSaveReceipt {
  before: ProjectData;
  saved: ProjectData;
}

// Edit timestamps describe activity, not unsaved business content. Revision
// entries retain their dates/authors: those are explicitly editable fields.
function content(project: ProjectData) {
  return {
    ...project,
    updatedAt: undefined,
    lastUpdatedBy: undefined,
    lastSaveOperation: undefined,
    roomTypes: project.roomTypes.map((room) => ({ ...room, updatedAt: undefined })),
  };
}

export function hasProjectChanges(current: ProjectData, persisted: ProjectData | undefined): boolean {
  return !persisted || valuesDiffer(content(current), content(persisted));
}

export function nextProjectEditTime(...previous: string[]): string {
  return new Date(Math.max(Date.now(), ...previous.map((value) => (Date.parse(value) || 0) + 1))).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identified(value: unknown[]): value is Array<Record<string, unknown> & { id: string }> {
  return value.every((entry) => isRecord(entry) && typeof entry.id === "string")
    && new Set(value.map((entry) => (entry as { id: string }).id)).size === value.length;
}

// Apply the save delta to a newer edit (or an Undo snapshot). When both sides
// changed a value, keep the edit. ID-based arrays also keep newly saved
// revisions without replacing edited notes or regenerating their snapshots.
function rebase(before: unknown, saved: unknown, current: unknown): unknown {
  if (current === before || !valuesDiffer(current, before)) return saved;
  if (saved === before || !valuesDiffer(saved, before)) return current;
  if (before === undefined && Array.isArray(saved) && Array.isArray(current)) before = [];
  if (Array.isArray(before) && Array.isArray(saved) && Array.isArray(current)
    && identified(before) && identified(saved) && identified(current)) {
    const oldById = new Map(before.map((entry) => [entry.id, entry]));
    const savedById = new Map(saved.map((entry) => [entry.id, entry]));
    const currentById = new Map(current.map((entry) => [entry.id, entry]));
    const result = current.flatMap((entry) => {
      const old = oldById.get(entry.id);
      const persisted = savedById.get(entry.id);
      if (old && !persisted && !valuesDiffer(old, entry)) return [];
      return [old && persisted ? rebase(old, persisted, entry) : entry];
    });
    for (const entry of saved) {
      if (!oldById.has(entry.id) && !currentById.has(entry.id)) result.push(entry);
    }
    return result;
  }
  if (isRecord(before) && isRecord(saved) && isRecord(current)) {
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(saved), ...Object.keys(current)])) {
      const value = rebase(before[key], saved[key], current[key]);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  return current;
}

export function rebaseProjectSave(receipt: ProjectSaveReceipt, current: ProjectData): ProjectData {
  if (current.id !== receipt.saved.id) return current;
  const merged = rebase(receipt.before, receipt.saved, current) as ProjectData;
  const dirty = hasProjectChanges(merged, receipt.saved);
  // Local draft recovery compares timestamps. A remaining draft must be newer
  // than the saved response, even if the server's clock is ahead of this PC.
  return {
    ...merged,
    updatedAt: dirty ? nextProjectEditTime(receipt.saved.updatedAt, current.updatedAt) : receipt.saved.updatedAt,
    lastUpdatedBy: receipt.saved.lastUpdatedBy,
  };
}
