export interface CfsCircuit {
  id: string;
  // Internal: rows generated together (e.g., 4S1's 6 zones) share this id.
  deviceGroupId: string;
  device: string;
  deviceNum: string;
  deviceAuto: string;
  control: string;
  fixture: string;
  pcs: string;
  watt: string;
  lowEnd: string;
  highEnd: string;
  area: string;
  note: string;
  designerNumber: string;
  group: string;
  sequenceNo: string;
  addressZone: string;
}

export type CfsField = keyof Omit<CfsCircuit, 'id'>;

export interface RoomType {
  id: string;
  name: string;
  updatedAt: string;
  circuitIds?: string[];
  revision: string;
  revisions: RoomTypeRevision[];
  rows: CfsCircuit[];
  dryContacts?: DryContactEntry[];
  deviceAssignments: DeviceAssignment[];
  hvacAssignments: HvacAssignment[];
  hvacSeasons: HvacSeason[];
  curtainAssignments?: CurtainAssignment[];
  cfsRowDisplay?: CfsRowDisplaySettings;
  backlightLevels?: BacklightLevelSetting[];
  scenes: Scene[];
  roomScenes: RoomScene[];
  switches: SwitchEntry[];
  pduDeviceCounts: PduDeviceCount[];
  inspectionMarks: InspectionMark[];
}

export interface RoomTypeRevision {
  id: string;
  revision: string;
  savedAt: string;
  snapshot: string;
  note: string;
}

export type RevisionFieldChanges = Record<string, string[]>;

export interface LocationMaster {
  id: string;
  name: string;
  number: string;
  code: string;
  color: string;
}

export interface FixtureMaster {
  id: string;
  fixture: string;
  fixtureType: string;
  powerMode: 'VA' | 'W';
  watt: string;
  powerFactor: string;
}

export type AddressMode = 'fixed' | 'dali';

// Global app-level master (shared across projects).
export interface DeviceMaster {
  id: string;
  model: string;
  control: string;
  abbrev: string;
  programmingCode: string;
  lowEnd: string;
  highEnd: string;
  isDefault: boolean;
  addressMode: AddressMode;
  pdu: string;
  watts: string;
}

export interface PduDeviceCount {
  deviceId: string;
  quantity: number;
}

export type InspectionMarkSourceType = 'areaScene' | 'roomScene' | 'switch';
export type InspectionMarkScope = 'areaScene' | 'override';

export interface InspectionMark {
  id: string;
  sourceType: InspectionMarkSourceType;
  sourceId: string;
  targetId: string;
  scope: InspectionMarkScope;
  label: string;
  previousValue: string;
  value: string;
  markedAt: string;
}

export interface CollaborationUser {
  id: string;
  displayName: string;
  email: string;
  role?: CollaborationRole;
  createdAt?: string | null;
  lastSeenAt?: string | null;
}

export type CollaborationRole = "viewer" | "editor" | "admin";

export interface CollaborationMembership {
  id: string;
  email: string;
  displayName: string;
  role: CollaborationRole;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lastSeenAt: string | null;
}

export interface CollaborationEditorInfo {
  userId: string;
  displayName: string;
  updatedAt: string;
}

