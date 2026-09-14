import type { ProjectData, TrashData } from '../types';
import { canonicalJson } from './canonicalJson';
import { createAppId } from './id';
import { confirmedImportBatch, deferredImportSubset, importBatches, isImportRecovery, validImportRecovery, verifyImportBatch, type ImportRecovery } from './projectImportRecovery';

export interface DraftScope { workspace: string; owner: string; tab: string }
export interface ProjectDraftRecord {
  key: string;
  scope: DraftScope;
  project: ProjectData;
  baseUpdatedAt: string | null;
  generation: number;
  savedAt: string;
  importRecovery?: ImportRecovery;
  intent?: { before: ProjectData; project: ProjectData; expectedUpdatedAt: string; operationId: string; forceOverwriteUpdatedAt?: string;
    restore?: { trashItemId: string; deletedAt: string; expectedUpdatedAt: null; original: TrashData['projects'][number]; confirmedProject?: ProjectData } };
}
export interface DraftStatus { state: 'unconfirmed' | 'saving' | 'saved' | 'failed'; message: string; projectId?: string }
export const DRAFT_STATUS_EVENT = 'cfs-draft-status';
const DB_NAME = 'cfs-drafts';
const STORE = 'projects';
const DEADLINE = 5000;
let scope: DraftScope | null = null;
let cached: ProjectDraftRecord[] = [];
let generation = Date.now();
let status: DraftStatus = { state: 'saved', message: '' };
const projectStatuses = new Map<string, DraftStatus>();
const FALLBACK_PREFIX = 'cfs-draft-project-v3:';
let lastArchivedRaw: string | null = null;
const unresolvedInheritance = new WeakSet<ProjectDraftRecord>();
const uncertainImportBatches = new Set<string>();
async function bounded<T>(work: Promise<T>, milliseconds = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The local draft could not be verified in time. Export a backup.')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export function getDraftStatus(projectId?: string | null): DraftStatus {
  if (projectId) return projectStatuses.get(projectId) ?? { state: 'unconfirmed', message: 'The local draft for this project has not been verified.', projectId };
  return [...projectStatuses.values()].find(item => item.state === 'failed') ?? status;
}
function publish(next: DraftStatus) {
  if (next.projectId) projectStatuses.set(next.projectId, next);
  status = next;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DRAFT_STATUS_EVENT));
}
function keyFor(value: DraftScope, projectId: string) { return JSON.stringify([value.workspace, value.owner, projectId, value.tab]); }
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Local draft storage is unavailable in this browser.')); return; }
    let done = false;
    const request = indexedDB.open(DB_NAME, 1);
    const timer = setTimeout(() => finish(new Error('Local draft storage could not start. Check other tabs.')), DEADLINE);
    const finish = (error?: Error) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(request.result);
    };
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onblocked = () => finish(new Error('Another tab is using local draft storage. The draft has not been verified.'));
    request.onerror = () => finish(new Error('Local draft storage could not be opened.'));
    request.onsuccess = () => {
      if (done) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      finish();
    };
  });
}
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, result: (value: T) => void) => void, onStart?: () => void): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let result: T;
    const tx = db.transaction(STORE, mode);
    onStart?.();
    const finish = (error?: Error) => {
      if (done) return;
      done = true; clearTimeout(timer); db.close();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      try { tx.abort(); } catch { /* Already settled; late callbacks are ignored. */ }
      finish(new Error('The local draft could not be verified in time. Keep this screen open and export a backup.'));
    }, DEADLINE);
    tx.oncomplete = () => finish();
    tx.onabort = tx.onerror = () => finish(new Error('Local draft storage failed. Previous drafts are retained.'));
    try { run(tx.objectStore(STORE), value => { result = value; }); }
    catch (error) { try { tx.abort(); } catch {} finish(error instanceof Error ? error : new Error('Local draft storage failed.')); }
  });
}
function readAll() {
  return transaction<ProjectDraftRecord[]>('readonly', (store, result) => {
    const request = store.getAll(); request.onsuccess = () => result(request.result as ProjectDraftRecord[]);
  });
}
function owned(record: ProjectDraftRecord, owner: DraftScope) {
  return Boolean(record.project && record.scope) && record.scope.workspace === owner.workspace && record.scope.owner === owner.owner;
}
export function cachedProjectDrafts(): ProjectData[] {
  if (!scope) return [];
  return cached.filter(record => owned(record, scope!) && record.scope.tab === scope!.tab && !isImportRecovery(record)).map(record => record.project);
}
export function cachedDraftRecords(): ProjectDraftRecord[] { return scope ? cached.filter(record => owned(record, scope!)) : []; }
export function draftScope(): DraftScope | null { return scope; }
export function validDraftRecord(value: unknown): value is ProjectDraftRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as ProjectDraftRecord;
  const validProject = (project: ProjectData) => project && typeof project.id === 'string' && typeof project.name === 'string'
    && typeof project.updatedAt === 'string' && ['roomTypes', 'circuits', 'locations', 'fixtures'].every(key => Array.isArray((project as unknown as Record<string, unknown>)[key]));
  return Boolean(record.scope && ['workspace', 'owner', 'tab'].every(key => typeof (record.scope as unknown as Record<string, unknown>)[key] === 'string'))
    && validProject(record.project) && record.key === keyFor(record.scope, record.project.id) && Number.isFinite(record.generation)
    && (record.baseUpdatedAt === null || typeof record.baseUpdatedAt === 'string')
    && (!isImportRecovery(record) || validImportRecovery(record))
    && (!record.intent || (validProject(record.intent.before) && (record.intent.restore ? validRestoreProject(record.intent.project) : validProject(record.intent.project))
      && record.intent.before.id === record.project.id && record.intent.project.id === record.project.id
      && typeof record.intent.expectedUpdatedAt === 'string' && record.intent.operationId === record.intent.project.lastSaveOperation?.id
      && (!record.intent.restore || (typeof record.intent.restore.trashItemId === 'string' && Boolean(record.intent.restore.trashItemId)
        && typeof record.intent.restore.deletedAt === 'string' && record.intent.restore.expectedUpdatedAt === null
        && record.intent.restore.original?.id === record.intent.restore.trashItemId
        && record.intent.restore.original?.deletedAt === record.intent.restore.deletedAt
        && record.intent.restore.original?.project?.id === record.project.id
        && (!record.intent.restore.confirmedProject || (validRestoreProject(record.intent.restore.confirmedProject)
          && record.intent.restore.confirmedProject.id === record.project.id
          && record.intent.restore.confirmedProject.lastSaveOperation?.id === record.intent.operationId))))));
}
export function validRestoreProject(project: unknown): project is ProjectData {
  if (!project || typeof project !== 'object' || Array.isArray(project)) return false;
  const value = project as Record<string, unknown>;
  return typeof value.id === 'string' && Boolean(value.id) && typeof value.name === 'string' && typeof value.updatedAt === 'string'
    && ['circuits', 'locations', 'fixtures'].every(key => Array.isArray(value[key]))
    && Array.isArray(value.roomTypes) && value.roomTypes.every(room => Boolean(room && typeof room === 'object' && !Array.isArray(room)));
}
export function exportRecoveryBytes(records: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `cfs-draft-recovery-${Date.now()}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export function resetProjectDrafts(): void { scope = null; cached = []; projectStatuses.clear(); publish({ state: 'saved', message: '' }); }
function fallbackRecords(): ProjectDraftRecord[] {
  const records: ProjectDraftRecord[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(FALLBACK_PREFIX)) continue;
    try { const item = JSON.parse(localStorage.getItem(key) ?? 'null'); if (item?.project && item?.scope) records.push(item); } catch { /* Preserve malformed bytes. */ }
  }
  return records;
}

export async function initializeProjectDrafts(nextScope: DraftScope): Promise<ProjectDraftRecord[]> {
  scope = nextScope;
  cached = [];
  try {
    const records = await bounded(readAll());
    for (const item of fallbackRecords()) {
      const index = records.findIndex(old => old.key === item.key);
      if (index < 0) records.push(item);
      else if (records[index].generation < item.generation) records[index] = item;
      else if (records[index].generation === item.generation && canonicalJson(records[index]) !== canonicalJson(item)) {
        // Keep both durable bytes; expose the fallback as a separate recovery candidate.
        records.push({ ...item, key: `${item.key}:fallback-conflict` });
      }
    }
    if (scope !== nextScope) return [];
    const loaded = records.filter(record => owned(record, nextScope));
    // A checkpoint may complete while the initial IDB read is still pending.
    for (const current of cached) {
      const index = loaded.findIndex(record => record.key === current.key);
      if (index < 0) loaded.push(current);
      else if (current.generation > loaded[index].generation) loaded[index] = current;
      else if (current.generation === loaded[index].generation && canonicalJson(current) !== canonicalJson(loaded[index])) {
        loaded.push({ ...loaded[index], key: `${loaded[index].key}:initialization-conflict` });
        loaded[index] = current;
      }
    }
    cached = loaded;
    generation = Math.max(generation, Date.now(), ...cached.map(record => record.generation).filter(Number.isFinite));
    for (const record of cached) {
      const projectId = record.project?.id;
      if (!validDraftRecord(record)) publish({ state: 'failed', projectId, message: 'The draft structure or generation could not be verified. Export the original draft for review.' });
    }
    publish({ state: 'saved', message: '' });
    return cached;
  } catch (error) {
    if (scope !== nextScope) return [];
    try {
      for (const record of fallbackRecords().filter(item => owned(item, nextScope))) {
        const index = cached.findIndex(item => item.key === record.key);
        if (index < 0) cached.push(record);
        else if (cached[index].generation < record.generation) cached[index] = record;
      }
    } catch { /* Keep current RAM generations and pending intents if fallback is unreadable. */ }
    publish({ state: 'failed', message: error instanceof Error ? error.message : 'Local drafts could not be loaded.' });
    return cached;
  }
}

export async function checkpointProject(project: ProjectData, baseUpdatedAt: string | null, intent?: ProjectDraftRecord['intent'] | null, capturedScope: DraftScope | null = scope, importRecovery?: ImportRecovery): Promise<ProjectDraftRecord | null> {
  const owner = capturedScope;
  if (!owner) { publish({ projectId: project.id, state: 'failed', message: 'The local draft owner could not be verified. Export a backup.' }); return null; }
  const key = keyFor(owner, project.id);
  const previous = cached.find(record => record.key === key);
  const knownPrevious = previous && !unresolvedInheritance.has(previous) ? previous : undefined;
  const record: ProjectDraftRecord = {
    key, scope: { ...owner }, project: structuredClone(project), baseUpdatedAt: baseUpdatedAt ?? previous?.baseUpdatedAt ?? null,
    generation: ++generation, savedAt: new Date().toISOString(), intent: intent === null ? undefined : intent ?? knownPrevious?.intent,
  };
  if (importRecovery) record.importRecovery = structuredClone(importRecovery);
  if (intent === undefined) unresolvedInheritance.add(record);
  let durableBasisRead = false;
  let durableBasis: ProjectDraftRecord | undefined;
  const inheritIntent = (existing?: ProjectDraftRecord, fallback?: ProjectDraftRecord | null) => {
    if (intent !== undefined) return;
    const basis = [knownPrevious, existing, fallback].filter((item): item is ProjectDraftRecord => Boolean(item && item.key === key))
      .sort((a, b) => b.generation - a.generation)[0];
    if (!basis && !durableBasisRead) throw new Error('Previous save verification details could not be verified. Keep the draft and check again.');
    record.intent = basis?.intent;
    unresolvedInheritance.delete(record);
  };
  const readFallback = () => {
    const raw = localStorage.getItem(FALLBACK_PREFIX + key);
    if (!raw) return null;
    const fallback: unknown = JSON.parse(raw);
    if (!validDraftRecord(fallback) || fallback.key !== key) throw new Error('The fallback draft save verification details could not be verified.');
    return fallback;
  };
  if (scope === owner) { cached = [...cached.filter(item => item.key !== key), record]; publish({ projectId: project.id, state: 'saving', message: 'Storing a draft on this device…' }); }
  const work = bounded((async () => {
    await transaction<void>('readwrite', (store, result) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const existing = request.result as ProjectDraftRecord | undefined;
        durableBasis = existing;
        durableBasisRead = true;
        // The active RAM cache may belong to another owner. Resolve omitted intent atomically from this key's durable basis.
        try { inheritIntent(existing, intent === undefined ? readFallback() : null); }
        catch { store.transaction.abort(); return; }
        const latest = cached.find(item => item.key === key);
        if ((!existing || existing.generation < record.generation) && (!latest || latest.generation <= record.generation)) store.put(record);
        result(undefined);
      };
    });
    const verified = (await readAll()).find(item => item.key === key);
    if (!verified || verified.generation !== record.generation || canonicalJson(verified) !== canonicalJson(record)) throw new Error('The contents of this draft generation could not be verified.');
    if (scope === owner && cached.find(item => item.key === key)?.generation === record.generation) publish({ projectId: project.id, state: 'saved', message: 'Draft stored on this device (not saved to shared data)' });
    return record;
  })()).catch(error => {
    // One project per key. setItem is atomic: a quota error keeps the previous copy.
    try {
      const fallbackKey = FALLBACK_PREFIX + key;
      const old = readFallback();
      inheritIntent(durableBasis, old);
      const latest = cached.find(item => item.key === key);
      if ((!old || old.generation < record.generation) && (!latest || latest.generation <= record.generation)) localStorage.setItem(fallbackKey, JSON.stringify(record));
      if (localStorage.getItem(fallbackKey) === JSON.stringify(record)) {
        if (scope === owner && cached.find(item => item.key === key)?.generation === record.generation) publish({ projectId: project.id, state: 'saved', message: 'Draft stored in fallback storage on this device (not saved to shared data)' });
        return record;
      }
    } catch { /* Never remove an older copy when quota is exceeded. */ }
    if (scope === owner && cached.find(item => item.key === key)?.generation === record.generation) publish({ projectId: project.id, state: 'failed', message: error instanceof Error ? error.message : 'Local draft storage failed.' });
    return null;
  });
  return work;
}

export async function removeConfirmedDraft(record: ProjectDraftRecord): Promise<void> {
  const key = record.key;
  await bounded(transaction<void>('readwrite', (store, result) => {
    const request = store.get(key);
    request.onsuccess = () => {
      if ((request.result as ProjectDraftRecord | undefined)?.generation === record.generation) store.delete(key);
      result(undefined);
    };
  }));
  const fallbackKey = FALLBACK_PREFIX + key;
  try { if (JSON.parse(localStorage.getItem(fallbackKey) ?? 'null')?.generation === record.generation) localStorage.removeItem(fallbackKey); } catch { /* Keep unreadable copies. */ }
  cached = cached.filter(item => item.key !== key || item.generation !== record.generation);
}

/** A read-only confirmation must not replace the currently edited tab's draft. */
export async function checkpointProjectRestore(project: ProjectData, baseUpdatedAt: string, intent: NonNullable<ProjectDraftRecord['intent']>, owner: DraftScope | null): Promise<ProjectDraftRecord | null> {
  if (!owner || !intent.restore) return null;
  const record = await checkpointProject(project, baseUpdatedAt, intent, { ...owner, tab: `recovery:restore:${intent.operationId}` });
  if (record && scope === owner) cached = [...cached.filter(item => item.key !== record.key), record];
  return record;
}

/** Import archives never replace the current tab's draft or single-save intent. */
export async function checkpointProjectImport(project: ProjectData, metadata: ImportRecovery, owner: DraftScope | null): Promise<ProjectDraftRecord | null> {
  if (!owner) return null;
  const record = await checkpointProject(project, metadata.expectedUpdatedAt, null,
    { ...owner, tab: `recovery:import:${metadata.batchId}` }, metadata);
  if (record && scope === owner) cached = [...cached.filter(item => item.key !== record.key), record];
  return record;
}

/** Defer is one batch transaction: fallback keys are never partially marked complete. */
export async function deferProjectImport(records: ProjectDraftRecord[], owner: DraftScope): Promise<ProjectDraftRecord[]> {
  return retainProjectImport(records, owner, 'deferredAt');
}
/** Explicit recovery actions refresh durable generations instead of retrying stale RAM. */
export async function refreshProjectImport(records: ProjectDraftRecord[], owner: DraftScope): Promise<ProjectDraftRecord[]> {
  const batchId = records[0]?.importRecovery?.batchId;
  if (!batchId || scope !== owner) throw new Error('The import recovery owner could not be verified.');
  const batchKey = JSON.stringify([owner.workspace, owner.owner, batchId]);
  let nativeAvailable = true;
  let native: ProjectDraftRecord[];
  try { native = await bounded(readAll()); }
  catch {
    // A complete available fallback cohort can still be inspected without IDB.
    // Never manufacture missing bytes from the old RAM cache.
    native = [];
    nativeAvailable = false;
  }
  const durable = native.filter(record => owned(record, owner) && record.importRecovery?.batchId === batchId);
  for (const record of fallbackRecords().filter(item => owned(item, owner) && item.importRecovery?.batchId === batchId)) {
    const index = durable.findIndex(item => item.key === record.key);
    if (index < 0) durable.push(record);
    else if (record.generation > durable[index].generation) durable[index] = record;
    else if (record.generation === durable[index].generation && canonicalJson(record) !== canonicalJson(durable[index])) durable.push({ ...record, key: `${record.key}:fallback-conflict` });
  }
  if (scope !== owner || !durable.length) throw new Error('Import recovery could not be read from this device. Keep the original backup and check again.');
  if (!nativeAvailable && (uncertainImportBatches.has(batchKey) || [...records, ...cached]
    .filter(record => owned(record, owner) && record.importRecovery?.batchId === batchId)
    .some(record => {
      const available = durable.find(item => item.key === record.key);
      return !available || available.generation < record.generation
        || available.generation === record.generation && canonicalJson(available) !== canonicalJson(record);
    }))) {
    throw new Error('The latest import recovery could not be verified. Keep the original backup and check again when local storage is available.');
  }
  if (nativeAvailable) uncertainImportBatches.delete(batchKey);
  const refreshed = importBatches(durable)[0];
  generation = refreshed.reduce((latest, record) => Number.isFinite(record.generation) ? Math.max(latest, record.generation) : latest, Math.max(generation, Date.now()));
  cached = [...cached.filter(record => record.importRecovery?.batchId !== batchId), ...refreshed];
  return refreshed;
}
export async function confirmProjectImport(records: ProjectDraftRecord[], owner: DraftScope): Promise<ProjectDraftRecord[]> {
  return retainProjectImport(records, owner, 'confirmedAt');
}
async function retainProjectImport(records: ProjectDraftRecord[], owner: DraftScope, field: 'deferredAt' | 'confirmedAt'): Promise<ProjectDraftRecord[]> {
  await verifyImportBatch(records, undefined, field === 'deferredAt');
  if (scope !== owner || !records.every(record => owned(record, owner) && validDraftRecord(record))) throw new Error('The import recovery owner changed.');
  generation = records.reduce((latest, record) => Math.max(latest, record.generation), Math.max(generation, Date.now()));
  const stamp = new Date(Math.max(Date.now(), ...records.map(record => (Date.parse(record.importRecovery?.[field] ?? '') || 0) + 1))).toISOString();
  const next = records.map(record => ({ ...structuredClone(record), generation: ++generation, savedAt: stamp,
    importRecovery: { ...record.importRecovery!, [field]: stamp } }));
  const retained = (field === 'confirmedAt' ? confirmedImportBatch(records) : deferredImportSubset(records)) ? records : next;
  const sameMembers = (values: ProjectDraftRecord[]) => values.filter(record => owned(record, owner)
    && record.importRecovery?.batchId === records[0].importRecovery!.batchId).every(record => records.some(item => item.key === record.key));
  let transactionStarted = false;
  const batchKey = JSON.stringify([owner.workspace, owner.owner, records[0].importRecovery!.batchId]);
  try {
    await bounded(transaction<void>('readwrite', (store, result) => {
    const request = store.getAll();
    request.onsuccess = () => {
      try {
      const existing = request.result as ProjectDraftRecord[];
      const fallback = fallbackRecords();
      if (scope !== owner || !sameMembers([...existing, ...fallback]) || records.some(record => {
        const candidates = [...existing, ...fallback].filter(item => item.key === record.key);
        const latest = candidates.sort((a, b) => b.generation - a.generation)[0];
        return !latest || canonicalJson(latest) !== canonicalJson(record)
          || candidates.some(item => item.generation === latest.generation && canonicalJson(item) !== canonicalJson(latest));
      })) {
        store.transaction.abort(); return;
      }
      for (const record of retained) store.put(record);
      result(undefined);
      } catch { store.transaction.abort(); }
    };
    }, () => { transactionStarted = true; uncertainImportBatches.add(batchKey); }));
  } catch (error) {
    // Never add fallback writes after a transaction may have committed.
    if (transactionStarted || scope !== owner) throw error;
    for (let index = 0; index < records.length; index++) {
      const record = records[index], candidate = retained[index];
      const key = FALLBACK_PREFIX + record.key;
      const current = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (scope !== owner || canonicalJson(current) !== canonicalJson(record)) throw new Error('The fallback recovery changed. Keep the current view and check again.');
      localStorage.setItem(key, JSON.stringify(candidate));
      if (localStorage.getItem(key) !== JSON.stringify(candidate)) throw new Error('The retained fallback recovery could not be verified.');
      if (scope === owner) cached = [...cached.filter(item => item.key !== candidate.key), candidate];
    }
    if (!sameMembers(fallbackRecords()) || !retained.every(record => localStorage.getItem(FALLBACK_PREFIX + record.key) === JSON.stringify(record))) {
      throw new Error('The complete fallback recovery could not be verified. Keep the current view.');
    }
    return retained;
  }
  const verified = await bounded(readAll());
  const latestFallback = fallbackRecords();
  if (!sameMembers([...verified, ...latestFallback]) || !retained.every(record => verified.some(item => item.key === record.key && canonicalJson(item) === canonicalJson(record))
    && !latestFallback.some(item => item.key === record.key && (item.generation > record.generation
      || item.generation === record.generation && canonicalJson(item) !== canonicalJson(record))))) {
    throw new Error('The complete retained import could not be read back. Keep this view and check again.');
  }
  if (scope === owner) cached = [...cached.filter(item => !retained.some(record => record.key === item.key)), ...retained];
  uncertainImportBatches.delete(batchKey);
  return retained;
}

/** A read-only confirmation must not replace the currently edited tab's draft. */
export async function preserveRecoveryProject(project: ProjectData, baseUpdatedAt: string | null, owner: DraftScope | null): Promise<ProjectDraftRecord | null> {
  if (!owner) return null;
  const record = await checkpointProject(project, baseUpdatedAt, null, { ...owner, tab: `recovery:${createAppId()}` });
  if (record && scope === owner) cached = [...cached, record];
  return record;
}

/** Unattributed legacy data is never assigned to the currently signed-in user. */
export async function archiveLegacyProjectDrafts(): Promise<void> {
  const raw = window.localStorage.getItem('cfs-project-drafts-v2');
  if (!raw || raw === lastArchivedRaw) return;
  // Store the original bytes, including unknown/invalid fields. Keep the old key too.
  const key = `legacy-unattributed:cfs-project-drafts-v2:${createAppId()}`;
  await bounded(transaction<void>('readwrite', (store, result) => {
    store.put({ key, raw, scope: { workspace: 'legacy', owner: 'unattributed', tab: 'legacy' }, savedAt: new Date().toISOString() });
    result(undefined);
  }));
  lastArchivedRaw = raw;
}
