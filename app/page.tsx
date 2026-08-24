"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ProjectData, RoomType, TrashData } from "./types";
import {
  createNewProject,
  downloadProjectBackup,
  emptyTrashData,
  clearProjectDrafts,
  loadProjectDrafts,
  loadProjects,
  loadProjectsFromDatabase,
  loadTrash,
  loadTrashFromDatabase,
  migrateProjectsPayload,
  isProjectSaveConflictError,
  saveProjectToDatabase,
  saveProjectsDraftLocally,
  saveProjectsToDatabase,
  saveTrashToDatabase,
  type CollaborationSaveIdentity,
} from "./lib/storage";
import ProjectListScreen from "./components/ProjectListScreen";
import ProjectScreen from "./components/ProjectScreen";
import CollaborationBar from "./components/CollaborationBar";
import { createAppId } from './lib/id';
import { useCollaboration } from "./lib/useCollaboration";
import { DEFAULT_CFS_ROW_ORDER } from "./lib/cfsRowDisplay";

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

// Browser drafts for projects that exist on the server but carry a newer
// updatedAt. In shared (supabase) mode these are never adopted silently:
// a tab with a stale base keeps a "newer" draft forever and resurrecting it
// overwrote other users' saves (incident 2026-08-24).
function newerLocalDraftsThan(serverProjects: ProjectData[]): ProjectData[] {
  try {
    const drafts = loadProjectDrafts();
    if (drafts.length === 0) return [];
    const serverById = new Map(serverProjects.map((project) => [project.id, project]));
    return drafts.filter((draft) => {
      const server = serverById.get(draft.id);
      if (!server) return false;
      const serverTime = Date.parse(server.updatedAt ?? "");
      const draftTime = Date.parse(draft.updatedAt ?? "");
      return Number.isFinite(draftTime) && (!Number.isFinite(serverTime) || draftTime > serverTime);
    });
  } catch {
    return [];
  }
}

