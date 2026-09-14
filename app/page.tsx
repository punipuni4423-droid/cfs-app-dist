"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ProjectData, RoomType, TrashData } from "./types";
import {
  createNewProject,
  downloadProjectBackup,
  emptyTrashData,
  confirmProjectSave,
  cleanupRestoredProjectTrash,
  readProjectRestoreTrashItem,
  prepareProjectRestore,
  saveProjectRestore,
  confirmProjectRestore,
  migrateTrashPayload,
  prepareProjectSave,
  loadProjectDrafts,
  loadProjects,
  loadProjectsFromDatabase,
  loadTrash,
  loadTrashFromDatabase,
  migrateProjectsPayload,
  isProjectSaveConflictError,
  saveProjectToDatabase,
  saveProjectsToDatabase,
  readImportSharedProjects,
  renameProjectInDatabase,
  saveTrashToDatabase,
  deleteProjectToTrash,
  type CollaborationSaveIdentity,
} from "./lib/storage";
import ProjectListScreen from "./components/ProjectListScreen";
import type { SaveRecoveryUi } from './components/SaveRecoveryPanel';
import ProjectScreen from "./components/ProjectScreen";
import CollaborationBar from "./components/CollaborationBar";
import { createAppId } from './lib/id';
import { useCollaboration } from "./lib/useCollaboration";
import { DEFAULT_CFS_ROW_ORDER } from "./lib/cfsRowDisplay";
import { hasProjectChanges, nextProjectEditTime, rebaseProjectSave, type ProjectSaveReceipt } from "./lib/projectSaveState";
import { archiveLegacyProjectDrafts, cachedDraftRecords, checkpointProject, checkpointProjectImport, checkpointProjectRestore, draftScope, resetProjectDrafts, validDraftRecord, exportRecoveryBytes, preserveRecoveryProject, DRAFT_STATUS_EVENT, getDraftStatus, initializeProjectDrafts, removeConfirmedDraft, type ProjectDraftRecord, type DraftScope } from './lib/projectDraftStore';
import { completeImportBatch, confirmedImportBatch, deferredImportSubset, importBatches, importTargetsProject, isImportRecovery, recoverableImportSubset, verifyImportBatch, type ImportRecovery } from './lib/projectImportRecovery';
import { confirmProjectImport, deferProjectImport, refreshProjectImport } from './lib/projectDraftStore';
import { finiteFetch, SaveProtocolError } from './lib/projectSaveProtocol';
import { appendCommonRevision, commonSnapshot } from './lib/projectCommonHistory';
import { canonicalJson, valuesDiffer } from './lib/canonicalJson';

const LOAD_TIMEOUT_MS = 10_000;
const ACTIVE_PROJECT_STORAGE_KEY = "cfs-active-project-v1";

type SaveStatus =
  | "idle"
  | "savingDraft"
  | "draftSaved"
  | "savingProject"
  | "projectSaved"
  | "savingRevision"
  | "revisionSaved"
  | "error";
type ImportConflictAction = "update" | "copy" | "cancel";
type SaveConflictAction = "overwrite" | "reload" | "backup" | "cancel";
type SharingMode = "local" | "supabase";

function readStoredActiveProjectId(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredActiveProjectId(projectId: string): void {
  if (typeof window === "undefined") return;
  try {
    if (projectId) {
      window.sessionStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId);
    } else {
      window.sessionStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
    }
  } catch {
    // Navigation restore is a convenience feature; storage failures should not block editing.
  }
}

function cloneData<T>(source: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(source);
  }
  return JSON.parse(JSON.stringify(source)) as T;
}

function rawProjectListFromImport(payload: unknown): Record<string, unknown>[] {
  const rawProjects = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === "object" && Array.isArray((payload as { projects?: unknown }).projects)
      ? (payload as { projects: unknown[] }).projects
      : [];
  return rawProjects.filter((project): project is Record<string, unknown> =>
    project !== null && typeof project === "object",
  );
}

function hasOwnField(source: Record<string, unknown> | undefined, field: string): boolean {
  return Boolean(source && Object.prototype.hasOwnProperty.call(source, field));
}

function preserveFieldsMissingFromImport(
  existing: ProjectData,
  imported: ProjectData,
  rawImportedProject: Record<string, unknown> | undefined,
): ProjectData {
  const rawRoomTypes = Array.isArray(rawImportedProject?.roomTypes)
    ? rawImportedProject.roomTypes.filter((roomType): roomType is Record<string, unknown> =>
        roomType !== null && typeof roomType === "object",
      )
    : [];
  const rawRoomTypeById = new Map(
    rawRoomTypes
      .filter((roomType) => typeof roomType.id === "string")
      .map((roomType) => [roomType.id as string, roomType]),
  );
  const existingRoomTypeById = new Map(existing.roomTypes.map((roomType) => [roomType.id, roomType]));
  return {
    ...imported,
    roomTypes: imported.roomTypes.map((roomType) => {
      const existingRoomType = existingRoomTypeById.get(roomType.id);
      const rawRoomType = rawRoomTypeById.get(roomType.id);
      if (!existingRoomType || !rawRoomType) return roomType;
      return {
        ...roomType,
        curtainAssignments: hasOwnField(rawRoomType, "curtainAssignments")
          ? roomType.curtainAssignments
          : existingRoomType.curtainAssignments ?? roomType.curtainAssignments,
        cfsRowDisplay: hasOwnField(rawRoomType, "cfsRowDisplay")
          ? roomType.cfsRowDisplay
          : existingRoomType.cfsRowDisplay ?? roomType.cfsRowDisplay,
      };
    }),
  };
}

function uniqueName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) return baseName;
  let index = 2;
  let next = `${baseName} Restored`;
  while (usedNames.has(next)) {
    next = `${baseName} Restored ${index}`;
    index += 1;
  }
  return next;
}

function uniqueImportCopyName(baseName: string, usedNames: Set<string>): string {
  let index = 1;
  let next = `${baseName} (${index})`;
  while (usedNames.has(next)) {
    index += 1;
    next = `${baseName} (${index})`;
  }
  usedNames.add(next);
  return next;
}

function projectImportConflictSummary(projects: ReadonlyArray<ProjectData>): string {
  const visible = projects.slice(0, 5).map((project) => `- ${project.name}`).join("\n");
  const hiddenCount = projects.length - 5;
  return hiddenCount > 0 ? `${visible}\n- ...and ${hiddenCount} more` : visible;
}

function chooseImportConflictAction(conflicts: ReadonlyArray<ProjectData>): ImportConflictAction {
  const answer = window.prompt(
    [
      `${conflicts.length} imported project${conflicts.length === 1 ? " has" : "s have"} the same ID as an existing project.`,
      "",
      projectImportConflictSummary(conflicts),
      "",
      "Type U to update the existing project(s).",
      "Type C to import them as copied project(s) with new IDs and names like (1), (2).",
      "Press Cancel to stop the import.",
    ].join("\n"),
    "U",
  );
  if (answer === null) return "cancel";
  const normalized = answer.trim().toLowerCase();
  if (normalized === "u" || normalized === "update") return "update";
  if (normalized === "c" || normalized === "copy") return "copy";
  window.alert("Import cancelled. Enter U to update, or C to copy.");
  return "cancel";
}

