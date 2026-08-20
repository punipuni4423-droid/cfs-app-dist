import type {
  CfsCircuit,
  CfsRowDisplaySettings,
  CircuitEntry,
  CollaborationEditorInfo,
  CurtainAssignment,
  DeviceAssignment,
  DryContactEntry,
  FixtureMaster,
  HvacAssignment,
  HvacSeason,
  InspectionMark,
  LocationMaster,
  PduDeviceCount,
  ProjectData,
  RoomType,
  RoomScene,
  Scene,
  SceneCircuitSetting,
  SwitchEntry,
  TrashData,
} from '../types';
import {
  CFS_COLUMNS,
  STORAGE_KEY,
  TRASH_STORAGE_KEY,
  RESERVED_VALUE,
  backlightLevelsFromSwitches,
  createDefaultBacklightLevels,
  createDefaultHvacSeasons,
  createDefaultLocations,
  createDefaultRoomScenes,
  normalizeBacklightLevels,
} from './constants';
import { normalizeCfsRowDisplaySettings } from './cfsRowDisplay';
import { nextUniqueAreaCode, normalizeAreaCode } from './programming';
import { isProjectSettings, migrateProjectSettings } from './programmingNameSettings';
import { createAppId } from './id';
import { normalizeSwitchPriorityFunctions } from './switchSync';
import { normalizeProjectRoomTypeCircuitIds } from './roomTypeSync';

const PROJECT_DRAFT_STORAGE_KEY = 'cfs-project-drafts-v1';
const VALID_SWITCH_KINDS = new Set(['contact', 'lutronPd', 'lutronPico', 'command', 'tstat', 'pir', 'qsm']);
const VALID_BUTTON_TYPES = new Set(['single', 'toggle', 'scene']);
const VALID_HVAC_PROTOCOLS = new Set(['Modbus', 'FCU', 'BACnet']);
const VALID_HVAC_THERMOSTAT_ROLES = new Set(['Master', 'Slave']);
const VALID_CURTAIN_ACTIONS = new Set(['Open', 'Close', 'Stop']);
const VALID_INSPECTION_MARK_SOURCE_TYPES = new Set(['areaScene', 'roomScene', 'switch']);
const VALID_INSPECTION_MARK_SCOPES = new Set(['areaScene', 'override']);
const PROJECT_BACKUP_SCHEMA_VERSION = 2;
const LEGACY_STORAGE_KEYS = [
  'cfs-projects-v1',
  'cfs-projects-v2',
  'cfs-projects-v3',
  'cfs-projects-v4',
  'cfs-projects-v5',
  'cfs-projects-v6',
  'cfs-projects-v7',
  'cfs-projects-v8',
  'cfs-projects-v9',
  'cfs-projects-v10',
  'cfs-projects-v11',
  'cfs-projects-v12',
  'cfs-projects-v12-backup',
  'cfs-projects-v13',
  'cfs-projects-v13-backup',
  'cfs-app-settings-v1-backup',
];

function cleanupLegacyStorageKeys(): void {
  if (typeof window === 'undefined') return;
  for (const key of LEGACY_STORAGE_KEYS) {
    if (key !== STORAGE_KEY) {
      window.localStorage.removeItem(key);
    }
  }
}

function cleanupProjectCacheStorageForRetry(targetKey: string): void {
  if (typeof window === 'undefined') return;
  const retryCleanupKeys = [
    ...LEGACY_STORAGE_KEYS,
    PROJECT_DRAFT_STORAGE_KEY,
    STORAGE_KEY,
    TRASH_STORAGE_KEY,
  ];
  for (const key of retryCleanupKeys) {
    if (key && key !== targetKey) {
      window.localStorage.removeItem(key);
    }
  }
}

function safeSetItem(
  key: string,
  value: string,
  options: { notifyOnError?: boolean; cleanupProjectCacheOnRetry?: boolean } = {},
): boolean {
  const notifyOnError = options.notifyOnError ?? false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    cleanupLegacyStorageKeys();
    if (options.cleanupProjectCacheOnRetry) {
      cleanupProjectCacheStorageForRetry(key);
    }
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (retryError) {
      console.error('Failed to save CFS data to localStorage.', retryError);
      if (options.cleanupProjectCacheOnRetry) {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // Ignore cleanup failures. The database save path remains authoritative.
        }
      }
    }
    console.error('Failed to save CFS data to localStorage.', error);
    if (notifyOnError && typeof window !== 'undefined') {
      window.alert(
        'Failed to save locally. Old migration backups were cleared, but browser storage is still full. Delete unnecessary projects or old revisions and try again.',
      );
    }
    return false;
  }
}

function isCfsCircuit(value: unknown): value is CfsCircuit {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return false;
  if (typeof v.deviceGroupId !== 'string') return false;
  return CFS_COLUMNS.every((col) => typeof v[col.key] === 'string');
}

function stringField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function migrateCfsCircuit(value: unknown): CfsCircuit | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === 'string' && v.id !== '' ? v.id : createAppId();
  const row: CfsCircuit = {
    id,
    deviceGroupId:
      typeof v.deviceGroupId === 'string' && v.deviceGroupId !== ''
        ? v.deviceGroupId
        : id,
    device: '',
    deviceNum: '',
    deviceAuto: '',
    control: '',
    fixture: '',
    pcs: '',
    watt: '',
    lowEnd: '',
    highEnd: '',
    area: '',
    note: '',
    designerNumber: '',
    group: '',
    sequenceNo: '',
    addressZone: '',
  };
  for (const col of CFS_COLUMNS) {
    row[col.key] = stringField(v[col.key]);
  }
  return row;
}

function isSceneCircuitSetting(value: unknown): value is SceneCircuitSetting {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.circuitId === 'string' && typeof v.percentage === 'string';
}

function isScene(value: unknown): value is Scene {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.areaId === 'string' &&
    typeof v.name === 'string' &&
    Array.isArray(v.settings) &&
    v.settings.every(isSceneCircuitSetting)
  );
}

function isRoomSceneAreaSceneSelection(value: unknown): value is RoomScene['areaSceneSelections'][number] {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.areaId === 'string' && typeof v.sceneId === 'string';
}

