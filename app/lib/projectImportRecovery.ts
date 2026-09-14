import type { ProjectData } from '../types';
import type { ProjectDraftRecord } from './projectDraftStore';
import { canonicalJson } from './canonicalJson';
import { projectFingerprint } from './projectSaveProtocol';

export interface ImportRecovery {
  version: 1;
  batchId: string;
  targetIds: string[];
  expectedUpdatedAt: string | null;
  operationId: string;
  action: 'update' | 'copy' | 'new';
  deferredAt?: string;
  confirmedAt?: string;
}
export function isImportRecovery(record: ProjectDraftRecord): boolean {
  return record.importRecovery !== undefined || typeof record.scope?.tab === 'string' && record.scope.tab.startsWith('recovery:import:');
}
export function importTargetsProject(record: ProjectDraftRecord, id: string): boolean {
  return record.project?.id === id || Array.isArray(record.importRecovery?.targetIds) && record.importRecovery.targetIds.includes(id);
}
export function validImportRecovery(record: ProjectDraftRecord): boolean {
  const value = record.importRecovery;
  return Boolean(value && !record.intent && value.version === 1 && typeof value.batchId === 'string' && value.batchId
    && record.scope?.tab === `recovery:import:${value.batchId}`
    && Array.isArray(value.targetIds) && value.targetIds.length && value.targetIds.every(id => typeof id === 'string' && id)
    && new Set(value.targetIds).size === value.targetIds.length && value.targetIds.includes(record.project?.id)
    && (value.expectedUpdatedAt === null || typeof value.expectedUpdatedAt === 'string')
    && value.expectedUpdatedAt === record.baseUpdatedAt
    && ['update', 'copy', 'new'].includes(value.action)
    && (value.action === 'update' ? typeof value.expectedUpdatedAt === 'string' : value.expectedUpdatedAt === null)
    && typeof value.operationId === 'string' && value.operationId && value.operationId === record.project?.lastSaveOperation?.id
    && record.project.lastSaveOperation?.kind === 'current'
    && (value.deferredAt === undefined || typeof value.deferredAt === 'string')
    && (value.confirmedAt === undefined || typeof value.confirmedAt === 'string'));
}
export function importBatches(records: ProjectDraftRecord[]): ProjectDraftRecord[][] {
  const groups = new Map<string, ProjectDraftRecord[]>();
  for (const record of records.filter(isImportRecovery)) {
    const key = record.importRecovery?.batchId || record.key;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].map(records => {
    const ids = records[0]?.importRecovery?.targetIds;
    return Array.isArray(ids) ? [...records].sort((a, b) => ids.indexOf(a.project.id) - ids.indexOf(b.project.id)) : records;
  });
}
export function completeImportBatch(records: ProjectDraftRecord[]): boolean {
  return recoverableImportSubset(records) && records.length === records[0].importRecovery!.targetIds.length;
}
/** Only missing members are tolerated; malformed or conflicting metadata is not. */
export function recoverableImportSubset(records: ProjectDraftRecord[]): boolean {
  const first = records[0];
  if (!first || !records.every(validImportRecovery)) return false;
  const metadata = first.importRecovery!;
  return records.length <= metadata.targetIds.length && new Set(records.map(record => record.project.id)).size === records.length
    && records.every(record => record.importRecovery!.batchId === metadata.batchId
      && canonicalJson(record.importRecovery!.targetIds) === canonicalJson(metadata.targetIds)
      && record.scope.owner === first.scope.owner && record.scope.workspace === first.scope.workspace);
}
export function deferredImportBatch(records: ProjectDraftRecord[]): boolean {
  const stamp = records[0]?.importRecovery?.deferredAt;
  return completeImportBatch(records) && typeof stamp === 'string' && Boolean(stamp)
    && records.every(record => record.importRecovery?.deferredAt === stamp);
}
export function deferredImportSubset(records: ProjectDraftRecord[]): boolean {
  const stamp = records[0]?.importRecovery?.deferredAt;
  return recoverableImportSubset(records) && typeof stamp === 'string' && Boolean(stamp)
    && records.every(record => record.importRecovery?.deferredAt === stamp);
}
export function confirmedImportBatch(records: ProjectDraftRecord[]): boolean {
  const stamp = records[0]?.importRecovery?.confirmedAt;
  return completeImportBatch(records) && typeof stamp === 'string' && Boolean(stamp)
    && (!records.some(record => record.importRecovery?.deferredAt) || deferredImportBatch(records))
    && records.every(record => record.importRecovery?.confirmedAt === stamp);
}
export async function verifyImportBatch(records: ProjectDraftRecord[], prepared?: readonly ProjectData[], allowMissing = false): Promise<void> {
  if (!(allowMissing ? recoverableImportSubset(records) : completeImportBatch(records))) throw new Error('The complete import recovery could not be verified. Export the original recovery.');
  const ids = records[0].importRecovery!.targetIds;
  if (prepared && (prepared.length !== ids.length || prepared.some((project, index) => project.id !== ids[index]
    || canonicalJson(project) !== canonicalJson(records.find(record => record.project.id === project.id)?.project)))) {
    throw new Error('The prepared import changed. No import was sent. Keep the recovery backup.');
  }
  if (!(await Promise.all(records.map(async record => record.project.lastSaveOperation!.fingerprint === await projectFingerprint(record.project)))).every(Boolean)) {
    throw new Error('The import recovery contents could not be verified. Export the original recovery.');
  }
}
