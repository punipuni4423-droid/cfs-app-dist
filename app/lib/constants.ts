import type {
  AddressMode,
  BacklightLevelSetting,
  ButtonType,
  CfsRowDisplaySettings,
  CfsCircuit,
  CfsField,
  CircuitEntry,
  CurtainAssignment,
  CurtainAction,
  DeviceAssignment,
  DeviceMaster,
  DryContactEntry,
  FixtureMaster,
  HvacAssignment,
  HvacSeason,
  InputMaster,
  LocationMaster,
  PduDeviceCount,
  RoomType,
  RoomScene,
  RoomSceneKind,
  RoomScenePhase,
  Scene,
  SwitchEntry,
  SwitchKind,
  TriggerMaster,
} from '../types';
import { nextUniqueAreaCode } from './programming';
import { createAppId } from './id';
import { normalizeCfsRowDisplaySettings } from './cfsRowDisplay';

export const STORAGE_KEY = 'cfs-projects-v14';
export const TRASH_STORAGE_KEY = 'cfs-trash-v1';
export const RESERVED_VALUE = 'Reserved';
export const APP_SETTINGS_KEY = 'cfs-app-settings-v3';

export function inferAddressMode(model: string): AddressMode {
  return /DALUNV/i.test(model) ? 'dali' : 'fixed';
}

export type CellKind =
  | 'text'
  | 'number'
  | 'device-select'
  | 'devicenum-select'
  | 'fixture-select'
  | 'area-select'
  | 'readonly';

export interface CfsColumnDef {
  key: CfsField;
  label: string;
  minWidth: number;
  type: 'text' | 'number';
  kind: CellKind;
}

export const CFS_COLUMNS: readonly CfsColumnDef[] = [
  { key: 'device', label: 'Device', minWidth: 200, type: 'text', kind: 'device-select' },
  { key: 'deviceNum', label: 'Device Num.', minWidth: 96, type: 'text', kind: 'devicenum-select' },
  { key: 'deviceAuto', label: 'Device Auto', minWidth: 110, type: 'text', kind: 'readonly' },
  { key: 'control', label: 'Control', minWidth: 110, type: 'text', kind: 'readonly' },
  { key: 'fixture', label: 'Fixture', minWidth: 160, type: 'text', kind: 'fixture-select' },
  { key: 'pcs', label: 'pcs.', minWidth: 64, type: 'number', kind: 'number' },
  { key: 'watt', label: 'W', minWidth: 72, type: 'number', kind: 'readonly' },
  { key: 'lowEnd', label: 'Low End', minWidth: 80, type: 'number', kind: 'readonly' },
  { key: 'highEnd', label: 'High End', minWidth: 80, type: 'number', kind: 'readonly' },
  { key: 'area', label: 'Area', minWidth: 130, type: 'text', kind: 'area-select' },
  { key: 'note', label: 'Note', minWidth: 180, type: 'text', kind: 'text' },
  { key: 'designerNumber', label: 'Designer Number', minWidth: 130, type: 'text', kind: 'text' },
  { key: 'group', label: 'Group', minWidth: 80, type: 'text', kind: 'text' },
  { key: 'sequenceNo', label: 'No', minWidth: 90, type: 'number', kind: 'number' },
  { key: 'addressZone', label: 'Address/Zone', minWidth: 130, type: 'text', kind: 'text' },
] as const;

export const CONTROL_OPTIONS: readonly string[] = [
  '',
  'On/Off',
  'Phase',
  'PWM',
  'DALI',
  'Input/Output',
  'Input',
  'TSTAT',
  'Processor',
  'Power Supply',
  'Sensor',
  'Keypad',
  'Remote',
] as const;

export const DEFAULT_LOCATION_COLORS: readonly string[] = [
  '#FF8A65',
  '#BA68C8',
  '#4DB6AC',
  '#F06292',
  '#90A4AE',
  '#FFB74D',
  '#7986CB',
  '#A1887F',
  '#CE93D8',
  '#80CBC4',
  '#FFAB91',
] as const;

export const DEVICE_NUM_OPTIONS: readonly string[] = [
  '',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
] as const;

// Circuit pcs suggestion list (combobox via <datalist>) — direct entry also allowed.
export const CIRCUIT_PCS_OPTIONS: readonly string[] = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
] as const;

export const DIMMING_TYPE_OPTIONS: readonly string[] = [
  '',
  'On/Off',
  'Phase',
  'PWM',
  'DALI',
] as const;