function isRoomScene(value: unknown): value is RoomScene {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const areaSceneSelectionsOk =
    !('areaSceneSelections' in v) ||
    (Array.isArray(v.areaSceneSelections) &&
      v.areaSceneSelections.every(isRoomSceneAreaSceneSelection));
  return (
    typeof v.id === 'string' &&
    (!('kind' in v) || v.kind === 'pms' || v.kind === 'standard') &&
    (v.phase === 'Check In' || v.phase === 'Check Out') &&
    typeof v.sceneType === 'string' &&
    typeof v.detail === 'string' &&
    typeof v.triggerCondition === 'string' &&
    (!('backlightCondition' in v) || typeof v.backlightCondition === 'string') &&
    areaSceneSelectionsOk &&
    Array.isArray(v.settings) &&
    v.settings.every(isSceneCircuitSetting)
  );
}

function isHvacAssignment(value: unknown): value is HvacAssignment {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    VALID_HVAC_PROTOCOLS.has(v.protocol as string) &&
    VALID_HVAC_THERMOSTAT_ROLES.has(v.thermostatRole as string) &&
    typeof v.area === 'string' &&
    typeof v.lowEnd === 'string' &&
    typeof v.highEnd === 'string' &&
    typeof v.summerWinterChange === 'boolean' &&
    typeof v.note === 'string'
  );
}

function migrateHvacAssignment(value: unknown): HvacAssignment | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return null;
  if (!VALID_HVAC_PROTOCOLS.has(v.protocol as string)) return null;
  return {
    id: v.id,
    protocol: v.protocol as HvacAssignment['protocol'],
    thermostatRole: VALID_HVAC_THERMOSTAT_ROLES.has(v.thermostatRole as string)
      ? (v.thermostatRole as HvacAssignment['thermostatRole'])
      : 'Master',
    area: typeof v.area === 'string' ? v.area : '',
    lowEnd: typeof v.lowEnd === 'string' ? v.lowEnd : '20',
    highEnd: typeof v.highEnd === 'string' ? v.highEnd : '28',
    summerWinterChange: typeof v.summerWinterChange === 'boolean' ? v.summerWinterChange : false,
    note: typeof v.note === 'string' ? v.note : '',
  };
}

function isHvacSeason(value: unknown): value is HvacSeason {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.startMonth === 'string' &&
    typeof v.startDay === 'string' &&
    typeof v.endMonth === 'string' &&
    typeof v.endDay === 'string'
  );
}

function isCurtainAssignment(value: unknown): value is CurtainAssignment {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.area === 'string' &&
    typeof v.detail === 'string' &&
    VALID_CURTAIN_ACTIONS.has(v.action as string)
  );
}

function migrateCurtainAssignment(value: unknown): CurtainAssignment | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const rawAction = typeof v.action === 'string' ? v.action.trim() : '';
  const normalizedAction = rawAction.toLowerCase();
  const action =
    normalizedAction === 'close'
      ? 'Close'
      : normalizedAction === 'stop'
        ? 'Stop'
        : 'Open';
  return {
    id: typeof v.id === 'string' && v.id !== '' ? v.id : createAppId(),
    area: typeof v.area === 'string' ? v.area : '',
    detail: typeof v.detail === 'string' ? v.detail : '',
    action,
  };
}

function isCfsRowDisplaySettings(value: unknown): value is CfsRowDisplaySettings {
  const normalized = normalizeCfsRowDisplaySettings(value);
  return normalized.order.length > 0 && Array.isArray(normalized.hidden);
}

function migrateBacklightCondition(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === '-' || /^light$/i.test(trimmed)) return '';
  if (/^master\s*on$/i.test(trimmed)) return 'masterOn';
  return value;
}

function isRoomType(value: unknown): value is RoomType {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const circuitIdsOk =
    !('circuitIds' in v) ||
    (Array.isArray(v.circuitIds) && v.circuitIds.every((id) => typeof id === 'string'));
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.updatedAt === 'string' &&
    circuitIdsOk &&
    Array.isArray(v.rows) &&
    v.rows.every(isCfsCircuit) &&
    (!('dryContacts' in v) ||
      (Array.isArray(v.dryContacts) && v.dryContacts.every(isDryContactEntry))) &&
    Array.isArray(v.deviceAssignments) &&
    v.deviceAssignments.every(isDeviceAssignment) &&
    Array.isArray(v.hvacAssignments) &&
    v.hvacAssignments.every(isHvacAssignment) &&
    Array.isArray(v.hvacSeasons) &&
    v.hvacSeasons.every(isHvacSeason) &&
    (!('curtainAssignments' in v) ||
      (Array.isArray(v.curtainAssignments) && v.curtainAssignments.every(isCurtainAssignment))) &&
    (!('cfsRowDisplay' in v) || isCfsRowDisplaySettings(v.cfsRowDisplay)) &&
    (!('backlightLevels' in v) || Array.isArray(v.backlightLevels)) &&
    Array.isArray(v.scenes) &&
    v.scenes.every(isScene) &&
    (!('roomScenes' in v) || (Array.isArray(v.roomScenes) && v.roomScenes.every(isRoomScene))) &&
    Array.isArray(v.switches) &&
    v.switches.every(isSwitchEntry) &&
    Array.isArray(v.pduDeviceCounts) &&
    v.pduDeviceCounts.every(isPduDeviceCount) &&
    (!('inspectionMarks' in v) ||
      (Array.isArray(v.inspectionMarks) && v.inspectionMarks.every(isInspectionMark)))
  );
}

function isPduDeviceCount(value: unknown): value is PduDeviceCount {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.deviceId === 'string' && typeof v.quantity === 'number' && Number.isFinite(v.quantity);
}

function isInspectionMark(value: unknown): value is InspectionMark {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    VALID_INSPECTION_MARK_SOURCE_TYPES.has(v.sourceType as string) &&
    typeof v.sourceId === 'string' &&
    typeof v.targetId === 'string' &&
    VALID_INSPECTION_MARK_SCOPES.has(v.scope as string) &&
    typeof v.label === 'string' &&
    typeof v.previousValue === 'string' &&
    typeof v.value === 'string' &&
    typeof v.markedAt === 'string'
  );
}

function isDryContactEntry(value: unknown): value is DryContactEntry {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.area === 'string' &&
    typeof v.circuit === 'string' &&
    typeof v.detail === 'string'
  );
}

function migrateDryContactEntry(value: unknown): DryContactEntry | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const circuit = stringField(v.circuit).trim();
  const detail = stringField(v.detail).trim();
  return {
    id: typeof v.id === 'string' && v.id !== '' ? v.id : createAppId(),
    area: typeof v.area === 'string' ? v.area : '',
    circuit: circuit || detail,
    detail,
  };
}

