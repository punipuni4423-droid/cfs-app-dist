import type {
  CircuitEntry,
  DeviceMaster,
  ProgrammingNameSettings,
  ProjectData,
  RoomScene,
  RoomType,
  Scene,
  SwitchEntry,
} from "../types";
import { createDefaultDevices } from "./constants";
import { BY_SCENE_VALUE, OTHER_AREA_ID, type CfsZoneRow } from "./cfsTableModel";
import { selectedSceneIdsForSwitch } from "./cfsValueResolver";
import { buildAreaAddressAssignmentMap, normalizeProgrammingToken } from "./programming";
import { formatProgrammingName, normalizeProgrammingNameSettings } from "./programmingNameSettings";
import { circuitsForRoomType } from "./roomTypeSync";
import {
  buildCfsZoneRows,
  isCciAddress,
  isCcoAddress,
  isPalladiomBacklightTarget,
  rowDimmingValues,
  rowNumberValues,
  rowZoneValues,
  switchGroupId,
} from "./useCfsZoneRows";

export interface LutronAutomationSpec {
  format: "cfs-lutron-automation-spec";
  schemaVersion: 1;
  generatedAt: string;
  source: {
    projectId: string;
    projectName: string;
    roomTypeId: string;
    roomTypeName: string;
    roomTypeRevision: string;
  };
  summary: {
    areas: number;
    fixtures: number;
    circuits: number;
    cfsRows: number;
    lightingZones: number;
    inputs: number;
    hvacRows: number;
    backlightRows: number;
    areaScenes: number;
    roomScenes: number;
    switches: number;
    gcuDeviceCount: number;
    warnings: number;
  };
  automation: {
    recommendedRoute: "designer-template-rpa";
    directDatabaseWriteRecommended: false;
    validationTargets: string[];
  };
  areas: LutronAreaSpec[];
  fixtures: LutronFixtureSpec[];
  devices: LutronDeviceUseSpec[];
  zones: LutronZoneSpec[];
  areaScenes: LutronSceneSpec[];
  roomScenes: LutronRoomSceneSpec[];
  switches: LutronSwitchSpec[];
  pdu: LutronPduSpec[];
  warnings: LutronSpecWarning[];
}

export interface LutronAreaSpec {
  id: string;
  name: string;
  number: string;
  code: string;
}

export interface LutronFixtureSpec {
  id: string;
  fixture: string;
  fixtureType: string;
  powerMode: string;
  watt: string;
  powerFactor: string;
}

export interface LutronDeviceUseSpec {
  model: string;
  control: string;
  programmingCode: string;
  quantity: number;
  source: "deviceAssignment" | "pdu" | "deviceAssignment+pdu";
  pdu: string;
  watts: string;
}

export interface LutronZoneSpec {
  id: string;
  kind: "lighting" | "input" | "hvac" | "backlight" | "reserved";
  device: string;
  deviceNum: string;
  zone: string;
  group: string;
  daliLine: string;
  isDali: boolean;
  areaId: string;
  areaName: string;
  dimmingTypes: string[];
  circuitNumbers: string[];
  areaAddresses: string[];
  programmingNames: string[];
  detail: string;
  assignmentIds: string[];
  circuitIds: string[];
}

export interface LutronSceneLevelSpec {
  circuitId: string;
  designerNumber: string;
  detail: string;
  areaId: string;
  value: string;
}

export interface LutronSceneSpec {
  id: string;
  areaId: string;
  areaName: string;
  name: string;
  levels: LutronSceneLevelSpec[];
}

export interface LutronRoomSceneSpec {
  id: string;
  phase: RoomScene["phase"];
  sceneType: string;
  detail: string;
  triggerCondition: string;
  backlightCondition: string;
  areaSceneSelections: Array<{
    areaId: string;
    areaName: string;
    sceneId: string;
    sceneName: string;
  }>;
  directLevels: LutronSceneLevelSpec[];
}

export interface LutronSwitchSpec {
  id: string;
  switchGroupId: string;
  kind: SwitchEntry["kind"];
  switchNumber: string;
  switchName: string;
  cciAssignment: string;
  buttonLabel: string;
  buttonFunction: string;
  buttonType: SwitchEntry["buttonType"];
  condition: string;
  selectedScenes: Array<{ sceneId: string; sceneName: string; areaName: string }>;
  circuitOverrides: LutronSceneLevelSpec[];
  backlightTarget: string;
  backlightCondition: string;
}

