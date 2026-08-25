import type {
  BacklightLevelSetting,
  CfsCircuit,
  CfsRowDisplaySettings,
  CircuitEntry,
  CurtainAssignment,
  DeviceAssignment,
  DeviceMaster,
  DryContactEntry,
  HvacAssignment,
  HvacSeason,
  InspectionMark,
  LocationMaster,
  PduDeviceCount,
  RoomScene,
  RoomsSubTab,
  Scene,
  SwitchEntry,
} from "../types";

/**
 * Snapshot stored on every RoomTypeRevision. Revisions keep the full room-type
 * state, so a diff between any two revisions can always be recomputed on demand
 * instead of being frozen into the revision memo.
 */
export interface RevisionSnapshot {
  circuits?: CircuitEntry[];
  dryContacts?: DryContactEntry[];
  rows?: CfsCircuit[];
  deviceAssignments?: DeviceAssignment[];
  hvacAssignments?: HvacAssignment[];
  hvacSeasons?: HvacSeason[];
  curtainAssignments?: CurtainAssignment[];
  cfsRowDisplay?: CfsRowDisplaySettings;
  backlightLevels?: BacklightLevelSetting[];
  scenes?: Scene[];
  roomScenes?: RoomScene[];
  switches?: SwitchEntry[];
  pduDeviceCounts?: PduDeviceCount[];
  inspectionMarks?: InspectionMark[];
}

export type RevisionChangeKind = "changed" | "added" | "removed";

/**
 * One changed cell: a single field of a single row, with its before/after value.
 * Multi-field edits produce one entry per field so the UI can render them as
 * table cells instead of a semicolon-joined sentence.
 */
export interface RevisionChangeEntry {
  key: string;
  tabId: RoomsSubTab;
  tabLabel: string;
  groupLabel: string;
  rowId: string;
  rowLabel: string;
  field: string;
  fieldLabel: string;
  before: string;
  after: string;
  kind: RevisionChangeKind;
}

export interface RevisionChangeRowGroup {
  rowId: string;
  rowLabel: string;
  entries: RevisionChangeEntry[];
}

export interface RevisionChangeGroup {
  key: string;
  tabId: RoomsSubTab;
  label: string;
  rows: RevisionChangeRowGroup[];
  entryCount: number;
  addedCount: number;
  removedCount: number;
  changedCount: number;
}

export interface RevisionChangeContext {
  locations: readonly LocationMaster[];
  devices: readonly DeviceMaster[];
}

export const REVISION_CHANGE_FILTERS = ["all", "changed", "added", "removed"] as const;
export type RevisionChangeFilter = (typeof REVISION_CHANGE_FILTERS)[number];

const NOT_SET = "Not set";
const NO_VALUE = "-";

const FIELD_LABELS: Record<string, string> = {
  designerNumber: "Designer #",
  internalNumber: "Internal #",
  dimmingType: "Dimming type",
  fixture: "Fixture",
  pcs: "QTY",
  detail: "Detail",
  area: "Area",
  areaId: "Area",
  ffe: "FFE",
  energySaving: "Energy Saving",
  circuit: "Circuit",
  device: "Device",
  deviceNum: "Device #",
  circuitNumber: "Circuit",
  zoneAddress: "Zone",
  protocol: "Protocol",
  thermostatRole: "Master / Slave",
  lowEnd: "Low end",
  highEnd: "High end",
  summerWinterChange: "Summer/Winter",
  note: "Detail",
  name: "Name",
  startMonth: "Start month",
  startDay: "Start day",
  endMonth: "End month",
  endDay: "End day",
  phase: "Room status",
  switchNumber: "Switch #",
  switchName: "Switch name",
  buttonLabel: "Button",
  buttonFunction: "Function",
  isPriorityFunction: "Priority function",
  condition: "Trigger condition",
  sceneIds: "Area scene",
  buttonSetting: "Scene/override setting",
  areaSceneSelections: "Area scene selection",
  backlightTarget: "Backlight target",
  backlightCondition: "Backlight scene",
  backlightLevels: "Backlight logic",
  settings: "Scene values",
  triggerCondition: "Trigger condition",
  sceneType: "Scene name",
  quantity: "Quantity",
  action: "Action",
  control: "Control",
  watt: "Watt",
  addressZone: "Zone",
  group: "Group",
  sequenceNo: "Sequence #",
};

