import { createHash } from 'node:crypto';
import type { ProjectData, RoomType } from '../types';
import { canonicalJson } from './canonicalJson';
import { commonRevisions, commonRestoreProblem } from './projectCommonHistory';
import type { ProjectBase, RestoreSource } from './projectBase';

/** Local files have no SQL version counter. This token is only used in local mode. */
export function localProjectBase(project: ProjectData): ProjectBase {
  return { version: 1, hash: createHash('sha256').update(canonicalJson(project)!).digest('hex'), updatedAt: project.updatedAt };
}
export function localRevisionRestore(project: ProjectData, source: RestoreSource): ProjectData {
  if (source.kind === 'common-revision') {
    const revision = commonRevisions(project).find(item => item.id === source.id);
    if (!revision) throw new Error('The common revision is unavailable.');
    const problem = commonRestoreProblem(project, revision.snapshot);
    if (problem) throw new Error(problem);
    return { ...project, ...structuredClone(revision.snapshot) };
  }
  if (source.kind !== 'room-type-revision') throw new Error('Automatic server history requires secure sharing.');
  const room = project.roomTypes.find(item => item.id === source.roomTypeId);
  const revision = room?.revisions?.find(item => item.id === source.revisionId);
  if (!room || !revision) throw new Error('The room revision is unavailable.');
  const snapshot = JSON.parse(revision.snapshot) as Record<string, unknown>;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('The revision snapshot is invalid.');
  const restored: RoomType = { ...room, revision: revision.revision };
  const values = restored as unknown as Record<string, unknown>;
  for (const key of ['rows','dryContacts','deviceAssignments','hvacAssignments','hvacSeasons','curtainAssignments','cfsRowDisplay','backlightLevels','scenes','roomScenes','switches','pduDeviceCounts','inspectionMarks']) {
    if (snapshot[key] == null) continue;
    if (key === 'cfsRowDisplay' ? typeof snapshot[key] !== 'object' || Array.isArray(snapshot[key]) : !Array.isArray(snapshot[key])) throw new Error('The revision snapshot is invalid.');
    values[key] = structuredClone(snapshot[key]);
  }
  let circuits = project.circuits;
  if (snapshot.circuits != null) {
    if (!Array.isArray(snapshot.circuits)) throw new Error('Revision circuits are invalid.');
    const historic = snapshot.circuits as ProjectData['circuits'];
    if (historic.some(item => !item || typeof item.id !== 'string') || new Set(historic.map(item => item.id)).size !== historic.length) throw new Error('Revision circuits are invalid.');
    if (Array.isArray(room.circuitIds)) {
      const scoped = new Set(room.circuitIds), replacements = new Map(historic.map(item => [item.id, item]));
      if (circuits.some(item => !scoped.has(item.id) && replacements.has(item.id))) throw new Error('Revision circuits conflict with another room type.');
      circuits = circuits.flatMap(item => {
        if (!scoped.has(item.id)) return [item];
        const replacement = replacements.get(item.id); replacements.delete(item.id);
        return replacement ? [replacement] : [];
      });
      circuits.push(...replacements.values()); restored.circuitIds = historic.map(item => item.id);
    } else circuits = historic;
  }
  return { ...project, circuits, roomTypes: project.roomTypes.map(item => item.id === room.id ? restored : item) };
}
