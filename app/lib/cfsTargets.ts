import type { CircuitEntry, LocationMaster, RoomType } from "../types";
import type { CfsZoneRow } from "./cfsTableModel";
import { OTHER_AREA_ID, type RowCircuit } from "./cfsTableModel";
import { ccoSettingTargets, cfsOnlySettingTargets, curtainSettingTargets, hvacSettingTargets, picoLedSettingTargets } from "./settingTargets";

export interface CfsResolvedTarget {
  targetId: string;
  areaId: string;
  dimmingType: string;
  label: string;
  detail: string;
}

export type CfsTargetKind = "circuit" | "hvac" | "cco" | "cci" | "curtain" | "backlight" | "picoLed" | "unknown";

export interface CfsTargetCatalogEntry {
  id: string;
  kind: CfsTargetKind;
  label: string;
  detail: string;
  validSettingTarget: boolean;
  visibleInCfs: boolean;
}

export interface CfsTargetCatalog {
  byId: Map<string, CfsTargetCatalogEntry>;
  validSettingLabels: Map<string, string>;
  cfsVisibleLabels: Map<string, string>;
}

function targetFromRowCircuit(item: RowCircuit): CfsResolvedTarget {
  return {
    targetId: item.circuit.id,
    areaId: item.circuit.area || OTHER_AREA_ID,
    dimmingType: item.circuit.dimmingType,
    label: [item.designerNumber, item.detail || item.circuit.fixture || item.circuit.id.slice(0, 6)]
      .filter(Boolean)
      .join(" / "),
    detail: [item.location, item.dimmingType].filter(Boolean).join(" / "),
  };
}

function inputTargetsForRow(row: CfsZoneRow): CfsResolvedTarget[] {
  const inputKind = (row.inputKind ?? "").trim().toUpperCase();
  if (row.circuits.length > 0 || (inputKind !== "CCO" && inputKind !== "CCI")) return [];
  const prefix = inputKind.toLowerCase();
  const assignmentIds = row.assignmentIds?.length ? row.assignmentIds : [row.id];
  return assignmentIds.map((assignmentId) => ({
    targetId: `${prefix}:${assignmentId}`,
    areaId: row.locationId || OTHER_AREA_ID,
    dimmingType: inputKind,
    label: [row.address || row.zone, row.assignmentDetail || row.assignmentValue || inputKind]
      .filter(Boolean)
      .join(" / "),
    detail: [row.device, row.deviceNum].filter(Boolean).join(" / "),
  }));
}

export function cfsTargetsForRow(row: CfsZoneRow): CfsResolvedTarget[] {
  if (row.isBacklight) return [];
  if (row.isCurtain) {
    const assignmentIds = row.assignmentIds?.length ? row.assignmentIds : [row.id];
    return assignmentIds.map((assignmentId) => ({
      targetId: `curtain:${assignmentId}`,
      areaId: row.locationId || OTHER_AREA_ID,
      dimmingType: "Curtain",
      label: ["Curtain", row.deviceNum].filter(Boolean).join(" "),
      detail: [row.location, row.assignmentDetail || row.assignmentValue || row.zone].filter(Boolean).join(" / "),
    }));
  }
  if (row.isHvac && row.hvacSettingId) {
    const metric = row.hvacMetric || "HVAC";
    return [
      {
        targetId: row.hvacSettingId,
        areaId: row.locationId,
        dimmingType: metric,
        label: ["HVAC", row.deviceNum, metric].filter(Boolean).join(" "),
        detail: [row.location, row.zone].filter(Boolean).join(" / "),
      },
    ];
  }
  return [...row.circuits, ...(row.targetAliasCircuits ?? [])].map(targetFromRowCircuit).concat(inputTargetsForRow(row));
}

export function buildCfsTargetIndex(rows: CfsZoneRow[]): Map<string, CfsResolvedTarget> {
  const map = new Map<string, CfsResolvedTarget>();
  for (const row of rows) {
    for (const target of cfsTargetsForRow(row)) {
      if (!map.has(target.targetId)) map.set(target.targetId, target);
    }
  }
  return map;
}

function kindFromTargetId(targetId: string): CfsTargetKind {
  if (targetId.startsWith("hvac:")) return "hvac";
  if (targetId.startsWith("cco:")) return "cco";
  if (targetId.startsWith("cci:")) return "cci";
  if (targetId.startsWith("curtain:")) return "curtain";
  if (targetId.startsWith("backlight:")) return "backlight";
  if (targetId.startsWith("pico-led:")) return "picoLed";
  return "unknown";
}