function isCcoAssignment(assignment: DeviceAssignment): boolean {
  return /^CCO/i.test(assignment.zoneAddress.trim().replace(/^\d+-/, ''));
}

function inferDryContactsFromAssignments(assignments: readonly DeviceAssignment[]): DryContactEntry[] {
  const byKey = new Map<string, DryContactEntry>();
  for (const assignment of assignments) {
    if (!isCcoAssignment(assignment)) continue;
    const assigned = assignment.circuitNumber.trim();
    const detail = assignment.detail.trim();
    const circuit = assigned && assigned !== RESERVED_VALUE ? assigned : detail;
    if (!circuit) continue;
    const key = [assignment.area ?? '', circuit, detail].join('\u0000').toLowerCase();
    if (byKey.has(key)) continue;
    byKey.set(key, {
      id: `dry-contact:${assignment.id}`,
      area: assignment.area ?? '',
      circuit,
      detail: detail && detail !== circuit ? detail : '',
    });
  }
  return Array.from(byKey.values());
}

function migrateCollaborationEditorInfo(value: unknown): CollaborationEditorInfo | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.userId !== 'string' || v.userId === '') return null;
  if (typeof v.displayName !== 'string' || v.displayName === '') return null;
  if (typeof v.updatedAt !== 'string' || v.updatedAt === '') return null;
  return {
    userId: v.userId,
    displayName: v.displayName,
    updatedAt: v.updatedAt,
  };
}

function migrateInspectionMark(value: unknown): InspectionMark | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!VALID_INSPECTION_MARK_SOURCE_TYPES.has(v.sourceType as string)) return null;
  if (typeof v.sourceId !== 'string' || v.sourceId === '') return null;
  if (typeof v.targetId !== 'string' || v.targetId === '') return null;
  const sourceType = v.sourceType as InspectionMark['sourceType'];
  return {
    id: typeof v.id === 'string' && v.id !== '' ? v.id : createAppId(),
    sourceType,
    sourceId: v.sourceId,
    targetId: v.targetId,
    scope: VALID_INSPECTION_MARK_SCOPES.has(v.scope as string)
      ? (v.scope as InspectionMark['scope'])
      : sourceType === 'areaScene'
        ? 'areaScene'
        : 'override',
    label: stringField(v.label),
    previousValue: stringField(v.previousValue),
    value: stringField(v.value),
    markedAt: typeof v.markedAt === 'string' && v.markedAt !== '' ? v.markedAt : new Date().toISOString(),
  };
}

function switchGroupId(sw: SwitchEntry): string {
  return sw.switchGroupId || sw.id;
}

function commandPirReference(index: number): string {
  return `PIR ${index}`;
}

function migrateCommandPirReferences(switches: SwitchEntry[]): SwitchEntry[] {
  const pirReferenceByLegacyValue = new Map<string, string>();
  const seenGroups = new Set<string>();
  let pirIndex = 1;

  for (const sw of switches) {
    if (sw.kind !== 'pir') continue;
    const groupId = switchGroupId(sw);
    if (seenGroups.has(groupId)) continue;
    seenGroups.add(groupId);

    const reference = commandPirReference(pirIndex);
    pirReferenceByLegacyValue.set(groupId, reference);
    const legacyNumber = sw.switchNumber.trim();
    if (legacyNumber) pirReferenceByLegacyValue.set(legacyNumber, reference);
    pirIndex += 1;
  }

  if (pirReferenceByLegacyValue.size === 0) return switches;

  let changed = false;
  const migrated = switches.map((sw) => {
    if (sw.kind !== 'command') return sw;
    const reference = pirReferenceByLegacyValue.get(sw.switchNumber.trim());
    if (!reference || reference === sw.switchNumber) return sw;
    changed = true;
    return { ...sw, switchNumber: reference };
  });

  return changed ? migrated : switches;
}

