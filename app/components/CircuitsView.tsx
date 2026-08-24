"use client";

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CircuitEntry, DryContactEntry, FixtureMaster, LocationMaster, RevisionFieldChanges } from "../types";
import {
  CIRCUIT_PCS_OPTIONS,
  DIMMING_TYPE_OPTIONS,
  calcFixtureVa,
  createEmptyCircuitEntry,
  createEmptyDryContactEntry,
} from "../lib/constants";
import {
  circuitCsvSignature,
  circuitsToCsv,
  csvToCircuits,
  downloadCsv,
  readCsvFileText,
  uniqueByCsvSignature,
} from "../lib/csv";
import {
  suggestionOptionsForArea,
  type ProjectCircuitSuggestions,
  type SuggestionOption,
} from "../lib/projectCircuitSuggestions";
import { useDragReorder } from "../lib/useDragReorder";
import { buildCircuitRunInfo } from "../lib/circuitRunInfo";
import { circuitGroupKey } from "../lib/circuitGroups";
import AutoGrowTextarea from "./AutoGrowTextarea";
import Combobox from "./Combobox";
import ActionIconButton from "./ActionIconButton";
import DuplicationBanner from "./DuplicationBanner";
import ResizableMatrixScroll from "./ResizableMatrixScroll";
import { createAppId } from '../lib/id';

interface CircuitsViewProps {
  circuits: CircuitEntry[];
  dryContacts: DryContactEntry[];
  fixtures: FixtureMaster[];
  locations: LocationMaster[];
  onChange: (next: CircuitEntry[]) => void;
  onDryContactsChange: (next: DryContactEntry[]) => void;
  revisionChanges?: RevisionFieldChanges;
  dryContactRevisionChanges?: RevisionFieldChanges;
  suggestions?: ProjectCircuitSuggestions;
  canEdit?: boolean;
}

const COL_COUNT = 15;
const DRY_CONTACT_COL_COUNT = 6;
const MAX_IMPORT_FILE_SIZE = 5 * 1024 * 1024;
const CIRCUIT_COLUMN_WIDTHS = [36, 44, 130, 100, 120, 140, 44, 150, 86, 70, 80, 60, 80, 200, 96] as const;
type CircuitViewMode = "lighting" | "dryContact";
const EMPTY_SUGGESTIONS: readonly SuggestionOption[] = [];

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function isDaliCircuit(circuit: CircuitEntry): boolean {
  return circuit.dimmingType === "DALI";
}

function daliFixtureKey(circuit: CircuitEntry): string {
  return circuit.daliFixtureGroupId || circuit.id;
}

