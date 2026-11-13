import { roomTypeIndexLabel, uniqueRoomTypeExcelSheetName } from "./excelExportNames";
import type { Workbook, Worksheet } from "exceljs";
import type { CircuitEntry, DeviceMaster, ProjectData, RoomScene, RoomType, SceneCircuitSetting, SwitchEntry } from "../types";
import { appendCfsSheet, type CfsExcelSheetModel } from "./cfsExcelExport";
import { appendRemarksSheet } from "./remarksExcelExport";
import { appendHvacSheets } from "./hvacExcelExport";
import { appendProjectTables, uniqueProjectExcelSheetName, type ProjectExcelTable, type ProjectExcelValue } from "./projectExcelTables";
import { projectPduTables } from "./projectExcelPdu";
import { circuitsForRoomType } from "./roomTypeSync";
import { calcFixtureVa, DALI_ADDRESSES_PER_LINE, fixtureUnitVa, normalizeBacklightLevels } from "./constants";
import { isDeviceDaliModel } from "./deviceAssignmentSync";
import { buildSettingTargetGroups, hvacSettingTargets, settingTargetIds, type SettingTarget } from "./settingTargets";
import { formatSettingLevel, selectedSceneIdsForSwitch } from "./cfsValueResolver";
import { isPmsScene, sortRoomScenesByGroup } from "./roomScenes";
import { buildSceneNameColors, CFS_OFF_VALUE_COLOR, isOffLikeDisplayValue, sceneNameColor } from "./cfsDisplayTextStyle";
import { parsePirAreaNumbers, parsePirSelections, parseQsmAssignments } from "./switchSync";
import { deriveTstatOccupancy, isActiveTstatControl, registeredThermostatSwitches, tstatCommandReferenceLabel } from "./tstatOccupancy";
import { DOOR_MAGNET_SCENE_LABEL } from "./cfsSceneColumnGroups";
import { hasTstatBindingQuarantine } from "./tstatBindingQuarantine";

export interface ProjectExcelExportOptions {
  // The caller binds the same snapshot and unfiltered project mode to its
  // existing CFS model builder; no second matrix implementation is introduced.
  buildCfsModel(roomType: RoomType): CfsExcelSheetModel;
  devices: readonly DeviceMaster[];
  wattPerPdu: number;
}

export interface ProjectExcelSheetIndexEntry {
  roomType: string;
  tab: string;
  sheetName: string;
  status: "Exported" | "Not applicable";
  note: string;
}

export interface ProjectExcelExportResult {
  index: readonly ProjectExcelSheetIndexEntry[];
  worksheets: readonly Worksheet[];
}

function areaName(project: ProjectData, id: string): string {
  return project.locations.find((area) => area.id === id)?.name || (id ? `Unresolved area: ${id}` : "Other");
}

function settingText(settings: readonly SceneCircuitSetting[], target: SettingTarget): string {
  const setting = settingTargetIds(target).map((id) => settings.find((entry) => entry.circuitId === id)).find((entry) => entry?.percentage.trim());
  return formatSettingLevel(setting, target.hvacMetric || target.dimmingType);
}

function settingSummary(settings: readonly SceneCircuitSetting[], targets: readonly SettingTarget[]): string {
  const lines: string[] = [];
  const known = new Set<string>();
  for (const target of targets) {
    settingTargetIds(target).forEach((id) => known.add(id));
    const value = settingText(settings, target);
    if (value !== "") lines.push(`${target.areaName} / ${target.circuitNumber} / ${target.detail}\n${value}`);
  }
  for (const setting of settings) {
    if (!known.has(setting.circuitId)) lines.push(`Unresolved target: ${setting.circuitId}\n${setting.percentage}`);
  }
  return lines.join("\n\n");
}

function roomSceneName(scene: RoomScene): string {
  const name = scene.sceneType.trim();
  let detail = scene.detail.trim();
  const lastWord = name.split(/\s+/).filter(Boolean).at(-1) ?? "";
  if (lastWord && detail.toLowerCase().startsWith(`${lastWord.toLowerCase()} `)) detail = detail.slice(lastWord.length).trim();
  return name.length === 1 && detail && /^[\p{L}\p{N}]/u.test(detail) ? `${name}${detail}` : [name, detail].filter(Boolean).join(" ");
}