function upsertCatalogEntry(
  map: Map<string, CfsTargetCatalogEntry>,
  entry: CfsTargetCatalogEntry,
): void {
  const existing = map.get(entry.id);
  if (!existing) {
    map.set(entry.id, entry);
    return;
  }
  map.set(entry.id, {
    id: entry.id,
    kind: existing.kind !== "unknown" ? existing.kind : entry.kind,
    label: existing.label || entry.label,
    detail: existing.detail || entry.detail,
    validSettingTarget: existing.validSettingTarget || entry.validSettingTarget,
    visibleInCfs: existing.visibleInCfs || entry.visibleInCfs,
  });
}

export function buildCfsTargetCatalog(params: {
  rows: CfsZoneRow[];
  circuits: CircuitEntry[];
  roomType: RoomType;
  locations: LocationMaster[];
}): CfsTargetCatalog {
  const { rows, circuits, roomType, locations } = params;
  const byId = new Map<string, CfsTargetCatalogEntry>();

  for (const circuit of circuits) {
    const label = [circuit.designerNumber, circuit.detail || circuit.fixture || circuit.id.slice(0, 6)]
      .filter(Boolean)
      .join(" / ");
    upsertCatalogEntry(byId, {
      id: circuit.id,
      kind: "circuit",
      label,
      detail: [circuit.dimmingType, circuit.area].filter(Boolean).join(" / "),
      validSettingTarget: true,
      visibleInCfs: false,
    });
  }

  for (const target of ccoSettingTargets(roomType.deviceAssignments, locations)) {
    upsertCatalogEntry(byId, {
      id: target.id,
      kind: "cco",
      label: [target.circuitNumber, target.detail].filter(Boolean).join(" / "),
      detail: [target.areaName, target.dimmingType].filter(Boolean).join(" / "),
      validSettingTarget: true,
      visibleInCfs: false,
    });
  }

  for (const target of cfsOnlySettingTargets(roomType.rows, locations)) {
    upsertCatalogEntry(byId, {
      id: target.id,
      kind: kindFromTargetId(target.id),
      label: [target.circuitNumber, target.detail].filter(Boolean).join(" / "),
      detail: [target.areaName, target.dimmingType].filter(Boolean).join(" / "),
      validSettingTarget: true,
      visibleInCfs: false,
    });
  }

  for (const target of hvacSettingTargets(roomType.hvacAssignments, locations)) {
    upsertCatalogEntry(byId, {
      id: target.id,
      kind: "hvac",
      label: [target.areaName, target.circuitNumber, target.detail].filter(Boolean).join(" / "),
      detail: [target.dimmingType, target.hvacAssignmentId].filter(Boolean).join(" / "),
      validSettingTarget: true,
      visibleInCfs: false,
    });
  }

  for (const target of curtainSettingTargets(roomType.curtainAssignments ?? [], locations)) {
    upsertCatalogEntry(byId, {
      id: target.id,
      kind: "curtain",
      label: [target.areaName, target.circuitNumber, target.detail].filter(Boolean).join(" / "),
      detail: [target.dimmingType, target.curtainAssignmentId].filter(Boolean).join(" / "),
      validSettingTarget: true,
      visibleInCfs: false,
    });
  }

  for (const target of picoLedSettingTargets(roomType.switches, locations)) {
    upsertCatalogEntry(byId, {
      id: target.id,
      kind: "picoLed",
      label: [target.circuitNumber, target.detail].filter(Boolean).join(" / "),
      detail: [target.areaName, target.dimmingType].filter(Boolean).join(" / "),
      validSettingTarget: true,
      visibleInCfs: false,
    });
  }

  const cfsTargets = buildCfsTargetIndex(rows);
  for (const target of cfsTargets.values()) {
    upsertCatalogEntry(byId, {
      id: target.targetId,
      kind: kindFromTargetId(target.targetId),
      label: target.label,
      detail: target.detail,
      validSettingTarget: false,
      visibleInCfs: true,
    });
  }

  const validSettingLabels = new Map<string, string>();
  const cfsVisibleLabels = new Map<string, string>();
  for (const entry of byId.values()) {
    if (entry.validSettingTarget) validSettingLabels.set(entry.id, entry.label);
    if (entry.visibleInCfs) cfsVisibleLabels.set(entry.id, entry.label);
  }

  return { byId, validSettingLabels, cfsVisibleLabels };
}