export const FIXTURE_TYPE_OPTIONS: readonly string[] = [
  'DL',
  'Indirect',
] as const;

export const HVAC_PROTOCOL_OPTIONS: readonly HvacAssignment['protocol'][] = [
  'Modbus',
  'FCU',
  'BACnet',
] as const;

export const HVAC_TEMPERATURE_OPTIONS: readonly string[] = Array.from(
  { length: 26 },
  (_, i) => String(i + 10),
);

export const HVAC_THERMOSTAT_ROLE_OPTIONS: readonly HvacAssignment['thermostatRole'][] = [
  'Master',
  'Slave',
] as const;

export const CURTAIN_ACTIONS: readonly CurtainAction[] = ['Open', 'Close', 'Stop'] as const;

export const DEFAULT_FIXTURE_POWER_FACTOR = '0.7';

const DEFAULT_LOCATIONS_DATA: ReadonlyArray<readonly [string, string]> = [
  ['Entrance', '1'],
  ['Foyer', '2'],
  ['Bedroom', '3'],
  ['Living', '4'],
  ['Dining', '5'],
  ['Vanity', '6'],
  ['Bathroom', '7'],
  ['Toilet', '8'],
  ['Kitchen', '9'],
  ['Balcony', '10'],
  ['Outdoor', '11'],
] as const;

export const REMOVED_DEFAULT_DEVICE_MODELS: readonly string[] = [
  'HQP7-1',
  'Wireless OCC',
  'Pico Remote',
  'MQSE-4T20-D',
] as const;

const DEFAULT_DEVICES_DATA: ReadonlyArray<
  readonly [string, string, string, string, string, AddressMode, string, string]
> = [
  ['MP-1L-GCU', 'Processor', 'GCU', '', '', 'fixed', '-8', '4.2'],
  ['MP-2L-GCU', 'Processor', 'GCU', '', '', 'fixed', '-8', '4.2'],
  ['GCU-HOSP', 'Processor', 'GCU', '', '', 'fixed', '-8', '5.0'],
  ['GCU-HOSP-1', 'Processor', 'GCU', '', '', 'fixed', '-8', '5.0'],
  ['QSPS-DH-1-75', 'Power Supply', 'QSPS', '', '', 'fixed', '+75', ''],
  ['MQSE-4S1-D', 'On/Off', 'S', '', '', 'fixed', '+4', ''],
  ['MQSE-4A1-D', 'Phase', 'A', '5', '90', 'fixed', '+4', ''],
  ['QSN-4P20-D', 'PWM', 'P', '5', '90', 'fixed', '0', ''],
  ['QSN2-1DALUNV-D', 'DALI', '1D', '1', '90', 'dali', '0', ''],
  ['QSN2-2DALUNV-D', 'DALI', '2D', '1', '90', 'dali', '0', ''],
  ['QSE-IO', 'Input/Output', 'IO', '', '', 'fixed', '-3', ''],
  ['QSE-CI-WCI', 'Input', 'WCI', '', '', 'fixed', '-1', ''],
  ['SMC53-MYRM', 'Keypad', 'SMC53', '', '', 'fixed', '-5', '4.0'],
  ['SMC55-MYRM', 'Keypad', 'SMC55', '', '', 'fixed', '-5', '4.0'],
  ['Palladiom Tstat', 'TSTAT', 'TSTAT', '', '', 'fixed', '-1', ''],
  ['QSM', 'Sensor', 'QSM', '', '', 'fixed', '-3', ''],
  ['Palladiom Keypad', 'Keypad', 'PD', '', '', 'fixed', '-1', ''],
  ['CorridorPico', 'Remote', 'CP', '', '', 'fixed', '-1', ''],
  ['PrivacyPico', 'Remote', 'PP', '', '', 'fixed', '-1', ''],
] as const;

// Address/Zone enumeration per device model.
const DEVICE_ADDRESSES: Readonly<Record<string, string[]>> = {
  'MQSE-4S1-D': ['Zn1', 'Zn2', 'Zn3', 'Zn4', 'CCO', 'CCI'],
  'MQSE-4A1-D': ['Zn1', 'Zn2', 'Zn3', 'Zn4'],
  'QSN-4P20-D': ['Zn1', 'Zn2', 'Zn3', 'Zn4'],
  'QSN2-1DALUNV-D': Array.from({ length: 64 }, (_, i) => String(i + 1)),
  'QSN2-2DALUNV-D': [
    ...Array.from({ length: 64 }, (_, i) => String(i + 1)),
    ...Array.from({ length: 64 }, (_, i) => String(i + 1)),
  ],
  'QSE-IO': [
    ...Array.from({ length: 5 }, (_, i) => `CCI${i + 1}`),
    ...Array.from({ length: 5 }, (_, i) => `CCO${i + 1}`),
  ],
  'QSE-CI-WCI': Array.from({ length: 8 }, (_, i) => `CCI${i + 1}`),
};

