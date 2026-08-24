"use client";

import { useState, type ReactNode } from "react";
import type {
  CircuitEntry,
  DeviceAssignment,
  DeviceMaster,
  FixtureMaster,
  HvacAssignment,
  PduDeviceCount,
  RevisionFieldChanges,
  RoomType,
  SwitchEntry,
  SwitchKind,
} from "../types";
import {
  createEmptyDeviceAssignment,
  createEmptyHvacAssignment,
  createEmptySwitchEntry,
  DEFAULT_FIXTURE_POWER_FACTOR,
  fixtureUnitVa,
  getDeviceAddresses,
  RESERVED_VALUE,
} from "../lib/constants";
import {
  PICO_CORRIDOR_ALLOCATION,
  PICO_CORRIDOR_BUTTON_COUNT,
  PICO_CORRIDOR_BUTTON_LABEL,
  PICO_PRIVACY_BUTTON_COUNT,
  isPrivacyPicoButtonCount,
} from "../lib/picoSpecials";
import { createAppId } from '../lib/id';

interface PduViewProps {
  roomType: RoomType;
  devices: DeviceMaster[];
  fixtures: FixtureMaster[];
  circuits: CircuitEntry[];
  wattPerPdu: number;
  onFixturesChange: (next: FixtureMaster[]) => void;
  onPduDeviceCountsChange: (next: PduDeviceCount[]) => void;
  onDeviceAssignmentsChange: (next: DeviceAssignment[]) => void;
  onHvacAssignmentsChange: (next: HvacAssignment[]) => void;
  onSwitchesChange: (next: SwitchEntry[]) => void;
  revisionChanges?: RevisionFieldChanges;
}

interface DevicePduRow {
  device: DeviceMaster;
  pduPerUnit: number;
  vaPerUnit: number;
  quantity: number;
  source: "Device Assign" | "HVAC" | "Switch" | "Manual";
  switchKind: SwitchKind | null;
  totalPdu: number;
  totalVa: number;
}

interface FixtureVaRow {
  fixture: string;
  unitVa: number;
  quantity: number;
  totalVa: number;
}