function backlightName(room: Pick<RoomType, "backlightLevels">, value: string): string {
  if (value === "__byScene" || !value.trim()) return value === "__byScene" ? "By Scene" : "";
  return normalizeBacklightLevels(room.backlightLevels).find((level) => level.key === value)?.name ?? value;
}

function areaSceneTables(room: RoomType, targets: readonly SettingTarget[], project: ProjectData): ProjectExcelTable[] {
  const palette = buildSceneNameColors(room.scenes);
  return room.scenes.map((scene) => {
    const rows: ProjectExcelValue[][] = targets.filter((target) => target.areaId === scene.areaId || (!scene.areaId && target.areaName === "Other")).map((target, index) => [index + 1, target.areaName, target.circuitNumber, target.dimmingType, target.detail, settingText(scene.settings, target)]);
    const localTargets = targets.filter((target) => target.areaId === scene.areaId || (!scene.areaId && target.areaName === "Other"));
    const localIds = new Set(localTargets.flatMap(settingTargetIds));
    scene.settings.filter((setting) => !localIds.has(setting.circuitId)).forEach((setting) => {
      const target = targets.find((candidate) => settingTargetIds(candidate).includes(setting.circuitId));
      rows.push(["", target?.areaName ?? "", target?.circuitNumber ?? setting.circuitId, target?.dimmingType ?? "", target ? "Out-of-area setting (not applied)" : "Unresolved target", setting.percentage]);
    });
    return {
      title: `${areaName(project, scene.areaId)} / ${scene.name}`,
      titleColor: isOffLikeDisplayValue(scene.name) ? CFS_OFF_VALUE_COLOR : palette.get(scene.name.trim().toLowerCase()) ?? sceneNameColor(scene.name),
      headers: ["No", "Area", "Circuit #", "Dimming Type", "Detail", "Level"],
      widths: [8, 22, 15, 18, 34, 42], rows,
      // Retain a readable section for each Area Scene rather than serializing settings.
    };
  });
}

function sceneTable(scenes: readonly RoomScene[], room: RoomType, project: ProjectData, targets: readonly SettingTarget[], label: string): ProjectExcelTable {
  return {
    title: label,
    headers: ["No", "Room Status", "Scene Name", "Trigger Condition", "Area Scene Selection", "Individual Setting", "Backlight Setting"],
    widths: [8, 16, 30, 28, 40, 60, 28],
    rows: scenes.map((scene, index) => [index + 1, scene.phase, roomSceneName(scene), scene.triggerCondition,
      scene.areaSceneSelections.map((selection) => `${areaName(project, selection.areaId)}: ${room.scenes.find((candidate) => candidate.id === selection.sceneId)?.name ?? `Unresolved scene: ${selection.sceneId}`}`).join("\n"),
      settingSummary(scene.settings, targets), backlightName(room, scene.backlightCondition)]),
  };
}

function switchAllocation(sw: SwitchEntry, project: ProjectData): string {
  if (sw.kind === "pir") return Object.entries(parsePirAreaNumbers(sw.allocation)).map(([area, count]) => `${areaName(project, area)}: ${count}`).join("\n");
  if (sw.kind === "qsm") return parseQsmAssignments(sw.allocation).map((value) => {
    const [area, instance] = value.split("::");
    return `${areaName(project, area)}${instance ? ` / PIR ${instance}` : ""}`;
  }).join("\n");
  if (sw.kind === "contact" && sw.buttonFunction === "PIR") return parsePirSelections(sw.allocation).map((value) => {
    const [area, instance] = value.split("::");
    return `${areaName(project, area)}${instance ? ` / PIR ${instance}` : ""}`;
  }).join("\n");
  return sw.allocation;
}

