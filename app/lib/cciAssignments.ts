import type { DeviceAssignment, SwitchEntry } from "../types";

const RESERVED_VALUE = "Reserved";

export interface CciAssignmentOption {
  value: string;
  deviceKey: string;
  address: string;
  assigned: string;
  label: string;
  detail: string;
}

function normalizeCciAddress(value: string): string {
  return value.replace(/^\d+-/, "").trim();
}

export function cciCombinedLabel(option: CciAssignmentOption): string {
  return `${option.assigned} ${option.detail}`.trim();
}

export function splitSwitchNumberAndName(value: string, detail = ""): { switchNumber: string; switchName: string } {
  const source = value.trim();
  const currentDetail = detail.trim();
  if (!source) return { switchNumber: "", switchName: currentDetail };
  const match = source.match(/^((?:SW|S|W)[-\s]?\d+[A-Z0-9-]*)\s+(.+)$/i);
  if (match) return { switchNumber: match[1].trim(), switchName: match[2].trim() };
  return { switchNumber: source, switchName: currentDetail || source };
}

export function buildCciAssignmentOptions(deviceAssignments: readonly DeviceAssignment[]): CciAssignmentOption[] {
  const options: CciAssignmentOption[] = [];
  const seen = new Set<string>();
  for (const assignment of deviceAssignments) {
    const address = normalizeCciAddress(assignment.zoneAddress);
    const isCci = /^CCI/i.test(address);
    const assigned = assignment.circuitNumber.trim();
    if (!isCci || !assigned || assigned === RESERVED_VALUE) continue;

    const deviceKey = `${assignment.device || "Input"} #${assignment.deviceNum || "-"}`;
    const value = `${deviceKey} ${address}`;
    if (seen.has(value)) continue;
    seen.add(value);

    const split = splitSwitchNumberAndName(assigned, assignment.detail);
    options.push({
      value,
      deviceKey,
      address,
      assigned: split.switchNumber,
      label: address,
      detail: split.switchName,
    });
  }
  return options;
}

export function findContactCciOption(
  sw: SwitchEntry,
  options: readonly CciAssignmentOption[],
): CciAssignmentOption | undefined {
  return options.find(
    (option) =>
      (sw.cciAssignment === "" || option.deviceKey === sw.cciAssignment) &&
      (option.address === sw.allocation ||
        option.address === sw.switchNumber ||
        option.value === sw.switchNumber ||
        cciCombinedLabel(option) === sw.switchNumber),
  ) ?? options.find(
    (option) =>
      (sw.cciAssignment === "" || option.deviceKey === sw.cciAssignment) &&
      (option.assigned === sw.switchNumber ||
        cciCombinedLabel(option) === sw.switchNumber ||
        cciCombinedLabel(option) === `${sw.switchNumber} ${sw.switchName}`.trim()),
  );
}

export function syncContactSwitchesWithCciOptions(
  switches: SwitchEntry[],
  options: readonly CciAssignmentOption[],
): SwitchEntry[] {
  if (options.length === 0) return switches;

  let changed = false;
  const next = switches.map((sw) => {
    if (sw.kind !== "contact") return sw;
    const selected = findContactCciOption(sw, options);
    if (!selected) return sw;
    const needsUpdate =
      sw.cciAssignment !== selected.deviceKey ||
      sw.allocation !== selected.address ||
      sw.switchNumber !== selected.assigned ||
      sw.switchName !== selected.detail;
    if (!needsUpdate) return sw;
    changed = true;
    return {
      ...sw,
      cciAssignment: selected.deviceKey,
      allocation: selected.address,
      switchNumber: selected.assigned,
      switchName: selected.detail,
    };
  });

  return changed ? next : switches;
}

export function syncContactSwitchesWithCciAssignments(
  switches: SwitchEntry[],
  deviceAssignments: readonly DeviceAssignment[],
): SwitchEntry[] {
  return syncContactSwitchesWithCciOptions(switches, buildCciAssignmentOptions(deviceAssignments));
}
