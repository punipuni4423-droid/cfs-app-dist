import type {
  CircuitEntry,
  DeviceAssignment,
  DeviceMaster,
  FixtureMaster,
  LocationMaster,
  ProgrammingNameSettings,
} from "../types";
import { calcFixtureVa } from "./constants";
import { circuitGroupKey } from "./circuitGroups";
import { isLowHighEndEligibleDimmingTypes, resolveLowHighEnd } from "./lowHighEnd";
import { normalizeProgrammingToken } from "./programming";
import {
  formatProgrammingName,
  normalizeProgrammingNameSettings,
} from "./programmingNameSettings";
import {
  OTHER_AREA_ID,
  type BaseColumn,
  type BaseColumnKey,
  type CfsZoneRow,
} from "./cfsTableModel";
import { rowDimmingValues, rowNumberValues, rowZoneValues } from "./useCfsZoneRows";

export type CfsNumberMode = "designer" | "internal";

export interface CfsBaseValueContext {
  locations: LocationMaster[];
  devices: DeviceMaster[];
  programmingNameSettings?: ProgrammingNameSettings;
  // T-33: sources for the totalVa / zoneLowEnd / zoneHighEnd columns. When
  // absent those columns resolve to "-" (callers that never show them, or old
  // call sites, stay compatible).
  circuits?: CircuitEntry[];
  fixtures?: FixtureMaster[];
  deviceAssignments?: DeviceAssignment[];
}

function programmingAreaToken(
  item: CfsZoneRow["circuits"][number],
  locationById: ReadonlyMap<string, LocationMaster>,
): string {
  const location = locationById.get(item.locationId);
  return normalizeProgrammingToken(location?.code || item.location || "");
}

function isOtherProgrammingLocation(item: CfsZoneRow["circuits"][number]): boolean {
  return item.locationId === OTHER_AREA_ID || item.location.trim().toLowerCase() === "other";
}

function programmingLocationNumberToken(
  item: CfsZoneRow["circuits"][number],
  locationById: ReadonlyMap<string, LocationMaster>,
): string {
  const locationNumber = locationById.get(item.locationId)?.number.trim() ?? "";
  return isOtherProgrammingLocation(item) ? locationNumber || "99" : locationNumber;
}

function programmingAreaTokenForName(
  item: CfsZoneRow["circuits"][number],
  locationNumber: string,
  locationById: ReadonlyMap<string, LocationMaster>,
  settings: ProgrammingNameSettings,
): string {
  if (!isOtherProgrammingLocation(item)) return programmingAreaToken(item, locationById);
  return settings.tokens.includes("locationNumber") ? "" : locationNumber || "99";
}

function programmingAddressToken(
  item: CfsZoneRow["circuits"][number],
  locationById: ReadonlyMap<string, LocationMaster>,
): string {
  const rawAddress = normalizeProgrammingToken(item.areaAddress);
  if (!rawAddress) return "";
  const area = programmingAreaToken(item, locationById);
  if (area && rawAddress.toUpperCase().startsWith(area.toUpperCase())) {
    return rawAddress.slice(area.length);
  }
  return rawAddress;
}

function normalizeZoneNumber(value: string): string {
  return normalizeProgrammingToken(value).replace(/^ZN/, "");
}

function normalizeControlAddressToken(value: string): string {
  const zone = normalizeZoneNumber(value);
  const cco = zone.match(/^CCO(\d*)$/);
  if (cco) return `O${cco[1] ?? ""}`;
  const cci = zone.match(/^CCI(\d*)$/);
  if (cci) return `I${cci[1] ?? ""}`;
  return zone;
}

function deviceProgrammingToken(
  row: CfsZoneRow,
  deviceByModel: ReadonlyMap<string, DeviceMaster>,
): string {
  const device = deviceByModel.get(row.device);
  const code = normalizeProgrammingToken(device?.programmingCode || device?.abbrev || row.device);
  const deviceNum = normalizeProgrammingToken(row.deviceNum === "-" ? "" : row.deviceNum);
  const prefix = `${code}${deviceNum}`;
  if (row.isDali) {
    const line = normalizeProgrammingToken(row.daliLine);
    const group = normalizeProgrammingToken(row.group === "-" ? "" : row.group);
    const address = normalizeZoneNumber(row.zone === "-" ? "" : row.zone);
    const route = (/2D/i.test(code) ? [line, group, address] : [group, address])
      .filter(Boolean)
      .join("-");
    return route ? `${prefix}-${route}` : prefix;
  }
  const zone = normalizeControlAddressToken(row.zone === "-" ? "" : row.zone);
  return zone ? `${prefix}-${zone}` : prefix;
}

