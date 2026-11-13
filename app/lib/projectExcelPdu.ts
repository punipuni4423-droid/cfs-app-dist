import type { CircuitEntry, DeviceMaster, FixtureMaster, RoomType, SwitchEntry } from "../types";
import { fixtureUnitVa, getDeviceAddresses } from "./constants";
import { isPrivacyPicoButtonCount } from "./picoSpecials";
import type { ProjectExcelTable } from "./projectExcelTables";

const number = (value: string | number) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value.replace(/^\+/, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};
const rounded = (value: number) => Math.round(value * 100) / 100;

/** Snapshot projection of PduView's quantity and VA rules; no quantity sync/write. */
export function projectPduTables(room: RoomType, devices: readonly DeviceMaster[], fixtures: readonly FixtureMaster[], circuits: readonly CircuitEntry[], wattPerPdu: number): ProjectExcelTable[] {
  const manual = new Map((room.pduDeviceCounts ?? []).map((row) => [row.deviceId, row.quantity]));
  const assignments = room.deviceAssignments ?? [];
  const switches = room.switches ?? [];
  const switchGroup = (sw: SwitchEntry) => sw.switchGroupId || sw.id;
  const deviceRows = devices.filter((device) => device.pdu.trim() || device.watts.trim()).map((device) => {
    const model = device.model.trim().toLowerCase();
    const kind = model.includes("palladiom") ? "lutronPd" : model.includes("pico") ? "lutronPico" : model.includes("qsm") ? "qsm" : model.includes("pir") || model.includes("occ") ? "pir" : null;
    const source = getDeviceAddresses(device.model).length > 0 ? "Device Assign"
      : device.control.trim().toLowerCase() === "tstat" || model.includes("tstat") || model.includes("thermostat") ? "HVAC"
        : kind ? "Switch" : "Manual";
    const quantity = source === "Device Assign" ? new Set(assignments.filter((row) => row.device === device.model).map((row) => `${device.model}:${row.deviceGroupId || row.deviceNum || row.id}`)).size
      : source === "HVAC" ? room.hvacAssignments.length
        : kind === "lutronPico" ? new Set(switches.filter((sw) => sw.kind === kind && (device.model.replace(/\s+/g, "").toLowerCase() === "privacypico" ? isPrivacyPicoButtonCount(sw.buttonCount) : !isPrivacyPicoButtonCount(sw.buttonCount))).map(switchGroup)).size
          : kind ? new Set(switches.filter((sw) => sw.kind === kind).map((sw) => kind === "lutronPd" ? sw.switchNumber.trim() || switchGroup(sw) : switchGroup(sw))).size
            : manual.get(device.id) ?? 0;
    const unitPdu = number(device.pdu);
    const directVa = number(device.watts);
    const unitVa = unitPdu > 0 ? 0 : directVa > 0 ? directVa : Math.abs(unitPdu) * wattPerPdu;
    return { name: device.model, source, quantity, unitPdu, unitVa, totalPdu: unitPdu * quantity, totalVa: unitVa * quantity };
  });
  const fixtureByName = new Map(fixtures.map((fixture) => [fixture.fixture, fixture]));
  const fixtureRows = new Map<string, { unitVa: number; quantity: number }>();
  for (const circuit of circuits) {
    const fixture = fixtureByName.get(circuit.fixture);
    const unitVa = fixture ? fixtureUnitVa(fixture) : null;
    const quantity = number(circuit.pcs);
    if (unitVa === null || quantity <= 0) continue;
    fixtureRows.set(circuit.fixture, { unitVa, quantity: (fixtureRows.get(circuit.fixture)?.quantity ?? 0) + quantity });
  }
  const totalPdu = deviceRows.reduce((sum, row) => sum + row.totalPdu, 0);
  const deviceVa = deviceRows.reduce((sum, row) => sum + row.totalVa, 0);
  const fixtureVa = [...fixtureRows.values()].reduce((sum, row) => sum + row.unitVa * row.quantity, 0);
  return [
    { title: "Lutron Device PDU Summary (all devices)", headers: ["Device", "PDU / Unit", "Qty", "Count", "Total PDU", "VA / Unit", "Total VA"], widths: [30, 15, 10, 18, 15, 15, 15], rows: deviceRows.map((row) => [row.name, rounded(row.unitPdu), row.quantity, row.source, rounded(row.totalPdu), rounded(row.unitVa), rounded(row.totalVa)]) },
    { title: "Lighting Fixture VA Summary (DALI included)", headers: ["Fixture", "Unit VA", "Total pcs", "Total VA"], rows: [...fixtureRows].map(([name, row]) => [name, rounded(row.unitVa), row.quantity, rounded(row.unitVa * row.quantity)]) },
    { title: "Power Summary", headers: ["Item", "Value"], widths: [34, 24], rows: [["1 PDU (VA)", wattPerPdu], ["Total PDU", rounded(totalPdu)], ["Lighting Fixture Total VA", rounded(fixtureVa)], ["Lutron Device Total VA", rounded(deviceVa)], ["Combined Total VA", rounded(fixtureVa + deviceVa)], ["Breaker Rating", "20 A / 100 V"], ["Breakers Required", Math.max(0, Math.ceil((fixtureVa + deviceVa) / 100 / 20))]] },
  ];
}