function switchTable(rows: readonly SwitchEntry[], room: RoomType, project: ProjectData, targets: readonly SettingTarget[], label: string): ProjectExcelTable {
  return {
    title: label,
    headers: ["No", "Kind", "Switch #", "Switch Name", "CCI Assignment", "Buttons", "Button", "Function", "Priority", "Trigger Condition", "Allocation", "Area Scene Selection", "Function Setting", "Backlight Target", "Backlight Setting"],
    widths: [8, 16, 16, 24, 20, 12, 20, 24, 12, 28, 30, 36, 60, 30, 24],
    groupKeys: rows.map((sw) => sw.switchGroupId || sw.id), mergeColumns: [2, 3, 4, 5, 6],
    rows: rows.map((sw, index) => [index + 1, sw.kind, tstatCommandReferenceLabel(sw, room.switches, room.hvacAssignments),
      hasTstatBindingQuarantine(sw) ? "Quarantined control (inactive)" : sw.tstatBinding ? `${areaName(project, sw.tstatBinding.areaId)}${isActiveTstatControl(sw, room.hvacAssignments, room.switches) ? "" : " (inactive)"}` : sw.switchName,
      sw.cciAssignment, sw.buttonCount, sw.buttonLabel, sw.tstatBinding && sw.buttonFunction === "PIR" ? "" : sw.buttonFunction, sw.isPriorityFunction ? "Yes" : "", sw.condition, switchAllocation(sw, project),
      selectedSceneIdsForSwitch(sw).map((id) => room.scenes.find((scene) => scene.id === id)?.name ?? `Unresolved scene: ${id}`).join("\n"),
      settingSummary(sw.buttonSetting.circuitSettings, targets),
      sw.tstatBinding ? sw.backlightTarget.split(",").filter(Boolean).map((id) => {
        const target = room.switches.find((candidate) => (candidate.switchGroupId || candidate.id) === id);
        return target ? [target.switchNumber, target.switchName].filter(Boolean).join(" - ") : "Unresolved backlight target";
      }).join("\n") : sw.backlightTarget,
      backlightName(room, sw.backlightCondition)]),
  };
}

function deviceTable(room: RoomType, project: ProjectData, devices: readonly DeviceMaster[], circuits: readonly CircuitEntry[]): ProjectExcelTable {
  // As in DeviceAssignView, LINE is based on the complete DALI device-group
  // order, not the repeated address or a filtered/visible row index.
  const lineById = new Map<string, number>();
  const groupCounts = new Map<string, number>();
  for (const row of room.deviceAssignments) {
    if (!row.deviceGroupId || !row.device || !isDeviceDaliModel(row.device, devices)) continue;
    const index = groupCounts.get(row.deviceGroupId) ?? 0;
    lineById.set(row.id, index < DALI_ADDRESSES_PER_LINE ? 1 : 2);
    groupCounts.set(row.deviceGroupId, index + 1);
  }
  const hasDali = room.deviceAssignments.some((row) => row.device && isDeviceDaliModel(row.device, devices));
  return {
    title: "Device Assign (all zones and Reserved rows)",
    headers: hasDali
      ? ["No", "Device", "Device #", "LINE", "Group", "Low End", "High End", "Zone / Address", "Circuit #", "Area", "Detail"]
      : ["No", "Device", "Device #", "Low End", "High End", "Zone / Address", "Circuit #", "Area", "Group", "Detail"],
    widths: hasDali ? [8, 28, 12, 10, 12, 12, 12, 20, 24, 24, 42] : [8, 28, 12, 12, 12, 20, 24, 24, 12, 42],
    groupKeys: room.deviceAssignments.map((row) => row.deviceGroupId || row.id), mergeColumns: [2, 3],
    rows: room.deviceAssignments.map((row, index) => {
      const device = devices.find((candidate) => candidate.model === row.device);
      const circuitNumbers = [row.circuitNumber, ...(row.additionalCircuitNumbers ?? [])];
      const linked = circuitNumbers.map((number) => circuits.find((circuit) => circuit.internalNumber === number)).filter((circuit): circuit is CircuitEntry => Boolean(circuit));
      const areas = [...new Set(linked.map((circuit) => areaName(project, circuit.area)))];
      const details = [...new Set(linked.map((circuit) => circuit.detail).filter(Boolean))];
      const low = row.lowEnd || device?.lowEnd || "";
      const high = row.highEnd || device?.highEnd || "";
      const numbers = circuitNumbers.filter(Boolean).join("\n");
      const area = areas.join("\n") || (row.area ? areaName(project, row.area) : "");
      const detail = row.zoneDetail || row.detail || details.join("\n");
      return hasDali
        ? [index + 1, row.device, row.deviceNum, lineById.get(row.id) ?? "", row.group, low, high, row.zoneAddress, numbers, area, detail]
        : [index + 1, row.device, row.deviceNum, low, high, row.zoneAddress, numbers, area, row.group, detail];
    }),
  };
}

