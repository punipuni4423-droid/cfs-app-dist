import type { CfsRowKind, CircuitEntry, DeviceAssignment, RoomScene, SwitchEntry } from "../types";

export type BaseColumnKey =
  | "designerNumber"
  | "areaAddress"
  | "programmingName"
  | "device"
  | "deviceNum"
  | "dimmingType"
  | "group"
  | "zone"
  | "number"
  | "area"
  | "detail";

export interface BaseColumn {
  key: BaseColumnKey;
  label: string;
  minWidth: number;
}

export interface RowCircuit {
  id: string;
  designerNumber: string;
  internalNumber: string;
  dimmingType: string;
  location: string;
  locationId: string;
  locationColor: string;
  areaAddress: string;
  detail: string;
  circuit: CircuitEntry;
}

export interface CfsZoneRow {
  id: string;
  orderIndex: number;
  assignmentIds?: string[];
  device: string;
  deviceNum: string;
  zone: string;
  group: string;
  address: string;
  daliLine: string;
  isDali: boolean;
  location: string;
  locationId: string;
  locationColor: string;
  circuits: RowCircuit[];
  targetAliasCircuits?: RowCircuit[];
  isHvac?: boolean;
  isCci?: boolean;
  isCurtain?: boolean;
  rowKind?: CfsRowKind;
  isBacklight?: boolean;
  backlightSourceId?: string;
  backlightTargetGroupId?: string;
  backlightValue?: string;
  backlightTargetLabel?: string;
  hvacSettingId?: string;
  hvacMetric?: string;
  assignmentValue?: string;
  assignmentDetail?: string;
  inputKind?: string;
  isIoAssignment?: boolean;
}

export interface FunctionColumn {
  id: string;
  category: "scene" | "command" | "switch";
  sourceOrder?: number;
  switchGroupKey: string;
  buttonKey: string;
  switchNumber: string;
  switchName: string;
  button: string;
  functionName: string;
  condition: string;
  kind: SwitchEntry["kind"] | "scene";
  source?: SwitchEntry;
  roomScene?: RoomScene;
  pirLabels?: string[];
}

export type MergeInfo = { isFirst: boolean; rowSpan: number };
export type CfsSortMode = "device" | "area" | "internal" | "programmingName";
export type CfsDisplayAssignment = DeviceAssignment & { assignmentIds: string[] };
export type FunctionColumnGroup = {
  key: string;
  label: string;
  kind: FunctionColumn["kind"];
  columns: FunctionColumn[];
};

export const OTHER_AREA_ID = "__other__";
export const BY_SCENE_VALUE = "__byScene";

export const BASE_COLUMNS: BaseColumn[] = [
  { key: "number", label: "No", minWidth: 44 },
  { key: "device", label: "Device", minWidth: 150 },
  { key: "deviceNum", label: "Device #", minWidth: 82 },
  { key: "dimmingType", label: "Type", minWidth: 102 },
  { key: "group", label: "Group", minWidth: 92 },
  { key: "zone", label: "Zone / Address", minWidth: 116 },
  { key: "designerNumber", label: "Designer #", minWidth: 96 },
  { key: "area", label: "Area", minWidth: 130 },
  { key: "areaAddress", label: "Area Address", minWidth: 112 },
  { key: "detail", label: "Detail", minWidth: 170 },
  { key: "programmingName", label: "Programming Name", minWidth: 240 },
];
export const CFS_FUNCTION_COLUMN_WIDTH = 106;
export const BACKLIGHT_LOGIC_MERGE_KEYS: BaseColumnKey[] = [
  "device",
  "deviceNum",
  "dimmingType",
  "group",
  "zone",
  "designerNumber",
  "area",
  "areaAddress",
];