function migrateRoomType(value: unknown): RoomType | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return null;
  if (typeof v.name !== 'string') return null;
  if (typeof v.updatedAt !== 'string') return null;
  if (!Array.isArray(v.rows)) return null;
  const rows = v.rows
    .map((row) => migrateCfsCircuit(row))
    .filter((row): row is CfsCircuit => row !== null);
  if (
    !Array.isArray(v.deviceAssignments) ||
    !v.deviceAssignments.every(isDeviceAssignment)
  ) {
    return null;
  }
  const scenes: Scene[] =
    Array.isArray(v.scenes) && v.scenes.every(isScene)
      ? (v.scenes as Scene[])
      : [];
  const roomScenes: RoomScene[] =
    Array.isArray(v.roomScenes) && v.roomScenes.every(isRoomScene)
      ? ((v.roomScenes as RoomScene[]).length > 0
          ? (v.roomScenes as RoomScene[]).map((scene) => ({
              ...scene,
              backlightCondition: migrateBacklightCondition(
                (scene as unknown as Record<string, unknown>).backlightCondition,
              ),
              areaSceneSelections: Array.isArray((scene as unknown as Record<string, unknown>).areaSceneSelections)
                ? scene.areaSceneSelections
                : [],
            }))
          : createDefaultRoomScenes())
      : createDefaultRoomScenes();
  const hvacAssignments: HvacAssignment[] =
    Array.isArray(v.hvacAssignments)
      ? v.hvacAssignments
          .map((assignment) => migrateHvacAssignment(assignment))
          .filter((assignment): assignment is HvacAssignment => assignment !== null)
      : [];
  const hvacSeasons: HvacSeason[] =
    Array.isArray(v.hvacSeasons) && v.hvacSeasons.every(isHvacSeason)
      ? (v.hvacSeasons as HvacSeason[])
      : createDefaultHvacSeasons();
  const curtainAssignments: CurtainAssignment[] =
    Array.isArray(v.curtainAssignments)
      ? v.curtainAssignments
          .map((assignment) => migrateCurtainAssignment(assignment))
          .filter((assignment): assignment is CurtainAssignment => assignment !== null)
      : [];
  const cfsRowDisplay = normalizeCfsRowDisplaySettings(v.cfsRowDisplay);
  const normalizedSwitches: SwitchEntry[] =
    Array.isArray(v.switches) && v.switches.every(isSwitchEntry)
      ? (v.switches as SwitchEntry[]).map((sw) => ({
          ...sw,
          switchGroupId:
            typeof (sw as unknown as Record<string, unknown>).switchGroupId === 'string' &&
            sw.switchGroupId !== ''
              ? sw.switchGroupId
              : sw.id,
          cciAssignment:
            typeof (sw as unknown as Record<string, unknown>).cciAssignment === 'string'
              ? sw.cciAssignment
              : '',
          buttonCount:
            typeof (sw as unknown as Record<string, unknown>).buttonCount === 'string'
              ? sw.buttonCount
              : '',
          buttonLabel:
            typeof (sw as unknown as Record<string, unknown>).buttonLabel === 'string'
              ? sw.buttonLabel
              : '',
          isPriorityFunction:
            (sw as unknown as Record<string, unknown>).isPriorityFunction === true
              ? true
              : undefined,
          buttonSetting: {
            ...sw.buttonSetting,
            sceneIds: Array.isArray(
              (sw.buttonSetting as unknown as Record<string, unknown>).sceneIds,
            )
              ? sw.buttonSetting.sceneIds
              : sw.buttonSetting.sceneId
                ? [sw.buttonSetting.sceneId]
                : [],
          },
          backlightTarget:
            typeof (sw as unknown as Record<string, unknown>).backlightTarget === 'string'
              ? sw.backlightTarget
              : '',
          backlightCondition: migrateBacklightCondition(
            (sw as unknown as Record<string, unknown>).backlightCondition,
          ),
          backlightLevels:
            Array.isArray((sw as unknown as Record<string, unknown>).backlightLevels)
              ? normalizeBacklightLevels(sw.backlightLevels)
              : createDefaultBacklightLevels(),
        }))
      : [];
  const switches = normalizeSwitchPriorityFunctions(migrateCommandPirReferences(normalizedSwitches));
  const backlightLevels = Array.isArray(v.backlightLevels)
    ? normalizeBacklightLevels(v.backlightLevels)
    : backlightLevelsFromSwitches(switches);
  const pduDeviceCounts: PduDeviceCount[] =
    Array.isArray(v.pduDeviceCounts) && v.pduDeviceCounts.every(isPduDeviceCount)
      ? (v.pduDeviceCounts as PduDeviceCount[]).filter((item) => Number.isFinite(item.quantity))
      : [];
  const inspectionMarks: InspectionMark[] = Array.isArray(v.inspectionMarks)
    ? v.inspectionMarks
        .map((mark) => migrateInspectionMark(mark))
        .filter((mark): mark is InspectionMark => mark !== null)
    : [];
  const deviceAssignments = (v.deviceAssignments as DeviceAssignment[]).map((da) => ({
    ...da,
    area: typeof (da as unknown as Record<string, unknown>).area === 'string' ? da.area : '',
    group: typeof (da as unknown as Record<string, unknown>).group === 'string' ? da.group : '',
  }));
  const dryContacts = Array.isArray(v.dryContacts)
    ? v.dryContacts
        .map((entry) => migrateDryContactEntry(entry))
        .filter((entry): entry is DryContactEntry => entry !== null)
    : inferDryContactsFromAssignments(deviceAssignments);
  return {
    id: v.id,
    name: v.name,
    updatedAt: v.updatedAt,
    ...(Array.isArray(v.circuitIds)
      ? { circuitIds: v.circuitIds.filter((id): id is string => typeof id === 'string') }
      : {}),
    revision: typeof v.revision === 'string' ? v.revision : '1.00',
    revisions: Array.isArray(v.revisions)
      ? v.revisions.filter((item): item is RoomType['revisions'][number] => {
          if (item === null || typeof item !== 'object') return false;
          const r = item as Record<string, unknown>;
          return (
            typeof r.id === 'string' &&
            typeof r.revision === 'string' &&
            typeof r.savedAt === 'string' &&
            typeof r.snapshot === 'string'
          );
        }).map((item) => ({
          ...item,
          note: typeof (item as unknown as Record<string, unknown>).note === 'string'
            ? (item as unknown as Record<string, string>).note
            : 'Legacy revision snapshot.',
        }))
      : [],
    rows,
    dryContacts,
    deviceAssignments,
    hvacAssignments,
    hvacSeasons,
    curtainAssignments,
    cfsRowDisplay,
    backlightLevels,
    scenes,
    roomScenes,
    switches,
    pduDeviceCounts,
    inspectionMarks,
  };
}

function isLocationMaster(value: unknown): value is LocationMaster {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.number === 'string' &&
    typeof v.code === 'string' &&
    typeof v.color === 'string'
  );
}

function migrateLocationMasters(values: unknown[]): LocationMaster[] {
  const usedCodes = new Set<string>();
  return values
    .map((value, index) => {
      if (value === null || typeof value !== 'object') return null;
      const v = value as Record<string, unknown>;
      if (typeof v.id !== 'string') return null;
      const name = typeof v.name === 'string' ? v.name : '';
      const number = typeof v.number === 'string' ? v.number : '';
      const rawCode = typeof v.code === 'string' ? normalizeAreaCode(v.code) : '';
      const code = rawCode && !usedCodes.has(rawCode)
        ? rawCode
        : nextUniqueAreaCode(name || `Area ${index + 1}`, usedCodes);
      usedCodes.add(code);
      return {
        id: v.id,
        name,
        number,
        code,
        color: typeof v.color === 'string' ? v.color : '',
      };
    })
    .filter((location): location is LocationMaster => location !== null);
}

function isFixtureMaster(value: unknown): value is FixtureMaster {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.fixture === 'string' &&
    typeof v.fixtureType === 'string' &&
    typeof v.watt === 'string' &&
    (v.powerMode === undefined || v.powerMode === 'VA' || v.powerMode === 'W') &&
    (v.powerFactor === undefined || typeof v.powerFactor === 'string')
  );
}

function migrateFixtureMaster(value: unknown): FixtureMaster | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return null;
  if (typeof v.fixture !== 'string') return null;
  return {
    id: v.id,
    fixture: v.fixture,
    fixtureType:
      typeof v.fixtureType === 'string' && v.fixtureType !== ''
        ? v.fixtureType
        : 'DL',
    powerMode: v.powerMode === 'W' ? 'W' : 'VA',
    watt: typeof v.watt === 'string' ? v.watt : '',
    powerFactor: typeof v.powerFactor === 'string' && v.powerFactor !== '' ? v.powerFactor : '0.7',
  };
}