const HIDDEN_FIELDS = new Set([
  "__added",
  "__removed",
  "id",
  "circuitGroupId",
  "daliFixtureGroupId",
  "deviceGroupId",
  "switchGroupId",
  "group",
]);

const STRUCTURED_FIELDS = new Set(["settings", "sceneIds", "buttonSetting", "backlightLevels"]);

/** Tab labels the auto memo has ever produced. Used to recognise legacy notes. */
const AUTO_NOTE_TAB_PREFIXES = [
  "Circuit tab",
  "Dry Contact tab",
  "Device Assign tab",
  "Area Scene tab",
  "Scene tab",
  "Switch tab",
  "Command tab",
  "Backlight tab",
  "PDU tab",
  "CFS tab",
  "Project circuits",
  "Dry Contact",
  "CFS rows",
  "Device Assign",
  "HVAC",
  "HVAC seasons",
  "Lutron Curtain",
  "Area Scene",
  "Scene",
  "Switch",
  "Command",
  "Backlight",
  "CFS row display",
  "PDU",
  "Inspection marks",
];

const AUTO_NOTE_SENTINELS = [
  "Initial revision snapshot.",
  "No data changes from the previous revision.",
  "No memo.",
];

const INTERNAL_ID_PATTERN = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i;

function hasInternalId(value: string): boolean {
  return INTERNAL_ID_PATTERN.test(value);
}

interface SummarizeTarget {
  tabId: RoomsSubTab;
  label: string;
}

/**
 * Builds one entry per changed cell for every tracked collection in the
 * snapshot. Labels are resolved against the CURRENT project masters, matching
 * the previous behaviour of the string-based memo generator.
 */
