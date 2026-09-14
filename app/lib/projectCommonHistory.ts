import type { ProjectCommonRevision, ProjectCommonSnapshot, ProjectData } from '../types';
import { valuesDiffer } from './canonicalJson';
import { createAppId } from './id';

export function commonSnapshot(project: ProjectData): ProjectCommonSnapshot {
  return structuredClone({ name: project.name, settings: project.settings, remarks: project.remarks,
    locations: project.locations, fixtures: project.fixtures });
}
export function validCommonRevision(value: unknown): value is ProjectCommonRevision {
  if (!value || typeof value !== 'object') return false;
  const v = value as ProjectCommonRevision;
  const record = (item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item);
  return typeof v.id === 'string' && v.id.trim().length > 0 && typeof v.revision === 'string' && /^P[1-9][0-9]*$/.test(v.revision)
    && typeof v.savedAt === 'string' && v.savedAt.trim().length > 0 && typeof v.note === 'string'
    && typeof v.savedBy === 'string'
    && ((v as ProjectCommonRevision & { operationId?: unknown }).operationId === undefined || typeof (v as ProjectCommonRevision & { operationId?: unknown }).operationId === 'string')
    && record(v.snapshot) && typeof v.snapshot.name === 'string' && (v.snapshot.settings === undefined || record(v.snapshot.settings))
    && (v.snapshot.remarks === undefined || (Array.isArray(v.snapshot.remarks) && v.snapshot.remarks.every(record)))
    && Array.isArray(v.snapshot.locations) && v.snapshot.locations.every(record)
    && Array.isArray(v.snapshot.fixtures) && v.snapshot.fixtures.every(record);
}
export function validCommonHistory(value: unknown): value is ProjectCommonRevision[] {
  return Array.isArray(value) && value.every(validCommonRevision) && new Set(value.map(item => item.id)).size === value.length && new Set(value.map(item => item.revision)).size === value.length;
}
export function commonRevisions(project: ProjectData): ProjectCommonRevision[] {
  return Array.isArray(project.commonRevisions) ? project.commonRevisions.filter(validCommonRevision) : [];
}
export function appendCommonRevision(project: ProjectData, note: string, savedBy: string): ProjectData {
  if (project.commonRevisions !== undefined && !validCommonHistory(project.commonRevisions)) throw new Error('Common history is invalid. Keep the original data for review.');
  const history = commonRevisions(project);
  const snapshot = commonSnapshot(project);
  if (history.length && !valuesDiffer(history.at(-1)!.snapshot, snapshot)) return project;
  return { ...project, commonRevisions: [...history, { id: createAppId(), revision: `P${Math.max(0, ...history.map(item => Number(item.revision.slice(1)))) + 1}`,
    savedAt: new Date().toISOString(), savedBy, note, snapshot }] };
}
/** Removing a referenced master is not a safe common-only restoration. */
export function commonRestoreProblem(project: ProjectData, snapshot: ProjectCommonSnapshot): string {
  const areas = new Set(snapshot.locations.map(area => area.id));
  const targetFixtureNames = new Set(snapshot.fixtures.map(fixture => fixture.fixture));
  const removedFixtures = new Set(project.fixtures.filter(fixture => !targetFixtureNames.has(fixture.fixture)).map(fixture => fixture.fixture));
  if (project.circuits.some(circuit => (circuit.area && !areas.has(circuit.area)) || removedFixtures.has(circuit.fixture))) {
    return 'The restore snapshot is missing an Area or Fixture referenced by a current circuit. Export JSON and check the references.';
  }
  if (project.roomTypes.some(room => room.deviceAssignments.some(assignment => assignment.area && !areas.has(assignment.area)))) {
    return 'The restore snapshot is missing an Area referenced by a current device assignment.';
  }
  if (project.roomTypes.some(room => room.scenes.some(scene => !areas.has(scene.areaId)) || room.roomScenes.some(scene => scene.areaSceneSelections.some(selection => !areas.has(selection.areaId))))) return 'The restore snapshot is missing an Area referenced by a current Scene.';
  return '';
}