function isCircuitEntry(value: unknown): value is CircuitEntry {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.circuitGroupId === 'string' &&
    typeof v.daliFixtureGroupId === 'string' &&
    typeof v.designerNumber === 'string' &&
    typeof v.internalNumber === 'string' &&
    typeof v.dimmingType === 'string' &&
    typeof v.fixture === 'string' &&
    typeof v.pcs === 'string' &&
    typeof v.detail === 'string' &&
    typeof v.area === 'string' &&
    typeof v.ffe === 'boolean' &&
    typeof v.energySaving === 'boolean'
  );
}

function migrateCircuitEntry(value: unknown): CircuitEntry | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return null;
  return {
    id: v.id,
    circuitGroupId:
      typeof v.circuitGroupId === 'string' && v.circuitGroupId !== ''
        ? v.circuitGroupId
        : v.id,
    daliFixtureGroupId:
      typeof v.daliFixtureGroupId === 'string' ? v.daliFixtureGroupId : '',
    designerNumber: typeof v.designerNumber === 'string' ? v.designerNumber : '',
    internalNumber: typeof v.internalNumber === 'string' ? v.internalNumber : '',
    dimmingType: typeof v.dimmingType === 'string' ? v.dimmingType : '',
    fixture: typeof v.fixture === 'string' ? v.fixture : '',
    pcs: typeof v.pcs === 'string' ? v.pcs : '',
    detail: typeof v.detail === 'string' ? v.detail : '',
    area: typeof v.area === 'string' ? v.area : '',
    ffe: typeof v.ffe === 'boolean' ? v.ffe : false,
    energySaving: typeof v.energySaving === 'boolean' ? v.energySaving : false,
  };
}

function migrateProject(value: unknown): ProjectData | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string') return null;
  if (typeof v.updatedAt !== 'string') return null;
  if (!Array.isArray(v.locations)) return null;
  if (!Array.isArray(v.fixtures)) return null;
  const migratedLocations = migrateLocationMasters(v.locations);
  const migratedFixtures = v.fixtures
    .map((fixture) => migrateFixtureMaster(fixture))
    .filter((fixture): fixture is FixtureMaster => fixture !== null);

  const rawRoomTypes = Array.isArray(v.roomTypes) ? v.roomTypes : [];
  const migratedRoomTypes = rawRoomTypes
    .map((rt) => migrateRoomType(rt))
    .filter((rt): rt is RoomType => rt !== null);

  const rawCircuits = Array.isArray(v.circuits) ? v.circuits : [];
  const migratedCircuits = rawCircuits
    .map((c) => migrateCircuitEntry(c))
    .filter((c): c is CircuitEntry => c !== null);
  const migratedSettings = migrateProjectSettings(v.settings);

  return normalizeProjectRoomTypeCircuitIds({
    id: typeof v.id === 'string' && v.id !== '' ? v.id : createAppId(),
    name: v.name,
    updatedAt: v.updatedAt,
    lastUpdatedBy: migrateCollaborationEditorInfo(v.lastUpdatedBy),
    ...(migratedSettings ? { settings: migratedSettings } : {}),
    locations: migratedLocations,
    fixtures: migratedFixtures,
    circuits: migratedCircuits,
    roomTypes: migratedRoomTypes,
  });
}

function isSwitchEntry(value: unknown): value is SwitchEntry {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!VALID_SWITCH_KINDS.has(v.kind as string)) return false;
  if (!VALID_BUTTON_TYPES.has(v.buttonType as string)) return false;
  if (v.buttonSetting === null || typeof v.buttonSetting !== 'object') return false;
  const buttonSetting = v.buttonSetting as Record<string, unknown>;
  const sceneIdsOk =
    !('sceneIds' in buttonSetting) ||
    (Array.isArray(buttonSetting.sceneIds) &&
      buttonSetting.sceneIds.every((id) => typeof id === 'string'));
  return (
    typeof v.id === 'string' &&
    (!('switchGroupId' in v) || typeof v.switchGroupId === 'string') &&
    typeof v.switchNumber === 'string' &&
    typeof v.switchName === 'string' &&
    (!('cciAssignment' in v) || typeof v.cciAssignment === 'string') &&
    (!('buttonCount' in v) || typeof v.buttonCount === 'string') &&
    (!('buttonLabel' in v) || typeof v.buttonLabel === 'string') &&
    (!('isPriorityFunction' in v) || typeof v.isPriorityFunction === 'boolean') &&
    typeof v.allocation === 'string' &&
    typeof v.buttonFunction === 'string' &&
    typeof v.condition === 'string' &&
    typeof buttonSetting.sceneId === 'string' &&
    sceneIdsOk &&
    Array.isArray(buttonSetting.circuitSettings) &&
    buttonSetting.circuitSettings.every(isSceneCircuitSetting)
  );
}

function isDeviceAssignment(value: unknown): value is DeviceAssignment {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.deviceGroupId === 'string' &&
    typeof v.device === 'string' &&
    typeof v.deviceNum === 'string' &&
    typeof v.zoneAddress === 'string' &&
    typeof v.circuitNumber === 'string' &&
    (!('area' in v) || typeof v.area === 'string') &&
    typeof v.detail === 'string'
  );
}

function isProjectData(value: unknown): value is ProjectData {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.updatedAt === 'string' &&
    (!('lastUpdatedBy' in v) || migrateCollaborationEditorInfo(v.lastUpdatedBy) !== null || v.lastUpdatedBy === null) &&
    (!('settings' in v) || isProjectSettings(v.settings)) &&
    Array.isArray(v.locations) &&
    v.locations.every(isLocationMaster) &&
    Array.isArray(v.fixtures) &&
    v.fixtures.every(isFixtureMaster) &&
    Array.isArray(v.circuits) &&
    v.circuits.every(isCircuitEntry) &&
    Array.isArray(v.roomTypes) &&
    v.roomTypes.every(isRoomType)
  );
}

const LEGACY_STORAGE_KEY_V13 = 'cfs-projects-v13';
const LEGACY_STORAGE_KEY_V13_BACKUP = 'cfs-projects-v13-backup';
const LEGACY_STORAGE_KEY_V12 = 'cfs-projects-v12';
const LEGACY_STORAGE_KEY_V12_BACKUP = 'cfs-projects-v12-backup';

export interface ProjectBackupPayload {
  format: 'cfs-project-backup';
  schemaVersion: number;
  storageKey: string;
  exportedAt: string;
  projects: ProjectData[];
}