export function cfsRowProgrammingNameValues(
  row: CfsZoneRow,
  context: CfsBaseValueContext,
): string[] {
  if (row.isBacklight || row.isHvac || row.isCurtain || row.circuits.length === 0) return [];
  const locationById = new Map(context.locations.map((location) => [location.id, location]));
  const deviceByModel = new Map(context.devices.map((device) => [device.model, device]));
  const settings = normalizeProgrammingNameSettings(context.programmingNameSettings);
  const deviceToken = deviceProgrammingToken(row, deviceByModel);
  return row.circuits.map((item) => {
    const locationNumber = programmingLocationNumberToken(item, locationById);
    return formatProgrammingName(
      {
        locationNumber,
        designerNumber: item.designerNumber.trim(),
        area: programmingAreaTokenForName(item, locationNumber, locationById, settings),
        address: programmingAddressToken(item, locationById),
        device: deviceToken,
      },
      item.detail.trim(),
      settings,
    );
  });
}

// ---- T-33: zone Total VA / Low End / High End -------------------------------

function formatVaTotal(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (Number.isInteger(n)) return String(n);
  return (Math.round(n * 100) / 100).toString();
}

export interface CfsZoneVaContext {
  // Full circuit list of the room type (all rows of every circuit group).
  circuits: readonly CircuitEntry[];
  fixtureByName: ReadonlyMap<string, FixtureMaster>;
}

/**
 * Zone Total VA. Same calculation as the Circuit tab (calcFixtureVa summed
 * over every row of the linked circuit group), so a zone linked to one group
 * matches the Circuit tab's Total VA exactly. DALI address rows sum their own
 * DALI fixture block instead of the whole group (one address = one block).
 * Backlight / HVAC / Curtain rows and zones without circuits return [] ("-").
 */
export function rowTotalVaValues(row: CfsZoneRow, context: CfsZoneVaContext): string[] {
  if (row.isBacklight || row.isHvac || row.isCurtain) return [];
  if (row.circuits.length === 0) return [];
  let sum = 0;
  let found = false;
  const seen = new Set<string>();
  const addVa = (entry: CircuitEntry): void => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    const fixture = context.fixtureByName.get(entry.fixture);
    if (!fixture) return;
    const value = Number.parseFloat(calcFixtureVa(entry.pcs, fixture));
    if (Number.isFinite(value)) {
      sum += value;
      found = true;
    }
  };
  // T-59: additional circuits merged into the zone count toward the total.
  for (const item of [...row.circuits, ...(row.zoneExtraCircuits ?? [])]) {
    const entry = item.circuit;
    const expanded = row.isDali
      ? entry.daliFixtureGroupId.trim()
        ? context.circuits.filter((c) => c.daliFixtureGroupId === entry.daliFixtureGroupId)
        : [entry]
      : context.circuits.filter((c) => circuitGroupKey(c) === circuitGroupKey(entry));
    for (const circuit of expanded.length > 0 ? expanded : [entry]) addVa(circuit);
  }
  return found ? [formatVaTotal(sum)] : [];
}

export interface CfsZoneEndContext {
  // Original circuit rows by id - CfsZoneRow.circuits carries the CFS display
  // dimming type (e.g. "PWM" for 4P20 devices), so the On/Off judgement must
  // read the Circuit tab's original value.
  circuitById: ReadonlyMap<string, CircuitEntry>;
  assignmentById: ReadonlyMap<string, DeviceAssignment>;
  deviceByModel: ReadonlyMap<string, DeviceMaster>;
}