export interface CollaborationLock {
  scopeId: string;
  projectId?: string | null;
  userId: string;
  userName: string;
  sessionId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface CollaborationStatus {
  enabled: boolean;
  mode: 'local' | 'view' | 'edit';
  ownsLock: boolean;
  scopeId?: string;
  projectId?: string | null;
  lock: CollaborationLock | null;
  locks?: CollaborationLock[];
  lastUpdatedBy: CollaborationEditorInfo | null;
  membership?: CollaborationMembership;
  leaseSeconds: number;
  heartbeatMs: number;
  idleMs: number;
}

export interface InputMaster {
  id: string;
  name: string;
}

export interface TriggerMaster {
  id: string;
  name: string;
}

export interface CircuitEntry {
  id: string;
  circuitGroupId: string;
  daliFixtureGroupId: string;
  designerNumber: string;
  internalNumber: string;
  dimmingType: string;
  fixture: string;
  pcs: string;
  detail: string;
  // Area assigned to this circuit (LocationMaster.id). Empty when unassigned.
  area: string;
  // FFE (Furniture, Fixtures & Equipment) flag.
  ffe: boolean;
  // Energy-saving circuit flag (Energy Save).
  energySaving: boolean;
}

export interface DryContactEntry {
  id: string;
  area: string;
  circuit: string;
  detail: string;
}

// Per-project device assignment row (one per zone/address).
export interface DeviceAssignment {
  id: string;
  deviceGroupId: string;
  device: string;
  // Instance number for distinguishing multiple of the same device.
  // Shared across all rows in the same deviceGroupId.
  deviceNum: string;
  zoneAddress: string;
  circuitNumber: string;
  // Optional area for I/O assignments that are not linked to a lighting circuit.
  area?: string;
  detail: string;
  // DALI address-group number (sequential per device). Empty for non-DALI.
  group: string;
}

export type HvacProtocol = 'Modbus' | 'FCU' | 'BACnet';
export type HvacThermostatRole = 'Master' | 'Slave';

export interface HvacAssignment {
  id: string;
  protocol: HvacProtocol;
  thermostatRole: HvacThermostatRole;
  area: string;
  lowEnd: string;
  highEnd: string;
  summerWinterChange: boolean;
  note: string;
}

export interface HvacSeason {
  id: string;
  name: string;
  startMonth: string;
  startDay: string;
  endMonth: string;
  endDay: string;
}

export type CurtainAction = 'Open' | 'Close' | 'Stop';

export interface CurtainAssignment {
  id: string;
  area: string;
  detail: string;
  action: CurtainAction;
}

export type CfsRowKind = 'lighting' | 'cco' | 'curtain' | 'hvac' | 'backlight';

export interface CfsRowDisplaySettings {
  order: CfsRowKind[];
  hidden: CfsRowKind[];
}

// Per-circuit percentage setting inside a Scene.
export interface SceneCircuitSetting {
  // CircuitEntry.id this setting targets.
  circuitId: string;
  // Percentage as a string ('' means unset/inherit).
  percentage: string;
}

// A single lighting scene defined inside an Area, scoped to a RoomType.
export interface Scene {
  id: string;
  // LocationMaster.id this scene belongs to.
  areaId: string;
  name: string;
  settings: SceneCircuitSetting[];
}

export interface RoomSceneAreaSceneSelection {
  areaId: string;
  sceneId: string;
}

export type RoomScenePhase = 'Check In' | 'Check Out';
export type RoomSceneKind = 'pms' | 'standard';

export interface RoomScene {
  id: string;
  kind?: RoomSceneKind;
  phase: RoomScenePhase;
  sceneType: string;
  detail: string;
  triggerCondition: string;
  backlightCondition: string;
  areaSceneSelections: RoomSceneAreaSceneSelection[];
  settings: SceneCircuitSetting[];
}

export type SwitchKind = 'contact' | 'lutronPd' | 'lutronPico' | 'command' | 'tstat' | 'pir' | 'qsm';
export type ButtonType = 'single' | 'toggle' | 'scene';

export interface SwitchButtonSetting {
  // Legacy single Scene.id. Kept for migration/backward compatibility.
  sceneId: string;
  // Scene ids selected per area. Empty for per-circuit mode.
  sceneIds: string[];
  // Per-circuit percentage settings (used when sceneId is empty).
  circuitSettings: SceneCircuitSetting[];
}

export type BacklightMode = 'Manual' | 'DBM';

export interface BacklightLevelSetting {
  key: string;
  name: string;
  mode: BacklightMode;
  active: string;
  inactive: string;
}

export interface SwitchEntry {
  id: string;
  // Physical switch grouping. Multiple rows/functions share this id.
  switchGroupId: string;
  kind: SwitchKind;
  switchNumber: string;
  switchName: string;
  cciAssignment: string;
  buttonCount: string;
  buttonLabel: string;
  allocation: string;
  buttonFunction: string;
  // Optional preferred function for a physical button with multiple function rows.
  isPriorityFunction?: boolean;
  buttonType: ButtonType;
  condition: string;
  buttonSetting: SwitchButtonSetting;
  backlightTarget: string;
  backlightCondition: string;
  // Palladiom group assignment ("" = By Scene, level key = fixed level).
  // Kept separate from backlightCondition, which is the per-row ACTION
  // ("pressing this button sets targets' backlight to X") paired with
  // backlightTarget. Meaningful for lutronPd entries only.
  backlightAssignment: string;
  backlightLevels: BacklightLevelSetting[];
}

export type ProgrammingNameToken = 'locationNumber' | 'designerNumber' | 'area' | 'address' | 'device';
export type ProgrammingNameBracketStyle = 'square' | 'round' | 'curly' | 'angle' | 'none';

export interface ProgrammingNameSettings {
  tokens: ProgrammingNameToken[];
  bracketStyle: ProgrammingNameBracketStyle;
  tokenSeparator: string;
  detailSeparator: string;
}

export interface ProjectSettings {
  programmingName: ProgrammingNameSettings;
}

export interface ProjectData {
  id: string;
  name: string;
  updatedAt: string;
  lastUpdatedBy?: CollaborationEditorInfo | null;
  settings?: ProjectSettings;
  locations: LocationMaster[];
  fixtures: FixtureMaster[];
  circuits: CircuitEntry[];
  roomTypes: RoomType[];
}

export interface DeletedProjectItem {
  id: string;
  deletedAt: string;
  project: ProjectData;
}

export interface DeletedRoomTypeItem {
  id: string;
  deletedAt: string;
  projectId: string;
  projectName: string;
  roomType: RoomType;
}

export interface TrashData {
  projects: DeletedProjectItem[];
  roomTypes: DeletedRoomTypeItem[];
}

export type ProjectTab = 'area' | 'fixture' | 'rooms';

export type RoomsSubTab = 'circuit' | 'deviceAssign' | 'areaScene' | 'scene' | 'switch' | 'command' | 'backlight' | 'cfs' | 'pdu';
