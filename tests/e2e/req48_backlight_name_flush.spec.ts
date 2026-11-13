import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { BacklightLevelSetting, ProjectData, SwitchEntry } from "../../app/types";
import { createEmptySwitchEntry, createNewRoomType, normalizeBacklightLevels } from "../../app/lib/constants";
import { syncProjectRoomTypeLinks } from "../../app/lib/roomTypeSync";
import { createNewProject, normalizeProjectSave } from "../../app/lib/storage";

function loadNameHandlers() {
  const path = "app/components/BacklightView.tsx";
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "BacklightView") as ts.FunctionDeclaration;
  const names = new Set(["pendingNameRef", "commitNameRef", "flushPendingName", "commitSwitches",
    "updateAllPalladiomLevels", "updateLevel", "commitLevelName", "editLevelName"]);
  const statements = component.body!.statements.filter(node => {
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(item => names.has(item.name.getText(source)));
    if (ts.isFunctionDeclaration(node)) return Boolean(node.name && names.has(node.name.text));
    return ts.isExpressionStatement(node) && node.getText(source).startsWith("useLayoutEffect(");
  });
  expect(statements).toHaveLength(names.size + 2);
  const save = readFileSync("app/components/ProjectScreen.tsx", "utf8")
    .match(/const handleSaveCurrentProject = useCallback\([\s\S]*?\n  \}, \[[^\n]+\]\);/)?.[0];
  expect(save).toBeDefined();
  return ts.transpileModule(statements.map(node => node.getText(source)).join("\n") + "\n" + save
    + "\n({ editLevelName, handleSaveCurrentProject });",
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

test("Save flushes a focused Backlight name into the project and Palladiom rows before snapshotting", async () => {
  const room = createNewRoomType("Test room");
  room.switches = [{ ...createEmptySwitchEntry("lutronPd"), backlightAssignment: "base" }];
  let project = { ...createNewProject("Backlight test"), roomTypes: [room] };
  let persisted: ProjectData | undefined;
  const flushNameRef = { current: null };
  const cleanups: (() => void)[] = [];
  const handlers = runInNewContext(loadNameHandlers(), {
    canEdit: true, canEditBacklightLevels: true, devices: [], onReadOnlyAction: undefined,
    levels: normalizeBacklightLevels(room.backlightLevels), palladiomSwitches: room.switches,
    normalizeBacklightLevels, syncProjectRoomTypeLinks, setEditingName: () => {},
    useRef: (current: unknown) => ({ current }),
    useCallback: (callback: unknown) => callback,
    useLayoutEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    },
    flushNameRef, flushBacklightNameRef: flushNameRef,
    onBacklightLevelsChange: (levels: BacklightLevelSetting[]) => {
      project = { ...project, roomTypes: [{ ...project.roomTypes[0], backlightLevels: structuredClone(levels) }] };
    },
    onChange: (apply: (current: SwitchEntry[]) => SwitchEntry[]) => {
      project = { ...project, roomTypes: [{ ...project.roomTypes[0], switches: structuredClone(apply(project.roomTypes[0].switches)) }] };
    },
    onSaveProjectDraft: async (mutate: (current: ProjectData) => ProjectData) => {
      persisted = normalizeProjectSave(JSON.parse(JSON.stringify(mutate(project))));
      return true;
    },
  }) as { editLevelName: (key: string, value: string) => void; handleSaveCurrentProject: () => Promise<boolean> };

  handlers.editLevelName("base", "Night  Mode  ");
  expect(project.roomTypes[0].backlightLevels?.[0].name).toBe("Base");
  expect(await handlers.handleSaveCurrentProject()).toBe(true);
  const savedRoom = persisted?.roomTypes[0];
  expect(savedRoom?.backlightLevels?.[0].name).toBe("Night  Mode");
  expect(savedRoom?.switches[0].backlightLevels[0].name).toBe("Night  Mode");
  expect(savedRoom?.switches[0].backlightAssignment).toBe("base");

  handlers.editLevelName("base", "Unmount  Scene  ");
  expect(cleanups).toHaveLength(1);
  cleanups[0]();
  expect(project.roomTypes[0].backlightLevels?.[0].name).toBe("Unmount  Scene");
  expect(flushNameRef.current).toBeNull();
});