function circuitTable(circuits: readonly CircuitEntry[], project: ProjectData): ProjectExcelTable {
  return {
    title: "Circuit",
    headers: ["No", "Designer #", "Internal #", "Dimming Type", "Area", "Fixture", "pcs.", "VA", "Total VA", "FFE", "Energy Save", "Detail"],
    widths: [8, 16, 14, 18, 24, 30, 12, 12, 14, 10, 14, 42],
    rows: circuits.map((circuit, index) => {
      const fixture = project.fixtures.find((candidate) => candidate.fixture === circuit.fixture);
      return [index + 1, circuit.designerNumber, circuit.internalNumber, circuit.dimmingType, areaName(project, circuit.area), circuit.fixture, circuit.pcs, fixture ? fixtureUnitVa(fixture) ?? "" : "", fixture ? calcFixtureVa(circuit.pcs, fixture) : "", circuit.ffe ? "Yes" : "", circuit.energySaving ? "Yes" : "", circuit.detail];
    }),
  };
}

function backlightTables(room: Pick<RoomType, "backlightLevels" | "switches">): ProjectExcelTable[] {
  const levels = normalizeBacklightLevels(room.backlightLevels);
  const groups = new Map<string, SwitchEntry[]>();
  room.switches.filter((sw) => sw.kind === "lutronPd").forEach((sw) => {
    const key = sw.switchGroupId || sw.id;
    groups.set(key, [...(groups.get(key) ?? []), sw]);
  });
  return [
    { title: "Backlight Scenes", headers: ["No", "Backlight Scene", "Mode", "Active %", "Inactive %"], widths: [8, 30, 18, 16, 16], rows: levels.map((level, index) => [index + 1, level.name, level.mode, level.active, level.inactive]) },
    { title: "Palladiom Backlight Assignment", headers: ["No", "Switch #", "Switch Name", "Backlight Scene"], widths: [8, 20, 30, 30], rows: [...groups.values()].map((entries, index) => {
      const values = [...new Set(entries.map((entry) => backlightName(room, entry.backlightAssignment || "__byScene")))];
      return [index + 1, entries[0].switchNumber, entries[0].switchName, values.length === 1 ? values[0] : `Mixed\n${values.join("\n")}`];
    }) },
  ];
}

export function appendBacklightExcelSheet(workbook: Workbook, room: Pick<RoomType, "backlightLevels" | "switches">): void {
  appendProjectTables(workbook, "Backlight", backlightTables(room));
}

