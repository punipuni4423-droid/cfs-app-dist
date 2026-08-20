import type { ProjectData, RoomType } from "../types";

export type CfsLutronBridgeWarningSeverity = "info" | "warning" | "error";

export interface CfsLutronBridgeWarning {
  severity: CfsLutronBridgeWarningSeverity;
  code: string;
  message: string;
  sourceId?: string;
}

export interface CfsLutronBridgeRoom {
  floorName: string;
  name: string;
  roomType: string;
  sourceRoomTypeId: string;
  sourceRoomTypeName: string;
  sourceRoomTypeRevision: string;
}

export interface CfsLutronBridgeExport {
  schemaVersion: "1.0";
  exportedAt: string;
  exportedBy: string;
  sourceProjectId: string;
  sourceProjectName: string;
  sourceRoomTypeIds: string[];
  mode: "additive";
  unknownTemplatePolicy: "error";
  placeName: string;
  reassignTemplates: false;
  templateMappings: Record<string, string>;
  rooms: CfsLutronBridgeRoom[];
  summary: {
    rooms: number;
    roomTypes: number;
    templateMappings: number;
    warnings: number;
  };
  warnings: CfsLutronBridgeWarning[];
}

export interface BuildCfsLutronBridgeExportOptions {
  project: ProjectData;
  roomTypeIds?: readonly string[];
  generatedAt?: string;
  exportedBy?: string;
  placeName?: string;
  defaultFloorName?: string;
}

export interface CfsLutronBridgeValidationResult {
  errors: CfsLutronBridgeWarning[];
  warnings: CfsLutronBridgeWarning[];
}

const DEFAULT_FLOOR_NAME = "CFS Room Types";
const DEFAULT_TEMPLATE_NAME = "Default Room Template";

function safeText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeRoomTypeKey(value: string, usedKeys: Set<string>): string {
  const base =
    value
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "room_type";
  const safeBase = base === "_default" ? "room_type_default" : base;
  let candidate = safeBase;
  let suffix = 2;
  while (usedKeys.has(candidate)) {
    candidate = `${safeBase}_${suffix}`;
    suffix += 1;
  }
  usedKeys.add(candidate);
  return candidate;
}

function selectedRoomTypes(project: ProjectData, roomTypeIds?: readonly string[]): RoomType[] {
  if (!project.roomTypes.length) {
    throw new Error("Project has no room types.");
  }
  if (!roomTypeIds?.length) return project.roomTypes;

  const byId = new Map(project.roomTypes.map((roomType) => [roomType.id, roomType]));
  const selected = roomTypeIds.map((id) => byId.get(id)).filter((roomType): roomType is RoomType => Boolean(roomType));
  if (!selected.length) {
    throw new Error("Selected room type was not found.");
  }
  return selected;
}

function makeUniqueRoomName(
  floorName: string,
  roomName: string,
  usedRoomKeys: Set<string>,
): { name: string; renamed: boolean } {
  const baseName = safeText(roomName, "Room");
  let candidate = baseName;
  let suffix = 2;
  let renamed = false;
  while (usedRoomKeys.has(`${floorName}\u0000${candidate}`)) {
    candidate = `${baseName} ${suffix}`;
    suffix += 1;
    renamed = true;
  }
  usedRoomKeys.add(`${floorName}\u0000${candidate}`);
  return { name: candidate, renamed };
}

