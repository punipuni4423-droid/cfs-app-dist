import type { CfsRowKind, CircuitEntry, DeviceAssignment, RoomScene, SwitchEntry } from "../types";

export type BaseColumnKey =
  | "designerNumber"
  | "areaAddress"
  | "programmingName"
  | "device"
  | "deviceNum"
  | "dimmingType"
  | "totalVa"
  | "zoneLowEnd"
  | "zoneHighEnd"
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
  // T-56 (was T-33): the three zone columns live directly after Designer #
  // in the order Low End -> High End -> Total VA. Never place any of them
  // between "group" and "zone" - the on-screen and Excel group+zone merge
  // relies on those two being adjacent in the visible order.
  { key: "zoneLowEnd", label: "Low End", minWidth: 84 },
  { key: "zoneHighEnd", label: "High End", minWidth: 84 },
  { key: "totalVa", label: "Total VA", minWidth: 88 },
  { key: "area", label: "Area", minWidth: 130 },
  { key: "areaAddress", label: "Area Address", minWidth: 112 },
  { key: "detail", label: "Detail", minWidth: 170 },
  { key: "programmingName", label: "Programming Name", minWidth: 240 },
];
export const CFS_FUNCTION_COLUMN_WIDTH = 106;
// The Backlight Logic merged band assumes its keys are CONTIGUOUS in the
// default column order (colSpan math in CfsView/cfsExcelExport), and the
// band anchor is the FIRST visible key of this array, so the array order
// must match the default display order. The three T-56 columns sit between
// designerNumber and area, so they must be members; otherwise the merged
// "Backlight Logic" cell would overlap their cells.
export const BACKLIGHT_LOGIC_MERGE_KEYS: BaseColumnKey[] = [
  "device",
  "deviceNum",
  "dimmingType",
  "group",
  "zone",
  "designerNumber",
  "zoneLowEnd",
  "zoneHighEnd",
  "totalVa",
  "area",
  "areaAddress",
];

// T-56 (was T-33): saved base-column orders from before these columns existed
// do not contain the new keys. Instead of appending them at the end, insert
// each one right after its anchor so existing users see them directly after
// Designer # in the order Low End -> High End -> Total VA.
const NEW_BASE_COLUMN_ANCHORS: ReadonlyArray<readonly [BaseColumnKey, BaseColumnKey]> = [
  ["zoneLowEnd", "designerNumber"],
  ["zoneHighEnd", "zoneLowEnd"],
  ["totalVa", "zoneHighEnd"],
];

/**
 * Builds the ordered column list from a saved baseColumnOrder. Unknown keys
 * are dropped, missing legacy keys keep the historical append-at-end
 * behavior, and the new T-33/T-56 keys are inserted after their anchor
 * column (Designer #) when the saved order predates them.
 */
export function orderBaseColumns(order: readonly BaseColumnKey[]): BaseColumn[] {
  const byKey = new Map(BASE_COLUMNS.map((col) => [col.key, col]));
  const ordered = order
    .map((key) => byKey.get(key))
    .filter((col): col is BaseColumn => Boolean(col));
  const present = new Set(ordered.map((col) => col.key));
  for (const [key, anchorKey] of NEW_BASE_COLUMN_ANCHORS) {
    if (present.has(key)) continue;
    const col = byKey.get(key);
    if (!col) continue;
    const anchorIndex = ordered.findIndex((c) => c.key === anchorKey);
    if (anchorIndex < 0) continue; // empty/partial orders fall back to the default append below
    ordered.splice(anchorIndex + 1, 0, col);
    present.add(key);
  }
  return [...ordered, ...BASE_COLUMNS.filter((col) => !present.has(col.key))];
}
