"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CfsCircuit,
  CfsRowDisplaySettings,
  CircuitEntry,
  BacklightLevelSetting,
  CurtainAssignment,
  DeviceAssignment,
  DryContactEntry,
  FixtureMaster,
  HvacAssignment,
  HvacSeason,
  InspectionMark,
  LocationMaster,
  PduDeviceCount,
  ProgrammingNameSettings,
  ProjectData,
  ProjectTab,
  RoomType,
  RoomTypeRevision,
  RoomScene,
  RoomsSubTab,
  Scene,
  SwitchEntry,
  SwitchKind,
  RevisionFieldChanges,
} from "../types";
import {
  backlightLevelsFromSwitches,
  createDefaultCfsRowDisplaySettings,
  createNewRoomType,
  RESERVED_VALUE,
} from "../lib/constants";
import { downloadProjectBackup } from "../lib/storage";
import { useAppSettings } from "../lib/appSettings";
import { useGridArrowNavigation } from "../lib/useGridArrowNavigation";
import { buildProjectCircuitSuggestions } from "../lib/projectCircuitSuggestions";
import { duplicateRoomType } from "../lib/roomTypeCopy";
import { cfsWindowChannelName, type CfsWindowMessage, type CfsWindowSnapshot } from "../lib/cfsWindowSync";
import { circuitsForRoomType, inferRoomTypeCircuitIds, normalizeProjectRoomTypeCircuitIds, syncProjectRoomTypeLinks } from "../lib/roomTypeSync";
import TabsBar, { type TabDef } from "./TabsBar";
import LocationsView from "./LocationsView";
import FixturesView from "./FixturesView";
import DeviceAssignView from "./DeviceAssignView";
import RoomsView from "./RoomsView";
import CircuitsView from "./CircuitsView";
import SceneView from "./SceneView";
import RoomSceneView from "./RoomSceneView";
import CfsView, {
  type InspectionCompletionOptions,
  type InspectionCompletionPayload,
  type InspectionRevisionTarget,
  type InspectionRevisionChoice,
} from "./CfsView";
import CfsErrorBoundary from "./CfsErrorBoundary";
import SwitchView from "./SwitchView";
import CommandView from "./CommandView";
import BacklightView from "./BacklightView";
import PduView from "./PduView";
import LutronSpecView from "./LutronSpecView";
import CollaborationBar from "./CollaborationBar";
import { ActionIcon } from "./ActionIconButton";
import { createAppId } from '../lib/id';
import type { CollaborationController } from "../lib/useCollaboration";

const ROOM_TYPE_MANAGE_ID = "__manage__";
const HISTORY_LIMIT = 50;
const PROJECT_NAV_STORAGE_PREFIX = "cfs-project-navigation-v1:";
const IDLE_AUTO_SAVE_REVISION_NOTE = "Auto-saved draft after 15 minutes idle.";

const VALID_PROJECT_TABS: readonly ProjectTab[] = ["area", "fixture", "rooms"];
const VALID_ROOM_SUB_TABS: readonly RoomsSubTab[] = [
  "circuit",
  "deviceAssign",
  "areaScene",
  "scene",
  "switch",
  "command",
  "backlight",
  "cfs",
  "pdu",
];

interface StoredProjectNavigation {
  activeTab?: ProjectTab;
  activeSubTab?: RoomsSubTab;
  activeRoomTypeId?: string;
}

function isProjectTab(value: unknown): value is ProjectTab {
  return typeof value === "string" && VALID_PROJECT_TABS.includes(value as ProjectTab);
}

function isRoomsSubTab(value: unknown): value is RoomsSubTab {
  return typeof value === "string" && VALID_ROOM_SUB_TABS.includes(value as RoomsSubTab);
}

function projectNavStorageKey(projectId: string): string {
  return `${PROJECT_NAV_STORAGE_PREFIX}${projectId}`;
}

function readStoredProjectNavigation(
  projectId: string,
  validRoomTypeIds: ReadonlySet<string>,
): StoredProjectNavigation {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(projectNavStorageKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const roomTypeId = typeof parsed.activeRoomTypeId === "string" ? parsed.activeRoomTypeId : "";
    return {
      activeTab: isProjectTab(parsed.activeTab) ? parsed.activeTab : undefined,
      activeSubTab: isRoomsSubTab(parsed.activeSubTab) ? parsed.activeSubTab : undefined,
      activeRoomTypeId: validRoomTypeIds.has(roomTypeId) ? roomTypeId : "",
    };
  } catch {
    return {};
  }
}

function writeStoredProjectNavigation(projectId: string, navigation: StoredProjectNavigation): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(projectNavStorageKey(projectId), JSON.stringify(navigation));
  } catch {
    // Navigation restore is best-effort and should not block project editing.
  }
}

function isCcoAssignment(assignment: DeviceAssignment): boolean {
  return /^CCO/i.test(assignment.zoneAddress.trim().replace(/^\d+-/, ""));
}

function inferDryContactsFromAssignments(assignments: readonly DeviceAssignment[] = []): DryContactEntry[] {
  const byKey = new Map<string, DryContactEntry>();
  for (const assignment of assignments) {
    if (!isCcoAssignment(assignment)) continue;
    const assigned = assignment.circuitNumber.trim();
    const detail = assignment.detail.trim();
    const circuit = assigned && assigned !== RESERVED_VALUE ? assigned : detail;
    if (!circuit) continue;
    const key = [assignment.area ?? "", circuit, detail].join("\u0000").toLowerCase();
    if (byKey.has(key)) continue;
    byKey.set(key, {
      id: `dry-contact:${assignment.id}`,
      area: assignment.area ?? "",
      circuit,
      detail: detail && detail !== circuit ? detail : "",
    });
  }
  return Array.from(byKey.values());
}

interface RevisionSnapshotNormalizeOptions {
  fillMissingNewFields?: boolean;
}

function normalizeRevisionSnapshot(
  snapshot: RevisionSnapshot,
  options: RevisionSnapshotNormalizeOptions = {},
): RevisionSnapshot {
  const normalized: RevisionSnapshot = Array.isArray(snapshot.dryContacts)
    ? snapshot
    : {
        ...snapshot,
        dryContacts: inferDryContactsFromAssignments(snapshot.deviceAssignments),
      };
  if (options.fillMissingNewFields === false) {
    return normalized;
  }
  return {
    ...normalized,
    backlightLevels: normalized.backlightLevels ?? backlightLevelsFromSwitches(normalized.switches),
    curtainAssignments: normalized.curtainAssignments ?? [],
    cfsRowDisplay: normalized.cfsRowDisplay ?? createDefaultCfsRowDisplaySettings(),
  };
}

interface RevisionSnapshot {
  circuits?: CircuitEntry[];
  dryContacts?: DryContactEntry[];
  rows?: CfsCircuit[];
  deviceAssignments?: DeviceAssignment[];
  hvacAssignments?: HvacAssignment[];
  hvacSeasons?: HvacSeason[];
  curtainAssignments?: CurtainAssignment[];
  cfsRowDisplay?: CfsRowDisplaySettings;
  backlightLevels?: BacklightLevelSetting[];
  scenes?: Scene[];
  roomScenes?: RoomScene[];
  switches?: SwitchEntry[];
  pduDeviceCounts?: PduDeviceCount[];
  inspectionMarks?: InspectionMark[];
}

interface RevisionComparison {
  before: RevisionSnapshot;
  after: RevisionSnapshot;
}

interface RevisionDiff {
  circuitIds: string[];
  dryContactIds: string[];
  assignmentIds: string[];
  switchIds: string[];
  circuitFields: RevisionFieldChanges;
  dryContactFields: RevisionFieldChanges;
  assignmentFields: RevisionFieldChanges;
  switchFields: RevisionFieldChanges;
  curtainAssignmentFields: RevisionFieldChanges;
  sceneFields: RevisionFieldChanges;
  roomSceneFields: RevisionFieldChanges;
  switchTargetFields: RevisionFieldChanges;
  roomSceneTargetFields: RevisionFieldChanges;
  cfsRowFields: RevisionFieldChanges;
  pduDeviceCountFields: RevisionFieldChanges;
  backlightLogicChanged: boolean;
  cfsRowDisplayChanged: boolean;
}

interface RevisionSectionChange {
  tabIds: RoomsSubTab[];
  label: string;
  count: number;
}

interface SaveRevisionOptions {
  clearInspectionMarks?: boolean;
  note?: string;
  revisionOverride?: string;
}

interface BatchRevisionDraft {
  roomTypeId: string;
  revision: string;
  note: string;
  selected: boolean;
}

interface InspectionSessionEntry {
  roomTypeId: string;
  baseline: InspectionCompletionPayload;
  touched: boolean;
  revision: string;
  note: string;
  selected: boolean;
}

type FinishRevisionExitAction = "stay" | "back";

interface ProjectInspectionHistoryControls {
  active: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

interface ProjectInspectionHistoryStatus {
  active: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

function applyInspectionPayloadToRoomType(rt: RoomType, payload: InspectionCompletionPayload): RoomType {
  return {
    ...rt,
    scenes: payload.scenes,
    roomScenes: payload.roomScenes,
    switches: payload.switches,
    inspectionMarks: payload.inspectionMarks,
  };
}

function inspectionPayloadsEqual(before: InspectionCompletionPayload, after: InspectionCompletionPayload): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

function revisionDateInputValue(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function revisionDateInputToIso(value: string, fallback: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

interface ProjectScreenProps {
  project: ProjectData;
  onBackToProjects: () => void;
  onUpdateProject: (mutate: (project: ProjectData) => ProjectData) => void;
  onSaveProjectDraft: (mutate: (project: ProjectData) => ProjectData | null) => Promise<boolean>;
  onSaveProjectRevision: (mutate: (project: ProjectData) => ProjectData | null) => Promise<boolean>;
  onMoveRoomTypeToTrash: (project: ProjectData, roomType: RoomType) => void;
  saveStatus:
    | "idle"
    | "savingDraft"
    | "draftSaved"
    | "savingProject"
    | "projectSaved"
    | "savingRevision"
    | "revisionSaved"
    | "error";
  lastSavedAt: string | null;
  collaboration: CollaborationController;
  canEdit?: boolean;
  onReadOnlyAction?: () => void;
}

export default function ProjectScreen({
  project,
  onBackToProjects,
  onUpdateProject,
  onSaveProjectDraft,
  onSaveProjectRevision,
  onMoveRoomTypeToTrash,
  saveStatus,
  lastSavedAt,
  collaboration,
  canEdit = true,
  onReadOnlyAction,
}: ProjectScreenProps) {
  useGridArrowNavigation();
  const initialNavigation = readStoredProjectNavigation(
    project.id,
    new Set(project.roomTypes.map((roomType) => roomType.id)),
  );
  const [activeTab, setActiveTab] = useState<ProjectTab>(initialNavigation.activeTab ?? "rooms");
  const [activeSubTab, setActiveSubTab] = useState<RoomsSubTab>(initialNavigation.activeSubTab ?? "circuit");
  const [activeRoomTypeId, setActiveRoomTypeId] = useState<string>(initialNavigation.activeRoomTypeId ?? "");
  const [activeSwitchKind, setActiveSwitchKind] = useState<SwitchKind>("lutronPd");
  const { settings } = useAppSettings();
  const devices = settings.devices;
  const inputMasters = settings.inputMasters;
  const triggerMasters = settings.triggerMasters;
  const roomTypeIdsKey = project.roomTypes.map((roomType) => roomType.id).join("\u0000");
  const validRoomTypeIds = useMemo(
    () => new Set(roomTypeIdsKey ? roomTypeIdsKey.split("\u0000") : []),
    [roomTypeIdsKey],
  );
  const undoStackRef = useRef<ProjectData[]>([]);
  const redoStackRef = useRef<ProjectData[]>([]);
  const lastHistoryPushRef = useRef(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  const inspectionHistoryRef = useRef<ProjectInspectionHistoryControls | null>(null);
  const [inspectionHistoryStatus, setInspectionHistoryStatus] = useState<ProjectInspectionHistoryStatus>({
    active: false,
    canUndo: false,
    canRedo: false,
  });
  const [showRevisionChanges, setShowRevisionChanges] = useState(false);
  const [showRevisionManager, setShowRevisionManager] = useState(false);
  const [isTopUiCollapsed, setIsTopUiCollapsed] = useState(false);
  const [finishRevisionDialogOpen, setFinishRevisionDialogOpen] = useState(false);
  const [finishRevisionDialogIdle, setFinishRevisionDialogIdle] = useState(false);
  const [finishRevisionExitAction, setFinishRevisionExitAction] = useState<FinishRevisionExitAction>("stay");
  const [isFinishingRevision, setIsFinishingRevision] = useState(false);
  const [finishRevisionError, setFinishRevisionError] = useState("");
  const [finishRevisionNote, setFinishRevisionNote] = useState("");
  const [batchRevisionDialogOpen, setBatchRevisionDialogOpen] = useState(false);
  const [batchRevisionDrafts, setBatchRevisionDrafts] = useState<BatchRevisionDraft[]>([]);
  const [batchRevisionError, setBatchRevisionError] = useState("");
  const [isSavingBatchRevision, setIsSavingBatchRevision] = useState(false);
  const [inspectionSessionEntries, setInspectionSessionEntries] = useState<InspectionSessionEntry[]>([]);
  const [lutronExportRoomTypeId, setLutronExportRoomTypeId] = useState<string | null>(null);
  const restoringNavigationRef = useRef(false);
  const restoredProjectIdRef = useRef(project.id);
  const batchRevisionDialogRef = useRef<HTMLElement | null>(null);
  const batchRevisionOpenerRef = useRef<HTMLElement | null>(null);
  const batchRevisionSelectAllRef = useRef<HTMLInputElement | null>(null);
  const isSavingBatchRevisionRef = useRef(false);

  function cloneProjectData<T>(source: T): T {
    if (typeof structuredClone === "function") {
      return structuredClone(source);
    }
    return JSON.parse(JSON.stringify(source)) as T;
  }

  const updateProject = useCallback(
    (mutate: (project: ProjectData) => ProjectData): void => {
      if (!canEdit) {
        onReadOnlyAction?.();
        return;
      }
      const now = Date.now();
      if (now - lastHistoryPushRef.current > 900) {
        undoStackRef.current = [
          ...undoStackRef.current.slice(-(HISTORY_LIMIT - 1)),
          cloneProjectData(project),
        ];
        redoStackRef.current = [];
        setHistoryVersion((v) => v + 1);
      }
      lastHistoryPushRef.current = now;
      onUpdateProject((current) => syncProjectRoomTypeLinks(mutate(current), { devices }));
    },
    [onUpdateProject, project, devices, canEdit, onReadOnlyAction],
  );

  const handleUndo = useCallback((): void => {
    if (!canEdit) {
      onReadOnlyAction?.();
      return;
    }
    const inspectionHistory = inspectionHistoryRef.current;
    if (inspectionHistory?.active) {
      if (inspectionHistory.canUndo) inspectionHistory.undo();
      return;
    }
    const previous = undoStackRef.current.at(-1);
    if (!previous) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    redoStackRef.current = [
      ...redoStackRef.current.slice(-(HISTORY_LIMIT - 1)),
      cloneProjectData(project),
    ];
    setHistoryVersion((v) => v + 1);
    onUpdateProject(() => cloneProjectData(previous));
  }, [onUpdateProject, project, canEdit, onReadOnlyAction]);

  const handleRedo = useCallback((): void => {
    if (!canEdit) {
      onReadOnlyAction?.();
      return;
    }
    const inspectionHistory = inspectionHistoryRef.current;
    if (inspectionHistory?.active) {
      if (inspectionHistory.canRedo) inspectionHistory.redo();
      return;
    }
    const next = redoStackRef.current.at(-1);
    if (!next) return;
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    undoStackRef.current = [
      ...undoStackRef.current.slice(-(HISTORY_LIMIT - 1)),
      cloneProjectData(project),
    ];
    setHistoryVersion((v) => v + 1);
    onUpdateProject(() => cloneProjectData(next));
  }, [onUpdateProject, project, canEdit, onReadOnlyAction]);

  const canUndo = inspectionHistoryStatus.active
    ? inspectionHistoryStatus.canUndo
    : historyVersion >= 0 && undoStackRef.current.length > 0;
  const canRedo = inspectionHistoryStatus.active
    ? inspectionHistoryStatus.canRedo
    : historyVersion >= 0 && redoStackRef.current.length > 0;

  const handleInspectionHistoryChange = useCallback((controls: ProjectInspectionHistoryControls): void => {
    inspectionHistoryRef.current = controls;
    setInspectionHistoryStatus((current) => {
      const next = {
        active: controls.active,
        canUndo: controls.canUndo,
        canRedo: controls.canRedo,
      };
      return current.active === next.active && current.canUndo === next.canUndo && current.canRedo === next.canRedo
        ? current
        : next;
    });
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }

      const key = e.key.toLowerCase();
      const isModifierPressed = e.ctrlKey || e.metaKey;
      if (isModifierPressed && key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (
        (isModifierPressed && key === "y") ||
        (isModifierPressed && e.shiftKey && key === "z")
      ) {
        e.preventDefault();
        handleRedo();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo, handleRedo]);

  useEffect(() => {
    document.body.classList.toggle("cfs-top-ui-collapsed", isTopUiCollapsed);
    return () => {
      document.body.classList.remove("cfs-top-ui-collapsed");
    };
  }, [isTopUiCollapsed]);

  useEffect(() => {
    if (restoredProjectIdRef.current === project.id) return;
    restoredProjectIdRef.current = project.id;
    const stored = readStoredProjectNavigation(project.id, validRoomTypeIds);
    restoringNavigationRef.current = true;
    setActiveTab(stored.activeTab ?? "rooms");
    setActiveSubTab(stored.activeSubTab ?? "circuit");
    setActiveRoomTypeId(stored.activeRoomTypeId ?? "");
    const raf = requestAnimationFrame(() => {
      restoringNavigationRef.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [project.id, validRoomTypeIds]);

  useEffect(() => {
    if (activeRoomTypeId && !project.roomTypes.some((roomType) => roomType.id === activeRoomTypeId)) {
      setActiveRoomTypeId("");
    }
  }, [activeRoomTypeId, project.roomTypes]);

  useEffect(() => {
    if (restoringNavigationRef.current) return;
    writeStoredProjectNavigation(project.id, {
      activeTab,
      activeSubTab,
      activeRoomTypeId: project.roomTypes.some((roomType) => roomType.id === activeRoomTypeId) ? activeRoomTypeId : "",
    });
  }, [activeRoomTypeId, activeSubTab, activeTab, project.id, project.roomTypes]);

  // Keep tab changes anchored at the project header so navigation stays predictable.
  const scrollKey = `${activeTab}:${activeSubTab}`;
  const prevScrollKeyRef = useRef(scrollKey);

  useLayoutEffect(() => {
    if (prevScrollKeyRef.current === scrollKey) return;
    window.scrollTo({ top: 0, behavior: "auto" });
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "auto" });
      requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: "auto" });
      });
    });
    prevScrollKeyRef.current = scrollKey;
  }, [scrollKey]);