export function validateCfsLutronBridgeExport(
  payload: CfsLutronBridgeExport,
): CfsLutronBridgeValidationResult {
  const errors: CfsLutronBridgeWarning[] = [];
  const warnings: CfsLutronBridgeWarning[] = [];

  if (payload.schemaVersion !== "1.0") {
    errors.push({ severity: "error", code: "unsupported_schema_version", message: "schemaVersion must be 1.0." });
  }
  if (!payload.exportedAt || Number.isNaN(Date.parse(payload.exportedAt))) {
    errors.push({ severity: "error", code: "invalid_exported_at", message: "exportedAt must be a date-time string." });
  }
  if (!payload.exportedBy.trim()) {
    errors.push({ severity: "error", code: "missing_exported_by", message: "exportedBy is required." });
  }
  if (payload.mode !== "additive") {
    errors.push({ severity: "error", code: "unsupported_mode", message: "mode must be additive." });
  }
  if (payload.unknownTemplatePolicy !== "error") {
    errors.push({
      severity: "error",
      code: "unsupported_unknown_template_policy",
      message: "unknownTemplatePolicy must be error.",
    });
  }
  if (payload.reassignTemplates !== false) {
    errors.push({
      severity: "error",
      code: "reassign_templates_enabled",
      message: "reassignTemplates must remain false for CFS exports.",
    });
  }
  if (!payload.placeName.trim()) {
    errors.push({ severity: "error", code: "missing_place_name", message: "placeName is required." });
  }
  if (!payload.templateMappings._default?.trim()) {
    errors.push({
      severity: "error",
      code: "missing_default_template_mapping",
      message: "templateMappings._default is required.",
    });
  }
  if (!payload.rooms.length) {
    errors.push({ severity: "error", code: "missing_rooms", message: "At least one room entry is required." });
  }

  const roomKeys = new Set<string>();
  for (const [index, room] of payload.rooms.entries()) {
    const path = `rooms[${index}]`;
    if (!room.floorName.trim()) {
      errors.push({ severity: "error", code: "missing_floor_name", message: `${path}.floorName is required.` });
    }
    if (!room.name.trim()) {
      errors.push({ severity: "error", code: "missing_room_name", message: `${path}.name is required.` });
    }
    if (!room.roomType.trim()) {
      errors.push({ severity: "error", code: "missing_room_type", message: `${path}.roomType is required.` });
    } else if (!payload.templateMappings[room.roomType]) {
      warnings.push({
        severity: "warning",
        code: "room_type_uses_default_template",
        message: `${path}.roomType uses _default because it has no explicit template mapping.`,
      });
    }
    const roomKey = `${room.floorName}\u0000${room.name}`;
    if (roomKeys.has(roomKey)) {
      errors.push({
        severity: "error",
        code: "duplicate_room",
        message: `Duplicate room '${room.name}' under floor '${room.floorName}'.`,
      });
    }
    roomKeys.add(roomKey);
  }

  return { errors, warnings };
}

export function buildCfsLutronBridgeExport({
  project,
  roomTypeIds,
  generatedAt = new Date().toISOString(),
  exportedBy = "CFS",
  placeName = project.name,
  defaultFloorName = DEFAULT_FLOOR_NAME,
}: BuildCfsLutronBridgeExportOptions): CfsLutronBridgeExport {
  const roomTypes = selectedRoomTypes(project, roomTypeIds);
  const warnings: CfsLutronBridgeWarning[] = [
    {
      severity: "info",
      code: "logical_room_type_export",
      message:
        "CFS exports logical RoomType templates only. Actual room numbers and room-to-template expansion must be handled outside CFS.",
    },
  ];
  const usedRoomTypeKeys = new Set<string>();
  const usedRoomKeys = new Set<string>();
  const templateMappings: Record<string, string> = {
    _default: safeText(roomTypes[0]?.name ?? project.name, DEFAULT_TEMPLATE_NAME),
  };
  const roomTypeKeyById = new Map<string, string>();

  for (const roomType of roomTypes) {
    const roomTypeKey = normalizeRoomTypeKey(roomType.name, usedRoomTypeKeys);
    roomTypeKeyById.set(roomType.id, roomTypeKey);
    templateMappings[roomTypeKey] = safeText(roomType.name, DEFAULT_TEMPLATE_NAME);
  }

  const rooms = roomTypes.map((roomType) => {
    const roomTypeKey = roomTypeKeyById.get(roomType.id) ?? "_default";
    const floorName = safeText(defaultFloorName, DEFAULT_FLOOR_NAME);
    const uniqueName = makeUniqueRoomName(floorName, roomType.name, usedRoomKeys);
    if (uniqueName.renamed) {
      warnings.push({
        severity: "warning",
        code: "duplicate_room_name_renamed",
        message: `Room type '${roomType.name}' was renamed to '${uniqueName.name}' in the LD export to avoid a duplicate floor/name pair.`,
        sourceId: roomType.id,
      });
    }
    return {
      floorName,
      name: uniqueName.name,
      roomType: roomTypeKey,
      sourceRoomTypeId: roomType.id,
      sourceRoomTypeName: roomType.name,
      sourceRoomTypeRevision: roomType.revision || "1.00",
    };
  });

  const exportPayload: CfsLutronBridgeExport = {
    schemaVersion: "1.0",
    exportedAt: generatedAt,
    exportedBy,
    sourceProjectId: project.id,
    sourceProjectName: safeText(project.name, "CFS Project"),
    sourceRoomTypeIds: roomTypes.map((roomType) => roomType.id),
    mode: "additive",
    unknownTemplatePolicy: "error",
    placeName: safeText(placeName, "CFS Project"),
    reassignTemplates: false,
    templateMappings,
    rooms,
    summary: {
      rooms: rooms.length,
      roomTypes: roomTypes.length,
      templateMappings: Object.keys(templateMappings).length,
      warnings: warnings.length,
    },
    warnings,
  };

  const validation = validateCfsLutronBridgeExport(exportPayload);
  exportPayload.warnings = [...warnings, ...validation.warnings, ...validation.errors];
  exportPayload.summary.warnings = exportPayload.warnings.length;

  return exportPayload;
}