export function buildRevisionChangeEntries(
  before: RevisionSnapshot,
  after: RevisionSnapshot,
  context: RevisionChangeContext,
): RevisionChangeEntry[] {
  const areaNameById = new Map(context.locations.map((location) => [location.id, location.name]));
  const sceneLabelById = new Map(
    [...(before.scenes ?? []), ...(after.scenes ?? [])]
      .filter((scene) => Boolean(scene.name))
      .map((scene) => [scene.id, scene.name]),
  );
  const roomSceneLabelById = new Map(
    [...(before.roomScenes ?? []), ...(after.roomScenes ?? [])]
      .map((scene): [string, string] => [
        scene.id,
        [scene.phase, scene.sceneType, scene.detail].filter(Boolean).join(" / "),
      ])
      .filter(([, label]) => Boolean(label)),
  );
  const assignmentLabelById = new Map(
    [...(before.deviceAssignments ?? []), ...(after.deviceAssignments ?? [])].map((assignment) => [
      assignment.id,
      [
        [assignment.device, assignment.deviceNum].filter(Boolean).join("/"),
        assignment.zoneAddress || assignment.circuitNumber,
      ]
        .filter(Boolean)
        .join(" ") || "Unassigned device",
    ]),
  );

  const targetLabelById = new Map<string, string>();
  [...(before.circuits ?? []), ...(after.circuits ?? [])].forEach((circuit) => {
    targetLabelById.set(
      circuit.id,
      [circuit.designerNumber || circuit.internalNumber || "Circuit", circuit.detail || circuit.fixture]
        .filter(Boolean)
        .join(" / "),
    );
  });
  [...(before.deviceAssignments ?? []), ...(after.deviceAssignments ?? [])].forEach((assignment) => {
    const address = assignment.zoneAddress.trim();
    const normalizedAddress = address.replace(/^\d+-/, "");
    const inputKind = /^CCI/i.test(normalizedAddress) ? "cci" : /^CCO/i.test(normalizedAddress) ? "cco" : "";
    if (!inputKind) return;
    const value = assignment.circuitNumber.trim();
    const detail = assignment.detail.trim();
    targetLabelById.set(
      `${inputKind}:${assignment.id}`,
      [address || inputKind.toUpperCase(), value && value !== "Reserved" ? value : "", detail].filter(Boolean).join(" / "),
    );
  });
  [...(before.hvacAssignments ?? []), ...(after.hvacAssignments ?? [])].forEach((assignment) => {
    ["On/Off", "Setpoint", "Fan Mode", "Drift"].forEach((metric) => {
      targetLabelById.set(
        `hvac:${assignment.id}:${metric}`,
        ["HVAC", areaNameById.get(assignment.area), metric].filter(Boolean).join(" / "),
      );
    });
  });
  [...(before.curtainAssignments ?? []), ...(after.curtainAssignments ?? [])].forEach((assignment) => {
    targetLabelById.set(
      `curtain:${assignment.id}`,
      ["Lutron Curtain", areaNameById.get(assignment.area), assignment.detail].filter(Boolean).join(" / "),
    );
  });

  const readableBacklightTarget = (value: string): string => {
    const labels = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => sceneLabelById.get(entry) || roomSceneLabelById.get(entry) || areaNameById.get(entry) || "")
      .filter(Boolean);
    return labels.length > 0 ? labels.join(", ") : "Configured";
  };

  const readableLabel = (value: string, fallback: string): string =>
    hasInternalId(value) ? fallback : value || fallback;

  const displayValue = (field: string, value: unknown): string => {
    if (value === null || value === undefined || value === "") return NOT_SET;
    if (field === "area" || field === "areaId") return areaNameById.get(String(value)) || "Unassigned area";
    if (field === "cciAssignment") return assignmentLabelById.get(String(value)) || "Not assigned";
    if (field === "backlightTarget") return readableBacklightTarget(String(value));
    if (STRUCTURED_FIELDS.has(field) || typeof value === "object") return "Updated";
    if (typeof value === "boolean") return value ? "On" : "Off";
    const text = String(value);
    return hasInternalId(text) ? "Configured" : text;
  };

  const settingsMap = (settings: unknown): Map<string, string> => {
    const map = new Map<string, string>();
    if (!Array.isArray(settings)) return map;
    for (const setting of settings) {
      if (!setting || typeof setting !== "object") continue;
      const row = setting as { circuitId?: unknown; percentage?: unknown };
      const targetId = typeof row.circuitId === "string" ? row.circuitId.trim() : "";
      if (!targetId) continue;
      map.set(targetId, typeof row.percentage === "string" ? row.percentage.trim() : String(row.percentage ?? "").trim());
    }
    return map;
  };

  const targetLabel = (targetId: string): string =>
    targetLabelById.get(targetId) || targetId.replace(/^[a-f0-9-]{18,}$/i, "Configured target");

  const entries: RevisionChangeEntry[] = [];
  const push = (entry: Omit<RevisionChangeEntry, "key">): void => {
    entries.push({ ...entry, key: `${entry.tabLabel}|${entry.rowId}|${entry.field}|${entries.length}` });
  };

  /** Expands one structured field (scene values / button settings) per target. */
  const pushStructuredField = (
    target: SummarizeTarget,
    groupLabel: string,
    rowId: string,
    rowLabel: string,
    field: string,
    fieldLabel: string,
    beforeRow: Record<string, unknown> | undefined,
    afterRow: Record<string, unknown> | undefined,
  ): void => {
    let beforeSettings: unknown;
    let afterSettings: unknown;
    if (field === "buttonSetting") {
      beforeSettings = (beforeRow?.buttonSetting as { circuitSettings?: unknown } | undefined)?.circuitSettings;
      afterSettings = (afterRow?.buttonSetting as { circuitSettings?: unknown } | undefined)?.circuitSettings;
    } else if (field === "settings") {
      beforeSettings = beforeRow?.settings;
      afterSettings = afterRow?.settings;
    } else {
      push({
        tabId: target.tabId,
        tabLabel: target.label,
        groupLabel,
        rowId,
        rowLabel,
        field,
        fieldLabel,
        before: "Configured",
        after: "Updated",
        kind: "changed",
      });
      return;
    }

    const beforeByTarget = settingsMap(beforeSettings);
    const afterByTarget = settingsMap(afterSettings);
    const targetIds = Array.from(new Set([...beforeByTarget.keys(), ...afterByTarget.keys()])).filter(
      (targetId) => beforeByTarget.get(targetId) !== afterByTarget.get(targetId),
    );
    if (targetIds.length === 0) {
      push({
        tabId: target.tabId,
        tabLabel: target.label,
        groupLabel,
        rowId,
        rowLabel,
        field,
        fieldLabel,
        before: "Configured",
        after: "Updated",
        kind: "changed",
      });
      return;
    }
    targetIds.forEach((targetId) => {
      push({
        tabId: target.tabId,
        tabLabel: target.label,
        groupLabel,
        rowId,
        rowLabel,
        field,
        fieldLabel: `${fieldLabel} / ${targetLabel(targetId)}`,
        before: beforeByTarget.get(targetId) || NOT_SET,
        after: afterByTarget.get(targetId) || NOT_SET,
        kind: "changed",
      });
    });
  };

  const changedFieldsById = <T extends { id: string }>(
    beforeRows: readonly T[] = [],
    afterRows: readonly T[] = [],
  ): Map<string, string[]> => {
    const beforeById = new Map(beforeRows.map((item) => [item.id, item]));
    const afterById = new Map(afterRows.map((item) => [item.id, item]));
    const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
    const result = new Map<string, string[]>();
    ids.forEach((id) => {
      const beforeItem = beforeById.get(id) as Record<string, unknown> | undefined;
      const afterItem = afterById.get(id) as Record<string, unknown> | undefined;
      const keys = new Set(
        [...Object.keys(beforeItem ?? {}), ...Object.keys(afterItem ?? {})].filter((key) => key !== "id"),
      );
      const fields = Array.from(keys).filter(
        (key) => JSON.stringify(beforeItem?.[key]) !== JSON.stringify(afterItem?.[key]),
      );
      if (!beforeItem && afterItem) fields.unshift("__added");
      if (beforeItem && !afterItem) fields.unshift("__removed");
      if (fields.length > 0) result.set(id, fields);
    });
    return result;
  };

  function summarize<T extends { id: string }>(
    target: SummarizeTarget,
    groupLabel: string,
    beforeRows: readonly T[] = [],
    afterRows: readonly T[] = [],
    labelFor: (row: T) => string,
  ): void {
    const fieldsById = changedFieldsById(beforeRows, afterRows);
    const beforeById = new Map(beforeRows.map((row) => [row.id, row]));
    const afterById = new Map(afterRows.map((row) => [row.id, row]));

    fieldsById.forEach((fields, id) => {
      const beforeRow = beforeById.get(id);
      const afterRow = afterById.get(id);
      const row = afterRow ?? beforeRow;
      if (!row) return;
      const rowLabel = labelFor(row);

      if (!beforeRow) {
        push({
          tabId: target.tabId,
          tabLabel: target.label,
          groupLabel,
          rowId: id,
          rowLabel,
          field: "__added",
          fieldLabel: "Row",
          before: NO_VALUE,
          after: "Added",
          kind: "added",
        });
        return;
      }
      if (!afterRow) {
        push({
          tabId: target.tabId,
          tabLabel: target.label,
          groupLabel,
          rowId: id,
          rowLabel,
          field: "__removed",
          fieldLabel: "Row",
          before: "Removed",
          after: NO_VALUE,
          kind: "removed",
        });
        return;
      }

      const beforeRecord = beforeRow as Record<string, unknown>;
      const afterRecord = afterRow as Record<string, unknown>;
      fields
        .filter((field) => !HIDDEN_FIELDS.has(field))
        .forEach((field) => {
          const fieldLabel = FIELD_LABELS[field] ?? field;
          if (STRUCTURED_FIELDS.has(field)) {
            pushStructuredField(target, groupLabel, id, rowLabel, field, fieldLabel, beforeRecord, afterRecord);
            return;
          }
          push({
            tabId: target.tabId,
            tabLabel: target.label,
            groupLabel,
            rowId: id,
            rowLabel,
            field,
            fieldLabel,
            before: displayValue(field, beforeRecord[field]),
            after: displayValue(field, afterRecord[field]),
            kind: "changed",
          });
        });
    });
  }

  summarize({ tabId: "circuit", label: "Circuit tab" }, "", before.circuits, after.circuits, (row) =>
    [row.designerNumber || row.internalNumber || "Unassigned circuit", row.detail].filter(Boolean).join(" / "),
  );
  summarize({ tabId: "circuit", label: "Dry Contact tab" }, "", before.dryContacts, after.dryContacts, (row) =>
    [areaNameById.get(row.area) || "Unassigned area", row.circuit || "Unassigned contact", row.detail]
      .filter(Boolean)
      .join(" / "),
  );
  // Legacy CFS rows were previously only visible through the count-only
  // fallback, so a CFS row edit combined with any other edit was invisible.
  summarize({ tabId: "circuit", label: "Circuit tab" }, "CFS rows", before.rows, after.rows, (row) =>
    [row.designerNumber || row.addressZone || row.device || "CFS row", row.note || row.fixture]
      .filter(Boolean)
      .join(" / "),
  );
  summarize(
    { tabId: "deviceAssign", label: "Device Assign tab" },
    "",
    before.deviceAssignments,
    after.deviceAssignments,
    (row) =>
      [[row.device, row.deviceNum].filter(Boolean).join("/"), row.zoneAddress || row.circuitNumber]
        .filter(Boolean)
        .join(" ") || "Unassigned device",
  );
  summarize(
    { tabId: "deviceAssign", label: "Device Assign tab" },
    "HVAC",
    before.hvacAssignments,
    after.hvacAssignments,
    (row) => [row.protocol, row.note || areaNameById.get(row.area) || "HVAC assignment"].filter(Boolean).join(" "),
  );
  summarize(
    { tabId: "deviceAssign", label: "Device Assign tab" },
    "HVAC Season",
    before.hvacSeasons,
    after.hvacSeasons,
    (row) => row.name || `${row.startMonth}/${row.startDay}-${row.endMonth}/${row.endDay}`,
  );
  summarize(
    { tabId: "deviceAssign", label: "Device Assign tab" },
    "Lutron Curtain",
    before.curtainAssignments,
    after.curtainAssignments,
    (row) =>
      ["Lutron Curtain", areaNameById.get(row.area) || "Unassigned area", row.detail].filter(Boolean).join(" / "),
  );
  summarize({ tabId: "areaScene", label: "Area Scene tab" }, "", before.scenes, after.scenes, (row) =>
    row.name || areaNameById.get(row.areaId) || "Unnamed area scene",
  );
  summarize({ tabId: "scene", label: "Scene tab" }, "", before.roomScenes, after.roomScenes, (row) =>
    [row.phase, row.sceneType, row.detail, row.triggerCondition].filter(Boolean).join(" / ") || "Unnamed scene",
  );

  const beforeMarks = new Map((before.inspectionMarks ?? []).map((mark) => [mark.id, mark]));
  const afterMarks = new Map((after.inspectionMarks ?? []).map((mark) => [mark.id, mark]));
  new Set([...beforeMarks.keys(), ...afterMarks.keys()]).forEach((id) => {
    const previous = beforeMarks.get(id);
    const next = afterMarks.get(id);
    const label = next?.label || previous?.label || "Inspection update";
    const base = {
      tabId: "cfs" as RoomsSubTab,
      tabLabel: "CFS tab",
      groupLabel: "Inspection Mark",
      rowId: id,
      rowLabel: label,
      field: "value",
      fieldLabel: "Inspection value",
    };
    if (!previous && next) {
      push({ ...base, before: next.previousValue || NOT_SET, after: next.value || "Uneffected", kind: "added" });
    } else if (previous && !next) {
      push({ ...base, before: previous.value || previous.previousValue || NOT_SET, after: "Mark cleared", kind: "removed" });
    } else if (previous && next && JSON.stringify(previous) !== JSON.stringify(next)) {
      push({
        ...base,
        before: previous.value || previous.previousValue || NOT_SET,
        after: next.value || "Uneffected",
        kind: "changed",
      });
    }
  });

  const beforePduByDevice = new Map((before.pduDeviceCounts ?? []).map((row) => [row.deviceId, row]));
  const afterPduByDevice = new Map((after.pduDeviceCounts ?? []).map((row) => [row.deviceId, row]));
  new Set([...beforePduByDevice.keys(), ...afterPduByDevice.keys()]).forEach((deviceId) => {
    const beforeRow = beforePduByDevice.get(deviceId);
    const afterRow = afterPduByDevice.get(deviceId);
    if ((beforeRow?.quantity ?? 0) === (afterRow?.quantity ?? 0)) return;
    const label = context.devices.find((device) => device.id === deviceId)?.model || "Unassigned device";
    push({
      tabId: "pdu",
      tabLabel: "PDU tab",
      groupLabel: "",
      rowId: deviceId,
      rowLabel: label,
      field: "quantity",
      fieldLabel: "Quantity",
      before: String(beforeRow?.quantity ?? 0),
      after: String(afterRow?.quantity ?? 0),
      kind: "changed",
    });
  });

  // Room-type level Backlight Logic. Keyed by level `key`, so a renamed or
  // retuned level reports the exact field that moved.
  const beforeLevels = new Map((before.backlightLevels ?? []).map((level) => [level.key, level]));
  const afterLevels = new Map((after.backlightLevels ?? []).map((level) => [level.key, level]));
  new Set([...beforeLevels.keys(), ...afterLevels.keys()]).forEach((key) => {
    const previous = beforeLevels.get(key);
    const next = afterLevels.get(key);
    const rowLabel = next?.name || previous?.name || key || "Backlight Logic";
    const base = {
      tabId: "backlight" as RoomsSubTab,
      tabLabel: "Backlight tab",
      groupLabel: "Backlight Logic",
      rowId: key,
      rowLabel,
    };
    if (!previous && next) {
      push({ ...base, field: "__added", fieldLabel: "Row", before: NO_VALUE, after: "Added", kind: "added" });
      return;
    }
    if (previous && !next) {
      push({ ...base, field: "__removed", fieldLabel: "Row", before: "Removed", after: NO_VALUE, kind: "removed" });
      return;
    }
    if (!previous || !next) return;
    (["name", "mode", "active", "inactive"] as const).forEach((field) => {
      if (previous[field] === next[field]) return;
      push({
        ...base,
        field,
        fieldLabel: field === "name" ? "Name" : field === "mode" ? "Mode" : field === "active" ? "Active" : "Inactive",
        before: displayValue(field, previous[field]),
        after: displayValue(field, next[field]),
        kind: "changed",
      });
    });
  });

  const beforeRowDisplay = before.cfsRowDisplay;
  const afterRowDisplay = after.cfsRowDisplay;
  if (beforeRowDisplay && afterRowDisplay) {
    const rowDisplayBase = {
      tabId: "cfs" as RoomsSubTab,
      tabLabel: "CFS tab",
      groupLabel: "",
      rowId: "cfs-row-display",
      rowLabel: "Row display / order",
      kind: "changed" as RevisionChangeKind,
    };
    if (JSON.stringify(beforeRowDisplay.order) !== JSON.stringify(afterRowDisplay.order)) {
      push({
        ...rowDisplayBase,
        field: "order",
        fieldLabel: "Row order",
        before: beforeRowDisplay.order.join(", ") || NOT_SET,
        after: afterRowDisplay.order.join(", ") || NOT_SET,
      });
    }
    if (JSON.stringify(beforeRowDisplay.hidden) !== JSON.stringify(afterRowDisplay.hidden)) {
      push({
        ...rowDisplayBase,
        field: "hidden",
        fieldLabel: "Hidden rows",
        before: beforeRowDisplay.hidden.join(", ") || "None",
        after: afterRowDisplay.hidden.join(", ") || "None",
      });
    }
  }

  const beforeSwitches = before.switches ?? [];
  const afterSwitches = after.switches ?? [];
  const switchFieldsById = changedFieldsById(beforeSwitches, afterSwitches);
  const beforeSwitchById = new Map(beforeSwitches.map((row) => [row.id, row]));
  const afterSwitchById = new Map(afterSwitches.map((row) => [row.id, row]));
  switchFieldsById.forEach((fields, id) => {
    const beforeRow = beforeSwitchById.get(id);
    const afterRow = afterSwitchById.get(id);
    const row = afterRow ?? beforeRow;
    if (!row) return;
    const isBacklightChange = fields.some(
      (field) =>
        field === "backlightTarget" ||
        field === "backlightCondition" ||
        field === "backlightAssignment" ||
        field === "backlightLevels",
    );
    const target: SummarizeTarget =
      row.kind === "command"
        ? { tabId: "command", label: "Command tab" }
        : isBacklightChange
          ? { tabId: "backlight", label: "Backlight tab" }
          : { tabId: "switch", label: "Switch tab" };
    const rowLabel =
      [
        [readableLabel(row.switchNumber, row.kind === "pir" ? "PIR" : "Configured switch"), row.switchName]
          .filter(Boolean)
          .join(" - "),
        readableLabel(row.buttonLabel, ""),
        row.buttonFunction,
      ]
        .filter(Boolean)
        .join(" / ") || "Unlabeled switch";

    if (!beforeRow) {
      push({
        tabId: target.tabId,
        tabLabel: target.label,
        groupLabel: "",
        rowId: id,
        rowLabel,
        field: "__added",
        fieldLabel: "Row",
        before: NO_VALUE,
        after: "Added",
        kind: "added",
      });
      return;
    }
    if (!afterRow) {
      push({
        tabId: target.tabId,
        tabLabel: target.label,
        groupLabel: "",
        rowId: id,
        rowLabel,
        field: "__removed",
        fieldLabel: "Row",
        before: "Removed",
        after: NO_VALUE,
        kind: "removed",
      });
      return;
    }

    const beforeRecord = beforeRow as unknown as Record<string, unknown>;
    const afterRecord = afterRow as unknown as Record<string, unknown>;
    fields
      .filter((field) => !HIDDEN_FIELDS.has(field))
      .forEach((field) => {
        const fieldLabel = FIELD_LABELS[field] ?? field;
        if (STRUCTURED_FIELDS.has(field)) {
          pushStructuredField(target, "", id, rowLabel, field, fieldLabel, beforeRecord, afterRecord);
          return;
        }
        push({
          tabId: target.tabId,
          tabLabel: target.label,
          groupLabel: "",
          rowId: id,
          rowLabel,
          field,
          fieldLabel,
          before: displayValue(field, beforeRecord[field]),
          after: displayValue(field, afterRecord[field]),
          kind: "changed",
        });
      });
  });

  return entries;
}

