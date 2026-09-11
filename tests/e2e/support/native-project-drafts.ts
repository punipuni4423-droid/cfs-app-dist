import type { Page } from './safe-test';
import type { ProjectData } from '../../../app/types';

export interface NativeDraftRecord {
  key: string;
  scope: { workspace: string; owner: string; tab: string };
  project: ProjectData;
  generation: number;
  baseUpdatedAt: string | null;
}

/** Independent, read-only durability observation. Never reads the app's RAM cache or legacy seeds. */
export async function readNativeDraftRecords(page: Page): Promise<NativeDraftRecord[]> {
  return page.evaluate(() => new Promise<NativeDraftRecord[]>((resolve, reject) => {
    let db: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    let settled = false;
    const finish = (error?: Error, records: NativeDraftRecord[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      db?.close();
      if (error) reject(error); else resolve(records);
    };
    const timer = setTimeout(() => {
      try { transaction?.abort(); } catch { /* A completed transaction cannot be aborted. */ }
      finish(new Error('Native draft read exceeded 5000 ms'));
    }, 5000);
    const request = indexedDB.open('cfs-drafts');
    // A read must not create a missing database or alter its schema.
    request.onupgradeneeded = () => { try { request.transaction?.abort(); } finally { finish(undefined, []); } };
    request.onblocked = () => finish(new Error('Native draft database is blocked'));
    request.onerror = () => finish(request.error ?? new Error('Native draft open failed'));
    request.onsuccess = () => {
      db = request.result;
      if (settled) { db.close(); return; }
      db.onversionchange = () => { try { transaction?.abort(); } catch {} finish(new Error('Native draft database version changed')); };
      if (!db.objectStoreNames.contains('projects')) { finish(new Error('Native draft projects store is missing')); return; }
      try {
      transaction = db.transaction('projects', 'readonly');
      const getAll = transaction.objectStore('projects').getAll();
      let records: NativeDraftRecord[] = [];
      getAll.onsuccess = () => { records = getAll.result as NativeDraftRecord[]; };
      getAll.onerror = () => finish(getAll.error ?? new Error('Native draft read failed'));
      transaction.onabort = () => finish(transaction?.error ?? new Error('Native draft read aborted'));
      transaction.onerror = () => finish(transaction?.error ?? new Error('Native draft transaction failed'));
      // Request success alone is insufficient: observe only a completed readonly transaction.
      transaction.oncomplete = () => finish(undefined, records);
      } catch (error) { finish(error instanceof Error ? error : new Error('Native draft transaction could not start')); }
    };
  }));
}

export async function readNativeDraftProjects(page: Page): Promise<ProjectData[]> {
  const records = (await readNativeDraftRecords(page)).filter(record => !record.scope?.tab?.startsWith('recovery:') && record.project);
  const projects = new Map<string, NativeDraftRecord>();
  for (const record of records) {
    const { scope, project, generation, key } = record;
    if (!scope?.workspace || !scope.owner || !scope.tab || !project.id || !Array.isArray(project.roomTypes)
      || !Number.isFinite(generation) || key !== JSON.stringify([scope.workspace, scope.owner, project.id, scope.tab])) {
      throw new Error('Native draft record has invalid identity, key or generation');
    }
    const previous = projects.get(project.id);
    if (previous && (previous.scope.workspace !== scope.workspace || previous.scope.owner !== scope.owner)) {
      throw new Error(`Ambiguous owner/workspace for native draft ${project.id}`);
    }
    if (previous?.generation === generation && JSON.stringify(previous.project) !== JSON.stringify(project)) {
      throw new Error(`Conflicting native draft generation for ${project.id}`);
    }
    if (!previous || previous.generation < generation) projects.set(project.id, record);
  }
  return [...projects.values()].map(record => record.project);
}

export async function readNativeDraftProject(page: Page, projectId?: string): Promise<ProjectData | undefined> {
  const projects = await readNativeDraftProjects(page);
  if (projectId) return projects.find(project => project.id === projectId);
  if (projects.length > 1) throw new Error('A Project ID is required when multiple drafts exist');
  return projects[0];
}