function mergeNewerLocalDrafts(serverProjects: ProjectData[]): ProjectData[] {
  try {
    const drafts = loadProjectDrafts();
    if (drafts.length === 0) return serverProjects;
    const draftById = new Map(drafts.map((draft) => [draft.id, draft]));
    return serverProjects.map((project) => {
      const draft = draftById.get(project.id);
      if (!draft) return project;
      const serverTime = Date.parse(project.updatedAt ?? "");
      const draftTime = Date.parse(draft.updatedAt ?? "");
      const draftIsNewer =
        Number.isFinite(draftTime) && (!Number.isFinite(serverTime) || draftTime > serverTime);
      return draftIsNewer ? draft : project;
    });
  } catch {
    return serverProjects;
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
  const [projects, setProjects] = useState<ProjectData[]>([]);
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
  const skipNextSave = useRef(false);
  const skipNextTrashSave = useRef(false);
  const collaborationAccessTokenRef = useRef(collaboration.accessToken);
  const trashSaveIdentity = useRef(collaboration.editIdentity);
  const persistedProjectUpdatedAt = useRef<Map<string, string>>(new Map());

  const rememberPersistedProjects = useCallback((nextProjects: ReadonlyArray<ProjectData>): void => {
    persistedProjectUpdatedAt.current = new Map(nextProjects.map((project) => [project.id, project.updatedAt]));
  }, []);

  const rememberPersistedProject = useCallback((project: ProjectData): void => {
    persistedProjectUpdatedAt.current.set(project.id, project.updatedAt);
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
      const staleDrafts = newerLocalDraftsThan(loaded);
      if (staleDrafts.length > 0) {
        downloadProjectBackup(staleDrafts, "unsaved_browser_draft");
        clearProjectDrafts();
        window.alert(
          "Unsaved browser drafts from a previous session were found. They were downloaded as a backup file and the screen now shows the latest shared data. Use Import Data if you need to restore the backup.",
        );
      }
      setProjects(loaded);
    } else {
      // Local mode: keep browser-draft copies that are newer than the
      // server snapshot so a reload does not discard unsaved edits.
      setProjects(mergeNewerLocalDrafts(loaded));
    }
    setTrash(loadedTrash);
  }, [rememberPersistedProjects]);

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
        const localDrafts = loadProjectDrafts();
        const localProjects = localDrafts.length > 0 ? localDrafts : loadProjects();
        const localTrash = loadTrash();
        skipNextTrashSave.current = true;
        persistedProjectUpdatedAt.current = new Map();
        setTrash(localTrash);
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
    collaboration.sharingMode,
    applyLoadedServerState,
    loadAttempt,
  ]);

  useEffect(() => {
    if (!initialized.current) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    if (collaboration.sharingMode === "supabase") {
      // Shared mode never auto-uploads drafts to the shared DB (see
      // docs/SUPABASE_REVISION_SYNC.md), but the draft must still survive a
      // project reload triggered by transient auth churn. Persist it to the
      // browser silently; the save-status UI stays driven by explicit saves.
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        try {
          saveProjectsDraftLocally(projects);
        } catch {
          // Browser draft persistence is best-effort.
        }
        saveTimer.current = null;
      }, 1200);
      return () => {
        if (saveTimer.current) {
          clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
      };
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveStatus("savingDraft");
    saveTimer.current = setTimeout(async () => {
      try {
        const draftSaved = saveProjectsDraftLocally(projects);
        setSaveStatus(draftSaved ? "draftSaved" : "idle");
        if (draftSaved) {
          setLastSavedAt(formatStatusTime());
        }
      } catch {
        setSaveStatus("error");
      }
      saveTimer.current = null;
    }, 1200);

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
    trashSaveTimer.current = setTimeout(() => {
      void saveTrashToDatabase(trash, {
        notifyOnError: true,
        collaboration: scheduledCollaboration,
      }).catch(() => {
        setSaveStatus("error");
      });
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

      saveProjectsDraftLocally(nextProjects);

      let latestProjects: ProjectData[];
      try {
        latestProjects = await loadProjectsFromDatabase({
          accessToken: saveIdentity?.accessToken,
          secureSharing: true,
          throwOnError: true,
        });
      } catch (loadError) {
        console.error("Failed to load latest project after save conflict.", loadError);
        window.alert(
          "The project has a newer server version, but CFS could not load it. The current draft is still open and was kept as a browser draft. Export a backup before closing this page.",
        );
        return null;
      }

      const serverProject = latestProjects.find((candidate) => candidate.id === projectToSave.id) ?? error.serverProject;
      const action = chooseProjectSaveConflictAction(projectToSave, serverProject);
      const backupPrefix = `${projectToSave.name}_unsaved_conflict_draft`;

      if (action === "backup") {
        downloadProjectBackup([projectToSave], backupPrefix);
        return null;
      }

      if (action === "reload") {
        downloadProjectBackup([projectToSave], backupPrefix);
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

      downloadProjectBackup([projectToSave], backupPrefix);
      return saveProjectToDatabase(projectToSave, nextProjects, {
        expectedUpdatedAt,
        forceOverwrite: true,
        forceOverwriteUpdatedAt,
        notifyOnError: false,
        collaboration: saveIdentity,
      });
    },
    [rememberPersistedProjects],
  );

  const persistProjectListSnapshot = useCallback(
    (nextProjects: ProjectData[], nextTrash?: TrashData): void => {
      setSaveStatus("savingDraft");
      void (async () => {
        const savedProjects = await saveProjectsToDatabase(nextProjects, {
          notifyOnError: true,
          collaboration: collaboration.editIdentity,
        });
        rememberPersistedProjects(savedProjects);
        if (nextTrash) {
          await saveTrashToDatabase(nextTrash, {
            notifyOnError: true,
            collaboration: collaboration.editIdentity,
          });
        }
        setSaveStatus("draftSaved");
        setLastSavedAt(formatStatusTime());
      })().catch(() => {
        if (collaboration.sharingMode !== "supabase") {
          saveProjectsDraftLocally(nextProjects);
        }
        setSaveStatus("error");
      });
    },
    [collaboration.editIdentity, collaboration.sharingMode, rememberPersistedProjects],
  );

  const handleCreateProject = useCallback((name: string): void => {
    if (!collaboration.canCreateProject) {
      collaboration.readOnlyMessage();
      return;
    }
    const project = createNewProject(name);
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
        console.error("Failed to create project.", error);
        window.alert(error instanceof Error ? error.message : "Failed to create project.");
        setSaveStatus("error");
      });
  }, [collaboration, projects, rememberPersistedProject]);

  const handleRenameProject = useCallback((id: string, newName: string): void => {
    if (!requireEditMode()) return;
    // Shared mode has no list autosave (the effect early-returns for
    // supabase), so persist explicitly like delete/restore do; otherwise the
    // rename only changes local state and reverts on reload.
    const nextProjects = projects.map((p) =>
      p.id === id
        ? { ...p, name: newName, updatedAt: new Date().toISOString() }
        : p,
    );
    skipNextSave.current = true;
    setProjects(nextProjects);
    persistProjectListSnapshot(nextProjects);
  }, [persistProjectListSnapshot, projects, requireEditMode]);

  const handleDeleteProject = useCallback(
    (id: string): void => {
      if (!requireEditMode()) return;
      const project = projects.find((p) => p.id === id);
      if (!project) return;
      if (
        !window.confirm(
          `Move project "${project.name}" to Trash?\n\nIt will be permanently deleted only when you empty Trash.`,
        )
      ) {
        return;
      }
      const deletedAt = new Date().toISOString();
      const nextTrash = {
        ...trash,
        projects: [
          {
            id: createAppId(),
            deletedAt,
            project: cloneData(project),
          },
          ...trash.projects,
        ],
      };
      const nextProjects = projects.filter((p) => p.id !== id);
      skipNextSave.current = true;
      skipNextTrashSave.current = true;
      setTrash(nextTrash);
      setProjects(nextProjects);
      persistProjectListSnapshot(nextProjects, nextTrash);
      setActiveProjectId((current) => {
        if (current !== id) return current;
        writeStoredActiveProjectId("");
        return "";
      });
    },
    [persistProjectListSnapshot, projects, requireEditMode, trash],
  );

  const handleRestoreProject = useCallback(
    (trashItemId: string): void => {
      if (!requireEditMode()) return;
      const item = trash.projects.find((candidate) => candidate.id === trashItemId);
      if (!item) return;
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
      const nextProjects = [restored, ...projects];
      const nextTrash = {
        ...trash,
        projects: trash.projects.filter((candidate) => candidate.id !== trashItemId),
      };
      skipNextSave.current = true;
      skipNextTrashSave.current = true;
      setProjects(nextProjects);
      setTrash(nextTrash);
      persistProjectListSnapshot(nextProjects, nextTrash);
    },
    [persistProjectListSnapshot, projects, requireEditMode, trash],
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
      persistProjectListSnapshot(nextProjects, nextTrash);
    },
    [persistProjectListSnapshot, projects, requireEditMode, trash],
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
    const maxBytes = 50 * 1024 * 1024;
    if (file.size > maxBytes) {
      window.alert("Import file must be 50 MB or smaller.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
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
          void saveProjectsToDatabase(next, { collaboration: collaboration.editIdentity })
            .then((savedProjects) => rememberPersistedProjects(savedProjects))
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
        void saveProjectsToDatabase(next, { collaboration: collaboration.editIdentity })
          .then((savedProjects) => rememberPersistedProjects(savedProjects))
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
  }, [projects, requireEditMode, collaboration.editIdentity, rememberPersistedProjects]);

  const handleUpdateProject = useCallback(
    (mutate: (project: ProjectData) => ProjectData): void => {
      if (!requireEditMode()) return;
      setProjects((current) =>
        current.map((p) =>
          p.id === activeProjectId
            ? { ...mutate(p), updatedAt: new Date().toISOString() }
            : p,
        ),
      );
    },
    [activeProjectId, requireEditMode],
  );

  const handleSaveProjectRevision = useCallback(
    async (mutate: (project: ProjectData) => ProjectData | null): Promise<boolean> => {
      if (!requireEditMode()) return false;
      const currentProject = projects.find((project) => project.id === activeProjectId);
      if (!currentProject) return false;
      const expectedUpdatedAt = persistedProjectUpdatedAt.current.get(currentProject.id);
      if (!expectedUpdatedAt) {
        window.alert("This project was loaded from a browser draft or an unknown database state. Reload the project list before saving a revision.");
        setSaveStatus("error");
        return false;
      }
      const savedAt = new Date().toISOString();
      const editor = collaboration.editorInfo
        ? { ...collaboration.editorInfo, updatedAt: savedAt }
        : null;
      const mutated = mutate(currentProject);
      if (!mutated) return false;
      const projectToSave: ProjectData = {
        ...mutated,
        updatedAt: savedAt,
        lastUpdatedBy: editor ?? currentProject.lastUpdatedBy ?? null,
      };
      const next = projects.map((p) =>
        p.id === activeProjectId ? projectToSave : p,
      );
      setSaveStatus("savingRevision");
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
        try {
          savedProject = await recoverProjectSaveConflict(error, projectToSave, next, expectedUpdatedAt, revisionSaveIdentity);
        } catch (recoveryError) {
          console.error("Failed to recover from project revision save conflict.", recoveryError);
        }
      }
      if (!savedProject) {
        if (collaboration.sharingMode !== "supabase") {
          saveProjectsDraftLocally(next);
        }
        setSaveStatus("error");
        return false;
      }
      rememberPersistedProject(savedProject);
      skipNextSave.current = true;
      setProjects((latest) =>
        latest.map((candidate) => (candidate.id === savedProject.id ? savedProject : candidate)),
      );
      await collaboration.refreshStatus().catch(() => undefined);
      setSaveStatus("revisionSaved");
      setLastSavedAt(formatStatusTime());
      return true;
    },
    [activeProjectId, projects, requireEditMode, collaboration, rememberPersistedProject, recoverProjectSaveConflict],
  );

  const handleSaveProjectDraft = useCallback(
    async (mutate: (project: ProjectData) => ProjectData | null): Promise<boolean> => {
      if (!requireEditMode()) return false;
      const currentProject = projects.find((project) => project.id === activeProjectId);
      if (!currentProject) return false;
      const expectedUpdatedAt = persistedProjectUpdatedAt.current.get(currentProject.id);
      if (!expectedUpdatedAt) {
        window.alert("This project was loaded from a browser draft or an unknown database state. Reload the project list before saving.");
        setSaveStatus("error");
        return false;
      }
      const savedAt = new Date().toISOString();
      const editor = collaboration.editorInfo
        ? { ...collaboration.editorInfo, updatedAt: savedAt }
        : null;
      const mutated = mutate(currentProject);
      if (!mutated) return false;
      const projectToSave: ProjectData = {
        ...mutated,
        updatedAt: savedAt,
        lastUpdatedBy: editor ?? currentProject.lastUpdatedBy ?? null,
      };
      const next = projects.map((p) =>
        p.id === activeProjectId ? projectToSave : p,
      );
      setSaveStatus("savingProject");
      const draftSaveIdentity = collaboration.editIdentity
        ? { ...collaboration.editIdentity, projectId: projectToSave.id }
        : undefined;
      let savedProject: ProjectData | null = null;
      try {
        savedProject = await saveProjectToDatabase(projectToSave, next, {
          expectedUpdatedAt,
          notifyOnError: false,
          collaboration: draftSaveIdentity,
        });
      } catch (error) {
        try {
          savedProject = await recoverProjectSaveConflict(error, projectToSave, next, expectedUpdatedAt, draftSaveIdentity);
        } catch (recoveryError) {
          console.error("Failed to recover from project draft save conflict.", recoveryError);
        }
      }
      if (!savedProject) {
        if (collaboration.sharingMode !== "supabase") {
          saveProjectsDraftLocally(next);
        }
        setSaveStatus("error");
        return false;
      }
      rememberPersistedProject(savedProject);
      skipNextSave.current = true;
      setProjects((latest) =>
        latest.map((candidate) => (candidate.id === savedProject.id ? savedProject : candidate)),
      );
      await collaboration.refreshStatus().catch(() => undefined);
      setSaveStatus("projectSaved");
      setLastSavedAt(formatStatusTime());
      return true;
    },
    [activeProjectId, projects, requireEditMode, collaboration, rememberPersistedProject, recoverProjectSaveConflict],
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
      onSelectProject={handleSelectProject}
      onCreateProject={handleCreateProject}
      onRenameProject={handleRenameProject}
      onDeleteProject={handleDeleteProject}
      onRestoreProject={handleRestoreProject}
      onRestoreRoomType={handleRestoreRoomType}
      onEmptyTrash={handleEmptyTrash}
      onExportProjects={handleExportProjects}
      onImportProjects={handleImportProjects}
      collaborationBar={collaborationBar}
      canEdit={collaboration.canEdit}
      canCreateProject={collaboration.canCreateProject}
      projectLocks={collaboration.locks ?? []}
    />
  );
}
