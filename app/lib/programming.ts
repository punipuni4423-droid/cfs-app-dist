import type { CircuitEntry, DeviceAssignment, LocationMaster } from "../types";

const FALLBACK_AREA_CODE = "AR";
const AREA_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function normalizeAreaCode(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 2);
}

export function deriveAreaCode(name: string): string {
  const normalized = normalizeAreaCode(name);
  if (normalized.length >= 2) return normalized;
  if (normalized.length === 1) return `${normalized}A`;
  return FALLBACK_AREA_CODE;
}

function uniquePush(values: string[], seen: Set<string>, value: string): void {
  const normalized = normalizeAreaCode(value);
  if (normalized.length !== 2 || seen.has(normalized)) return;
  seen.add(normalized);
  values.push(normalized);
}

function areaCodeCandidates(label: string): string[] {
  const text = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const first = text[0] || FALLBACK_AREA_CODE[0];
  const values: string[] = [];
  const seen = new Set<string>();

  uniquePush(values, seen, deriveAreaCode(label));
  for (let index = 1; index < text.length; index += 1) {
    uniquePush(values, seen, `${first}${text[index]}`);
  }
  for (let index = 0; index < text.length - 1; index += 1) {
    uniquePush(values, seen, text.slice(index, index + 2));
  }
  for (let index = 1; index <= 9; index += 1) {
    uniquePush(values, seen, `${first}${index}`);
  }
  for (const char of AREA_CODE_CHARS) {
    uniquePush(values, seen, `${first}${char}`);
  }
  for (const char of AREA_CODE_CHARS) {
    for (let index = 1; index <= 9; index += 1) {
      uniquePush(values, seen, `${char}${index}`);
    }
  }
  return values;
}

export function nextUniqueAreaCode(label: string, usedCodes: ReadonlySet<string>): string {
  const used = new Set(Array.from(usedCodes, normalizeAreaCode).filter((code) => code.length === 2));
  for (const candidate of areaCodeCandidates(label)) {
    if (!used.has(candidate)) return candidate;
  }
  return FALLBACK_AREA_CODE;
}

export function buildAreaCodeMap(locations: readonly LocationMaster[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  locations.forEach((location, index) => {
    const source = location.code.trim() || location.name.trim() || `Area ${index + 1}`;
    const code = nextUniqueAreaCode(source, used);
    used.add(code);
    map.set(location.id, code);
  });
  return map;
}

function numericPrefix(value: string): number {
  const normalized = value.trim();
  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) return Number.POSITIVE_INFINITY;
  return Number.parseFloat(match[0]);
}

function naturalCompare(a: string, b: string): number {
  const numberCompare = numericPrefix(a) - numericPrefix(b);
  if (numberCompare !== 0) return numberCompare;
  return a.localeCompare(b, "en", { numeric: true });
}

function normalizeDetailMatch(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function assignmentAddressIndex(assignment: DeviceAssignment): number | null {
  const match = assignment.zoneAddress.trim().match(/\d+/);
  if (!match) return null;
  const index = Number.parseInt(match[0], 10) - 1;
  return Number.isFinite(index) && index >= 0 ? index : null;
}

function displayCircuitsForAssignment(circuits: readonly CircuitEntry[], assignment: DeviceAssignment): CircuitEntry[] {
  const detail = assignment.detail.trim();
  if (detail && circuits[0]) {
    const normalizedDetail = normalizeDetailMatch(detail);
    const detailMatch = circuits.find((circuit) => normalizeDetailMatch(circuit.detail) === normalizedDetail);
    if (detailMatch) return [detailMatch];
    const addressIndex = assignmentAddressIndex(assignment);
    if (addressIndex !== null && circuits[addressIndex]) return [circuits[addressIndex]];
    return [circuits[0]];
  }
  const seen = new Set<string>();
  const result: CircuitEntry[] = [];
  for (const circuit of circuits) {
    const key = circuit.circuitGroupId || circuit.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(circuit);
  }
  return result;
}

export function areaAddressAssignmentKey(assignmentId: string, circuitId: string): string {
  return `${assignmentId}\u0000${circuitId}`;
}

export function buildAreaAddressAssignmentMap(
  assignments: readonly DeviceAssignment[],
  circuits: readonly CircuitEntry[],
  locations: readonly LocationMaster[],
): Map<string, string> {
  const codeByLocationId = buildAreaCodeMap(locations);
  const locationOrder = new Map(locations.map((location, index) => [location.id, index]));
  const circuitByDesignerNumber = new Map<string, CircuitEntry[]>();
  for (const circuit of circuits) {
    const key = circuit.designerNumber.trim();
    if (!key) continue;
    circuitByDesignerNumber.set(key, [...(circuitByDesignerNumber.get(key) ?? []), circuit]);
  }
  const assignmentOrder = new Map(assignments.map((assignment, index) => [assignment.id, index]));
  const sorted = assignments
    .flatMap((assignment) => {
      const assigned = assignment.circuitNumber.trim();
      if (!assigned || assigned === "Reserved") return [];
      return displayCircuitsForAssignment(circuitByDesignerNumber.get(assigned) ?? [], assignment).map((circuit) => ({
        assignment,
        circuit,
      }));
    })
    .filter(({ circuit }) => circuit.area.trim())
    .slice()
    .sort((a, b) => {
      const aOrder = locationOrder.get(a.circuit.area) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = locationOrder.get(b.circuit.area) ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      const designerCompare = naturalCompare(a.circuit.designerNumber, b.circuit.designerNumber);
      if (designerCompare !== 0) return designerCompare;
      const internalCompare = naturalCompare(a.circuit.internalNumber, b.circuit.internalNumber);
      if (internalCompare !== 0) return internalCompare;
      const assignmentCompare =
        (assignmentOrder.get(a.assignment.id) ?? Number.MAX_SAFE_INTEGER) -
        (assignmentOrder.get(b.assignment.id) ?? Number.MAX_SAFE_INTEGER);
      if (assignmentCompare !== 0) return assignmentCompare;
      const groupCompare = naturalCompare(a.assignment.group, b.assignment.group);
      if (groupCompare !== 0) return groupCompare;
      const zoneCompare = naturalCompare(a.assignment.zoneAddress, b.assignment.zoneAddress);
      if (zoneCompare !== 0) return zoneCompare;
      const detailCompare = a.circuit.detail.localeCompare(b.circuit.detail, "en", { numeric: true });
      if (detailCompare !== 0) return detailCompare;
      return areaAddressAssignmentKey(a.assignment.id, a.circuit.id).localeCompare(
        areaAddressAssignmentKey(b.assignment.id, b.circuit.id),
      );
    });

  const nextByAreaId = new Map<string, number>();
  const usedAddresses = new Set<string>();
  const result = new Map<string, string>();
  for (const { assignment, circuit } of sorted) {
    const code = codeByLocationId.get(circuit.area) ?? FALLBACK_AREA_CODE;
    let next = nextByAreaId.get(circuit.area) ?? 1;
    let address = `${code}${next}`;
    while (usedAddresses.has(address)) {
      next += 1;
      address = `${code}${next}`;
    }
    nextByAreaId.set(circuit.area, next + 1);
    usedAddresses.add(address);
    result.set(areaAddressAssignmentKey(assignment.id, circuit.id), address);
  }
  return result;
}

export function normalizeProgrammingToken(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}