export default function CircuitsView({
  circuits,
  dryContacts,
  fixtures,
  locations,
  onChange,
  onDryContactsChange,
  revisionChanges = {},
  dryContactRevisionChanges = {},
  suggestions,
  canEdit = true,
}: CircuitsViewProps) {
  const [circuitViewMode, setCircuitViewMode] = useState<CircuitViewMode>("lighting");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollPosRef = useRef<number | null>(null);
  const canEditRef = useRef(canEdit);

  useEffect(() => {
    canEditRef.current = canEdit;
  }, [canEdit]);

  function commitCircuits(next: CircuitEntry[]): void {
    if (!canEditRef.current) return;
    onChange(next);
  }

  function commitDryContacts(next: DryContactEntry[]): void {
    if (!canEditRef.current) return;
    onDryContactsChange(next);
  }

  const drag = useDragReorder(circuits, commitCircuits, (c) => c.id, circuitGroupKey);
  const dryContactDrag = useDragReorder(dryContacts, commitDryContacts, (entry) => entry.id);

  function hasRevisionChange(id: string, fields?: string[]): boolean {
    const changed = revisionChanges[id];
    if (!changed) return false;
    if (!fields) return changed.length > 0;
    return fields.some((field) => changed.includes(field));
  }

  function revisionCellClass(id: string, fields?: string[]): string {
    return hasRevisionChange(id, fields) ? "revision-changed-cell" : "";
  }

  function hasDryContactRevisionChange(id: string, fields?: string[]): boolean {
    const changed = dryContactRevisionChanges[id];
    if (!changed) return false;
    if (!fields) return changed.length > 0;
    return fields.some((field) => changed.includes(field));
  }

  function dryContactRevisionCellClass(id: string, fields?: string[]): string {
    return hasDryContactRevisionChange(id, fields) ? "revision-changed-cell" : "";
  }

  function detailOptionsForArea(area: string): readonly SuggestionOption[] {
    return suggestions ? suggestionOptionsForArea(suggestions.detailByArea, area) : EMPTY_SUGGESTIONS;
  }

  function dryContactOptionsForArea(area: string): readonly SuggestionOption[] {
    return suggestions ? suggestionOptionsForArea(suggestions.dryContactByArea, area) : EMPTY_SUGGESTIONS;
  }

  // R17-style scroll preservation across collapse toggles (two-stage RAF).
  useLayoutEffect(() => {
    if (scrollPosRef.current === null) return;
    const target = scrollPosRef.current;
    scrollPosRef.current = null;
    window.scrollTo({ top: target, behavior: "auto" });
    requestAnimationFrame(() => {
      window.scrollTo({ top: target, behavior: "auto" });
      requestAnimationFrame(() => {
        window.scrollTo({ top: target, behavior: "auto" });
      });
    });
  }, [collapsedGroups]);

  // Distinct group ids in display order.
  const groupOrder = useMemo(() => {
    const seen: string[] = [];
    for (const c of circuits) {
      const key = circuitGroupKey(c);
      if (!seen.includes(key)) seen.push(key);
    }
    return seen;
  }, [circuits]);

  // First-row id per group (used to detect group head).
  const firstRowIdByGroup = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of circuits) {
      const key = circuitGroupKey(c);
      if (!map.has(key)) map.set(key, c.id);
    }
    return map;
  }, [circuits]);

  function isFirstOfGroup(c: CircuitEntry): boolean {
    return firstRowIdByGroup.get(circuitGroupKey(c)) === c.id;
  }

  function isIndirectFixture(fixtureName: string): boolean {
    return (
      fixtures.find((fixture) => fixture.fixture === fixtureName)?.fixtureType ===
      "Indirect"
    );
  }

  function fixtureType(fixtureName: string): string {
    return fixtures.find((fixture) => fixture.fixture === fixtureName)?.fixtureType ?? "";
  }

  function normalizePcsInput(fixtureName: string, value: string): string {
    if (isIndirectFixture(fixtureName)) return value;
    if (value.trim() === "") return "";
    const parsed = parsePositiveInt(value);
    return String(parsed);
  }

  function formatPcsStepValue(value: number, indirect: boolean): string {
    const safeValue = Math.max(indirect ? 0.1 : 1, value);
    if (!indirect) return String(Math.max(1, Math.round(safeValue)));
    const rounded = Math.round(safeValue * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  function stepPcs(id: string, delta: number): void {
    const target = circuits.find((c) => c.id === id);
    if (!target) return;
    const indirect = isIndirectFixture(target.fixture);
    const current = Number.parseFloat(target.pcs || "1");
    const base = Number.isFinite(current) ? current : 1;
    update(id, "pcs", formatPcsStepValue(base + delta, indirect));
  }

  function getGroupNo(groupId: string): number {
    return groupOrder.indexOf(groupId) + 1;
  }

  function isCollapsed(groupId: string): boolean {
    return collapsedGroups.has(groupId);
  }

  // R11 + R13/R14: target update + propagation + fixture→pcs auto-fill.
  function update(
    id: string,
    field: keyof Omit<CircuitEntry, "id" | "circuitGroupId">,
    value: string,
  ): void {
    const target = circuits.find((c) => c.id === id);
    if (!target) return;
    const effectiveValue =
      field === "pcs" ? normalizePcsInput(target.fixture, value) : value;
    // Group-level fields propagate to the entire circuit group. One circuit
    // (Designer #) carries exactly one Designer #, Internal #, Dimming Type,
    // Area, FFE, Energy Save, and Detail (2026-08-24).
    const propagateToGroup =
      (field === "designerNumber" ||
        field === "internalNumber" ||
        field === "dimmingType" ||
        field === "area" ||
        field === "detail") &&
      target.circuitGroupId.trim() !== "";
    const targetGroupKey = circuitGroupKey(target);
    const targetDaliFixtureKey = daliFixtureKey(target);
    const propagateToDaliFixtureBlock =
      isDaliCircuit(target) &&
      (field === "fixture" || field === "ffe" || field === "energySaving") &&
      targetDaliFixtureKey !== "";

    let next = circuits.map((c) => {
        const isTarget = c.id === id;
        const isInGroup =
          propagateToGroup && circuitGroupKey(c) === targetGroupKey;
        const isInDaliFixtureBlock =
          propagateToDaliFixtureBlock && daliFixtureKey(c) === targetDaliFixtureKey;
        if (!isTarget && !isInGroup && !isInDaliFixtureBlock) return c;
        const updated = { ...c, [field]: effectiveValue };
        // R11: when fixture is set on the target row and pcs is empty, default pcs to "1".
        if (isTarget && field === "fixture" && effectiveValue !== "" && c.pcs.trim() === "") {
          updated.pcs = "1";
        } else if (isTarget && field === "fixture" && !isIndirectFixture(effectiveValue)) {
          updated.pcs = normalizePcsInput(effectiveValue, c.pcs);
        }
        return updated;
      });

    if (field === "pcs") {
      const updatedTarget = next.find((c) => c.id === id) ?? target;
      if (updatedTarget.dimmingType === "DALI" && !isIndirectFixture(updatedTarget.fixture)) {
        next = syncDaliFixtureRows(next, updatedTarget, parsePositiveInt(value), id);
      }
    }

    if (field === "dimmingType" && effectiveValue === "DALI") {
      const converted = next.find((c) => c.id === id) ?? target;
      next = isIndirectFixture(converted.fixture)
        ? collapseDaliFixtureRows(next, converted, id)
        : syncDaliFixtureRows(
            next,
            converted,
            parsePositiveInt(converted.pcs || target.pcs),
            id,
          );
    }

    if (field === "fixture") {
      const updatedTarget = next.find((c) => c.id === id) ?? target;
      if (updatedTarget.dimmingType === "DALI") {
        next = isIndirectFixture(effectiveValue)
          ? collapseDaliFixtureRows(next, updatedTarget, id)
          : syncDaliFixtureRows(
              next,
              updatedTarget,
              parsePositiveInt(updatedTarget.pcs || target.pcs),
              id,
            );
      }
    }

    commitCircuits(next);
  }

  function collapseDaliFixtureRows(
    list: CircuitEntry[],
    source: CircuitEntry,
    sourceId: string,
  ): CircuitEntry[] {
    const groupId = source.circuitGroupId;
    if (!groupId) return list;
    const sourceInList = list.find((c) => c.id === sourceId) ?? source;
    const blockId = sourceInList.daliFixtureGroupId || createAppId();
    let inserted = false;
    const collapsedRow: CircuitEntry = {
      ...sourceInList,
      circuitGroupId: groupId,
      daliFixtureGroupId: blockId,
      pcs: isIndirectFixture(sourceInList.fixture)
        ? sourceInList.pcs
        : sourceInList.pcs.trim() || "1",
    };
    const result: CircuitEntry[] = [];
    for (const row of list) {
      const isBlockRow =
        row.id === sourceId ||
        (row.daliFixtureGroupId !== "" && row.daliFixtureGroupId === blockId);
      if (!isBlockRow) {
        result.push(row);
        continue;
      }
      if (!inserted) {
        result.push(collapsedRow);
        inserted = true;
      }
    }
    return result;
  }

  function updateBoolean(
    id: string,
    field: 'ffe' | 'energySaving',
    value: boolean,
  ): void {
    const target = circuits.find((c) => c.id === id);
    if (!target) return;
    const targetGroupKey = circuitGroupKey(target);
    commitCircuits(
      circuits.map((c) => {
        const shouldUpdate =
          c.id === id ||
          (target.circuitGroupId.trim() !== "" && circuitGroupKey(c) === targetGroupKey) ||
          (isDaliCircuit(target) &&
            target.daliFixtureGroupId !== "" &&
            c.daliFixtureGroupId === target.daliFixtureGroupId);
        return shouldUpdate ? { ...c, [field]: value } : c;
      }),
    );
  }

  function syncDaliFixtureRows(
    list: CircuitEntry[],
    source: CircuitEntry,
    desiredCount: number,
    sourceId: string,
  ): CircuitEntry[] {
    const groupId = source.circuitGroupId;
    if (!groupId) return list;
    const sourceInList = list.find((c) => c.id === sourceId) ?? source;
    const blockId = sourceInList.daliFixtureGroupId || createAppId();
    const groupRows = list.filter((c) => {
      if (c.id === sourceId) return true;
      return c.daliFixtureGroupId !== "" && c.daliFixtureGroupId === blockId;
    });
    if (groupRows.length === 0) return list;
    const count = Math.max(desiredCount, 1);
    const normalizedRows: CircuitEntry[] = Array.from({ length: count }, (_, index) => {
      const existing = groupRows[index];
      const base = existing ?? sourceInList;
      return {
        ...base,
        id: existing?.id ?? createAppId(),
        circuitGroupId: groupId,
        daliFixtureGroupId: blockId,
        designerNumber: sourceInList.designerNumber,
        internalNumber: sourceInList.internalNumber,
        dimmingType: "DALI",
        area: sourceInList.area,
        fixture: sourceInList.fixture,
        pcs: index === 0 ? String(count) : "",
        detail: sourceInList.detail,
        ffe: sourceInList.ffe,
        energySaving: sourceInList.energySaving,
      };
    });

    const result: CircuitEntry[] = [];
    let inserted = false;
    for (const row of list) {
      const isBlockRow =
        row.id === sourceId ||
        (row.daliFixtureGroupId !== "" && row.daliFixtureGroupId === blockId);
      if (!isBlockRow) {
        result.push(row);
        continue;
      }
      if (!inserted) {
        result.push(...normalizedRows);
        inserted = true;
      }
    }
    return result;
  }

  function addRow(): void {
    // New group: createEmptyCircuitEntry generates a fresh circuitGroupId.
    commitCircuits([...circuits, createEmptyCircuitEntry()]);
  }

  function handleImportFile(file: File): void {
    if (!canEdit) return;
    if (file.size > MAX_IMPORT_FILE_SIZE) {
      window.alert("CSV file must be 5MB or smaller.");
      return;
    }

    void (async () => {
      try {
        const parsed = await csvToCircuits(await readCsvFileText(file), locations);
        if (parsed.length === 0) {
          window.alert(
            "No valid circuit rows were found. Supported columns include Designer #, Code, Fixture, Qty, Dimming Type, Area, and Detail.",
          );
          return;
        }
        const unique = uniqueByCsvSignature(circuits, parsed, circuitCsvSignature);
        const append = window.confirm(
          `${parsed.length} circuit rows were found.` +
            (unique.skipped > 0 ? `\n${unique.skipped} matching rows will be skipped when appending.` : "") +
            "\n\nOK: append to the current circuit list\n" +
            "Cancel: replace the current circuit list",
        );
        if (!append) {
          commitCircuits(parsed);
          return;
        }
        if (unique.added.length === 0) {
          window.alert("No new circuit rows were imported because every row already exists.");
          return;
        }
        commitCircuits([...circuits, ...unique.added]);
        if (unique.skipped > 0) {
          window.alert(`${unique.added.length} new circuit rows were imported. ${unique.skipped} matching rows were skipped.`);
        }
      } catch (error) {
        window.alert("Failed to parse circuit CSV: " + String(error));
      }
    })();
  }

  function handleExport(): void {
    downloadCsv("circuits.csv", circuitsToCsv(circuits, locations));
  }

  function addDryContactRow(): void {
    commitDryContacts([...dryContacts, createEmptyDryContactEntry()]);
  }

  function updateDryContact(
    id: string,
    field: keyof Omit<DryContactEntry, "id">,
    value: string,
  ): void {
    commitDryContacts(
      dryContacts.map((entry) =>
        entry.id === id ? { ...entry, [field]: value } : entry,
      ),
    );
  }

  function copyDryContact(id: string): void {
    const index = dryContacts.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const source = dryContacts[index];
    const copied: DryContactEntry = {
      ...source,
      id: createAppId(),
      circuit: source.circuit.trim() ? `${source.circuit} Copy` : "",
    };
    commitDryContacts([
      ...dryContacts.slice(0, index + 1),
      copied,
      ...dryContacts.slice(index + 1),
    ]);
  }

  function removeDryContact(id: string): void {
    commitDryContacts(dryContacts.filter((entry) => entry.id !== id));
  }

  // R13: insert new row in the SAME group as target, inheriting designer/internal numbers.
  function addBelow(targetId: string): void {
    const target = circuits.find((c) => c.id === targetId);
    if (!target) return;
    if (isDaliCircuit(target)) {
      addDaliFixtureBlock(target);
      return;
    }
    const newRow = createEmptyCircuitEntry(
      target.designerNumber,
      target.circuitGroupId,
    );
    newRow.internalNumber = target.internalNumber;
    newRow.dimmingType = target.dimmingType;
    newRow.area = target.area;
    newRow.detail = target.detail;
    newRow.ffe = target.ffe;
    newRow.energySaving = target.energySaving;
    // Insert at end of the same group.
    let lastIdxInGroup = -1;
    const targetGroupKey = circuitGroupKey(target);
    for (let i = 0; i < circuits.length; i += 1) {
      if (circuitGroupKey(circuits[i]) === targetGroupKey) {
        lastIdxInGroup = i;
      }
    }
    const insertAt = lastIdxInGroup === -1 ? circuits.length : lastIdxInGroup + 1;
    commitCircuits([
      ...circuits.slice(0, insertAt),
      newRow,
      ...circuits.slice(insertAt),
    ]);
  }

  function copyGroup(targetId: string): void {
    const target = circuits.find((c) => c.id === targetId);
    if (!target) return;
    const targetGroupKey = circuitGroupKey(target);
    const sourceRows = circuits.filter((c) => circuitGroupKey(c) === targetGroupKey);
    if (sourceRows.length === 0) return;

    const newCircuitGroupId = createAppId();
    const daliFixtureGroupIds = new Map<string, string>();
    const copiedRows = sourceRows.map((row) => {
      let daliFixtureGroupId = "";
      if (row.daliFixtureGroupId) {
        const existing = daliFixtureGroupIds.get(row.daliFixtureGroupId);
        daliFixtureGroupId = existing ?? createAppId();
        if (!existing) daliFixtureGroupIds.set(row.daliFixtureGroupId, daliFixtureGroupId);
      }
      return {
        ...row,
        id: createAppId(),
        circuitGroupId: newCircuitGroupId,
        daliFixtureGroupId,
        designerNumber: row.designerNumber.trim() ? `${row.designerNumber} Copy` : "",
        internalNumber: "",
      };
    });

    const lastSourceIndex = circuits.reduce(
      (lastIndex, row, index) =>
        circuitGroupKey(row) === targetGroupKey ? index : lastIndex,
      -1,
    );
    const insertAt = lastSourceIndex === -1 ? circuits.length : lastSourceIndex + 1;
    commitCircuits([
      ...circuits.slice(0, insertAt),
      ...copiedRows,
      ...circuits.slice(insertAt),
    ]);
  }

  function remove(id: string): void {
    const target = circuits.find((c) => c.id === id);
    const filtered = circuits.filter((c) => c.id !== id);
    if (!target || target.dimmingType !== "DALI" || !target.daliFixtureGroupId) {
      commitCircuits(filtered);
      return;
    }

    const remainingBlockRows = filtered.filter((c) => c.daliFixtureGroupId === target.daliFixtureGroupId);
    if (remainingBlockRows.length === 0) {
      commitCircuits(filtered);
      return;
    }

    let firstSeen = false;
    commitCircuits(
      filtered.map((c) => {
        if (c.daliFixtureGroupId !== target.daliFixtureGroupId) return c;
        if (!firstSeen) {
          firstSeen = true;
          return { ...c, pcs: String(remainingBlockRows.length) };
        }
        return { ...c, pcs: "" };
      }),
    );
  }

  function toggleCollapse(groupId: string): void {
    scrollPosRef.current = window.scrollY;
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function calcVA(c: CircuitEntry): string {
    const fx = fixtures.find((f) => f.fixture === c.fixture);
    if (!fx) return "";
    return calcFixtureVa(c.pcs, fx);
  }

  function addDaliFixtureBlock(target: CircuitEntry): void {
    const newRow = createEmptyCircuitEntry(target.designerNumber, target.circuitGroupId);
    newRow.internalNumber = target.internalNumber;
    newRow.dimmingType = "DALI";
    newRow.area = target.area;
    newRow.daliFixtureGroupId = createAppId();
    newRow.pcs = "1";

    let insertAt = circuits.findIndex((c) => c.id === target.id);
    if (insertAt === -1) insertAt = circuits.length - 1;
    const targetBlock = daliFixtureKey(target);
    const targetGroupKey = circuitGroupKey(target);
    for (let i = insertAt; i < circuits.length; i += 1) {
      if (circuitGroupKey(circuits[i]) !== targetGroupKey) break;
      if (daliFixtureKey(circuits[i]) === targetBlock) insertAt = i;
    }

    commitCircuits([
      ...circuits.slice(0, insertAt + 1),
      newRow,
      ...circuits.slice(insertAt + 1),
    ]);
  }

  // Visible rows: hide non-first rows of collapsed groups.
  const visibleCircuits = useMemo(() => {
    return circuits.filter((c) => {
      if (isFirstOfGroup(c)) return true;
      return !isCollapsed(circuitGroupKey(c));
    });
    // isFirstOfGroup / isCollapsed depend on circuits + collapsedGroups
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circuits, collapsedGroups, firstRowIdByGroup]);

  const groupHeadByGroup = useMemo(() => {
    const map = new Map<string, CircuitEntry>();
    for (const c of circuits) {
      const key = circuitGroupKey(c);
      if (!map.has(key)) map.set(key, c);
    }
    return map;
  }, [circuits]);

  // R20: per-group total VA across ALL rows of the group (not affected by collapse).
  const groupTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of circuits) {
      const v = Number.parseFloat(calcVA(c));
      if (Number.isFinite(v)) {
        const key = circuitGroupKey(c);
        map.set(key, (map.get(key) ?? 0) + v);
      }
    }
    return map;
    // calcVA depends on fixtures
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circuits, fixtures]);

  const circuitRunInfo = useMemo(() => buildCircuitRunInfo(visibleCircuits), [visibleCircuits]);

  const daliFixtureBlockInfo = useMemo(() => {
    const map = new Map<string, { isFirst: boolean; rowSpan: number }>();
    let index = 0;
    while (index < visibleCircuits.length) {
      const circuit = visibleCircuits[index];
      if (!isDaliCircuit(circuit)) {
        index += 1;
        continue;
      }
      const key = `${circuitGroupKey(circuit)}::${daliFixtureKey(circuit)}`;
      let end = index + 1;
      while (
        end < visibleCircuits.length &&
        isDaliCircuit(visibleCircuits[end]) &&
        `${circuitGroupKey(visibleCircuits[end])}::${daliFixtureKey(visibleCircuits[end])}` === key
      ) {
        end += 1;
      }
      const rowSpan = end - index;
      for (let current = index; current < end; current += 1) {
        map.set(visibleCircuits[current].id, {
          isFirst: current === index,
          rowSpan,
        });
      }
      index = end;
    }
    return map;
  }, [visibleCircuits]);

  function formatTotal(n: number): string {
    if (!Number.isFinite(n)) return "";
    if (Number.isInteger(n)) return String(n);
    return (Math.round(n * 100) / 100).toString();
  }

  // R25: detect duplicates across groups (one representative per group).
  // The representative is the first-row's value. Within the same group the
  // value already propagates so same-group equality is by definition not a duplicate.
  const { dupDesigner, dupInternal } = useMemo(() => {
    const designerByGroup = new Map<string, string>();
    const internalByGroup = new Map<string, string>();
    for (const groupId of groupOrder) {
      const headId = firstRowIdByGroup.get(groupId);
      const head = circuits.find((c) => c.id === headId);
      if (!head) continue;
      const dn = head.designerNumber.trim();
      const inn = head.internalNumber.trim();
      if (dn) designerByGroup.set(groupId, dn);
      if (inn) internalByGroup.set(groupId, inn);
    }
    function findDups(map: Map<string, string>): Set<string> {
      const counts = new Map<string, number>();
      for (const v of map.values()) counts.set(v, (counts.get(v) ?? 0) + 1);
      const dup = new Set<string>();
      for (const [v, n] of counts) if (n > 1) dup.add(v);
      return dup;
    }
    return {
      dupDesigner: findDups(designerByGroup),
      dupInternal: findDups(internalByGroup),
    };
  }, [circuits, groupOrder, firstRowIdByGroup]);

  const designerBannerItems = useMemo(
    () =>
      Array.from(dupDesigner)
        .sort()
        .map((v) => `'${v}'  is used in multiple groups`),
    [dupDesigner],
  );
  const internalBannerItems = useMemo(
    () =>
      Array.from(dupInternal)
        .sort()
        .map((v) => `'${v}'  is used in multiple groups`),
    [dupInternal],
  );

  function isDesignerDup(c: CircuitEntry): boolean {
    const v = c.designerNumber.trim();
    return v !== "" && dupDesigner.has(v);
  }
  function isInternalDup(c: CircuitEntry): boolean {
    const v = c.internalNumber.trim();
    return v !== "" && dupInternal.has(v);
  }

  return (
    <section className="card card-padded fade-in">
      <div
        className="scene-area-bar"
        role="tablist"
        aria-label="Circuit mode"
        style={{ marginBottom: "0.75rem" }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={circuitViewMode === "lighting"}
          className={`scene-area-chip${circuitViewMode === "lighting" ? " scene-area-chip-active" : ""}`}
          onClick={() => setCircuitViewMode("lighting")}
        >
          Lighting
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={circuitViewMode === "dryContact"}
          className={`scene-area-chip${circuitViewMode === "dryContact" ? " scene-area-chip-active" : ""}`}
          onClick={() => setCircuitViewMode("dryContact")}
        >
          Dry Contact
        </button>
      </div>

      {circuitViewMode === "lighting" ? (
        <>
      <div className="toolbar">
        <button
          className="btn btn-secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={!canEdit}
        >
          CSV Import
        </button>
        <button className="btn btn-secondary" onClick={handleExport}>
          CSV Export
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportFile(file);
            e.target.value = "";
          }}
        />
        <span className="toolbar-spacer" />
        <span className="muted-pill" title="Drag handles to reorder">
          :: Drag to reorder
        </span>
      </div>

      <DuplicationBanner
        title="Duplicate Designer#"
        items={designerBannerItems}
      />
      <DuplicationBanner
        title="Duplicate Internal#"
        items={internalBannerItems}
      />

      <ResizableMatrixScroll className="table-workspace-scroll" variant="large">
        <table className="matrix-table master-table circuits-table lighting-circuits-table">
          <colgroup>
            {CIRCUIT_COLUMN_WIDTHS.map((width, index) => (
              <col key={index} style={{ width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="col-center" style={{ minWidth: 36 }} aria-label="Reorder" />
              <th className="col-center" style={{ minWidth: 44 }}>
                No
              </th>
              <th style={{ minWidth: 130 }}>Designer #</th>
              <th style={{ minWidth: 100 }}>Internal #</th>
              <th style={{ minWidth: 120 }}>Dimming Type</th>
              <th style={{ minWidth: 140 }}>Area</th>
              <th className="col-center" style={{ minWidth: 44 }}>
                +
              </th>
              <th style={{ minWidth: 150 }}>Fixture</th>
              <th style={{ minWidth: 70 }}>pcs.</th>
              <th style={{ minWidth: 70 }}>VA</th>
              <th style={{ minWidth: 80 }}>Total VA</th>
              <th className="col-center" style={{ minWidth: 60 }}>FFE</th>
              <th className="col-center" style={{ minWidth: 80 }}>Energy Save</th>
              <th style={{ minWidth: 200 }}>Detail</th>
              <th className="col-center" style={{ minWidth: 96 }}>
                Operation
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleCircuits.length === 0 ? (
              <tr>
                <td colSpan={COL_COUNT} className="screen-empty">
                  No circuits are registered yet. Add a row below.
                </td>
              </tr>
            ) : (
              visibleCircuits.map((c) => {
                const matched = fixtures.some((f) => f.fixture === c.fixture);
                const groupKey = circuitGroupKey(c);
                const isDragging = drag.draggingKey === groupKey;
                const runInfo = circuitRunInfo.get(c.id) ?? { isHead: true, isTail: true, rowSpan: 1 };
                const isHead = runInfo.isHead;
                const collapsed = isCollapsed(groupKey);
                const groupNo = getGroupNo(groupKey);
                const designerDup = isDesignerDup(c);
                const internalDup = isInternalDup(c);
                const groupVisibleRows = runInfo.rowSpan;
                const groupHead = groupHeadByGroup.get(groupKey) ?? c;
                const groupIsDali = isDaliCircuit(groupHead);
                const currentFixtureIsIndirect = isIndirectFixture(c.fixture);
                const currentFixtureType = fixtureType(c.fixture);
                const daliFixtureInfo = groupIsDali ? daliFixtureBlockInfo.get(c.id) : undefined;
                const showDaliFixtureBlock = !groupIsDali || daliFixtureInfo?.isFirst;
                const fixtureRowSpan = groupIsDali ? (daliFixtureInfo?.rowSpan ?? 1) : 1;
                const isLastVisible = runInfo.isTail;
                const isGroupInner = groupVisibleRows > 1 && !isLastVisible;
                const dropTarget =
                  drag.dragOverInfo && drag.dragOverInfo.targetKey === groupKey;
                const showDropBefore =
                  dropTarget && drag.dragOverInfo!.position === "before" && isHead;
                const showDropAfter =
                  dropTarget && drag.dragOverInfo!.position === "after" && isLastVisible;
                const trClass = [
                  isDragging ? "row-dragging" : "",
                  collapsed && isHead ? "row-collapsed" : "",
                  isGroupInner ? "group-inner-row" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                const totalForGroup = groupTotals.get(groupKey) ?? 0;
                return (
                  <Fragment key={c.id}>
                    {showDropBefore ? (
                      <tr className="drop-indicator-row" aria-hidden="true">
                        <td colSpan={COL_COUNT}>
                          <span className="drop-indicator-line" />
                        </td>
                      </tr>
                    ) : null}
                  <tr
                    className={trClass}
                    data-drag-reorder-key={groupKey}
                    onDragOver={(e) => drag.onDragOver(e, groupKey)}
                    onDrop={(e) => drag.onDrop(e, groupKey)}
                  >
                    {isHead ? (
                      <td className="col-center drag-handle-cell" rowSpan={groupVisibleRows}>
                        <span className="rowspan-cell-content rowspan-cell-center">
                        <span
                          className="drag-handle"
                          draggable={canEdit}
                          onPointerDown={(e) => drag.onPointerDown(e, groupKey)}
                          onDragStart={(e) => drag.onDragStart(e, groupKey)}
                          onDragOver={(e) => drag.onDragOver(e, groupKey)}
                          onDrop={(e) => drag.onDrop(e, groupKey)}
                          onDragEnd={drag.onDragEnd}
                          title="Drag to reorder"
                        >
                          ::
                        </span>
                        </span>
                      </td>
                    ) : null}
                    {isHead ? (
                      <td className="col-center" rowSpan={groupVisibleRows}>
                        <span className="rowspan-cell-content">{groupNo}</span>
                      </td>
                    ) : null}
                    {isHead ? (
                      <td
                        className={[designerDup ? "cell-duplicate" : "", revisionCellClass(c.id, ["designerNumber"])].filter(Boolean).join(" ")}
                        rowSpan={groupVisibleRows}
                      >
                        <div className="rowspan-cell-content">
                        <div className="device-cell">
                          <button
                            type="button"
                            className="collapse-toggle"
                            title={collapsed ? "Expand" : "Collapse"}
                            aria-label={collapsed ? "Expand" : "Collapse"}
                            onClick={() => toggleCollapse(groupKey)}
                            disabled={!canEdit}
                          >
                            {collapsed ? "▶" : "▼"}
                          </button>
                          <AutoGrowTextarea
                            value={c.designerNumber}
                            onChange={(value) => update(c.id, "designerNumber", value)}
                            disabled={!canEdit}
                          />
                        </div>
                        </div>
                      </td>
                    ) : null}
                    {isHead ? (
                      <td
                        className={[internalDup ? "cell-duplicate" : "", revisionCellClass(c.id, ["internalNumber"])].filter(Boolean).join(" ")}
                        rowSpan={groupVisibleRows}
                      >
                        <div className="rowspan-cell-content">
                        <AutoGrowTextarea
                          value={groupHead.internalNumber}
                          onChange={(value) => update(c.id, "internalNumber", value)}
                          disabled={!canEdit}
                        />
                        </div>
                      </td>
                    ) : null}
                    {isHead ? (
                      <td rowSpan={groupVisibleRows} className={revisionCellClass(c.id, ["dimmingType"])}>
                        <div className="rowspan-cell-content">
                        <select
                          className="cell-input"
                          value={groupHead.dimmingType}
                          onChange={(e) =>
                            update(c.id, "dimmingType", e.target.value)
                          }
                          disabled={!canEdit}
                        >
                          {DIMMING_TYPE_OPTIONS.map((option) => (
                            <option key={option || "blank"} value={option}>
                              {option || "-"}
                            </option>
                          ))}
                        </select>
                        </div>
                      </td>
                    ) : null}
                    {isHead ? (
                      <td rowSpan={groupVisibleRows} className={revisionCellClass(c.id, ["area"])}>
                        <div className="rowspan-cell-content">
                        <select
                          className="cell-input"
                          value={groupHead.area}
                          onChange={(e) =>
                            update(c.id, "area", e.target.value)
                          }
                          disabled={!canEdit}
                        >
                          <option value="">—</option>
                          {locations.map((loc) => (
                            <option key={loc.id} value={loc.id}>
                              {loc.name || "(No name)"}
                            </option>
                          ))}
                        </select>
                        </div>
                      </td>
                    ) : null}
                    {((!groupIsDali && isHead) || (groupIsDali && showDaliFixtureBlock)) ? (
                    <td className="col-center" rowSpan={groupIsDali ? fixtureRowSpan : groupVisibleRows}>
                      <span className="rowspan-cell-content rowspan-cell-center">
                      <button
                        type="button"
                        className="btn-add-circuit"
                        title="Add a row under the same Designer Number"
                        onClick={() => addBelow(c.id)}
                        disabled={!canEdit}
                      >
                        +
                      </button>
                      </span>
                    </td>
                    ) : null}
                    {showDaliFixtureBlock ? (
                    <td rowSpan={fixtureRowSpan} className={revisionCellClass(c.id, ["fixture"])}>
                      <div className="rowspan-cell-content">
                      <select
                        className="cell-input"
                        value={c.fixture}
                        onChange={(e) => update(c.id, "fixture", e.target.value)}
                        disabled={!canEdit}
                      >
                        <option value="">—</option>
                        {!matched && c.fixture ? (
                          <option value={c.fixture}>
                            {c.fixture} (unregistered)
                          </option>
                        ) : null}
                        {fixtures.map((f) => (
                          <option key={f.id} value={f.fixture}>
                            {f.fixture}
                          </option>
                        ))}
                      </select>
                      </div>
                    </td>
                    ) : null}
                    {showDaliFixtureBlock ? (
                    <td rowSpan={fixtureRowSpan} className={revisionCellClass(c.id, ["pcs"])}>
                      <div className="rowspan-cell-content">
                      <div className="pcs-cell-control">
                        <Combobox
                          value={c.pcs}
                          options={CIRCUIT_PCS_OPTIONS}
                          onChange={(v) => update(c.id, "pcs", v)}
                          numeric={currentFixtureIsIndirect ? "decimal" : true}
                          disabled={!canEdit}
                        />
                        {currentFixtureType === "DL" ? (
                          <div className="pcs-step-buttons pcs-step-buttons-compact">
                            <button type="button" onClick={() => stepPcs(c.id, 1)} disabled={!canEdit}>+1</button>
                            <button type="button" onClick={() => stepPcs(c.id, -1)} disabled={!canEdit}>-1</button>
                          </div>
                        ) : null}
                        {currentFixtureIsIndirect ? (
                          <div className="pcs-step-buttons">
                            <button type="button" onClick={() => stepPcs(c.id, 0.1)} disabled={!canEdit}>+0.1</button>
                            <button type="button" onClick={() => stepPcs(c.id, 1)} disabled={!canEdit}>+1</button>
                            <button type="button" onClick={() => stepPcs(c.id, -0.1)} disabled={!canEdit}>-0.1</button>
                            <button type="button" onClick={() => stepPcs(c.id, -1)} disabled={!canEdit}>-1</button>
                          </div>
                        ) : null}
                      </div>
                      </div>
                    </td>
                    ) : null}
                    {showDaliFixtureBlock ? (
                    <td rowSpan={fixtureRowSpan}>
                      <span className="rowspan-cell-content cell-readonly">{calcVA(c)}</span>
                    </td>
                    ) : null}
                    {isHead ? (
                      <td
                        className="cell-readonly-merged col-center"
                        rowSpan={groupVisibleRows}
                      >
                        <span className="rowspan-cell-content">{formatTotal(totalForGroup)}</span>
                      </td>
                    ) : null}
                    {isHead ? (
                      <td
                        className={`col-center ${revisionCellClass(c.id, ["ffe"])}`}
                        rowSpan={groupVisibleRows}
                      >
                        <span className="rowspan-cell-content rowspan-cell-center">
                        <input
                          type="checkbox"
                          checked={groupHead.ffe}
                          onChange={(e) => updateBoolean(c.id, 'ffe', e.target.checked)}
                          aria-label="FFE"
                          disabled={!canEdit}
                        />
                        </span>
                      </td>
                    ) : null}
                    {isHead ? (
                      <td
                        className={`col-center ${revisionCellClass(c.id, ["energySaving"])}`}
                        rowSpan={groupVisibleRows}
                      >
                        <span className="rowspan-cell-content rowspan-cell-center">
                        <input
                          type="checkbox"
                          checked={groupHead.energySaving}
                          onChange={(e) => updateBoolean(c.id, 'energySaving', e.target.checked)}
                          aria-label="Energy Save"
                          disabled={!canEdit}
                        />
                        </span>
                      </td>
                    ) : null}
                    {isHead ? (
                      <td className={revisionCellClass(c.id, ["detail"])} rowSpan={groupVisibleRows}>
                        <div className="rowspan-cell-content">
                        <div className="cell-with-clear">
                          <Combobox
                            value={groupHead.detail}
                            options={detailOptionsForArea(groupHead.area)}
                            onChange={(value) => update(c.id, "detail", value)}
                            ariaLabel="Detail"
                            disabled={!canEdit}
                          />
                          {groupHead.detail.trim() ? (
                            <button
                              type="button"
                              className="btn-clear-circuit"
                              onClick={() => update(c.id, "detail", "")}
                              disabled={!canEdit}
                            >
                              Clear
                            </button>
                          ) : null}
                        </div>
                        </div>
                      </td>
                    ) : null}
                    <td className="col-center">
                      <div className="table-actions">
                        {isHead ? (
                          <ActionIconButton
                            icon="copy"
                            label="Copy Circuit"
                            className="btn-secondary-ghost"
                            onClick={() => copyGroup(c.id)}
                            title="Copy this circuit group"
                            disabled={!canEdit}
                          />
                        ) : null}
                        <ActionIconButton
                          icon="trash"
                          label="Delete Circuit"
                          className="btn-danger-ghost"
                          onClick={() => remove(c.id)}
                          disabled={!canEdit}
                        />
                      </div>
                    </td>
                  </tr>
                    {showDropAfter ? (
                      <tr className="drop-indicator-row" aria-hidden="true">
                        <td colSpan={COL_COUNT}>
                          <span className="drop-indicator-line" />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={COL_COUNT}>
                <button className="btn-add-row" onClick={addRow} title="Add Row" disabled={!canEdit}>
                  + Add Row
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </ResizableMatrixScroll>
        </>
      ) : (
        <ResizableMatrixScroll className="table-workspace-scroll" variant="large">
          <table className="matrix-table master-table circuits-table">
            <colgroup>
              <col className="table-col-drag" />
              <col className="table-col-no" />
            </colgroup>
            <thead>
              <tr>
                <th className="col-center" style={{ minWidth: 36 }} aria-label="Reorder" />
                <th className="col-center" style={{ minWidth: 44 }}>No</th>
                <th style={{ minWidth: 180 }}>Area</th>
                <th style={{ minWidth: 240 }}>Circuit</th>
                <th style={{ minWidth: 260 }}>Detail</th>
                <th className="col-center" style={{ minWidth: 96 }}>Operation</th>
              </tr>
            </thead>
            <tbody>
              {dryContacts.length === 0 ? (
                <tr>
                  <td colSpan={DRY_CONTACT_COL_COUNT} className="screen-empty">
                    No dry contacts are registered yet. Add a row below.
                  </td>
                </tr>
              ) : (
                dryContacts.map((entry, index) => {
                  const areaMatched = locations.some((location) => location.id === entry.area);
                  return (
                    <tr
                      key={entry.id}
                      className={[
                        dryContactDrag.draggingKey === entry.id ? "row-dragging" : "",
                        dryContactDrag.dragOverInfo?.targetKey === entry.id && dryContactDrag.dragOverInfo.position === "before" ? "drop-before" : "",
                        dryContactDrag.dragOverInfo?.targetKey === entry.id && dryContactDrag.dragOverInfo.position === "after" ? "drop-after" : "",
                      ].filter(Boolean).join(" ")}
                      data-drag-reorder-key={entry.id}
                      onDragOver={(event) => dryContactDrag.onDragOver(event, entry.id)}
                      onDrop={(event) => dryContactDrag.onDrop(event, entry.id)}
                    >
                      <td className="col-center drag-handle-cell">
                        <span
                          className="drag-handle"
                          draggable={canEdit}
                          onPointerDown={(event) => dryContactDrag.onPointerDown(event, entry.id)}
                          onDragStart={(event) => dryContactDrag.onDragStart(event, entry.id)}
                          onDragOver={(event) => dryContactDrag.onDragOver(event, entry.id)}
                          onDrop={(event) => dryContactDrag.onDrop(event, entry.id)}
                          onDragEnd={dryContactDrag.onDragEnd}
                          title="Drag to reorder"
                        >
                          ::
                        </span>
                      </td>
                      <td className="col-center">{index + 1}</td>
                      <td className={dryContactRevisionCellClass(entry.id, ["area"])}>
                        <select
                          className="cell-input"
                          value={entry.area}
                          onChange={(event) => updateDryContact(entry.id, "area", event.target.value)}
                          disabled={!canEdit}
                        >
                          <option value="">-</option>
                          {!areaMatched && entry.area ? (
                            <option value={entry.area}>{entry.area} (unregistered)</option>
                          ) : null}
                          {locations.map((location) => (
                            <option key={location.id} value={location.id}>
                              {location.name || "(No name)"}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={dryContactRevisionCellClass(entry.id, ["circuit"])}>
                        <Combobox
                          value={entry.circuit}
                          options={dryContactOptionsForArea(entry.area)}
                          onChange={(value) => updateDryContact(entry.id, "circuit", value)}
                          ariaLabel="Dry Contact Circuit"
                          disabled={!canEdit}
                        />
                      </td>
                      <td className={dryContactRevisionCellClass(entry.id, ["detail"])}>
                        <div className="cell-with-clear">
                          <AutoGrowTextarea
                            value={entry.detail}
                            onChange={(value) => updateDryContact(entry.id, "detail", value)}
                            disabled={!canEdit}
                          />
                          {entry.detail.trim() ? (
                            <button
                              type="button"
                              className="btn-clear-circuit"
                              onClick={() => updateDryContact(entry.id, "detail", "")}
                              disabled={!canEdit}
                            >
                              Clear
                            </button>
                          ) : null}
                        </div>
                      </td>
                      <td className="col-center">
                        <div className="table-actions">
                          <ActionIconButton
                            icon="copy"
                            label="Copy Dry Contact"
                            className="btn-secondary-ghost"
                            onClick={() => copyDryContact(entry.id)}
                            title="Copy this dry contact"
                            disabled={!canEdit}
                          />
                          <ActionIconButton
                            icon="trash"
                            label="Delete Dry Contact"
                            className="btn-danger-ghost"
                            onClick={() => removeDryContact(entry.id)}
                            disabled={!canEdit}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            <tfoot>
              <tr className="add-row-tr">
                <td colSpan={DRY_CONTACT_COL_COUNT}>
                  <button className="btn-add-row" onClick={addDryContactRow} title="Add Row" disabled={!canEdit}>
                    + Add Row
                  </button>
                </td>
              </tr>
            </tfoot>
          </table>
        </ResizableMatrixScroll>
      )}
    </section>
  );
}