export function migrateProjectsPayload(payload: unknown): ProjectData[] {
  const rawProjects = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object' && Array.isArray((payload as { projects?: unknown }).projects)
      ? (payload as { projects: unknown[] }).projects
      : [];

  return rawProjects
    .map((project) => migrateProject(project))
    .filter((project): project is ProjectData => project !== null);
}

export function emptyTrashData(): TrashData {
  return { projects: [], roomTypes: [] };
}

export function migrateTrashPayload(payload: unknown): TrashData {
  if (payload === null || typeof payload !== 'object') return emptyTrashData();
  const source = 'trash' in payload && typeof (payload as { trash?: unknown }).trash === 'object'
    ? (payload as { trash: unknown }).trash
    : payload;
  if (source === null || typeof source !== 'object') return emptyTrashData();
  const raw = source as Record<string, unknown>;
  const rawProjects = Array.isArray(raw.projects) ? raw.projects : [];
  const rawRoomTypes = Array.isArray(raw.roomTypes) ? raw.roomTypes : [];

  const projects = rawProjects
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const v = item as Record<string, unknown>;
      const project = migrateProject(v.project);
      if (!project) return null;
      return {
        id: typeof v.id === 'string' && v.id !== '' ? v.id : createAppId(),
        deletedAt:
          typeof v.deletedAt === 'string' && v.deletedAt !== ''
            ? v.deletedAt
            : new Date().toISOString(),
        project,
      };
    })
    .filter((item): item is TrashData['projects'][number] => item !== null);

  const roomTypes = rawRoomTypes
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const v = item as Record<string, unknown>;
      const roomType = migrateRoomType(v.roomType);
      if (!roomType) return null;
      return {
        id: typeof v.id === 'string' && v.id !== '' ? v.id : createAppId(),
        deletedAt:
          typeof v.deletedAt === 'string' && v.deletedAt !== ''
            ? v.deletedAt
            : new Date().toISOString(),
        projectId: typeof v.projectId === 'string' ? v.projectId : '',
        projectName: typeof v.projectName === 'string' ? v.projectName : '',
        roomType,
      };
    })
    .filter((item): item is TrashData['roomTypes'][number] => item !== null);

  return { projects, roomTypes };
}

export function createProjectBackupPayload(
  projects: ReadonlyArray<ProjectData>,
): ProjectBackupPayload {
  return {
    format: 'cfs-project-backup',
    schemaVersion: PROJECT_BACKUP_SCHEMA_VERSION,
    storageKey: STORAGE_KEY,
    exportedAt: new Date().toISOString(),
    projects: projects.map((project) => project),
  };
}