  const activeRoomType = useMemo(
    () => project.roomTypes.find((rt) => rt.id === activeRoomTypeId),
    [project.roomTypes, activeRoomTypeId],
  );
  const activeRoomTypeRevisionCount = activeRoomType?.revisions?.length ?? 0;
  const displayedRevisions = useMemo(
    () =>
      (activeRoomType?.revisions ?? [])
        .map((revision, index) => ({ revision, index }))
        .sort((a, b) => {
          const timeCompare = Date.parse(b.revision.savedAt) - Date.parse(a.revision.savedAt);
          if (Number.isFinite(timeCompare) && timeCompare !== 0) return timeCompare;
          const revisionCompare = Number.parseFloat(b.revision.revision) - Number.parseFloat(a.revision.revision);
          return Number.isFinite(revisionCompare) && revisionCompare !== 0 ? revisionCompare : b.index - a.index;
        }),
    [activeRoomType?.revisions],
  );
  const activeRoomTypeCircuits = useMemo(
    () => (activeRoomType ? circuitsForRoomType(project, activeRoomType) : project.circuits),
    [activeRoomType, project],
  );
  const projectCircuitSuggestions = useMemo(
    () => buildProjectCircuitSuggestions(project),
    [project],
  );
  const lutronExportRoomType = useMemo(
    () => project.roomTypes.find((rt) => rt.id === lutronExportRoomTypeId),
    [project.roomTypes, lutronExportRoomTypeId],
  );

  // ---- CFS sub-window sync: broadcast the active room type to the
  // read-only /cfs-window view (same browser, BroadcastChannel). ----
  const cfsWindowChannelRef = useRef<BroadcastChannel | null>(null);
  const cfsWindowSnapshotRef = useRef<CfsWindowSnapshot | null>(null);
  const programmingNameSettings = project.settings?.programmingName;
  const cfsWindowSnapshot = useMemo<CfsWindowSnapshot | null>(() => {
    if (!activeRoomType) return null;
    return {
      projectName: project.name,
      roomType: activeRoomType,
      circuits: activeRoomTypeCircuits,
      devices,
      locations: project.locations,
      programmingNameSettings,
      sentAt: Date.now(),
    };
  }, [project.name, activeRoomType, activeRoomTypeCircuits, devices, project.locations, programmingNameSettings]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(cfsWindowChannelName(project.id));
    cfsWindowChannelRef.current = channel;
    channel.onmessage = (event) => {
      const message = event.data as CfsWindowMessage | undefined;
      if (message?.type !== "request") return;
      const snapshot = cfsWindowSnapshotRef.current;
      if (snapshot) {
        channel.postMessage({
          type: "snapshot",
          snapshot: { ...snapshot, sentAt: Date.now() },
        } satisfies CfsWindowMessage);
      }
    };
    const ping = window.setInterval(() => {
      channel.postMessage({ type: "ping" } satisfies CfsWindowMessage);
    }, 5000);
    return () => {
      window.clearInterval(ping);
      try {
        channel.postMessage({ type: "closed" } satisfies CfsWindowMessage);
      } catch {
        // Channel already torn down by the browser.
      }
      channel.close();
      cfsWindowChannelRef.current = null;
    };
  }, [project.id]);

