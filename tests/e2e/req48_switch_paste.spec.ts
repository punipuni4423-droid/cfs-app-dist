import { expect, test } from "@playwright/test";
import { createEmptySwitchEntry } from "../../app/lib/constants";
import { checkedOperationPasteRows, copyOperation, operationPasteTargets, pasteOperation } from "../../app/lib/switchOperationClipboard";
import { copySwitchButton, switchButtonCopyTargets } from "../../app/lib/switchButtonCopy";
import type { SwitchEntry } from "../../app/types";

function row(id: string, buttonLabel = "M1", fields: Partial<SwitchEntry> = {}): SwitchEntry {
  return { ...createEmptySwitchEntry("lutronPd"), id, switchGroupId: id, buttonLabel, buttonFunction: id, ...fields };
}

test("direct Function Paste copies both settings only to the clicked row and preserves its name and trigger", () => {
  const rows = [row("source", "M1", { condition: "Occupied", backlightTarget: "source-target", backlightCondition: "base" }),
    row("one", "M1", { condition: "Vacant", backlightTarget: "wired" }), row("two")];
  const clipboard = copyOperation(rows, "source", "function")!;
  const result = pasteOperation(rows, clipboard, ["one"], () => "unused");
  expect(result[1]).toMatchObject({ id: "one", buttonFunction: "one", condition: "Vacant", backlightTarget: "source-target",
    backlightCondition: "base", switchGroupId: "one" });
  expect(result[2]).toBe(rows[2]);
  expect(rows[1].buttonFunction).toBe("one");
});

test("checked Function Paste excludes the source, another kind and quarantined rows", () => {
  const rows = [row("source", "M1", { backlightCondition: "base" }), row("one"), row("two"), row("pico", "M1", { kind: "lutronPico" }),
    row("quarantine", "M1", { tstatBindingQuarantine: { raw: true } })];
  const clipboard = copyOperation(rows, "source", "function")!;
  const targets = new Map(operationPasteTargets(rows, clipboard).map(target => [target.id, target]));
  const selected = checkedOperationPasteRows(new Set(rows.map(item => item.id)), targets);
  expect(selected.ids).toEqual(["one", "two"]);
  expect(selected.reasons).toHaveLength(1);
  expect(pasteOperation(rows, clipboard, ["source", "one"], () => "unused")).toBe(rows);
  const result = pasteOperation(rows, clipboard, selected.ids, () => "unused");
  expect(result.map(item => item.buttonFunction)).toEqual(["source", "one", "two", "pico", "quarantine"]);
  expect(result.slice(1, 3).map(item => item.backlightCondition)).toEqual(["base", "base"]);
  expect(result[3]).toBe(rows[3]);
  expect(result[4]).toBe(rows[4]);
});

test("Button selection uses representative rows and explains row reduction", () => {
  const rows = [row("source"), row("one"), row("long"), row("long-tail", "M1", { switchGroupId: "long" })];
  const targets = new Map(switchButtonCopyTargets(rows, "source").map(target => [target.id, target]));
  const selected = checkedOperationPasteRows(new Set(["one", "long", "long-tail"]), targets);
  expect(selected.ids).toEqual(["one"]);
  expect(selected.reasons).toContain("Existing function rows would be removed, potentially losing wiring or inspection references.");
  expect(copySwitchButton(rows, "source", ["one", "long"], () => "unused")).toBe(rows);
  expect(copySwitchButton(rows, "source", selected.ids, () => "unused").map(item => item.buttonFunction))
    .toEqual(["source", "source", "long", "long-tail"]);
});