export function downloadProjectBackup(
  projects: ReadonlyArray<ProjectData>,
  filenamePrefix = 'cfs-projects',
): void {
  if (typeof window === 'undefined') return;
  const payload = createProjectBackupPayload(projects);
  const safePrefix = filenamePrefix
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_') || 'cfs-projects';
  const stamp = payload.exportedAt.replace(/[:.]/g, '-');
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safePrefix}_${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function loadProjects(): ProjectData[] {
  if (typeof window === 'undefined') return [];
  // 1. Prefer current STORAGE_KEY (v14).
  const current = window.localStorage.getItem(STORAGE_KEY);
  if (current) {
    try {
      const parsed: unknown = JSON.parse(current);
      if (Array.isArray(parsed)) {
        if (parsed.every(isProjectData)) {
          return parsed;
        }
        // In-place migration for older v13 payloads that pre-date scenes/area.
        const migrated = migrateProjectsPayload(parsed);
        if (migrated.length > 0) {
          safeSetItem(STORAGE_KEY, JSON.stringify(migrated), { cleanupProjectCacheOnRetry: true });
          return migrated;
        }
      }
    } catch {
      // fall through to legacy migration attempt.
    }
  }
  // 2. Look for legacy v13 data and migrate.
  const legacyV13 = window.localStorage.getItem(LEGACY_STORAGE_KEY_V13);
  if (legacyV13) {
    try {
      const parsed: unknown = JSON.parse(legacyV13);
      if (Array.isArray(parsed)) {
        const migrated: ProjectData[] = migrateProjectsPayload(parsed);
        safeSetItem(STORAGE_KEY, JSON.stringify(migrated), { cleanupProjectCacheOnRetry: true });
        safeSetItem(LEGACY_STORAGE_KEY_V13_BACKUP, legacyV13, { cleanupProjectCacheOnRetry: true });
        window.localStorage.removeItem(LEGACY_STORAGE_KEY_V13);
        return migrated;
      }
    } catch {
      // ignore parse errors and fall through.
    }
  }

  // 3. Look for legacy v12 data and migrate.
  const legacyV12 = window.localStorage.getItem(LEGACY_STORAGE_KEY_V12);
  if (legacyV12) {
    try {
      const parsed: unknown = JSON.parse(legacyV12);
      if (Array.isArray(parsed)) {
        const migrated: ProjectData[] = migrateProjectsPayload(parsed);
        safeSetItem(STORAGE_KEY, JSON.stringify(migrated), { cleanupProjectCacheOnRetry: true });
        safeSetItem(LEGACY_STORAGE_KEY_V12_BACKUP, legacyV12, { cleanupProjectCacheOnRetry: true });
        window.localStorage.removeItem(LEGACY_STORAGE_KEY_V12);
        return migrated;
      }
    } catch {
      // ignore parse errors and fall through.
    }
  }
  return [];
}

export function loadTrash(): TrashData {
  if (typeof window === 'undefined') return emptyTrashData();
  const current = window.localStorage.getItem(TRASH_STORAGE_KEY);
  if (!current) return emptyTrashData();
  try {
    return migrateTrashPayload(JSON.parse(current));
  } catch {
    return emptyTrashData();
  }
}

function loadLocalProjects(): ProjectData[] {
  return loadProjects();
}

function saveLocalProjects(projects: ReadonlyArray<ProjectData>, options: { notifyOnError?: boolean } = {}): boolean {
  if (typeof window === 'undefined') return true;
  if (projects.length === 0) {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  }
  return safeSetItem(STORAGE_KEY, JSON.stringify(projects), {
    notifyOnError: options.notifyOnError ?? false,
    cleanupProjectCacheOnRetry: true,
  });
}

function loadLocalProjectDrafts(): ProjectData[] {
  if (typeof window === 'undefined') return [];
  const current = window.localStorage.getItem(PROJECT_DRAFT_STORAGE_KEY);
  if (!current) return [];
  try {
    return migrateProjectsPayload(JSON.parse(current));
  } catch {
    return [];
  }
}

function saveLocalProjectDrafts(projects: ReadonlyArray<ProjectData>, options: { notifyOnError?: boolean } = {}): boolean {
  if (typeof window === 'undefined') return true;
  if (projects.length === 0) {
    window.localStorage.removeItem(PROJECT_DRAFT_STORAGE_KEY);
    return true;
  }
  return safeSetItem(PROJECT_DRAFT_STORAGE_KEY, JSON.stringify(projects), {
    notifyOnError: options.notifyOnError ?? false,
    cleanupProjectCacheOnRetry: true,
  });
}

function clearLocalProjectDrafts(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(PROJECT_DRAFT_STORAGE_KEY);
}

function clearLocalProjectDraft(projectId: string): void {
  if (typeof window === 'undefined') return;
  const nextDrafts = loadLocalProjectDrafts().filter((project) => project.id !== projectId);
  if (nextDrafts.length > 0) {
    saveLocalProjectDrafts(nextDrafts, { notifyOnError: false });
  } else {
    clearLocalProjectDrafts();
  }
}

function projectUpdatedAtTime(project: ProjectData): number {
  const time = Date.parse(project.updatedAt);
  return Number.isFinite(time) ? time : 0;
}

function mergeSavedProjectsWithLocalDrafts(
  savedProjects: ReadonlyArray<ProjectData>,
  localDrafts: ReadonlyArray<ProjectData>,
): ProjectData[] {
  if (localDrafts.length === 0) return [...savedProjects];

  const savedById = new Map(savedProjects.map((project) => [project.id, project]));
  const draftById = new Map(localDrafts.map((project) => [project.id, project]));
  const selectedDraftIds = new Set<string>();

  const mergedSaved = savedProjects.map((savedProject) => {
    const draft = draftById.get(savedProject.id);
    if (!draft) return savedProject;
    if (projectUpdatedAtTime(draft) > projectUpdatedAtTime(savedProject)) {
      selectedDraftIds.add(draft.id);
      return draft;
    }
    return savedProject;
  });

  const localOnlyDrafts = localDrafts.filter((draft) => !savedById.has(draft.id));
  for (const draft of localOnlyDrafts) selectedDraftIds.add(draft.id);

  const nextDrafts = localDrafts.filter((draft) => selectedDraftIds.has(draft.id));
  if (nextDrafts.length > 0) {
    saveLocalProjectDrafts(nextDrafts, { notifyOnError: false });
  } else {
    clearLocalProjectDrafts();
  }

  return [...localOnlyDrafts, ...mergedSaved];
}

export function loadProjectDrafts(): ProjectData[] {
  return loadLocalProjectDrafts();
}

export function saveProjectsDraftLocally(projects: ReadonlyArray<ProjectData>): boolean {
  return saveLocalProjectDrafts(projects, { notifyOnError: false });
}

function saveLocalTrash(trash: TrashData): void {
  if (typeof window === 'undefined') return;
  if (trash.projects.length === 0 && trash.roomTypes.length === 0) {
    localStorage.removeItem(TRASH_STORAGE_KEY);
    return;
  }
  safeSetItem(TRASH_STORAGE_KEY, JSON.stringify(trash), { cleanupProjectCacheOnRetry: true });
}

export interface CollaborationSaveIdentity {
  userId: string;
  sessionId: string;
  projectId?: string;
  requireLock?: boolean;
  accessToken?: string;
}

interface ProjectSaveErrorPayload {
  error?: string;
  code?: string;
  project?: unknown;
  serverProject?: unknown;
  serverUpdatedAt?: string;
}

export class ProjectSaveConflictError extends Error {
  readonly status = 409;
  readonly code = 'PROJECT_CONFLICT';
  readonly serverProject?: ProjectData;
  readonly serverUpdatedAt?: string;

  constructor(message: string, details: { serverProject?: ProjectData; serverUpdatedAt?: string } = {}) {
    super(message);
    this.name = 'ProjectSaveConflictError';
    Object.setPrototypeOf(this, ProjectSaveConflictError.prototype);
    this.serverProject = details.serverProject;
    this.serverUpdatedAt = details.serverUpdatedAt;
  }
}

export function isProjectSaveConflictError(error: unknown): error is ProjectSaveConflictError {
  if (error instanceof ProjectSaveConflictError) return true;
  const candidate = error && typeof error === 'object' ? error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    message?: unknown;
  } : null;
  if (!candidate) return false;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return (
    candidate.name === 'ProjectSaveConflictError' ||
    candidate.code === 'PROJECT_CONFLICT' ||
    (
      candidate.status === 409 &&
      /updated by another user|reload before saving|update token/i.test(message)
    )
  );
}

function projectFromErrorPayload(value: unknown): ProjectData | undefined {
  return migrateProjectsPayload([value])[0];
}

function collaborationSaveHeaders(identity?: CollaborationSaveIdentity): HeadersInit {
  if (!identity) return {};
  return {
    'X-CFS-User-Id': identity.userId,
    'X-CFS-Session-Id': identity.sessionId,
    ...(identity.projectId ? { 'X-CFS-Project-Id': identity.projectId } : {}),
    ...(identity.requireLock ? { 'X-CFS-Require-Edit-Lock': '1' } : {}),
    ...(identity.accessToken ? { Authorization: `Bearer ${identity.accessToken}` } : {}),
  };
}

export async function loadProjectsFromDatabase(
  options: { signal?: AbortSignal; throwOnError?: boolean; accessToken?: string; secureSharing?: boolean } = {},
): Promise<ProjectData[]> {
  if (typeof window === 'undefined') return [];
  try {
    const response = await fetch('/api/projects', {
      cache: 'no-store',
      signal: options.signal,
      headers: options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : undefined,
    });
    if (!response.ok) throw new Error(`GET /api/projects failed: ${response.status}`);
    const payload: unknown = await response.json();
    const savedProjects = migrateProjectsPayload(payload);
    if (savedProjects.length === 0) {
      clearLocalProjectDrafts();
      if (!options.secureSharing) saveLocalProjects([], { notifyOnError: false });
      return [];
    }
    const projects = mergeSavedProjectsWithLocalDrafts(savedProjects, options.secureSharing ? [] : loadLocalProjectDrafts());
    if (!options.secureSharing) saveLocalProjects(projects, { notifyOnError: false });
    return projects;
  } catch (error) {
    console.error(
      options.throwOnError
        ? 'Failed to load projects from database.'
        : 'Failed to load projects from database. Falling back to browser storage.',
      error,
    );
    if (options.throwOnError) throw error;
    if (options.secureSharing) return [];
    const drafts = loadLocalProjectDrafts();
    return drafts.length > 0 ? drafts : loadLocalProjects();
  }
}

