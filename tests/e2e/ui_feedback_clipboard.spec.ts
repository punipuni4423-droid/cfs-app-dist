import { test, expect } from "@playwright/test";
import { createEmptySwitchEntry } from "../../app/lib/constants";
import { copyOperation, operationPasteTargets, pasteOperation } from "../../app/lib/switchOperationClipboard";
import type { SwitchEntry } from "../../app/types";

function row(id: string, group: string, button = "M1", fields: Partial<SwitchEntry> = {}): SwitchEntry {
  return { ...createEmptySwitchEntry("lutronPd"), id, switchGroupId: group, switchNumber: group, buttonCount: "2", buttonLabel: button, ...fields };
}
test("Function copies exactly one complete action, retaining physical identities and other functions", () => {
  const rows = [row("s", "source", "M1", { buttonFunction: "Occupied", buttonType: "toggle", condition: "Trigger", buttonSetting: { sceneId: "a", sceneIds: ["a"], circuitSettings: [{ circuitId: "c", percentage: "50 / Off\nLegacy", valueMode: "text" }] }, backlightTarget: "BL-A", backlightCondition: "Night" }), row("s2", "source"), row("d", "target", "M2", { allocation: "hardware", cciAssignment: "local-CCI", backlightAssignment: "local-BL", backlightTarget: "BL-B", settingLinkGroupId: "old" }), row("d2", "target", "M2"), row("other", "other", "1", { kind: "lutronPico" })];
  const before = JSON.stringify(rows), clip = copyOperation(rows, "s", "function")!;
  const next = pasteOperation(rows, clip, ["d"], () => "unused");
  expect(JSON.stringify(rows)).toBe(before);
  expect(next[2]).toMatchObject({ id: "d", switchGroupId: "target", buttonLabel: "M2", allocation: "hardware", cciAssignment: "local-CCI", backlightAssignment: "local-BL",
    buttonFunction: rows[2].buttonFunction, condition: rows[2].condition, buttonType: rows[2].buttonType, backlightTarget: "BL-A", backlightCondition: "Night" });
  expect(pasteOperation(rows, copyOperation(rows, "s2", "function")!, ["d"], () => "unused")[2].backlightTarget).toBe("");
  expect(next[2].buttonSetting).toEqual(rows[0].buttonSetting); expect(next[2].settingLinkGroupId).toBeUndefined();
  for (const index of [0, 1, 3, 4]) expect(next[index]).toBe(rows[index]);
  next[2].buttonSetting.circuitSettings[0].percentage = "changed";
  expect(clip.rows[0].content.buttonSetting.circuitSettings[0].percentage).toBe("50 / Off\nLegacy");
  for (const ids of [[], ["s"], ["missing"], ["other"], ["d", "missing"]]) expect(pasteOperation(rows, clip, ids, () => "unused")).toBe(rows);
  expect(operationPasteTargets(rows.filter(item => item.id !== "s"), clip)).toEqual([]);
});
test("Switch replaces all functions per button, preserves destination registration and rejects mismatched layouts", () => {
  const rows = [row("s1", "source", "M1", { buttonFunction: "A", backlightTarget: "source-A" }), row("s2", "source", "M1", { buttonFunction: "B" }), row("s3", "source", "M2", { buttonFunction: "C", backlightTarget: "source-C" }), row("d1", "target", "M1", { switchName: "Keep", allocation: "physical", backlightAssignment: "local", backlightTarget: "dest-B" }), row("d2", "target", "M2", { backlightTarget: "dest-C" }), row("bad", "bad", "M1", { buttonCount: "1" }), row("pico", "pico", "1", { kind: "lutronPico" })];
  const clip = copyOperation(rows, "s1", "switch")!;
  expect(operationPasteTargets(rows, clip).map(item => [item.id, Boolean(item.reason)])).toEqual([["target", false], ["bad", true]]);
  let sequence = 0; const next = pasteOperation(rows, clip, ["target"], () => `new-${++sequence}`);
  expect(next.filter(item => item.switchGroupId === "target").map(item => [item.id, item.buttonLabel, item.buttonFunction])).toEqual([["d1", "M1", "A"], ["new-1", "M1", "B"], ["d2", "M2", "C"]]);
  expect(next.filter(item => item.switchGroupId === "target").map(item => item.backlightTarget)).toEqual(["dest-B", "", "dest-C"]);
  expect(next.find(item => item.id === "d1")).toMatchObject({ switchName: "Keep", allocation: "physical", backlightAssignment: "local" });
  expect(pasteOperation(rows, clip, ["target", "bad"], () => "unused")).toBe(rows);
  expect(next.find(item => item.id === "bad")).toBe(rows[5]); expect(next.find(item => item.id === "pico")).toBe(rows[6]);
});
test("Switch paste rejects any row reduction atomically, including multi-button and multiple destinations", () => {
  const rows = [row("s1", "source", "M1"), row("s2", "source", "M2"), row("d1", "target", "M1", { backlightTarget: "B" }), row("d-extra", "target", "M1", { backlightTarget: "removed-row" }), row("d2", "target", "M2", { backlightTarget: "C" }), row("unrelated", "other", "M1", { backlightTarget: "D" })];
  const safe = [row("safe1", "safe", "M1"), row("safe2", "safe", "M2")];
  const all = [...rows, ...safe], clip = copyOperation(all, "s1", "switch")!;
  expect(pasteOperation(all, clip, ["safe", "target"], () => "unused")).toBe(all);
  expect(operationPasteTargets(all, clip).find(item => item.id === "target")?.reason).toMatch(/function rows/i);
  expect(pasteOperation(all, clip, ["target"], () => "unused")).toBe(all);
  expect(pasteOperation(all, clip, ["safe"], () => "unused")).not.toBe(all);
  const emptyExtra = all.map(item => item.id === "d-extra" ? { ...item, backlightTarget: "" } : item);
  expect(pasteOperation(emptyExtra, copyOperation(emptyExtra, "s1", "switch")!, ["target"], () => "unused")).toBe(emptyExtra);
});
test("Thermostat shared Area binding, Command references and legacy group identity remain destination-local", () => {
  const source = row("ts", "area-a", "-", { kind: "tstat", tstatBinding: { areaId: "a", assignmentIds: ["th1", "th2"] }, buttonFunction: "Occupied" });
  const target = row("td", "area-b", "-", { kind: "tstat", tstatBinding: { areaId: "b", assignmentIds: ["th3"] } });
  const rows = [source, target]; const clip = copyOperation(rows, "ts", "switch")!;
  expect(pasteOperation(rows, clip, ["area-b"], () => "extra")[1].tstatBinding).toEqual(target.tstatBinding);
  const commands = [row("c1", "legacy-common", "source-button", { kind: "command", switchNumber: "source-reference", buttonFunction: "Action" }), row("c2", "legacy-common", "target-button", { kind: "command", switchNumber: "target-reference" })];
  const commandClip = copyOperation(commands, "c1", "function")!; const result = pasteOperation(commands, commandClip, ["c2"], () => "unused");
  expect(result[1]).toMatchObject({ id: "c2", switchNumber: "target-reference", buttonLabel: "target-button", buttonFunction: "Action" });
  const legacy = [row("s1", "s"), row("s2", "s"), row("legacy", "")]; const copy = copyOperation(legacy, "s1", "switch")!;
  expect(pasteOperation(legacy, copy, ["legacy"], () => "extra").slice(2).map(item => item.switchGroupId)).toEqual(["legacy", "legacy"]);
  expect(copyOperation([row("q", "q", "-", { kind: "qsm" })], "q", "function")).toBeNull();
});
test("buttonless switch paste preserves destination registration and row identity despite different labels", () => {
  for (const kind of ["pir", "contact", "tstat"] as const) {
    const make = (id: string, group: string, label: string, fields: Partial<SwitchEntry> = {}) => row(id, group, label, { kind, ...fields });
    const rows = [make("s1", "src", "area::1", { buttonFunction: "A" }), make("s2", "src", "area::1", { buttonFunction: "B" }), make("d1", "dst", "area::2", { allocation: "dest-allocation", cciAssignment: "dest-CCI", backlightTarget: "dest-B", tstatBinding: { areaId: "dest-area", assignmentIds: ["dest-TH"] } }), make("safe", "safe", "area::3", { backlightTarget: "safe" })];
    const clip = copyOperation(rows, "s1", "switch")!; expect(operationPasteTargets(rows, clip).find(item => item.id === "dst")?.reason).toBeUndefined();
    const next = pasteOperation(rows, clip, ["dst"], () => "new");
    expect(next.filter(item => item.switchGroupId === "dst").map(item => [item.id, item.buttonLabel, item.buttonFunction, item.backlightTarget])).toEqual([["d1", "area::2", "A", "dest-B"], ["new", "area::2", "B", ""]]);
    expect(next.find(item => item.id === "d1")).toMatchObject({ allocation: "dest-allocation", cciAssignment: "dest-CCI", tstatBinding: { areaId: "dest-area", assignmentIds: ["dest-TH"] } });
    expect(next.find(item => item.id === "safe")).toBe(rows[3]);
    const shorter = copyOperation([rows[0], ...rows.slice(2)], "s1", "switch")!;
    const sameCount = pasteOperation(rows, shorter, ["dst", "safe"], () => "unused");
    expect(sameCount.filter(item => item.id === "d1" || item.id === "safe").map(item => [item.id, item.buttonLabel, item.buttonFunction])).toEqual([["d1", "area::2", "A"], ["safe", "area::3", "A"]]);
    expect(pasteOperation(next, shorter, ["dst", "safe"], () => "unused")).toBe(next);
    expect(pasteOperation(next, shorter, ["safe", "missing"], () => "unused")).toBe(next);
  }
});
test("PIR destination labels distinguish groups and functions using visible registration names", () => {
  const locations = [{ id: "area-id", code: "", name: "Guest Room", number: "1", color: "" }];
  const pir = (id: string, group: string, action: string) => row(id, group, JSON.stringify(["area-id::2"]), { kind: "pir", switchNumber: "area-id", allocation: JSON.stringify({ "area-id": "2" }), buttonFunction: action });
  const rows = [pir("s", "source", "Source"), pir("d", "target", "Destination"), pir("o", "other", "Other"), pir("o2", "other", "Other second")];
  for (const scope of ["switch", "function"] as const) {
    const clip = copyOperation(rows, "s", scope, locations)!; const labels = operationPasteTargets(rows, clip, locations).map(target => target.label);
    expect(new Set(labels).size).toBe(labels.length); expect(labels.every(label => label.includes("PIR2") && label.includes("Guest Room") && !label.includes("area-id"))).toBe(true);
    expect(labels.some(label => label.includes("Group #2"))).toBe(true); expect(labels.some(label => label.includes("Group #3"))).toBe(true);
  }
});
test("priority-invalid multi-paste is atomic and never normalizes an unselected sibling", () => {
  const rows = [row("s", "a", "M1", { isPriorityFunction: true }), row("s2", "a"), row("d", "b", "M1"), row("peer", "b", "M1", { isPriorityFunction: true }), row("safe", "c", "M1"), row("safe-peer", "c")];
  const clip = copyOperation(rows, "s", "function")!;
  expect(pasteOperation(rows, clip, ["safe", "d"], () => "unused")).toBe(rows);
  const next = pasteOperation(rows, clip, ["safe"], () => "unused"); expect(next[4].isPriorityFunction).toBe(true); expect(next[5]).toBe(rows[5]);
});