export interface LutronPduSpec {
  deviceId: string;
  model: string;
  quantity: number;
  pdu: string;
  watts: string;
  resolved: boolean;
}

export interface LutronSpecWarning {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  sourceId?: string;
}

export interface BuildLutronAutomationSpecOptions {
  project: ProjectData;
  roomTypeId?: string;
  devices?: readonly DeviceMaster[];
  generatedAt?: string;
}

function safeValue(value: string, fallback = ""): string {
  const trimmed = value.trim();
  return trimmed || fallback;
}

function circuitLabel(circuit: CircuitEntry): string {
  return [circuit.designerNumber || "-", circuit.detail || circuit.fixture || circuit.id.slice(0, 8)]
    .filter(Boolean)
    .join(" / ");
}

function isSyntheticTargetId(value: string): boolean {
  return /^(cco|cci|hvac|backlight):/i.test(value);
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

function deviceProgrammingToken(row: CfsZoneRow, deviceByModel: ReadonlyMap<string, DeviceMaster>): string {
  const device = deviceByModel.get(row.device);
  const code = normalizeProgrammingToken(device?.programmingCode || device?.abbrev || row.device);
  const deviceNum = normalizeProgrammingToken(row.deviceNum === "-" ? "" : row.deviceNum);
  const prefix = `${code}${deviceNum}`;
  if (row.isDali) {
    const line = normalizeProgrammingToken(row.daliLine);
    const group = normalizeProgrammingToken(row.group === "-" ? "" : row.group);
    const address = normalizeZoneNumber(row.zone === "-" ? "" : row.zone);
    const route = (/2D/i.test(code) ? [line, group, address] : [group, address]).filter(Boolean).join("-");
    return route ? `${prefix}-${route}` : prefix;
  }
  const zone = normalizeControlAddressToken(row.zone === "-" ? "" : row.zone);
  return zone ? `${prefix}-${zone}` : prefix;
}

function programmingAreaToken(
  item: CfsZoneRow["circuits"][number],
  locationById: ReadonlyMap<string, ProjectData["locations"][number]>,
): string {
  const location = locationById.get(item.locationId);
  return normalizeProgrammingToken(location?.code || item.location || "");
}

function isOtherProgrammingLocation(item: CfsZoneRow["circuits"][number]): boolean {
  return item.locationId === OTHER_AREA_ID || item.location.trim().toLowerCase() === "other";
}

function programmingLocationNumberToken(
  item: CfsZoneRow["circuits"][number],
  locationById: ReadonlyMap<string, ProjectData["locations"][number]>,
): string {
  const locationNumber = locationById.get(item.locationId)?.number.trim() ?? "";
  return isOtherProgrammingLocation(item) ? locationNumber || "99" : locationNumber;
}

function programmingAreaTokenForName(
  item: CfsZoneRow["circuits"][number],
  locationById: ReadonlyMap<string, ProjectData["locations"][number]>,
  programmingNameSettings: ProgrammingNameSettings,
  locationNumber: string,
): string {
  if (!isOtherProgrammingLocation(item)) return programmingAreaToken(item, locationById);
  return programmingNameSettings.tokens.includes("locationNumber") ? "" : locationNumber || "99";
}

function programmingAddressToken(
  item: CfsZoneRow["circuits"][number],
  locationById: ReadonlyMap<string, ProjectData["locations"][number]>,
): string {
  const rawAddress = normalizeProgrammingToken(item.areaAddress);
  if (!rawAddress) return "";
  const area = programmingAreaToken(item, locationById);
  if (area && rawAddress.toUpperCase().startsWith(area.toUpperCase())) {
    return rawAddress.slice(area.length);
  }
  return rawAddress;
}

function rowCircuitDetailText(item: CfsZoneRow["circuits"][number]): string {
  return item.detail.trim() || item.designerNumber.trim() || item.internalNumber.trim();
}

function rowProgrammingNameValues(
  row: CfsZoneRow,
  locationById: ReadonlyMap<string, ProjectData["locations"][number]>,
  deviceByModel: ReadonlyMap<string, DeviceMaster>,
  programmingNameSettings: ProgrammingNameSettings,
): string[] {
  if (row.isBacklight || row.isHvac || row.circuits.length === 0) return [];
  const deviceToken = deviceProgrammingToken(row, deviceByModel);
  return row.circuits.map((item) => {
    const locationNumber = programmingLocationNumberToken(item, locationById);
    const designerNumber = item.designerNumber.trim();
    const detail = rowCircuitDetailText(item);
    return formatProgrammingName(
      {
        locationNumber,
        designerNumber,
        area: programmingAreaTokenForName(item, locationById, programmingNameSettings, locationNumber),
        address: programmingAddressToken(item, locationById),
        device: deviceToken,
      },
      detail,
      programmingNameSettings,
    );
  });
}

function zoneKind(row: CfsZoneRow): LutronZoneSpec["kind"] {
  if (row.isHvac) return "hvac";
  if (row.isBacklight) return "backlight";
  if (row.circuits.length === 0 && !row.assignmentValue) return "reserved";
  if (isCciAddress(row.address) || isCcoAddress(row.address) || row.inputKind) return "input";
  return "lighting";
}

function buildRows(
  project: ProjectData,
  roomType: RoomType,
): CfsZoneRow[] {
  const circuits = circuitsForRoomType(project, roomType);
  const locationById = new Map(project.locations.map((location) => [location.id, location]));
  const areaAddressByAssignmentCircuit = buildAreaAddressAssignmentMap(
    roomType.deviceAssignments,
    circuits,
    project.locations,
  );
  const palladiomBySceneTargets = new Map<string, SwitchEntry>();
  for (const sw of roomType.switches) {
    if (sw.kind !== "lutronPd") continue;
    if (!isPalladiomBacklightTarget(sw)) continue;
    const key = switchGroupId(sw);
    if (!palladiomBySceneTargets.has(key)) palladiomBySceneTargets.set(key, sw);
  }
  return buildCfsZoneRows({
    roomType,
    circuits,
    locations: project.locations,
    locationById,
    areaAddressByAssignmentCircuit,
    palladiomBySceneTargets,
    selectedAreaIds: new Set<string>(),
    hiddenDeviceKeys: new Set<string>(),
    sortMode: "device",
  });
}

function toSceneLevels(
  settings: readonly { circuitId: string; percentage: string }[],
  circuitsById: ReadonlyMap<string, CircuitEntry>,
  locationById: ReadonlyMap<string, ProjectData["locations"][number]>,
): LutronSceneLevelSpec[] {
  return settings.map((setting) => {
    const circuit = circuitsById.get(setting.circuitId);
    return {
      circuitId: setting.circuitId,
      designerNumber: circuit?.designerNumber ?? "",
      detail: circuit?.detail ?? "",
      areaId: circuit?.area ?? "",
      value: setting.percentage,
    };
  }).filter((level) => {
    if (level.circuitId.startsWith("cco:")) return true;
    return Boolean(circuitsById.get(level.circuitId) || locationById.get(level.areaId));
  });
}

function toAreaSceneSpec(
  scene: Scene,
  circuitsById: ReadonlyMap<string, CircuitEntry>,
  locationById: ReadonlyMap<string, ProjectData["locations"][number]>,
): LutronSceneSpec {
  return {
    id: scene.id,
    areaId: scene.areaId,
    areaName: locationById.get(scene.areaId)?.name ?? "",
    name: scene.name,
    levels: toSceneLevels(scene.settings, circuitsById, locationById),
  };
}

function toRoomSceneSpec(
  roomScene: RoomScene,
  scenesById: ReadonlyMap<string, Scene>,
  circuitsById: ReadonlyMap<string, CircuitEntry>,
  locationById: ReadonlyMap<string, ProjectData["locations"][number]>,
): LutronRoomSceneSpec {
  return {
    id: roomScene.id,
    phase: roomScene.phase,
    sceneType: roomScene.sceneType,
    detail: roomScene.detail,
    triggerCondition: roomScene.triggerCondition,
    backlightCondition: roomScene.backlightCondition,
    areaSceneSelections: roomScene.areaSceneSelections.map((selection) => {
      const selectedScene = scenesById.get(selection.sceneId);
      return {
        areaId: selection.areaId,
        areaName: locationById.get(selection.areaId)?.name ?? "",
        sceneId: selection.sceneId,
        sceneName: selectedScene?.name ?? "",
      };
    }),
    directLevels: toSceneLevels(roomScene.settings, circuitsById, locationById),
  };
}

function toSwitchSpec(
  sw: SwitchEntry,
  scenesById: ReadonlyMap<string, Scene>,
  circuitsById: ReadonlyMap<string, CircuitEntry>,
  locationById: ReadonlyMap<string, ProjectData["locations"][number]>,
): LutronSwitchSpec {
  return {
    id: sw.id,
    switchGroupId: switchGroupId(sw),
    kind: sw.kind,
    switchNumber: sw.switchNumber,
    switchName: sw.switchName,
    cciAssignment: sw.cciAssignment,
    buttonLabel: sw.buttonLabel,
    buttonFunction: sw.buttonFunction,
    buttonType: sw.buttonType,
    condition: sw.condition,
    selectedScenes: selectedSceneIdsForSwitch(sw).map((sceneId) => {
      const scene = scenesById.get(sceneId);
      return {
        sceneId,
        sceneName: scene?.name ?? "",
        areaName: scene ? locationById.get(scene.areaId)?.name ?? "" : "",
      };
    }),
    circuitOverrides: toSceneLevels(sw.buttonSetting.circuitSettings, circuitsById, locationById),
    backlightTarget: sw.backlightTarget,
    backlightCondition: sw.backlightCondition === BY_SCENE_VALUE ? "" : sw.backlightCondition,
  };
}

function toZoneSpec(
  row: CfsZoneRow,
  locationById: ReadonlyMap<string, ProjectData["locations"][number]>,
  deviceByModel: ReadonlyMap<string, DeviceMaster>,
  programmingNameSettings: ProgrammingNameSettings,
): LutronZoneSpec {
  const programmingNames = rowProgrammingNameValues(row, locationById, deviceByModel, programmingNameSettings);
  return {
    id: row.id,
    kind: zoneKind(row),
    device: row.device === "-" ? "" : row.device,
    deviceNum: row.deviceNum === "-" ? "" : row.deviceNum,
    zone: rowZoneValues(row).join(" / "),
    group: row.group === "-" ? "" : row.group,
    daliLine: row.daliLine,
    isDali: row.isDali,
    areaId: row.locationId === OTHER_AREA_ID ? "" : row.locationId,
    areaName: row.locationId === OTHER_AREA_ID ? "" : row.location,
    dimmingTypes: rowDimmingValues(row),
    circuitNumbers: rowNumberValues(row, "designer"),
    areaAddresses: row.circuits.map((item) => item.areaAddress).filter(Boolean),
    programmingNames,
    detail:
      row.assignmentDetail ||
      row.assignmentValue ||
      row.circuits.map(rowCircuitDetailText).filter(Boolean).join(" / "),
    assignmentIds: row.assignmentIds ?? [row.id],
    circuitIds: row.circuits.map((item) => item.id),
  };
}

function deviceUseKey(model: string): string {
  return model.trim().toUpperCase();
}

function buildDeviceUses(
  roomType: RoomType,
  devices: readonly DeviceMaster[],
): LutronDeviceUseSpec[] {
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  const devicesByModel = new Map(devices.map((device) => [deviceUseKey(device.model), device]));
  const uses = new Map<string, LutronDeviceUseSpec>();

  function upsert(device: DeviceMaster | undefined, model: string, quantity: number, source: LutronDeviceUseSpec["source"]): void {
    const normalizedModel = safeValue(device?.model ?? model);
    if (!normalizedModel || quantity <= 0) return;
    const key = deviceUseKey(normalizedModel);
    const existing = uses.get(key);
    const nextSource =
      existing && existing.source !== source
        ? "deviceAssignment+pdu"
        : source;
    uses.set(key, {
      model: normalizedModel,
      control: device?.control ?? "",
      programmingCode: device?.programmingCode || device?.abbrev || "",
      quantity: (existing?.quantity ?? 0) + quantity,
      source: nextSource,
      pdu: device?.pdu ?? "",
      watts: device?.watts ?? "",
    });
  }

  const assignmentGroups = new Map<string, { model: string; device?: DeviceMaster }>();
  for (const assignment of roomType.deviceAssignments) {
    const model = assignment.device.trim();
    if (!model) continue;
    const key = assignment.deviceGroupId || `${model}:${assignment.deviceNum}:${assignment.zoneAddress}`;
    assignmentGroups.set(key, {
      model,
      device: devicesByModel.get(deviceUseKey(model)),
    });
  }
  for (const group of assignmentGroups.values()) {
    upsert(group.device, group.model, 1, "deviceAssignment");
  }

  for (const pduCount of roomType.pduDeviceCounts) {
    const device = devicesById.get(pduCount.deviceId);
    upsert(device, device?.model ?? pduCount.deviceId, pduCount.quantity, "pdu");
  }

  return Array.from(uses.values()).sort((a, b) => a.model.localeCompare(b.model, "en", { numeric: true }));
}

function buildPdu(roomType: RoomType, devices: readonly DeviceMaster[]): LutronPduSpec[] {
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  return roomType.pduDeviceCounts.map((count) => {
    const device = devicesById.get(count.deviceId);
    return {
      deviceId: count.deviceId,
      model: device?.model ?? "",
      quantity: count.quantity,
      pdu: device?.pdu ?? "",
      watts: device?.watts ?? "",
      resolved: Boolean(device),
    };
  });
}

function buildWarnings(
  project: ProjectData,
  roomType: RoomType,
  devices: readonly DeviceMaster[],
  zones: readonly LutronZoneSpec[],
): LutronSpecWarning[] {
  const warnings: LutronSpecWarning[] = [];
  const circuits = circuitsForRoomType(project, roomType);
  const deviceModels = new Set(devices.map((device) => deviceUseKey(device.model)));
  const circuitIds = new Set(circuits.map((circuit) => circuit.id));
  const sceneIds = new Set(roomType.scenes.map((scene) => scene.id));
  const locationIds = new Set(project.locations.map((location) => location.id));

  if (project.locations.length === 0) {
    warnings.push({ severity: "error", code: "no_areas", message: "Project has no areas." });
  }
  if (circuits.length === 0) {
    warnings.push({ severity: "warning", code: "no_circuits", message: "Project has no circuits." });
  }
  if (roomType.deviceAssignments.length === 0) {
    warnings.push({ severity: "warning", code: "no_device_assignments", message: "Room type has no device assignments." });
  }
  for (const circuit of circuits) {
    if (circuit.area && !locationIds.has(circuit.area)) {
      warnings.push({
        severity: "error",
        code: "missing_circuit_area",
        message: `Circuit ${circuitLabel(circuit)} references a missing area.`,
        sourceId: circuit.id,
      });
    } else if (!circuit.area) {
      warnings.push({
        severity: "warning",
        code: "unassigned_circuit_area",
        message: `Circuit ${circuitLabel(circuit)} has no area.`,
        sourceId: circuit.id,
      });
    }
  }
  for (const assignment of roomType.deviceAssignments) {
    if (assignment.device.trim() && !deviceModels.has(deviceUseKey(assignment.device))) {
      warnings.push({
        severity: "warning",
        code: "missing_device_master",
        message: `Device assignment uses ${assignment.device}, but the device master was not supplied to the spec builder.`,
        sourceId: assignment.id,
      });
    }
  }
  for (const scene of roomType.scenes) {
    for (const setting of scene.settings) {
      if (isSyntheticTargetId(setting.circuitId)) continue;
      if (!circuitIds.has(setting.circuitId)) {
        warnings.push({
          severity: "error",
          code: "scene_missing_circuit",
          message: `Area Scene ${scene.name || scene.id} references a missing circuit.`,
          sourceId: scene.id,
        });
      }
    }
  }
  for (const sw of roomType.switches) {
    for (const sceneId of selectedSceneIdsForSwitch(sw)) {
      if (!sceneIds.has(sceneId)) {
        warnings.push({
          severity: "error",
          code: "switch_missing_scene",
          message: `Switch ${sw.switchNumber || sw.id} references a missing scene.`,
          sourceId: sw.id,
        });
      }
    }
  }
  for (const pduCount of roomType.pduDeviceCounts) {
    if (!devices.some((device) => device.id === pduCount.deviceId)) {
      warnings.push({
        severity: "warning",
        code: "pdu_device_unresolved",
        message: "PDU device count references a device ID that is not available to the server-side spec builder.",
        sourceId: pduCount.deviceId,
      });
    }
  }
  const reservedRows = zones.filter((zone) => zone.kind === "reserved").length;
  if (reservedRows > 0) {
    warnings.push({
      severity: "info",
      code: "reserved_rows",
      message: `${reservedRows} reserved CFS row(s) are included for review but will not create Lutron loads.`,
    });
  }
  return warnings;
}

export function buildLutronAutomationSpec({
  project,
  roomTypeId,
  devices = createDefaultDevices(),
  generatedAt = new Date().toISOString(),
}: BuildLutronAutomationSpecOptions): LutronAutomationSpec {
  const roomType = project.roomTypes.find((candidate) => candidate.id === roomTypeId) ?? project.roomTypes[0];
  if (!roomType) {
    throw new Error("Project has no room types.");
  }

  const locationById = new Map(project.locations.map((location) => [location.id, location]));
  const circuits = circuitsForRoomType(project, roomType);
  const circuitsById = new Map(circuits.map((circuit) => [circuit.id, circuit]));
  const deviceByModel = new Map(devices.map((device) => [device.model, device]));
  const scenesById = new Map(roomType.scenes.map((scene) => [scene.id, scene]));
  const rows = buildRows(project, roomType);
  const programmingNameSettings = normalizeProgrammingNameSettings(project.settings?.programmingName);
  const zones = rows.map((row) => toZoneSpec(row, locationById, deviceByModel, programmingNameSettings));
  const pdu = buildPdu(roomType, devices);
  const warnings = buildWarnings(project, roomType, devices, zones);
  const gcuDeviceCount = buildDeviceUses(roomType, devices)
    .filter((device) => /GCU/i.test(`${device.model} ${device.control} ${device.programmingCode}`))
    .reduce((sum, device) => sum + device.quantity, 0);

  return {
    format: "cfs-lutron-automation-spec",
    schemaVersion: 1,
    generatedAt,
    source: {
      projectId: project.id,
      projectName: project.name,
      roomTypeId: roomType.id,
      roomTypeName: roomType.name,
      roomTypeRevision: roomType.revision,
    },
    summary: {
      areas: project.locations.length,
      fixtures: project.fixtures.length,
      circuits: circuits.length,
      cfsRows: zones.length,
      lightingZones: zones.filter((zone) => zone.kind === "lighting").length,
      inputs: zones.filter((zone) => zone.kind === "input").length,
      hvacRows: zones.filter((zone) => zone.kind === "hvac").length,
      backlightRows: zones.filter((zone) => zone.kind === "backlight").length,
      areaScenes: roomType.scenes.length,
      roomScenes: roomType.roomScenes.length,
      switches: roomType.switches.length,
      gcuDeviceCount,
      warnings: warnings.length,
    },
    automation: {
      recommendedRoute: "designer-template-rpa",
      directDatabaseWriteRecommended: false,
      validationTargets: [
        "CFS project JSON",
        "Lutron Designer UI automation log",
        "Lutron LocalDB read-only comparison",
        "TransferOutput SQLite read-only comparison",
      ],
    },
    areas: project.locations.map((location) => ({
      id: location.id,
      name: location.name,
      number: location.number,
      code: location.code,
    })),
    fixtures: project.fixtures.map((fixture) => ({ ...fixture })),
    devices: buildDeviceUses(roomType, devices),
    zones,
    areaScenes: roomType.scenes.map((scene) => toAreaSceneSpec(scene, circuitsById, locationById)),
    roomScenes: roomType.roomScenes.map((scene) => toRoomSceneSpec(scene, scenesById, circuitsById, locationById)),
    switches: roomType.switches.map((sw) => toSwitchSpec(sw, scenesById, circuitsById, locationById)),
    pdu,
    warnings,
  };
}
