import { test, expect } from "./support/safe-test";
import { createEmptySwitchEntry } from "../../app/lib/constants";
import { copySwitchButton, switchButtonCopyLabel, switchButtonCopyTargets } from "../../app/lib/switchButtonCopy";
import { normalizeSwitchSettingLinksAfterCommit } from "../../app/lib/switchSettingLinks";
import type { SwitchEntry } from "../../app/types";

function button(id: string, group: string, label: string, fields: Partial<SwitchEntry> = {}): SwitchEntry {
  return { ...createEmptySwitchEntry("lutronPd"), id, switchGroupId: group, switchNumber: group, buttonCount: "2", buttonLabel: label, ...fields };
}

test("button copy replaces all functions with independent settings and preserves destination identity", () => {
  const rows = [
    button("s1", "source", "M1", { buttonFunction: "Occupied", condition: "Occupied trigger", isPriorityFunction: true, settingLinkGroupId: "source-link", buttonSetting: { sceneId: "scene1", sceneIds: ["scene1"], circuitSettings: [{ circuitId: "c1", percentage: "Occupied:50%\nVacant:Off", valueMode: "text" }] }, backlightTarget: "bl-target", backlightCondition: "night" }),
    button("s2", "source", "M1", { buttonFunction: "Vacant", buttonType: "toggle", condition: "Vacant trigger" }),
    button("untouched-button", "source", "M2"),
    button("d1", "target", "M2", { switchName: "Target name", allocation: "local", cciAssignment: "local-cci", backlightAssignment: "local-level", backlightTarget: "dest-B", backlightLevels: [{ key: "local", name: "Local", mode: "DBM", active: "17", inactive: "9" }], settingLinkGroupId: "old-link", buttonFunction: "old" }),
    button("linked-other", "other", "M1", { settingLinkGroupId: "old-link", buttonFunction: "unselected" }),
    button("pico", "pico", "1", { kind: "lutronPico" }),
  ];
  const before = JSON.stringify(rows);
  let sequence = 0;
  const result = copySwitchButton(rows, "s1", ["d1"], () => `new-${++sequence}`);
  expect(JSON.stringify(rows)).toBe(before);
  expect(result.map(row => row.id)).toEqual(["s1", "s2", "untouched-button", "d1", "new-1", "linked-other", "pico"]);
  const copied = result.filter(row => row.switchGroupId === "target");
  expect(copied.map(row => [row.buttonFunction, row.condition, row.isPriorityFunction])).toEqual([["Occupied", "Occupied trigger", true], ["Vacant", "Vacant trigger", undefined]]);
  for (const row of copied) {
    expect(row).toMatchObject({ switchGroupId: "target", switchNumber: "target", switchName: "Target name", buttonLabel: "M2", allocation: "local", cciAssignment: "local-cci", backlightAssignment: "local-level" });
    expect(row.settingLinkGroupId).toBeUndefined();
    expect(row.backlightLevels).toEqual(rows[3].backlightLevels);
  }
  expect(copied[0].buttonSetting).toEqual(rows[0].buttonSetting);
  expect(copied.map(row => row.backlightTarget)).toEqual(["dest-B", ""]);
  expect(copied[0].backlightCondition).toBe("night");
  copied[0].buttonSetting.sceneIds.push("extra");
  copied[0].buttonSetting.circuitSettings[0].percentage = "Edited";
  expect(rows[0].buttonSetting.sceneIds).toEqual(["scene1"]);
  expect(rows[0].buttonSetting.circuitSettings[0].percentage).toBe("Occupied:50%\nVacant:Off");
  const normalized = normalizeSwitchSettingLinksAfterCommit(rows, result);
  expect(normalized.find(row => row.id === "linked-other")?.buttonFunction).toBe("unselected");
  expect(normalized.find(row => row.id === "s1")?.buttonSetting).toEqual(rows[0].buttonSetting);
});

test("button copy requires explicit valid destinations and never accepts another kind, source or stale id", () => {
  const rows = [button("s", "source", "M1"), button("s-more", "source", "M1"), button("d", "source", "M2"), button("p", "pico", "1", { kind: "lutronPico" }), button("pir", "pir", "M1", { kind: "pir" })];
  expect(switchButtonCopyTargets(rows, "s")).toEqual([{ id: "d", label: "Palladiom source / M2", functionCount: 1 }]);
  for (const targets of [[], ["s"], ["s-more"], ["missing"], ["p"], ["pir"], ["d", "missing"]]) {
    expect(copySwitchButton(rows, "s", targets, () => "new")).toBe(rows);
  }
  expect(copySwitchButton(rows, "missing", ["d"], () => "new")).toBe(rows);
});

test("row reduction is rejected atomically across multiple explicit Pico buttons", () => {
  const pico = (id: string, group: string, label: string, fields: Partial<SwitchEntry> = {}) => button(id, group, label, { kind: "lutronPico", ...fields });
  const rows = [pico("s", "a", "1", { buttonFunction: "raise", buttonType: "toggle", backlightTarget: "" }), pico("d1", "b", "2", { backlightTarget: "dest-B" }), pico("d2", "b", "2", { backlightTarget: "removed" }), pico("other", "b", "3", { backlightTarget: "other" }), pico("d3", "c", "4", { backlightTarget: "dest-C" })];
  expect(copySwitchButton(rows, "s", ["d1", "d3"], () => "unused")).toBe(rows);
  expect(switchButtonCopyTargets(rows, "s").find(target => target.id === "d1")?.reason).toMatch(/function rows/i);
  expect(copySwitchButton(rows, "s", ["d1"], () => "unused")).toBe(rows);
  const next = copySwitchButton(rows, "s", ["d3"], () => "unused");
  expect(next[4]).toMatchObject({ id: "d3", buttonFunction: "raise", backlightTarget: "dest-C" });
  const emptyExtra = rows.map(row => row.id === "d2" ? { ...row, backlightTarget: "" } : row);
  expect(copySwitchButton(emptyExtra, "s", ["d1"], () => "unused")).toBe(emptyExtra);
});

test("unnamed panel labels retain the physical panel order including panels without buttons", () => {
  const rows = [button("blank", "a", "", { switchNumber: "" }), button("source", "b", "M1", { switchNumber: "" }), button("destination", "c", "M2", { switchNumber: "" })];
  expect(switchButtonCopyLabel(rows, rows[1])).toBe("Palladiom #2 / M1");
  expect(switchButtonCopyTargets(rows, "source")).toEqual([{ id: "destination", label: "Palladiom #3 / M2", functionCount: 1 }]);
});

test("legacy destination without an explicit group id keeps all new functions on the same physical panel", () => {
  const rows = [button("source-a", "source", "M1"), button("source-b", "source", "M1"), button("legacy-destination", "", "M2")];
  const result = copySwitchButton(rows, "source-a", ["legacy-destination"], () => "extra-function");
  expect(result.slice(2).map(row => [row.id, row.switchGroupId, row.buttonLabel])).toEqual([["legacy-destination", "legacy-destination", "M2"], ["extra-function", "legacy-destination", "M2"]]);
});
