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
  renameProjectInDatabase,
  saveTrashToDatabase,
  deleteProjectToTrash,
  type CollaborationSaveIdentity,
} from "./lib/storage";
import ProjectListScreen from "./components/ProjectListScreen";
import ProjectScreen from "./components/ProjectScreen";
import CollaborationBar from "./components/CollaborationBar";
import { createAppId } from './lib/id';
import { useCollaboration } from "./lib/useCollaboration";
import { DEFAULT_CFS_ROW_ORDER } from "./lib/cfsRowDisplay";
import { hasProjectChanges, nextProjectEditTime, rebaseProjectSave, type ProjectSaveReceipt } from "./lib/projectSaveState";
import { archiveLegacyProjectDrafts, cachedDraftRecords, checkpointProject, checkpointProjectRestore, draftScope, resetProjectDrafts, validDraftRecord, exportRecoveryBytes, preserveRecoveryProject, DRAFT_STATUS_EVENT, getDraftStatus, initializeProjectDrafts, removeConfirmedDraft, type ProjectDraftRecord } from './lib/projectDraftStore';
import { finiteFetch, SaveProtocolError } from './lib/projectSaveProtocol';
import { appendCommonRevision, commonSnapshot } from './lib/projectCommonHistory';
import { valuesDiffer } from './lib/canonicalJson';

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
  if (!value) return "不明";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function projectSaveConflictSummary(project: ProjectData | undefined): string {
  if (!project) return "サーバー版: 取得できませんでした";
  return [
    `サーバー版: ${project.name}`,
    `更新日時: ${formatConflictTimestamp(project.updatedAt)}`,
    `Room Type数: ${project.roomTypes.length}`,
    `Circuit数: ${project.circuits.length}`,
  ].join("\n");
}

