import type { CircuitEntry, DeviceAssignment, LocationMaster, RoomType, SceneCircuitSetting, SwitchEntry } from "../types";
import { selectedSceneIdsForSwitch } from "./cfsValueResolver";
import { buildCfsTargetCatalog, type CfsTargetCatalog } from "./cfsTargets";
import { buildCfsZoneRows, isPalladiomBacklightTarget, normalizeBacklightCondition } from "./useCfsZoneRows";
import { buildAreaAddressAssignmentMap } from "./programming";
import { hasMeaningfulBacklightSource } from "./switchSync";

export type CfsLinkNodeGroup =
  | "Circuit"
  | "Device Assign"
  | "Area Scene"
  | "Scene"
  | "Switch"
  | "Command"
  | "HVAC"
  | "Backlight"
  | "CFS"
  | "Inspection";

export type CfsLinkNodeKind = "tab" | "record" | "target" | "cfs";
export type CfsLinkEdgeKind = "reference" | "render" | "editable" | "fallback" | "diagnostic";
export type CfsLinkRisk = "ok" | "warning" | "error";
export type CfsLinkIssueSeverity = "info" | "warning" | "error";
export type CfsLinkIssueCode =
  | "missing_target"
  | "stale_hvac_target"
  | "missing_area_scene"
  | "missing_switch_scene"
  | "duplicate_switch_column"
  | "dali_ambiguous"
  | "designer_missing"
  | "missing_backlight_target"
  | "backlight_target_not_by_scene"
  | "missing_backlight_condition"
  | "missing_backlight_cfs_row";

export interface CfsLinkNode {
  id: string;
  group: CfsLinkNodeGroup;
  kind: CfsLinkNodeKind;
  label: string;
  detail?: string;
}

export interface CfsLinkEdge {
  id: string;
  from: string;
  to: string;
  fromGroup: CfsLinkNodeGroup;
  toGroup: CfsLinkNodeGroup;
  kind: CfsLinkEdgeKind;
  risk: CfsLinkRisk;
  label: string;
  keys: string[];
}

export interface CfsLinkIssue {
  id: string;
  code: CfsLinkIssueCode;
  severity: CfsLinkIssueSeverity;
  group: CfsLinkNodeGroup;
  title: string;
  detail: string;
  sourceId?: string;
  sourceIds?: string[];
  targetId?: string;
}

export interface CfsLinkageSummary {
  nodes: number;
  edges: number;
  issues: number;
  errors: number;
  warnings: number;
  circuits: number;
  assignments: number;
  areaScenes: number;
  roomScenes: number;
  switches: number;
  cfsTargets: number;
  signature: string;
}

export interface CfsLinkageGraph {
  version: 1;
  nodes: CfsLinkNode[];
  edges: CfsLinkEdge[];
  issues: CfsLinkIssue[];
  summary: CfsLinkageSummary;
}

export interface CfsLinkageSnapshot {
  version: 1;
  summary: CfsLinkageSummary;
  nodes: CfsLinkNode[];
  edges: CfsLinkEdge[];
  issues: CfsLinkIssue[];
}

export interface CfsLinkageDiff {
  signatureChanged: boolean;
  addedEdges: CfsLinkEdge[];
  removedEdges: CfsLinkEdge[];
  addedIssues: CfsLinkIssue[];
  resolvedIssues: CfsLinkIssue[];
}

