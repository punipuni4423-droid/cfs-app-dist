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
  ProjectRemark,
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
import { collectionLosses, migrationMessage, migrationReport, setMigrationReviewPending, type MigrationReport } from './migrationSafety';
import { cachedProjectDrafts, checkpointProject } from './projectDraftStore';
import { finiteFetch, matchesSaveIntent, prepareSaveProject, projectFingerprint, SAVE_PROTOCOL_VERSION, SaveProtocolError, saveError } from './projectSaveProtocol';
import { validCommonHistory } from './projectCommonHistory';
import { canonicalJson } from './canonicalJson';

// v2 (2026-08-21): invalidates drafts written by builds that had the
// stale-snapshot clobber bug. Those drafts contain silently reverted values
// (e.g. Palladiom By-Scene dropped), and the newer-draft-wins reload merge
// would resurrect them over good server data. New-format drafts are only
// written by fixed builds, so the merge can trust them again.
const VALID_SWITCH_KINDS = new Set(['contact', 'lutronPd', 'lutronPico', 'command', 'tstat', 'pir', 'qsm']);
const VALID_BUTTON_TYPES = new Set(['single', 'toggle', 'scene']);
const VALID_HVAC_PROTOCOLS = new Set(['Modbus', 'FCU', 'BACnet']);
const VALID_HVAC_THERMOSTAT_ROLES = new Set(['Master', 'Slave']);
const VALID_CURTAIN_ACTIONS = new Set(['Open', 'Close', 'Stop']);
const VALID_INSPECTION_MARK_SOURCE_TYPES = new Set(['areaScene', 'roomScene', 'switch']);
const VALID_INSPECTION_MARK_SCOPES = new Set(['areaScene', 'override']);
const PROJECT_BACKUP_SCHEMA_VERSION = 2;

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
    // A failed write must never delete the last recoverable draft or backup.
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (retryError) {
      console.error('Failed to save CFS data to localStorage.', retryError);
    }
    console.error('Failed to save CFS data to localStorage.', error);
    if (notifyOnError && typeof window !== 'undefined') {
      window.alert(
        '端末への保存に失敗しました。以前の退避は削除していません。画面を閉じずにJSONをバックアップしてください。',
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
    (!('settingLinkGroupId' in v) || typeof v.settingLinkGroupId === 'string' || typeof v.settingLinkGroupId === 'undefined') &&
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

function normalizePalladiomAssignmentValue(value: unknown): string {
  const condition = migrateBacklightCondition(value);
  if (!condition || condition === '__byScene') return '';
  const defaults = createDefaultBacklightLevels();
  const matched = defaults.find(
    (level) => level.key === condition || level.name.toLowerCase() === condition.toLowerCase(),
  );
  return matched ? matched.key : condition;
}

interface PalladiomAssignmentMigrationEntry {
  kind: string;
  id: string;
  switchGroupId?: string;
  backlightTarget: string;
  backlightCondition: string;
  backlightAssignment?: string;
}

/**
 * Splits the historically conflated lutronPd backlightCondition into the
 * per-group assignment ("" = By Scene, level key = fixed level; see
 * docs/CFS_STANDARD_GUIDELINES "Palladiom Backlight Assignment") and the
 * per-row ACTION condition (paired with backlightTarget). Legacy rows without
 * an action target carried the assignment in backlightCondition; that value
 * moves to backlightAssignment and the row condition is cleared. Rows with a
 * target keep their condition as the action. Divergent legacy values fall
 * back to By Scene, the documented default.
 */
function migratePalladiomBacklightAssignments<T extends PalladiomAssignmentMigrationEntry>(
  switches: T[],
): Array<T & { backlightAssignment: string }> {
  const assignmentByGroup = new Map<string, string>();
  for (const sw of switches) {
    if (sw.kind !== 'lutronPd') continue;
    const group = sw.switchGroupId || sw.id;
    if (typeof sw.backlightAssignment === 'string') {
      if (!assignmentByGroup.has(group)) {
        assignmentByGroup.set(group, normalizePalladiomAssignmentValue(sw.backlightAssignment));
      }
      continue;
    }
    if (sw.backlightTarget.trim() !== '') continue;
    const candidate = normalizePalladiomAssignmentValue(sw.backlightCondition);
    const existing = assignmentByGroup.get(group);
    if (existing === undefined) assignmentByGroup.set(group, candidate);
    else if (existing !== candidate) assignmentByGroup.set(group, '');
  }
  return switches.map((sw) => {
    if (sw.kind !== 'lutronPd') {
      return { ...sw, backlightAssignment: '' };
    }
    const group = sw.switchGroupId || sw.id;
    const assignment = assignmentByGroup.get(group) ?? '';
    const isLegacyEntry = typeof sw.backlightAssignment !== 'string';
    const backlightCondition =
      isLegacyEntry && sw.backlightTarget.trim() === '' ? '' : sw.backlightCondition;
    return { ...sw, backlightAssignment: assignment, backlightCondition };
  });
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
  const scenes: Scene[] =
    Array.isArray(v.scenes)
      ? v.scenes.filter(isScene)
      : [];
  const roomScenes: RoomScene[] =
    Array.isArray(v.roomScenes)
      ? (v.roomScenes.length > 0
          ? v.roomScenes.filter(isRoomScene).map((scene) => ({
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
    Array.isArray(v.hvacSeasons)
      ? v.hvacSeasons.filter(isHvacSeason)
      : createDefaultHvacSeasons();
  const curtainAssignments: CurtainAssignment[] =
    Array.isArray(v.curtainAssignments)
      ? v.curtainAssignments
          .map((assignment) => migrateCurtainAssignment(assignment))
          .filter((assignment): assignment is CurtainAssignment => assignment !== null)
      : [];
  const cfsRowDisplay = normalizeCfsRowDisplaySettings(v.cfsRowDisplay);
  const normalizedSwitches: Array<Omit<SwitchEntry, 'backlightAssignment'> & { backlightAssignment?: string }> =
    Array.isArray(v.switches)
      ? v.switches.filter(isSwitchEntry).map((sw) => ({
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
          backlightAssignment:
            typeof (sw as unknown as Record<string, unknown>).backlightAssignment === 'string'
              ? migrateBacklightCondition((sw as unknown as Record<string, unknown>).backlightAssignment)
              : undefined,
          backlightLevels:
            Array.isArray((sw as unknown as Record<string, unknown>).backlightLevels)
              ? normalizeBacklightLevels(sw.backlightLevels)
              : createDefaultBacklightLevels(),
        }))
      : [];
  const switches = normalizeSwitchPriorityFunctions(
    migrateCommandPirReferences(
      migratePalladiomBacklightAssignments(normalizedSwitches),
    ),
  );
  const backlightLevels = Array.isArray(v.backlightLevels)
    ? normalizeBacklightLevels(v.backlightLevels)
    : backlightLevelsFromSwitches(switches);
  const pduDeviceCounts: PduDeviceCount[] =
    Array.isArray(v.pduDeviceCounts)
      ? v.pduDeviceCounts.filter(isPduDeviceCount).filter((item) => Number.isFinite(item.quantity))
      : [];
  const inspectionMarks: InspectionMark[] = Array.isArray(v.inspectionMarks)
    ? v.inspectionMarks
        .map((mark) => migrateInspectionMark(mark))
        .filter((mark): mark is InspectionMark => mark !== null)
    : [];
  const deviceAssignments = (Array.isArray(v.deviceAssignments) ? v.deviceAssignments : []).map((value) => {
    if (!value || typeof value !== 'object') return value;
    const da = value as Record<string, unknown>;
    return { ...da, group: typeof da.group === 'string' ? da.group : '' };
  }).filter(isDeviceAssignment).map((da) => ({
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isProjectRemark(value: unknown): value is ProjectRemark {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    typeof v.body === 'string' &&
    typeof v.hasTable === 'boolean' &&
    isStringArray(v.columns) &&
    Array.isArray(v.rows) &&
    v.rows.every(isStringArray)
  );
}

function migrateProjectRemarks(value: unknown): ProjectRemark[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.filter(isProjectRemark).map((remark) => ({
    id: remark.id,
    title: remark.title,
    body: remark.body,
    hasTable: remark.hasTable,
    columns: [...remark.columns],
    rows: remark.rows.map((row) => [...row]),
  }));
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
  const migratedRemarks = migrateProjectRemarks(v.remarks);

  return normalizeProjectRoomTypeCircuitIds({
    id: typeof v.id === 'string' && v.id !== '' ? v.id : createAppId(),
    name: v.name,
    updatedAt: v.updatedAt,
    lastUpdatedBy: migrateCollaborationEditorInfo(v.lastUpdatedBy),
    ...(v.commonRevisions !== undefined ? { commonRevisions: v.commonRevisions as ProjectData['commonRevisions'] } : {}),
    ...(v.lastSaveOperation !== undefined ? { lastSaveOperation: v.lastSaveOperation as ProjectData['lastSaveOperation'] } : {}),
    ...(migratedSettings ? { settings: migratedSettings } : {}),
    ...(migratedRemarks ? { remarks: migratedRemarks } : {}),
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
    (!('settingLinkGroupId' in v) || typeof v.settingLinkGroupId === 'string' || typeof v.settingLinkGroupId === 'undefined') &&
    (!('backlightAssignment' in v) || typeof v.backlightAssignment === 'string') &&
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
    typeof v.group === 'string' &&
    (!('area' in v) || typeof v.area === 'string') &&
    typeof v.detail === 'string' &&
    (!('lowEnd' in v) || typeof v.lowEnd === 'string') &&
    (!('highEnd' in v) || typeof v.highEnd === 'string') &&
    (!('additionalCircuitNumbers' in v) ||
      (Array.isArray(v.additionalCircuitNumbers) &&
        v.additionalCircuitNumbers.every((entry) => typeof entry === 'string'))) &&
    (!('zoneDetail' in v) || typeof v.zoneDetail === 'string')
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
    (!('remarks' in v) || (Array.isArray(v.remarks) && v.remarks.every(isProjectRemark))) &&
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

export function migrateProjectsWithReport(payload: unknown): { projects: ProjectData[]; report: MigrationReport } {
  const rawProjects = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object' && Array.isArray((payload as { projects?: unknown }).projects)
      ? (payload as { projects: unknown[] }).projects
      : [];

  const projects = rawProjects
    .map((project) => migrateProject(project))
    .filter((project): project is ProjectData => project !== null);
  const issues = collectionLosses(rawProjects, projects);
  rawProjects.forEach((project, projectIndex) => {
    if (!project || typeof project !== 'object') return;
    const history = (project as { commonRevisions?: unknown }).commonRevisions;
    if (history !== undefined && !validCommonHistory(history)) {
      issues.push({ path: `projects[${projectIndex}].commonRevisions`, action: 'repaired', count: 1 });
    }
    const rooms = (project as { roomTypes?: unknown }).roomTypes;
    if (!Array.isArray(rooms)) return;
    rooms.forEach((room, roomIndex) => {
      const assignments = room && typeof room === 'object' ? room.deviceAssignments : undefined;
      if (!Array.isArray(assignments)) return;
      assignments.forEach((assignment, index) => {
        if (assignment && typeof assignment === 'object' && typeof assignment.group !== 'string' &&
          isDeviceAssignment({ ...assignment, group: '' })) {
          issues.push({ path: `projects[${projectIndex}].roomTypes[${roomIndex}].deviceAssignments[${index}].group`, action: 'repaired', count: 1 });
        }
      });
    });
  });
  return { projects, report: migrationReport(issues) };
}

let pendingMigrationReport: MigrationReport | undefined;
export const MIGRATION_REPORT_EVENT = 'cfs-migration-report';

export function getPendingMigrationReport(): MigrationReport | undefined {
  return pendingMigrationReport;
}

function publishMigrationReport(report: MigrationReport): void {
  if (!report.issues.length) return;
  console.warn('CFS MigrationReport', report);
  if (typeof window === 'undefined') return;
  // Remain blocked until an explicit save confirms the current load's losses.
  pendingMigrationReport = report;
  setMigrationReviewPending(true);
  window.dispatchEvent(new Event(MIGRATION_REPORT_EVENT));
}

export function migrateProjectsPayload(payload: unknown): ProjectData[] {
  const { projects, report } = migrateProjectsWithReport(payload);
  publishMigrationReport(report);
  return projects;
}

/** JSON omits undefined object properties. Reject non-DTO objects; preserve
 * invalid arrays/scalars for the existing migration diagnostics unchanged. */
function projectWireObjectShape<T>(value: T, ancestors = new Set<object>()): T {
  if (!value || typeof value !== 'object') return value;
  if (ancestors.has(value)) throw new SaveProtocolError('SAVE_PROJECT_INVALID', '保存対象に循環参照があります。元データを保持して確認してください。');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) {
    throw new SaveProtocolError('SAVE_PROJECT_INVALID', '保存対象にJSON形式ではないオブジェクトがあります。元データを保持して確認してください。');
  }
  ancestors.add(value);
  try {
    return (array
      // map retains holes, undefined elements and non-finite numbers.
      ? value.map(item => projectWireObjectShape(item, ancestors))
      : Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, projectWireObjectShape(item, ancestors)]))) as T;
  } finally { ancestors.delete(value); }
}

/** Use the same migration as POST/GET before fixing the immutable wire intent. */
export function normalizeProjectSave(project: ProjectData): ProjectData {
  const { projects, report } = migrateProjectsWithReport([projectWireObjectShape(project)]);
  const normalized = projectWireObjectShape(projects[0]);
  if (projects.length !== 1 || normalized.id !== project.id) {
    throw new SaveProtocolError('SAVE_PROJECT_INVALID', '保存対象の構造またはIDを確認できません。元データを保持して確認してください。');
  }
  if (normalized.commonRevisions !== undefined && !validCommonHistory(normalized.commonRevisions)) {
    throw new SaveProtocolError('COMMON_HISTORY_PROTECTED', '共通履歴が不正です。元データを保持して確認してください。');
  }
  // Generated defaults/IDs must settle in this captured snapshot, never in a retry.
  const repeated = projectWireObjectShape(migrateProjectsWithReport([normalized]).projects[0]);
  if (canonicalJson(normalized) !== canonicalJson(repeated)) {
    throw new SaveProtocolError('SAVE_NORMALIZATION_UNSTABLE', '保存形式の変換結果が安定しません。元データを保持して確認してください。');
  }
  if (report.issues.length) {
    publishMigrationReport(migrationReport([...(pendingMigrationReport?.issues ?? []), ...report.issues]));
  }
  return normalized;
}

/** The returned Project is both the durable intent and the exact POST body. */
export async function prepareProjectSave(project: ProjectData, kind: 'current' | 'revision' | 'idle', operationId?: string): Promise<ProjectData> {
  return prepareSaveProject(normalizeProjectSave(structuredClone(project)), kind, operationId);
}

async function projectSaveSubmission(project: ProjectData): Promise<ProjectData> {
  const snapshot = structuredClone(project);
  if (snapshot.lastSaveOperation && snapshot.lastSaveOperation.fingerprint === await projectFingerprint(snapshot)) {
    const normalized = normalizeProjectSave(snapshot);
    if (!await matchesSaveIntent(snapshot, normalized)) {
      // Do not silently replace an already checkpointed operation/payload on retry.
      throw new SaveProtocolError('SAVE_INTENT_NOT_NORMALIZED', '退避した保存要求の形式が一致しません。自動再送せず、保存状態と元データを確認してください。');
    }
    return snapshot;
  }
  return prepareProjectSave(snapshot, 'current');
}

export function emptyTrashData(): TrashData {
  return { projects: [], roomTypes: [] };
}

const trashDisplayTokens = new WeakMap<object, string>();
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

  const result = { projects, roomTypes };
  const token = typeof (payload as Record<string, unknown>).updatedAt === 'string'
    ? (payload as { updatedAt: string }).updatedAt : trashDisplayTokens.get(payload);
  if (token !== undefined) {
    trashDisplayTokens.set(result, token);
    projects.forEach(item => trashDisplayTokens.set(item, token));
  }
  return result;
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
        if (migrated.length > 0 || pendingMigrationReport) {
          if (!pendingMigrationReport) safeSetItem(STORAGE_KEY, JSON.stringify(migrated), { cleanupProjectCacheOnRetry: true });
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
        if (pendingMigrationReport) return migrated;
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
        if (pendingMigrationReport) return migrated;
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
  if (pendingMigrationReport) return false;
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
  // Drafts are recovery candidates, never an implicit authoritative database baseline.
  return [];
}

function saveLocalProjectDrafts(projects: ReadonlyArray<ProjectData>, options: { notifyOnError?: boolean } = {}): boolean {
  void options;
  return saveProjectsDraftLocally(projects);
}

function clearLocalProjectDrafts(): void {
  // Server reload/empty state cannot authorize deleting recovery copies.
}

function clearLocalProjectDraft(projectId: string): void {
  void projectId;
  // The page acknowledges exactly the submitted owner/tab/generation after readback.
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
  return cachedProjectDrafts();
}

export function clearProjectDrafts(): void {
  clearLocalProjectDrafts();
}

export function saveProjectsDraftLocally(projects: ReadonlyArray<ProjectData>): boolean {
  projects.forEach(project => { void checkpointProject(project, null); });
  return false; // Async transaction completion is reported through DRAFT_STATUS_EVENT.
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

/** Only called by explicit database saves. Background local drafts never open a confirmation. */
async function postProjectsWithConfirmation(body: Record<string, unknown>, headers: HeadersInit): Promise<Response> {
  const pending = pendingMigrationReport;
  if (pending && !window.confirm(`${migrationMessage(pending)}\n今回読み込んだ全プロジェクトの修復・除外を確認し、保存を許可しますか？`)) {
    throw new Error('修復・除外を含む保存をキャンセルしました。元データは保持されています。');
  }
  const post = (payload: Record<string, unknown>) => finiteFetch('/api/projects', {
    method: 'POST', headers, body: JSON.stringify({ ...payload, saveProtocol: SAVE_PROTOCOL_VERSION }),
  });
  let response = await post(body);
  if (response.status === 409) {
    const rejection = await response.clone().json().catch(() => ({}));
    if (rejection.code === 'MIGRATION_CONFIRMATION_REQUIRED' && typeof rejection.migrationConfirmation === 'string') {
      const report = rejection.migrationReport as MigrationReport;
      const details = report.issues.map((issue) => `${issue.path}: ${issue.action === 'excluded' ? '除外/削除' : '修復'} ${issue.count} 件`).join('\n');
      if (window.confirm(`${rejection.error}\n${details}\nこの変更を保存しますか？`)) {
        response = await post({ ...body, migrationConfirmation: rejection.migrationConfirmation });
      }
    }
  }
  return response;
}

function acknowledgeConfirmedMigration(): void {
  pendingMigrationReport = undefined;
  setMigrationReviewPending(false);
  window.dispatchEvent(new Event(MIGRATION_REPORT_EVENT));
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
    const serverReport = payload && typeof payload === 'object'
      ? (payload as { migrationReport?: MigrationReport }).migrationReport : undefined;
    if (serverReport?.issues?.length) publishMigrationReport(serverReport);
    // The API has already migrated this load. Re-migrating its excluded-to-empty
    // RoomScenes would generate legacy defaults and hide the diagnostic state.
    // Only accept typed server projects; raw/older responses still use migration.
    const reportedProjects = payload && typeof payload === 'object'
      ? (payload as { projects?: unknown }).projects : undefined;
    const savedProjects = serverReport?.issues?.length && Array.isArray(reportedProjects) && reportedProjects.every(isProjectData)
      ? reportedProjects
      : migrateProjectsPayload(payload);
    if (pendingMigrationReport) return savedProjects;
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

let trashServerUpdatedAt: string | undefined;

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
    trashServerUpdatedAt = typeof (payload as { updatedAt?: unknown }).updatedAt === 'string' ? (payload as { updatedAt: string }).updatedAt : undefined;
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
  project = await projectSaveSubmission(project);
  const notifyOnError = options.notifyOnError ?? true;
  void allProjects;
  try {
    const response = await postProjectsWithConfirmation({
        project,
        expectedUpdatedAt: options.expectedUpdatedAt ?? '',
        createOnly: options.createOnly === true,
        forceOverwrite: options.forceOverwrite === true,
        forceOverwriteUpdatedAt: options.forceOverwriteUpdatedAt ?? '',
      }, { 'Content-Type': 'application/json', ...collaborationSaveHeaders(options.collaboration) });
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
      throw saveError(response.status, payload.code);
    }
    const payload: unknown = await response.json().catch(() => null);
    const record = payload && typeof payload === 'object' ? payload as { ok?: boolean; project?: ProjectData } : null;
    if (!record?.ok || !record.project || !Array.isArray(record.project.roomTypes)
      || !await matchesSaveIntent(project, record.project)) {
      throw new SaveProtocolError('SAVE_RESPONSE_INVALID', '保存応答の内容を確認できません。保存状態を確認してください。', response.status, true);
    }
    const confirmed = await confirmProjectSave(project, options.collaboration);
    acknowledgeConfirmedMigration();
    return confirmed;
  } catch (error) {
    console.error('Failed to save project to database.', error);
    if (notifyOnError) {
      window.alert(`${error instanceof Error ? error.message : '保存を確認できません。'}\n端末の退避状況を確認し、必要ならJSONをバックアップしてください。`);
    }
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) {
      throw new SaveProtocolError('SAVE_RESULT_UNKNOWN', '保存結果が不明です。下書きを保持して保存状態を確認してください。', undefined, true);
    }
    throw error;
  }
}

/** Read-only, no fallback, draft merge, migration side effects or recovery cleanup. */
export async function confirmProjectSave(sent: ProjectData, collaboration?: CollaborationSaveIdentity): Promise<ProjectData> {
  const response = await finiteFetch('/api/projects', { cache: 'no-store', headers: collaborationSaveHeaders(collaboration) }, 15_000);
  if (!response.ok) throw new SaveProtocolError('SAVE_CONFIRMATION_FAILED', '保存先の確認ができません。下書きは保持しています。', response.status, true);
  const body = await response.json().catch(() => null) as { projects?: ProjectData[] } | null;
  const project = body && Array.isArray(body.projects) ? body.projects.find(item => item.id === sent.id) : undefined;
  if (!project || !Array.isArray(project.roomTypes) || !await matchesSaveIntent(sent, project)) {
    throw new SaveProtocolError('SAVE_RESULT_UNKNOWN', '送信した内容を保存先で確認できません。自動再送せず、保存状態を確認してください。', undefined, true);
  }
  return project;
}

/** Trash restores retain the immutable original schema; ordinary writers still normalize. */
export async function prepareProjectRestore(project: ProjectData): Promise<ProjectData> {
  return prepareSaveProject(project, 'current');
}

export async function confirmProjectRestore(sent: ProjectData, collaboration?: CollaborationSaveIdentity, confirmedReceipt?: ProjectData): Promise<ProjectData> {
  if (confirmedReceipt && !await matchesSaveIntent(sent, confirmedReceipt)) throw new SaveProtocolError('RESTORE_RECEIPT_INVALID', '復旧確認の記録が一致しません。原文を保持します。');
  const response = await finiteFetch('/api/projects?restoreRaw=1', { cache: 'no-store', headers: collaborationSaveHeaders(collaboration) }, 15_000);
  if (!response.ok) throw new SaveProtocolError('RESTORE_CONFIRMATION_FAILED', '復元先を確認できません。', response.status, true);
  const body = await response.json().catch(() => null) as { projects?: ProjectData[] } | null;
  const matches = Array.isArray(body?.projects) ? body.projects.filter(item => item?.id === sent.id) : [];
  const valid = matches.length === 1 && typeof matches[0].id === 'string' && typeof matches[0].name === 'string'
    && typeof matches[0].updatedAt === 'string' && Array.isArray(matches[0].roomTypes)
    && ['circuits', 'locations', 'fixtures'].every(key => Array.isArray((matches[0] as unknown as Record<string, unknown>)[key]))
    && matches[0].roomTypes.every(room => Boolean(room && typeof room === 'object' && !Array.isArray(room)));
  if (!valid || (!confirmedReceipt && !await matchesSaveIntent(sent, matches[0]))) {
    throw new SaveProtocolError('RESTORE_RESULT_UNKNOWN', '復元先の本体を確認できません。原文と復元要求を保持します。', undefined, true);
  }
  return matches[0];
}

export async function saveProjectRestore(sent: ProjectData, collaboration?: CollaborationSaveIdentity): Promise<ProjectData> {
  if (!sent.lastSaveOperation || sent.lastSaveOperation.fingerprint !== await projectFingerprint(sent)) throw new SaveProtocolError('RESTORE_INTENT_INVALID', '復元要求が変更されています。原文を保持します。');
  const response = await finiteFetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', ...collaborationSaveHeaders(collaboration) },
    body: JSON.stringify({ projects: [sent], restoreProjectIds: [sent.id], expectedUpdatedAts: { [sent.id]: null }, saveProtocol: SAVE_PROTOCOL_VERSION, restoreRaw: true }) });
  if (!response.ok) { const body = await response.json().catch(() => null); throw saveError(response.status, body?.code); }
  const body = await response.json().catch(() => null) as { ok?: boolean; projects?: ProjectData[] } | null;
  const matches = Array.isArray(body?.projects) ? body.projects.filter(item => item?.id === sent.id) : [];
  if (body?.ok !== true || matches.length !== 1 || !await matchesSaveIntent(sent, matches[0])) throw new SaveProtocolError('RESTORE_RESPONSE_INVALID', '復元の保存応答を確認できません。', response.status, true);
  return confirmProjectRestore(sent, collaboration);
}

export async function saveProjectsToDatabase(
  projects: ReadonlyArray<ProjectData>,
  options: { notifyOnError?: boolean; collaboration?: CollaborationSaveIdentity; expectedUpdatedAts?: Record<string, string | null>; restoreProjectIds?: string[] } = {},
): Promise<ProjectData[]> {
  if (typeof window === 'undefined') return [...projects];
  const notifyOnError = options.notifyOnError ?? true;
  projects = await Promise.all(projects.map(project => projectSaveSubmission(project)));
  try {
    const response = await postProjectsWithConfirmation({ projects, expectedUpdatedAts: options.expectedUpdatedAts, restoreProjectIds: options.restoreProjectIds },
      { 'Content-Type': 'application/json', ...collaborationSaveHeaders(options.collaboration) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw saveError(response.status, payload.code);
    }
    const payload: unknown = await response.json().catch(() => ({}));
    const savedProjects = (payload as { projects?: ProjectData[] }).projects;
    if ((payload as { ok?: unknown }).ok !== true || !Array.isArray(savedProjects) || !(await Promise.all(projects.map(project => {
      const saved = savedProjects.find(item => item?.id === project.id);
      return saved ? matchesSaveIntent(project, saved) : false;
    }))).every(Boolean)) throw new SaveProtocolError('SAVE_RESPONSE_INVALID', '保存応答の内容を確認できません。', response.status, true);
    const confirmed = await Promise.all(projects.map(project => confirmProjectSave(project, options.collaboration)));
    acknowledgeConfirmedMigration();
    return confirmed;
  } catch (error) {
    console.error('Failed to save projects to database.', error);
    if (notifyOnError) {
      window.alert(`${error instanceof Error ? error.message : '保存を確認できません。'}\n端末の退避状況を確認し、必要ならJSONをバックアップしてください。`);
    }
    throw error;
  }
}

export async function renameProjectInDatabase(projectId: string, name: string, expectedUpdatedAt: string, collaboration?: CollaborationSaveIdentity): Promise<ProjectData> {
  const response = await fetch('/api/projects/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...collaborationSaveHeaders(collaboration) },
    body: JSON.stringify({ projectId, name, expectedUpdatedAt }), signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Rename failed: ${response.status}`);
  const project = migrateProjectsPayload([body.project])[0];
  if (!project || project.id !== projectId) throw new Error('Rename response was incomplete. Reload before retrying.');
  return project;
}

export async function deleteProjectToTrash(
  projectId: string,
  expectedUpdatedAt: string,
  collaboration?: CollaborationSaveIdentity,
): Promise<{ projects: ProjectData[]; trash: TrashData }> {
  const response = await fetch('/api/projects/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...collaborationSaveHeaders(collaboration) },
    body: JSON.stringify({ projectId, expectedUpdatedAt }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Project deletion failed: ${response.status}`);
  if (!Array.isArray(result.projects) || !result.trash || typeof result.updatedAt !== 'string') {
    throw new Error('Deletion response was incomplete. Reload to check the project and Trash.');
  }
  const projects = migrateProjectsPayload(result.projects);
  const trash = migrateTrashPayload(result);
  trashServerUpdatedAt = result.updatedAt;
  if (!collaboration?.accessToken) saveLocalProjects(projects, { notifyOnError: false });
  saveLocalTrash(trash);
  clearLocalProjectDraft(projectId);
  return { projects, trash };
}

async function readRestoreTrashSnapshot(collaboration?: CollaborationSaveIdentity, isCurrent: () => boolean = () => true) {
  if (!isCurrent()) throw new Error('利用者が変更されました。復元結果を再確認してください。');
  const response = await finiteFetch('/api/trash?restoreRaw=1', { cache: 'no-store', headers: collaborationSaveHeaders(collaboration) }, 15_000);
  if (!response.ok) throw new SaveProtocolError('RESTORE_TRASH_READ_FAILED', 'Trash更新を確認できません。', response.status, true);
  const body = await response.json().catch(() => null) as { trash?: TrashData; updatedAt?: string } | null;
  if (!body || typeof body.updatedAt !== 'string' || !body.trash || !Array.isArray(body.trash.projects) || !Array.isArray(body.trash.roomTypes)) {
    throw new SaveProtocolError('RESTORE_TRASH_RESPONSE_INVALID', 'Trash応答を確認できません。', response.status, true);
  }
  if (!isCurrent()) throw new Error('利用者が変更されました。復元結果を再確認してください。');
  return { trash: body.trash, updatedAt: body.updatedAt };
}

/** Capture the server original without dropping unknown fields; migration is only for display identity. */
function restoredDisplayProjection(value: unknown, original: unknown): unknown {
  if (Array.isArray(original)) return Array.isArray(value) && value.length === original.length
    ? original.map((item, index) => restoredDisplayProjection(value[index], item)) : { incompatibleArray: true };
  if (original && typeof original === 'object') {
    const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(original).map(([key, item]) => [key, restoredDisplayProjection(source[key], item)]));
  }
  return value;
}

export async function readProjectRestoreTrashItem(expected: TrashData['projects'][number], collaboration?: CollaborationSaveIdentity,
  isCurrent: () => boolean = () => true): Promise<TrashData['projects'][number]> {
  const token = trashDisplayTokens.get(expected);
  const { trash, updatedAt } = await readRestoreTrashSnapshot(collaboration, isCurrent);
  if (token === undefined || token !== updatedAt) throw new SaveProtocolError('RESTORE_TRASH_CONFLICT', '表示後にTrashが変化したか、表示の保存基準が不明です。一覧を再読み込みしてください。', 409);
  const matches = trash.projects.filter(item => item.id === expected.id);
  // Missing legacy defaults can generate fresh IDs on each display migration.
  // Compare all original fields; generated fields absent from the raw original
  // are display-only. The raw original itself remains the exact write/CAS basis.
  const displayed = matches.length === 1 ? migrateTrashPayload({ projects: matches, roomTypes: [] }).projects[0] : undefined;
  if (matches.length !== 1 || !displayed || canonicalJson(restoredDisplayProjection(displayed, matches[0])) !== canonicalJson(restoredDisplayProjection(expected, matches[0]))) {
    throw new SaveProtocolError('RESTORE_TRASH_CONFLICT', 'Trash原本が変更されています。削除せず保持します。', 409);
  }
  return matches[0];
}

/** Restore cleanup only: preserve every other entry and use the freshly read Trash CAS token. */
export async function cleanupRestoredProjectTrash(
  original: TrashData['projects'][number],
  collaboration?: CollaborationSaveIdentity,
  isCurrent: () => boolean = () => true,
): Promise<TrashData> {
  const checkOwner = () => { if (!isCurrent()) throw new Error('利用者が変更されました。復元結果を再確認してください。'); };
  const headers = collaborationSaveHeaders(collaboration);
  const read = () => readRestoreTrashSnapshot(collaboration, isCurrent);
  const initial = await read();
  if (initial.trash.projects.filter(item => item.id === original.id).length > 1) {
    throw new SaveProtocolError('RESTORE_TRASH_CONFLICT', '同じIDのTrash原本が複数あります。削除せず保持します。', 409);
  }
  const existing = initial.trash.projects.find(item => item.id === original.id);
  if (existing && canonicalJson(existing) !== canonicalJson(original)) {
    throw new SaveProtocolError('RESTORE_TRASH_CONFLICT', 'Trash原本が変更されています。削除せず保持します。', 409);
  }
  let confirmed = initial;
  if (existing) {
    const next: TrashData = { ...initial.trash, projects: initial.trash.projects.filter(item => item.id !== original.id) };
    checkOwner();
    const response = await finiteFetch('/api/trash', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ saveProtocol: SAVE_PROTOCOL_VERSION, restoreCleanup: { original }, trash: next, expectedUpdatedAt: initial.updatedAt }) });
    if (!response.ok) throw new SaveProtocolError('RESTORE_TRASH_SAVE_FAILED', 'Trash更新を確認できません。', response.status, true);
    const body = await response.json().catch(() => null) as { ok?: boolean; trash?: TrashData; updatedAt?: string } | null;
    if (body?.ok !== true || typeof body.updatedAt !== 'string' || canonicalJson(body.trash) !== canonicalJson(next)) {
      throw new SaveProtocolError('RESTORE_TRASH_RESPONSE_INVALID', 'Trash保存応答を確認できません。', response.status, true);
    }
    confirmed = await read();
    if (canonicalJson(confirmed.trash) !== canonicalJson(next)) {
      throw new SaveProtocolError('RESTORE_TRASH_RESULT_UNKNOWN', 'Trashの保存先が変化しています。再確認してください。', undefined, true);
    }
  }
  checkOwner();
  trashServerUpdatedAt = confirmed.updatedAt;
  trashDisplayTokens.set(confirmed.trash, confirmed.updatedAt);
  if (!collaboration?.accessToken) saveLocalTrash(confirmed.trash);
  return confirmed.trash;
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
      body: JSON.stringify({ trash, expectedUpdatedAt: trashServerUpdatedAt }),
    });
    if (!response.ok) {
      throw new Error(`POST /api/trash failed: ${response.status}`);
    }
    const result = await response.json();
    trashServerUpdatedAt = typeof result.updatedAt === 'string' ? result.updatedAt : undefined;
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