function chooseProjectSaveConflictAction(
  draftProject: ProjectData,
  serverProject: ProjectData | undefined,
): SaveConflictAction {
  const answer = window.prompt(
    [
      "この画面を開いた後に、他のユーザーがこのプロジェクトを保存しました。",
      "",
      `現在の下書き: ${draftProject.name}`,
      projectSaveConflictSummary(serverProject),
      "",
      "O: この下書きで上書きします（非推奨。相手の保存内容を消します）",
      "R: サーバー最新版を読み込みます",
      "B: この下書きをJSONバックアップとして保存し、編集を続けます",
      "Cancel: 保存せずに編集を続けます",
    ].join("\n"),
    "B",
  );
  if (answer === null) return "cancel";
  const normalized = answer.trim().toLowerCase();
  if (normalized === "o" || normalized === "overwrite") return "overwrite";
  if (normalized === "r" || normalized === "reload") return "reload";
  if (normalized === "b" || normalized === "backup") return "backup";
  window.alert("保存をキャンセルしました。O（上書き）、R（再読み込み）、B（バックアップ）のいずれかを入力してください。");
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
  const [saveMessage, setSaveMessage] = useState('');
  const [pendingSave, setPendingSave] = useState<{ before: ProjectData; sent: ProjectData; expected: string; draft: ProjectDraftRecord | null; archived?: boolean; forceOverwriteUpdatedAt?: string } | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{ record: ProjectDraftRecord; projectConfirmed: boolean } | null>(null);
  const restoreInFlight = useRef(false);
  const [restoringProject, setRestoringProject] = useState(false);
  const tabId = useRef(createAppId());
  const previousMode = useRef(collaboration.mode);
  const ownerEpoch = useRef(0);
  const activeProjectRef = useRef(activeProjectId);
  activeProjectRef.current = activeProjectId;

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
    explicitSavePending.current = false; setSaveStatus('idle');
    deletePending.current = false; setDeletingProject(false);
    restoreInFlight.current = false; setRestoringProject(false); setPendingRestore(null); trashSavesInFlight.current.clear();
    resetProjectDrafts();
    setPendingSave(null); setSaveReceipt(null); setRecoveryRecords([]); setSaveMessage('');
    if (collaboration.requiresSignIn) return;
    let cancelled = false;
    void (async () => {
      const config = await finiteFetch('/api/sharing/config', { cache: 'no-store' }, 10_000).then(response => response.json()).catch(() => null) as { url?: string } | null;
      if (cancelled) return;
      if (collaboration.sharingMode === 'supabase' && !config?.url) { setSaveMessage('退避先の共有環境を確認できません。接続を確認し、バックアップしてください。'); return; }
      const records = await initializeProjectDrafts({ workspace: `${collaboration.sharingMode}:${config?.url ?? window.location.origin}`,
        owner: collaboration.user?.id ?? 'local', tab: tabId.current });
      if (!cancelled) setRecoveryRecords(records);
      await archiveLegacyProjectDrafts().catch(() => undefined);
    })();
    return () => { cancelled = true; };
  }, [collaboration.authReady, collaboration.requiresSignIn, collaboration.sharingMode, collaboration.user?.id]);

  useEffect(() => {
    if (previousMode.current === 'edit' && collaboration.mode !== 'edit') {
      const project = projectsRef.current.find(item => item.id === activeProjectId);
      if (project && hasProjectChanges(project, persistedProjects.current.get(project.id))) {
        void checkpointProject(project, persistedProjectUpdatedAt.current.get(project.id) ?? null);
        setSaveMessage('編集権限を失いました。この画面の変更は共有未保存です。退避状況を確認してください。');
      }
    }
    previousMode.current = collaboration.mode;
  }, [collaboration.mode, activeProjectId]);

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
    if (epoch !== ownerEpoch.current || projectId !== activeProjectRef.current) throw new Error('編集対象または利用者が変更されました。');
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
      }); } catch (error) { throw Object.assign(error instanceof Error ? error : new Error('保存結果を確認できません。'), { forceOverwriteUpdatedAt }); }
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
        if (epoch !== ownerEpoch.current) throw new Error('利用者が変更されました。');
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

  const runProjectRestore = useCallback(async (record: ProjectDraftRecord, retry: boolean, epoch: number): Promise<void> => {
    const intent = record.intent;
    const restore = intent?.restore;
    const currentOwner = draftScope();
    const current = () => epoch === ownerEpoch.current && draftScope() === currentOwner;
    let saved: ProjectData | undefined;
    try {
      if (!validDraftRecord(record) || !intent || !restore || !currentOwner
        || record.scope.owner !== currentOwner.owner || record.scope.workspace !== currentOwner.workspace) throw new Error('復元要求の利用者と原本を確認できません。');
      const identity = { userId: collaboration.user?.id ?? '', sessionId: collaboration.sessionId,
        projectId: '', accessToken: collaboration.accessToken || undefined, requireLock: retry };
      if (retry && (!collaboration.canEdit || activeProjectRef.current)) throw new Error('一覧の編集権限を取得してから同じ復元を再送してください。');
      saved = retry && !restore.confirmedProject
        ? await saveProjectRestore(intent.project, identity)
        : await confirmProjectRestore(intent.project, identity, restore.confirmedProject);
      if (!current()) return;
      if (!saved) throw new Error('復元先の本文を確認できません。');
      if (!restore.confirmedProject) {
        const confirmedRecord = await checkpointProjectRestore(record.project, record.baseUpdatedAt ?? intent.before.updatedAt,
          { ...intent, restore: { ...restore, confirmedProject: saved } }, currentOwner);
        if (!current()) return;
        if (!confirmedRecord) throw new Error('復旧確認の端末退避が未確認です。Trash原本を保持します。');
        record = confirmedRecord;
      }
      setPendingRestore({ record, projectConfirmed: true });
      if (!collaboration.canEdit || activeProjectRef.current) throw new Error('Trash更新には一覧の編集権限が必要です。');
      if (trashSaveTimer.current || trashSavesInFlight.current.size) throw new Error('別のTrash更新が進行中です。完了後に再確認してください。');
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
      setSaveMessage('ProjectとTrashの復元結果を確認しました。');
      setSaveStatus('projectSaved');
      setLastSavedAt(formatStatusTime());
    } catch (error) {
      if (!current()) return;
      const detail = error instanceof SaveProtocolError ? `${error.message} (${error.code}${error.status ? ` / HTTP ${error.status}` : ''})` : error instanceof Error ? error.message : '保存先を確認してください。';
      setPendingRestore({ record, projectConfirmed: Boolean(saved) });
      setSaveStatus('error');
      setSaveMessage(saved ? `本体は復旧済み、Trash更新は未確認です。${detail}` : `復元を確認できません。元のTrashと復元要求は保持しています。${detail}`);
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
  }, [collaboration.accessToken, collaboration.canEdit, collaboration.sessionId, collaboration.user?.id, rememberPersistedProject, setProjects]);

  const resolveProjectRestore = (record: ProjectDraftRecord, retry = false): void => {
    if (restoreInFlight.current || (retry && (!requireEditMode() || activeProjectRef.current))) return;
    restoreInFlight.current = true;
    setRestoringProject(true);
    setSaveMessage('復元先を確認しています。');
    void runProjectRestore(record, retry, ownerEpoch.current);
  };

  const handleRestoreProject = useCallback(
    (trashItemId: string): void => {
      if (!requireEditMode()) return;
      if (restoreInFlight.current || pendingRestore) return;
      if (trashSaveTimer.current || trashSavesInFlight.current.size) { setSaveMessage('Trash更新中です。完了後に復元してください。'); return; }
      const item = trash.projects.find((candidate) => candidate.id === trashItemId);
      if (!item) return;
      const previous = cachedDraftRecords().filter(record => validDraftRecord(record) && record.intent?.restore?.trashItemId === trashItemId)
        .sort((a, b) => b.generation - a.generation)[0];
      if (previous) { setPendingRestore({ record: previous, projectConfirmed: false }); setSaveMessage('以前の復元要求を保持しています。復元状態を確認してください。'); return; }
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
      setSaveMessage('復元要求をこの端末に退避しています。確認が終わるまでTrashを保持します。');
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
        if (!record) throw new Error('復元要求の端末退避を確認できません。Trash原本は保持しています。');
        setPendingRestore({ record, projectConfirmed: false });
        setRecoveryRecords(cachedDraftRecords());
        await runProjectRestore(record, true, epoch);
      })().catch(error => {
        if (epoch !== ownerEpoch.current) return;
        setSaveMessage(`復元を確認できません。${error instanceof Error ? error.message : '原文を保持しています。'}`);
        setSaveStatus('error');
      }).finally(() => { if (epoch === ownerEpoch.current) { restoreInFlight.current = false; setRestoringProject(false); } });
    },
    [collaboration.editIdentity, pendingRestore, projects, requireEditMode, trash, runProjectRestore],
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

  const handleImportProjects = useCallback((file: File): void => {
    if (!requireEditMode()) return;
    const epoch = ownerEpoch.current;
    const maxBytes = 50 * 1024 * 1024;
    if (file.size > maxBytes) {
      window.alert("Import file must be 50 MB or smaller.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (epoch !== ownerEpoch.current) return;
      try {
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

        const existingById = new Map(projects.map((project) => [project.id, project]));
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
          const smallerWarnings = projects
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

          const merged = projects.map((project) => importedById.get(project.id) ?? project);
          const next = [...newProjects, ...merged];
          skipNextSave.current = true;
          setProjects(next);
          void saveProjectsToDatabase(importedForUpdate, { collaboration: collaboration.editIdentity,
            expectedUpdatedAts: Object.fromEntries(importedForUpdate.map(project => [project.id, persistedProjectUpdatedAt.current.get(project.id) ?? null])),
          })
            .then((savedProjects) => { if (epoch === ownerEpoch.current) savedProjects.forEach(rememberPersistedProject); })
            .catch(() => undefined);
          return;
        }

        const usedNames = new Set(projects.map((project) => project.name));
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

        const next = [...copiedProjects, ...newProjects, ...projects];
        skipNextSave.current = true;
        setProjects(next);
        void saveProjectsToDatabase([...copiedProjects, ...newProjects], { collaboration: collaboration.editIdentity,
          expectedUpdatedAts: Object.fromEntries([...copiedProjects, ...newProjects].map(project => [project.id, null])),
        })
          .then((savedProjects) => { if (epoch === ownerEpoch.current) savedProjects.forEach(rememberPersistedProject); })
          .catch(() => undefined);
      } catch (error) {
        console.error("Failed to import project data.", error);
        window.alert("Failed to import the selected file. Check that it is a valid JSON or QJSON backup.");
      }
    };
    reader.onerror = () => {
      window.alert("Failed to read the selected file.");
    };
    reader.readAsText(file, "utf-8");
  }, [projects, requireEditMode, collaboration.editIdentity, rememberPersistedProject, setProjects]);

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
      if (!requireEditMode() || explicitSavePending.current) return false;
      if (pendingSave) { setSaveMessage('先の保存結果を確認してから次の保存を行ってください。'); return false; }
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
      catch (error) { setSaveMessage(error instanceof Error ? error.message : '保存内容を作成できません。元データを確認してください。'); setSaveStatus('error'); return false; }
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
      setSaveMessage('保存先へ送信しています…');
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
          setSaveMessage(`${error.message} (${error.code}${error.status ? ` / HTTP ${error.status}` : ''})`);
          if (error.unknown) setPendingSave({ before: currentProject, sent: projectToSave, expected: expectedUpdatedAt, draft });
        } else if (!isProjectSaveConflictError(error)) {
          setSaveMessage('保存に失敗しました。下書きを保持して接続と編集権限を確認してください。');
        }
        try {
          savedProject = await recoverProjectSaveConflict(error, projectToSave, next, expectedUpdatedAt, revisionSaveIdentity);
        } catch (recoveryError) {
          if (epoch !== ownerEpoch.current) return false;
          if (recoveryError instanceof SaveProtocolError && recoveryError.unknown) {
            const forceOverwriteUpdatedAt = (recoveryError as SaveProtocolError & { forceOverwriteUpdatedAt?: string }).forceOverwriteUpdatedAt;
            intent = { ...intent, forceOverwriteUpdatedAt };
            setPendingSave({ before: currentProject, sent: projectToSave, expected: expectedUpdatedAt, draft, forceOverwriteUpdatedAt });
            setSaveMessage(`${recoveryError.message} (${recoveryError.code}${recoveryError.status ? ` / HTTP ${recoveryError.status}` : ''})`);
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
      setSaveMessage('保存先の内容を確認しました。');
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
        if (epoch === ownerEpoch.current) { setSaveStatus('error'); setSaveMessage(error instanceof Error ? error.message : '保存を開始できません。バックアップしてください。'); }
        return false;
      } finally { if (epoch === ownerEpoch.current) explicitSavePending.current = false; }
    },
    [activeProjectId, requireEditMode, collaboration, rememberPersistedProject, recoverProjectSaveConflict, setProjects, pendingSave],
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
    if (!pendingSave || explicitSavePending.current) return;
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
        setSaveMessage('以前の保存を確認しました。追加入力は退避に保持しています。編集権限を取得し、退避を編集へ戻してください。');
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
      setSaveMessage('保存先の内容を確認しました。');
    } catch (error) {
      if (epoch !== ownerEpoch.current) return;
      setSaveMessage(error instanceof SaveProtocolError ? `${error.message} (${error.code}${error.status ? ` / HTTP ${error.status}` : ''})` : '保存結果をまだ確認できません。退避は保持しています。');
    } finally { if (epoch === ownerEpoch.current) explicitSavePending.current = false; }
  };

  const reliabilityNotice = (
    <section className="card" aria-label="保存と下書きの状態" style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minHeight: 42 }}>
      {saveMessage && <p role="status" style={{ margin: 0 }}>{saveMessage}</p>}
      {(hasUnsavedDatabaseChangesNow() || draftStatus.state === 'failed') && <p style={{ margin: 0 }} role={draftStatus.state === 'failed' ? 'alert' : 'status'}>{draftStatus.message || '変更は共有未保存です。'}</p>}
      <div className="toolbar" style={{ margin: 0 }}>
        {pendingRestore && <>
          <button className="btn btn-secondary" disabled={restoringProject} onClick={() => resolveProjectRestore(pendingRestore.record)}>復元状態を確認</button>
          {!pendingRestore.projectConfirmed && <button className="btn btn-secondary" disabled={restoringProject || !collaboration.canEdit || Boolean(activeProjectId)} onClick={() => resolveProjectRestore(pendingRestore.record, true)}>同じ復元を再送</button>}
          <button className="btn btn-secondary" disabled={restoringProject} onClick={() => { setPendingRestore(null); setSaveMessage('復元要求をこの端末に保持しました。後で復元状態を確認できます。'); }}>後で確認</button>
        </>}
        {pendingSave && <>
          <button className="btn btn-secondary" onClick={() => void resolvePendingSave()}>保存状態を確認</button>
          <button className="btn btn-secondary" disabled={!collaboration.canEdit} onClick={() => void resolvePendingSave(true)}>同じ保存を再送</button>
        </>}
        {activeProject && <button className="btn btn-secondary" onClick={() => downloadProjectBackup([activeProject], 'unsaved_recovery')}>現在の内容をバックアップ</button>}
      </div>
      {recoveryRecords.filter(record => !activeProjectId || record.project.id === activeProjectId).map(record => (
        <div key={record.key} style={{ width: '100%', marginTop: 4 }}>
          <span>この利用者の退避: {record.project.name} / {record.savedAt} </span>
          <button className="btn btn-secondary" onClick={() => exportRecoveryBytes(record)}>退避を原文で出力</button>
          {!validDraftRecord(record) && <span role="alert">退避の構造を確認できません。原文を出力して確認してください。</span>}
          {validDraftRecord(record) && record.intent?.restore && <button className="btn btn-secondary" disabled={restoringProject} onClick={() => {
            setPendingRestore({ record, projectConfirmed: false }); setSaveMessage('以前の復元要求を保持しています。復元状態を確認してください。');
          }}>以前の復元を確認</button>}
          {validDraftRecord(record) && record.intent && !record.intent.restore && <button className="btn btn-secondary" onClick={() => {
            if (!record.intent!.before) { setSaveMessage('以前の保存基準が不足しています。退避を出力して差分を確認してください。'); return; }
            setPendingSave({ before: record.intent!.before, sent: record.intent!.project, expected: record.intent!.expectedUpdatedAt, draft: record, archived: true, forceOverwriteUpdatedAt: record.intent!.forceOverwriteUpdatedAt });
            setSaveMessage('以前の保存要求を保持しています。保存状態を確認してください。');
          }}>以前の保存を確認</button>}
          <button className="btn btn-secondary" disabled={!validDraftRecord(record) || Boolean(record.intent?.restore) || !collaboration.canEdit || activeProjectId !== record.project.id || !projects.some(project => project.id === record.project.id)} onClick={() => {
            const server = persistedProjects.current.get(record.project.id);
            if (!server || !record.baseUpdatedAt || server.updatedAt !== record.baseUpdatedAt) {
              setSaveMessage('共有データが変更済みか基準が不明です。退避を出力して差分を確認してください。'); return;
            }
            if (!window.confirm('この退避を編集内容へ戻します。共有保存はまだ行いません。')) return;
            setProjects(latest => latest.map(project => project.id === record.project.id ? record.project : project));
            if (record.intent) setPendingSave({ before: record.intent.before, sent: record.intent.project, expected: record.intent.expectedUpdatedAt, draft: record, forceOverwriteUpdatedAt: record.intent.forceOverwriteUpdatedAt });
            setSaveMessage('退避を編集内容へ戻しました。共有未保存です。');
          }}>退避を編集へ戻す</button>
        </div>
      ))}
    </section>
  );

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
        reliabilityNotice={reliabilityNotice}
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
      collaborationBar={<>{collaborationBar}{reliabilityNotice}</>}
      canEdit={collaboration.canEdit && !deletingProject && !restoringProject && !pendingRestore}
      canCreateProject={collaboration.canCreateProject && !deletingProject && !restoringProject && !pendingRestore}
      projectLocks={collaboration.locks ?? []}
    />
  );
}
