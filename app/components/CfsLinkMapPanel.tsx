"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CfsLinkEdge,
  CfsLinkIssue,
  CfsLinkIssueSeverity,
  CfsLinkNode,
  CfsLinkNodeGroup,
  CfsLinkageGraph,
} from "../lib/cfsLinkageGraph";
import { serializeCfsLinkageSnapshot } from "../lib/cfsLinkageGraph";
import type { StaleHvacRepairPlan } from "../lib/staleHvacLinkRepair";

interface CfsLinkMapPanelProps {
  graph: CfsLinkageGraph;
  roomTypeName: string;
  staleHvacRepairPlan?: StaleHvacRepairPlan;
  lastHvacRepairSummary?: { count: number; skipped: number } | null;
  onRepairStaleHvacLinks?: () => void;
  onClose: () => void;
}

interface FlowNode {
  id: string;
  label: string;
  group: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FlowEdge {
  from: string;
  to: string;
  label: string;
  risk: "ok" | "warning" | "error";
}

type LinkMapView = "overview" | "current" | "rules" | "issues";

interface PaperChildNode {
  node: CfsLinkNode;
  x: number;
  y: number;
  hiddenCount?: number;
}

interface PaperRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LinkRuleCatalogItem {
  id: string;
  source: string;
  target: string;
  label: string;
  detail: string;
  status: "implemented" | "partial" | "missing" | "external";
  fromGroups?: string[];
  toGroups?: string[];
  labels?: string[];
}

interface SwimlaneLane {
  id: string;
  step: string;
  label: string;
  description: string;
  groups: CfsLinkNodeGroup[];
}

const PAPER_WIDTH = 1900;
const PAPER_HEIGHT = 1400;
const CHILD_NODE_LIMIT = 24;
const CHILD_NODE_WIDTH = 144;
const CHILD_NODE_HEIGHT = 94;
const CHILD_NODE_GAP = 18;

const FLOW_NODES: FlowNode[] = [
  { id: "cfs", label: "CFS Matrix", group: "CFS", x: 700, y: 500, w: 210, h: 84 },
  { id: "scene", label: "Scene", group: "Scene", x: 705, y: 84, w: 200, h: 74 },
  { id: "switch", label: "Switch / Command", group: "Switch", x: 1150, y: 240, w: 220, h: 74 },
  { id: "hvac", label: "HVAC", group: "HVAC", x: 1260, y: 520, w: 190, h: 74 },
  { id: "backlight", label: "Backlight", group: "Backlight", x: 1120, y: 820, w: 200, h: 74 },
  { id: "inspection", label: "InspectionMode", group: "Inspection", x: 690, y: 940, w: 230, h: 74 },
  { id: "areaScene", label: "Area Scene", group: "Area Scene", x: 270, y: 820, w: 210, h: 74 },
  { id: "device", label: "Device Assign", group: "Device Assign", x: 140, y: 520, w: 220, h: 74 },
  { id: "circuit", label: "Circuit", group: "Circuit", x: 260, y: 240, w: 200, h: 74 },
];

const FLOW_EDGES: FlowEdge[] = [
  { from: "circuit", to: "device", label: "Designer# / DALI", risk: "ok" },
  { from: "device", to: "cfs", label: "row target", risk: "ok" },
  { from: "areaScene", to: "scene", label: "selection", risk: "ok" },
  { from: "scene", to: "cfs", label: "scene value", risk: "ok" },
  { from: "switch", to: "cfs", label: "switch value", risk: "ok" },
  { from: "hvac", to: "cfs", label: "HVAC value", risk: "ok" },
  { from: "backlight", to: "cfs", label: "backlight value", risk: "warning" },
  { from: "cfs", to: "inspection", label: "edit cell", risk: "ok" },
  { from: "inspection", to: "areaScene", label: "draft apply", risk: "ok" },
  { from: "inspection", to: "scene", label: "draft apply", risk: "ok" },
  { from: "inspection", to: "switch", label: "draft apply", risk: "ok" },
];

/*
const LINK_RULE_CATALOG_BROKEN_ENCODING: LinkRuleCatalogItem[] = [
  {
    id: "circuit-device",
    source: "Circuit",
    target: "Device Assign",
    label: "Designer# / DALI",
    detail: "CircuitのDesigner#をDevice AssignのCircuit # / Inputと照合します。DALIはDetailまたはAddressで個別灯へ絞り込みます。",
    status: "partial",
    fromGroups: ["Circuit"],
    toGroups: ["Device Assign"],
    labels: ["Designer#", "Designer# + DALI detail/address"],
  },
  {
    id: "device-cfs",
    source: "Device Assign",
    target: "CFS Matrix",
    label: "CFS row",
    detail: "Device Assignの表示対象行がCFSのベース行を作ります。非照明CCI/CCOは追加改善対象です。",
    status: "partial",
    fromGroups: ["Device Assign"],
    toGroups: ["CFS"],
    labels: ["CFS row"],
  },
  {
    id: "area-scene-target",
    source: "Area Scene",
    target: "Circuit / HVAC / CCO",
    label: "Area Scene setting",
    detail: "Area Sceneの値がcircuitIdで照明、HVAC、CCOなどの対象へ紐づきます。",
    status: "implemented",
    fromGroups: ["Area Scene"],
    labels: ["Area Scene setting"],
  },
  {
    id: "area-scene-room-scene",
    source: "Area Scene",
    target: "Scene",
    label: "Area Scene selection",
    detail: "Sceneタブの列がAreaごとにArea Sceneを選び、CFSセルではその値を参照します。",
    status: "implemented",
    fromGroups: ["Area Scene"],
    toGroups: ["Scene"],
    labels: ["Area Scene selection"],
  },
  {
    id: "scene-direct",
    source: "Scene",
    target: "Circuit / HVAC",
    label: "Scene direct setting",
    detail: "Sceneタブで直接入力された値はArea Sceneより優先され、CFSのScene列へ表示されます。",
    status: "implemented",
    fromGroups: ["Scene"],
    labels: ["Scene direct setting"],
  },
  {
    id: "switch-scene",
    source: "Switch / Command",
    target: "Area Scene",
    label: "Switch scene recall",
    detail: "SwitchまたはCommandがSceneを呼び出す場合、選択されたArea Sceneを経由してCFSへ値が出ます。",
    status: "implemented",
    fromGroups: ["Switch", "Backlight", "HVAC"],
    toGroups: ["Area Scene"],
    labels: ["Switch scene recall"],
  },
  {
    id: "switch-direct",
    source: "Switch / Command",
    target: "Circuit / HVAC / CCO",
    label: "Switch value",
    detail: "Switch、Contact、PIR、Commandの直接値がCFSの機能列へ表示されます。非照明CCO表示は追加改善対象です。",
    status: "partial",
    labels: ["Switch value"],
  },
  {
    id: "inspection",
    source: "CFS InspectionMode",
    target: "Scene / Area Scene / Switch",
    label: "InspectionMode draft finish",
    detail: "CFS上で編集した値を、直接値があれば元のScene/Switchへ、参照Scene値ならArea Sceneへ書き戻します。",
    status: "partial",
    fromGroups: ["Inspection"],
    labels: ["InspectionMode draft finish"],
  },
  {
    id: "backlight",
    source: "Backlight Logic",
    target: "Palladiom target / CFS",
    label: "Backlight target",
    detail: "Backlight条件と対象Palladiom groupをCFSのBacklight Logic行へ反映します。現状は宛先ノードとCFS renderの補強が必要です。",
    status: "partial",
    labels: ["Backlight target"],
  },
  {
    id: "cci-contact",
    source: "Device Assign CCI",
    target: "Switch Contact",
    label: "CCI physical input sync",
    detail: "Device Assignで登録したCCI物理入力とSwitch/Contact行の割当を同期します。現Link Mapでは未表示です。",
    status: "missing",
  },
  {
    id: "qsm-pir",
    source: "QSM",
    target: "PIR instance",
    label: "QSM / PIR assignment",
    detail: "PIR instanceがどのQSMへ所属しているかを監査します。CFS列には出ませんが、連動監査として必要です。",
    status: "missing",
  },
  {
    id: "area-programming",
    source: "Area / Location / DeviceMaster",
    target: "Area Address / Programming Name",
    label: "Programming naming",
    detail: "Area code、Area Address、DeviceMaster programmingCodeからCFSのProgramming Nameを作ります。現Link Map署名には未反映です。",
    status: "missing",
  },
  {
    id: "import-export",
    source: "Project data / Export",
    target: "CFS deliverables",
    label: "Import / Export safety",
    detail: "プロジェクト保存、旧データ移行、Excel exportとLink Map snapshot差分をアップデート確認に使います。現状は運用で補っています。",
    status: "external",
  },
];

const SWIMLANE_LANES: SwimlaneLane[] = [
  {
    id: "source-data",
    step: "1",
    label: "Source Data",
    description: "Circuit and Device Assign create the base CFS rows.",
    groups: ["Circuit", "Device Assign"],
  },
  {
    id: "scene-values",
    step: "2",
    label: "Scene Values",
    description: "Area Scene, Scene, Switch, and Command provide values.",
    groups: ["Area Scene", "Scene", "Switch", "Command"],
  },
  {
    id: "system-logic",
    step: "3",
    label: "System Logic",
    description: "HVAC and Backlight links are checked separately.",
    groups: ["HVAC", "Backlight"],
  },
  {
    id: "cfs-output",
    step: "4",
    label: "CFS Output",
    description: "Resolved rows and function columns appear in the CFS matrix.",
    groups: ["CFS"],
  },
  {
    id: "inspection-finish",
    step: "5",
    label: "Inspection Finish",
    description: "InspectionMode drafts are written back when the session is finished.",
    groups: ["Inspection"],
  },
];
*/

const LINK_RULE_CATALOG: LinkRuleCatalogItem[] = [
  {
    id: "circuit-device",
    source: "Circuit",
    target: "Device Assign",
    label: "Designer# / DALI",
    detail: "CircuitのDesigner#をDevice AssignのCircuit # / Inputと照合します。DALIはDetailまたはAddressで個別灯へ結びます。",
    status: "partial",
    fromGroups: ["Circuit"],
    toGroups: ["Device Assign"],
    labels: ["Designer#", "Designer# + DALI detail/address"],
  },
  {
    id: "device-cfs",
    source: "Device Assign",
    target: "CFS Matrix",
    label: "CFS row",
    detail: "Device Assignの表示対象行からCFSのベース行を作ります。非照明CCI/CCOは追加改善対象です。",
    status: "partial",
    fromGroups: ["Device Assign"],
    toGroups: ["CFS"],
    labels: ["CFS row"],
  },
  {
    id: "area-scene-target",
    source: "Area Scene",
    target: "Circuit / HVAC / CCO",
    label: "Area Scene setting",
    detail: "Area Sceneの値をCircuit ID、HVAC、CCOなどの対象へ結びます。",
    status: "implemented",
    fromGroups: ["Area Scene"],
    labels: ["Area Scene setting"],
  },
  {
    id: "area-scene-room-scene",
    source: "Area Scene",
    target: "Scene",
    label: "Area Scene selection",
    detail: "Sceneタブの列がAreaごとにArea Sceneを選び、CFSセルではその値を参照します。",
    status: "implemented",
    fromGroups: ["Area Scene"],
    toGroups: ["Scene"],
    labels: ["Area Scene selection"],
  },
  {
    id: "scene-direct",
    source: "Scene",
    target: "Circuit / HVAC",
    label: "Scene direct setting",
    detail: "Sceneタブで直接入力した値はArea Sceneより優先され、CFSのScene列へ表示されます。",
    status: "implemented",
    fromGroups: ["Scene"],
    labels: ["Scene direct setting"],
  },
  {
    id: "switch-scene",
    source: "Switch / Command",
    target: "Area Scene",
    label: "Switch scene recall",
    detail: "SwitchまたはCommandがSceneを呼び出す場合、選択されたArea Sceneを経由してCFSへ値が入ります。",
    status: "implemented",
    fromGroups: ["Switch", "Command", "Backlight", "HVAC"],
    toGroups: ["Area Scene"],
    labels: ["Switch scene recall"],
  },
  {
    id: "switch-direct",
    source: "Switch / Command",
    target: "Circuit / HVAC / CCO",
    label: "Switch value",
    detail: "Switch、Contact、PIR、Commandの直接値をCFSの機能列へ表示します。非照明CCO表示は追加改善対象です。",
    status: "partial",
    labels: ["Switch value"],
  },
  {
    id: "inspection",
    source: "CFS InspectionMode",
    target: "Scene / Area Scene / Switch",
    label: "InspectionMode draft finish",
    detail: "CFS上で作成したドラフト値を、終了時にLinkedならArea Sceneへ、UnlinkならScene/Switchの直接値へ反映します。",
    status: "partial",
    fromGroups: ["Inspection"],
    labels: ["InspectionMode draft finish"],
  },
  {
    id: "backlight",
    source: "Backlight Logic",
    target: "Palladiom target / CFS",
    label: "Backlight target",
    detail: "Backlight条件と対象Palladiom groupをCFSのBacklight Logic行へ反映します。現状は完全ノードとCFS renderの補強が必要です。",
    status: "partial",
    labels: ["Backlight target"],
  },
  {
    id: "cci-contact",
    source: "Device Assign CCI",
    target: "Switch Contact",
    label: "CCI physical input sync",
    detail: "Device Assignで登録したCCI物理入力とSwitch/Contact行の割当を同期します。現Link Mapでは未表示です。",
    status: "missing",
  },
  {
    id: "qsm-pir",
    source: "QSM",
    target: "PIR instance",
    label: "QSM / PIR assignment",
    detail: "PIR instanceがどのQSMへ所属しているかを監査します。CFS列には出ませんが、連動監査として必要です。",
    status: "missing",
  },
  {
    id: "area-programming",
    source: "Area / Location / DeviceMaster",
    target: "Area Address / Programming Name",
    label: "Programming naming",
    detail: "Area code、Area Address、DeviceMaster programmingCodeからCFSのProgramming Nameを作ります。現Link Map診断には未反映です。",
    status: "missing",
  },
  {
    id: "import-export",
    source: "Project data / Export",
    target: "CFS deliverables",
    label: "Import / Export safety",
    detail: "プロジェクト保存、旧データ移行、Excel export、Link Map snapshot差分をアップデート確認に使います。現状は運用で補っています。",
    status: "external",
  },
];

const SWIMLANE_LANES: SwimlaneLane[] = [
  {
    id: "source-data",
    step: "1",
    label: "Source Data",
    description: "Circuit and Device Assign create the base CFS rows.",
    groups: ["Circuit", "Device Assign"],
  },
  {
    id: "scene-values",
    step: "2",
    label: "Scene Values",
    description: "Area Scene, Scene, Switch, and Command provide values.",
    groups: ["Area Scene", "Scene", "Switch"],
  },
  {
    id: "system-logic",
    step: "3",
    label: "System Logic",
    description: "HVAC and Backlight links are checked separately.",
    groups: ["HVAC", "Backlight"],
  },
  {
    id: "cfs-output",
    step: "4",
    label: "CFS Output",
    description: "Resolved rows and function columns appear in the CFS matrix.",
    groups: ["CFS"],
  },
  {
    id: "inspection-finish",
    step: "5",
    label: "Inspection Finish",
    description: "InspectionMode drafts are written back when the session is finished.",
    groups: ["Inspection"],
  },
];

function riskRank(risk: "ok" | "warning" | "error"): number {
  if (risk === "error") return 2;
  if (risk === "warning") return 1;
  return 0;
}

function statusLabel(graph: CfsLinkageGraph): string {
  if (graph.summary.errors > 0) return "Needs Review";
  if (graph.summary.warnings > 0) return "Warnings";
  return "Linked";
}

function severityLabel(severity: CfsLinkIssueSeverity): string {
  if (severity === "error") return "Error";
  if (severity === "warning") return "Warning";
  return "Info";
}

function groupCount(graph: CfsLinkageGraph, group: string): number {
  if (group === "Circuit") return graph.summary.circuits;
  if (group === "Device Assign") return graph.summary.assignments;
  if (group === "Area Scene") return graph.summary.areaScenes;
  if (group === "Scene") return graph.summary.roomScenes;
  if (group === "Switch" || group === "Command") {
    return graph.nodes.filter((node) => node.group === group && node.kind !== "tab").length;
  }
  if (group === "CFS") return graph.summary.cfsTargets;
  return graph.nodes.filter((node) => node.group === group && node.kind !== "tab").length;
}

function laneCount(graph: CfsLinkageGraph, lane: SwimlaneLane): number {
  return lane.groups.reduce((sum, group) => sum + groupCount(graph, group), 0);
}

function laneIssueCount(graph: CfsLinkageGraph, lane: SwimlaneLane): number {
  return graph.issues.filter((issue) => lane.groups.includes(issue.group)).length;
}

function laneRisk(graph: CfsLinkageGraph, lane: SwimlaneLane): "ok" | "warning" | "error" {
  return graph.issues
    .filter((issue) => lane.groups.includes(issue.group))
    .reduce<"ok" | "warning" | "error">((risk, issue) => {
      const next = issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "ok";
      return riskRank(next) > riskRank(risk) ? next : risk;
    }, "ok");
}

function laneNodes(nodes: CfsLinkNode[], lane: SwimlaneLane): CfsLinkNode[] {
  return nodes.filter((node) => lane.groups.includes(node.group) && node.kind !== "tab");
}

function nodeCenter(node: FlowNode): { x: number; y: number } {
  return {
    x: node.x + node.w / 2,
    y: node.y + node.h / 2,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rectsOverlap(a: PaperRect, b: PaperRect, gap = CHILD_NODE_GAP): boolean {
  return !(
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y
  );
}

function flowEdgeRisk(edge: FlowEdge, graph: CfsLinkageGraph): FlowEdge["risk"] {
  const fromGroup = FLOW_NODES.find((node) => node.id === edge.from)?.group;
  const toGroup = FLOW_NODES.find((node) => node.id === edge.to)?.group;
  const relevant = graph.edges.filter((item) => {
    const routeMatch = fromGroup && toGroup && item.fromGroup === fromGroup && item.toGroup === toGroup;
    const labelMatch = edge.label.toLowerCase().includes(item.label.toLowerCase()) || item.label.toLowerCase().includes(edge.label.toLowerCase());
    return routeMatch || labelMatch;
  });
  if (relevant.length === 0) return edge.risk;
  return relevant.reduce<FlowEdge["risk"]>((acc, item) => (riskRank(item.risk) > riskRank(acc) ? item.risk : acc), edge.risk);
}

function summarizeEdges(edges: CfsLinkEdge[]): Array<{ key: string; label: string; count: number; risk: "ok" | "warning" | "error" }> {
  const map = new Map<string, { key: string; label: string; count: number; risk: "ok" | "warning" | "error" }>();
  for (const edge of edges) {
    const key = `${edge.fromGroup}->${edge.toGroup}:${edge.label}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      if (riskRank(edge.risk) > riskRank(existing.risk)) existing.risk = edge.risk;
    } else {
      map.set(key, {
        key,
        label: `${edge.fromGroup} -> ${edge.toGroup}: ${edge.label}`,
        count: 1,
        risk: edge.risk,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const riskCompare = riskRank(b.risk) - riskRank(a.risk);
    if (riskCompare !== 0) return riskCompare;
    return b.count - a.count;
  });
}

function ruleMatchesEdge(rule: LinkRuleCatalogItem, edge: CfsLinkEdge): boolean {
  const fromOk = !rule.fromGroups || rule.fromGroups.includes(edge.fromGroup);
  const toOk = !rule.toGroups || rule.toGroups.includes(edge.toGroup);
  const labelOk = !rule.labels || rule.labels.includes(edge.label);
  return fromOk && toOk && labelOk;
}

function ruleStatus(rule: LinkRuleCatalogItem, count: number, risk: "ok" | "warning" | "error"): "active" | "warning" | "planned" | "missing" {
  if (count > 0 && risk !== "ok") return "warning";
  if (count > 0) return "active";
  if (rule.status === "missing" || rule.status === "partial") return "missing";
  return "planned";
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function readableTargetId(value: string): string {
  const hvac = value.match(/^hvac:([^:]+):(.+)$/);
  if (hvac) return `HVAC ${hvac[2]} / ID ${shortId(hvac[1])}`;
  const cco = value.match(/^cco:(.+)$/);
  if (cco) return `CCO target / ID ${shortId(cco[1])}`;
  const cci = value.match(/^cci:(.+)$/);
  if (cci) return `CCI target / ID ${shortId(cci[1])}`;
  return value;
}

function nodeName(node: CfsLinkNode | undefined, fallback: string): string {
  if (!node) return `Missing endpoint: ${readableTargetId(fallback)}`;
  return node.label || readableTargetId(node.id);
}

function nodeDetail(node: CfsLinkNode | undefined): string {
  if (!node) return "";
  return node.detail ?? "";
}

function edgeExplanation(edge: CfsLinkEdge): string {
  if (edge.label === "Designer#") return "Circuit Designer#とDevice AssignのCircuit # / Inputが一致しているリンクです。";
  if (edge.label === "Designer# + DALI detail/address") return "DALIのDesigner#に加えてDetailまたはAddressで個別灯へ絞り込むリンクです。";
  if (edge.label === "CFS row") return "Device Assignの行がCFSのベース行として表示されるリンクです。";
  if (edge.label === "Area Scene setting") return "Area Sceneに入力された値が対象Circuit/HVACへ紐づくリンクです。";
  if (edge.label === "Area Scene selection") return "Scene列がAreaごとのArea Sceneを参照するリンクです。";
  if (edge.label === "Scene direct setting") return "Sceneタブに直接入力された値がCFSへ出るリンクです。";
  if (edge.label === "Switch scene recall") return "Switch/CommandがArea Sceneを呼び出してCFSへ値を出すリンクです。";
  if (edge.label === "Switch value") return "Switch/Command/PIR/Contactの直接値が対象へ紐づくリンクです。";
  if (edge.label === "Backlight target") return "Backlight Logicの発生元と対象Palladiom groupを結ぶリンクです。";
  if (edge.label === "InspectionMode draft finish") return "CFS InspectionModeで作成したドラフトを、終了時にArea Scene / Override / Switch設定へ反映するリンクです。";
  if (edge.label === "CFS value") return "対象値がCFSの機能セルへ表示されるリンクです。";
  return `${edge.fromGroup}から${edge.toGroup}へ${edge.kind}として登録されたリンクです。`;
}

function issueRepairHint(issue: CfsLinkIssue): string {
  if (issue.title === "Stale HVAC target") {
    return "回収推奨です。HVAC行の再作成やID変更後にArea Sceneが旧HVAC IDを参照している可能性があり、HVACのCFS表示やInspectionMode書き戻し先が期待とずれます。";
  }
  if (issue.title === "Missing target" || issue.title.includes("Missing")) {
    return "回収必要です。参照元が存在しない対象を指しているため、CFS表示または書き戻しが成立しません。";
  }
  if (issue.title.includes("Duplicate")) {
    return "要確認です。意図した同名列なら問題ありませんが、誤登録ならCFS列が読みにくくなります。";
  }
  if (issue.title.includes("DALI")) {
    return "要確認です。DetailまたはAddressで個別灯を一意に判断できない可能性があります。";
  }
  return "内容を確認してください。意図した連動でなければ修正対象です。";
}

function edgeExplanationText(edge: CfsLinkEdge): string {
  if (edge.label === "Designer#") return "CircuitのDesigner#とDevice AssignのCircuit # / Inputが一致するリンクです。";
  if (edge.label === "Designer# + DALI detail/address") return "DALIのDesigner#にDetailまたはAddressを加えて個別灯へ絞り込むリンクです。";
  if (edge.label === "CFS row") return "Device Assignの行がCFSのベース行として表示されるリンクです。";
  if (edge.label === "Area Scene setting") return "Area Sceneの値が対象Circuit/HVAC/CCOへ紐づくリンクです。";
  if (edge.label === "Area Scene selection") return "Scene列がAreaごとのArea Sceneを参照するリンクです。";
  if (edge.label === "Scene direct setting") return "Sceneタブで直接入力された値がCFSへ出るリンクです。";
  if (edge.label === "Switch scene recall") return "Switch/CommandがArea Sceneを呼び出してCFSへ値を出すリンクです。";
  if (edge.label === "Switch value") return "Switch/Command/PIR/Contactの直接値が対象へ紐づくリンクです。";
  if (edge.label === "Backlight target") return "Backlight Logicの発生元と対象Palladiom groupを結ぶリンクです。";
  if (edge.label === "Backlight Logic row") return "有効なBacklight条件がCFSのBacklight Logic行へ表示されるリンクです。";
  if (edge.label === "InspectionMode draft finish") return "CFS InspectionModeで作成したドラフトを、終了時にArea Scene / Override / Switch設定へ反映するリンクです。";
  if (edge.label === "CFS value") return "対象値がCFSの機能セルへ表示されるリンクです。";
  return `${edge.fromGroup}から${edge.toGroup}へ${edge.kind}として登録されたリンクです。`;
}

function issueRepairHintText(issue: CfsLinkIssue): string {
  if (issue.code === "stale_hvac_target") {
    return "HVAC行の再作成やID変更後に古いHVAC IDが残っている可能性があります。Repair Previewで置換内容を確認してください。";
  }
  if (issue.code === "missing_target") {
    return "参照先のCircuit/HVAC/CCOが現在の設定対象カタログにありません。参照元タブで対象を選び直してください。";
  }
  if (issue.code === "missing_area_scene" || issue.code === "missing_switch_scene") {
    return "参照元のScene選択を開き、現在存在するArea Sceneを選択してください。";
  }
  if (issue.code === "missing_backlight_target") {
    return "Backlight対象のPalladiom By Sceneグループが存在しません。Backlightタブで対象を選び直してください。";
  }
  if (issue.code === "backlight_target_not_by_scene") {
    return "対象グループは存在しますがBy Scene対象ではありません。CFS Backlight Logicへ出す場合はBacklightタブで対象側をBy Sceneにしてください。";
  }
  if (issue.code === "missing_backlight_condition") {
    return "Backlight対象はありますが条件が空です。Active/Inactive条件を設定するとCFS Backlight Logic行が生成されます。";
  }
  if (issue.code === "missing_backlight_cfs_row") {
    return "対象と条件は有効ですがCFS行が生成されていません。Backlight行生成ロジックの確認対象です。";
  }
  if (issue.code === "duplicate_switch_column") {
    return "同じCFS列として見えるSwitch/Contactが複数あります。意図した重複か確認してください。";
  }
  if (issue.code === "dali_ambiguous") {
    return "DALIのDetailまたはAddressで個別灯を一意に判断できない可能性があります。";
  }
  if (issue.code === "designer_missing") {
    return "Device AssignのCircuit/InputとCircuitタブのDesigner#が一致しているか確認してください。";
  }
  return "内容を確認し、意図しない連動であれば参照元の設定を現在存在する対象へ更新してください。";
}

const legacyMojibakeTextHelpers = [edgeExplanation, issueRepairHint];
void legacyMojibakeTextHelpers;

function downloadSnapshot(graph: CfsLinkageGraph, roomTypeName: string): void {
  const snapshot = serializeCfsLinkageSnapshot(graph);
  const content = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeName = roomTypeName.trim().replace(/[^a-z0-9_-]+/gi, "-") || "room";
  link.href = url;
  link.download = `cfs-linkage-${safeName}-${snapshot.summary.signature}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function CfsLinkMapPanel({
  graph,
  roomTypeName,
  staleHvacRepairPlan,
  lastHvacRepairSummary,
  onRepairStaleHvacLinks,
  onClose,
}: CfsLinkMapPanelProps): React.JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  const [view, setView] = useState<LinkMapView>("overview");
  const [search, setSearch] = useState("");
  const [expandedGroupId, setExpandedGroupId] = useState("cfs");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const panelRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const edgeSummaries = useMemo(() => summarizeEdges(graph.edges), [graph.edges]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const issueByTarget = useMemo(() => {
    const map = new Map<string, CfsLinkIssue[]>();
    for (const issue of graph.issues) {
      if (!issue.targetId) continue;
      map.set(issue.targetId, [...(map.get(issue.targetId) ?? []), issue]);
    }
    return map;
  }, [graph.issues]);
  const detailedEdges = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return graph.edges
      .map((edge, index) => {
        const source = nodeById.get(edge.from);
        const target = nodeById.get(edge.to);
        const sourceName = nodeName(source, edge.from);
        const targetName = nodeName(target, edge.to);
        const text = [
          sourceName,
          targetName,
          edge.fromGroup,
          edge.toGroup,
          edge.label,
          edge.kind,
          edge.keys.join(" "),
          source?.detail ?? "",
          target?.detail ?? "",
        ].join(" ").toLowerCase();
        return { edge, index, source, target, sourceName, targetName, text };
      })
      .filter((item) => !normalizedSearch || item.text.includes(normalizedSearch))
      .sort((a, b) => {
        const riskCompare = riskRank(b.edge.risk) - riskRank(a.edge.risk);
        if (riskCompare !== 0) return riskCompare;
        const routeCompare = `${a.edge.fromGroup} ${a.edge.toGroup}`.localeCompare(`${b.edge.fromGroup} ${b.edge.toGroup}`, "ja");
        if (routeCompare !== 0) return routeCompare;
        return a.sourceName.localeCompare(b.sourceName, "ja", { numeric: true });
      });
  }, [graph.edges, nodeById, search]);
  const ruleRows = useMemo(() => {
    return LINK_RULE_CATALOG.map((rule) => {
      const matches = graph.edges.filter((edge) => ruleMatchesEdge(rule, edge));
      const risk = matches.reduce<"ok" | "warning" | "error">(
        (acc, edge) => (riskRank(edge.risk) > riskRank(acc) ? edge.risk : acc),
        "ok",
      );
      return {
        rule,
        count: matches.length,
        risk,
        status: ruleStatus(rule, matches.length, risk),
      };
    });
  }, [graph.edges]);
  const nodeRows = useMemo(() => {
    return [...graph.nodes].sort((a, b) => {
      const groupCompare = a.group.localeCompare(b.group, "en");
      if (groupCompare !== 0) return groupCompare;
      return nodeName(a, a.id).localeCompare(nodeName(b, b.id), "ja", { numeric: true });
    });
  }, [graph.nodes]);
  const repairableStaleHvacCount = staleHvacRepairPlan?.repairs.length ?? 0;
  const skippedStaleHvacCount = staleHvacRepairPlan?.skipped.length ?? 0;
  const expandedGroup = FLOW_NODES.find((node) => node.id === expandedGroupId) ?? FLOW_NODES[0]!;
  const childNodes = useMemo<PaperChildNode[]>(() => {
    const groupRecords = nodeRows.filter((node) => node.group === expandedGroup.group && node.kind !== "tab");
    const visible = groupRecords.slice(0, CHILD_NODE_LIMIT);
    const hiddenCount = groupRecords.length - visible.length;
    const records: PaperChildNode["node"][] = hiddenCount > 0
      ? [
          ...visible,
          {
            id: `more:${expandedGroup.id}`,
            group: expandedGroup.group as CfsLinkNode["group"],
            kind: "record",
            label: `+${hiddenCount} more`,
            detail: `${expandedGroup.label} records`,
          },
        ]
      : visible;
    const count = records.length;
    const radii = count > 12 ? [190, 330, 470, 610] : [220, 360];
    const maxRadius = radii[radii.length - 1] ?? 220;
    const parentCenter = nodeCenter(expandedGroup);
    const cloudCenter = {
      x: clamp(parentCenter.x, maxRadius + 120, PAPER_WIDTH - maxRadius - 160),
      y: clamp(parentCenter.y, maxRadius + 90, PAPER_HEIGHT - maxRadius - 90),
    };
    const occupied: PaperRect[] = FLOW_NODES.map((node) => ({
      x: node.x - 26,
      y: node.y - 26,
      w: node.w + 52,
      h: node.h + 52,
    }));
    return records.map((node, index) => {
      let chosen: PaperRect | undefined;
      const baseAngle = -90 + index * 137.508;
      for (const radius of radii) {
        const slots = Math.max(8, Math.ceil((Math.PI * 2 * radius) / (CHILD_NODE_WIDTH + CHILD_NODE_GAP * 3)));
        for (let step = 0; step < slots; step += 1) {
          const angle = (baseAngle + (360 / slots) * step) * (Math.PI / 180);
          const rect: PaperRect = {
            x: cloudCenter.x + Math.cos(angle) * radius - CHILD_NODE_WIDTH / 2,
            y: cloudCenter.y + Math.sin(angle) * radius - CHILD_NODE_HEIGHT / 2,
            w: CHILD_NODE_WIDTH,
            h: CHILD_NODE_HEIGHT,
          };
          if (
            rect.x < 24 ||
            rect.y < 24 ||
            rect.x + rect.w > PAPER_WIDTH - 24 ||
            rect.y + rect.h > PAPER_HEIGHT - 24 ||
            occupied.some((item) => rectsOverlap(rect, item))
          ) {
            continue;
          }
          chosen = rect;
          break;
        }
        if (chosen) break;
      }
      if (!chosen) {
        const columns = Math.max(4, Math.floor((PAPER_WIDTH - 80) / (CHILD_NODE_WIDTH + CHILD_NODE_GAP)));
        for (let attempt = 0; attempt < 240; attempt += 1) {
          const slot = index + attempt;
          const rect: PaperRect = {
            x: 40 + (slot % columns) * (CHILD_NODE_WIDTH + CHILD_NODE_GAP),
            y: 40 + Math.floor(slot / columns) * (CHILD_NODE_HEIGHT + CHILD_NODE_GAP),
            w: CHILD_NODE_WIDTH,
            h: CHILD_NODE_HEIGHT,
          };
          if (rect.y + rect.h > PAPER_HEIGHT - 24) break;
          if (!occupied.some((item) => rectsOverlap(rect, item))) {
            chosen = rect;
            break;
          }
        }
      }
      const rect = chosen ?? {
        x: 40 + (index % 8) * (CHILD_NODE_WIDTH + CHILD_NODE_GAP),
        y: PAPER_HEIGHT - 40 - (Math.floor(index / 8) + 1) * (CHILD_NODE_HEIGHT + CHILD_NODE_GAP),
        w: CHILD_NODE_WIDTH,
        h: CHILD_NODE_HEIGHT,
      };
      occupied.push(rect);
      return {
        node,
        x: rect.x,
        y: rect.y,
        hiddenCount: node.id === `more:${expandedGroup.id}` ? hiddenCount : undefined,
      };
    });
  }, [expandedGroup, nodeRows]);
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : undefined;
  const selectedPaperChild = selectedNodeId ? childNodes.find((child) => child.node.id === selectedNodeId) : undefined;
  const selectedNodeEdges = selectedNode
    ? graph.edges.filter((edge) => edge.from === selectedNode.id || edge.to === selectedNode.id).slice(0, 10)
    : [];

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    closeButtonRef.current?.focus();
  }, [mounted]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((item) => item.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className="cfs-link-map-overlay" role="dialog" aria-modal="true" aria-labelledby="cfs-link-map-title">
      <button type="button" className="cfs-link-map-backdrop" aria-label="Close Link Map" onClick={onClose} />
      <section ref={panelRef} className="cfs-link-map-panel">
        <header className="cfs-link-map-header">
          <div>
            <div className="cfs-link-map-kicker">CFS linkage diagnostics</div>
            <h2 id="cfs-link-map-title">Link Map</h2>
          </div>
          <div className="cfs-link-map-header-actions">
            <span className={`cfs-link-status cfs-link-status-${graph.summary.errors > 0 ? "error" : graph.summary.warnings > 0 ? "warning" : "ok"}`}>
              {statusLabel(graph)}
            </span>
            <button type="button" className="btn btn-secondary" onClick={() => downloadSnapshot(graph, roomTypeName)}>
              Download Snapshot
            </button>
            {repairableStaleHvacCount > 0 && onRepairStaleHvacLinks ? (
              <button type="button" className="btn btn-primary" onClick={onRepairStaleHvacLinks}>
                Repair Stale HVAC
              </button>
            ) : null}
            <button ref={closeButtonRef} type="button" className="btn btn-secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        <div className="cfs-link-map-summary" aria-label="Link summary">
          <span>{graph.summary.circuits} Circuits</span>
          <span>{graph.summary.assignments} Assignments</span>
          <span>{graph.summary.areaScenes} Area Scenes</span>
          <span>{graph.summary.roomScenes} Scene Columns</span>
          <span>{graph.summary.switches} Switch Rows</span>
          <span>{graph.summary.edges} Links</span>
          <span>{graph.summary.issues} Issues</span>
          <span>Signature {graph.summary.signature}</span>
        </div>

        {(repairableStaleHvacCount > 0 || skippedStaleHvacCount > 0 || lastHvacRepairSummary) ? (
          <div className="cfs-link-repair-strip" aria-label="Stale HVAC repair status">
            <div>
              <strong>Stale HVAC repair</strong>
              <span>
                {repairableStaleHvacCount > 0
                  ? `${repairableStaleHvacCount} repairable link${repairableStaleHvacCount === 1 ? "" : "s"} detected`
                  : lastHvacRepairSummary
                    ? `${lastHvacRepairSummary.count} link${lastHvacRepairSummary.count === 1 ? "" : "s"} repaired`
                    : "No repairable stale HVAC links"}
                {skippedStaleHvacCount > 0 ? ` / ${skippedStaleHvacCount} skipped` : ""}
              </span>
            </div>
            {repairableStaleHvacCount > 0 && onRepairStaleHvacLinks ? (
              <button type="button" className="btn btn-primary" onClick={onRepairStaleHvacLinks}>
                Repair and Highlight
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="cfs-link-map-tabs" role="tablist" aria-label="Link Map views">
          {[
            ["overview", "Overview"],
            ["current", "Current Links"],
            ["rules", "All Rules"],
            ["issues", "Warnings"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              className={view === key ? "is-active" : ""}
              onClick={() => setView(key as LinkMapView)}
            >
              {label}
            </button>
          ))}
        </div>

        {view === "overview" ? (
          <div className="cfs-link-map-body">
            <div className="cfs-link-swimlane-viewport" aria-label="CFS linkage overview">
              <div className="cfs-link-swimlane-intro">
                <div>
                  <span>Dependency overview</span>
                  <h3>タブ連動の流れ</h3>
                  <p>
                    固定レーンで、どのタブ群がCFSへ値を渡しているかを確認できます。
                    詳細な1件ごとの接続はCurrent Links、仕様上の全ルールはAll Rulesで確認します。
                  </p>
                </div>
                <div className="cfs-link-swimlane-legend" aria-label="Link map legend">
                  <span><i className="cfs-link-legend-dot cfs-link-legend-ok" />正常</span>
                  <span><i className="cfs-link-legend-dot cfs-link-legend-warning" />確認</span>
                  <span><i className="cfs-link-legend-dot cfs-link-legend-error" />修正必要</span>
                </div>
              </div>
              <div className="cfs-link-swimlane-intro" hidden>
                <div>
                  <span>Dependency overview</span>
                  <h3>タブ連動の流れ</h3>
                  <p>
                    固定レーンで、どのタブ群がCFSへ値を渡しているかを確認できます。
                    詳細な1件ごとの接続は Current Links、仕様上の全ルールは All Rules で確認します。
                  </p>
                </div>
                <div className="cfs-link-swimlane-legend" aria-label="Link map legend">
                  <span><i className="cfs-link-legend-dot cfs-link-legend-ok" />正常</span>
                  <span><i className="cfs-link-legend-dot cfs-link-legend-warning" />確認</span>
                  <span><i className="cfs-link-legend-dot cfs-link-legend-error" />要修正</span>
                </div>
              </div>

              <div className="cfs-link-swimlane">
                {SWIMLANE_LANES.map((lane) => {
                  const records = laneNodes(nodeRows, lane);
                  const risk = laneRisk(graph, lane);
                  const issueCount = laneIssueCount(graph, lane);
                  return (
                    <section key={lane.id} className={`cfs-link-lane cfs-link-lane-${risk}`}>
                      <header>
                        <span>{lane.step}</span>
                        <div>
                          <h3>{lane.label}</h3>
                          <p>{lane.description}</p>
                        </div>
                        <strong>{laneCount(graph, lane)} records</strong>
                      </header>
                      <div className="cfs-link-lane-groups">
                        {lane.groups.map((group) => (
                          <span key={group}>{group}</span>
                        ))}
                      </div>
                      <div className="cfs-link-lane-records">
                        {records.slice(0, 6).map((node) => (
                          <button
                            key={node.id}
                            type="button"
                            className={selectedNodeId === node.id ? "is-selected" : ""}
                            onClick={() => setSelectedNodeId(node.id)}
                          >
                            <strong>{nodeName(node, node.id)}</strong>
                            <small>{nodeDetail(node) || node.kind}</small>
                          </button>
                        ))}
                        {records.length > 6 ? <span className="cfs-link-lane-more">+{records.length - 6} more</span> : null}
                        {records.length === 0 ? <span className="cfs-link-lane-more">No current records</span> : null}
                      </div>
                      {issueCount > 0 ? (
                        <em>{issueCount} issue{issueCount === 1 ? "" : "s"}</em>
                      ) : (
                        <em>No active issues</em>
                      )}
                    </section>
                  );
                })}
              </div>

              <section className="cfs-link-route-board" aria-label="Expected CFS route summary">
                <div className="cfs-link-route-board-head">
                  <div>
                    <span>Route summary</span>
                    <h3>連動ルート別の状態</h3>
                  </div>
                  <p>カードをクリックすると、実データのリンク表またはルール一覧へ移動します。</p>
                </div>
                <div className="cfs-link-route-grid">
                  {ruleRows.map(({ rule, count, risk, status }) => (
                    <button
                      key={rule.id}
                      type="button"
                      className={`cfs-link-route-card cfs-link-route-card-${risk} cfs-link-route-card-${status}`}
                      onClick={() => {
                        setSearch(rule.label);
                        setView(count > 0 ? "current" : "rules");
                      }}
                    >
                      <span>{status === "active" ? "Active" : status === "warning" ? "Warning" : status === "missing" ? "Missing" : "Planned"}</span>
                      <strong>{rule.source} {"->"} {rule.target}</strong>
                      <small>{rule.label}</small>
                      <em>{count} current links</em>
                    </button>
                  ))}
                </div>
              </section>
            </div>

            <div className="cfs-link-paper-viewport" hidden aria-label="CFS linkage paper map">
              <div className="cfs-link-paper" style={{ width: PAPER_WIDTH, height: PAPER_HEIGHT }}>
                <svg
                  className="cfs-link-paper-svg"
                  viewBox={`0 0 ${PAPER_WIDTH} ${PAPER_HEIGHT}`}
                  role="img"
                  aria-label="CFS radial linkage diagram"
                >
                  <defs>
                    <marker id="cfs-link-arrow-ok" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                      <path d="M0,0 L8,4 L0,8 z" />
                    </marker>
                    <marker id="cfs-link-arrow-warning" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                      <path d="M0,0 L8,4 L0,8 z" />
                    </marker>
                    <marker id="cfs-link-arrow-error" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                      <path d="M0,0 L8,4 L0,8 z" />
                    </marker>
                  </defs>
                  <circle className="cfs-link-paper-ring" cx={PAPER_WIDTH / 2} cy={PAPER_HEIGHT / 2} r="235" />
                  <circle className="cfs-link-paper-ring" cx={PAPER_WIDTH / 2} cy={PAPER_HEIGHT / 2} r="430" />
                  {FLOW_EDGES.map((edge) => {
                    const from = FLOW_NODES.find((node) => node.id === edge.from)!;
                    const to = FLOW_NODES.find((node) => node.id === edge.to)!;
                    const start = nodeCenter(from);
                    const end = nodeCenter(to);
                    const risk = flowEdgeRisk(edge, graph);
                    const controlX = PAPER_WIDTH / 2 + (start.x + end.x - PAPER_WIDTH) * 0.12;
                    const controlY = PAPER_HEIGHT / 2 + (start.y + end.y - PAPER_HEIGHT) * 0.12;
                    const labelX = (start.x + end.x + controlX) / 3;
                    const labelY = (start.y + end.y + controlY) / 3;
                    const path = `M ${start.x} ${start.y} Q ${controlX} ${controlY} ${end.x} ${end.y}`;
                    return (
                      <g key={`${edge.from}-${edge.to}-${edge.label}`} className={`cfs-link-edge cfs-link-edge-${risk}`}>
                        <path d={path} markerEnd={`url(#cfs-link-arrow-${risk})`} />
                        <text x={labelX} y={labelY - 7}>{edge.label}</text>
                      </g>
                    );
                  })}
                  {childNodes.map((child) => {
                    const parent = nodeCenter(expandedGroup);
                    const childX = child.x + CHILD_NODE_WIDTH / 2;
                    const childY = child.y + CHILD_NODE_HEIGHT / 2;
                    const path = `M ${parent.x} ${parent.y} L ${childX} ${childY}`;
                    return (
                      <g key={`child-edge-${child.node.id}`} className="cfs-link-paper-child-edge">
                        <path d={path} />
                      </g>
                    );
                  })}
                </svg>

                {FLOW_NODES.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    className={`cfs-link-paper-node cfs-link-paper-node-${node.id}${expandedGroupId === node.id ? " is-expanded" : ""}`}
                    style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
                    onClick={() => {
                      setExpandedGroupId(node.id);
                      setSelectedNodeId("");
                    }}
                    aria-pressed={expandedGroupId === node.id}
                  >
                    <strong>{node.label}</strong>
                    <span>{groupCount(graph, node.group)} records</span>
                  </button>
                ))}

                {childNodes.map((child) => {
                  const isMore = Boolean(child.hiddenCount);
                  return (
                    <button
                      key={child.node.id}
                      type="button"
                      className={`cfs-link-paper-child${selectedNodeId === child.node.id ? " is-selected" : ""}${isMore ? " is-more" : ""}`}
                      style={{ left: child.x, top: child.y, width: CHILD_NODE_WIDTH }}
                      onClick={() => {
                        if (!isMore) setSelectedNodeId(child.node.id);
                      }}
                      aria-pressed={selectedNodeId === child.node.id}
                    >
                      <strong>{nodeName(child.node, child.node.id)}</strong>
                      <span>{isMore ? `${child.hiddenCount} hidden records` : nodeDetail(child.node) || child.node.kind}</span>
                    </button>
                  );
                })}

                {selectedNode ? (
                  <div
                    className="cfs-link-paper-detail-card"
                    style={{
                      left: selectedPaperChild
                        ? clamp(selectedPaperChild.x + CHILD_NODE_WIDTH + 18, 24, PAPER_WIDTH - 340)
                        : PAPER_WIDTH - 360,
                      top: selectedPaperChild
                        ? clamp(selectedPaperChild.y, 24, PAPER_HEIGHT - 390)
                        : PAPER_HEIGHT - 390,
                    }}
                  >
                    <div>
                      <span>{selectedNode.group}</span>
                      <strong>{nodeName(selectedNode, selectedNode.id)}</strong>
                      <small>{nodeDetail(selectedNode) || selectedNode.kind}</small>
                    </div>
                    {selectedNodeEdges.length === 0 ? (
                      <p>No current links for this node.</p>
                    ) : (
                      <ul>
                        {selectedNodeEdges.map((edge) => {
                          const isSource = edge.from === selectedNode.id;
                          const otherNode = nodeById.get(isSource ? edge.to : edge.from);
                          return (
                            <li key={edge.id}>
                              <span>{isSource ? "to" : "from"} {edge.kind}</span>
                              <strong>{nodeName(otherNode, isSource ? edge.to : edge.from)}</strong>
                              <small>{edgeExplanationText(edge)}</small>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
            </div>

            <aside className="cfs-link-diagnostics">
              <div className="cfs-link-diagnostic-section">
                <h3>Overview Guide</h3>
                <div className="cfs-link-focus-card">
                  <span>Swimlane map</span>
                  <strong>{graph.summary.edges} current links</strong>
                  <small>
                    レーンは役割別の概要、カードは連動ルートです。ノードを選ぶと下に接続先が出ます。
                  </small>
                </div>
              </div>

              {selectedNode ? (
                <div className="cfs-link-diagnostic-section">
                  <h3>Selected Node</h3>
                  <div className="cfs-link-focus-card">
                    <span>{selectedNode.group}</span>
                    <strong>{nodeName(selectedNode, selectedNode.id)}</strong>
                    <small>{nodeDetail(selectedNode) || selectedNode.kind}</small>
                  </div>
                  {selectedNodeEdges.length > 0 ? (
                    <ul className="cfs-link-rule-list">
                      {selectedNodeEdges.slice(0, 4).map((edge) => (
                        <li key={`aside-${edge.id}`} className={`cfs-link-rule cfs-link-rule-${edge.risk}`}>
                          <span>{edge.risk}</span>
                          <strong>{edge.label}</strong>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <div className="cfs-link-diagnostic-section">
                <h3>Risk Check</h3>
                {graph.issues.length === 0 ? (
                  <p className="cfs-link-empty">No missing links were detected.</p>
                ) : (
                  <ul className="cfs-link-issue-list">
                    {graph.issues.slice(0, 8).map((issue) => (
                      <li key={issue.id} className={`cfs-link-issue cfs-link-issue-${issue.severity}`}>
                        <span>{severityLabel(issue.severity)}</span>
                        <strong>{issue.title}</strong>
                        <small>{issueRepairHintText(issue)}</small>
                      </li>
                    ))}
                  </ul>
                )}
                {graph.issues.length > 8 ? (
                  <p className="cfs-link-muted">+{graph.issues.length - 8} more issues in the Warnings view.</p>
                ) : null}
              </div>

              <div className="cfs-link-diagnostic-section">
                <h3>Active Link Types</h3>
                <ul className="cfs-link-rule-list">
                  {edgeSummaries.slice(0, 10).map((item) => (
                    <li key={item.key} className={`cfs-link-rule cfs-link-rule-${item.risk}`}>
                      <span>{item.count}</span>
                      <strong>{item.label}</strong>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="cfs-link-diagnostic-section">
                <h3>Stale HVAC Repair Preview</h3>
                {repairableStaleHvacCount === 0 && skippedStaleHvacCount === 0 ? (
                  <p className="cfs-link-empty">No repairable stale HVAC links are waiting.</p>
                ) : (
                  <>
                    <p className="cfs-link-muted">
                      {repairableStaleHvacCount} repairable / {skippedStaleHvacCount} skipped. Only stale HVAC target IDs are replaced.
                    </p>
                    <ul className="cfs-link-repair-list">
                      {(staleHvacRepairPlan?.repairs ?? []).slice(0, 8).map((item, index) => (
                        <li key={`${item.oldTargetId}-${item.newTargetId}-${index}`}>
                          <strong>{item.sourceName} / {item.metric}</strong>
                          <small>{readableTargetId(item.oldTargetId)} -&gt; {readableTargetId(item.newTargetId)}</small>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              <div className="cfs-link-diagnostic-section">
                <h3>Node Details</h3>
                <div className="cfs-link-node-list">
                  {nodeRows.map((node) => (
                    <div key={node.id} className="cfs-link-node-row">
                      <span>{node.group}</span>
                      <strong>{nodeName(node, node.id)}</strong>
                      <small>{nodeDetail(node) || node.kind}</small>
                    </div>
                  ))}
                </div>
              </div>
            </aside>
          </div>
        ) : null}

        {view === "current" ? (
          <div className="cfs-link-detail-view">
            <div className="cfs-link-detail-toolbar">
              <div>
                <strong>Current actual links</strong>
                <span>{detailedEdges.length} / {graph.edges.length} links shown</span>
              </div>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search source, target, rule, key"
                aria-label="Search current links"
              />
            </div>
            <div className="cfs-link-table-wrap">
              <table className="cfs-link-detail-table">
                <thead>
                  <tr>
                    <th>Risk</th>
                    <th>Route</th>
                    <th>Source</th>
                    <th>Link Detail</th>
                    <th>Target</th>
                    <th>Keys</th>
                  </tr>
                </thead>
                <tbody>
                  {detailedEdges.map(({ edge, index, source, target, sourceName, targetName }) => {
                    const targetIssues = issueByTarget.get(edge.keys[1]) ?? issueByTarget.get(edge.to.replace(/^target:/, "")) ?? [];
                    return (
                      <tr key={`${edge.id}-${index}`} className={`cfs-link-row-${edge.risk}`}>
                        <td><span className={`cfs-link-risk-pill cfs-link-risk-${edge.risk}`}>{edge.risk}</span></td>
                        <td>
                          <strong>{edge.fromGroup} -&gt; {edge.toGroup}</strong>
                          <small>{edge.kind}</small>
                        </td>
                        <td>
                          <strong>{sourceName}</strong>
                          <small>{edge.fromGroup}{nodeDetail(source) ? ` / ${nodeDetail(source)}` : ""}</small>
                        </td>
                        <td>
                          <strong>{edge.label}</strong>
                          <small>{edgeExplanationText(edge)}</small>
                          {targetIssues.length > 0 ? <em>{targetIssues[0].title}: {issueRepairHintText(targetIssues[0])}</em> : null}
                        </td>
                        <td>
                          <strong>{targetName}</strong>
                          <small>{edge.toGroup}{nodeDetail(target) ? ` / ${readableTargetId(nodeDetail(target))}` : ""}</small>
                        </td>
                        <td><code>{edge.keys.map(readableTargetId).join(" / ") || "-"}</code></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {view === "rules" ? (
          <div className="cfs-link-detail-view">
            <div className="cfs-link-detail-toolbar">
              <div>
                <strong>All expected link rules</strong>
                <span>Shows both current data links and expected CFS linkage rules, including rules with no current matches.</span>
              </div>
            </div>
            <div className="cfs-link-rule-grid">
              {ruleRows.map(({ rule, count, risk, status }) => (
                <article key={rule.id} className={`cfs-link-rule-card cfs-link-rule-card-${status}`}>
                  <div className="cfs-link-rule-card-head">
                    <span>{status === "active" ? "Active" : status === "warning" ? "Warning" : status === "missing" ? "Missing" : "Planned"}</span>
                    <strong>{count} current links</strong>
                  </div>
                  <h3>{rule.source} {"->"} {rule.target}</h3>
                  <p>{rule.label}</p>
                  <small>{rule.detail}</small>
                  {risk !== "ok" ? <em>Current risk: {risk}</em> : null}
                </article>
              ))}
            </div>
          </div>
        ) : null}

        {view === "issues" ? (
          <div className="cfs-link-detail-view">
            <div className="cfs-link-detail-toolbar">
              <div>
                <strong>Warnings and repair notes</strong>
                <span>回収が必要か、どの参照元を確認するかを表示します。</span>
              </div>
              {repairableStaleHvacCount > 0 && onRepairStaleHvacLinks ? (
                <button type="button" className="btn btn-primary" onClick={onRepairStaleHvacLinks}>
                  Repair Stale HVAC and Highlight
                </button>
              ) : null}
            </div>
            {graph.issues.length === 0 ? (
              <p className="cfs-link-empty">No warnings or errors were detected.</p>
            ) : (
              <div className="cfs-link-table-wrap">
                <table className="cfs-link-detail-table">
                  <thead>
                    <tr>
                      <th>Level</th>
                      <th>Group</th>
                      <th>Issue</th>
                      <th>Target</th>
                      <th>Repair Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {graph.issues.map((issue) => (
                      <tr key={issue.id} className={`cfs-link-row-${issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "ok"}`}>
                        <td><span className={`cfs-link-risk-pill cfs-link-risk-${issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "ok"}`}>{severityLabel(issue.severity)}</span></td>
                        <td>{issue.group}</td>
                        <td>
                          <strong>{issue.title}</strong>
                          <small>{issue.detail}</small>
                        </td>
                        <td><code>{issue.targetId ? readableTargetId(issue.targetId) : "-"}</code></td>
                        <td>{issueRepairHintText(issue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