/**
 * Zone Low/High End: DeviceAssign row override first, DeviceMaster fallback
 * second (shared resolveLowHighEnd). T-55: only zones with at least one
 * linked DALI / PWM / Phase circuit (original Circuit-tab dimming type) show
 * a value; unassigned zones, On/Off-only zones, Backlight, HVAC and Curtain
 * rows return [] ("-") - hidden overrides stay in the data.
 */
export function rowZoneLowHighEndValues(
  row: CfsZoneRow,
  key: "zoneLowEnd" | "zoneHighEnd",
  context: CfsZoneEndContext,
): string[] {
  if (row.isBacklight || row.isHvac || row.isCurtain) return [];
  const originalDimmingTypes = [...row.circuits, ...(row.zoneExtraCircuits ?? [])].map(
    (item) => context.circuitById.get(item.id)?.dimmingType ?? item.dimmingType,
  );
  if (!isLowHighEndEligibleDimmingTypes(originalDimmingTypes)) return [];
  const assignment = (row.assignmentIds ?? [])
    .map((id) => context.assignmentById.get(id))
    .find((entry): entry is DeviceAssignment => Boolean(entry));
  const resolved = resolveLowHighEnd(assignment, row.device, context.deviceByModel);
  const value = key === "zoneLowEnd" ? resolved.lowEnd : resolved.highEnd;
  return value ? [value] : [];
}

function zoneVaContextFrom(context: CfsBaseValueContext): CfsZoneVaContext {
  return {
    circuits: context.circuits ?? [],
    fixtureByName: new Map((context.fixtures ?? []).map((fixture) => [fixture.fixture, fixture])),
  };
}

function zoneEndContextFrom(context: CfsBaseValueContext): CfsZoneEndContext {
  return {
    circuitById: new Map((context.circuits ?? []).map((circuit) => [circuit.id, circuit])),
    assignmentById: new Map((context.deviceAssignments ?? []).map((assignment) => [assignment.id, assignment])),
    deviceByModel: new Map(context.devices.map((device) => [device.model, device])),
  };
}

export function cfsBaseColumnLabel(col: BaseColumn, numberMode: CfsNumberMode): string {
  return col.key === "designerNumber"
    ? numberMode === "designer" ? "Designer #" : "Internal #"
    : col.label;
}

export function cfsBaseColumnValues(
  row: CfsZoneRow,
  key: BaseColumnKey,
  numberMode: CfsNumberMode,
  context: CfsBaseValueContext,
): string[] {
  if (row.isBacklight) {
    if (key === "device") return ["Backlight Logic"];
    if (key === "detail") return row.circuits.map((item) => item.detail || "-");
    return [];
  }

  if (row.isHvac) {
    switch (key) {
      case "zone":
        return rowZoneValues(row);
      case "dimmingType":
        return rowDimmingValues(row);
      case "detail":
        return row.circuits.map((item) => item.detail || "-");
      case "area":
        return [row.location];
      case "device":
      case "deviceNum":
        return [String(row[key] ?? "")];
      default:
        return [];
    }
  }

  switch (key) {
    case "designerNumber":
      return rowNumberValues(row, numberMode);
    case "areaAddress":
      return row.circuits.map((item) => item.areaAddress || "-");
    case "programmingName":
      return cfsRowProgrammingNameValues(row, context);
    case "dimmingType":
      return rowDimmingValues(row);
    case "totalVa":
      return rowTotalVaValues(row, zoneVaContextFrom(context));
    case "zoneLowEnd":
    case "zoneHighEnd":
      return rowZoneLowHighEndValues(row, key, zoneEndContextFrom(context));
    case "area":
      return row.location ? [row.location] : [];
    case "detail":
      if (row.circuits.length === 0 && row.isIoAssignment) {
        const ioDetail = row.assignmentDetail || row.assignmentValue || "";
        return ioDetail ? [ioDetail] : [];
      }
      return row.circuits.length === 0
        ? [row.assignmentDetail || row.assignmentValue || "-"]
        : row.circuits.map((item) => item.detail || item.designerNumber || item.internalNumber || "-");
    case "zone":
      return rowZoneValues(row);
    case "group":
      return row.isDali ? [row.group || "Reserved"] : [];
    case "number":
      return [];
    case "device":
    case "deviceNum":
      return [String(row[key] ?? "")];
    default:
      return [];
  }
}
