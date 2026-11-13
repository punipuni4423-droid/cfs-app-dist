import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { ProjectData, RoomType } from "../../app/types";
import { createEmptyCircuitEntry, createEmptyRoomScene, createEmptyScene, createNewRoomType, normalizeBacklightLevels } from "../../app/lib/constants";
import { roomSceneCellValue, SCENE_NAME_LINE_PREFIX } from "../../app/lib/cfsValueResolver";
import { normalizeSceneSettingsByCircuitGroup, sameSceneSettings } from "../../app/lib/circuitGroups";
import { setSceneSettingValue } from "../../app/lib/settingValues";
import { syncProjectRoomTypeLinks } from "../../app/lib/roomTypeSync";
import { createNewProject, normalizeProjectSave } from "../../app/lib/storage";

test("Backlight normalizes trailing whitespace only and keeps the legacy master alias", () => {
  const levels = normalizeBacklightLevels([{ key: "base", name: " Night  Mode  " }, { key: "masterOn", name: "Master On" }, { key: "relax", name: " " }]);
  expect(levels.map(level => level.name)).toEqual([" Night  Mode", "Bright", "Relax"]);
  expect(normalizeBacklightLevels([{ key: "masterOn", name: "Master On" }], { migrateLegacyMasterOn: false })[0].name).toBe("Master On");
});

test("stored Area Scene name round-trips and only displays when inherited", () => {
  const project = createNewProject("Area Scene test");
  const circuit = { ...createEmptyCircuitEntry("1"), id: "c1", area: "a1", dimmingType: "Phase" };
  const scene = { ...createEmptyScene("a1"), id: "s1", name: "Repro Scene A", settings: [{ circuitId: circuit.id, percentage: "30" }] };
  const roomScene = { ...createEmptyRoomScene(), areaSceneSelections: [{ areaId: "a1", sceneId: "s1" }] };
  project.circuits = [circuit];
  project.roomTypes = [{ ...createNewRoomType("Room"), circuitIds: ["c1"], scenes: [scene], roomScenes: [roomScene] }];
  const saved = normalizeProjectSave(project);
  const read = normalizeProjectSave(JSON.parse(JSON.stringify(saved)));
  const restoredScene = read.roomTypes[0].scenes[0];
  expect(restoredScene.name).toBe(scene.name);
  const source = read.roomTypes[0].roomScenes[0];
  const named = new Map([[restoredScene.id, restoredScene]]);
  const unnamed = new Map([[restoredScene.id, { ...restoredScene, name: "" }]]);
  const value = roomSceneCellValue(source, circuit, named, false);
  expect(value).toEqual(["30%"]);
  expect(roomSceneCellValue(source, circuit, named, true)).toEqual([SCENE_NAME_LINE_PREFIX + scene.name, ...value]);
  expect(roomSceneCellValue(source, circuit, unnamed, true)).toEqual(value);
  expect(roomSceneCellValue({ ...source, settings: [{ circuitId: circuit.id, percentage: "45" }] }, circuit, named, true)).toEqual(["45%"]);
});

function readSceneWriteHandlers() {
  const path = "app/components/SceneView.tsx";
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["setSetting", "handleRenameScene", "updateSelectedScene", "handleSettingChange"]);
  const handlers: string[] = [];
  let normalizeEffect = "";
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) handlers.push(node.getText(source));
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect") {
      const callback = node.arguments[0];
      if (callback?.getText(source).includes("normalizeSceneSettingsByCircuitGroup")) normalizeEffect = callback.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(handlers).toHaveLength(names.size);
  expect(normalizeEffect).not.toBe("");
  return ts.transpileModule(
    handlers.join("\n") + "\n({ handleRenameScene, handleSettingChange, normalize: " + normalizeEffect + " });",
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
}

for (const nextWrite of ["value", "group normalization"] as const) {
  test(`latest Area Scene name survives a same-render ${nextWrite} write, save and reload`, () => {
    const circuit = { ...createEmptyCircuitEntry("1"), id: "c1", area: "a1", dimmingType: "Phase", circuitGroupId: "g1" };
    const circuits = [circuit, { ...circuit, id: "c2" }];
    const scene = { ...createEmptyScene("a1"), id: "s1",
      settings: nextWrite === "value" ? [] : [{ circuitId: circuit.id, percentage: "30" }] };
    const roomScene = { ...createEmptyRoomScene(), areaSceneSelections: [{ areaId: "a1", sceneId: scene.id }] };
    const room = { ...createNewRoomType("Room"), circuitIds: ["c1", "c2"], scenes: [scene], roomScenes: [roomScene] };
    let project: ProjectData = { ...createNewProject("Area Scene writes"), circuits, roomTypes: [room] };
    const projectScreen = readFileSync("app/components/ProjectScreen.tsx", "utf8");
    const setScenesSource = projectScreen.match(/const setScenes = useCallback\([\s\S]*?\n  \);/)?.[0];
    expect(setScenesSource).toBeDefined();
    const setScenes = runInNewContext(ts.transpileModule(setScenesSource + "\nsetScenes;", {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      useCallback: (callback: unknown) => callback,
      updateActiveRoomType: (mutate: (current: RoomType) => RoomType) => {
        project = syncProjectRoomTypeLinks({ ...project, roomTypes: [mutate(project.roomTypes[0])] }, { devices: [] });
      },
    });
    const handlers = runInNewContext(readSceneWriteHandlers(), {
      canEdit: true, selectedScene: scene, scenes: room.scenes, circuits,
      overlayHostOnly: false, suppressSceneNormalization: false,
      normalizeSceneSettingsByCircuitGroup, sameSceneSettings, setSceneSettingValue,
      onChange: setScenes,
    }) as {
      handleRenameScene: (name: string) => void;
      handleSettingChange: (circuitId: string, value: string) => void;
      normalize: () => void;
    };
    handlers.handleRenameScene("Repro Scene A");
    expect(project.roomTypes[0].scenes[0].name).toBe("Repro Scene A");
    if (nextWrite === "value") handlers.handleSettingChange(circuit.id, "30");
    else handlers.normalize();
    const updated = project.roomTypes[0].scenes[0];
    expect(updated.name).toBe("Repro Scene A");
    expect(updated.settings.map(setting => setting.circuitId)).toEqual(["c1", "c2"]);
    const saved = normalizeProjectSave(structuredClone(project));
    const read = normalizeProjectSave(JSON.parse(JSON.stringify(saved)));
    const restored = read.roomTypes[0].scenes[0];
    expect(restored.name).toBe("Repro Scene A");
    const restoredRoomScene = read.roomTypes[0].roomScenes.find(row => row.id === roomScene.id);
    expect(restoredRoomScene).toBeDefined();
    expect(roomSceneCellValue(restoredRoomScene!, circuit, new Map([[restored.id, restored]]), true))
      .toEqual([SCENE_NAME_LINE_PREFIX + "Repro Scene A", "30%"]);
  });
}