/** Groups entries into tab sections, then into rows so the table can merge cells. */
export function groupRevisionChangeEntries(entries: readonly RevisionChangeEntry[]): RevisionChangeGroup[] {
  const groups: RevisionChangeGroup[] = [];
  const groupByKey = new Map<string, RevisionChangeGroup>();
  const rowByKey = new Map<string, RevisionChangeRowGroup>();

  for (const entry of entries) {
    const label = entry.groupLabel ? `${entry.tabLabel} / ${entry.groupLabel}` : entry.tabLabel;
    let group = groupByKey.get(label);
    if (!group) {
      group = {
        key: label,
        tabId: entry.tabId,
        label,
        rows: [],
        entryCount: 0,
        addedCount: 0,
        removedCount: 0,
        changedCount: 0,
      };
      groupByKey.set(label, group);
      groups.push(group);
    }
    const rowKey = `${label} ${entry.rowId}`;
    let row = rowByKey.get(rowKey);
    if (!row) {
      row = { rowId: entry.rowId, rowLabel: entry.rowLabel, entries: [] };
      rowByKey.set(rowKey, row);
      group.rows.push(row);
    }
    row.entries.push(entry);
    group.entryCount += 1;
    if (entry.kind === "added") group.addedCount += 1;
    else if (entry.kind === "removed") group.removedCount += 1;
    else group.changedCount += 1;
  }

  return groups;
}