export function getDeviceAddresses(model: string): string[] {
  return DEVICE_ADDRESSES[model] ?? [];
}

// Number of DALI lines for a device model. 2DALUNV has 2 lines, 1DALUNV has 1.
export function getDaliLineCount(model: string): number {
  if (/2DALUNV/i.test(model)) return 2;
  if (/1DALUNV/i.test(model)) return 1;
  return 0;
}

// Addresses per DALI line (always 64).
export const DALI_ADDRESSES_PER_LINE = 64;

export function createEmptyCircuit(): CfsCircuit {
  return {
    id: createAppId(),
    deviceGroupId: '',
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
}

export function buildDefaultRows(): CfsCircuit[] {
  return [createEmptyCircuit()];
}

export function createNewRoomType(name: string): RoomType {
  return {
    id: createAppId(),
    name,
    updatedAt: new Date().toISOString(),
    circuitIds: [],
    revision: '1.00',
    revisions: [],
    rows: buildDefaultRows(),
    dryContacts: [],
    deviceAssignments: [],
    hvacAssignments: [],
    hvacSeasons: createDefaultHvacSeasons(),
    curtainAssignments: [],
    cfsRowDisplay: createDefaultCfsRowDisplaySettings(),
    backlightLevels: createDefaultBacklightLevels(),
    scenes: [],
    roomScenes: createDefaultRoomScenes(),
    switches: [],
    pduDeviceCounts: [],
    inspectionMarks: [],
  };
}

export function createEmptyPduDeviceCount(deviceId: string = ''): PduDeviceCount {
  return {
    deviceId,
    quantity: 0,
  };
}

export function createEmptyCircuitEntry(
  designerNumber: string = '',
  circuitGroupId?: string,
): CircuitEntry {
  return {
    id: createAppId(),
    circuitGroupId: circuitGroupId ?? createAppId(),
    daliFixtureGroupId: '',
    designerNumber,
    internalNumber: '',
    dimmingType: '',
    fixture: '',
    pcs: '',
    detail: '',
    area: '',
    ffe: false,
    energySaving: false,
  };
}

export function createEmptyDryContactEntry(): DryContactEntry {
  return {
    id: createAppId(),
    area: '',
    circuit: '',
    detail: '',
  };
}

export function createEmptyScene(areaId: string): Scene {
  return {
    id: createAppId(),
    areaId,
    name: '',
    settings: [],
  };
}

export function createDefaultRoomScenes(): RoomScene[] {
  return [
    createEmptyRoomScene('Check In', 'Welcome Scene', '', 'Day'),
    createEmptyRoomScene('Check In', 'Welcome Scene', '', 'Night'),
    createEmptyRoomScene('Check In', 'Re-entry Scene', '', 'Day'),
    createEmptyRoomScene('Check In', 'Re-entry Scene', '', 'Night'),
    createEmptyRoomScene('Check In', 'Unoccupied Scene', '', ''),
    createEmptyRoomScene('Check Out', 'Occupied Scene', '', ''),
    createEmptyRoomScene('Check Out', 'Unoccupied Scene', '', ''),
  ];
}

export function createEmptyRoomScene(
  phase: RoomScenePhase = 'Check In',
  sceneType: string = '',
  detail: string = '',
  triggerCondition: string = '',
  kind: RoomSceneKind = 'standard',
): RoomScene {
  return {
    id: createAppId(),
    kind,
    phase,
    sceneType,
    detail,
    triggerCondition,
    backlightCondition: '',
    areaSceneSelections: [],
    settings: [],
  };
}

export function createEmptyDeviceAssignment(): DeviceAssignment {
  return {
    id: createAppId(),
    deviceGroupId: '',
    device: '',
    deviceNum: '',
    zoneAddress: '',
    circuitNumber: '',
    area: '',
    detail: '',
    group: '',
  };
}

export function createEmptyHvacAssignment(): HvacAssignment {
  return {
    id: createAppId(),
    protocol: 'Modbus',
    thermostatRole: 'Master',
    area: '',
    lowEnd: '20',
    highEnd: '28',
    summerWinterChange: false,
    note: '',
  };
}

export function createDefaultHvacSeasons(): HvacSeason[] {
  return [
    {
      id: createAppId(),
      name: 'Summer',
      startMonth: '6',
      startDay: '1',
      endMonth: '9',
      endDay: '30',
    },
    {
      id: createAppId(),
      name: 'Winter',
      startMonth: '12',
      startDay: '1',
      endMonth: '3',
      endDay: '31',
    },
  ];
}

export function createEmptyHvacSeason(): HvacSeason {
  return {
    id: createAppId(),
    name: '',
    startMonth: '1',
    startDay: '1',
    endMonth: '12',
    endDay: '31',
  };
}

export function createEmptyCurtainAssignment(): CurtainAssignment {
  return {
    id: createAppId(),
    area: '',
    detail: '',
    action: 'Open',
  };
}

export function createDefaultCfsRowDisplaySettings(): CfsRowDisplaySettings {
  return normalizeCfsRowDisplaySettings({});
}

export function createEmptyLocation(): LocationMaster {
  return { id: createAppId(), name: '', number: '', code: '', color: '' };
}

export function createDefaultLocations(): LocationMaster[] {
  const usedCodes = new Set<string>();
  return DEFAULT_LOCATIONS_DATA.map(([name, number], index) => {
    const code = nextUniqueAreaCode(name, usedCodes);
    usedCodes.add(code);
    return {
      id: createAppId(),
      name,
      number,
      code,
      color: DEFAULT_LOCATION_COLORS[index % DEFAULT_LOCATION_COLORS.length],
    };
  });
}

export function createEmptyFixture(): FixtureMaster {
  return {
    id: createAppId(),
    fixture: '',
    fixtureType: 'DL',
    powerMode: 'VA',
    watt: '',
    powerFactor: DEFAULT_FIXTURE_POWER_FACTOR,
  };
}

export function createEmptyDevice(): DeviceMaster {
  return {
    id: createAppId(),
    model: '',
    control: '',
    abbrev: '',
    programmingCode: '',
    lowEnd: '',
    highEnd: '',
    isDefault: false,
    addressMode: 'fixed',
    pdu: '0',
    watts: '',
  };
}

export function createEmptyInputMaster(): InputMaster {
  return { id: createAppId(), name: '' };
}

export function createEmptyTriggerMaster(): TriggerMaster {
  return { id: createAppId(), name: '' };
}

export function createDefaultDevices(): DeviceMaster[] {
  return DEFAULT_DEVICES_DATA.map(([model, control, abbrev, lowEnd, highEnd, addressMode, pdu, watts]) => ({
    id: createAppId(),
    model,
    control,
    abbrev,
    programmingCode: abbrev,
    lowEnd,
    highEnd,
    isDefault: true,
    addressMode,
    pdu,
    watts,
  }));
}

export function createDefaultInputMasters(): InputMaster[] {
  return ['Door Magnet', 'Window Magnet'].map((name) => ({
    id: createAppId(),
    name,
  }));
}

export function createDefaultTriggerMasters(): TriggerMaster[] {
  return ['Less 4 Second', 'Less 10 Second'].map((name) => ({
    id: createAppId(),
    name,
  }));
}

export const SWITCH_KIND_OPTIONS: readonly { value: SwitchKind; label: string }[] = [
  { value: 'lutronPd', label: 'Palladiom' },
  { value: 'contact', label: 'CCI' },
  { value: 'lutronPico', label: 'Pico' },
  { value: 'pir', label: 'PIR' },
  { value: 'qsm', label: 'QSM' },
] as const;

export const BUTTON_TYPE_OPTIONS: readonly { value: ButtonType; label: string }[] = [
  { value: 'single', label: 'Single' },
  { value: 'toggle', label: 'Toggle' },
  { value: 'scene', label: 'Scene' },
] as const;

export const BACKLIGHT_LEVEL_NAMES: readonly { key: string; name: string }[] = [
  { key: 'base', name: 'Base' },
  { key: 'masterOn', name: 'Bright' },
  { key: 'relax', name: 'Relax' },
  { key: 'mood', name: 'Mood' },
  { key: 'sleep', name: 'Sleep' },
] as const;

export function createDefaultBacklightLevels(): BacklightLevelSetting[] {
  return BACKLIGHT_LEVEL_NAMES.map((level) => ({
    key: level.key,
    name: level.name,
    mode: 'Manual',
    active: '100',
    inactive: '20',
  }));
}

function normalizeBacklightMode(value: unknown): BacklightLevelSetting['mode'] {
  return value === 'Dynamic Backlight Management' || value === 'DBM' ? 'DBM' : 'Manual';
}

export function normalizeBacklightLevels(
  value: unknown,
  options: { useDefaultsWhenMissing?: boolean } = {},
): BacklightLevelSetting[] {
  const defaults = createDefaultBacklightLevels();
  if (!Array.isArray(value)) return options.useDefaultsWhenMissing === false ? [] : defaults;
  const byKey = new Map(defaults.map((level) => [level.key, level]));
  return value
    .map((item): BacklightLevelSetting | null => {
      if (item === null || typeof item !== 'object') return null;
      const v = item as Record<string, unknown>;
      const key = typeof v.key === 'string' && v.key.trim() ? v.key.trim() : createAppId();
      if (key === 'light') return null;
      const defaultLevel = byKey.get(key);
      const rawName = typeof v.name === 'string' ? v.name.trim() : '';
      const name =
        key === 'masterOn' && (!rawName || /^master\s*on$/i.test(rawName))
          ? 'Bright'
          : rawName || defaultLevel?.name || 'Backlight Scene';
      return {
        key,
        name,
        mode: normalizeBacklightMode(v.mode),
        active: typeof v.active === 'string' ? v.active : defaultLevel?.active ?? '100',
        inactive: typeof v.inactive === 'string' ? v.inactive : defaultLevel?.inactive ?? '20',
      };
    })
    .filter((item): item is BacklightLevelSetting => item !== null);
}

export function backlightLevelsFromSwitches(switches: readonly SwitchEntry[] = []): BacklightLevelSetting[] {
  const byKey = new Map<string, BacklightLevelSetting>();
  let hasPalladiomSwitch = false;
  for (const sw of switches) {
    if (sw.kind !== 'lutronPd') continue;
    hasPalladiomSwitch = true;
    for (const level of normalizeBacklightLevels(sw.backlightLevels)) {
      if (!byKey.has(level.key)) byKey.set(level.key, level);
    }
  }
  return hasPalladiomSwitch ? Array.from(byKey.values()) : createDefaultBacklightLevels();
}

export function createEmptySwitchEntry(kind: SwitchKind): SwitchEntry {
  return {
    id: createAppId(),
    switchGroupId: createAppId(),
    kind,
    switchNumber: '',
    switchName: '',
    cciAssignment: '',
    buttonCount: '',
    buttonLabel: '',
    allocation: '',
    buttonFunction: '',
    buttonType: 'single',
    condition: '',
    buttonSetting: { sceneId: '', sceneIds: [], circuitSettings: [] },
    backlightTarget: '',
    backlightCondition: '',
    backlightAssignment: '',
    backlightLevels: createDefaultBacklightLevels(),
  };
}

export function calcWatt(pcsStr: string, wattEachStr: string): string {
  const pcs = Number.parseFloat(pcsStr);
  const wEach = Number.parseFloat(wattEachStr);
  if (!Number.isFinite(pcs) || !Number.isFinite(wEach)) return '';
  const result = pcs * wEach;
  if (Number.isInteger(result)) return String(result);
  return (Math.round(result * 100) / 100).toString();
}

export function fixtureUnitVa(fixture: FixtureMaster): number | null {
  const input = Number.parseFloat(fixture.watt);
  if (!Number.isFinite(input)) return null;
  if (input <= 0) return null;
  if (fixture.powerMode !== 'W') return input;
  const factor = Number.parseFloat(fixture.powerFactor || DEFAULT_FIXTURE_POWER_FACTOR);
  if (!Number.isFinite(factor) || factor <= 0) return null;
  const safeFactor = Math.min(1, factor);
  return input / safeFactor;
}

export function calcFixtureVa(pcsStr: string, fixture: FixtureMaster): string {
  const pcs = Number.parseFloat(pcsStr);
  const unitVa = fixtureUnitVa(fixture);
  if (!Number.isFinite(pcs) || unitVa === null) return '';
  const result = pcs * unitVa;
  if (Number.isInteger(result)) return String(result);
  return (Math.round(result * 100) / 100).toString();
}