  useEffect(() => {
    cfsWindowSnapshotRef.current = cfsWindowSnapshot;
    const channel = cfsWindowChannelRef.current;
    if (!channel || !cfsWindowSnapshot) return;
    const timer = window.setTimeout(() => {
      channel.postMessage({ type: "snapshot", snapshot: cfsWindowSnapshot } satisfies CfsWindowMessage);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [cfsWindowSnapshot]);

  const handleOpenCfsWindow = useCallback(() => {
    window.open(
      `/cfs-window?project=${encodeURIComponent(project.id)}`,
      `cfs-window-${project.id}`,
      "width=1500,height=900",
    );
  }, [project.id]);

  useEffect(() => {
    if (!canEdit) return;
    const synced = syncProjectRoomTypeLinks(project, { devices });
    if (synced === project) return;
    onUpdateProject((current) => syncProjectRoomTypeLinks(current, { devices }));
  }, [devices, onUpdateProject, project, canEdit]);

  useEffect(() => {
    if (showRevisionChanges && activeRoomType && activeRoomTypeRevisionCount === 0) {
      setShowRevisionChanges(false);
    }
  }, [activeRoomType, activeRoomTypeRevisionCount, showRevisionChanges]);

  function createRevisionSnapshot(rt: RoomType, circuits: CircuitEntry[]): RevisionSnapshot {
    return {
      circuits,
      dryContacts: rt.dryContacts ?? inferDryContactsFromAssignments(rt.deviceAssignments),
      rows: rt.rows,
      deviceAssignments: rt.deviceAssignments,
      hvacAssignments: rt.hvacAssignments,
      hvacSeasons: rt.hvacSeasons,
      curtainAssignments: rt.curtainAssignments ?? [],
      cfsRowDisplay: rt.cfsRowDisplay,
      backlightLevels: rt.backlightLevels ?? backlightLevelsFromSwitches(rt.switches),
      scenes: rt.scenes,
      roomScenes: rt.roomScenes,
      switches: rt.switches,
      pduDeviceCounts: rt.pduDeviceCounts,
      inspectionMarks: rt.inspectionMarks,
    };
  }

  function parseRevisionSnapshot(
    snapshot: string,
    options?: RevisionSnapshotNormalizeOptions,
  ): RevisionSnapshot | null {
    try {
      const parsed = JSON.parse(snapshot) as RevisionSnapshot;
      return parsed && typeof parsed === "object" ? normalizeRevisionSnapshot(parsed, options) : null;
    } catch {
      return null;
    }
  }

  function revisionSnapshotsEqual(before: RevisionSnapshot, after: RevisionSnapshot): boolean {
    return JSON.stringify(before) === JSON.stringify(after);
  }

  const changedIds = useCallback(<T extends { id: string },>(before: T[] = [], after: T[] = []): string[] => {
    const beforeById = new Map(before.map((item) => [item.id, JSON.stringify(item)]));
    const afterById = new Map(after.map((item) => [item.id, JSON.stringify(item)]));
    const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
    return Array.from(ids).filter((id) => beforeById.get(id) !== afterById.get(id));
  }, []);

  const changedPduDeviceIds = useCallback((
    before: PduDeviceCount[] = [],
    after: PduDeviceCount[] = [],
  ): string[] => {
    const beforeByDevice = new Map(before.map((item) => [item.deviceId, item.quantity]));
    const afterByDevice = new Map(after.map((item) => [item.deviceId, item.quantity]));
    const ids = new Set([...beforeByDevice.keys(), ...afterByDevice.keys()]);
    return Array.from(ids).filter((id) => beforeByDevice.get(id) !== afterByDevice.get(id));
  }, []);

  const changedPduDeviceFields = useCallback((
    before: PduDeviceCount[] = [],
    after: PduDeviceCount[] = [],
  ): RevisionFieldChanges => {
    const beforeByDevice = new Map(before.map((item) => [item.deviceId, item]));
    const afterByDevice = new Map(after.map((item) => [item.deviceId, item]));
    const ids = new Set([...beforeByDevice.keys(), ...afterByDevice.keys()]);
    const result: RevisionFieldChanges = {};
    ids.forEach((deviceId) => {
      const beforeRow = beforeByDevice.get(deviceId);
      const afterRow = afterByDevice.get(deviceId);
      const fields: string[] = [];
      if (!beforeRow && afterRow) fields.push("__added");
      if (beforeRow && !afterRow) fields.push("__removed");
      if ((beforeRow?.quantity ?? 0) !== (afterRow?.quantity ?? 0)) fields.push("quantity");
      if (fields.length > 0) result[deviceId] = fields;
    });
    return result;
  }, []);

  const changedFields = useCallback(<T extends { id: string },>(before: T[] = [], after: T[] = []): RevisionFieldChanges => {
    const beforeById = new Map(before.map((item) => [item.id, item]));
    const afterById = new Map(after.map((item) => [item.id, item]));
    const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
    const result: RevisionFieldChanges = {};

    ids.forEach((id) => {
      const beforeItem = beforeById.get(id) as Record<string, unknown> | undefined;
      const afterItem = afterById.get(id) as Record<string, unknown> | undefined;
      const keys = new Set([
        ...Object.keys(beforeItem ?? {}),
        ...Object.keys(afterItem ?? {}),
      ].filter((key) => key !== "id"));
      const fields = Array.from(keys).filter(
        (key) => JSON.stringify(beforeItem?.[key]) !== JSON.stringify(afterItem?.[key]),
      );
      if (!beforeItem && afterItem) fields.unshift("__added");
      if (beforeItem && !afterItem) fields.unshift("__removed");
      if (fields.length > 0) result[id] = fields;
    });

    return result;
  }, []);

  const changedSettingTargetFields = useCallback(<T extends { id: string },>(
    before: T[] = [],
    after: T[] = [],
    settingsFor: (row: T | undefined) => Array<{ circuitId: string; percentage: string }> | undefined,
  ): RevisionFieldChanges => {
    const beforeById = new Map(before.map((item) => [item.id, item]));
    const afterById = new Map(after.map((item) => [item.id, item]));
    const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
    const result: RevisionFieldChanges = {};

    const byTarget = (settings: Array<{ circuitId: string; percentage: string }> | undefined): Map<string, string> => {
      const map = new Map<string, string>();
      for (const setting of settings ?? []) {
        const targetId = setting.circuitId.trim();
        if (!targetId) continue;
        map.set(targetId, setting.percentage.trim());
      }
      return map;
    };

    ids.forEach((id) => {
      const beforeRow = beforeById.get(id);
      const afterRow = afterById.get(id);
      const beforeTargets = byTarget(settingsFor(beforeRow));
      const afterTargets = byTarget(settingsFor(afterRow));
      const targetIds = new Set([...beforeTargets.keys(), ...afterTargets.keys()]);
      const changedTargets = Array.from(targetIds).filter(
        (targetId) => beforeTargets.get(targetId) !== afterTargets.get(targetId),
      );
      if (!beforeRow && afterRow && changedTargets.length > 0) changedTargets.unshift("__added");
      if (beforeRow && !afterRow && changedTargets.length > 0) changedTargets.unshift("__removed");
      if (changedTargets.length > 0) result[id] = changedTargets;
    });

    return result;
  }, []);

  const hasFieldChange = useCallback((changes: RevisionFieldChanges, id: string, fields?: string[]): boolean => {
    const changed = changes[id];
    if (!changed) return false;
    if (!fields) return changed.length > 0;
    return fields.some((field) => changed.includes(field));
  }, []);

  const hasAnyFieldChange = useCallback((changes: RevisionFieldChanges, ids: string[], fields?: string[]): boolean => {
    return ids.some((id) => hasFieldChange(changes, id, fields));
  }, [hasFieldChange]);

  const switchGroupId = useCallback((sw: SwitchEntry): string => {
    return sw.switchGroupId || sw.id;
  }, []);

  const uniqueChangedSwitchGroups = useCallback((
    before: SwitchEntry[] = [],
    after: SwitchEntry[] = [],
    fields: string[],
    predicate: (sw: SwitchEntry) => boolean,
  ): number => {
    const beforeById = new Map(before.map((sw) => [sw.id, sw]));
    const afterById = new Map(after.map((sw) => [sw.id, sw]));
    const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
    const groups = new Set<string>();

    ids.forEach((id) => {
      const beforeRow = beforeById.get(id);
      const afterRow = afterById.get(id);
      const rowForKind = afterRow ?? beforeRow;
      if (!rowForKind || !predicate(rowForKind)) return;
      const changed = fields.some(
        (field) =>
          JSON.stringify((beforeRow as unknown as Record<string, unknown> | undefined)?.[field]) !==
          JSON.stringify((afterRow as unknown as Record<string, unknown> | undefined)?.[field]),
      );
      if (changed) groups.add(switchGroupId(rowForKind));
    });

    return groups.size;
  }, [switchGroupId]);

  const hasBacklightLogicChange = useCallback((before: RevisionSnapshot, after: RevisionSnapshot): boolean => {
    const beforeLevels = before.backlightLevels ?? backlightLevelsFromSwitches(before.switches);
    const afterLevels = after.backlightLevels ?? backlightLevelsFromSwitches(after.switches);
    if (JSON.stringify(beforeLevels) !== JSON.stringify(afterLevels)) return true;
    const beforeSwitches = before.switches ?? [];
    const afterSwitches = after.switches ?? [];
    const afterById = new Map(afterSwitches.map((sw) => [sw.id, sw]));
    return beforeSwitches.some((beforeRow) => {
      if (beforeRow.kind !== "lutronPd") return false;
      const afterRow = afterById.get(beforeRow.id);
      if (!afterRow || afterRow.kind !== "lutronPd") return false;
      return JSON.stringify(beforeRow.backlightLevels ?? []) !== JSON.stringify(afterRow.backlightLevels ?? []);
    });
  }, []);

  const backlightAssignmentChangeCount = useCallback((before: SwitchEntry[] = [], after: SwitchEntry[] = []): number => {
    const afterById = new Map(after.map((sw) => [sw.id, sw]));
    const groups = new Set<string>();
    before.forEach((beforeRow) => {
      if (beforeRow.kind !== "lutronPd") return;
      const afterRow = afterById.get(beforeRow.id);
      if (!afterRow || afterRow.kind !== "lutronPd") return;
      if ((beforeRow.backlightAssignment ?? "") !== (afterRow.backlightAssignment ?? "")) {
        groups.add(switchGroupId(afterRow));
      }
    });
    return groups.size;
  }, [switchGroupId]);

  const revisionSectionChanges = useCallback((before: RevisionSnapshot | null, after: RevisionSnapshot): RevisionSectionChange[] => {
    if (!before) return [];
    const switchFields = [
      "kind",
      "switchNumber",
      "switchName",
      "cciAssignment",
      "buttonCount",
      "buttonLabel",
      "buttonFunction",
      "isPriorityFunction",
      "condition",
      "buttonSetting",
      "backlightTarget",
      "backlightCondition",
      "backlightAssignment",
    ];
    const commandFields = [
      "switchNumber",
      "switchName",
      "buttonLabel",
      "condition",
      "buttonSetting",
    ];
    const switchCount = uniqueChangedSwitchGroups(
      before.switches,
      after.switches,
      switchFields,
      (sw) => sw.kind !== "command",
    );
    const commandCount = uniqueChangedSwitchGroups(
      before.switches,
      after.switches,
      commandFields,
      (sw) => sw.kind === "command",
    );
    const backlightCount =
      (hasBacklightLogicChange(before, after) ? 1 : 0) +
      backlightAssignmentChangeCount(before.switches, after.switches);
    const cfsRowDisplayChanged =
      JSON.stringify(before.cfsRowDisplay ?? createDefaultCfsRowDisplaySettings()) !==
      JSON.stringify(after.cfsRowDisplay ?? createDefaultCfsRowDisplaySettings());
    const sections: RevisionSectionChange[] = [
      { tabIds: ["circuit", "cfs"], label: "Project circuits", count: changedIds(before.circuits, after.circuits).length },
      { tabIds: ["circuit", "cfs"], label: "Dry Contact", count: changedIds(before.dryContacts, after.dryContacts).length },
      { tabIds: ["circuit"], label: "CFS rows", count: changedIds(before.rows, after.rows).length },
      { tabIds: ["deviceAssign", "cfs"], label: "Device Assign", count: changedIds(before.deviceAssignments, after.deviceAssignments).length },
      { tabIds: ["deviceAssign", "cfs"], label: "HVAC", count: changedIds(before.hvacAssignments, after.hvacAssignments).length },
      { tabIds: ["deviceAssign"], label: "HVAC seasons", count: changedIds(before.hvacSeasons, after.hvacSeasons).length },
      { tabIds: ["deviceAssign", "cfs"], label: "Lutron Curtain", count: changedIds(before.curtainAssignments, after.curtainAssignments).length },
      { tabIds: ["areaScene"], label: "Area Scene", count: changedIds(before.scenes, after.scenes).length },
      { tabIds: ["scene"], label: "Scene", count: changedIds(before.roomScenes, after.roomScenes).length },
      { tabIds: ["switch", "cfs"], label: "Switch", count: switchCount },
      { tabIds: ["command", "cfs"], label: "Command", count: commandCount },
      { tabIds: ["backlight", "cfs"], label: "Backlight", count: backlightCount },
      { tabIds: ["cfs"], label: "CFS row display", count: cfsRowDisplayChanged ? 1 : 0 },
      { tabIds: ["pdu"], label: "PDU", count: changedPduDeviceIds(before.pduDeviceCounts, after.pduDeviceCounts).length },
      { tabIds: ["cfs"], label: "Inspection marks", count: changedIds(before.inspectionMarks, after.inspectionMarks).length },
    ];
    return sections.filter((section) => section.count > 0);
  }, [backlightAssignmentChangeCount, changedIds, changedPduDeviceIds, hasBacklightLogicChange, uniqueChangedSwitchGroups]);

  const detailedRevisionChanges = useCallback((before: RevisionSnapshot, after: RevisionSnapshot): string[] => {
    const fieldLabels: Record<string, string> = {
      designerNumber: "Designer #",
      internalNumber: "Internal #",
      dimmingType: "Dimming type",
      fixture: "Fixture",
      pcs: "QTY",
      detail: "Detail",
      area: "Area",
      areaId: "Area",
      ffe: "FFE",
      energySaving: "Energy Saving",
      circuit: "Circuit",
      device: "Device",
      deviceNum: "Device #",
      circuitNumber: "Circuit",
      zoneAddress: "Zone",
      protocol: "Protocol",
      thermostatRole: "Master / Slave",
      lowEnd: "Low end",
      highEnd: "High end",
      summerWinterChange: "Summer/Winter",
      note: "Detail",
      name: "Name",
      startMonth: "Start month",
      startDay: "Start day",
      endMonth: "End month",
      endDay: "End day",
      phase: "Room status",
      switchNumber: "Switch #",
      switchName: "Switch name",
      buttonLabel: "Button",
      buttonFunction: "Function",
      isPriorityFunction: "Priority function",
      condition: "Trigger condition",
      sceneIds: "Area scene",
      buttonSetting: "Scene/override setting",
      areaSceneSelections: "Area scene selection",
      backlightTarget: "Backlight target",
      backlightCondition: "Backlight scene",
      backlightLevels: "Backlight logic",
      settings: "Scene values",
      triggerCondition: "Trigger condition",
      sceneType: "Scene name",
      quantity: "Quantity",
      action: "Action",
    };
    const hiddenRevisionFields = new Set([
      "__added",
      "__removed",
      "id",
      "circuitGroupId",
      "daliFixtureGroupId",
      "deviceGroupId",
      "switchGroupId",
      "group",
    ]);
    const structuredFields = new Set(["settings", "sceneIds", "buttonSetting", "backlightLevels"]);
    const areaNameById = new Map(project.locations.map((location) => [location.id, location.name]));
    const sceneLabelById = new Map(
      [...(before.scenes ?? []), ...(after.scenes ?? [])]
        .filter((scene) => Boolean(scene.name))
        .map((scene) => [scene.id, scene.name]),
    );
    const roomSceneLabelById = new Map(
      [...(before.roomScenes ?? []), ...(after.roomScenes ?? [])]
        .map((scene): [string, string] => [scene.id, [scene.phase, scene.sceneType, scene.detail].filter(Boolean).join(" / ")])
        .filter(([, label]) => Boolean(label)),
    );
    const assignmentLabelById = new Map(
      [...(before.deviceAssignments ?? []), ...(after.deviceAssignments ?? [])].map((assignment) => [
        assignment.id,
        [[assignment.device, assignment.deviceNum].filter(Boolean).join("/"), assignment.zoneAddress || assignment.circuitNumber]
          .filter(Boolean)
          .join(" ") || "Unassigned device",
      ]),
    );
    const targetLabelById = new Map<string, string>();
    [...(before.circuits ?? []), ...(after.circuits ?? [])].forEach((circuit) => {
      targetLabelById.set(
        circuit.id,
        [circuit.designerNumber || circuit.internalNumber || "Circuit", circuit.detail || circuit.fixture].filter(Boolean).join(" / "),
      );
    });
    [...(before.deviceAssignments ?? []), ...(after.deviceAssignments ?? [])].forEach((assignment) => {
      const address = assignment.zoneAddress.trim();
      const normalizedAddress = address.replace(/^\d+-/, "");
      const inputKind = /^CCI/i.test(normalizedAddress) ? "cci" : /^CCO/i.test(normalizedAddress) ? "cco" : "";
      if (!inputKind) return;
      const value = assignment.circuitNumber.trim();
      const detail = assignment.detail.trim();
      targetLabelById.set(
        `${inputKind}:${assignment.id}`,
        [address || inputKind.toUpperCase(), value && value !== "Reserved" ? value : "", detail].filter(Boolean).join(" / "),
      );
    });
    [...(before.hvacAssignments ?? []), ...(after.hvacAssignments ?? [])].forEach((assignment) => {
      ["On/Off", "Setpoint", "Fan Mode", "Drift"].forEach((metric) => {
        targetLabelById.set(`hvac:${assignment.id}:${metric}`, ["HVAC", areaNameById.get(assignment.area), metric].filter(Boolean).join(" / "));
      });
    });
    [...(before.curtainAssignments ?? []), ...(after.curtainAssignments ?? [])].forEach((assignment) => {
      targetLabelById.set(
        `curtain:${assignment.id}`,
        ["Lutron Curtain", areaNameById.get(assignment.area), assignment.detail].filter(Boolean).join(" / "),
      );
    });
    const changes: string[] = [];
    const hasInternalId = (value: string): boolean => /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i.test(value);
    const readableBacklightTarget = (value: string): string => {
      const labels = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => sceneLabelById.get(entry) || roomSceneLabelById.get(entry) || areaNameById.get(entry) || "")
        .filter(Boolean);
      return labels.length > 0 ? labels.join(", ") : "Configured";
    };
    const readableLabel = (value: string, fallback: string): string => hasInternalId(value) ? fallback : value || fallback;
    const displayValue = (field: string, value: unknown): string => {
      if (value === null || value === undefined || value === "") return "Not set";
      if (field === "area" || field === "areaId") return areaNameById.get(String(value)) || "Unassigned area";
      if (field === "cciAssignment") return assignmentLabelById.get(String(value)) || "Not assigned";
      if (field === "backlightTarget") return readableBacklightTarget(String(value));
      if (structuredFields.has(field) || typeof value === "object") return "Updated";
      if (typeof value === "boolean") return value ? "On" : "Off";
      const text = String(value);
      return hasInternalId(text) ? "Configured" : text;
    };
    const settingsMap = (settings: unknown): Map<string, string> => {
      const map = new Map<string, string>();
      if (!Array.isArray(settings)) return map;
      for (const setting of settings) {
        if (!setting || typeof setting !== "object") continue;
        const row = setting as { circuitId?: unknown; percentage?: unknown };
        const targetId = typeof row.circuitId === "string" ? row.circuitId.trim() : "";
        if (!targetId) continue;
        map.set(targetId, typeof row.percentage === "string" ? row.percentage.trim() : String(row.percentage ?? "").trim());
      }
      return map;
    };
    const targetLabel = (targetId: string): string => {
      return targetLabelById.get(targetId) || targetId.replace(/^[a-f0-9-]{18,}$/i, "Configured target");
    };
    const settingsChangeText = (label: string, beforeSettings: unknown, afterSettings: unknown): string => {
      const beforeByTarget = settingsMap(beforeSettings);
      const afterByTarget = settingsMap(afterSettings);
      const targetIds = Array.from(new Set([...beforeByTarget.keys(), ...afterByTarget.keys()]));
      const parts = targetIds
        .filter((targetId) => beforeByTarget.get(targetId) !== afterByTarget.get(targetId))
        .map((targetId) => {
          const beforeValue = beforeByTarget.get(targetId) || "Not set";
          const afterValue = afterByTarget.get(targetId) || "Not set";
          return `${label} ${targetLabel(targetId)}: ${beforeValue} -> ${afterValue}`;
        });
      if (parts.length === 0) return `${label} updated`;
      return parts.join("; ");
    };
    const structuredFieldText = (
      field: string,
      label: string,
      beforeRow?: Record<string, unknown>,
      afterRow?: Record<string, unknown>,
    ): string => {
      if (field === "buttonSetting") {
        const beforeSetting = beforeRow?.buttonSetting as { circuitSettings?: unknown } | undefined;
        const afterSetting = afterRow?.buttonSetting as { circuitSettings?: unknown } | undefined;
        return settingsChangeText(label, beforeSetting?.circuitSettings, afterSetting?.circuitSettings);
      }
      if (field === "settings") {
        return settingsChangeText(label, beforeRow?.settings, afterRow?.settings);
      }
      return `${label} updated`;
    };
    const fieldText = (fields: string[], beforeRow?: Record<string, unknown>, afterRow?: Record<string, unknown>): string => {
      if (!beforeRow) return "Added";
      if (!afterRow) return "Removed";
      return fields
        .filter((field) => !hiddenRevisionFields.has(field))
        .map((field) => {
          const label = fieldLabels[field] ?? field;
          if (structuredFields.has(field)) return structuredFieldText(field, label, beforeRow, afterRow);
          return `${label}: ${displayValue(field, beforeRow[field])} -> ${displayValue(field, afterRow[field])}`;
        })
        .join("; ");
    };

    function summarize<T extends { id: string }>(
      title: string,
      beforeRows: T[] = [],
      afterRows: T[] = [],
      labelFor: (row: T) => string,
    ): void {
      const fieldsById = changedFields(beforeRows, afterRows);
      const beforeById = new Map(beforeRows.map((row) => [row.id, row]));
      const afterById = new Map(afterRows.map((row) => [row.id, row]));
      const added: string[] = [];
      const removed: string[] = [];
      Object.entries(fieldsById).forEach(([id, fields]) => {
        const beforeRow = beforeById.get(id);
        const afterRow = afterById.get(id);
        const row = afterRow ?? beforeRow;
        if (!row) return;
        const summary = fieldText(fields, beforeRow as Record<string, unknown> | undefined, afterRow as Record<string, unknown> | undefined);
        if (!summary) return;
        if (summary === "Added") {
          added.push(labelFor(row));
          return;
        }
        if (summary === "Removed") {
          removed.push(labelFor(row));
          return;
        }
        changes.push(`${title}\t${labelFor(row)}: ${summary}`);
      });
      const summarizeBulk = (labels: string[], action: "added" | "removed"): void => {
        if (labels.length === 0) return;
        if (labels.length <= 4) {
          labels.forEach((label) => changes.push(`${title}\t${label}: ${action === "added" ? "Added" : "Removed"}`));
          return;
        }
        const examples = Array.from(new Set(labels)).slice(0, 4).join(", ");
        const remainder = labels.length - Math.min(labels.length, 4);
        changes.push(`${title}\t${labels.length} items ${action}: ${examples}${remainder > 0 ? ` + ${remainder} more` : ""}`);
      };
      summarizeBulk(added, "added");
      summarizeBulk(removed, "removed");
    }

    summarize("Circuit tab", before.circuits, after.circuits, (row) =>
      [row.designerNumber || row.internalNumber || "Unassigned circuit", row.detail].filter(Boolean).join(" / "),
    );
    summarize("Dry Contact tab", before.dryContacts, after.dryContacts, (row) =>
      [areaNameById.get(row.area) || "Unassigned area", row.circuit || "Unassigned contact", row.detail].filter(Boolean).join(" / "),
    );
    summarize("Device Assign tab", before.deviceAssignments, after.deviceAssignments, (row) =>
      [[row.device, row.deviceNum].filter(Boolean).join("/"), row.zoneAddress || row.circuitNumber].filter(Boolean).join(" ") || "Unassigned device",
    );
    summarize("Device Assign tab / HVAC", before.hvacAssignments, after.hvacAssignments, (row) =>
      [row.protocol, row.note || areaNameById.get(row.area) || "HVAC assignment"].filter(Boolean).join(" "),
    );
    summarize("Device Assign tab / HVAC Season", before.hvacSeasons, after.hvacSeasons, (row) =>
      row.name || `${row.startMonth}/${row.startDay}-${row.endMonth}/${row.endDay}`,
    );
    summarize("Device Assign tab / Lutron Curtain", before.curtainAssignments, after.curtainAssignments, (row) =>
      ["Lutron Curtain", areaNameById.get(row.area) || "Unassigned area", row.detail].filter(Boolean).join(" / "),
    );
    summarize("Area Scene tab", before.scenes, after.scenes, (row) => row.name || areaNameById.get(row.areaId) || "Unnamed area scene");
    summarize("Scene tab", before.roomScenes, after.roomScenes, (row) =>
      [row.phase, row.sceneType, row.detail, row.triggerCondition].filter(Boolean).join(" / ") || "Unnamed scene",
    );

    const beforeMarks = new Map((before.inspectionMarks ?? []).map((mark) => [mark.id, mark]));
    const afterMarks = new Map((after.inspectionMarks ?? []).map((mark) => [mark.id, mark]));
    new Set([...beforeMarks.keys(), ...afterMarks.keys()]).forEach((id) => {
      const previous = beforeMarks.get(id);
      const next = afterMarks.get(id);
      const label = next?.label || previous?.label || "Inspection update";
      if (!previous && next) {
        changes.push(`CFS tab / Inspection Mark\t${label}: ${next.previousValue || "Not set"} -> ${next.value || "Uneffected"}`);
      } else if (previous && !next) {
        changes.push(`CFS tab / Inspection Mark\t${label}: Mark cleared`);
      } else if (previous && next && JSON.stringify(previous) !== JSON.stringify(next)) {
        changes.push(`CFS tab / Inspection Mark\t${label}: ${previous.value || previous.previousValue || "Not set"} -> ${next.value || "Uneffected"}`);
      }
    });

    const beforePduByDevice = new Map((before.pduDeviceCounts ?? []).map((row) => [row.deviceId, row]));
    const afterPduByDevice = new Map((after.pduDeviceCounts ?? []).map((row) => [row.deviceId, row]));
    const pduDeviceIds = new Set([...beforePduByDevice.keys(), ...afterPduByDevice.keys()]);
    pduDeviceIds.forEach((deviceId) => {
      const beforeRow = beforePduByDevice.get(deviceId);
      const afterRow = afterPduByDevice.get(deviceId);
      if ((beforeRow?.quantity ?? 0) === (afterRow?.quantity ?? 0)) return;
      const label = devices.find((device) => device.id === deviceId)?.model || "Unassigned device";
      changes.push(`PDU tab\t${label}: ${beforeRow?.quantity ?? 0} -> ${afterRow?.quantity ?? 0}`);
    });

    if (
      JSON.stringify(before.cfsRowDisplay ?? createDefaultCfsRowDisplaySettings()) !==
      JSON.stringify(after.cfsRowDisplay ?? createDefaultCfsRowDisplaySettings())
    ) {
      changes.push("CFS tab\tRow display/order: Updated");
    }
    if (
      JSON.stringify(before.backlightLevels ?? backlightLevelsFromSwitches(before.switches)) !==
      JSON.stringify(after.backlightLevels ?? backlightLevelsFromSwitches(after.switches))
    ) {
      changes.push("Backlight tab\tBacklight Logic: Updated");
    }

    const beforeSwitches = before.switches ?? [];
    const afterSwitches = after.switches ?? [];
    const switchFieldsById = changedFields(beforeSwitches, afterSwitches);
    const beforeSwitchById = new Map(beforeSwitches.map((row) => [row.id, row]));
    const afterSwitchById = new Map(afterSwitches.map((row) => [row.id, row]));
    Object.entries(switchFieldsById).forEach(([id, fields]) => {
      const beforeRow = beforeSwitchById.get(id);
      const afterRow = afterSwitchById.get(id);
      const row = afterRow ?? beforeRow;
      if (!row) return;
      const tab =
        row.kind === "command"
          ? "Command tab"
          : fields.some((field) => field === "backlightTarget" || field === "backlightCondition" || field === "backlightAssignment" || field === "backlightLevels")
            ? "Backlight tab"
            : "Switch tab";
      const label =
        [
          [readableLabel(row.switchNumber, row.kind === "pir" ? "PIR" : "Configured switch"), row.switchName].filter(Boolean).join(" - "),
          readableLabel(row.buttonLabel, ""),
          row.buttonFunction,
        ]
          .filter(Boolean)
          .join(" / ") || "Unlabeled switch";
      const summary = fieldText(fields, beforeRow as Record<string, unknown> | undefined, afterRow as Record<string, unknown> | undefined);
      if (!summary) return;
      changes.push(`${tab}\t${label}: ${summary}`);
    });

    return changes;
  }, [changedFields, devices, project.locations]);

  const revisionChangeNote = useCallback((before: RevisionSnapshot | null, after: RevisionSnapshot): string => {
    if (!before) return "Initial revision snapshot.";
    const details = detailedRevisionChanges(before, after);
    if (details.length > 0) {
      return details.join("\n");
    }
    const sections = revisionSectionChanges(before, after);
    if (sections.length === 0) return "No data changes from the previous revision.";
    return sections.map((section) => `${section.label}\t${section.count} changed`).join("\n");
  }, [detailedRevisionChanges, revisionSectionChanges]);

  function formatRevisionUserNote(note: string): string {
    return note
      .trim()
      .split(/\r?\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `Note\t${line}`)
      .join("\n");
  }

  function revisionAutoNoteAtIndex(rt: RoomType, index: number): string {
    const revision = rt.revisions[index];
    if (!revision) return "No memo.";
    const after = parseRevisionSnapshot(revision.snapshot);
    if (!after) return "No memo.";
    const previous = index > 0 ? parseRevisionSnapshot(rt.revisions[index - 1].snapshot) : null;
    return revisionChangeNote(previous, after);
  }

  function revisionNoteGroups(note: string): Array<{ tab: string; items: string[] }> {
    const groups: Array<{ tab: string; items: string[] }> = [];
    for (const rawLine of note.split(/\n+/).map((line) => line.trim()).filter(Boolean)) {
      const [tabPart, itemPart] = rawLine.includes("\t")
        ? rawLine.split(/\t(.+)/).filter(Boolean)
        : ["Summary", rawLine];
      const tab = tabPart || "Summary";
      const item = itemPart || rawLine;
      const group = groups.find((entry) => entry.tab === tab);
      if (group) group.items.push(item);
      else groups.push({ tab, items: [item] });
    }
    return groups.length > 0 ? groups : [{ tab: "Summary", items: ["No memo."] }];
  }

  function renderRevisionNote(note: string): React.JSX.Element {
    return (
      <div className="revision-note-groups">
        {revisionNoteGroups(note).map((group) => (
          <div key={group.tab} className="revision-note-group">
            <div className="revision-note-tab">{group.tab}</div>
            <ul className="revision-note-items">
              {group.items.map((item, itemIndex) => (
                <li key={`${group.tab}-${itemIndex}`}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }

  const revisionComparison = useMemo<RevisionComparison | null>(() => {
    if (!activeRoomType || !showRevisionChanges) return null;
    const latest = activeRoomType.revisions?.at(-1);
    if (!latest) return null;
    const latestSnapshot = parseRevisionSnapshot(latest.snapshot);
    if (!latestSnapshot) return null;
    const currentSnapshot = createRevisionSnapshot(activeRoomType, activeRoomTypeCircuits);
    if (!revisionSnapshotsEqual(latestSnapshot, currentSnapshot)) {
      return { before: latestSnapshot, after: currentSnapshot };
    }
    const previous = activeRoomType.revisions?.at(-2);
    const previousSnapshot = previous ? parseRevisionSnapshot(previous.snapshot) : null;
    return { before: previousSnapshot ?? latestSnapshot, after: latestSnapshot };
  }, [activeRoomType, activeRoomTypeCircuits, showRevisionChanges]);

  const revisionDiff = useMemo<RevisionDiff | null>(() => {
    if (!revisionComparison) return null;
    const { before, after } = revisionComparison;
    const circuitFields = changedFields(before.circuits, after.circuits);
    const dryContactFields = changedFields(before.dryContacts, after.dryContacts);
    const assignmentFields = changedFields(before.deviceAssignments, after.deviceAssignments);
    const curtainAssignmentFields = changedFields(before.curtainAssignments, after.curtainAssignments);
    const switchFields = changedFields(before.switches, after.switches);
    const sceneFields = changedFields(before.scenes, after.scenes);
    const roomSceneFields = changedFields(before.roomScenes, after.roomScenes);
    const switchTargetFields = changedSettingTargetFields(
      before.switches,
      after.switches,
      (sw) => sw?.buttonSetting?.circuitSettings,
    );
    const roomSceneTargetFields = changedSettingTargetFields(
      before.roomScenes,
      after.roomScenes,
      (scene) => scene?.settings,
    );
    const cfsRowFields = changedFields(before.rows, after.rows);
    const pduDeviceCountFields = changedPduDeviceFields(before.pduDeviceCounts, after.pduDeviceCounts);
    const backlightLogicChanged = hasBacklightLogicChange(before, after);
    const cfsRowDisplayChanged =
      JSON.stringify(before.cfsRowDisplay ?? createDefaultCfsRowDisplaySettings()) !==
      JSON.stringify(after.cfsRowDisplay ?? createDefaultCfsRowDisplaySettings());
    return {
      circuitIds: Object.keys(circuitFields),
      dryContactIds: Object.keys(dryContactFields),
      assignmentIds: Object.keys(assignmentFields),
      switchIds: Object.keys(switchFields),
      circuitFields,
      dryContactFields,
      assignmentFields,
      curtainAssignmentFields,
      switchFields,
      sceneFields,
      roomSceneFields,
      switchTargetFields,
      roomSceneTargetFields,
      cfsRowFields,
      pduDeviceCountFields,
      backlightLogicChanged,
      cfsRowDisplayChanged,
    };
  }, [changedFields, changedPduDeviceFields, changedSettingTargetFields, hasBacklightLogicChange, revisionComparison]);

  const highlightedSubTabs = useMemo(() => {
    const highlighted = new Set<RoomsSubTab>();
    if (!activeRoomType || !showRevisionChanges || !revisionDiff || !revisionComparison) return highlighted;
    const { before, after } = revisionComparison;

    if (
      Object.keys(revisionDiff.circuitFields).length > 0 ||
      Object.keys(revisionDiff.dryContactFields).length > 0 ||
      Object.keys(revisionDiff.cfsRowFields).length > 0
    ) {
      highlighted.add("circuit");
      highlighted.add("cfs");
    }
    if (
      Object.keys(revisionDiff.assignmentFields).length > 0 ||
      Object.keys(revisionDiff.curtainAssignmentFields).length > 0
    ) {
      highlighted.add("deviceAssign");
      highlighted.add("cfs");
    }
    if (
      changedIds(before.hvacAssignments, after.hvacAssignments).length > 0 ||
      changedIds(before.hvacSeasons, after.hvacSeasons).length > 0
    ) {
      highlighted.add("deviceAssign");
      highlighted.add("cfs");
    }
    if (Object.keys(revisionDiff.sceneFields).length > 0) {
      highlighted.add("areaScene");
      highlighted.add("cfs");
    }
    if (Object.keys(revisionDiff.roomSceneFields).length > 0) {
      highlighted.add("scene");
      highlighted.add("cfs");
    }

    const contactSwitchIds = after.switches
      ?.filter((sw) => sw.kind !== "command")
      .map((sw) => sw.id) ?? [];
    const commandIds = after.switches
      ?.filter((sw) => sw.kind === "command")
      .map((sw) => sw.id) ?? [];
    const palladiomIds = after.switches
      ?.filter((sw) => sw.kind === "lutronPd")
      .map((sw) => sw.id) ?? [];
    const switchDataFields = [
      "kind",
      "switchNumber",
      "switchName",
      "cciAssignment",
      "buttonCount",
      "buttonLabel",
      "buttonFunction",
      "isPriorityFunction",
      "condition",
      "buttonSetting",
      "backlightTarget",
      "backlightCondition",
      "backlightAssignment",
    ];
    if (hasAnyFieldChange(revisionDiff.switchFields, contactSwitchIds, switchDataFields)) {
      highlighted.add("switch");
      highlighted.add("cfs");
    }
    if (hasAnyFieldChange(revisionDiff.switchFields, commandIds)) {
      highlighted.add("command");
      highlighted.add("cfs");
    }
    if (
      revisionDiff.backlightLogicChanged ||
      hasAnyFieldChange(revisionDiff.switchFields, palladiomIds, ["backlightCondition", "backlightAssignment"])
    ) {
      highlighted.add("backlight");
      highlighted.add("cfs");
    }
    if (Object.keys(revisionDiff.pduDeviceCountFields).length > 0) {
      highlighted.add("pdu");
    }
    if (revisionDiff.cfsRowDisplayChanged) {
      highlighted.add("cfs");
    }
    return highlighted;
  }, [activeRoomType, changedIds, hasAnyFieldChange, revisionComparison, revisionDiff, showRevisionChanges]);

  // ---- Master setters ----
  const setLocations = useCallback(
    (next: LocationMaster[]): void => {
      updateProject((p) => ({ ...p, locations: next }));
    },
    [updateProject],
  );

  const setFixtures = useCallback(
    (next: FixtureMaster[]): void => {
      updateProject((p) => ({ ...p, fixtures: next }));
    },
    [updateProject],
  );

  const setActiveRoomTypeCircuits = useCallback(
    (next: CircuitEntry[]): void => {
      updateProject((p) => {
        const scopedProject = normalizeProjectRoomTypeCircuitIds(p);
        const roomType = scopedProject.roomTypes.find((rt) => rt.id === activeRoomTypeId);
        if (!roomType) return p;
        const scopedIds = inferRoomTypeCircuitIds(scopedProject, roomType);
        const currentScopedIds = new Set(scopedIds);
        const nextIds = new Set(next.map((circuit) => circuit.id));
        const removeIds = new Set([...currentScopedIds, ...nextIds]);
        const firstScopedIndex = scopedProject.circuits.findIndex((circuit) =>
          currentScopedIds.has(circuit.id),
        );
        const insertIndex = firstScopedIndex === -1 ? scopedProject.circuits.length : firstScopedIndex;
        const before = scopedProject.circuits
          .slice(0, insertIndex)
          .filter((circuit) => !removeIds.has(circuit.id));
        const after = scopedProject.circuits
          .slice(insertIndex)
          .filter((circuit) => !removeIds.has(circuit.id));
        const circuits = [...before, ...next, ...after];
        const circuitIds = next.map((circuit) => circuit.id);
        return {
          ...scopedProject,
          circuits,
          roomTypes: scopedProject.roomTypes.map((rt) =>
            rt.id === activeRoomTypeId
              ? { ...rt, circuitIds, updatedAt: new Date().toISOString() }
              : rt,
          ),
        };
      });
    },
    [activeRoomTypeId, updateProject],
  );

  // ---- Room type management ----
  const handleCreateRoomType = useCallback(
    (name: string): void => {
      const newRoom = createNewRoomType(name);
      updateProject((p) => ({
        ...p,
        roomTypes: [...p.roomTypes, newRoom],
      }));
      setActiveRoomTypeId(newRoom.id);
      setActiveTab("rooms");
      setActiveSubTab("circuit");
    },
    [updateProject],
  );

  const handleRenameRoomType = useCallback(
    (id: string, newName: string): void => {
      updateProject((p) => ({
        ...p,
        roomTypes: p.roomTypes.map((rt) =>
          rt.id === id
            ? { ...rt, name: newName, updatedAt: new Date().toISOString() }
            : rt,
        ),
      }));
    },
    [updateProject],
  );

  const handleDuplicateRoomType = useCallback(
    (id: string): void => {
      updateProject((p) => {
        return duplicateRoomType(p, id)?.project ?? p;
      });
    },
    [updateProject],
  );

  const handleExportRoomTypeBackup = useCallback(
    (id: string): void => {
      const roomType = project.roomTypes.find((rt) => rt.id === id);
      if (!roomType) return;
      const exportedProject: ProjectData = {
        ...cloneProjectData(project),
        id: createAppId(),
        name: `${project.name} - ${roomType.name}`,
        updatedAt: new Date().toISOString(),
        roomTypes: [cloneProjectData(roomType)],
      };
      downloadProjectBackup([exportedProject], `${project.name}_${roomType.name}_share`);
    },
    [project],
  );

  function nextRoomTypeRevisionValue(rt: RoomType): string {
    const revisionNumbers = [
      Number.parseFloat(rt.revision || "1.00"),
      ...(rt.revisions ?? []).map((revision) => Number.parseFloat(revision.revision)),
    ].filter(Number.isFinite);
    const base = revisionNumbers.length > 0 ? Math.max(...revisionNumbers) : Number.NaN;
    return Number.isFinite(base) ? (Math.round((base + 0.01) * 100) / 100).toFixed(2) : "1.01";
  }

  function normalizedRevisionValue(value: string | undefined, fallback: string): string {
    const trimmed = value?.trim() ?? "";
    return trimmed || fallback;
  }

  const numericRevisionValue = useCallback((value: string): number | null => {
    const trimmed = value.trim();
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }, []);

  const revisionValidationMessage = useCallback((rt: RoomType, revision: string): string => {
    const label = revision.trim();
    const roomTypeName = rt.name || "this room type";
    if (!label) return `Update Revision is required for ${roomTypeName}.`;
    const existingLabels = new Set(
      (rt.revisions ?? [])
        .map((entry) => entry.revision.trim())
        .filter(Boolean),
    );
    if (existingLabels.has(label)) {
      return `Update Revision ${label} already exists for ${roomTypeName}.`;
    }
    const currentLabel = rt.revision.trim();
    if (currentLabel && currentLabel === label) {
      return `Update Revision for ${roomTypeName} must be different from the current revision.`;
    }
    const nextNumber = numericRevisionValue(label);
    const latestSavedNumber = (rt.revisions ?? [])
      .map((entry) => numericRevisionValue(entry.revision))
      .filter((value): value is number => value !== null)
      .sort((a, b) => b - a)[0];
    const currentNumber = numericRevisionValue(rt.revision);
    const latestNumber = Math.max(latestSavedNumber ?? Number.NEGATIVE_INFINITY, currentNumber ?? Number.NEGATIVE_INFINITY);
    if (nextNumber !== null && Number.isFinite(latestNumber) && nextNumber <= latestNumber) {
      return `Update Revision for ${roomTypeName} must be greater than ${latestNumber.toFixed(2)}.`;
    }
    return "";
  }, [numericRevisionValue]);

  const handleDeleteRoomType = useCallback(
    (id: string): void => {
      const roomType = project.roomTypes.find((rt) => rt.id === id);
      if (!roomType) return;
      if (
        !window.confirm(
          `Move room type "${roomType.name}" to Trash?\n\nIt will be permanently deleted only when you empty Trash.`,
        )
      ) {
        return;
      }
      onMoveRoomTypeToTrash(project, roomType);
      updateProject((p) => ({
        ...p,
        roomTypes: p.roomTypes.filter((rt) => rt.id !== id),
      }));
      if (activeRoomTypeId === id) {
        setActiveRoomTypeId("");
        setActiveTab("rooms");
      }
    },
    [updateProject, activeRoomTypeId, onMoveRoomTypeToTrash, project],
  );

  const handleSelectRoomType = useCallback((id: string): void => {
    setActiveRoomTypeId(id);
    setActiveTab("rooms");
    setActiveSubTab("cfs");
    setLutronExportRoomTypeId(null);
  }, []);

  const handleSelectRoomTypeTab = useCallback((id: string): void => {
    if (id === ROOM_TYPE_MANAGE_ID) {
      setActiveRoomTypeId("");
      return;
    }
    setActiveRoomTypeId(id);
    setActiveSubTab((prev) => prev);
  }, []);

  // ---- CFS row management ----
  const updateActiveRoomType = useCallback(
    (mutate: (rt: RoomType) => RoomType): void => {
      updateProject((p) => ({
        ...p,
        roomTypes: p.roomTypes.map((rt) =>
          rt.id === activeRoomTypeId
            ? { ...mutate(rt), updatedAt: new Date().toISOString() }
            : rt,
        ),
      }));
    },
    [updateProject, activeRoomTypeId],
  );

  const saveActiveRoomTypeRevision = useCallback(
    (mutate: (rt: RoomType) => RoomType): Promise<boolean> => {
      return onSaveProjectRevision((current) =>
        syncProjectRoomTypeLinks(
          {
            ...current,
            roomTypes: current.roomTypes.map((rt) =>
              rt.id === activeRoomTypeId
                ? { ...mutate(rt), updatedAt: new Date().toISOString() }
                : rt,
            ),
          },
          { devices },
        ),
      );
    },
    [activeRoomTypeId, devices, onSaveProjectRevision],
  );

  const saveRoomTypeRevision = useCallback((
    rt: RoomType,
    circuits: CircuitEntry[],
    options: SaveRevisionOptions = {},
  ): RoomType => {
    const revision = normalizedRevisionValue(options.revisionOverride, nextRoomTypeRevisionValue(rt));
    const previous = rt.revisions?.at(-1);
    const before = previous ? parseRevisionSnapshot(previous.snapshot) : null;
    const revisionSource = options.clearInspectionMarks ? { ...rt, inspectionMarks: [] } : rt;
    const snapshot = createRevisionSnapshot(revisionSource, circuits);
    const userNote = formatRevisionUserNote(options.note ?? "");
    const autoNote = revisionChangeNote(before, snapshot);
    return {
      ...revisionSource,
      revision,
      revisions: [
        ...(rt.revisions ?? []),
        {
          id: createAppId(),
          revision,
          savedAt: new Date().toISOString(),
          savedBy: collaboration.user?.displayName?.trim() || "",
          snapshot: JSON.stringify(snapshot),
          note: userNote || autoNote,
        },
      ],
    };
  }, [revisionChangeNote, collaboration.user]);

  const roomTypeHasRevisionDraftInProject = useCallback((sourceProject: ProjectData, rt: RoomType): boolean => {
    const latest = rt.revisions?.at(-1);
    if (!latest) return true;
    const latestSnapshot = parseRevisionSnapshot(latest.snapshot);
    if (!latestSnapshot) return true;
    const currentSnapshot = createRevisionSnapshot(rt, circuitsForRoomType(sourceProject, rt));
    return JSON.stringify(currentSnapshot) !== JSON.stringify(latestSnapshot);
  }, []);

  const roomTypeHasRevisionDraft = useCallback((rt: RoomType): boolean => {
    return roomTypeHasRevisionDraftInProject(project, rt);
  }, [project, roomTypeHasRevisionDraftInProject]);

  const revisionDraftRoomTypes = useMemo(
    () => project.roomTypes.filter((rt) => roomTypeHasRevisionDraftInProject(project, rt)),
    [project, roomTypeHasRevisionDraftInProject],
  );

  const handleSaveRevision = useCallback(async (options: SaveRevisionOptions = {}): Promise<boolean> => {
    if (!canEdit) {
      onReadOnlyAction?.();
      return false;
    }
    return saveActiveRoomTypeRevision((rt) => {
      return saveRoomTypeRevision(rt, circuitsForRoomType(project, rt), options);
    });
  }, [project, saveActiveRoomTypeRevision, saveRoomTypeRevision, canEdit, onReadOnlyAction]);

  const saveDraftRoomTypeRevisions = useCallback(async (options: SaveRevisionOptions = {}): Promise<boolean> => {
    if (!canEdit) {
      onReadOnlyAction?.();
      return false;
    }
    return onSaveProjectRevision((current) => {
      const draftIds = new Set(
        current.roomTypes
          .filter((rt) => roomTypeHasRevisionDraftInProject(current, rt))
          .map((rt) => rt.id),
      );
      if (draftIds.size === 0) return syncProjectRoomTypeLinks(current, { devices });
      return syncProjectRoomTypeLinks(
        {
          ...current,
          roomTypes: current.roomTypes.map((rt) =>
            draftIds.has(rt.id)
              ? {
                  ...saveRoomTypeRevision(rt, circuitsForRoomType(current, rt), options),
                  updatedAt: new Date().toISOString(),
                }
              : rt,
          ),
        },
        { devices },
      );
    });
  }, [
    canEdit,
    devices,
    onReadOnlyAction,
    onSaveProjectRevision,
    roomTypeHasRevisionDraftInProject,
    saveRoomTypeRevision,
  ]);

  const handleSaveCurrentProject = useCallback(async (): Promise<boolean> => {
    if (!canEdit) {
      onReadOnlyAction?.();
      return false;
    }
    return onSaveProjectDraft((current) => syncProjectRoomTypeLinks(current, { devices }));
  }, [canEdit, devices, onReadOnlyAction, onSaveProjectDraft]);

  const handleUpdateRevisionMetadata = useCallback((
    revisionIndex: number,
    patch: Partial<Pick<RoomTypeRevision, "revision" | "savedAt" | "savedBy" | "note">>,
  ): void => {
    if (!canEdit) {
      onReadOnlyAction?.();
      return;
    }
    updateActiveRoomType((rt) => {
      const currentRevision = rt.revisions[revisionIndex];
      if (!currentRevision) return rt;
      const nextRevisionLabel = patch.revision ?? currentRevision.revision;
      const revisions = rt.revisions.map((entry, index) =>
        index === revisionIndex
          ? {
              ...entry,
              ...patch,
              revision: nextRevisionLabel,
            }
          : entry,
      );
      return {
        ...rt,
        revision: rt.revision === currentRevision.revision ? nextRevisionLabel : rt.revision,
        revisions,
        updatedAt: new Date().toISOString(),
      };
    });
  }, [canEdit, onReadOnlyAction, updateActiveRoomType]);

  useEffect(() => {
    isSavingBatchRevisionRef.current = isSavingBatchRevision;
  }, [isSavingBatchRevision]);

  useEffect(() => {
    if (!batchRevisionDialogOpen) return;
    setBatchRevisionDrafts((drafts) => {
      const existingByRoomTypeId = new Map(drafts.map((draft) => [draft.roomTypeId, draft]));
      const nextDrafts = project.roomTypes.map((rt) => {
        const existing = existingByRoomTypeId.get(rt.id);
        const nextRevision = nextRoomTypeRevisionValue(rt);
        if (existing) {
          return revisionValidationMessage(rt, existing.revision)
            ? { ...existing, revision: nextRevision }
            : existing;
        }
        return {
          roomTypeId: rt.id,
          revision: nextRevision,
          note: "",
          selected: true,
        };
      });
      const unchanged =
        nextDrafts.length === drafts.length &&
        nextDrafts.every((draft, index) =>
          draft.roomTypeId === drafts[index]?.roomTypeId &&
          draft.revision === drafts[index]?.revision &&
          draft.note === drafts[index]?.note &&
          draft.selected === drafts[index]?.selected,
        );
      return unchanged ? drafts : nextDrafts;
    });
  }, [batchRevisionDialogOpen, project.roomTypes, revisionValidationMessage]);

  useEffect(() => {
    if (!batchRevisionDialogOpen) return;
    const dialog = batchRevisionDialogRef.current;
    const opener = batchRevisionOpenerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function focusableElements(): HTMLElement[] {
      if (!dialog) return [];
      return Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
    }

    const focusFrame = requestAnimationFrame(() => {
      const target = focusableElements()[0] ?? dialog;
      target?.focus();
    });

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        if (!isSavingBatchRevisionRef.current) {
          setBatchRevisionDialogOpen(false);
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusableElements();
      if (focusables.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      opener?.focus();
    };
  }, [batchRevisionDialogOpen]);

  const openBatchRevisionDialog = useCallback((): void => {
    if (!canEdit) {
      onReadOnlyAction?.();
      return;
    }
    if (project.roomTypes.length === 0) return;
    batchRevisionOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBatchRevisionDrafts(
      project.roomTypes.map((rt) => ({
        roomTypeId: rt.id,
        revision: nextRoomTypeRevisionValue(rt),
        note: "",
        selected: true,
      })),
    );
    setBatchRevisionError("");
    setBatchRevisionDialogOpen(true);
  }, [canEdit, onReadOnlyAction, project.roomTypes]);

  const updateBatchRevisionDraft = useCallback((
    roomTypeId: string,
    field: "revision" | "note",
    value: string,
  ): void => {
    setBatchRevisionDrafts((drafts) =>
      drafts.map((draft) =>
        draft.roomTypeId === roomTypeId ? { ...draft, [field]: value } : draft,
      ),
    );
  }, []);

  const setBatchRevisionDraftSelected = useCallback((roomTypeId: string, selected: boolean): void => {
    setBatchRevisionDrafts((drafts) =>
      drafts.map((draft) =>
        draft.roomTypeId === roomTypeId ? { ...draft, selected } : draft,
      ),
    );
  }, []);

  const setAllBatchRevisionDraftsSelected = useCallback((selected: boolean): void => {
    setBatchRevisionDrafts((drafts) => drafts.map((draft) => ({ ...draft, selected })));
  }, []);

  const handleSaveAllRevisions = useCallback(async (): Promise<void> => {
    if (!canEdit) {
      onReadOnlyAction?.();
      return;
    }
    const draftByRoomTypeId = new Map(batchRevisionDrafts.map((draft) => [draft.roomTypeId, draft]));
    const normalizedDrafts = project.roomTypes.map((rt) => {
      const draft = draftByRoomTypeId.get(rt.id);
      return {
        roomTypeId: rt.id,
        revision: (draft?.revision ?? nextRoomTypeRevisionValue(rt)).trim(),
        note: draft?.note ?? "",
        selected: draft?.selected ?? true,
      };
    }).filter((draft) => draft.selected);
    if (normalizedDrafts.length === 0) {
      setBatchRevisionError("Select at least one room type to save.");
      return;
    }
    const invalidDraft = normalizedDrafts.find((draft) => {
      const roomType = project.roomTypes.find((rt) => rt.id === draft.roomTypeId);
      return roomType ? revisionValidationMessage(roomType, draft.revision) !== "" : false;
    });
    if (invalidDraft) {
      const roomType = project.roomTypes.find((rt) => rt.id === invalidDraft.roomTypeId);
      setBatchRevisionError(roomType ? revisionValidationMessage(roomType, invalidDraft.revision) : "Update Revision is invalid.");
      return;
    }

    const normalizedDraftByRoomTypeId = new Map(normalizedDrafts.map((draft) => [draft.roomTypeId, draft]));
    isSavingBatchRevisionRef.current = true;
    setIsSavingBatchRevision(true);
    setBatchRevisionError("");
    let saveValidationError = "";
    const saved = await onSaveProjectRevision((current) => {
      const currentDrafts = current.roomTypes.map((rt) => {
        const visibleDraft = normalizedDraftByRoomTypeId.get(rt.id);
        return {
          roomTypeId: rt.id,
          revision: (visibleDraft?.revision ?? nextRoomTypeRevisionValue(rt)).trim(),
          note: visibleDraft?.note ?? "",
          selected: Boolean(visibleDraft),
        };
      }).filter((draft) => draft.selected);
      if (currentDrafts.length === 0) {
        saveValidationError = "Select at least one room type to save.";
        return null;
      }
      const currentInvalidDraft = currentDrafts.find((draft) => {
        const roomType = current.roomTypes.find((rt) => rt.id === draft.roomTypeId);
        return roomType ? revisionValidationMessage(roomType, draft.revision) !== "" : false;
      });
      if (currentInvalidDraft) {
        const roomType = current.roomTypes.find((rt) => rt.id === currentInvalidDraft.roomTypeId);
        saveValidationError = roomType
          ? revisionValidationMessage(roomType, currentInvalidDraft.revision)
          : "Update Revision is invalid.";
        return null;
      }

      const currentDraftByRoomTypeId = new Map(currentDrafts.map((draft) => [draft.roomTypeId, draft]));
      return syncProjectRoomTypeLinks(
        {
          ...current,
          roomTypes: current.roomTypes.map((rt) => {
            const draft = currentDraftByRoomTypeId.get(rt.id);
            if (!draft) return rt;
            return {
              ...saveRoomTypeRevision(rt, circuitsForRoomType(current, rt), {
                clearInspectionMarks: true,
                note: draft.note,
                revisionOverride: draft.revision,
              }),
              updatedAt: new Date().toISOString(),
            };
          }),
        },
        { devices },
      );
    });
    isSavingBatchRevisionRef.current = false;
    setIsSavingBatchRevision(false);
    if (saveValidationError) {
      setBatchRevisionError(saveValidationError);
      return;
    }
    if (!saved) {
      setBatchRevisionError("The revisions could not be saved. Keep editing and try again.");
      return;
    }
    setBatchRevisionDialogOpen(false);
    setBatchRevisionDrafts([]);
  }, [
    batchRevisionDrafts,
    canEdit,
    devices,
    onReadOnlyAction,
    onSaveProjectRevision,
    project.roomTypes,
    revisionValidationMessage,
    saveRoomTypeRevision,
  ]);

  const buildProjectWithRestoredRoomType = useCallback((
    sourceProject: ProjectData,
    sourceRoomType: RoomType,
    targetRevision: RoomTypeRevision,
  ): ProjectData | null => {
    const snapshot = parseRevisionSnapshot(targetRevision.snapshot);
    if (!snapshot) return null;
    const scopedIds = sourceRoomType.circuitIds;
    const snapshotCircuits = snapshot.circuits;
    let circuits = snapshotCircuits ?? sourceProject.circuits;
    let restoredCircuitIds = sourceRoomType.circuitIds;
    if (snapshotCircuits && Array.isArray(scopedIds)) {
      const currentScopedIds = new Set(scopedIds);
      const nextById = new Map(snapshotCircuits.map((circuit) => [circuit.id, circuit]));
      circuits = sourceProject.circuits.flatMap((circuit) => {
        if (!currentScopedIds.has(circuit.id)) return [circuit];
        const replacement = nextById.get(circuit.id);
        nextById.delete(circuit.id);
        return replacement ? [replacement] : [];
      });
      circuits.push(...nextById.values());
      restoredCircuitIds = snapshotCircuits.map((circuit) => circuit.id);
    }
    return {
      ...sourceProject,
      circuits,
      roomTypes: sourceProject.roomTypes.map((rt) =>
        rt.id === sourceRoomType.id
          ? {
              ...rt,
              circuitIds: restoredCircuitIds,
              revision: targetRevision.revision,
              updatedAt: new Date().toISOString(),
              revisions: rt.revisions,
              rows: snapshot.rows ?? rt.rows,
              dryContacts: snapshot.dryContacts ?? rt.dryContacts ?? [],
              deviceAssignments: snapshot.deviceAssignments ?? rt.deviceAssignments,
              hvacAssignments: snapshot.hvacAssignments ?? rt.hvacAssignments,
              hvacSeasons: snapshot.hvacSeasons ?? rt.hvacSeasons,
              curtainAssignments: snapshot.curtainAssignments ?? rt.curtainAssignments ?? [],
              cfsRowDisplay: snapshot.cfsRowDisplay ?? rt.cfsRowDisplay,
              backlightLevels: snapshot.backlightLevels ?? rt.backlightLevels ?? backlightLevelsFromSwitches(snapshot.switches ?? rt.switches),
              scenes: snapshot.scenes ?? rt.scenes,
              roomScenes: snapshot.roomScenes ?? rt.roomScenes,
              switches: snapshot.switches ?? rt.switches,
              pduDeviceCounts: snapshot.pduDeviceCounts ?? rt.pduDeviceCounts,
              inspectionMarks: snapshot.inspectionMarks ?? rt.inspectionMarks ?? [],
            }
          : rt,
      ),
    };
  },
    [],
  );

  const restoreActiveRoomTypeToRevision = useCallback(
    (targetRevision: RoomTypeRevision): boolean => {
      if (!activeRoomType) return false;
      let restored = false;
      updateProject((p) => {
        const nextProject = buildProjectWithRestoredRoomType(p, activeRoomType, targetRevision);
        if (!nextProject) return p;
        restored = true;
        return nextProject;
      });
      if (!restored) {
        window.alert("This revision snapshot could not be restored.");
        return false;
      }
      setShowRevisionChanges(false);
      return true;
    },
    [activeRoomType, buildProjectWithRestoredRoomType, updateProject],
  );

  const completeFinishFlow = useCallback(
    async (exitAction: FinishRevisionExitAction): Promise<void> => {
      await collaboration.finishEditing({ bypassGuard: true });
      setFinishRevisionExitAction("stay");
      if (exitAction === "back") {
        onBackToProjects();
      }
    },
    [collaboration, onBackToProjects],
  );

  const openFinishRevisionDialog = useCallback((idle: boolean, exitAction: FinishRevisionExitAction = "stay"): void => {
    setFinishRevisionExitAction(exitAction);
    setFinishRevisionDialogIdle(idle);
    setFinishRevisionError("");
    setFinishRevisionNote("");
    setFinishRevisionDialogOpen(true);
  }, []);

  const handleFinishWithRevision = useCallback(async (): Promise<void> => {
    const exitAction = finishRevisionExitAction;
    setIsFinishingRevision(true);
    setFinishRevisionError("");
    const saved = await saveDraftRoomTypeRevisions({ clearInspectionMarks: false, note: finishRevisionNote });
    if (!saved) {
      setFinishRevisionError("The revision could not be saved. Keep editing and try again.");
      setIsFinishingRevision(false);
      return;
    }
    setFinishRevisionDialogOpen(false);
    setFinishRevisionNote("");
    setIsFinishingRevision(false);
    await completeFinishFlow(exitAction);
  }, [completeFinishFlow, finishRevisionExitAction, finishRevisionNote, saveDraftRoomTypeRevisions]);

  const handleFinishWithCurrentProject = useCallback(async (): Promise<void> => {
    const exitAction = finishRevisionExitAction;
    setIsFinishingRevision(true);
    setFinishRevisionError("");
    const saved = await handleSaveCurrentProject();
    if (!saved) {
      setFinishRevisionError("The current project could not be saved. Keep editing and try again.");
      setIsFinishingRevision(false);
      return;
    }
    setFinishRevisionDialogOpen(false);
    setFinishRevisionNote("");
    setIsFinishingRevision(false);
    await completeFinishFlow(exitAction);
  }, [completeFinishFlow, finishRevisionExitAction, handleSaveCurrentProject]);

  const handleDiscardDraftAndFinish = useCallback(async (): Promise<void> => {
    const exitAction = finishRevisionExitAction;
    if (revisionDraftRoomTypes.some((rt) => !rt.revisions?.length)) {
      setFinishRevisionError("There is no saved revision to restore.");
      return;
    }
    setIsFinishingRevision(true);
    setFinishRevisionError("");
    const saved = await onSaveProjectDraft((current) => {
      const draftIds = current.roomTypes
        .filter((rt) => roomTypeHasRevisionDraftInProject(current, rt))
        .map((rt) => rt.id);
      let restoredProject: ProjectData = current;
      for (const roomTypeId of draftIds) {
        const roomType = restoredProject.roomTypes.find((rt) => rt.id === roomTypeId);
        const latestRevision = roomType?.revisions?.at(-1);
        if (!roomType || !latestRevision) return null;
        const nextProject = buildProjectWithRestoredRoomType(restoredProject, roomType, latestRevision);
        if (!nextProject) return null;
        restoredProject = nextProject;
      }
      return syncProjectRoomTypeLinks(restoredProject, { devices });
    });
    if (!saved) {
      setFinishRevisionError("The latest revision could not be restored. Keep editing and try again.");
      setIsFinishingRevision(false);
      return;
    }
    setShowRevisionChanges(false);
    setFinishRevisionDialogOpen(false);
    setFinishRevisionNote("");
    setIsFinishingRevision(false);
    await completeFinishFlow(exitAction);
  }, [
    buildProjectWithRestoredRoomType,
    completeFinishFlow,
    devices,
    finishRevisionExitAction,
    onSaveProjectDraft,
    revisionDraftRoomTypes,
    roomTypeHasRevisionDraftInProject,
  ]);

  useEffect(() => {
    collaboration.setFinishGuard(async ({ idle }) => {
      if (revisionDraftRoomTypes.length === 0) return true;
      if (idle) {
        setIsFinishingRevision(true);
        setFinishRevisionError("");
        const saved = await saveDraftRoomTypeRevisions({
          clearInspectionMarks: false,
          note: IDLE_AUTO_SAVE_REVISION_NOTE,
        });
        setIsFinishingRevision(false);
        if (saved) return true;
        openFinishRevisionDialog(true, "stay");
        setFinishRevisionError("Idle auto-save failed. Choose how to finish this editing session.");
        return false;
      }
      openFinishRevisionDialog(false, "stay");
      return false;
    });
    return () => collaboration.setFinishGuard(null);
  }, [collaboration, openFinishRevisionDialog, revisionDraftRoomTypes.length, saveDraftRoomTypeRevisions]);

  const handleBackToProjectList = useCallback((): void => {
    if (collaboration.mode !== "edit") {
      onBackToProjects();
      return;
    }
    if (revisionDraftRoomTypes.length > 0) {
      openFinishRevisionDialog(false, "back");
      return;
    }
    void (async () => {
      await collaboration.finishEditing({ bypassGuard: true });
      onBackToProjects();
    })();
  }, [collaboration, onBackToProjects, openFinishRevisionDialog, revisionDraftRoomTypes.length]);

  const handlePrepareInspectionStart = useCallback((choice: InspectionRevisionChoice): boolean => {
    if (!canEdit) {
      onReadOnlyAction?.();
      return false;
    }
    if (!activeRoomType) return false;
    if (choice === "newRevision") void handleSaveRevision({ clearInspectionMarks: false });
    return true;
  }, [activeRoomType, handleSaveRevision, canEdit, onReadOnlyAction]);

  const inspectionRevisionTargets = useMemo<InspectionRevisionTarget[]>(() => {
    const entryByRoomTypeId = new Map(inspectionSessionEntries.map((entry) => [entry.roomTypeId, entry]));
    return project.roomTypes.flatMap((rt) => {
      const entry = entryByRoomTypeId.get(rt.id);
      if (!entry?.touched) return [];
      return [{
        roomTypeId: rt.id,
        name: rt.name || "Room Type",
        currentRevision: rt.revision || "-",
        revision: entry.revision || nextRoomTypeRevisionValue(rt),
        note: entry.note,
        selected: entry.selected,
      }];
    });
  }, [inspectionSessionEntries, project.roomTypes]);

  const handleInspectionModeStart = useCallback((roomTypeId: string, payload: InspectionCompletionPayload): void => {
    const roomType = project.roomTypes.find((rt) => rt.id === roomTypeId);
    setInspectionSessionEntries([{
      roomTypeId,
      baseline: cloneProjectData(payload),
      touched: false,
      revision: roomType ? nextRoomTypeRevisionValue(roomType) : "1.01",
      note: "",
      selected: true,
    }]);
  }, [project.roomTypes]);

  const handleInspectionRoomTypeEnter = useCallback((roomTypeId: string, payload: InspectionCompletionPayload): void => {
    setInspectionSessionEntries((entries) => {
      if (entries.some((entry) => entry.roomTypeId === roomTypeId)) return entries;
      const roomType = project.roomTypes.find((rt) => rt.id === roomTypeId);
      return [
        ...entries,
        {
          roomTypeId,
          baseline: cloneProjectData(payload),
          touched: false,
          revision: roomType ? nextRoomTypeRevisionValue(roomType) : "1.01",
          note: "",
          selected: true,
        },
      ];
    });
  }, [project.roomTypes]);

  const handleInspectionLiveChange = useCallback((
    roomTypeId: string,
    payload: InspectionCompletionPayload,
    options: { hasDraft: boolean },
  ): void => {
    setInspectionSessionEntries((entries) => {
      const existing = entries.find((entry) => entry.roomTypeId === roomTypeId);
      const roomType = project.roomTypes.find((rt) => rt.id === roomTypeId);
      const baseline = existing?.baseline ?? cloneProjectData(payload);
      const touched = existing
        ? !inspectionPayloadsEqual(baseline, payload)
        : options.hasDraft;
      const nextEntry: InspectionSessionEntry = {
        roomTypeId,
        baseline,
        touched,
        revision: existing?.revision || (roomType ? nextRoomTypeRevisionValue(roomType) : "1.01"),
        note: existing?.note ?? "",
        selected: existing?.selected ?? true,
      };
      if (!existing) return [...entries, nextEntry];
      return entries.map((entry) => (entry.roomTypeId === roomTypeId ? nextEntry : entry));
    });

    updateProject((p) => {
      let changed = false;
      const roomTypes = p.roomTypes.map((rt) => {
        if (rt.id !== roomTypeId) return rt;
        const currentPayload: InspectionCompletionPayload = {
          scenes: rt.scenes,
          roomScenes: rt.roomScenes,
          switches: rt.switches,
          inspectionMarks: rt.inspectionMarks ?? [],
        };
        if (inspectionPayloadsEqual(currentPayload, payload)) return rt;
        changed = true;
        return { ...applyInspectionPayloadToRoomType(rt, payload), updatedAt: new Date().toISOString() };
      });
      return changed ? { ...p, roomTypes } : p;
    });
  }, [project.roomTypes, updateProject]);

  const handleInspectionRevisionTargetChange = useCallback((
    roomTypeId: string,
    patch: Partial<Pick<InspectionRevisionTarget, "selected" | "revision" | "note">>,
  ): void => {
    setInspectionSessionEntries((entries) =>
      entries.map((entry) =>
        entry.roomTypeId === roomTypeId
          ? { ...entry, ...patch }
          : entry,
      ),
    );
  }, []);

  const handleCompleteInspection = useCallback(
    (payload: InspectionCompletionPayload, options: InspectionCompletionOptions): boolean => {
      if (!canEdit) {
        onReadOnlyAction?.();
        return false;
      }
      if (!activeRoomTypeId) return false;

      if (options.saveAsNewRevision) {
        const entryByRoomTypeId = new Map(inspectionSessionEntries.map((entry) => [entry.roomTypeId, entry]));
        const selectedRoomTypeIds = new Set(
          inspectionSessionEntries
            .filter((entry) => entry.touched && entry.selected)
            .map((entry) => entry.roomTypeId),
        );
        if (selectedRoomTypeIds.size === 0) selectedRoomTypeIds.add(activeRoomTypeId);

        const invalidRoomType = project.roomTypes.find((rt) => {
          if (!selectedRoomTypeIds.has(rt.id)) return false;
          const entry = entryByRoomTypeId.get(rt.id);
          const revision = normalizedRevisionValue(entry?.revision, nextRoomTypeRevisionValue(rt));
          return revisionValidationMessage(rt, revision) !== "";
        });
        if (invalidRoomType) {
          const entry = entryByRoomTypeId.get(invalidRoomType.id);
          const revision = normalizedRevisionValue(entry?.revision, nextRoomTypeRevisionValue(invalidRoomType));
          window.alert(revisionValidationMessage(invalidRoomType, revision));
          return false;
        }

        void (async () => {
          let saveValidationError = "";
          const saved = await onSaveProjectRevision((current) => {
            const currentInvalidRoomType = current.roomTypes.find((rt) => {
              if (!selectedRoomTypeIds.has(rt.id)) return false;
              const entry = entryByRoomTypeId.get(rt.id);
              const revision = normalizedRevisionValue(entry?.revision, nextRoomTypeRevisionValue(rt));
              return revisionValidationMessage(rt, revision) !== "";
            });
            if (currentInvalidRoomType) {
              const entry = entryByRoomTypeId.get(currentInvalidRoomType.id);
              const revision = normalizedRevisionValue(entry?.revision, nextRoomTypeRevisionValue(currentInvalidRoomType));
              saveValidationError = revisionValidationMessage(currentInvalidRoomType, revision);
              return null;
            }

            return syncProjectRoomTypeLinks(
              {
                ...current,
                roomTypes: current.roomTypes.map((rt) => {
                  let nextRoomType = rt.id === activeRoomTypeId
                    ? applyInspectionPayloadToRoomType(rt, payload)
                    : rt;
                  if (selectedRoomTypeIds.has(rt.id)) {
                    const entry = entryByRoomTypeId.get(rt.id);
                    nextRoomType = saveRoomTypeRevision(nextRoomType, circuitsForRoomType(current, nextRoomType), {
                      clearInspectionMarks: false,
                      note: entry?.note ?? "",
                      revisionOverride: entry?.revision,
                    });
                  }
                  return nextRoomType === rt
                    ? rt
                    : { ...nextRoomType, updatedAt: new Date().toISOString() };
                }),
              },
              { devices },
            );
          });
          if (saveValidationError) {
            window.alert(saveValidationError);
            return;
          }
          if (!saved) {
            window.alert("The inspection revisions could not be saved. Keep editing and try again.");
            return;
          }
          setInspectionSessionEntries([]);
          setShowRevisionChanges(true);
        })();
      } else {
        updateActiveRoomType((rt) => applyInspectionPayloadToRoomType(rt, payload));
        setInspectionSessionEntries([]);
      }
      return true;
    },
    [
      activeRoomTypeId,
      canEdit,
      devices,
      inspectionSessionEntries,
      onReadOnlyAction,
      onSaveProjectRevision,
      project.roomTypes,
      revisionValidationMessage,
      saveRoomTypeRevision,
      updateActiveRoomType,
    ],
  );

  const handleRestoreRevision = useCallback(
    (revisionIndex: number): void => {
      if (!canEdit) {
        onReadOnlyAction?.();
        return;
      }
      const targetRevision = activeRoomType?.revisions?.[revisionIndex];
      if (!targetRevision) return;

      const message =
        `Load revision ${targetRevision.revision}? Revision history will be kept, but current draft changes will be replaced.`;
      if (!window.confirm(message)) return;

      restoreActiveRoomTypeToRevision(targetRevision);
    },
    [activeRoomType, restoreActiveRoomTypeToRevision, canEdit, onReadOnlyAction],
  );

  const setDeviceAssignments = useCallback(
    (next: DeviceAssignment[]): void => {
      updateActiveRoomType((rt) => ({ ...rt, deviceAssignments: next }));
    },
    [updateActiveRoomType],
  );

  const setDryContacts = useCallback(
    (next: DryContactEntry[]): void => {
      updateActiveRoomType((rt) => {
        const previous = rt.dryContacts ?? [];
        const previousByCircuit = new Map(
          previous
            .map((entry) => [entry.circuit.trim().toLowerCase(), entry] as const)
            .filter(([key]) => key !== ""),
        );
        const nextById = new Map(next.map((entry) => [entry.id, entry] as const));
        const nextByCircuit = new Map(
          next
            .map((entry) => [entry.circuit.trim().toLowerCase(), entry] as const)
            .filter(([key]) => key !== ""),
        );
        const deviceAssignments = rt.deviceAssignments.map((assignment) => {
          if (!isCcoAssignment(assignment)) return assignment;
          const assigned = assignment.circuitNumber.trim();
          if (!assigned || assigned === RESERVED_VALUE) return assignment;
          const previousEntry = previousByCircuit.get(assigned.toLowerCase());
          const nextEntry = previousEntry ? nextById.get(previousEntry.id) : nextByCircuit.get(assigned.toLowerCase());
          const nextCircuit = nextEntry?.circuit.trim() ?? "";
          if (!nextEntry || !nextCircuit) return assignment;
          const previousAutoDetail = previousEntry
            ? previousEntry.detail.trim() || previousEntry.circuit.trim()
            : assigned;
          const nextAutoDetail = nextEntry.detail.trim() || nextCircuit;
          const detail = assignment.detail.trim();
          const detailWasAuto = !detail || detail === previousAutoDetail || detail === assigned;
          return {
            ...assignment,
            area: nextEntry.area,
            circuitNumber: nextCircuit,
            detail: detailWasAuto ? nextAutoDetail : assignment.detail,
          };
        });
        return { ...rt, dryContacts: next, deviceAssignments };
      });
    },
    [updateActiveRoomType],
  );

  const setHvacAssignments = useCallback(
    (next: HvacAssignment[]): void => {
      updateActiveRoomType((rt) => ({ ...rt, hvacAssignments: next }));
    },
    [updateActiveRoomType],
  );

  const setHvacSeasons = useCallback(
    (next: HvacSeason[]): void => {
      updateActiveRoomType((rt) => ({ ...rt, hvacSeasons: next }));
    },
    [updateActiveRoomType],
  );

  const setCurtainAssignments = useCallback(
    (next: CurtainAssignment[]): void => {
      updateActiveRoomType((rt) => ({ ...rt, curtainAssignments: next }));
    },
    [updateActiveRoomType],
  );

  const setCfsRowDisplay = useCallback(
    (next: CfsRowDisplaySettings): void => {
      updateActiveRoomType((rt) => ({ ...rt, cfsRowDisplay: next }));
    },
    [updateActiveRoomType],
  );

  const setBacklightLevels = useCallback(
    (next: BacklightLevelSetting[] | ((current: BacklightLevelSetting[]) => BacklightLevelSetting[])): void => {
      updateActiveRoomType((rt) => ({
        ...rt,
        backlightLevels: typeof next === "function" ? next(rt.backlightLevels ?? []) : next,
      }));
    },
    [updateActiveRoomType],
  );

  const setScenes = useCallback(
    (next: Scene[]): void => {
      updateActiveRoomType((rt) => ({ ...rt, scenes: next }));
    },
    [updateActiveRoomType],
  );

  const setRoomScenes = useCallback(
    (next: RoomScene[] | ((current: RoomScene[]) => RoomScene[])): void => {
      updateActiveRoomType((rt) => ({
        ...rt,
        roomScenes: typeof next === "function" ? next(rt.roomScenes) : next,
      }));
    },
    [updateActiveRoomType],
  );

  const setSwitches = useCallback(
    // Accepts an updater so child views can apply changes against the CURRENT
    // switches instead of a prop snapshot; array snapshots computed from stale
    // props were overwriting just-made edits (e.g. Palladiom By-Scene).
    (next: SwitchEntry[] | ((current: SwitchEntry[]) => SwitchEntry[])): void => {
      updateActiveRoomType((rt) => ({
        ...rt,
        switches: typeof next === "function" ? next(rt.switches) : next,
      }));
    },
    [updateActiveRoomType],
  );

  const setPduDeviceCounts = useCallback(
    (next: PduDeviceCount[]): void => {
      updateActiveRoomType((rt) => ({ ...rt, pduDeviceCounts: next }));
    },
    [updateActiveRoomType],
  );

  const setInspectionMarks = useCallback(
    (next: InspectionMark[]): void => {
      updateActiveRoomType((rt) => ({ ...rt, inspectionMarks: next }));
    },
    [updateActiveRoomType],
  );

  const setProgrammingNameSettings = useCallback(
    (next: ProgrammingNameSettings): void => {
      updateProject((p) => ({
        ...p,
        settings: {
          ...(p.settings ?? {}),
          programmingName: next,
        },
      }));
    },
    [updateProject],
  );

  // ---- Tabs ----
  const parentTabs: TabDef[] = [
    { id: "area", label: "Area" },
    { id: "fixture", label: "Fixture" },
    { id: "rooms", label: "Room Type" },
  ];

  // Room type selector row (sits between parent tabs and sub tabs).
  const roomTypeTabs: TabDef[] = [
    ...project.roomTypes.map((rt) => ({ id: rt.id, label: rt.name || "(Untitled)" })),
    { id: ROOM_TYPE_MANAGE_ID, label: "+ Manage" },
  ];

  const subTabsDisabled = !activeRoomType;
  const subTabs: TabDef[] = [
    {
      id: "pdu",
      label: "PDU",
      disabled: subTabsDisabled,
      highlighted: highlightedSubTabs.has("pdu"),
    },
    {
      id: "circuit",
      label: "Circuit",
      disabled: subTabsDisabled,
      highlighted: highlightedSubTabs.has("circuit"),
    },
    {
      id: "deviceAssign",
      label: "Device Assign",
      disabled: subTabsDisabled,
      highlighted: highlightedSubTabs.has("deviceAssign"),
    },
    {
      id: "areaScene",
      label: "Area Scene",
      disabled: subTabsDisabled,
      highlighted: highlightedSubTabs.has("areaScene"),
    },
    {
      id: "scene",
      label: "Scene",
      disabled: subTabsDisabled,
      highlighted: highlightedSubTabs.has("scene"),
    },
    {
      id: "switch",
      label: "Switch",
      disabled: subTabsDisabled,
      highlighted: highlightedSubTabs.has("switch"),
    },
    {
      id: "command",
      label: "Command",
      disabled: subTabsDisabled,
      highlighted: highlightedSubTabs.has("command"),
    },
    {
      id: "backlight",
      label: "Backlight",
      disabled: subTabsDisabled,
      highlighted: highlightedSubTabs.has("backlight"),
    },
    {
      id: "cfs",
      label: "CFS",
      disabled: subTabsDisabled,
      highlighted: highlightedSubTabs.has("cfs"),
    },
  ];

  const batchRevisionDraftByRoomTypeId = useMemo(
    () => new Map(batchRevisionDrafts.map((draft) => [draft.roomTypeId, draft])),
    [batchRevisionDrafts],
  );
  const batchRevisionSelectedCount = project.roomTypes.reduce((count, rt) => {
    const draft = batchRevisionDraftByRoomTypeId.get(rt.id);
    return count + (draft?.selected ?? true ? 1 : 0);
  }, 0);
  const allBatchRevisionsSelected =
    project.roomTypes.length > 0 && batchRevisionSelectedCount === project.roomTypes.length;
  const someBatchRevisionsSelected = batchRevisionSelectedCount > 0;
  const saveInProgress =
    saveStatus === "savingDraft" || saveStatus === "savingProject" || saveStatus === "savingRevision";
  const draftStatusTime =
    lastSavedAt && (saveStatus === "draftSaved" || saveStatus === "projectSaved" || saveStatus === "revisionSaved")
      ? lastSavedAt
      : "";
  const draftStatusTitle =
    saveStatus === "savingDraft"
      ? "Saving local draft"
      : saveStatus === "draftSaved"
        ? lastSavedAt
          ? `Local draft saved at ${lastSavedAt}`
          : "Local draft saved"
        : saveStatus === "savingProject"
          ? "Saving current project"
          : saveStatus === "projectSaved"
            ? lastSavedAt
              ? `Current project saved at ${lastSavedAt}`
              : "Current project saved"
            : saveStatus === "savingRevision"
              ? "Saving revision"
              : saveStatus === "revisionSaved"
                ? lastSavedAt
                  ? `Revision saved at ${lastSavedAt}`
                  : "Revision saved"
                : saveStatus === "error"
                  ? "Save failed"
                  : draftStatusTime
                    ? `Draft saved at ${draftStatusTime}`
                    : "Draft";
  const draftStatusLabel = saveStatus === "error" ? "Error" : saveStatus === "projectSaved" ? "Saved" : "Draft";
  const draftStatusAria =
    draftStatusTime ? `${draftStatusLabel} ${draftStatusTime}. ${draftStatusTitle}` : draftStatusTitle;
  const canRestoreLatestRevisionOnFinish =
    revisionDraftRoomTypes.length > 0 && revisionDraftRoomTypes.every((rt) => Boolean(rt.revisions?.length));

  useEffect(() => {
    if (!batchRevisionSelectAllRef.current) return;
    batchRevisionSelectAllRef.current.indeterminate = someBatchRevisionsSelected && !allBatchRevisionsSelected;
  }, [allBatchRevisionsSelected, someBatchRevisionsSelected]);

  return (
    <main className={`app-shell project-screen-shell${canEdit ? "" : " is-view-only"}`}>
      {isTopUiCollapsed ? (
        <button
          type="button"
          className="top-ui-restore-button"
          onClick={() => setIsTopUiCollapsed(false)}
          title="Show top bar"
          aria-label="Show top bar"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 18h16" />
            <path d="M4 12h16" />
            <path d="M8 8l4-4 4 4" />
          </svg>
        </button>
      ) : null}
      <div className="project-top-toolbar" aria-label="Project top controls">
        <nav className="breadcrumb project-top-breadcrumb fade-in">
          <button className="breadcrumb-link" onClick={handleBackToProjectList}>Back to Project List</button>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-current">{project.name}</span>
        </nav>
        <div className="project-top-action-groups">
          <CollaborationBar collaboration={collaboration} compact />
          <div className="history-controls" aria-label="History controls">
            <button
              type="button"
              className="history-button history-icon-button"
              onClick={handleUndo}
              disabled={!canUndo || !canEdit}
              title="Undo"
              aria-label="Undo"
            >
              <ActionIcon name="undo" />
            </button>
            <button
              type="button"
              className="history-button history-icon-button"
              onClick={handleRedo}
              disabled={!canRedo || !canEdit}
              title="Redo"
              aria-label="Redo"
            >
              <ActionIcon name="redo" />
            </button>
            <div className="revision-top-controls">
              {activeRoomType ? (
                <span className="muted-pill">
                  {activeRoomType.name || "Room Type"} Revision {activeRoomType.revision || "1.00"}
                </span>
              ) : null}
              {activeRoomType ? (
                <span
                  className="muted-pill revision-save-status"
                  aria-live="polite"
                  aria-label={draftStatusAria}
                  title={draftStatusTitle}
                >
                  <span className="revision-save-status-label">{draftStatusLabel}</span>
                  {draftStatusTime ? <span className="revision-save-status-time">{draftStatusTime}</span> : null}
                </span>
              ) : null}
              <button
                type="button"
                className="history-button history-icon-button save-current-button"
                onClick={() => void handleSaveCurrentProject()}
                disabled={!canEdit || saveInProgress}
                title="Save current project without a new revision"
                aria-label="Save current project without a new revision"
              >
                <ActionIcon name="save" />
              </button>
              <button
                type="button"
                className="history-button history-icon-button save-revision-button"
                onClick={openBatchRevisionDialog}
                disabled={project.roomTypes.length === 0 || !canEdit || saveInProgress}
                title={project.roomTypes.length > 0 ? "Save all room types as new revisions" : "Create a room type to save a revision"}
                aria-label={project.roomTypes.length > 0 ? "Save all room types as new revisions" : "Create a room type to save a revision"}
              >
                <ActionIcon name="save" />
              </button>
              <button
                type="button"
                className="history-button history-icon-button revision-management-button"
                onClick={() => setShowRevisionManager((value) => !value)}
                disabled={!activeRoomType}
                title={activeRoomType ? "Open revision management" : "Select a room type to manage revisions"}
                aria-label={activeRoomType ? "Open revision management" : "Select a room type to manage revisions"}
              >
                <ActionIcon name="history" />
              </button>
              <button
                type="button"
                className={`history-button history-icon-button update-highlights-button${showRevisionChanges ? " is-active" : ""}`}
                onClick={() => setShowRevisionChanges((value) => !value)}
                disabled={!activeRoomType || activeRoomTypeRevisionCount < 1}
                aria-pressed={showRevisionChanges}
                aria-label={showRevisionChanges ? "Turn off update highlights" : "Turn on update highlights"}
                title={
                  !activeRoomType
                    ? "Select a room type to highlight updates"
                    : activeRoomTypeRevisionCount < 1
                      ? "Save a revision before highlighting updates"
                      : showRevisionChanges
                        ? "Turn off update highlights"
                        : activeRoomTypeRevisionCount > 1
                          ? "Highlight current draft changes, or the latest saved revision changes when the draft is unchanged"
                          : "Highlight current draft changes from the saved revision"
                }
              >
                <ActionIcon name="highlight" />
              </button>
            </div>
            <button
              type="button"
              className="history-button history-icon-button top-ui-collapse-button"
              onClick={() => setIsTopUiCollapsed(true)}
              title="Hide top bar"
              aria-label="Hide top bar"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M4 6h16" />
                <path d="M4 12h16" />
                <path d="M8 16l4 4 4-4" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      {batchRevisionDialogOpen ? (
        <div className="modal-backdrop edit-finish-backdrop" role="presentation">
          <section
            ref={batchRevisionDialogRef}
            className="edit-finish-dialog revision-batch-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="revisionBatchTitle"
            tabIndex={-1}
          >
            <h2 id="revisionBatchTitle">Save Revision</h2>
            <p>Select the room types to update, then review the next revision number and memo for each selected row.</p>
            <div className="revision-batch-summary" aria-live="polite">
              <span>{batchRevisionSelectedCount} / {project.roomTypes.length} room types selected</span>
              <div className="revision-batch-bulk-actions">
                <button
                  type="button"
                  className="revision-batch-utility"
                  onClick={() => setAllBatchRevisionDraftsSelected(true)}
                  disabled={isSavingBatchRevision || allBatchRevisionsSelected}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="revision-batch-utility"
                  onClick={() => setAllBatchRevisionDraftsSelected(false)}
                  disabled={isSavingBatchRevision || !someBatchRevisionsSelected}
                >
                  Clear selection
                </button>
              </div>
            </div>
            <div className="revision-batch-table-wrap">
              <table className="mini-table revision-batch-table">
                <thead>
                  <tr>
                    <th className="revision-batch-select-heading">
                      <label className="revision-batch-select-all">
                        <input
                          ref={batchRevisionSelectAllRef}
                          type="checkbox"
                          checked={allBatchRevisionsSelected}
                          aria-checked={allBatchRevisionsSelected ? "true" : someBatchRevisionsSelected ? "mixed" : "false"}
                          onChange={(event) => setAllBatchRevisionDraftsSelected(event.target.checked)}
                          disabled={isSavingBatchRevision || project.roomTypes.length === 0}
                        />
                        <span>Save</span>
                      </label>
                    </th>
                    <th>Room Type</th>
                    <th>Current Revision</th>
                    <th>Update Revision</th>
                    <th>Memo</th>
                  </tr>
                </thead>
                <tbody>
                  {project.roomTypes.map((rt, index) => {
                    const draft = batchRevisionDraftByRoomTypeId.get(rt.id);
                    const draftRevision = draft?.revision ?? nextRoomTypeRevisionValue(rt);
                    const draftNote = draft?.note ?? "";
                    const draftSelected = draft?.selected ?? true;
                    const labelBase = rt.name || `Room Type ${index + 1}`;
                    return (
                      <tr key={rt.id} className={draftSelected ? "" : "is-unselected"}>
                        <td className="revision-batch-select-cell" data-label="Save">
                          <label className="revision-batch-row-check">
                            <input
                              type="checkbox"
                              checked={draftSelected}
                              onChange={(event) => setBatchRevisionDraftSelected(rt.id, event.target.checked)}
                              aria-label={`Save revision for ${labelBase}`}
                              disabled={isSavingBatchRevision}
                            />
                            <span>{draftSelected ? "Update" : "Skip"}</span>
                          </label>
                        </td>
                        <td className="revision-batch-room-name" data-label="Room Type">{labelBase}</td>
                        <td data-label="Current Revision">{rt.revision || "1.00"}</td>
                        <td data-label="Update Revision">
                          <input
                            className="revision-batch-revision-input"
                            value={draftRevision}
                            onChange={(event) => updateBatchRevisionDraft(rt.id, "revision", event.target.value)}
                            aria-label={`Update revision for ${labelBase}`}
                            disabled={isSavingBatchRevision || !draftSelected}
                            autoFocus={index === 0}
                          />
                        </td>
                        <td data-label="Memo">
                          <textarea
                            className="revision-batch-note-input"
                            value={draftNote}
                            onChange={(event) => updateBatchRevisionDraft(rt.id, "note", event.target.value)}
                            aria-label={`Memo for ${labelBase}`}
                            placeholder="Revision memo"
                            rows={2}
                            disabled={isSavingBatchRevision || !draftSelected}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {batchRevisionError ? <p className="edit-finish-error" role="alert">{batchRevisionError}</p> : null}
            <div className="edit-finish-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setBatchRevisionDialogOpen(false)}
                disabled={isSavingBatchRevision}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleSaveAllRevisions()}
                disabled={isSavingBatchRevision || batchRevisionSelectedCount === 0}
              >
                {isSavingBatchRevision ? "Saving revisions..." : "Save Revision"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {finishRevisionDialogOpen ? (
        <div className="modal-backdrop edit-finish-backdrop" role="presentation">
          <section className="edit-finish-dialog" role="dialog" aria-modal="true" aria-labelledby="finishRevisionTitle">
            <h2 id="finishRevisionTitle">Finish editing with draft changes?</h2>
            <p>
              {finishRevisionDialogIdle
                ? "This editing session is idle and has unpublished revision changes. Choose how to save or discard the draft before returning to View Only."
                : "This editing session has unpublished revision changes. Choose how to save or discard the draft before returning to View Only."}
            </p>
            <label className="revision-note-field">
              <span>Note</span>
              <textarea
                className="revision-note-input"
                value={finishRevisionNote}
                onChange={(event) => setFinishRevisionNote(event.target.value)}
                placeholder="Revision note"
                rows={4}
                disabled={isFinishingRevision}
              />
            </label>
            {finishRevisionError ? <p className="edit-finish-error" role="alert">{finishRevisionError}</p> : null}
            <div className="edit-finish-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setFinishRevisionDialogOpen(false);
                  setFinishRevisionNote("");
                }}
                disabled={isFinishingRevision}
              >
                Continue Editing
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void handleDiscardDraftAndFinish()}
                disabled={isFinishingRevision || !canRestoreLatestRevisionOnFinish}
                title={
                  canRestoreLatestRevisionOnFinish
                    ? "Discard draft changes and restore the latest saved revision"
                    : "No saved revision is available"
                }
              >
                {isFinishingRevision ? "Restoring..." : "Discard Draft & Restore Latest Rev"}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleFinishWithCurrentProject()}
                disabled={isFinishingRevision}
              >
                {isFinishingRevision ? "Saving..." : "Save Current & Finish"}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleFinishWithRevision()}
                disabled={isFinishingRevision}
              >
                {isFinishingRevision ? "Saving revision..." : "Save Revision & Finish"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      <div className="project-tabs-sticky">
        <TabsBar
          tabs={parentTabs}
          activeId={activeTab}
          onChange={(id) => {
            const next = id as ProjectTab;
            setActiveTab(next);
          }}
        />

        {activeTab === "rooms" ? (
          <>
            <TabsBar
              tabs={roomTypeTabs}
              activeId={activeRoomType ? activeRoomTypeId : ROOM_TYPE_MANAGE_ID}
              variant="sub"
              onChange={handleSelectRoomTypeTab}
            />
            {activeRoomType ? (
              <TabsBar
                tabs={subTabs}
                activeId={activeSubTab}
                variant="sub"
                onChange={(id) => setActiveSubTab(id as RoomsSubTab)}
              />
            ) : null}
          </>
        ) : null}
      </div>

      {activeRoomType && showRevisionManager ? (
        <div className="revision-manager-panel">
          {(activeRoomType.revisions?.length ?? 0) === 0 ? (
            <div className="screen-empty compact">No saved revisions yet.</div>
          ) : (
            <table className="mini-table revision-table">
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>Saved At</th>
                  <th>Saved By</th>
                  <th>Update Memo</th>
                  <th>Operation</th>
                </tr>
              </thead>
              <tbody>
                {displayedRevisions.map(({ revision, index }) => {
                  const storedNote = revision.note ?? "";
                  const autoNote = revisionAutoNoteAtIndex(activeRoomType, index);
                  const showAutoNote = autoNote.trim() !== "" && autoNote.trim() !== storedNote.trim();
                  return (
                    <tr key={revision.id}>
                      <td>
                        <input
                          className="revision-metadata-input"
                          value={revision.revision}
                          onChange={(event) => handleUpdateRevisionMetadata(index, { revision: event.target.value })}
                          aria-label={`Revision label for ${revision.revision || "saved revision"}`}
                          disabled={!canEdit}
                        />
                      </td>
                      <td>
                        <input
                          className="revision-metadata-input"
                          type="datetime-local"
                          value={revisionDateInputValue(revision.savedAt)}
                          onInput={(event) =>
                            handleUpdateRevisionMetadata(index, {
                              savedAt: revisionDateInputToIso(event.currentTarget.value, revision.savedAt),
                            })
                          }
                          onChange={(event) =>
                            handleUpdateRevisionMetadata(index, {
                              savedAt: revisionDateInputToIso(event.target.value, revision.savedAt),
                            })
                          }
                          aria-label={`Saved date for revision ${revision.revision || "saved revision"}`}
                          disabled={!canEdit}
                        />
                      </td>
                      <td>
                        <input
                          className="revision-metadata-input"
                          value={revision.savedBy ?? ""}
                          placeholder="-"
                          onChange={(event) => handleUpdateRevisionMetadata(index, { savedBy: event.target.value })}
                          aria-label={`Saved by for revision ${revision.revision || "saved revision"}`}
                          disabled={!canEdit}
                        />
                      </td>
                      <td>
                        <textarea
                          className="revision-metadata-note-input"
                          value={storedNote}
                          onChange={(event) => handleUpdateRevisionMetadata(index, { note: event.target.value })}
                          aria-label={`Memo for revision ${revision.revision || "saved revision"}`}
                          rows={2}
                          disabled={!canEdit}
                        />
                        {showAutoNote ? (
                          <div
                            className="revision-generated-note"
                            aria-label={`Automatic update memo for revision ${revision.revision || "saved revision"}`}
                          >
                            {renderRevisionNote(autoNote)}
                          </div>
                        ) : null}
                      </td>
                      <td className="col-center">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleRestoreRevision(index)}
                          disabled={!canEdit}
                          title="Load this revision while keeping revision history"
                        >
                          Restore
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {activeTab === "area" && (
        <LocationsView locations={project.locations} onChange={setLocations} />
      )}
      {activeTab === "fixture" && (
        <FixturesView fixtures={project.fixtures} onChange={setFixtures} />
      )}

      {activeTab === "rooms" && !activeRoomType && (
        <>
          <RoomsView
            roomTypes={project.roomTypes}
            onSelectRoomType={handleSelectRoomType}
            onCreateRoomType={handleCreateRoomType}
            onDuplicateRoomType={handleDuplicateRoomType}
            onExportLutronSpec={(id) => setLutronExportRoomTypeId(id)}
            onExportRoomTypeBackup={handleExportRoomTypeBackup}
            onRenameRoomType={handleRenameRoomType}
            onDeleteRoomType={handleDeleteRoomType}
            canEdit={canEdit}
          />
          {lutronExportRoomType ? (
            <section className="ld-export-panel fade-in">
              <div className="ld-export-panel-header">
                <div>
                  <p className="lutron-spec-kicker">LD Export</p>
                  <h2>{lutronExportRoomType.name}</h2>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setLutronExportRoomTypeId(null)}
                >
                  Close
                </button>
              </div>
              <LutronSpecView
                project={project}
                roomType={lutronExportRoomType}
              />
            </section>
          ) : null}
        </>
      )}

      {activeTab === "rooms" && activeRoomType && (
        <>
          {activeSubTab === "circuit" && (
            <CircuitsView
              circuits={activeRoomTypeCircuits}
              dryContacts={activeRoomType.dryContacts ?? []}
              fixtures={project.fixtures}
              locations={project.locations}
              onChange={setActiveRoomTypeCircuits}
              onDryContactsChange={setDryContacts}
              revisionChanges={revisionDiff?.circuitFields}
              dryContactRevisionChanges={revisionDiff?.dryContactFields}
              suggestions={projectCircuitSuggestions}
              canEdit={canEdit}
            />
          )}
          {activeSubTab === "deviceAssign" && (
            <DeviceAssignView
              assignments={activeRoomType.deviceAssignments}
              hvacAssignments={activeRoomType.hvacAssignments}
              hvacSeasons={activeRoomType.hvacSeasons}
              curtainAssignments={activeRoomType.curtainAssignments ?? []}
              devices={devices}
              inputMasters={inputMasters}
              fixtures={project.fixtures}
              locations={project.locations}
              circuits={activeRoomTypeCircuits}
              dryContacts={activeRoomType.dryContacts ?? []}
              onChange={setDeviceAssignments}
              onHvacAssignmentsChange={setHvacAssignments}
              onHvacSeasonsChange={setHvacSeasons}
              onCurtainAssignmentsChange={setCurtainAssignments}
              revisionChanges={revisionDiff?.assignmentFields}
              curtainRevisionChanges={revisionDiff?.curtainAssignmentFields}
              canEdit={canEdit}
            />
          )}
          {activeSubTab === "areaScene" && (
            <SceneView
              scenes={activeRoomType.scenes}
              locations={project.locations}
              circuits={activeRoomTypeCircuits}
              fixtures={project.fixtures}
              hvacAssignments={activeRoomType.hvacAssignments}
              hvacSeasons={activeRoomType.hvacSeasons}
              curtainAssignments={activeRoomType.curtainAssignments ?? []}
              switches={activeRoomType.switches}
              onChange={setScenes}
              revisionChanges={revisionDiff?.sceneFields}
              canEdit={canEdit}
            />
          )}
          {activeSubTab === "scene" && (
            <RoomSceneView
              roomScenes={activeRoomType.roomScenes}
              circuits={activeRoomTypeCircuits}
              scenes={activeRoomType.scenes}
              hvacAssignments={activeRoomType.hvacAssignments}
              hvacSeasons={activeRoomType.hvacSeasons}
              deviceAssignments={activeRoomType.deviceAssignments}
              cfsRows={activeRoomType.rows}
              curtainAssignments={activeRoomType.curtainAssignments ?? []}
              switches={activeRoomType.switches}
              backlightLevels={activeRoomType.backlightLevels}
              triggerMasters={triggerMasters}
              locations={project.locations}
              onChange={setRoomScenes}
              onSwitchesChange={setSwitches}
              revisionChanges={revisionDiff?.roomSceneFields}
              canEdit={canEdit}
            />
          )}
          {activeSubTab === "switch" && (
            <SwitchView
              key={activeRoomType.id}
              switches={activeRoomType.switches}
              backlightLevels={activeRoomType.backlightLevels}
              onBacklightLevelsChange={setBacklightLevels}
              scenes={activeRoomType.scenes}
              locations={project.locations}
              circuits={activeRoomTypeCircuits}
              deviceAssignments={activeRoomType.deviceAssignments}
              cfsRows={activeRoomType.rows}
              curtainAssignments={activeRoomType.curtainAssignments ?? []}
              hvacAssignments={activeRoomType.hvacAssignments}
              hvacSeasons={activeRoomType.hvacSeasons}
              triggerMasters={triggerMasters}
              activeKind={activeSwitchKind}
              onActiveKindChange={setActiveSwitchKind}
              onChange={setSwitches}
              revisionChanges={revisionDiff?.switchFields}
              canEdit={canEdit}
            />
          )}
          {activeSubTab === "command" && (
            <CommandView
              switches={activeRoomType.switches}
              scenes={activeRoomType.scenes}
              locations={project.locations}
              circuits={activeRoomTypeCircuits}
              deviceAssignments={activeRoomType.deviceAssignments}
              cfsRows={activeRoomType.rows}
              curtainAssignments={activeRoomType.curtainAssignments ?? []}
              hvacAssignments={activeRoomType.hvacAssignments}
              hvacSeasons={activeRoomType.hvacSeasons}
              backlightLevels={activeRoomType.backlightLevels}
              triggerMasters={triggerMasters}
              onChange={setSwitches}
              revisionChanges={revisionDiff?.switchFields}
              canEdit={canEdit}
            />
          )}
          {activeSubTab === "backlight" && (
            <BacklightView
              switches={activeRoomType.switches}
              backlightLevels={activeRoomType.backlightLevels}
              onChange={setSwitches}
              onBacklightLevelsChange={setBacklightLevels}
              roomScenes={activeRoomType.roomScenes}
              onRoomScenesChange={setRoomScenes}
              revisionChanges={revisionDiff?.switchFields}
              backlightLogicChanged={revisionDiff?.backlightLogicChanged}
              canEdit={canEdit}
            />
          )}
          {activeSubTab === "cfs" && (
            <CfsErrorBoundary
              projectName={project.name}
              roomTypeName={activeRoomType.name}
              resetKey={`${project.id}:${activeRoomType.id}`}
            >
              <CfsView
                projectName={project.name}
                roomType={activeRoomType}
                circuits={activeRoomTypeCircuits}
                devices={devices}
                locations={project.locations}
                onScenesChange={setScenes}
                onRoomScenesChange={setRoomScenes}
                onSwitchesChange={setSwitches}
                onInspectionMarksChange={setInspectionMarks}
                programmingNameSettings={project.settings?.programmingName}
                onProgrammingNameSettingsChange={setProgrammingNameSettings}
                onCfsRowDisplayChange={setCfsRowDisplay}
                onOpenExternalWindow={handleOpenCfsWindow}
                canEdit={canEdit}
                hasRevisionDraft={roomTypeHasRevisionDraft(activeRoomType)}
                onBeforeInspectionStart={handlePrepareInspectionStart}
                onInspectionModeStart={handleInspectionModeStart}
                onInspectionRoomTypeEnter={handleInspectionRoomTypeEnter}
                onInspectionLiveChange={handleInspectionLiveChange}
                onCompleteInspection={handleCompleteInspection}
                inspectionRevisionTargets={inspectionRevisionTargets}
                onInspectionRevisionTargetChange={handleInspectionRevisionTargetChange}
                onInspectionHistoryChange={handleInspectionHistoryChange}
                revisionDiff={revisionDiff}
              />
            </CfsErrorBoundary>
          )}
          {activeSubTab === "pdu" && (
            <PduView
              roomType={activeRoomType}
              devices={devices}
              fixtures={project.fixtures}
              circuits={activeRoomTypeCircuits}
              wattPerPdu={settings.wattPerPdu}
              onFixturesChange={setFixtures}
              onPduDeviceCountsChange={setPduDeviceCounts}
              onDeviceAssignmentsChange={setDeviceAssignments}
              onHvacAssignmentsChange={setHvacAssignments}
              onSwitchesChange={setSwitches}
              revisionChanges={revisionDiff?.pduDeviceCountFields}
            />
          )}
        </>
      )}
    </main>
  );
}