function parseNumber(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value.replace(/^\+/, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "-";
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

function countAssignedDevices(assignments: DeviceAssignment[], model: string): number {
  const keys = new Set<string>();
  assignments.forEach((assignment) => {
    if (assignment.device !== model) return;
    const key = assignment.deviceGroupId || assignment.deviceNum || assignment.id;
    keys.add(`${model}:${key}`);
  });
  return keys.size;
}

function hasAddressConfiguration(device: DeviceMaster): boolean {
  return getDeviceAddresses(device.model).length > 0;
}

function assignmentGroupKey(assignment: DeviceAssignment): string {
  return assignment.deviceGroupId || assignment.id;
}

function switchGroupKey(sw: SwitchEntry): string {
  return sw.switchGroupId || sw.id;
}

// A physical Palladiom keypad can span several switch groups (e.g. the upper
// and lower halves of a bedside keypad share one switch number). The PDU count
// follows the Switch tab quantity, so Palladioms are counted per switch number.
function palladiomUnitKey(sw: SwitchEntry): string {
  return sw.switchNumber.trim() || switchGroupKey(sw);
}

function switchUnitKey(sw: SwitchEntry): string {
  return sw.kind === "lutronPd" ? palladiomUnitKey(sw) : switchGroupKey(sw);
}

function switchKindForDevice(device: DeviceMaster): SwitchKind | null {
  const model = device.model.trim().toLowerCase();
  if (model.includes("palladiom")) return "lutronPd";
  if (model.includes("pico")) return "lutronPico";
  if (model === "qsm" || model.includes("qsm")) return "qsm";
  if (model.includes("pir") || model.includes("occ")) return "pir";
  return null;
}

function isCorridorPicoDevice(device: DeviceMaster): boolean {
  return device.model.replace(/\s+/g, "").toLowerCase() === "corridorpico";
}

function isPrivacyPicoDevice(device: DeviceMaster): boolean {
  return device.model.replace(/\s+/g, "").toLowerCase() === "privacypico";
}

// The PDU table lists CorridorPico and PrivacyPico as separate devices, but both
// are lutronPico switches. A pico switch group belongs to the PrivacyPico row
// when its button count is "Privacy"; every other pico group counts toward the
// non-privacy pico device row (CorridorPico), preserving the previous behavior.
function picoDeviceMatchesSwitch(device: DeviceMaster, sw: SwitchEntry): boolean {
  return isPrivacyPicoDevice(device)
    ? isPrivacyPicoButtonCount(sw.buttonCount)
    : !isPrivacyPicoButtonCount(sw.buttonCount);
}

function countPicoGroupsForDevice(switches: SwitchEntry[], device: DeviceMaster): number {
  return new Set(
    switches
      .filter((sw) => sw.kind === "lutronPico" && picoDeviceMatchesSwitch(device, sw))
      .map((sw) => switchGroupKey(sw)),
  ).size;
}

function isHvacTstatDevice(device: DeviceMaster): boolean {
  const model = device.model.trim().toLowerCase();
  const control = device.control.trim().toLowerCase();
  return control === "tstat" || model.includes("tstat") || model.includes("thermostat");
}

function countSwitchGroups(switches: SwitchEntry[], kind: SwitchKind): number {
  return new Set(
    switches
      .filter((sw) => sw.kind === kind)
      .map((sw) => switchUnitKey(sw)),
  ).size;
}

function nextDeviceNumber(rows: ReadonlyArray<DeviceAssignment>, model: string): string {
  const used = rows
    .filter((row) => row.device === model)
    .map((row) => Number.parseInt(row.deviceNum, 10))
    .filter((value): value is number => Number.isFinite(value));
  return String((used.length > 0 ? Math.max(...used) : 0) + 1);
}

function syncDeviceAssignments(
  assignments: DeviceAssignment[],
  device: DeviceMaster,
  quantity: number,
): DeviceAssignment[] {
  const addresses = getDeviceAddresses(device.model);
  if (addresses.length === 0) return assignments;
  const groups: string[] = [];
  const seen = new Set<string>();
  for (const assignment of assignments) {
    if (assignment.device !== device.model) continue;
    const key = assignmentGroupKey(assignment);
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(key);
  }

  if (quantity < groups.length) {
    const keep = new Set(groups.slice(0, quantity));
    return assignments.filter((assignment) => {
      if (assignment.device !== device.model) return true;
      return keep.has(assignmentGroupKey(assignment));
    });
  }

  let next = [...assignments];
  for (let index = groups.length; index < quantity; index += 1) {
    const groupId = createAppId();
    const deviceNum = nextDeviceNumber(next, device.model);
    const expandedRows = addresses.map((address, addressIndex) => ({
      ...createEmptyDeviceAssignment(),
      id: addressIndex === 0 ? createAppId() : createAppId(),
      deviceGroupId: groupId,
      device: device.model,
      deviceNum,
      zoneAddress: address,
      circuitNumber: RESERVED_VALUE,
    }));
    next = [...next, ...expandedRows];
  }
  return next;
}

function nextSwitchNumber(switches: SwitchEntry[], kind: SwitchKind, prefix: string): string {
  const numbers = switches
    .filter((sw) => sw.kind === kind)
    .map((sw) => {
      const match = sw.switchNumber.trim().match(new RegExp(`^${prefix}\\s*(\\d+)$`, "i"));
      return match ? Number.parseInt(match[1], 10) : null;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const fallbackCount = countSwitchGroups(switches, kind);
  return `${prefix}${(numbers.length > 0 ? Math.max(...numbers) : fallbackCount) + 1}`;
}

function createPduSwitch(device: DeviceMaster, kind: SwitchKind, switches: SwitchEntry[]): SwitchEntry {
  const next = createEmptySwitchEntry(kind);
  if (kind === "qsm") {
    return {
      ...next,
      switchNumber: nextSwitchNumber(switches, kind, "QSM"),
      switchName: device.model,
      allocation: "[]",
    };
  }
  if (kind === "lutronPd") {
    return {
      ...next,
      switchNumber: nextSwitchNumber(switches, kind, "PD"),
      switchName: device.model,
    };
  }
  if (kind === "lutronPico") {
    const isCorridorPico = isCorridorPicoDevice(device);
    return {
      ...next,
      switchNumber: nextSwitchNumber(switches, kind, "Pico"),
      switchName: device.model,
      buttonCount: isCorridorPico ? PICO_CORRIDOR_BUTTON_COUNT : next.buttonCount,
      buttonLabel: isCorridorPico ? PICO_CORRIDOR_BUTTON_LABEL : next.buttonLabel,
      allocation: isCorridorPico ? PICO_CORRIDOR_ALLOCATION : next.allocation,
      buttonFunction: isCorridorPico ? PICO_CORRIDOR_BUTTON_LABEL : next.buttonFunction,
      condition: isCorridorPico ? "Press4sec" : next.condition,
    };
  }
  if (kind === "pir") {
    return {
      ...next,
      switchNumber: nextSwitchNumber(switches, kind, "PIR"),
      switchName: device.model,
      buttonFunction: "PIR",
    };
  }
  return {
    ...next,
    switchNumber: nextSwitchNumber(switches, kind, "SW"),
    switchName: device.model,
  };
}

// Privacy picos are created as a two-button group (M1 MUR / M2 DND), matching
// what the Switch tab produces when the button count is set to "Privacy".
function createPrivacyPicoRows(device: DeviceMaster, switches: SwitchEntry[]): SwitchEntry[] {
  const base = createEmptySwitchEntry("lutronPico");
  const shared = {
    switchNumber: nextSwitchNumber(switches, "lutronPico", "Pico"),
    switchName: device.model,
    buttonCount: PICO_PRIVACY_BUTTON_COUNT,
  };
  return [
    { ...base, ...shared, buttonLabel: "M1", buttonFunction: "MUR" },
    {
      ...createEmptySwitchEntry("lutronPico"),
      ...shared,
      switchGroupId: base.switchGroupId,
      buttonLabel: "M2",
      buttonFunction: "DND",
    },
  ];
}

function syncSwitchesForDevice(
  switches: SwitchEntry[],
  device: DeviceMaster,
  kind: SwitchKind,
  quantity: number,
): SwitchEntry[] {
  const matches = (sw: SwitchEntry): boolean =>
    sw.kind === kind && (kind !== "lutronPico" || picoDeviceMatchesSwitch(device, sw));
  const groups: string[] = [];
  const seen = new Set<string>();
  for (const sw of switches) {
    if (!matches(sw)) continue;
    const key = switchUnitKey(sw);
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(key);
  }

  if (quantity < groups.length) {
    const keep = new Set(groups.slice(0, quantity));
    return switches.filter((sw) => !matches(sw) || keep.has(switchUnitKey(sw)));
  }

  let next = [...switches];
  for (let index = groups.length; index < quantity; index += 1) {
    if (kind === "lutronPico" && isPrivacyPicoDevice(device)) {
      next = [...next, ...createPrivacyPicoRows(device, next)];
    } else {
      next = [...next, createPduSwitch(device, kind, next)];
    }
  }
  return next;
}

function parseQuantity(rawValue: string): number {
  if (rawValue.trim() === "") return 0;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

function syncHvacAssignments(assignments: HvacAssignment[], quantity: number): HvacAssignment[] {
  if (quantity <= assignments.length) return assignments.slice(0, quantity);
  const next = [...assignments];
  for (let index = assignments.length; index < quantity; index += 1) {
    next.push(createEmptyHvacAssignment());
  }
  return next;
}

function normalizePowerFactor(value: string): string {
  if (value.trim() === "") return "";
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return "";
  return String(Math.min(1, Math.max(0.1, parsed)));
}

function commonFixturePowerFactor(fixtures: FixtureMaster[]): string {
  if (fixtures.length === 0) return DEFAULT_FIXTURE_POWER_FACTOR;
  const values = Array.from(
    new Set(fixtures.map((fixture) => fixture.powerFactor || DEFAULT_FIXTURE_POWER_FACTOR)),
  );
  return values.length === 1 ? values[0] : "";
}

export default function PduView({
  roomType,
  devices,
  fixtures,
  circuits,
  wattPerPdu,
  onFixturesChange,
  onPduDeviceCountsChange,
  onDeviceAssignmentsChange,
  onHvacAssignmentsChange,
  onSwitchesChange,
  revisionChanges,
}: PduViewProps) {
  const [excludeDaliFixtures, setExcludeDaliFixtures] = useState(false);
  const [hideReservedDevices, setHideReservedDevices] = useState(true);
  const pduDevices = devices.filter((device) => device.pdu.trim() !== "" || device.watts.trim() !== "");
  const manualQuantityByDevice = new Map(
    roomType.pduDeviceCounts.map((item) => [item.deviceId, item.quantity]),
  );

  function manualQuantity(deviceId: string): number {
    return manualQuantityByDevice.get(deviceId) ?? 0;
  }

  function updateManualQuantity(deviceId: string, quantity: number): void {
    const next = roomType.pduDeviceCounts
      .filter((item) => item.deviceId !== deviceId)
      .filter((item) => devices.some((device) => device.id === item.deviceId));
    if (quantity > 0) {
      next.push({ deviceId, quantity });
    }
    onPduDeviceCountsChange(next);
  }

  function updateDeviceQuantity(device: DeviceMaster, rawValue: string): void {
    const quantity = parseQuantity(rawValue);
    if (hasAddressConfiguration(device)) {
      onDeviceAssignmentsChange(syncDeviceAssignments(roomType.deviceAssignments, device, quantity));
      return;
    }
    if (isHvacTstatDevice(device)) {
      onHvacAssignmentsChange(syncHvacAssignments(roomType.hvacAssignments, quantity));
      return;
    }
    const switchKind = switchKindForDevice(device);
    if (switchKind) {
      onSwitchesChange(syncSwitchesForDevice(roomType.switches, device, switchKind, quantity));
      return;
    }
    updateManualQuantity(device.id, quantity);
  }

  function updateFixturePowerFactor(rawValue: string): void {
    const nextValue = normalizePowerFactor(rawValue);
    onFixturesChange(fixtures.map((fixture) => ({ ...fixture, powerFactor: nextValue })));
  }

  function revisionCellClass(deviceId: string, fields: string[] = ["quantity"]): string {
    const changed = revisionChanges?.[deviceId];
    if (!changed) return "";
    const isChanged = changed.some((field) => field === "__added" || field === "__removed" || fields.includes(field));
    return isChanged ? "revision-changed-cell" : "";
  }

  const deviceRows: DevicePduRow[] = pduDevices.map((device) => {
    const pduPerUnit = parseNumber(device.pdu);
    const directVa = parseNumber(device.watts);
    const switchKind = switchKindForDevice(device);
    const source = hasAddressConfiguration(device)
      ? "Device Assign"
      : isHvacTstatDevice(device)
        ? "HVAC"
        : switchKind
          ? "Switch"
          : "Manual";
    const quantity = source === "Device Assign"
      ? countAssignedDevices(roomType.deviceAssignments, device.model)
      : source === "HVAC"
        ? roomType.hvacAssignments.length
        : switchKind === "lutronPico"
          ? countPicoGroupsForDevice(roomType.switches, device)
          : switchKind
            ? countSwitchGroups(roomType.switches, switchKind)
            : manualQuantity(device.id);
    const vaPerUnit = pduPerUnit > 0
      ? 0
      : directVa > 0
        ? directVa
        : Math.abs(pduPerUnit) * wattPerPdu;
    return {
      device,
      pduPerUnit,
      vaPerUnit,
      quantity,
      source,
      switchKind,
      totalPdu: pduPerUnit * quantity,
      totalVa: vaPerUnit * quantity,
    };
  });
  const activeDeviceRows = deviceRows.filter((row) => row.quantity > 0);
  const displayedDeviceRows = hideReservedDevices ? activeDeviceRows : deviceRows;

  const fixtureByName = new Map(fixtures.map((fixture) => [fixture.fixture, fixture]));
  const fixtureAccumulator = new Map<string, { unitVa: number; quantity: number }>();
  circuits.forEach((circuit) => {
    if (excludeDaliFixtures && circuit.dimmingType === "DALI") return;
    const fixture = fixtureByName.get(circuit.fixture);
    if (!fixture) return;
    const unitVa = fixtureUnitVa(fixture);
    if (unitVa === null) return;
    const quantity = parseNumber(circuit.pcs);
    if (quantity <= 0) return;
    const existing = fixtureAccumulator.get(fixture.fixture) ?? { unitVa, quantity: 0 };
    fixtureAccumulator.set(fixture.fixture, {
      unitVa,
      quantity: existing.quantity + quantity,
    });
  });
  const fixtureRows: FixtureVaRow[] = Array.from(fixtureAccumulator.entries()).map(
    ([fixture, value]) => ({
      fixture,
      unitVa: value.unitVa,
      quantity: value.quantity,
      totalVa: value.unitVa * value.quantity,
    }),
  );

  const grandPdu = activeDeviceRows.reduce((sum, row) => sum + row.totalPdu, 0);
  const fixtureVaTotal = fixtureRows.reduce((sum, row) => sum + row.totalVa, 0);
  const lutronDeviceVaTotal = activeDeviceRows.reduce((sum, row) => sum + row.totalVa, 0);
  const combinedVa = fixtureVaTotal + lutronDeviceVaTotal;
  const breakersRequired = Math.max(0, Math.ceil(combinedVa / 100 / 20));

  return (
    <section className="card card-padded fade-in pdu-view">
      <div className="toolbar">
        <span className={`muted-pill ${grandPdu < 0 ? "pdu-pill-warning" : "pdu-pill-ok"}`}>
          Total PDU {formatNumber(grandPdu)}
        </span>
        <span className="muted-pill">1 PDU = {formatNumber(wattPerPdu)} VA</span>
        <span className="toolbar-spacer" />
        <label className="toolbar-field">
          <span>Correction</span>
          <input
            className="cell-input"
            type="number"
            min="0.1"
            max="1"
            step="0.1"
            value={commonFixturePowerFactor(fixtures)}
            onChange={(event) => updateFixturePowerFactor(event.target.value)}
          />
        </label>
        <span className="pdu-breaker-badge">{breakersRequired} Breaker</span>
      </div>

      <div className="pdu-summary-grid">
        <div className="pdu-kpi">
          <span className="pdu-kpi-label">
            Fixture VA
            <span className={`pdu-kpi-status ${excludeDaliFixtures ? "is-excluded" : "is-included"}`}>
              {excludeDaliFixtures ? "DALI Excluded" : "DALI Included"}
            </span>
          </span>
          <strong>{formatNumber(fixtureVaTotal)}</strong>
        </div>
        <div className="pdu-kpi">
          <span>Lutron Device VA</span>
          <strong>{formatNumber(lutronDeviceVaTotal)}</strong>
        </div>
        <div className="pdu-kpi">
          <span>Combined VA</span>
          <strong>{formatNumber(combinedVa)}</strong>
        </div>
      </div>

      {grandPdu < 0 ? (
        <div className="pdu-warning">PDU total is below 0. Add supply or reduce load.</div>
      ) : null}

      <PduTable
        title="Lutron Device PDU Summary"
        actions={
          <button
            type="button"
            className="btn btn-secondary reserved-toggle-button"
            onClick={() => setHideReservedDevices((prev) => !prev)}
          >
            {hideReservedDevices ? "Show Reserved" : "Hide Reserved"}
          </button>
        }
      >
        <table className="matrix-table pdu-table">
          <thead>
            <tr>
              <th>Device</th>
              <th className="col-center">PDU / Unit</th>
              <th className="col-center">Qty</th>
              <th className="col-center">Count</th>
              <th className="col-center">Total PDU</th>
              <th className="col-center">VA / Unit</th>
              <th className="col-center">Total VA</th>
            </tr>
          </thead>
          <tbody>
            {displayedDeviceRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="screen-empty compact">No PDU devices are registered.</td>
              </tr>
            ) : (
              displayedDeviceRows.map((row) => (
                <tr key={row.device.id}>
                  <td className={revisionCellClass(row.device.id, ["__added", "__removed"])}>
                    <strong>{row.device.model}</strong>
                    <span className="pdu-subtext">{row.device.control || "-"}</span>
                  </td>
                  <td className="col-center">{row.device.pdu || "0"}</td>
                  <td className={`col-center ${revisionCellClass(row.device.id)}`}>
                    <input
                      className="cell-input pdu-qty-input"
                      type="number"
                      min="0"
                      step="1"
                      value={row.quantity || ""}
                      onChange={(event) => updateDeviceQuantity(row.device, event.target.value)}
                    />
                  </td>
                  <td className="col-center">
                    <span className="muted-pill">{row.source}</span>
                  </td>
                  <td className={`col-center ${row.totalPdu < 0 ? "pdu-negative" : "pdu-positive"}`}>
                    {formatNumber(row.totalPdu)}
                  </td>
                  <td className="col-center">{formatNumber(row.vaPerUnit)}</td>
                  <td className="col-center">{formatNumber(row.totalVa)}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>Grand Total</td>
              <td className={`col-center ${grandPdu < 0 ? "pdu-negative" : "pdu-positive"}`}>
                {formatNumber(grandPdu)}
              </td>
              <td />
              <td className="col-center">{formatNumber(lutronDeviceVaTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </PduTable>

      <PduTable
        title="Lighting Fixture VA Summary"
        actions={
          <button
            type="button"
            className="btn btn-secondary reserved-toggle-button"
            onClick={() => setExcludeDaliFixtures((prev) => !prev)}
          >
            {excludeDaliFixtures ? "Show DALI" : "Exclude DALI"}
          </button>
        }
      >
        <table className="matrix-table pdu-table">
          <thead>
            <tr>
              <th>Fixture</th>
              <th className="col-center">Unit VA</th>
              <th className="col-center">Total pcs</th>
              <th className="col-center">Total VA</th>
            </tr>
          </thead>
          <tbody>
            {fixtureRows.length === 0 ? (
              <tr>
                <td colSpan={4} className="screen-empty compact">No fixture VA is available.</td>
              </tr>
            ) : (
              fixtureRows.map((row) => (
                <tr key={row.fixture}>
                  <td>{row.fixture}</td>
                  <td className="col-center">{formatNumber(row.unitVa)}</td>
                  <td className="col-center">{formatNumber(row.quantity)}</td>
                  <td className="col-center">{formatNumber(row.totalVa)}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Grand Total Fixture VA</td>
              <td className="col-center">{formatNumber(fixtureVaTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </PduTable>

      <PduTable title="Total Power Summary">
        <table className="matrix-table pdu-table pdu-total-table">
          <tbody>
            <tr>
              <th>Lighting Fixture Total VA</th>
              <td>{formatNumber(fixtureVaTotal)}</td>
            </tr>
            <tr>
              <th>Lutron Device Total VA</th>
              <td>{formatNumber(lutronDeviceVaTotal)}</td>
            </tr>
            <tr>
              <th>Combined Total VA</th>
              <td>{formatNumber(combinedVa)}</td>
            </tr>
            <tr>
              <th>Breaker Rating</th>
              <td>20A</td>
            </tr>
            <tr>
              <th>Breakers Required</th>
              <td>{breakersRequired}</td>
            </tr>
          </tbody>
        </table>
      </PduTable>
    </section>
  );
}

function PduTable({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="pdu-section">
      <div className="pdu-section-header">
        <h3>{title}</h3>
        {actions ? <div className="pdu-section-actions">{actions}</div> : null}
      </div>
      <div className="matrix-scroll pdu-scroll">{children}</div>
    </div>
  );
}
