import type {
  DeviceMaster,
  LocationMaster,
  ProgrammingNameSettings,
} from "../types";
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