export function filterRevisionChangeEntries(
  entries: readonly RevisionChangeEntry[],
  filter: RevisionChangeFilter,
): RevisionChangeEntry[] {
  if (filter === "all") return [...entries];
  return entries.filter((entry) => entry.kind === filter);
}

/** Legacy one-line-per-row rendering, kept for plain-text copy and exports. */
export function revisionChangeEntriesToText(entries: readonly RevisionChangeEntry[]): string {
  return groupRevisionChangeEntries(entries)
    .map((group) => {
      const lines = group.rows.flatMap((row) =>
        row.entries.map((entry) => `  ${row.rowLabel} | ${entry.fieldLabel} | ${entry.before} -> ${entry.after}`),
      );
      return [`[${group.label}] ${group.entryCount} changes`, ...lines].join("\n");
    })
    .join("\n\n");
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function revisionChangeEntriesToCsv(
  entries: readonly RevisionChangeEntry[],
  meta: { roomTypeName: string; baseRevision: string; targetRevision: string },
): string {
  const header = ["Room Type", "Base", "Target", "Tab", "Target Row", "Field", "Before", "After", "Kind"];
  const rows = groupRevisionChangeEntries(entries).flatMap((group) =>
    group.rows.flatMap((row) =>
      row.entries.map((entry) =>
        [
          meta.roomTypeName,
          meta.baseRevision,
          meta.targetRevision,
          group.label,
          row.rowLabel,
          entry.fieldLabel,
          entry.before,
          entry.after,
          entry.kind,
        ].map(csvCell).join(","),
      ),
    ),
  );
  return [header.map(csvCell).join(","), ...rows].join("\r\n");
}

/**
 * Older revisions stored the generated memo inside `note`, which made the memo
 * textarea show a raw tab-separated dump. Strip those lines so only what a
 * person actually typed stays editable. Also unwraps the legacy `Note\t` prefix.
 */
export function stripAutoGeneratedRevisionNote(note: string): string {
  const lines = note.split(/\r?\n/);
  const userLines: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (AUTO_NOTE_SENTINELS.includes(line)) continue;
    const tabIndex = line.indexOf("\t");
    if (tabIndex < 0) {
      userLines.push(line);
      continue;
    }
    const prefix = line.slice(0, tabIndex).trim();
    const rest = line.slice(tabIndex + 1).trim();
    if (prefix === "Note") {
      if (rest) userLines.push(rest);
      continue;
    }
    if (AUTO_NOTE_TAB_PREFIXES.some((known) => prefix === known || prefix.startsWith(`${known} /`))) {
      continue;
    }
    userLines.push(line.replace(/\t/g, " "));
  }
  return userLines.join("\n");
}

export function isAutoGeneratedRevisionNote(note: string): boolean {
  const trimmed = note.trim();
  if (!trimmed) return false;
  return stripAutoGeneratedRevisionNote(trimmed) === "";
}
