import type { ProjectData } from '../types';

/** Opaque hash of the exact PostgreSQL JSONB payload read together with version. */
export interface ProjectBase { version: number; hash: string; updatedAt: string }
export type RestoreSource = { kind: 'history'; id: string }
  | { kind: 'room-type-revision'; roomTypeId: string; revisionId: string }
  | { kind: 'common-revision'; id: string };
const loaded = new WeakMap<ProjectData, ProjectBase>();
const captured = new Map<string, ProjectBase | null>();
const key = (id: string, timestamp: string) => JSON.stringify([id, timestamp]);
export function validProjectBase(value: unknown): value is ProjectBase {
  const base = value as ProjectBase | null;
  return Boolean(base && Number.isSafeInteger(base.version) && base.version >= 1
    && typeof base.hash === 'string' && /^[a-f0-9]{64}$/.test(base.hash)
    && typeof base.updatedAt === 'string' && base.updatedAt);
}
export function registerProjectBases(projects: readonly ProjectData[], response: unknown): void {
  const bases = (response as { bases?: Record<string, unknown> } | null)?.bases;
  for (const project of projects) {
    const base = bases?.[project.id];
    if (!validProjectBase(base) || base.updatedAt !== project.updatedAt) continue;
    const value = Object.freeze({ ...base });
    loaded.set(project, value);
    const token = key(project.id, project.updatedAt);
    const previous = captured.get(token);
    captured.set(token, previous === null || previous && (previous.hash !== value.hash || previous.version !== value.version) ? null : value);
  }
}
export function projectBase(project?: ProjectData): ProjectBase | undefined { return project ? loaded.get(project) : undefined; }
/** Exact loaded timestamp only; never substitute the latest head for an old draft. */
export function capturedProjectBase(id: string, timestamp?: string | null): ProjectBase | undefined {
  return timestamp ? captured.get(key(id, timestamp)) ?? undefined : undefined;
}
