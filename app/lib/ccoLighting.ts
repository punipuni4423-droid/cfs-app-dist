import type { CircuitEntry, DeviceAssignment } from "../types";
import { RESERVED_VALUE } from "./constants";

export function isCcoLighting(assignment: Pick<DeviceAssignment, "zoneAddress" | "ccoLighting">): boolean {
  return assignment.ccoLighting === true && /^CCO/i.test(assignment.zoneAddress.trim().replace(/^\d+-/, ""));
}

export function isContactPort(assignment: Pick<DeviceAssignment, "zoneAddress">): boolean {
  return /^CC[IO]/i.test(assignment.zoneAddress.trim().replace(/^\d+-/, ""));
}

export function ccoLightingCircuit(circuits: readonly CircuitEntry[], number: string): CircuitEntry | undefined {
  const value = number.trim();
  if (!value || value === RESERVED_VALUE) return undefined;
  const matches = circuits.filter((c) => c.designerNumber.trim() === value || c.internalNumber.trim() === value);
  if (new Set(matches.map((c) => c.circuitGroupId || c.id)).size !== 1) return undefined;
  const match = matches[0];
  if (!match) return undefined;
  const group = circuits.filter((c) => (c.circuitGroupId || c.id) === (match.circuitGroupId || match.id));
  return group.every((c) => c.dimmingType === "On/Off") ? match : undefined;
}

// Compare the actual circuit group, not the currently displayed number mode.
export function hasCcoLightingOwner(
  assignments: readonly DeviceAssignment[], circuits: readonly CircuitEntry[], number: string, exceptId: string,
): boolean {
  const circuit = ccoLightingCircuit(circuits, number);
  if (!circuit) return false;
  const key = circuit.circuitGroupId || circuit.id;
  return assignments.some((a) => a.id !== exceptId && isCcoLighting(a) &&
    [a.circuitNumber, ...(a.additionalCircuitNumbers ?? [])].some((value) => {
      const assigned = ccoLightingCircuit(circuits, value);
      return assigned && (assigned.circuitGroupId || assigned.id) === key;
    }));
}

function portKey(a: DeviceAssignment): string {
  return a.deviceGroupId && a.zoneAddress ? `${a.deviceGroupId}::${a.zoneAddress}` : a.id;
}

export function clearLightingAssignment(a: DeviceAssignment): DeviceAssignment {
  const next = { ...a, circuitNumber: RESERVED_VALUE, detail: "", area: "", group: "" };
  delete next.additionalCircuitNumbers;
  delete next.zoneDetail;
  return next;
}

// A pure preview: the caller must confirm movedFrom before committing next.
// Bundled primary moves are refused rather than silently unassigning companions.
export function planCcoLightingAssignment(
  assignments: readonly DeviceAssignment[], circuits: readonly CircuitEntry[],
  targetId: string, number: string, extraIndex?: number,
): { next: DeviceAssignment[]; movedFrom: string[] } {
  const target = assignments.find((a) => a.id === targetId);
  if (!target || !isCcoLighting(target)) throw new Error("Choose a CCO lighting output first.");
  const value = number.trim();
  const circuit = ccoLightingCircuit(circuits, value);
  if (!circuit) throw new Error("CCO lighting accepts On/Off circuits only.");
  const sameGroup = (candidate: CircuitEntry | undefined) => candidate && (candidate.circuitGroupId || candidate.id) === (circuit.circuitGroupId || circuit.id);
  const extras = [...(target.additionalCircuitNumbers ?? [])];
  if (extraIndex !== undefined) {
    if (!ccoLightingCircuit(circuits, target.circuitNumber)) throw new Error("Assign the primary On/Off circuit first.");
    if (sameGroup(ccoLightingCircuit(circuits, target.circuitNumber)) || extras.some((v, i) => sameGroup(ccoLightingCircuit(circuits, v)) && i !== extraIndex)) throw new Error("This circuit is already assigned to this output.");
    if (extraIndex < 0) { if (extras.length >= 4) throw new Error("A zone can contain at most 5 circuits."); extras.push(value); }
    else { if (extraIndex >= extras.length) throw new Error("The circuit slot no longer exists."); extras[extraIndex] = value; }
  }
  const targetPort = portKey(target);
  const moved = new Map<string, string>();
  const sourcePorts = new Set<string>();
  const extraSourceIds = new Set<string>();
  let sourceDetail = "";
  for (const a of assignments) {
    if (portKey(a) === targetPort || (isContactPort(a) && !isCcoLighting(a))) continue;
    const primaryMatch = ccoLightingCircuit(circuits, a.circuitNumber);
    if (sameGroup(primaryMatch)) {
      if ((a.additionalCircuitNumbers ?? []).length) throw new Error("Remove this primary circuit from its existing bundle before moving it.");
      sourcePorts.add(portKey(a));
      sourceDetail ||= a.detail.trim();
      moved.set(portKey(a), `${a.device} #${a.deviceNum} ${a.zoneAddress}`);
    } else if ((a.additionalCircuitNumbers ?? []).some((v) => sameGroup(ccoLightingCircuit(circuits, v)))) {
      extraSourceIds.add(a.id);
      moved.set(portKey(a), `${a.device} #${a.deviceNum} ${a.zoneAddress}`);
    }
  }
  const seenCleared = new Set<string>();
  const next: DeviceAssignment[] = [];
  for (const a of assignments) {
    if (sourcePorts.has(portKey(a))) {
      if (!seenCleared.has(portKey(a))) { next.push(clearLightingAssignment(a)); seenCleared.add(portKey(a)); }
      continue;
    }
    if (a.id === targetId) {
      const updated: DeviceAssignment = extraIndex === undefined
        ? { ...a, circuitNumber: value, detail: sourceDetail || (a.circuitNumber === value ? a.detail : "") || circuit.detail, area: circuit.area, group: "" }
        : { ...a, additionalCircuitNumbers: extras };
      if (extraIndex === undefined && updated.additionalCircuitNumbers) {
        updated.additionalCircuitNumbers = updated.additionalCircuitNumbers.filter((v) => !sameGroup(ccoLightingCircuit(circuits, v)));
        if (!updated.additionalCircuitNumbers.length) { delete updated.additionalCircuitNumbers; delete updated.zoneDetail; }
      }
      next.push(updated);
    } else if (extraSourceIds.has(a.id)) {
      const remaining = (a.additionalCircuitNumbers ?? []).filter((v) => {
        const candidate = ccoLightingCircuit(circuits, v);
        return !candidate || (candidate.circuitGroupId || candidate.id) !== (circuit.circuitGroupId || circuit.id);
      });
      const updated: DeviceAssignment = { ...a, additionalCircuitNumbers: remaining };
      if (!remaining.length) { delete updated.additionalCircuitNumbers; delete updated.zoneDetail; }
      next.push(updated);
    } else next.push(a);
  }
  return { next, movedFrom: [...moved.values()] };
}