function clean(value: string | undefined | null): string {
  return (value ?? "").trim();
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isCciAddress(value: string): boolean {
  return /^cci/i.test(clean(value));
}

function isCcoAddress(value: string): boolean {
  return /^cco/i.test(clean(value));
}

function isCciOrCcoAddress(value: string): boolean {
  return isCciAddress(value) || isCcoAddress(value);
}

function isDaliDevice(assignment: DeviceAssignment): boolean {
  return /dali|dalunv/i.test(assignment.device);
}

function assignmentAddressIndex(assignment: DeviceAssignment): number | null {
  const match = clean(assignment.zoneAddress).match(/\d+/);
  if (!match) return null;
  const index = Number.parseInt(match[0], 10) - 1;
  return Number.isFinite(index) && index >= 0 ? index : null;
}

function switchGroupId(sw: SwitchEntry): string {
  return clean(sw.switchGroupId) || sw.id;
}

function switchColumnSignature(sw: SwitchEntry): string {
  return [
    sw.kind,
    clean(sw.switchNumber),
    clean(sw.switchName),
    clean(sw.buttonLabel),
    clean(sw.buttonFunction),
    clean(sw.condition),
  ].join("|");
}

function switchSourceGroup(sw: SwitchEntry): CfsLinkNodeGroup {
  if (sw.kind === "command") return "Command";
  if (sw.kind === "tstat") return "HVAC";
  if (hasMeaningfulBacklightSource(sw)) return "Backlight";
  return "Switch";
}

export function sourceIdsForIssue(issue: CfsLinkIssue): string[] {
  if (issue.sourceIds?.length) return issue.sourceIds;
  return (issue.sourceId ?? "").split(",").map((id) => id.trim()).filter(Boolean);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

function makeTabNode(group: CfsLinkNodeGroup, detail: string): CfsLinkNode {
  return {
    id: `tab:${group}`,
    group,
    kind: "tab",
    label: group,
    detail,
  };
}

function createNodeStore(): {
  add: (node: CfsLinkNode) => void;
  nodes: () => CfsLinkNode[];
} {
  const map = new Map<string, CfsLinkNode>();
  return {
    add(node) {
      if (!map.has(node.id)) map.set(node.id, node);
    },
    nodes() {
      return sortById(Array.from(map.values()));
    },
  };
}

function createIssueStore(): {
  add: (issue: CfsLinkIssue) => void;
  issues: () => CfsLinkIssue[];
} {
  const map = new Map<string, CfsLinkIssue>();
  return {
    add(issue) {
      if (!map.has(issue.id)) map.set(issue.id, issue);
    },
    issues() {
      return sortById(Array.from(map.values()));
    },
  };
}

function addEdge(edges: CfsLinkEdge[], edge: Omit<CfsLinkEdge, "id">): void {
  const id = `${edge.from}->${edge.to}:${edge.kind}:${edge.label}:${edge.keys.join("|")}`;
  edges.push({ ...edge, id: stableHash(id) });
}

function targetGroup(targetId: string, catalog: CfsTargetCatalog): CfsLinkNodeGroup {
  const kind = catalog.byId.get(targetId)?.kind;
  if (kind === "hvac") return "HVAC";
  if (kind === "cco" || kind === "cci" || kind === "curtain") return "Device Assign";
  if (kind === "backlight") return "Backlight";
  return catalog.validSettingLabels.has(targetId) ? "Circuit" : "CFS";
}

function settingRisk(setting: SceneCircuitSetting, catalog: CfsTargetCatalog): CfsLinkRisk {
  const targetId = clean(setting.circuitId);
  if (catalog.validSettingLabels.has(targetId)) return "ok";
  return targetId.startsWith("hvac:") ? "warning" : "error";
}

function addTargetNode(nodes: ReturnType<typeof createNodeStore>, targetId: string, catalog: CfsTargetCatalog): void {
  const group = targetGroup(targetId, catalog);
  const entry = catalog.byId.get(targetId);
  nodes.add({
    id: `target:${targetId}`,
    group,
    kind: "target",
    label: entry?.label ?? targetId,
    detail: entry?.detail || targetId,
  });
}

function addCfsTargetNode(nodes: ReturnType<typeof createNodeStore>, targetId: string, targetLabels: Map<string, string>): void {
  nodes.add({
    id: `cfs:${targetId}`,
    group: "CFS",
    kind: "cfs",
    label: targetLabels.get(targetId) ?? targetId,
    detail: "CFS matrix target",
  });
}

function addMissingTargetIssue(
  issues: ReturnType<typeof createIssueStore>,
  ownerGroup: CfsLinkNodeGroup,
  ownerId: string,
  targetId: string,
): void {
  const hvac = targetId.startsWith("hvac:");
  issues.add({
    id: `missing-target:${ownerGroup}:${ownerId}:${targetId}`,
    code: hvac ? "stale_hvac_target" : "missing_target",
    severity: hvac ? "warning" : "error",
    group: ownerGroup,
    title: hvac ? "Stale HVAC target" : "Missing target",
    detail: `${ownerGroup} references ${targetId}, but the current Circuit/HVAC/CCO setting target catalog does not contain it.`,
    sourceId: ownerId,
    sourceIds: [ownerId],
    targetId,
  });
}

function addSettingEdges(
  params: {
    nodes: ReturnType<typeof createNodeStore>;
    edges: CfsLinkEdge[];
    issues: ReturnType<typeof createIssueStore>;
    sourceNodeId: string;
    sourceGroup: CfsLinkNodeGroup;
    sourceId: string;
    settings: SceneCircuitSetting[];
    label: string;
    editableFromCfs?: boolean;
    targetCatalog: CfsTargetCatalog;
  },
): void {
  const {
    nodes,
    edges,
    issues,
    sourceNodeId,
    sourceGroup,
    sourceId,
    settings,
    label,
    editableFromCfs,
    targetCatalog,
  } = params;
  for (const setting of settings) {
    const targetId = clean(setting.circuitId);
    if (!targetId) continue;
    const risk = settingRisk(setting, targetCatalog);
    const isValidSettingTarget = targetCatalog.validSettingLabels.has(targetId);
    const isVisibleInCfs = targetCatalog.cfsVisibleLabels.has(targetId);
    addTargetNode(nodes, targetId, targetCatalog);
    addEdge(edges, {
      from: sourceNodeId,
      to: `target:${targetId}`,
      fromGroup: sourceGroup,
      toGroup: targetGroup(targetId, targetCatalog),
      kind: "reference",
      risk,
      label,
      keys: ["circuitId", targetId, clean(setting.percentage)],
    });
    if (isVisibleInCfs) {
      addCfsTargetNode(nodes, targetId, targetCatalog.cfsVisibleLabels);
      addEdge(edges, {
        from: `target:${targetId}`,
        to: `cfs:${targetId}`,
        fromGroup: targetGroup(targetId, targetCatalog),
        toGroup: "CFS",
        kind: "render",
        risk,
        label: "CFS value",
        keys: ["circuitId", targetId],
      });
      if (editableFromCfs) {
        addEdge(edges, {
          from: `cfs:${targetId}`,
          to: sourceNodeId,
          fromGroup: "Inspection",
          toGroup: sourceGroup,
          kind: "editable",
          risk,
          label: "InspectionMode draft finish",
          keys: ["circuitId", targetId],
        });
      }
    }
    if (!isValidSettingTarget) addMissingTargetIssue(issues, sourceGroup, sourceId, targetId);
  }
}

export function buildCfsLinkageGraph(params: {
  roomType: RoomType;
  circuits: CircuitEntry[];
  locations: LocationMaster[];
}): CfsLinkageGraph {
  const { roomType, circuits, locations } = params;
  const nodes = createNodeStore();
  const issues = createIssueStore();
  const edges: CfsLinkEdge[] = [];
  const circuitByDesigner = new Map<string, CircuitEntry[]>();
  const sceneById = new Map(roomType.scenes.map((scene) => [scene.id, scene]));
  const locationById = new Map(locations.map((loc) => [loc.id, loc]));
  const areaAddressByAssignmentCircuit = buildAreaAddressAssignmentMap(roomType.deviceAssignments, circuits, locations);
  const palladiomTargetsByGroup = new Map<string, SwitchEntry>();
  const palladiomBySceneTargets = new Map<string, SwitchEntry>();

  for (const sw of roomType.switches) {
    if (sw.kind !== "lutronPd") continue;
    const key = switchGroupId(sw);
    if (!palladiomTargetsByGroup.has(key)) palladiomTargetsByGroup.set(key, sw);
    if (isPalladiomBacklightTarget(sw) && !palladiomBySceneTargets.has(key)) {
      palladiomBySceneTargets.set(key, sw);
    }
  }

  const cfsRows = buildCfsZoneRows({
    roomType,
    circuits,
    locations,
    locationById,
    areaAddressByAssignmentCircuit,
    palladiomBySceneTargets,
    selectedAreaIds: new Set<string>(),
    hiddenDeviceKeys: new Set<string>(),
    sortMode: "device",
  });
  const targetCatalog = buildCfsTargetCatalog({ rows: cfsRows, circuits, roomType, locations });
  const backlightRowsByTarget = new Map(
    cfsRows
      .filter((row) => row.isBacklight && clean(row.backlightTargetGroupId))
      .map((row) => [clean(row.backlightTargetGroupId), row]),
  );

  nodes.add(makeTabNode("Circuit", `${circuits.length} circuits`));
  nodes.add(makeTabNode("Device Assign", `${roomType.deviceAssignments.length} assignments`));
  nodes.add(makeTabNode("Area Scene", `${roomType.scenes.length} area scenes`));
  nodes.add(makeTabNode("Scene", `${roomType.roomScenes.length} scene columns`));
  nodes.add(makeTabNode("Switch", `${roomType.switches.filter((sw) => switchSourceGroup(sw) === "Switch").length} switch rows`));
  nodes.add(makeTabNode("Command", `${roomType.switches.filter((sw) => switchSourceGroup(sw) === "Command").length} command rows`));
  nodes.add(makeTabNode("HVAC", `${roomType.hvacAssignments.length} HVAC assignments`));
  nodes.add(makeTabNode("Backlight", "Backlight logic"));
  nodes.add(makeTabNode("CFS", "Generated matrix"));
  nodes.add(makeTabNode("Inspection", "CFS draft/apply check"));
  for (const targetId of targetCatalog.cfsVisibleLabels.keys()) {
    addCfsTargetNode(nodes, targetId, targetCatalog.cfsVisibleLabels);
  }

  for (const circuit of circuits) {
    const area = locationById.get(circuit.area)?.name ?? "Other";
    const label = [circuit.designerNumber, circuit.detail || circuit.fixture || circuit.id.slice(0, 6)].filter(Boolean).join(" / ");
    nodes.add({
      id: `circuit:${circuit.id}`,
      group: "Circuit",
      kind: "record",
      label,
      detail: `${area} / ${circuit.dimmingType || "-"}`,
    });
    const designer = clean(circuit.designerNumber);
    if (!circuitByDesigner.has(designer)) circuitByDesigner.set(designer, []);
    circuitByDesigner.get(designer)!.push(circuit);
  }

  for (const assignment of roomType.deviceAssignments) {
    const assignmentNodeId = `assignment:${assignment.id}`;
    const assignmentLabel = [
      assignment.device || "Device",
      assignment.deviceNum ? `#${assignment.deviceNum}` : "",
      assignment.zoneAddress,
    ].filter(Boolean).join(" ");
    nodes.add({
      id: assignmentNodeId,
      group: "Device Assign",
      kind: "record",
      label: assignmentLabel || assignment.id.slice(0, 6),
      detail: assignment.detail || assignment.circuitNumber || "",
    });
    const designer = clean(assignment.circuitNumber);
    if (!designer || designer === "Reserved") continue;
    const matches = circuitByDesigner.get(designer) ?? [];
    if (matches.length === 0) {
      if (!isCciOrCcoAddress(assignment.zoneAddress)) {
        issues.add({
          id: `missing-designer:${assignment.id}:${designer}`,
          code: "designer_missing",
          severity: "warning",
          group: "Device Assign",
          title: "Designer# target not found",
          detail: `Device Assign ${assignmentLabel || assignment.id} references Designer# ${designer}, but no Circuit row matches it.`,
          sourceId: assignment.id,
          sourceIds: [assignment.id],
          targetId: designer,
        });
      }
      continue;
    }

    let linked = matches;
    if (isDaliDevice(assignment) && matches.length > 1) {
      const detail = normalize(assignment.detail);
      const detailMatch = detail ? matches.find((circuit) => normalize(circuit.detail) === detail) : undefined;
      const addressIndex = assignmentAddressIndex(assignment);
      linked = detailMatch ? [detailMatch] : addressIndex !== null && matches[addressIndex] ? [matches[addressIndex]] : matches;
      if (assignment.detail && !detailMatch && linked.length !== 1) {
        issues.add({
          id: `dali-detail:${assignment.id}:${designer}`,
          code: "dali_ambiguous",
          severity: "warning",
          group: "Device Assign",
          title: "DALI detail match is ambiguous",
          detail: `Device Assign ${assignmentLabel} uses Designer# ${designer}, but Detail "${assignment.detail}" did not match a single DALI circuit detail.`,
          sourceId: assignment.id,
          sourceIds: [assignment.id],
          targetId: designer,
        });
      }
    }

    for (const circuit of linked) {
      addEdge(edges, {
        from: `circuit:${circuit.id}`,
        to: assignmentNodeId,
        fromGroup: "Circuit",
        toGroup: "Device Assign",
        kind: isDaliDevice(assignment) ? "fallback" : "reference",
        risk: "ok",
        label: isDaliDevice(assignment) ? "Designer# + DALI detail/address" : "Designer#",
        keys: ["designerNumber", designer, "assignmentId", assignment.id],
      });
      addCfsTargetNode(nodes, circuit.id, targetCatalog.cfsVisibleLabels);
      addEdge(edges, {
        from: assignmentNodeId,
        to: `cfs:${circuit.id}`,
        fromGroup: "Device Assign",
        toGroup: "CFS",
        kind: "render",
        risk: "ok",
        label: "CFS row",
        keys: ["assignmentId", assignment.id, "circuitId", circuit.id],
      });
    }
  }

  for (const scene of roomType.scenes) {
    const sceneNodeId = `areaScene:${scene.id}`;
    const area = locationById.get(scene.areaId)?.name ?? "Other";
    nodes.add({
      id: sceneNodeId,
      group: "Area Scene",
      kind: "record",
      label: scene.name || "Area Scene",
      detail: area,
    });
    addSettingEdges({
      nodes,
      edges,
      issues,
      sourceNodeId: sceneNodeId,
      sourceGroup: "Area Scene",
      sourceId: scene.id,
      settings: scene.settings,
      label: "Area Scene setting",
      editableFromCfs: true,
      targetCatalog,
    });
  }

  for (const roomScene of roomType.roomScenes) {
    const roomSceneNodeId = `roomScene:${roomScene.id}`;
    nodes.add({
      id: roomSceneNodeId,
      group: "Scene",
      kind: "record",
      label: [roomScene.phase, roomScene.sceneType || "Scene"].filter(Boolean).join(" / "),
      detail: roomScene.triggerCondition || "",
    });
    for (const selection of roomScene.areaSceneSelections ?? []) {
      if (!clean(selection.sceneId)) continue;
      const areaScene = sceneById.get(selection.sceneId);
      addEdge(edges, {
        from: `areaScene:${selection.sceneId}`,
        to: roomSceneNodeId,
        fromGroup: "Area Scene",
        toGroup: "Scene",
        kind: "reference",
        risk: areaScene ? "ok" : "error",
        label: "Area Scene selection",
        keys: ["sceneId", selection.sceneId, "areaId", selection.areaId],
      });
      if (!areaScene) {
        issues.add({
          id: `missing-area-scene:${roomScene.id}:${selection.sceneId}`,
          code: "missing_area_scene",
          severity: "error",
          group: "Scene",
          title: "Missing Area Scene",
          detail: `Room Scene references Area Scene ${selection.sceneId}, but it does not exist.`,
          sourceId: roomScene.id,
          sourceIds: [roomScene.id],
          targetId: selection.sceneId,
        });
      }
    }
    addSettingEdges({
      nodes,
      edges,
      issues,
      sourceNodeId: roomSceneNodeId,
      sourceGroup: "Scene",
      sourceId: roomScene.id,
      settings: roomScene.settings,
      label: "Scene direct setting",
      editableFromCfs: true,
      targetCatalog,
    });
  }

  const switchSignatures = new Map<string, SwitchEntry[]>();
  for (const sw of roomType.switches) {
    const switchNodeId = `switch:${sw.id}`;
    const group = switchSourceGroup(sw);
    nodes.add({
      id: switchNodeId,
      group,
      kind: "record",
      label: [sw.switchNumber, sw.switchName, sw.buttonFunction || sw.buttonLabel].filter(Boolean).join(" / ") || sw.id.slice(0, 6),
      detail: [sw.kind, sw.condition].filter(Boolean).join(" / "),
    });

    const signature = switchColumnSignature(sw);
    if (sw.kind !== "command" && sw.kind !== "qsm" && clean(sw.switchNumber || sw.switchName)) {
      const list = switchSignatures.get(signature) ?? [];
      list.push(sw);
      switchSignatures.set(signature, list);
    }

    for (const sceneId of selectedSceneIdsForSwitch(sw)) {
      const areaScene = sceneById.get(sceneId);
      addEdge(edges, {
        from: switchNodeId,
        to: `areaScene:${sceneId}`,
        fromGroup: group,
        toGroup: "Area Scene",
        kind: "reference",
        risk: areaScene ? "ok" : "error",
        label: "Switch scene recall",
        keys: ["sceneId", sceneId],
      });
      if (!areaScene) {
        issues.add({
          id: `missing-switch-scene:${sw.id}:${sceneId}`,
          code: "missing_switch_scene",
          severity: "error",
          group,
          title: "Missing Switch Scene",
          detail: `Switch ${sw.switchNumber || sw.id} references Scene ${sceneId}, but it does not exist.`,
          sourceId: sw.id,
          sourceIds: [sw.id],
          targetId: sceneId,
        });
      }
    }

    addSettingEdges({
      nodes,
      edges,
      issues,
      sourceNodeId: switchNodeId,
      sourceGroup: group,
      sourceId: sw.id,
      settings: sw.buttonSetting.circuitSettings,
      label: "Switch value",
      editableFromCfs: true,
      targetCatalog,
    });

    const targets = hasMeaningfulBacklightSource(sw)
      ? sw.backlightTarget.split(",").map((value) => clean(value)).filter(Boolean)
      : [];
    for (const target of targets) {
      const targetGroupSwitch = palladiomTargetsByGroup.get(target);
      const targetSwitch = palladiomBySceneTargets.get(target);
      const condition = normalizeBacklightCondition(sw.backlightCondition, sw);
      const backlightTargetNodeId = `backlight:${target}`;
      nodes.add({
        id: backlightTargetNodeId,
        group: "Backlight",
        kind: "target",
        label: (targetSwitch ?? targetGroupSwitch)
          ? [targetSwitch?.switchNumber ?? targetGroupSwitch?.switchNumber, targetSwitch?.switchName ?? targetGroupSwitch?.switchName].filter(Boolean).join(" / ") || target
          : target,
        detail: targetSwitch ? "Palladiom Backlight target" : targetGroupSwitch ? "Palladiom target is not By Scene/Base" : "Missing Palladiom target group",
      });
      const row = backlightRowsByTarget.get(target);
      const risk: CfsLinkRisk = !targetGroupSwitch ? "error" : !targetSwitch || !condition || !row ? "warning" : "ok";
      addEdge(edges, {
        from: switchNodeId,
        to: backlightTargetNodeId,
        fromGroup: group,
        toGroup: "Backlight",
        kind: "reference",
        risk,
        label: "Backlight target",
        keys: ["switchGroupId", switchGroupId(sw), "target", target],
      });
      if (!targetGroupSwitch) {
        issues.add({
          id: `missing-backlight-target:${switchGroupId(sw)}:${target}`,
          code: "missing_backlight_target",
          severity: "error",
          group: "Backlight",
          title: "Missing Backlight target",
          detail: `Backlight source ${sw.switchNumber || sw.id} references ${target}, but no Palladiom Backlight target group exists. The CFS Backlight Logic row for that target will not be generated.`,
          sourceId: sw.id,
          sourceIds: [sw.id],
          targetId: `backlight:${target}`,
        });
        continue;
      }
      if (!targetSwitch) {
        issues.add({
          id: `backlight-target-not-by-scene:${switchGroupId(sw)}:${target}`,
          code: "backlight_target_not_by_scene",
          severity: "warning",
          group: "Backlight",
          title: "Backlight target is not By Scene/Base",
          detail: `Backlight source ${sw.switchNumber || sw.id} references ${target}, which exists as a Palladiom group but is not enabled as a By Scene/Base target. The CFS Backlight Logic row for that target will not be generated.`,
          sourceId: sw.id,
          sourceIds: [sw.id],
          targetId: `backlight:${target}`,
        });
        continue;
      }
      if (!condition) {
        issues.add({
          id: `missing-backlight-condition:${switchGroupId(sw)}:${target}`,
          code: "missing_backlight_condition",
          severity: "warning",
          group: "Backlight",
          title: "Backlight condition is empty",
          detail: `Backlight source ${sw.switchNumber || sw.id} has a target, but no active/inactive condition. The CFS Backlight Logic row will not be generated.`,
          sourceId: sw.id,
          sourceIds: [sw.id],
          targetId: `backlight:${target}`,
        });
        continue;
      }
      if (!row) {
        issues.add({
          id: `missing-backlight-cfs-row:${sw.id}:${target}`,
          code: "missing_backlight_cfs_row",
          severity: "warning",
          group: "Backlight",
          title: "Backlight CFS row was not generated",
          detail: `Backlight source ${sw.switchNumber || sw.id} has a valid target and condition, but no CFS Backlight Logic row was produced.`,
          sourceId: sw.id,
          sourceIds: [sw.id],
          targetId: `backlight:${target}`,
        });
        continue;
      }
      nodes.add({
        id: `cfs:${row.id}`,
        group: "CFS",
        kind: "cfs",
        label: `Backlight ${row.backlightTargetLabel || target}`,
        detail: "CFS Backlight Logic row",
      });
      addEdge(edges, {
        from: backlightTargetNodeId,
        to: `cfs:${row.id}`,
        fromGroup: "Backlight",
        toGroup: "CFS",
        kind: "render",
        risk: "ok",
        label: "Backlight Logic row",
        keys: ["target", target, "rowId", row.id],
      });
    }
  }

  for (const [signature, rows] of switchSignatures) {
    if (rows.length <= 1) continue;
    issues.add({
      id: `duplicate-switch-column:${stableHash(signature)}`,
      code: "duplicate_switch_column",
      severity: "warning",
      group: "Switch",
      title: "Duplicate CFS switch column signature",
      detail: `${rows.length} switch rows share the same CFS header signature. Confirm this is intentional.`,
      sourceId: rows.map((row) => row.id).join(","),
      sourceIds: rows.map((row) => row.id),
    });
  }

  const finalNodes = nodes.nodes();
  const finalIssues = issues.issues();
  const sortedEdges = sortById(edges);
  const signatureSource = JSON.stringify({
    nodes: finalNodes.map((node) => [node.id, node.group, node.kind, node.label, node.detail ?? ""]),
    edges: sortedEdges.map((edge) => [edge.from, edge.to, edge.kind, edge.risk, edge.label, edge.keys]),
    issues: finalIssues.map((issue) => [issue.id, issue.code, issue.severity, issue.group, issue.targetId ?? ""]),
  });
  const summary: CfsLinkageSummary = {
    nodes: finalNodes.length,
    edges: sortedEdges.length,
    issues: finalIssues.length,
    errors: finalIssues.filter((issue) => issue.severity === "error").length,
    warnings: finalIssues.filter((issue) => issue.severity === "warning").length,
    circuits: circuits.length,
    assignments: roomType.deviceAssignments.length,
    areaScenes: roomType.scenes.length,
    roomScenes: roomType.roomScenes.length,
    switches: roomType.switches.length,
    cfsTargets: Array.from(targetCatalog.cfsVisibleLabels.keys()).length,
    signature: stableHash(signatureSource),
  };

  return {
    version: 1,
    nodes: finalNodes,
    edges: sortedEdges,
    issues: finalIssues,
    summary,
  };
}

export function serializeCfsLinkageSnapshot(graph: CfsLinkageGraph): CfsLinkageSnapshot {
  return {
    version: 1,
    summary: graph.summary,
    nodes: sortById(graph.nodes),
    edges: sortById(graph.edges),
    issues: sortById(graph.issues),
  };
}

export function diffCfsLinkageSnapshots(before: CfsLinkageSnapshot, after: CfsLinkageSnapshot): CfsLinkageDiff {
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  const beforeIssues = new Map(before.issues.map((issue) => [issue.id, issue]));
  const afterIssues = new Map(after.issues.map((issue) => [issue.id, issue]));
  return {
    signatureChanged: before.summary.signature !== after.summary.signature,
    addedEdges: after.edges.filter((edge) => !beforeEdges.has(edge.id)),
    removedEdges: before.edges.filter((edge) => !afterEdges.has(edge.id)),
    addedIssues: after.issues.filter((issue) => !beforeIssues.has(issue.id)),
    resolvedIssues: before.issues.filter((issue) => !afterIssues.has(issue.id)),
  };
}