/** Export a caller-owned immutable project snapshot without editing or saving it. */
export function appendProjectExcelSheets(workbook: Workbook, projectSnapshot: ProjectData, options: ProjectExcelExportOptions): ProjectExcelExportResult {
  const project = projectSnapshot;
  const before = workbook.worksheets.length;
  const used = new Set(workbook.worksheets.map((sheet) => sheet.name.toLowerCase()));
  const indexName = uniqueProjectExcelSheetName("Project Index", used);
  // Reserve index first, while appending its contents only after the sheet list
  // is known. This also works when appending into a non-empty workbook.
  const indexSheet = workbook.addWorksheet(indexName);
  const entries: ProjectExcelSheetIndexEntry[] = [];
  const addTables = (room: Pick<RoomType, "name" | "revision"> | null, tab: string, tables: readonly ProjectExcelTable[], hasRecords = true, note = "") => {
    const label = room ? roomTypeIndexLabel(room) : "";
    if (!hasRecords) { entries.push({ roomType: label, tab, sheetName: "", status: "Not applicable", note: note || "No records in this project snapshot." }); return; }
    const name = room ? uniqueRoomTypeExcelSheetName(room, used, tab) : uniqueProjectExcelSheetName(tab, used);
    appendProjectTables(workbook, name, tables);
    entries.push({ roomType: label, tab, sheetName: name, status: "Exported", note });
  };
  addTables(null, "Area", [{ title: "Area", headers: ["No", "Area", "#", "Code", "Color"], widths: [8, 28, 14, 18, 18], rows: project.locations.map((area, index) => [index + 1, area.name, area.number, area.code, { text: area.color, color: area.color }]) }]);
  addTables(null, "Fixture", [{ title: "Fixture", headers: ["No", "Fixture", "Type", "Mode", "VA / W@", "Correction", "Unit VA"], widths: [8, 30, 22, 12, 16, 16, 16], rows: project.fixtures.map((fixture, index) => [index + 1, fixture.fixture, fixture.fixtureType, fixture.powerMode, fixture.watt, fixture.powerFactor, fixtureUnitVa(fixture) ?? ""]) }]);
  if ((project.remarks ?? []).length > 0) {
    const name = uniqueProjectExcelSheetName("Remarks", used);
    appendRemarksSheet(workbook, name, project.remarks ?? []);
    entries.push({ roomType: "", tab: "Remarks", sheetName: name, status: "Exported", note: "" });
  } else entries.push({ roomType: "", tab: "Remarks", sheetName: "", status: "Not applicable", note: "No remarks in this project snapshot." });
  project.roomTypes.forEach((storedRoom, roomIndex) => {
    const room = { ...storedRoom, switches: deriveTstatOccupancy(storedRoom).switches };
    const namedRoom = { name: room.name.trim() || `Room ${roomIndex + 1}`, revision: room.revision };
    const label = roomTypeIndexLabel(namedRoom);
    const circuits = circuitsForRoomType(project, room);
    const targets = [
      ...buildSettingTargetGroups(project.locations, circuits, room.deviceAssignments, room.rows, room.curtainAssignments ?? [], room.switches).flatMap((group) => group.targets),
      ...hvacSettingTargets(room.hvacAssignments, project.locations),
    ];
    addTables(namedRoom, "PDU", projectPduTables(room, options.devices, project.fixtures, circuits, options.wattPerPdu), true, "All devices; DALI included. Uses the captured Device Master and PDU setting.");
    addTables(namedRoom, "Circuit", [circuitTable(circuits, project)]);
    addTables(namedRoom, "Dry Contact", [{ title: "Dry Contact", headers: ["No", "Area", "Circuit", "Detail"], widths: [8, 26, 28, 48], rows: (room.dryContacts ?? []).map((row, index) => [index + 1, areaName(project, row.area), row.circuit, row.detail]) }], Boolean(room.dryContacts?.length));
    addTables(namedRoom, "Device Assign", [deviceTable(room, project, options.devices, circuits)], room.deviceAssignments.length > 0);
    addTables(namedRoom, "Curtain", [{ title: "Curtain", headers: ["No", "Area", "Detail", "Action"], widths: [8, 26, 42, 20], rows: (room.curtainAssignments ?? []).map((row, index) => [index + 1, areaName(project, row.area), row.detail, row.action]) }], Boolean(room.curtainAssignments?.length));
    const areaTables = areaSceneTables(room, targets, project);
    addTables(namedRoom, "Area Scene", areaTables, room.scenes.length > 0);
    const scenes = sortRoomScenesByGroup(room.roomScenes);
    const pms = scenes.filter(isPmsScene);
    const door = scenes.filter((scene) => !isPmsScene(scene));
    addTables(namedRoom, "Scene", [sceneTable(pms, room, project, targets, "From PMS Scene")], pms.length > 0);
    addTables(namedRoom, DOOR_MAGNET_SCENE_LABEL, [sceneTable(door, room, project, targets, DOOR_MAGNET_SCENE_LABEL)], door.length > 0);
    const registeredSwitches = new Set(registeredThermostatSwitches(room.switches, room.hvacAssignments));
    const switches = room.switches.filter(sw => sw.kind !== "command" &&
      (registeredSwitches.has(sw) || (room.hvacAssignments.length > 0 && hasTstatBindingQuarantine(sw))));
    const commands = room.switches.filter((sw) => sw.kind === "command");
    addTables(namedRoom, "Switch", [switchTable(switches, room, project, targets, "Switch")], switches.length > 0);
    addTables(namedRoom, "Command", [switchTable(commands, room, project, targets, "Command")], commands.length > 0);
    addTables(namedRoom, "Backlight", backlightTables(room));
    if (room.hvacAssignments.length > 0) {
      const names = { assignments: uniqueRoomTypeExcelSheetName(namedRoom, used, "TSTAT"), seasons: uniqueRoomTypeExcelSheetName(namedRoom, used, "TSTAT Seasons") };
      appendHvacSheets(workbook, { assignments: room.hvacAssignments, seasons: room.hvacSeasons, locations: project.locations }, names);
      entries.push({ roomType: label, tab: "TSTAT", sheetName: names.assignments, status: "Exported", note: "" }, { roomType: label, tab: "TSTAT Seasons", sheetName: names.seasons, status: "Exported", note: "" });
    } else entries.push({ roomType: label, tab: "TSTAT", sheetName: "", status: "Not applicable", note: "No HVAC assignments in this room type." }, { roomType: label, tab: "TSTAT Seasons", sheetName: "", status: "Not applicable", note: "No HVAC assignments in this room type." });
    const cfsName = uniqueRoomTypeExcelSheetName(namedRoom, used, "CFS");
    // The CFS projection distinguishes persisted controls from empty derived controls.
    appendCfsSheet(workbook, cfsName, options.buildCfsModel(storedRoom));
    entries.push({ roomType: label, tab: "CFS", sheetName: cfsName, status: "Exported", note: "All project columns and rows; temporary screen filters are ignored." });
  });
  indexSheet.columns = [{ width: 30 }, { width: 24 }, { width: 34 }, { width: 20 }, { width: 75 }];
  indexSheet.addRow([project.name, "Project Excel"]);
  indexSheet.mergeCells("A1:E1");
  indexSheet.getCell("A1").font = { name: "Arial", size: 16, bold: true, color: { argb: "FF0F6068" } };
  indexSheet.addRow(["Snapshot", project.updatedAt]);
  indexSheet.addRow(["Scope", "All room types and applicable tabs; no tab visits, edits or saves are performed."]);
  indexSheet.mergeCells("B3:E3");
  indexSheet.addRow(["Room Type", "Tab", "Worksheet", "Status", "Notes"]);
  const header = indexSheet.getRow(4);
  header.font = { name: "Arial", size: 11, bold: true };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF3F5" } };
  entries.forEach((entry) => {
    const row = indexSheet.addRow([entry.roomType || "Project", entry.tab, entry.sheetName, entry.status, entry.note]);
    row.font = { name: "Arial", size: 11, color: { argb: "FF111827" } };
    row.alignment = { vertical: "top", wrapText: true };
    if (entry.sheetName) row.getCell(3).value = { text: entry.sheetName, hyperlink: `#'${entry.sheetName.replace(/'/g, "''")}'!A1` };
    row.height = 34;
  });
  indexSheet.views = [{ state: "frozen", ySplit: 4, showGridLines: false }];
  indexSheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + entries.length, column: 5 } };
  indexSheet.pageSetup = { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:4" };
  return { index: entries, worksheets: workbook.worksheets.slice(before) };
}
