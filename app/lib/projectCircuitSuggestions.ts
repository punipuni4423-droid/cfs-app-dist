import type { DeviceAssignment, ProjectData, RoomType } from "../types";
import { RESERVED_VALUE } from "./constants";

export type SuggestionOption = string | {
  value: string;
  label: string;
};

export interface ProjectCircuitSuggestions {
  detailByArea: ReadonlyMap<string, SuggestionOption[]>;
  dryContactByArea: ReadonlyMap<string, SuggestionOption[]>;
}

interface CandidateRecord {
  value: string;
  fragments: Set<string>;
}

type CandidateBucket = Map<string, Map<string, CandidateRecord>>;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isReservedLike(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === RESERVED_VALUE.toLowerCase();
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function addCandidate(
  bucket: CandidateBucket,
  area: string,
  value: string,
  fragments: readonly string[],
): void {
  const normalizedArea = clean(area);
  const normalizedValue = clean(value);
  if (isReservedLike(normalizedValue)) return;

  const areaMap = bucket.get(normalizedArea) ?? new Map<string, CandidateRecord>();
  const key = normalizedValue.toLowerCase();
  const record = areaMap.get(key) ?? {
    value: normalizedValue,
    fragments: new Set<string>(),
  };
  for (const fragment of fragments) {
    const text = clean(fragment);
    if (text && !isReservedLike(text) && text !== normalizedValue) record.fragments.add(text);
  }
  areaMap.set(key, record);
  bucket.set(normalizedArea, areaMap);
}

function toOptions(bucket: CandidateBucket): ReadonlyMap<string, SuggestionOption[]> {
  const result = new Map<string, SuggestionOption[]>();
  for (const [area, values] of bucket.entries()) {
    const options = Array.from(values.values())
      .sort((a, b) => naturalCompare(a.value, b.value))
      .map((record) => {
        const fragments = Array.from(record.fragments)
          .sort(naturalCompare)
          .slice(0, 4);
        if (fragments.length === 0) return record.value;
        return {
          value: record.value,
          label: `${record.value} - ${fragments.join(" / ")}`,
        };
      });
    result.set(area, options);
  }
  return result;
}

function areaName(project: ProjectData, areaId: string): string {
  if (!areaId) return "";
  return project.locations.find((location) => location.id === areaId)?.name ?? areaId;
}

function isCcoAssignment(assignment: DeviceAssignment): boolean {
  return /^CCO\d*$/i.test(clean(assignment.zoneAddress));
}

function addDryContact(
  project: ProjectData,
  bucket: CandidateBucket,
  roomType: RoomType,
  area: string,
  circuit: string,
  detail: string,
): void {
  addCandidate(bucket, area, circuit, [
    areaName(project, area),
    detail,
    roomType.name,
  ]);
}

export function buildProjectCircuitSuggestions(project: ProjectData): ProjectCircuitSuggestions {
  const detailBucket: CandidateBucket = new Map();
  const dryContactBucket: CandidateBucket = new Map();

  for (const circuit of project.circuits) {
    addCandidate(detailBucket, circuit.area, circuit.detail, []);
  }

  for (const roomType of project.roomTypes) {
    for (const dryContact of roomType.dryContacts ?? []) {
      addDryContact(project, dryContactBucket, roomType, dryContact.area, dryContact.circuit, dryContact.detail);
    }
    for (const assignment of roomType.deviceAssignments) {
      if (!isCcoAssignment(assignment)) continue;
      addDryContact(
        project,
        dryContactBucket,
        roomType,
        clean(assignment.area),
        assignment.circuitNumber,
        assignment.detail,
      );
    }
  }

  return {
    detailByArea: toOptions(detailBucket),
    dryContactByArea: toOptions(dryContactBucket),
  };
}

export function suggestionOptionsForArea(
  optionsByArea: ReadonlyMap<string, SuggestionOption[]>,
  area: string,
): readonly SuggestionOption[] {
  const normalizedArea = clean(area);
  if (!normalizedArea) return [];
  return optionsByArea.get(normalizedArea) ?? [];
}