export async function loadTrashFromDatabase(
  options: { signal?: AbortSignal; throwOnError?: boolean; accessToken?: string; secureSharing?: boolean } = {},
): Promise<TrashData> {
  if (typeof window === 'undefined') return emptyTrashData();
  try {
    const response = await fetch('/api/trash', {
      cache: 'no-store',
      signal: options.signal,
      headers: options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : undefined,
    });
    if (!response.ok) throw new Error(`GET /api/trash failed: ${response.status}`);
    const payload: unknown = await response.json();
    const trash = migrateTrashPayload(payload);
    if (!options.secureSharing) saveLocalTrash(trash);
    return trash;
  } catch (error) {
    console.error(
      options.throwOnError
        ? 'Failed to load trash from database.'
        : 'Failed to load trash from database. Falling back to browser storage.',
      error,
    );
    if (options.throwOnError) throw error;
    if (options.secureSharing) return emptyTrashData();
    return loadTrash();
  }
}

export async function saveProjectToDatabase(
  project: ProjectData,
  allProjects: ReadonlyArray<ProjectData>,
  options: {
    expectedUpdatedAt?: string;
    createOnly?: boolean;
    forceOverwrite?: boolean;
    forceOverwriteUpdatedAt?: string;
    notifyOnError?: boolean;
    collaboration?: CollaborationSaveIdentity;
  } = {},
): Promise<ProjectData> {
  if (typeof window === 'undefined') return project;
  const notifyOnError = options.notifyOnError ?? true;
  const shouldCacheLocally = !options.collaboration?.accessToken;
  const localCacheSaved = shouldCacheLocally ? saveLocalProjects(allProjects, { notifyOnError: false }) : false;
  try {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...collaborationSaveHeaders(options.collaboration) },
      body: JSON.stringify({
        project,
        expectedUpdatedAt: options.expectedUpdatedAt ?? '',
        createOnly: options.createOnly === true,
        forceOverwrite: options.forceOverwrite === true,
        forceOverwriteUpdatedAt: options.forceOverwriteUpdatedAt ?? '',
      }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ProjectSaveErrorPayload;
      const message = payload.error || `POST /api/projects failed: ${response.status}`;
      if (
        response.status === 409 &&
        (
          payload.code === 'PROJECT_CONFLICT' ||
          /updated by another user|reload before saving|update token/i.test(message)
        )
      ) {
        const serverProject = projectFromErrorPayload(payload.project ?? payload.serverProject);
        throw new ProjectSaveConflictError(message, {
          serverProject,
          serverUpdatedAt: payload.serverUpdatedAt || serverProject?.updatedAt,
        });
      }
      throw new Error(message);
    }
    const payload: unknown = await response.json().catch(() => ({}));
    const savedProjects = migrateProjectsPayload([payload && typeof payload === 'object' ? (payload as { project?: unknown }).project : undefined]);
    clearLocalProjectDraft(project.id);
    return savedProjects[0] ?? project;
  } catch (error) {
    console.error('Failed to save project to database.', error);
    if (notifyOnError) {
      window.alert(
        localCacheSaved
          ? 'Failed to save this project to the database. The data is temporarily saved in the browser. Reload before retrying if another user may have saved changes.'
          : 'Failed to save this project to the database. Browser storage is also full, so a local backup could not be saved. Keep this page open and try saving again after checking the connection.',
      );
    }
    throw error;
  }
}

export async function saveProjectsToDatabase(
  projects: ReadonlyArray<ProjectData>,
  options: { notifyOnError?: boolean; collaboration?: CollaborationSaveIdentity } = {},
): Promise<ProjectData[]> {
  if (typeof window === 'undefined') return [...projects];
  const notifyOnError = options.notifyOnError ?? true;
  const shouldCacheLocally = !options.collaboration?.accessToken;
  const localCacheSaved = shouldCacheLocally ? saveLocalProjects(projects, { notifyOnError: false }) : false;
  try {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...collaborationSaveHeaders(options.collaboration) },
      body: JSON.stringify({ projects }),
    });
    if (!response.ok) {
      throw new Error(`POST /api/projects failed: ${response.status}`);
    }
    const payload: unknown = await response.json().catch(() => ({}));
    const savedProjects = migrateProjectsPayload(payload);
    clearLocalProjectDrafts();
    return savedProjects.length > 0 ? savedProjects : [...projects];
  } catch (error) {
    console.error('Failed to save projects to database.', error);
    if (notifyOnError) {
      window.alert(
        localCacheSaved
          ? 'Failed to save to the database. The data is temporarily saved in the browser. Check the saved state before restarting the app.'
          : 'Failed to save to the database. Browser storage is also full, so a local backup could not be saved. Keep this page open and try saving again after checking the connection.',
      );
    }
    throw error;
  }
}

export async function saveTrashToDatabase(
  trash: TrashData,
  options: { notifyOnError?: boolean; collaboration?: CollaborationSaveIdentity } = {},
): Promise<void> {
  if (typeof window === 'undefined') return;
  const notifyOnError = options.notifyOnError ?? true;
  saveLocalTrash(trash);
  try {
    const response = await fetch('/api/trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...collaborationSaveHeaders(options.collaboration) },
      body: JSON.stringify({ trash }),
    });
    if (!response.ok) {
      throw new Error(`POST /api/trash failed: ${response.status}`);
    }
  } catch (error) {
    console.error('Failed to save trash to database.', error);
    if (notifyOnError) {
      window.alert(
        'Failed to save the trash folder. Check the saved state before restarting the app.',
      );
    }
    throw error;
  }
}

export function createNewProject(name: string): ProjectData {
  return {
    id: createAppId(),
    name,
    updatedAt: new Date().toISOString(),
    locations: createDefaultLocations(),
    fixtures: [],
    circuits: [],
    roomTypes: [],
  };
}