function formatConflictTimestamp(value: string | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function projectSaveConflictSummary(project: ProjectData | undefined): string {
  if (!project) return "Server version: unavailable";
  return [
    `Server version: ${project.name}`,
    `Updated: ${formatConflictTimestamp(project.updatedAt)}`,
    `Room Types: ${project.roomTypes.length}`,
    `Circuits: ${project.circuits.length}`,
  ].join("\n");
}

function chooseProjectSaveConflictAction(
  draftProject: ProjectData,
  serverProject: ProjectData | undefined,
): SaveConflictAction {
  const answer = window.prompt(
    [
      "Another user saved this project after you opened this screen.",
      "",
      `Current draft: ${draftProject.name}`,
      projectSaveConflictSummary(serverProject),
      "",
      "O: Overwrite with this draft (not recommended; replaces the other user's saved changes)",
      "R: Load the latest server version",
      "B: Export this draft as a JSON backup and continue editing",
      "Cancel: Continue editing without saving",
    ].join("\n"),
    "B",
  );
  if (answer === null) return "cancel";
  const normalized = answer.trim().toLowerCase();
  if (normalized === "o" || normalized === "overwrite") return "overwrite";
  if (normalized === "r" || normalized === "reload") return "reload";
  if (normalized === "b" || normalized === "backup") return "backup";
  window.alert("Save cancelled. Enter O (overwrite), R (reload), or B (backup).");
  return "cancel";
}

function roomTypeContentWeight(roomType: RoomType): number {
  const cfsRowDisplay = roomType.cfsRowDisplay;
  const cfsRowDisplayWeight = cfsRowDisplay &&
    (
      cfsRowDisplay.hidden.length > 0 ||
      cfsRowDisplay.order.length !== DEFAULT_CFS_ROW_ORDER.length ||
      cfsRowDisplay.order.some((kind, index) => kind !== DEFAULT_CFS_ROW_ORDER[index])
    )
      ? cfsRowDisplay.hidden.length + cfsRowDisplay.order.length
      : 0;
  return (
    roomType.rows.length +
    roomType.deviceAssignments.length +
    roomType.hvacAssignments.length +
    roomType.hvacSeasons.length +
    (roomType.curtainAssignments?.length ?? 0) +
    cfsRowDisplayWeight +
    roomType.scenes.length +
    roomType.roomScenes.length +
    roomType.switches.length +
    roomType.pduDeviceCounts.length +
    roomType.inspectionMarks.length +
    roomType.revisions.length
  );
}

function projectContentWeight(project: ProjectData): number {
  return (
    project.locations.length +
    project.fixtures.length +
    project.circuits.length +
    project.roomTypes.reduce((sum, roomType) => sum + roomTypeContentWeight(roomType), 0)
  );
}

function projectSummary(project: ProjectData): string {
  const roomTypeDetail = project.roomTypes
    .map((roomType) =>
      `${roomType.name}: circuits ${project.circuits.length}, devices ${roomType.deviceAssignments.length}, curtains ${roomType.curtainAssignments?.length ?? 0}, scenes ${roomType.scenes.length}, switches ${roomType.switches.length}`,
    )
    .join("; ");
  return `${project.name} - areas ${project.locations.length}, fixtures ${project.fixtures.length}, circuits ${project.circuits.length}, room types ${project.roomTypes.length}${roomTypeDetail ? ` (${roomTypeDetail})` : ""}`;
}

function formatStatusTime(date = new Date()): string {
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function smallerImportWarning(existing: ProjectData, imported: ProjectData): string | null {
  const existingWeight = projectContentWeight(existing);
  const importedWeight = projectContentWeight(imported);
  const lostTopLevel =
    imported.locations.length < existing.locations.length ||
    imported.fixtures.length < existing.fixtures.length ||
    imported.circuits.length < existing.circuits.length ||
    imported.roomTypes.length < existing.roomTypes.length;
  const lostRoomContent = imported.roomTypes.some((importedRoomType) => {
    const existingRoomType = existing.roomTypes.find((roomType) => roomType.id === importedRoomType.id);
    return existingRoomType ? roomTypeContentWeight(importedRoomType) < roomTypeContentWeight(existingRoomType) : false;
  });

  if (importedWeight >= existingWeight && !lostTopLevel && !lostRoomContent) return null;
  return [
    `Existing: ${projectSummary(existing)}`,
    `Import:   ${projectSummary(imported)}`,
  ].join("\n");
}

type SaveFeedbackKind = 'none' | 'success' | 'progress' | 'save-failed' | 'restore-failed' | 'restore-partial' | 'recovery-required' | 'recovery-deferred' | 'draft-restored' | 'lock-lost' | 'workspace-unverified';
type SaveFeedbackScope = { projectId: string; epoch: number };
type ImportAttempt = { batchId: string; prepared: ProjectData[]; records: ProjectDraftRecord[]; message: string; results?: Record<string, string>; displayedPrepared?: boolean };

export default function Home() {
  const [projects, setProjectsState] = useState<ProjectData[]>([]);
  const projectsRef = useRef(projects);
  const setProjects = useCallback((update: ProjectData[] | ((current: ProjectData[]) => ProjectData[])): void => {
    const next = typeof update === "function" ? update(projectsRef.current) : update;
    projectsRef.current = next;
    setProjectsState(next);
  }, []);
  const [trash, setTrash] = useState<TrashData>(emptyTrashData);
  const [activeProjectId, setActiveProjectId] = useState<string>(() => readStoredActiveProjectId());
  const collaboration = useCollaboration(activeProjectId);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const initialized = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trashSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trashSavesInFlight = useRef(new Set<Promise<void>>());
  const skipNextSave = useRef(false);
  const skipNextTrashSave = useRef(false);
  const collaborationAccessTokenRef = useRef(collaboration.accessToken);
  const trashSaveIdentity = useRef(collaboration.editIdentity);
  const persistedProjectUpdatedAt = useRef<Map<string, string>>(new Map());
  const persistedProjects = useRef(new Map<string, ProjectData>());
  const explicitSavePending = useRef(false);
  const deletePending = useRef(false);
  const [deletingProject, setDeletingProject] = useState(false);
  const [saveReceipt, setSaveReceipt] = useState<ProjectSaveReceipt | null>(null);
  const [draftStatus, setDraftStatus] = useState(() => getDraftStatus(activeProjectId));
  const [recoveryRecords, setRecoveryRecords] = useState<ProjectDraftRecord[]>([]);
  const [saveFeedback, setSaveFeedback] = useState<{ kind: SaveFeedbackKind; message: string; projectId: string; epoch: number } | null>(null);
  const [workspaceUnverified, setWorkspaceUnverified] = useState(false);
  const [pendingSave, setPendingSave] = useState<{ before: ProjectData; sent: ProjectData; expected: string; draft: ProjectDraftRecord | null; archived?: boolean; forceOverwriteUpdatedAt?: string } | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{ record: ProjectDraftRecord; projectConfirmed: boolean } | null>(null);
  const restoreInFlight = useRef(false);
  const importInFlight = useRef(false);
  const importPhase = useRef<'preparing' | 'sending' | 'checking' | 'defer' | null>(null);
  const [importAttempt, setImportAttempt] = useState<ImportAttempt | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [deferredImportsReady, setDeferredImportsReady] = useState<string[]>([]);
  const [confirmedImportsReady, setConfirmedImportsReady] = useState<string[]>([]);
  const deferredRuntimeBlocked = useRef(new Set<string>());
  const importIdentityRef = useRef(collaboration.editIdentity);
  importIdentityRef.current = collaboration.editIdentity;
  const [restoringProject, setRestoringProject] = useState(false);
  const tabId = useRef(createAppId());
  const previousMode = useRef(collaboration.mode);
  const ownerEpoch = useRef(0);
  const activeProjectRef = useRef(activeProjectId);
  activeProjectRef.current = activeProjectId;
  const captureSaveFeedbackScope = useCallback((): SaveFeedbackScope => ({ projectId: activeProjectRef.current, epoch: ownerEpoch.current }), []);
  const reportSaveFeedback = useCallback((kind: SaveFeedbackKind, message: string, feedbackScope: SaveFeedbackScope = captureSaveFeedbackScope()) => {
    setSaveFeedback({ kind, message, ...feedbackScope });
  }, [captureSaveFeedbackScope]);

  useEffect(() => {
    const update = () => setDraftStatus(getDraftStatus(activeProjectId));
    update();
    window.addEventListener(DRAFT_STATUS_EVENT, update);
    return () => window.removeEventListener(DRAFT_STATUS_EVENT, update);
  }, [activeProjectId]);

  useEffect(() => {
    if (!collaboration.authReady) return;
    // Flush with the previous owner before changing scope or clearing the signed-out screen.
    projectsRef.current.forEach(project => {
      if (hasProjectChanges(project, persistedProjects.current.get(project.id))) void checkpointProject(project, persistedProjectUpdatedAt.current.get(project.id) ?? null);
    });
    ownerEpoch.current++;
    importInFlight.current = false; importPhase.current = null; setImportBusy(false); setImportAttempt(null);
    setDeferredImportsReady([]); setConfirmedImportsReady([]); deferredRuntimeBlocked.current.clear();
    explicitSavePending.current = false; setSaveStatus('idle');
    deletePending.current = false; setDeletingProject(false);
    restoreInFlight.current = false; setRestoringProject(false); setPendingRestore(null); trashSavesInFlight.current.clear();
    resetProjectDrafts();
    setWorkspaceUnverified(false);
    setPendingSave(null); setSaveReceipt(null); setRecoveryRecords([]); reportSaveFeedback('none', '');
    if (collaboration.requiresSignIn) return;
    let cancelled = false;
    const feedbackScope = captureSaveFeedbackScope();
    void (async () => {
      const config = await finiteFetch('/api/sharing/config', { cache: 'no-store' }, 10_000).then(response => response.json()).catch(() => null) as { url?: string } | null;
      if (cancelled) return;
      if (collaboration.sharingMode === 'supabase' && !config?.url) { setWorkspaceUnverified(true); reportSaveFeedback('workspace-unverified', 'The shared workspace for this draft could not be verified. Check the connection and export a backup.', feedbackScope); return; }
      setWorkspaceUnverified(false);
      const records = await initializeProjectDrafts({ workspace: `${collaboration.sharingMode}:${config?.url ?? window.location.origin}`,
        owner: collaboration.user?.id ?? 'local', tab: tabId.current });
      if (!cancelled) setRecoveryRecords(records);
      await archiveLegacyProjectDrafts().catch(() => undefined);
    })();
    return () => { cancelled = true; };
  }, [collaboration.authReady, collaboration.requiresSignIn, collaboration.sharingMode, collaboration.user?.id, reportSaveFeedback, captureSaveFeedbackScope]);

  useEffect(() => {
    if (previousMode.current === 'edit' && collaboration.mode !== 'edit') {
      const project = projectsRef.current.find(item => item.id === activeProjectId);
      if (project && hasProjectChanges(project, persistedProjects.current.get(project.id))) {
        void checkpointProject(project, persistedProjectUpdatedAt.current.get(project.id) ?? null);
        reportSaveFeedback('lock-lost', 'Edit access was lost. Changes on this screen are not saved to shared data. Check the local draft status.');
      }
    }
    previousMode.current = collaboration.mode;
  }, [collaboration.mode, activeProjectId, reportSaveFeedback]);

  const hasUnsavedDatabaseChangesNow = useCallback((): boolean => {
    const current = projectsRef.current.find((project) => project.id === activeProjectId);
    return Boolean(current && hasProjectChanges(current, persistedProjects.current.get(current.id)));
  }, [activeProjectId]);

  const rememberPersistedProjects = useCallback((nextProjects: ReadonlyArray<ProjectData>): void => {
    persistedProjectUpdatedAt.current = new Map(nextProjects.map((project) => [project.id, project.updatedAt]));
    persistedProjects.current = new Map(nextProjects.map((project) => [project.id, project]));
  }, []);

  const rememberPersistedProject = useCallback((project: ProjectData): void => {
    persistedProjectUpdatedAt.current.set(project.id, project.updatedAt);
    persistedProjects.current.set(project.id, project);
  }, []);

  const applyLoadedServerState = useCallback((loaded: ProjectData[], loadedTrash: TrashData, sharingMode: SharingMode): void => {
    skipNextSave.current = true;
    skipNextTrashSave.current = true;
    rememberPersistedProjects(loaded);
    if (sharingMode === "supabase") {
      // Shared mode: the server is authoritative. Silently adopting newer
      // browser drafts resurrected stale data and overwrote other users'
      // saves (2026-08-24), so leftover drafts become a downloadable
      // backup instead of the working copy.
      setRecoveryRecords(cachedDraftRecords());
      setProjects(loaded);
    } else {
      // Local mode: keep browser-draft copies that are newer than the
      // server snapshot so a reload does not discard unsaved edits.
      setRecoveryRecords(cachedDraftRecords());
      setProjects(loaded);
    }
    setTrash(loadedTrash);
  }, [rememberPersistedProjects, setProjects]);

  useEffect(() => {
    collaborationAccessTokenRef.current = collaboration.accessToken;
  }, [collaboration.accessToken]);

  useEffect(() => {
    trashSaveIdentity.current = collaboration.editIdentity;
  }, [collaboration.editIdentity]);

  useEffect(() => {
    if (!collaboration.authReady) return;
    if (collaboration.requiresSignIn) {
      initialized.current = false;
      persistedProjectUpdatedAt.current = new Map();
      persistedProjects.current.clear();
      setProjects([]);
      setTrash(emptyTrashData());
      setActiveProjectId("");
      writeStoredActiveProjectId("");
      setLoadError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timedOut = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LOAD_TIMEOUT_MS);

    setLoading(true);
    setLoadError(null);

    Promise.all([
      loadProjectsFromDatabase({
        signal: controller.signal,
        throwOnError: true,
        accessToken: collaborationAccessTokenRef.current || undefined,
        secureSharing: collaboration.sharingMode === "supabase",
      }),
      loadTrashFromDatabase({
        signal: controller.signal,
        throwOnError: true,
        accessToken: collaborationAccessTokenRef.current || undefined,
        secureSharing: collaboration.sharingMode === "supabase",
      }),
    ])
      .then(([loaded, loadedTrash]) => {
        if (cancelled) return;
        applyLoadedServerState(loaded, loadedTrash, collaboration.sharingMode);
        if (timedOut) {
          setLoadError(
            loaded.length > 0
              ? "Database did not respond within 10 seconds. Loaded the browser backup instead."
              : "Database did not respond within 10 seconds.",
          );
        }
      })
      .catch(() => {
        if (cancelled) return;
        const localDrafts = collaboration.sharingMode === 'supabase' ? [] : loadProjectDrafts();
        const localProjects = collaboration.sharingMode === 'supabase' ? [] : localDrafts.length > 0 ? localDrafts : loadProjects();
        const localTrash = collaboration.sharingMode === 'supabase' ? { projects: [], roomTypes: [] } : loadTrash();
        skipNextTrashSave.current = true;
        persistedProjectUpdatedAt.current = new Map();
        persistedProjects.current.clear();
        setTrash(localTrash);
        if (collaboration.sharingMode === 'supabase') { skipNextSave.current = true; setProjects([]); }
        if (localProjects.length > 0) {
          skipNextSave.current = true;
          setProjects(localProjects);
          setLoadError(
            timedOut
              ? "Database did not respond within 10 seconds. Loaded the browser backup instead."
              : "Could not reach the database. Loaded the browser backup instead.",
          );
        } else {
          setLoadError(
            timedOut
              ? "Database did not respond within 10 seconds."
              : "Could not load projects. Check the database connection and retry.",
          );
        }
      })
      .finally(() => {
        if (cancelled) return;
        clearTimeout(timeout);
        initialized.current = true;
        setLoading(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  // Supabase refreshes the token periodically. A token-only change must not
  // reload projects and reset the current project screen.
  }, [
    collaboration.authReady,
    collaboration.requiresSignIn,
    collaboration.user?.id,
    collaboration.sharingMode,
    applyLoadedServerState,
    loadAttempt,
    setProjects,
  ]);

  useEffect(() => {
    if (!initialized.current) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const owner = draftScope();
    const snapshot = projectsRef.current;
    const bases = new Map(persistedProjectUpdatedAt.current);
    const persisted = new Map(persistedProjects.current);
    const checkpointedProjectIds = new Set(cachedDraftRecords().filter(record => owner
      && record.scope.workspace === owner.workspace && record.scope.owner === owner.owner && record.scope.tab === owner.tab)
      .map(record => record.project.id));
    saveTimer.current = setTimeout(async () => {
      for (const project of snapshot) {
        // Returning to the saved baseline is an edit too. Keep its latest body and any unresolved save intent.
        if (hasProjectChanges(project, persisted.get(project.id)) || checkpointedProjectIds.has(project.id)) {
          await checkpointProject(project, bases.get(project.id) ?? null, undefined, owner);
        }
      }
      saveTimer.current = null;
    }, 300);

    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, [collaboration.sharingMode, projects]);

  useEffect(() => {
    if (!initialized.current) return;
    if (skipNextTrashSave.current) {
      skipNextTrashSave.current = false;
      return;
    }
    if (trashSaveTimer.current) clearTimeout(trashSaveTimer.current);
    const scheduledCollaboration = trashSaveIdentity.current;
    const epoch = ownerEpoch.current;
    trashSaveTimer.current = setTimeout(() => {
      if (epoch !== ownerEpoch.current) return;
      const save = saveTrashToDatabase(trash, {
        notifyOnError: true,
        collaboration: scheduledCollaboration,
      }).catch(() => {
        if (epoch === ownerEpoch.current) setSaveStatus("error");
      });
      trashSavesInFlight.current.add(save);
      void save.finally(() => trashSavesInFlight.current.delete(save));
      trashSaveTimer.current = null;
    }, 300);

    return () => {
      if (trashSaveTimer.current) {
        clearTimeout(trashSaveTimer.current);
        trashSaveTimer.current = null;
      }
    };
  }, [trash]);

  useEffect(() => {
    if (loading) return;
    if (activeProjectId) {
      if (projects.some((project) => project.id === activeProjectId)) {
        writeStoredActiveProjectId(activeProjectId);
      } else {
        setActiveProjectId("");
        writeStoredActiveProjectId("");
      }
      return;
    }

    const storedProjectId = readStoredActiveProjectId();
    if (!storedProjectId) return;
    if (projects.some((project) => project.id === storedProjectId)) {
      setActiveProjectId(storedProjectId);
    } else {
      writeStoredActiveProjectId("");
    }
  }, [activeProjectId, loading, projects]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId),
    [projects, activeProjectId],
  );

  const refreshLatestServerStateForEditStart = useCallback(async (): Promise<void> => {
    const epoch = ownerEpoch.current;
    const projectId = activeProjectId;
    const [loaded, loadedTrash] = await Promise.all([
      loadProjectsFromDatabase({
        throwOnError: true,
        accessToken: collaboration.accessToken || undefined,
        secureSharing: collaboration.sharingMode === "supabase",
      }),
      loadTrashFromDatabase({
        throwOnError: true,
        accessToken: collaboration.accessToken || undefined,
        secureSharing: collaboration.sharingMode === "supabase",
      }),
    ]);
    if (epoch !== ownerEpoch.current || projectId !== activeProjectRef.current) throw new Error('The editing target or user has changed.');
    applyLoadedServerState(loaded, loadedTrash, collaboration.sharingMode);
    if (activeProjectId && !loaded.some((project) => project.id === activeProjectId)) {
      setActiveProjectId("");
      writeStoredActiveProjectId("");
      throw new Error("The selected project no longer exists on the server.");
    }
    setLoadError(null);
  }, [activeProjectId, applyLoadedServerState, collaboration.accessToken, collaboration.sharingMode]);

  const setEditStartRefresh = collaboration.setEditStartRefresh;
  useEffect(() => {
    setEditStartRefresh(refreshLatestServerStateForEditStart);
    return () => setEditStartRefresh(null);
  }, [setEditStartRefresh, refreshLatestServerStateForEditStart]);

  const requireEditMode = useCallback((): boolean => {
    if (deletePending.current) return false;
    if (importPhase.current === 'preparing' || importPhase.current === 'defer') return false;
    if (collaboration.canEdit) return true;
    collaboration.readOnlyMessage();
    return false;
  }, [collaboration]);

  const collaborationBar = <CollaborationBar collaboration={collaboration} projectUpdatedAt={activeProject?.updatedAt} />;

  const recoverProjectSaveConflict = useCallback(
    async (
      error: unknown,
      projectToSave: ProjectData,
      nextProjects: ProjectData[],
      expectedUpdatedAt: string,
      saveIdentity: CollaborationSaveIdentity | undefined,
    ): Promise<ProjectData | null> => {
      if (!isProjectSaveConflictError(error)) throw error;

      const owner = draftScope();
      const local = projectsRef.current.find(project => project.id === projectToSave.id);
      if (local) await checkpointProject(local, expectedUpdatedAt, undefined, owner);
      if (owner !== draftScope()) return null;

      let latestProjects: ProjectData[];
      try {
        latestProjects = await loadProjectsFromDatabase({
          accessToken: saveIdentity?.accessToken,
          secureSharing: true,
          throwOnError: true,
        });
      } catch (loadError) {
        if (owner !== draftScope()) return null;
        console.error("Failed to load latest project after save conflict.", loadError);
        window.alert(
          "The project has a newer server version, but CFS could not load it. The current draft is still open and was kept as a browser draft. Export a backup before closing this page.",
        );
        return null;
      }

      if (owner !== draftScope()) return null;
      const serverProject = latestProjects.find((candidate) => candidate.id === projectToSave.id) ?? error.serverProject;
      const action = chooseProjectSaveConflictAction(projectToSave, serverProject);
      const backupPrefix = `${projectToSave.name}_unsaved_conflict_draft`;
      const latestDraft = projectsRef.current.find((candidate) => candidate.id === projectToSave.id) ?? projectToSave;

      if (action === "backup") {
        downloadProjectBackup([latestDraft], backupPrefix);
        return null;
      }

      if (action === "reload") {
        downloadProjectBackup([latestDraft], backupPrefix);
        rememberPersistedProjects(latestProjects);
        skipNextSave.current = true;
        setProjects(latestProjects);
        if (serverProject) {
          setActiveProjectId(serverProject.id);
          writeStoredActiveProjectId(serverProject.id);
        }
        return null;
      }

      if (action !== "overwrite") {
        return null;
      }

      const forceOverwriteUpdatedAt = serverProject?.updatedAt || error.serverUpdatedAt || "";
      if (!forceOverwriteUpdatedAt) {
        window.alert("CFS could not confirm the server version, so it will not overwrite. Export a backup before closing this page.");
        return null;
      }

      downloadProjectBackup([latestDraft], backupPrefix);
      const queued = cachedDraftRecords().find(record => record.scope.tab === owner?.tab && record.intent?.operationId === projectToSave.lastSaveOperation?.id)?.intent;
      if (queued) await checkpointProject(latestDraft, expectedUpdatedAt, { ...queued, forceOverwriteUpdatedAt }, owner);
      if (owner !== draftScope()) return null;
      try { return await saveProjectToDatabase(projectToSave, nextProjects, {
        expectedUpdatedAt,
        forceOverwrite: true,
        forceOverwriteUpdatedAt,
        notifyOnError: false,
        collaboration: saveIdentity,
      }); } catch (error) { throw Object.assign(error instanceof Error ? error : new Error('The save result could not be verified.'), { forceOverwriteUpdatedAt }); }
    },
    [rememberPersistedProjects, setProjects],
  );

  const persistProjectListSnapshot = useCallback(
    (nextProjects: ProjectData[], nextTrash?: TrashData, targetIds?: string[], restoreProjectIds?: string[]): void => {
      const epoch = ownerEpoch.current;
      const owner = draftScope();
      const bases = new Map(persistedProjectUpdatedAt.current);
      setSaveStatus("savingDraft");
      void (async () => {
        const updates = targetIds ? nextProjects.filter(project => targetIds.includes(project.id)) : nextProjects;
        const savedProjects = await saveProjectsToDatabase(updates, {
          notifyOnError: true,
          collaboration: collaboration.editIdentity,
          restoreProjectIds,
          expectedUpdatedAts: Object.fromEntries(updates.map(project => [project.id, bases.get(project.id) ?? null])),
        });
        if (epoch !== ownerEpoch.current) return;
        savedProjects.forEach(rememberPersistedProject);
        if (nextTrash) {
          await saveTrashToDatabase(nextTrash, {
            notifyOnError: true,
            collaboration: collaboration.editIdentity,
          });
        }
        if (epoch !== ownerEpoch.current) return;
        setSaveStatus("draftSaved");
        setLastSavedAt(formatStatusTime());
      })().catch(() => {
        if (collaboration.sharingMode !== "supabase") {
          nextProjects.filter(project => !targetIds || targetIds.includes(project.id)).forEach(project => { void checkpointProject(project, bases.get(project.id) ?? null, undefined, owner); });
        }
        if (epoch !== ownerEpoch.current) return;
        setSaveStatus("error");
      });
    },
    [collaboration.editIdentity, collaboration.sharingMode, rememberPersistedProject],
  );

  const handleCreateProject = useCallback((name: string): void => {
    if (!collaboration.canCreateProject) {
      collaboration.readOnlyMessage();
      return;
    }
    const project = createNewProject(name);
    const epoch = ownerEpoch.current;
    const owner = draftScope();
    setSaveStatus("savingDraft");
    void (async () => {
      const baseIdentity = collaboration.projectCreateIdentity;
      const projectIdentity = baseIdentity ? { ...baseIdentity, projectId: project.id } : undefined;
      const next = [project, ...projects];
      skipNextSave.current = true;
      setProjects(next);
      const savedProject = await saveProjectToDatabase(project, next, {
        createOnly: true,
        notifyOnError: true,
        collaboration: projectIdentity,
      });
      return savedProject;
    })()
      .then((savedProject) => {
        if (epoch !== ownerEpoch.current) return;
        rememberPersistedProject(savedProject);
        skipNextSave.current = true;
        setProjects((latest) =>
          latest.some((candidate) => candidate.id === savedProject.id)
            ? latest.map((candidate) => (candidate.id === savedProject.id ? savedProject : candidate))
            : [savedProject, ...latest],
        );
        setActiveProjectId(savedProject.id);
        writeStoredActiveProjectId(savedProject.id);
        setSaveStatus("draftSaved");
        setLastSavedAt(formatStatusTime());
      })
      .catch((error) => {
        void checkpointProject(project, null, undefined, owner);
        if (epoch !== ownerEpoch.current) return;
        console.error("Failed to create project.", error);
        window.alert(error instanceof Error ? error.message : "Failed to create project.");
        setSaveStatus("error");
      });
  }, [collaboration, projects, rememberPersistedProject, setProjects]);

  const handleRenameProject = useCallback((id: string, newName: string): void => {
    if (!requireEditMode()) return;
    const epoch = ownerEpoch.current;
    const project = projectsRef.current.find(candidate => candidate.id === id);
    if (!project) return;
    setSaveStatus('savingDraft');
    void renameProjectInDatabase(id, newName, persistedProjectUpdatedAt.current.get(id) ?? project.updatedAt, collaboration.editIdentity)
      .then(saved => {
        if (epoch !== ownerEpoch.current) return;
        rememberPersistedProject(saved);
        skipNextSave.current = true;
        // Only name/version are owned by this response. Preserve any newer local edits.
        setProjects(latest => latest.map(candidate => candidate.id === id
          ? { ...candidate, name: saved.name, updatedAt: candidate.updatedAt === project.updatedAt ? saved.updatedAt : candidate.updatedAt }
          : candidate));
        setSaveStatus('draftSaved');
        setLastSavedAt(formatStatusTime());
      })
      .catch(error => { if (epoch !== ownerEpoch.current) return; setSaveStatus('error'); window.alert(`${error instanceof Error ? error.message : 'Rename failed.'}\nReload to check the project before retrying.`); });
  }, [collaboration.editIdentity, rememberPersistedProject, requireEditMode, setProjects]);

  const handleDeleteProject = useCallback(
    (id: string): void => {
      if (!requireEditMode()) return;
      const epoch = ownerEpoch.current;
      const project = projects.find((p) => p.id === id);
      if (!project) return;
      if (
        !window.confirm(
          `Move project "${project.name}" to Trash?\n\nIt will be permanently deleted only when you empty Trash.`,
        )
      ) {
        return;
      }
      deletePending.current = true;
      setDeletingProject(true);
      setSaveStatus('savingDraft');
      const pendingTrashSave = trashSaveTimer.current !== null;
      if (trashSaveTimer.current) clearTimeout(trashSaveTimer.current);
      trashSaveTimer.current = null;
      void (async () => {
        // Flush an earlier, independent RoomType/trash edit before replacing
        // the displayed snapshot with the transaction's authoritative result.
        if (pendingTrashSave) await saveTrashToDatabase(trash, { collaboration: collaboration.editIdentity });
        if (epoch !== ownerEpoch.current) throw new Error('The user has changed.');
        return deleteProjectToTrash(id, persistedProjectUpdatedAt.current.get(id) ?? project.updatedAt, collaboration.editIdentity);
      })()
        .then(saved => {
          if (epoch !== ownerEpoch.current) return;
          rememberPersistedProjects(saved.projects);
          skipNextSave.current = true;
          skipNextTrashSave.current = true;
          setTrash(saved.trash);
          setProjects(latest => latest.filter(candidate => candidate.id !== id));
          setActiveProjectId(current => {
            if (current !== id) return current;
            writeStoredActiveProjectId('');
            return '';
          });
          setSaveStatus('draftSaved');
          setLastSavedAt(formatStatusTime());
        })
        .catch(error => {
          if (epoch !== ownerEpoch.current) return;
          // A timeout can happen after commit. Keep the original visible until
          // an authoritative reload confirms its location; never draft a deletion.
          setSaveStatus('error');
          window.alert(`${error instanceof Error ? error.message : 'Deletion failed.'}\nReload to check the project and Trash before retrying.`);
        })
        .finally(() => { if (epoch === ownerEpoch.current) { deletePending.current = false; setDeletingProject(false); } });
    },
    [collaboration.editIdentity, projects, rememberPersistedProjects, requireEditMode, setProjects, trash],
  );

  const runProjectRestore = useCallback(async (record: ProjectDraftRecord, retry: boolean, epoch: number, feedbackScope: SaveFeedbackScope): Promise<void> => {
    const intent = record.intent;
    const restore = intent?.restore;
    const currentOwner = draftScope();
    const current = () => epoch === ownerEpoch.current && draftScope() === currentOwner;
    let saved: ProjectData | undefined;
    try {
      if (!validDraftRecord(record) || !intent || !restore || !currentOwner
        || record.scope.owner !== currentOwner.owner || record.scope.workspace !== currentOwner.workspace) throw new Error('The restore request owner and original data could not be verified.');
      const identity = { userId: collaboration.user?.id ?? '', sessionId: collaboration.sessionId,
        projectId: '', accessToken: collaboration.accessToken || undefined, requireLock: retry };
      if (retry && (!collaboration.canEdit || activeProjectRef.current)) throw new Error('Obtain edit access to the project list before retrying the same restore.');
      saved = retry && !restore.confirmedProject
        ? await saveProjectRestore(intent.project, identity)
        : await confirmProjectRestore(intent.project, identity, restore.confirmedProject);
      if (!current()) return;
      if (!saved) throw new Error('The restored project contents could not be verified.');
      if (!restore.confirmedProject) {
        const confirmedRecord = await checkpointProjectRestore(record.project, record.baseUpdatedAt ?? intent.before.updatedAt,
          { ...intent, restore: { ...restore, confirmedProject: saved } }, currentOwner);
        if (!current()) return;
        if (!confirmedRecord) throw new Error('The local draft of the restore confirmation has not been verified. The original Trash item is retained.');
        record = confirmedRecord;
      }
      setPendingRestore({ record, projectConfirmed: true });
      if (!collaboration.canEdit || activeProjectRef.current) throw new Error('Updating Trash requires edit access to the project list.');
      if (trashSaveTimer.current || trashSavesInFlight.current.size) throw new Error('Another Trash update is in progress. Check again after it finishes.');
      const confirmedTrash = await cleanupRestoredProjectTrash(restore.original,
        { ...identity, requireLock: true }, current);
      if (!current()) return;
      // Only exact generations with this restore operation and no extra edits are removable.
      const records = new Map([record, ...cachedDraftRecords()].map(item => [item.key, item]));
      for (const candidate of records.values()) {
        if (candidate.intent?.operationId === intent.operationId && candidate.intent.restore && candidate.scope.tab === `recovery:restore:${intent.operationId}`
          && !hasProjectChanges(candidate.project, record.project)) {
          await removeConfirmedDraft(candidate).catch(() => undefined);
          if (!current()) return;
        }
      }
      skipNextTrashSave.current = true;
      setTrash(migrateTrashPayload(confirmedTrash));
      setPendingRestore(null);
      setRecoveryRecords(cachedDraftRecords());
      reportSaveFeedback('success', 'The Project and Trash restore results have been verified.', feedbackScope);
      setSaveStatus('projectSaved');
      setLastSavedAt(formatStatusTime());
    } catch (error) {
      if (!current()) return;
      const detail = error instanceof SaveProtocolError ? `${error.message} (${error.code}${error.status ? ` / HTTP ${error.status}` : ''})` : error instanceof Error ? error.message : 'Check the saved data.';
      setPendingRestore({ record, projectConfirmed: Boolean(saved) });
      setSaveStatus('error');
      reportSaveFeedback(saved ? 'restore-partial' : 'restore-failed', saved ? `The project is restored; the Trash update has not been verified. ${detail}` : `The restore could not be verified. The original Trash item and restore request are retained. ${detail}`, feedbackScope);
    } finally {
      if (current()) {
        if (saved) {
          const displayedSaved = saved.lastSaveOperation?.id === intent!.operationId && !hasProjectChanges({ ...saved, name: intent!.project.name }, intent!.project)
            ? { ...record.project, name: saved.name, updatedAt: saved.updatedAt, lastUpdatedBy: saved.lastUpdatedBy, lastSaveOperation: saved.lastSaveOperation }
            : migrateProjectsPayload([saved])[0];
          rememberPersistedProject(displayedSaved);
          skipNextSave.current = true;
          setProjects(latest => latest.some(item => item.id === saved!.id)
            ? latest.map(item => item.id === saved!.id ? rebaseProjectSave({ before: record.project, saved: displayedSaved }, item) : item) : [displayedSaved, ...latest]);
          const latest = projectsRef.current.find(item => item.id === saved!.id);
          if (latest && hasProjectChanges(latest, displayedSaved)) {
            await checkpointProject(latest, saved.updatedAt, undefined, currentOwner);
            if (!current()) return;
          }
        }
        restoreInFlight.current = false;
        setRestoringProject(false);
      }
    }
  }, [collaboration.accessToken, collaboration.canEdit, collaboration.sessionId, collaboration.user?.id, rememberPersistedProject, setProjects, reportSaveFeedback]);

  const resolveProjectRestore = (record: ProjectDraftRecord, retry = false): void => {
    const feedbackScope = captureSaveFeedbackScope();
    if (restoreInFlight.current || (retry && (!requireEditMode() || activeProjectRef.current))) return;
    restoreInFlight.current = true;
    setRestoringProject(true);
    reportSaveFeedback('progress', 'Checking the restore destination.', feedbackScope);
    void runProjectRestore(record, retry, ownerEpoch.current, feedbackScope);
  };

  const handleRestoreProject = useCallback(
    (trashItemId: string): void => {
      const feedbackScope = captureSaveFeedbackScope();
      if (!requireEditMode()) return;
      if (restoreInFlight.current || pendingRestore) return;
      if (trashSaveTimer.current || trashSavesInFlight.current.size) { reportSaveFeedback('recovery-required', 'Trash is being updated. Restore after the update finishes.', feedbackScope); return; }
      const item = trash.projects.find((candidate) => candidate.id === trashItemId);
      if (!item) return;
      const previous = cachedDraftRecords().filter(record => validDraftRecord(record) && record.intent?.restore?.trashItemId === trashItemId)
        .sort((a, b) => b.generation - a.generation)[0];
      if (previous) { setPendingRestore({ record: previous, projectConfirmed: false }); reportSaveFeedback('recovery-required', 'A previous restore request is retained. Check Restore Status.', feedbackScope); return; }
      if (projects.some((project) => project.id === item.project.id)) {
        window.alert("A project with the same ID already exists.");
        return;
      }
      const usedNames = new Set(projects.map((project) => project.name));
      const restored = {
        ...cloneData(item.project),
        name: uniqueName(item.project.name, usedNames),
        updatedAt: new Date().toISOString(),
      };
      const epoch = ownerEpoch.current;
      const owner = draftScope();
      restoreInFlight.current = true;
      setRestoringProject(true);
      reportSaveFeedback('progress', 'Storing the restore request on this device. Trash is retained until verification finishes.', feedbackScope);
      void (async () => {
        const original = await readProjectRestoreTrashItem(item, collaboration.editIdentity ?? undefined,
          () => epoch === ownerEpoch.current && draftScope() === owner);
        if (epoch !== ownerEpoch.current) return;
        const prepared = await prepareProjectRestore({ ...original.project, name: restored.name, updatedAt: restored.updatedAt });
        if (epoch !== ownerEpoch.current) return;
        const record = await checkpointProjectRestore(restored, item.project.updatedAt, {
          before: cloneData(item.project), project: prepared, expectedUpdatedAt: item.project.updatedAt, operationId: prepared.lastSaveOperation!.id,
          restore: { trashItemId, deletedAt: item.deletedAt, expectedUpdatedAt: null, original },
        }, owner);
        if (epoch !== ownerEpoch.current) return;
        if (!record) throw new Error('The local draft of the restore request could not be verified. The original Trash item is retained.');
        setPendingRestore({ record, projectConfirmed: false });
        setRecoveryRecords(cachedDraftRecords());
        await runProjectRestore(record, true, epoch, feedbackScope);
      })().catch(error => {
        if (epoch !== ownerEpoch.current) return;
        reportSaveFeedback('restore-failed', `The restore could not be verified. ${error instanceof Error ? error.message : 'The original data is retained.'}`, feedbackScope);
        setSaveStatus('error');
      }).finally(() => { if (epoch === ownerEpoch.current) { restoreInFlight.current = false; setRestoringProject(false); } });
    },
    [collaboration.editIdentity, pendingRestore, projects, requireEditMode, trash, runProjectRestore, reportSaveFeedback, captureSaveFeedbackScope],
  );

  const handleMoveRoomTypeToTrash = useCallback((project: ProjectData, roomType: RoomType): void => {
    if (!requireEditMode()) return;
    setTrash((current) => ({
      ...current,
      roomTypes: [
        {
          id: createAppId(),
          deletedAt: new Date().toISOString(),
          projectId: project.id,
          projectName: project.name,
          roomType: cloneData(roomType),
        },
        ...current.roomTypes,
      ],
    }));
  }, [requireEditMode]);

  const handleRestoreRoomType = useCallback(
    (trashItemId: string): void => {
      if (!requireEditMode()) return;
      const item = trash.roomTypes.find((candidate) => candidate.id === trashItemId);
      if (!item) return;
      const targetProject = projects.find((project) => project.id === item.projectId);
      if (!targetProject) {
        window.alert("Restore the original project before restoring this room type.");
        return;
      }
      const restoredAt = new Date().toISOString();
      const nextProjects = projects.map((project) => {
        if (project.id !== item.projectId) return project;
        const usedNames = new Set(project.roomTypes.map((roomType) => roomType.name));
        const idExists = project.roomTypes.some((roomType) => roomType.id === item.roomType.id);
        const restored = {
          ...cloneData(item.roomType),
          id: idExists ? createAppId() : item.roomType.id,
          name: uniqueName(item.roomType.name, usedNames),
          updatedAt: restoredAt,
        };
        return {
          ...project,
          updatedAt: restoredAt,
          roomTypes: [restored, ...project.roomTypes],
        };
      });
      const nextTrash = {
        ...trash,
        roomTypes: trash.roomTypes.filter((candidate) => candidate.id !== trashItemId),
      };
      skipNextSave.current = true;
      skipNextTrashSave.current = true;
      setProjects(nextProjects);
      setTrash(nextTrash);
      persistProjectListSnapshot(nextProjects, nextTrash, [item.projectId]);
    },
    [persistProjectListSnapshot, projects, requireEditMode, trash, setProjects],
  );

  const handleEmptyTrash = useCallback((): void => {
    if (!requireEditMode()) return;
    const itemCount = trash.projects.length + trash.roomTypes.length;
    if (itemCount === 0) return;
    if (
      !window.confirm(
        `Permanently delete ${itemCount} trash item${itemCount === 1 ? "" : "s"}?\n\nThis cannot be undone.`,
      )
    ) {
      return;
    }
    setTrash(emptyTrashData());
  }, [trash, requireEditMode]);

  const handleSelectProject = useCallback((id: string): void => {
    setActiveProjectId(id);
    writeStoredActiveProjectId(id);
  }, []);

  const handleBackToProjects = useCallback((): void => {
    setActiveProjectId("");
    writeStoredActiveProjectId("");
  }, []);

  const handleExportProjects = useCallback(
    (targetProjects: ProjectData[], filenamePrefix?: string): void => {
      if (targetProjects.length === 0) return;
      downloadProjectBackup(targetProjects, filenamePrefix);
    },
    [],
  );

  const importBlocksProject = useCallback((id: string): boolean => importBatches(cachedDraftRecords()).some(records =>
    (deferredRuntimeBlocked.current.has(records[0].importRecovery?.batchId ?? '')
      || !(confirmedImportBatch(records) && confirmedImportsReady.includes(records[0].importRecovery!.batchId))
        && !(deferredImportSubset(records) && deferredImportsReady.includes(records[0].importRecovery!.batchId)))
    && records.some(record => importTargetsProject(record, id))), [deferredImportsReady, confirmedImportsReady]);

  useEffect(() => {
    const batches = importBatches(recoveryRecords).filter(records => records.every(validDraftRecord) && confirmedImportBatch(records)
      && !confirmedImportsReady.includes(records[0].importRecovery!.batchId) && !deferredRuntimeBlocked.current.has(records[0].importRecovery!.batchId));
    if (!batches.length) return;
    let cancelled = false;
    const epoch = ownerEpoch.current;
    void Promise.all(batches.map(async records => { await verifyImportBatch(records); return records[0].importRecovery!.batchId; })).then(ids => {
      if (!cancelled && epoch === ownerEpoch.current) setConfirmedImportsReady(old => [...new Set([...old, ...ids])]);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [recoveryRecords, confirmedImportsReady]);

  useEffect(() => {
    if (loading || collaboration.requiresSignIn) return;
    const batches = importBatches(recoveryRecords).filter(records => records.every(validDraftRecord) && recoverableImportSubset(records)
      && deferredImportSubset(records)
      && !deferredImportsReady.includes(records[0].importRecovery!.batchId)
      && !deferredRuntimeBlocked.current.has(records[0].importRecovery!.batchId));
    if (!batches.length) return;
    let cancelled = false;
    const epoch = ownerEpoch.current;
    void (async () => {
      await Promise.all(batches.map(records => verifyImportBatch(records, undefined, true)));
      return readImportSharedProjects({ userId: collaboration.user?.id ?? 'local', sessionId: collaboration.sessionId,
        accessToken: collaboration.accessToken || undefined, requireLock: false });
    })().then(shared => {
      if (cancelled || epoch !== ownerEpoch.current) return;
      // Startup fallback or a changed shared baseline must not release the gate.
      if (canonicalJson([...persistedProjects.current.values()]) !== canonicalJson(shared)) return;
      setDeferredImportsReady(old => [...new Set([...old, ...batches.map(records => records[0].importRecovery!.batchId)])]);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [loading, recoveryRecords, deferredImportsReady, collaboration.requiresSignIn, collaboration.user?.id, collaboration.sessionId, collaboration.accessToken]);

  const finishImport = useCallback(async (records: ProjectDraftRecord[], saved: ProjectData[], owner: DraftScope, epoch: number, displayedPrepared: boolean) => {
    if (epoch !== ownerEpoch.current || draftScope() !== owner) return;
    const beforeById = new Map(records.map(record => {
      const latest = projectsRef.current.find(project => project.id === record.project.id);
      return [record.project.id, !displayedPrepared && latest && !hasProjectChanges(latest, persistedProjects.current.get(latest.id)) ? latest : record.project];
    }));
      saved.forEach(rememberPersistedProject);
      setProjects(latest => latest.map(project => {
        const confirmed = saved.find(item => item.id === project.id);
        const before = beforeById.get(project.id);
        return confirmed && before ? rebaseProjectSave({ before, saved: confirmed }, project) : project;
      }));
      const visibleSaved = saved.find(project => project.id === activeProjectRef.current);
      const visibleBefore = visibleSaved ? beforeById.get(visibleSaved.id) : undefined;
      if (visibleSaved && visibleBefore) setSaveReceipt({ before: visibleBefore, saved: visibleSaved });
    const batchId = records[0].importRecovery!.batchId;
    deferredRuntimeBlocked.current.add(batchId);
    const targetSnapshot = () => canonicalJson(projectsRef.current.filter(project => saved.some(item => item.id === project.id)));
    const checkpointedContents = targetSnapshot();
    // Verify every latest local edit before acknowledging the fixed import.
    for (const confirmed of saved) {
      const latest = projectsRef.current.find(project => project.id === confirmed.id);
      if (latest && hasProjectChanges(latest, confirmed) && !await preserveRecoveryProject(latest, confirmed.updatedAt, owner)) {
        throw new Error('Shared import verified, but the latest local edits could not be stored. Import recovery is retained.');
      }
      if (epoch !== ownerEpoch.current || draftScope() !== owner) return;
    }
    if (targetSnapshot() !== checkpointedContents) throw new Error('Shared import verified, but local edits changed during recovery storage. Check Import Status again to retain the latest edits.');
    await confirmProjectImport(records, owner);
    if (epoch === ownerEpoch.current && draftScope() === owner) {
      if (targetSnapshot() !== checkpointedContents) throw new Error('Shared import verified, but local edits changed during recovery storage. Check Import Status again to retain the latest edits.');
      deferredRuntimeBlocked.current.delete(batchId);
      setConfirmedImportsReady(old => [...new Set([...old, batchId])]);
      setRecoveryRecords(cachedDraftRecords()); setImportAttempt(null);
    }
  }, [rememberPersistedProject, setProjects]);

  const executeImport = useCallback(async (targets: ProjectData[], actions: ImportRecovery['action'][], started: ProjectData[], owner: DraftScope, epoch: number, view: string, identity: CollaborationSaveIdentity | undefined) => {
    const batchId = createAppId();
    const targetIds = targets.map(project => project.id);
    if (new Set(targetIds).size !== targetIds.length) throw new Error('The import has duplicate project IDs. No import was sent.');
    const expected = targets.map(project => {
      const existing = started.find(item => item.id === project.id);
      const token = persistedProjectUpdatedAt.current.get(project.id);
      if (existing && !token) throw new Error('The shared baseline is unknown. Load shared data before importing.');
      if (importBlocksProject(project.id) || cachedDraftRecords().some(record => record.project.id === project.id && record.intent)) {
        throw new Error('A previous save for an import target needs verification. Open Save and Recovery first.');
      }
      return existing ? token! : null;
    });
    const unchanged = () => epoch === ownerEpoch.current && draftScope() === owner && activeProjectRef.current === view
      && canonicalJson(importIdentityRef.current) === canonicalJson(identity)
      && targets.every((project, index) => canonicalJson(projectsRef.current.find(item => item.id === project.id)) === canonicalJson(started.find(item => item.id === project.id))
        && (persistedProjectUpdatedAt.current.get(project.id) ?? null) === expected[index]);
    const prepared = await Promise.all(targets.map(project => prepareProjectSave(project, 'current')));
    if (!unchanged()) throw new Error('The current view or project changed. No import was sent. Select the file again.');
    const records: ProjectDraftRecord[] = [];
    let attempt: ImportAttempt = { batchId, prepared, records, message: 'Storing import recovery on this device…' };
    setImportAttempt(attempt);
    try {
      for (const target of targets) {
        const previous = started.find(project => project.id === target.id);
        if (previous && hasProjectChanges(previous, persistedProjects.current.get(previous.id))) {
          if (!await preserveRecoveryProject(previous, expected[targetIds.indexOf(target.id)]!, owner)) throw new Error('The previous local edits could not be archived. No import was sent.');
        }
      }
      for (let index = 0; index < prepared.length; index++) {
        if (!unchanged()) throw new Error('The current view or project changed. No import was sent. Keep the recovery backup.');
        const record = await checkpointProjectImport(prepared[index], { version: 1, batchId, targetIds, expectedUpdatedAt: expected[index],
          operationId: prepared[index].lastSaveOperation!.id, action: actions[index] }, owner);
        if (!record) throw new Error('The complete import could not be stored on this device. No import was sent. Download Import Backup before closing.');
        records.push(record);
      }
      await verifyImportBatch(records, prepared);
      if (!unchanged()) throw new Error('The current view or project changed. No import was sent. Keep the recovery backup.');
      setRecoveryRecords(cachedDraftRecords());
      attempt = { ...attempt, displayedPrepared: true, message: 'Saving import…' };
      setImportAttempt(attempt);
      importPhase.current = 'sending';
      skipNextSave.current = true;
      setProjects(latest => [...prepared.filter(project => !latest.some(item => item.id === project.id)),
        ...latest.map(project => prepared.find(item => item.id === project.id) ?? project)]);
      const saved = await saveProjectsToDatabase(prepared, { collaboration: identity, notifyOnError: false, requirePreparedImport: true,
        expectedUpdatedAts: Object.fromEntries(targetIds.map((id, index) => [id, expected[index]])) });
      await finishImport(records, saved, owner, epoch, true);
    } catch (error) {
      if (epoch === ownerEpoch.current && draftScope() === owner) {
        const detail = error instanceof SaveProtocolError ? `${error.message} (${error.code}${error.status ? ` / HTTP ${error.status}` : ''})` : error instanceof Error ? error.message : 'The import result could not be verified.';
        setImportAttempt({ ...attempt, message: detail }); setRecoveryRecords(cachedDraftRecords());
      }
    }
  }, [finishImport, importBlocksProject, setProjects]);

  const resolveImport = useCallback(async (records: ProjectDraftRecord[], defer = false) => {
    if (importInFlight.current || explicitSavePending.current || restoreInFlight.current) return;
    const owner = draftScope(), epoch = ownerEpoch.current;
    if (!owner || !records.every(record => record.scope.owner === owner.owner && record.scope.workspace === owner.workspace)) return;
    const current = () => owner === draftScope() && epoch === ownerEpoch.current;
    const batchId = records[0]?.importRecovery?.batchId ?? '';
    const prepared = importAttempt?.batchId === batchId ? importAttempt.prepared : records.map(record => record.project);
    let attempt: ImportAttempt = { batchId, records, prepared, displayedPrepared: importAttempt?.batchId === batchId && importAttempt.displayedPrepared,
      message: defer ? 'Keeping recovery and loading shared data…' : 'Checking import status…' };
    importInFlight.current = true; importPhase.current = defer ? 'defer' : 'checking'; setImportBusy(true); setImportAttempt(attempt);
    try {
      records = await refreshProjectImport(records, owner);
      if (!current()) return;
      attempt = { ...attempt, records, prepared: completeImportBatch(records) ? records.map(record => record.project) : prepared };
      setRecoveryRecords(cachedDraftRecords()); setImportAttempt(attempt);
      if (!records.every(validDraftRecord)) throw new Error('The import recovery is incomplete. Export the original recovery for review.');
      await verifyImportBatch(records, undefined, defer);
      if (!current()) return;
      const identity = { userId: collaboration.user?.id ?? 'local', sessionId: collaboration.sessionId,
        accessToken: collaboration.accessToken || undefined, requireLock: false };
      if (defer) {
        const incomplete = !completeImportBatch(records);
        if (!window.confirm(`${incomplete ? 'Some import recovery projects are missing. Their contents cannot be recovered from this incomplete backup, and the shared save remains unverified. ' : ''}Keep this import as unverified recovery and load the latest shared data? Current local edits will be stored first. Nothing will be saved to shared data.`)) return;
        deferredRuntimeBlocked.current.add(batchId);
        const view = activeProjectRef.current;
        const snapshot = projectsRef.current;
        const unchanged = () => current() && view === activeProjectRef.current && canonicalJson(snapshot) === canonicalJson(projectsRef.current);
        for (const project of snapshot) {
          if (hasProjectChanges(project, persistedProjects.current.get(project.id))
            && !await preserveRecoveryProject(project, persistedProjectUpdatedAt.current.get(project.id) ?? null, owner)) {
            throw new Error('Current edits could not be stored. Import recovery and the current view are retained.');
          }
          if (!unchanged()) throw new Error('The current view changed. Import recovery is retained.');
        }
        const shared = await readImportSharedProjects(identity);
        if (!unchanged()) throw new Error('The current view changed. Import recovery is retained.');
        // A durable defer records the user's choice; it does not authorize a stale UI update.
        const updated = await deferProjectImport(records, owner);
        if (!current()) return;
        if (!unchanged()) throw new Error('Recovery is retained, but the view changed. Load shared data again to resume.');
        rememberPersistedProjects(shared);
        skipNextSave.current = true;
        setProjects(shared);
        deferredRuntimeBlocked.current.delete(batchId);
        setDeferredImportsReady(old => [...new Set([...old, batchId])]);
        if (activeProjectRef.current && !shared.some(project => project.id === activeProjectRef.current)) { setActiveProjectId(''); writeStoredActiveProjectId(''); }
        setRecoveryRecords(cachedDraftRecords());
        setImportAttempt({ ...attempt, records: updated, message: 'Import remains unverified. Shared data loaded. Recovery backups are retained. To import again, use Download Import Backup and choose Update for matching IDs.' });
      } else {
        const results: Record<string, string> = {};
        const confirmed: ProjectData[] = [];
        for (const record of records) {
          try { confirmed.push(await confirmProjectSave(record.project, identity)); results[record.project.id] = 'Verified in shared data'; }
          catch (error) { results[record.project.id] = error instanceof SaveProtocolError ? `${error.message} (${error.code}${error.status ? ` / HTTP ${error.status}` : ''})` : 'Not verified'; }
          if (!current()) return;
        }
        if (confirmed.length === records.length) {
          await finishImport(records, confirmed, owner, epoch, Boolean(attempt.displayedPrepared));
        } else {
          setImportAttempt({ ...attempt, results, message: 'The complete import has not been verified. All import recovery is retained. No import was resent.' });
        }
      }
    } catch (error) {
      if (current()) { setImportAttempt({ ...attempt, message: error instanceof Error ? error.message : 'Import recovery could not be verified.' }); setRecoveryRecords(cachedDraftRecords()); }
    } finally {
      if (current()) { importInFlight.current = false; importPhase.current = null; setImportBusy(false); }
    }
  }, [collaboration.user?.id, collaboration.sessionId, collaboration.accessToken, finishImport, rememberPersistedProjects, setProjects, importAttempt]);

  const handleImportProjects = useCallback((file: File): void => {
    if (!requireEditMode() || importInFlight.current || explicitSavePending.current || restoreInFlight.current || pendingSave || pendingRestore) return;
    const epoch = ownerEpoch.current;
    const owner = draftScope();
    const view = activeProjectRef.current;
    const identity = collaboration.editIdentity;
    if (!owner || view) { window.alert('Open the project list with verified edit access before importing.'); return; }
    const maxBytes = 50 * 1024 * 1024;
    if (file.size > maxBytes) {
      window.alert("Import file must be 50 MB or smaller.");
      return;
    }

    importInFlight.current = true; importPhase.current = 'preparing'; setImportBusy(true);
    const finish = () => { if (epoch === ownerEpoch.current) { importInFlight.current = false; importPhase.current = null; setImportBusy(false); } };
    const started = projectsRef.current;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        if (epoch !== ownerEpoch.current || draftScope() !== owner || view !== activeProjectRef.current) return;
        const text = typeof reader.result === "string" ? reader.result : "";
        const parsed: unknown = JSON.parse(text);
        const imported = migrateProjectsPayload(parsed);
        const rawImportedById = new Map(
          rawProjectListFromImport(parsed)
            .filter((project) => typeof project.id === "string")
            .map((project) => [project.id as string, project]),
        );
        if (imported.length === 0) {
          window.alert("No valid CFS projects were found in this file.");
          return;
        }

        const existingById = new Map(started.map((project) => [project.id, project]));
        const importedForUpdate = imported.map((project) => {
          const existingProject = existingById.get(project.id);
          return existingProject
            ? preserveFieldsMissingFromImport(existingProject, project, rawImportedById.get(project.id))
            : project;
        });
        const conflictingImportedProjects = imported.filter((project) => existingById.has(project.id));
        const conflictingProjects = importedForUpdate.filter((project) => existingById.has(project.id));
        const newProjects = imported.filter((project) => !existingById.has(project.id));
        const conflictAction =
          conflictingProjects.length > 0 ? chooseImportConflictAction(conflictingProjects) : "update";
        if (conflictAction === "cancel") return;

        if (conflictAction === "update") {
          const importedById = new Map(importedForUpdate.map((project) => [project.id, project]));
          const smallerWarnings = started
            .map((project) => {
              const importedProject = importedById.get(project.id);
              return importedProject ? smallerImportWarning(project, importedProject) : null;
            })
            .filter((warning): warning is string => warning !== null);
          if (smallerWarnings.length > 0) {
            const proceed = window.confirm(
              [
                "The selected import file has less data than an existing project with the same ID.",
                "Importing it may overwrite the current project with a partial/older backup.",
                "",
                ...smallerWarnings,
                "",
                "Continue replacing the existing project?",
              ].join("\n"),
            );
            if (!proceed) return;
          }

          const replaceCount = conflictingProjects.length;
          const message = [
            `Import ${imported.length} project${imported.length === 1 ? "" : "s"}?`,
            replaceCount > 0 ? `${replaceCount} existing project${replaceCount === 1 ? "" : "s"} will be updated by ID.` : "",
            newProjects.length > 0 ? `${newProjects.length} project${newProjects.length === 1 ? "" : "s"} will be added.` : "",
          ].filter(Boolean).join("\n");
          if (!window.confirm(message)) return;

          await executeImport(importedForUpdate, importedForUpdate.map(project => existingById.has(project.id) ? 'update' : 'new'), started, owner, epoch, view, identity);
          return;
        }

        const usedNames = new Set(started.map((project) => project.name));
        const copiedProjects = conflictingImportedProjects.map((project) => ({
          ...cloneData(project),
          id: createAppId(),
          name: uniqueImportCopyName(project.name, usedNames),
        }));
        const message = [
          `Import ${imported.length} project${imported.length === 1 ? "" : "s"}?`,
          `${copiedProjects.length} same-ID project${copiedProjects.length === 1 ? "" : "s"} will be added as copied project${copiedProjects.length === 1 ? "" : "s"} with new IDs.`,
          newProjects.length > 0 ? `${newProjects.length} project${newProjects.length === 1 ? "" : "s"} will be added normally.` : "",
        ].filter(Boolean).join("\n");
        if (!window.confirm(message)) return;

        await executeImport([...copiedProjects, ...newProjects], [...copiedProjects.map(() => 'copy' as const), ...newProjects.map(() => 'new' as const)], started, owner, epoch, view, identity);
      } catch (error) {
        console.error("Failed to import project data.", error);
        if (epoch === ownerEpoch.current) window.alert(error instanceof Error ? error.message : 'Failed to import the selected file. Check that it is a valid JSON or QJSON backup.');
      } finally { finish(); }
    };
    reader.onerror = () => {
      window.alert("Failed to read the selected file.");
      finish();
    };
    reader.onabort = finish;
    try { reader.readAsText(file, "utf-8"); }
    catch { finish(); window.alert('Failed to read the selected file.'); }
  }, [requireEditMode, collaboration.editIdentity, pendingSave, pendingRestore, executeImport]);

  const handleUpdateProject = useCallback(
    (mutate: (project: ProjectData) => ProjectData): void => {
      if (!requireEditMode()) return;
      setProjects((current) =>
        current.map((p) =>
          p.id === activeProjectId
            ? { ...mutate(p), updatedAt: nextProjectEditTime(p.updatedAt) }
            : p,
        ),
      );
    },
    [activeProjectId, requireEditMode, setProjects],
  );

  const saveProject = useCallback(
    async (mutate: (project: ProjectData) => ProjectData | null, revision: boolean): Promise<boolean> => {
      const feedbackScope = captureSaveFeedbackScope();
      if (!requireEditMode() || explicitSavePending.current || importBlocksProject(activeProjectId)) return false;
      if (pendingSave) { reportSaveFeedback('recovery-required', 'Verify the previous save result before saving again.', feedbackScope); return false; }
      const currentProject = projectsRef.current.find((project) => project.id === activeProjectId);
      if (!currentProject) return false;
      const expectedUpdatedAt = persistedProjectUpdatedAt.current.get(currentProject.id);
      if (!expectedUpdatedAt) {
        window.alert(`This project was loaded from a browser draft or an unknown database state. Reload the project list before saving${revision ? " a revision" : ""}.`);
        setSaveStatus("error");
        return false;
      }
      const savedAt = new Date().toISOString();
      const editor = collaboration.editorInfo
        ? { ...collaboration.editorInfo, updatedAt: savedAt }
        : null;
      let mutated: ProjectData | null;
      try {
        mutated = mutate(currentProject);
        if (revision && mutated) mutated = appendCommonRevision(mutated, '', collaboration.user?.displayName ?? '');
      }
      catch (error) { reportSaveFeedback('save-failed', error instanceof Error ? error.message : 'The save contents could not be prepared. Check the original data.', feedbackScope); setSaveStatus('error'); return false; }
      if (!mutated) return false;
      let projectToSave: ProjectData = {
        ...mutated,
        updatedAt: savedAt,
        lastUpdatedBy: editor ?? currentProject.lastUpdatedBy ?? null,
      };
      explicitSavePending.current = true;
      const owner = draftScope();
      const epoch = ownerEpoch.current;
      try {
      setSaveStatus(revision ? "savingRevision" : "savingProject");
      reportSaveFeedback('progress', 'Sending the save…', feedbackScope);
      projectToSave = await prepareProjectSave(projectToSave, revision ? 'revision' : 'current');
      let intent: NonNullable<ProjectDraftRecord['intent']> = { before: currentProject, project: projectToSave, expectedUpdatedAt, operationId: projectToSave.lastSaveOperation!.id };
      const draft = await checkpointProject(currentProject, expectedUpdatedAt, intent, owner);
      if (epoch !== ownerEpoch.current) return false;
      const next = projectsRef.current.map((p) =>
        p.id === activeProjectId ? projectToSave : p,
      );
      const revisionSaveIdentity = collaboration.editIdentity
        ? { ...collaboration.editIdentity, projectId: projectToSave.id }
        : undefined;
      let savedProject: ProjectData | null = null;
      try {
        savedProject = await saveProjectToDatabase(projectToSave, next, {
          expectedUpdatedAt,
          notifyOnError: false,
          collaboration: revisionSaveIdentity,
        });
      } catch (error) {
        if (epoch !== ownerEpoch.current) return false;
        if (error instanceof SaveProtocolError) {
          reportSaveFeedback('save-failed', `${error.message} (${error.code}${error.status ? ` / HTTP ${error.status}` : ''})`, feedbackScope);
          if (error.unknown) setPendingSave({ before: currentProject, sent: projectToSave, expected: expectedUpdatedAt, draft });
        } else if (!isProjectSaveConflictError(error)) {
          reportSaveFeedback('save-failed', 'Save failed. Keep your draft and check the connection and edit access.', feedbackScope);
        }
        try {
          savedProject = await recoverProjectSaveConflict(error, projectToSave, next, expectedUpdatedAt, revisionSaveIdentity);
        } catch (recoveryError) {
          if (epoch !== ownerEpoch.current) return false;
          if (recoveryError instanceof SaveProtocolError && recoveryError.unknown) {
            const forceOverwriteUpdatedAt = (recoveryError as SaveProtocolError & { forceOverwriteUpdatedAt?: string }).forceOverwriteUpdatedAt;
            intent = { ...intent, forceOverwriteUpdatedAt };
            setPendingSave({ before: currentProject, sent: projectToSave, expected: expectedUpdatedAt, draft, forceOverwriteUpdatedAt });
            reportSaveFeedback('save-failed', `${recoveryError.message} (${recoveryError.code}${recoveryError.status ? ` / HTTP ${recoveryError.status}` : ''})`, feedbackScope);
          }
          console.error("Failed to recover from project revision save conflict.", recoveryError);
        }
      }
      if (epoch !== ownerEpoch.current) return false;
      if (!savedProject) {
        const latest = projectsRef.current.find(candidate => candidate.id === currentProject.id);
        // A conflict Reload deliberately replaced the visible project with the
        // server snapshot. Do not overwrite the preserved pre-reload draft with it.
        if (latest && hasProjectChanges(latest, persistedProjects.current.get(latest.id))) await checkpointProject(latest, expectedUpdatedAt, intent, owner);
        if (epoch !== ownerEpoch.current) return false;
        setSaveStatus("error");
        return false;
      }
      if (epoch !== ownerEpoch.current) return false;
      rememberPersistedProject(savedProject);
      reportSaveFeedback('success', 'Saved contents verified.', feedbackScope);
      collaboration.resumeIdleAfterSave?.();
      const receipt = { before: currentProject, saved: savedProject };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      setProjects((latest) =>
        latest.map((candidate) => (candidate.id === savedProject.id ? rebaseProjectSave(receipt, candidate) : candidate)),
      );
      setSaveReceipt(receipt);
      // storage clears this project's old draft on success. Replace it with
      // the current edits immediately, before a reload can lose them.
      const remaining = projectsRef.current.find((candidate) => candidate.id === savedProject.id);
      const removeRetired = !remaining || !hasProjectChanges(remaining, savedProject);
      skipNextSave.current = removeRetired;
      const retired = await checkpointProject(remaining ?? savedProject, savedProject.updatedAt, null, owner);
      if (removeRetired && retired) await removeConfirmedDraft(retired).catch(() => undefined);
      await collaboration.refreshStatus().catch(() => undefined);
      if (epoch !== ownerEpoch.current) return false;
      const latest = projectsRef.current.find((candidate) => candidate.id === savedProject.id);
      if (latest && hasProjectChanges(latest, savedProject)) {
        setSaveStatus('idle');
      } else {
        setSaveStatus(revision ? "revisionSaved" : "projectSaved");
      }
      setLastSavedAt(formatStatusTime());
      return true;
      } catch (error) {
        if (epoch === ownerEpoch.current) { setSaveStatus('error'); reportSaveFeedback('save-failed', error instanceof Error ? error.message : 'The save could not start. Export a backup.', feedbackScope); }
        return false;
      } finally { if (epoch === ownerEpoch.current) explicitSavePending.current = false; }
    },
    [activeProjectId, requireEditMode, collaboration, rememberPersistedProject, recoverProjectSaveConflict, setProjects, pendingSave, reportSaveFeedback, captureSaveFeedbackScope, importBlocksProject],
  );

  const handleSaveProjectRevision = useCallback(
    (mutate: (project: ProjectData) => ProjectData | null) => saveProject(mutate, true),
    [saveProject],
  );

  const handleSaveProjectDraft = useCallback(
    (mutate: (project: ProjectData) => ProjectData | null) => saveProject(mutate, false),
    [saveProject],
  );

  const resolvePendingSave = async (retry = false): Promise<void> => {
    const feedbackScope = captureSaveFeedbackScope();
    if (!pendingSave || explicitSavePending.current || importInFlight.current || importBlocksProject(pendingSave.sent.id)) return;
    if (retry && (!requireEditMode() || activeProjectId !== pendingSave.sent.id)) return;
    explicitSavePending.current = true;
    const owner = draftScope();
    const epoch = ownerEpoch.current;
    const identity = { userId: collaboration.user?.id ?? '', sessionId: collaboration.sessionId,
      projectId: pendingSave.sent.id, accessToken: collaboration.accessToken || undefined, requireLock: retry };
    try {
      const saved = retry
        ? await saveProjectToDatabase(pendingSave.sent, projectsRef.current, { expectedUpdatedAt: pendingSave.expected,
          forceOverwrite: Boolean(pendingSave.forceOverwriteUpdatedAt), forceOverwriteUpdatedAt: pendingSave.forceOverwriteUpdatedAt,
          collaboration: identity, notifyOnError: false })
        : await confirmProjectSave(pendingSave.sent, identity);
      if (epoch !== ownerEpoch.current) return;
      if (pendingSave.archived && pendingSave.draft) {
        const recovered = rebaseProjectSave({ before: pendingSave.before, saved }, pendingSave.draft.project);
        const retained = await preserveRecoveryProject(recovered, saved.updatedAt, owner);
        if (epoch !== ownerEpoch.current) return;
        if (retained) {
          await removeConfirmedDraft(pendingSave.draft).catch(() => undefined);
          if (epoch !== ownerEpoch.current) return;
          setRecoveryRecords(cachedDraftRecords());
        }
        setPendingSave(null);
        reportSaveFeedback('recovery-required', 'The previous save has been verified. Later edits are retained in the local draft. Obtain edit access, then restore the draft to editing.', feedbackScope);
        return;
      }
      rememberPersistedProject(saved);
      const receipt = { before: pendingSave.before, saved };
      setProjects(latest => latest.map(project => project.id === saved.id ? rebaseProjectSave(receipt, project) : project));
      setSaveReceipt(receipt);
      const latest = projectsRef.current.find(project => project.id === saved.id);
      const retired = await checkpointProject(latest ?? saved, saved.updatedAt, null, owner);
      if ((!latest || !hasProjectChanges(latest, saved)) && retired) await removeConfirmedDraft(retired).catch(() => undefined);
      if (epoch !== ownerEpoch.current) return;
      setPendingSave(null);
      setSaveStatus(saved.lastSaveOperation?.kind === 'current' ? 'projectSaved' : 'revisionSaved');
      reportSaveFeedback('success', 'Saved contents verified.', feedbackScope);
    } catch (error) {
      if (epoch !== ownerEpoch.current) return;
      reportSaveFeedback('save-failed', error instanceof SaveProtocolError ? `${error.message} (${error.code}${error.status ? ` / HTTP ${error.status}` : ''})` : 'The save result has not yet been verified. The local draft is retained.', feedbackScope);
    } finally { if (epoch === ownerEpoch.current) explicitSavePending.current = false; }
  };

  const visibleImports = importBatches(recoveryRecords).filter(records => !activeProjectId || records.some(record => importTargetsProject(record, activeProjectId)));
  const visibleAttempt = importAttempt && (!activeProjectId || importAttempt.prepared.some(project => project.id === activeProjectId)) ? importAttempt : null;
  const activeImports = visibleImports.filter(records => deferredRuntimeBlocked.current.has(records[0].importRecovery?.batchId ?? '')
    || !(confirmedImportBatch(records) && confirmedImportsReady.includes(records[0].importRecovery!.batchId))
      && !(deferredImportSubset(records) && deferredImportsReady.includes(records[0].importRecovery!.batchId)));
  const importNotice = Boolean(activeImports.length || visibleAttempt && (!visibleAttempt.records.length || !visibleAttempt.records.every(record => record.importRecovery?.deferredAt)));
  const visibleRecoveryRecords = recoveryRecords.filter(record => !isImportRecovery(record) && (!activeProjectId || record.project.id === activeProjectId));
  const currentFeedback = saveFeedback?.epoch === ownerEpoch.current && saveFeedback.projectId === activeProjectId ? saveFeedback : null;
  const saveMessage = currentFeedback?.message ?? '';
  const unsavedChanges = hasUnsavedDatabaseChangesNow();
  const currentDraftStatus = !activeProjectId || !draftStatus.projectId || draftStatus.projectId === activeProjectId ? draftStatus : null;
  const draftFailed = currentDraftStatus?.state === 'failed';
  const draftUnconfirmed = unsavedChanges && (!currentDraftStatus || currentDraftStatus.state === 'unconfirmed');
  const lockLost = (unsavedChanges || currentFeedback?.kind === 'lock-lost') && !collaboration.canEdit;
  const invalidRecovery = visibleRecoveryRecords.some(record => !validDraftRecord(record));
  const feedbackNeedsAttention = Boolean(currentFeedback && ['save-failed', 'restore-failed', 'restore-partial', 'recovery-required'].includes(currentFeedback.kind));
  const feedbackIsError = currentFeedback?.kind === 'save-failed' || currentFeedback?.kind === 'restore-failed' || currentFeedback?.kind === 'restore-partial';
  const noticeRequired = Boolean(importNotice || pendingSave || pendingRestore || draftFailed || draftUnconfirmed || lockLost || workspaceUnverified || invalidRecovery || feedbackNeedsAttention);
  const noticeError = draftFailed || lockLost || Boolean(pendingRestore?.projectConfirmed) || feedbackIsError;
  const downloadCurrentBackup = activeProject ? () => downloadProjectBackup([activeProject], 'unsaved_recovery') : null;
  const pendingActions = <>{/* Existing explicit handlers and edit/restore guards are unchanged. */}
        {pendingRestore && <>
          <button className="btn btn-secondary" disabled={restoringProject} data-testid="restore-check" onClick={() => resolveProjectRestore(pendingRestore.record)}>Check Restore Status</button>
          {!pendingRestore.projectConfirmed && <button className="btn btn-secondary" disabled={restoringProject || !collaboration.canEdit || Boolean(activeProjectId)} data-testid="restore-retry" onClick={() => resolveProjectRestore(pendingRestore.record, true)}>Retry This Restore</button>}
          <button className="btn btn-secondary" disabled={restoringProject} data-testid="restore-later" onClick={() => { setPendingRestore(null); reportSaveFeedback('recovery-deferred', 'The restore request is retained on this device. You can check its status later.'); }}>Check Later</button>
        </>}
        {pendingSave && <>
          <button className="btn btn-secondary" data-testid="save-check" onClick={() => void resolvePendingSave()}>Check Save Status</button>
          <button className="btn btn-secondary" disabled={!collaboration.canEdit} data-testid="save-retry" onClick={() => void resolvePendingSave(true)}>Retry This Save</button>
        </>}
  </>;
  const reliabilityUi: SaveRecoveryUi = {
    scopeKey: `${collaboration.sharingMode}:${collaboration.user?.id ?? 'local'}:${ownerEpoch.current}:${activeProjectId || 'list'}`,
    backup: downloadCurrentBackup,
    recoveryCount: visibleRecoveryRecords.length + visibleImports.length,
    severity: noticeRequired ? noticeError ? 'error' : 'warning' : 'none',
    collapsedStatus: unsavedChanges ? 'Unshared draft changes.' : saveStatus === 'savingProject' || saveStatus === 'savingRevision' ? 'Saving project…' : null,
    notice: noticeRequired ? <>
      <div className="save-reliability-messages" role={noticeError ? 'alert' : 'status'}>
        {importNotice && <p data-testid="import-save-message">{visibleAttempt?.message || 'A previous import needs verification. Import recovery is retained on this device.'}</p>}
        {feedbackNeedsAttention && <p>{saveMessage}</p>}
        {pendingSave && <p>The previous save result needs verification. Check Save Status before saving again.</p>}
        {pendingRestore && currentFeedback?.kind !== 'restore-partial' && <p>{pendingRestore.projectConfirmed ? 'The project is restored; the Trash update has not been verified.' : restoringProject ? 'Checking the restore. The original Trash item is retained.' : 'The restore result needs verification. Check Restore Status.'}</p>}
        {draftFailed && <p>{currentDraftStatus?.message || 'Local draft storage failed. Export a backup before closing this screen.'}</p>}
        {draftUnconfirmed && <p>The local draft has not been verified. Export a backup before closing this screen.</p>}
        {lockLost && <p>Edit access was lost. Current changes are not saved to shared data. Check the local draft status.</p>}
        {workspaceUnverified && <p>The shared workspace for local drafts could not be verified. Check the connection and export a backup.</p>}
        {invalidRecovery && <p>A local recovery draft could not be verified. Open Recovery and export the original draft for review.</p>}
      </div>
      <div className="toolbar save-reliability-actions">
        {importNotice && <>
          <button className="btn btn-secondary" data-testid="import-backup" onClick={() => downloadProjectBackup(visibleAttempt?.prepared ?? activeImports.flatMap(records => records.map(record => record.project)), 'import_recovery')}>Download Import Backup</button>
          {activeImports.map(records => <button key={records[0].key} className="btn btn-secondary" disabled={importBusy || !completeImportBatch(records)} onClick={() => void resolveImport(records)}>Check Import Status</button>)}
        </>}
        {pendingActions}
        {downloadCurrentBackup && <button type="button" className="btn btn-secondary" data-testid="reliability-backup" onClick={downloadCurrentBackup}>Download Backup</button>}
      </div>
    </> : null,
    panel: <>
      {visibleImports.map(records => {
        const first = records[0], batchId = first.importRecovery?.batchId;
        const deferred = deferredImportSubset(records);
        const confirmed = confirmedImportBatch(records) && confirmedImportsReady.includes(batchId ?? '');
        const detail = visibleAttempt?.batchId === batchId ? visibleAttempt : null;
        return <div key={first.key} className="recovery-record" data-testid="import-recovery-record">
          <p>{confirmed ? 'Verified import backup retained' : deferred ? 'Unverified import retained for later review' : 'Import needs verification'} — {first.importRecovery?.targetIds?.length ?? records.length} projects</p>
          {detail && <p role="status">{detail.message}</p>}
          {records.map(record => <p key={record.key}>{record.project.name}: {detail?.results?.[record.project.id] ?? (confirmed ? 'Previously verified in shared data' : 'Not verified')}</p>)}
          {!completeImportBatch(records) && <p role="alert">The complete import recovery could not be verified. Some projects may be missing and cannot be restored from this incomplete backup. Shared saving remains unverified. Export the original recovery for review.</p>}
          <button className="btn btn-secondary" onClick={() => downloadProjectBackup(detail?.prepared ?? records.map(record => record.project), 'import_recovery')}>Download Import Backup</button>
          <button className="btn btn-secondary" onClick={() => exportRecoveryBytes(detail ?? records)}>Export Original Import Recovery</button>
          <button className="btn btn-secondary" disabled={importBusy || !completeImportBatch(records)} onClick={() => void resolveImport(records)}>Check Import Status</button>
          {!confirmed && (!deferred || !deferredImportsReady.includes(batchId ?? '')) && <button className="btn btn-secondary" disabled={importBusy || !recoverableImportSubset(records)} onClick={() => void resolveImport(records, true)}>Keep Import Recovery and Load Shared Data</button>}
          <button className="btn btn-secondary" onClick={() => downloadProjectBackup(projects.filter(project => records.some(record => record.project.id === project.id)), 'latest_local_edits')}>Download Latest Edits</button>
        </div>;
      })}
      {visibleAttempt && !visibleImports.some(records => records[0].importRecovery?.batchId === visibleAttempt.batchId) && <div className="recovery-record">
        <p>{visibleAttempt.message}</p>
        <button className="btn btn-secondary" onClick={() => downloadProjectBackup(visibleAttempt.prepared, 'import_recovery')}>Download Import Backup</button>
        <button className="btn btn-secondary" onClick={() => exportRecoveryBytes(visibleAttempt)}>Export Original Import Recovery</button>
      </div>}
      {saveMessage && !feedbackNeedsAttention && <p role="status">{saveMessage}</p>}
      {(unsavedChanges || draftFailed) && <p>{currentDraftStatus?.message || 'Changes are not saved to shared data.'}</p>}
      {visibleRecoveryRecords.length === 0 && visibleImports.length === 0 && !visibleAttempt && <p>No local recovery drafts for this view.</p>}
      {visibleRecoveryRecords.map(record => (
        <div key={record.key} className="recovery-record" data-testid="recovery-record">
          <span>Draft for this user: {record.project.name} / {record.savedAt} </span>
          <button className="btn btn-secondary" data-testid="recovery-export-raw" onClick={() => exportRecoveryBytes(record)}>Export Original Draft</button>
          {!validDraftRecord(record) && <span role="alert">The draft structure could not be verified. Export the original draft for review.</span>}
          {validDraftRecord(record) && record.intent?.restore && <button className="btn btn-secondary" disabled={restoringProject} onClick={() => {
            setPendingRestore({ record, projectConfirmed: false }); reportSaveFeedback('recovery-required', 'A previous restore request is retained. Check Restore Status.');
          }}>Check Previous Restore</button>}
          {validDraftRecord(record) && record.intent && !record.intent.restore && <button className="btn btn-secondary" onClick={() => {
            if (!record.intent!.before) { reportSaveFeedback('recovery-required', 'The previous save baseline is incomplete. Export the draft and review the differences.'); return; }
            setPendingSave({ before: record.intent!.before, sent: record.intent!.project, expected: record.intent!.expectedUpdatedAt, draft: record, archived: true, forceOverwriteUpdatedAt: record.intent!.forceOverwriteUpdatedAt });
            reportSaveFeedback('recovery-required', 'A previous save request is retained. Check Save Status.');
          }}>Check Previous Save</button>}
          <button className="btn btn-secondary" data-testid="recovery-return-to-editor" disabled={!validDraftRecord(record) || Boolean(record.intent?.restore) || !collaboration.canEdit || activeProjectId !== record.project.id || !projects.some(project => project.id === record.project.id)} onClick={() => {
            const server = persistedProjects.current.get(record.project.id);
            if (!server || !record.baseUpdatedAt || server.updatedAt !== record.baseUpdatedAt) {
              reportSaveFeedback('recovery-required', 'Shared data has changed or the baseline is unknown. Export the draft and review the differences.'); return;
            }
            if (!window.confirm('Restore this draft to editing? It will not be saved to shared data yet.')) return;
            setProjects(latest => latest.map(project => project.id === record.project.id ? record.project : project));
            if (record.intent) setPendingSave({ before: record.intent.before, sent: record.intent.project, expected: record.intent.expectedUpdatedAt, draft: record, forceOverwriteUpdatedAt: record.intent.forceOverwriteUpdatedAt });
            reportSaveFeedback('draft-restored', 'The draft has been restored to editing. It is not saved to shared data.');
          }}>Restore Draft to Editing</button>
        </div>
      ))}
    </>,
  };
  if (loading) {
    return (
      <main className="app-shell">
        <section className="card card-padded fade-in">
          <p className="screen-empty">Loading projects.</p>
        </section>
      </main>
    );
  }

  if (loadError && projects.length === 0) {
    return (
      <main className="app-shell">
        <section className="card card-padded fade-in">
          <p className="screen-empty">{loadError}</p>
          <div className="toolbar" style={{ justifyContent: "center" }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            >
              Retry
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (activeProject) {
    return (
      <ProjectScreen
        project={activeProject}
        saveReceipt={saveReceipt}
        reliabilityUi={reliabilityUi}
        errorAppliesToView={feedbackIsError || draftFailed || pendingSave?.sent.id === activeProjectId || pendingRestore?.record.project.id === activeProjectId}
      hasUnsavedDatabaseChanges={hasUnsavedDatabaseChangesNow()}
      hasUnsavedCommonChanges={Boolean(persistedProjects.current.get(activeProject.id) && valuesDiffer(commonSnapshot(activeProject), commonSnapshot(persistedProjects.current.get(activeProject.id)!)))}
        hasUnsavedDatabaseChangesNow={hasUnsavedDatabaseChangesNow}
        onBackToProjects={handleBackToProjects}
        onUpdateProject={handleUpdateProject}
        onSaveProjectDraft={handleSaveProjectDraft}
        onSaveProjectRevision={handleSaveProjectRevision}
        onMoveRoomTypeToTrash={handleMoveRoomTypeToTrash}
        saveStatus={saveStatus}
        lastSavedAt={lastSavedAt}
        collaboration={collaboration}
        canEdit={collaboration.canEdit}
        onReadOnlyAction={collaboration.readOnlyMessage}
      />
    );
  }

  return (
    <ProjectListScreen
      projects={projects}
      trash={trash}
      onSelectProject={id => { if (!deletePending.current && !restoreInFlight.current && !pendingRestore) handleSelectProject(id); }}
      onCreateProject={handleCreateProject}
      onRenameProject={handleRenameProject}
      onDeleteProject={handleDeleteProject}
      onRestoreProject={handleRestoreProject}
      onRestoreRoomType={handleRestoreRoomType}
      onEmptyTrash={handleEmptyTrash}
      onExportProjects={handleExportProjects}
      onImportProjects={handleImportProjects}
      collaborationBar={collaborationBar}
      reliabilityUi={reliabilityUi}
      canEdit={collaboration.canEdit && !deletingProject && !restoringProject && !pendingRestore}
      canCreateProject={collaboration.canCreateProject && !deletingProject && !restoringProject && !pendingRestore}
      projectLocks={collaboration.locks ?? []}
    />
  );
}
