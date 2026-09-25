"use client";
import type { ReactNode } from "react";
import type { LocationMaster, Scene } from "../../types";
import type { SettingTarget, SettingTargetGroup } from "../../lib/settingTargets";
import type { BulkSettingMode } from "../../lib/settingValues";
import CurtainActionButtons from "../CurtainActionButtons";

interface SceneValueSettingPanelProps {
  areasWithScenes: LocationMaster[];
  scenes: Scene[];
  targetGroups: SettingTargetGroup[];
  canEdit: boolean;
  sceneForArea: (areaId: string) => string;
  onSceneForAreaChange: (areaId: string, sceneId: string) => void;
  isAreaExpanded: (areaId: string) => boolean;
  onAreaToggle: (areaId: string) => void;
  areaHasSetting: (area: SettingTargetGroup) => boolean;
  bulk: {
    value: (area: SettingTargetGroup) => string;
    onPercentChange: (area: SettingTargetGroup, value: string) => void;
    onStep: (area: SettingTargetGroup, delta: number) => void;
    canApply: (area: SettingTargetGroup, mode: BulkSettingMode) => boolean;
    onApply: (area: SettingTargetGroup, mode: BulkSettingMode) => void;
  };
  valueForTarget: (target: SettingTarget) => string;
  onTargetValueChange: (target: SettingTarget, value: string) => void;
  onTargetStep: (target: SettingTarget, delta: number) => void;
  renderValueInput?: (target: SettingTarget, value: string) => ReactNode;
  cardClassName?: string;
  children?: ReactNode;
}
function isCurtainTarget(target: SettingTarget): boolean {
  return target.isCurtain === true || target.dimmingType === "Curtain";
}
export default function SceneValueSettingPanel({ areasWithScenes, scenes, targetGroups, canEdit, sceneForArea, onSceneForAreaChange, isAreaExpanded, onAreaToggle, areaHasSetting, bulk, valueForTarget, onTargetValueChange, onTargetStep, renderValueInput, cardClassName = '', children }: SceneValueSettingPanelProps): ReactNode {
    return (
      <div className={`scene-card switch-setting-card ${cardClassName}`}>
        <div className="switch-setting-layout">
          <div className="switch-setting-section switch-setting-scene-section">
            <div className="switch-setting-title">Area Scene</div>
            <div className="matrix-scroll">
              <table className="matrix-table master-table switch-setting-table switch-scene-table">
                <thead>
                  <tr>
                    <th>Area</th>
                    <th>Scene</th>
                    <th className="col-center">Clear</th>
                  </tr>
                </thead>
                <tbody>
                  {areasWithScenes.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="screen-empty">
                        No areas with scenes are registered.
                      </td>
                    </tr>
                  ) : (
                    areasWithScenes.map((area) => {
                      const areaScenes = scenes.filter((scene) => scene.areaId === area.id);
                      const selectedSceneId = sceneForArea(area.id);
                      return (
                        <tr key={area.id}>
                          <td><span className="cell-readonly">{area.name || "(No name)"}</span></td>
                          <td>
                            <select
                              className="cell-input"
                              value={selectedSceneId}
                              onChange={(e) => onSceneForAreaChange(area.id, e.target.value)}
                              disabled={!canEdit}
                            >
                              <option value="">-</option>
                              {areaScenes.map((scene, index) => (
                                <option key={scene.id} value={scene.id}>
                                  {scene.name || `Scene ${index + 1}`}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="col-center">
                            <button
                              type="button"
                              className="btn-clear-circuit"
                              onClick={() => onSceneForAreaChange(area.id, "")}
                              disabled={!canEdit}
                            >
                              Clear
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="switch-setting-section switch-setting-individual-section">
            <div className="switch-setting-title">Individual Override</div>
            <div className="switch-individual-list">
              {targetGroups.length === 0 ? (
                <p className="screen-empty">No circuits are registered.</p>
              ) : (
                targetGroups.map((area) => {
                  const areaTargets = area.targets;
                  const open = isAreaExpanded(area.id);
                  const hasAreaSetting = areaHasSetting(area);
                  return (
                    <div className="switch-area-panel" key={area.id}>
                      <button
                        type="button"
                        className={`switch-area-toggle${hasAreaSetting ? " has-setting" : ""}`}
                        onClick={() => onAreaToggle(area.id)}
                        aria-expanded={open}
                      >
                        <span className="switch-area-caret">{open ? "v" : ">"}</span>
                        <span>{area.name || "(No name)"}</span>
                        <span className="muted-pill">{areaTargets.length}</span>
                      </button>

                      {open ? (
                        <>
                        <div className="switch-area-bulk-panel">
                          <span className="switch-area-bulk-label">Area bulk</span>
                          <div className="scene-level-control switch-area-bulk-control">
                            <input
                              className="cell-input scene-level-input"
                              type="number"
                              min="0"
                              max="100"
                              step="1"
                              value={bulk.value(area)}
                              onChange={(e) => bulk.onPercentChange(area, e.target.value)}
                              disabled={!canEdit}
                            />
                            <div className="scene-step-grid switch-step-grid" aria-label="Area bulk level adjustment">
                              <button type="button" onClick={() => bulk.onStep(area, 1)} disabled={!canEdit}>+1</button>
                              <button type="button" onClick={() => bulk.onStep(area, 10)} disabled={!canEdit}>+10</button>
                              <button type="button" onClick={() => bulk.onStep(area, -1)} disabled={!canEdit}>-1</button>
                              <button type="button" onClick={() => bulk.onStep(area, -10)} disabled={!canEdit}>-10</button>
                            </div>
                          </div>
                          <div className="switch-onoff-buttons switch-area-bulk-buttons" role="group" aria-label="Area On Off Uneffected Raise Lower 0.5 sec">
                            <button type="button" onClick={() => bulk.onApply(area, "percent")} disabled={!canEdit || !bulk.canApply(area, "percent")}>Apply %</button>
                            <button type="button" onClick={() => bulk.onApply(area, "on")} disabled={!canEdit || !bulk.canApply(area, "on")}>On</button>
                            <button type="button" onClick={() => bulk.onApply(area, "off")} disabled={!canEdit || !bulk.canApply(area, "off")}>Off</button>
                            <button type="button" onClick={() => bulk.onApply(area, "blinkShort")} disabled={!canEdit || !bulk.canApply(area, "blinkShort")}>Blinking (Short)</button>
                            <button type="button" onClick={() => bulk.onApply(area, "blinkLong")} disabled={!canEdit || !bulk.canApply(area, "blinkLong")}>Blinking (Long)</button>
                            <button type="button" onClick={() => bulk.onApply(area, "raise")} disabled={!canEdit || !bulk.canApply(area, "raise")}>Raise</button>
                            <button type="button" onClick={() => bulk.onApply(area, "lower")} disabled={!canEdit || !bulk.canApply(area, "lower")}>Lower</button>
                            <button type="button" onClick={() => bulk.onApply(area, "halfSec")} disabled={!canEdit || !bulk.canApply(area, "halfSec")}>0.5 sec</button>
                            <button type="button" onClick={() => bulk.onApply(area, "clear")} disabled={!canEdit || !bulk.canApply(area, "clear")}>Uneffected</button>
                          </div>
                        </div>
                        <div className="matrix-scroll">
                          <table className="matrix-table master-table switch-setting-table switch-individual-table">
                            <thead>
                              <tr>
                                <th>Circuit #</th>
                                <th>Dimming Type</th>
                                <th>Detail</th>
                                <th>Override</th>
                              </tr>
                            </thead>
                            <tbody>
                              {areaTargets.map((target) => {
                                const value = valueForTarget(target);
                                return (
                                  <tr key={target.id}>
                                    <td><span className="cell-readonly">{target.circuitNumber}</span></td>
                                    <td><span className="cell-readonly">{target.dimmingType || "-"}</span></td>
                                    <td><span className="cell-readonly">{target.detail}</span></td>
                                    <td>
                                      {isCurtainTarget(target) ? (
                                        <CurtainActionButtons
                                          value={value}
                                          onChange={(nextValue) => onTargetValueChange(target, nextValue)}
                                          disabled={!canEdit}
                                        />
                                      ) : target.isOnOff ? (
                                        <div className="switch-onoff-buttons" role="group" aria-label="On Off Uneffected 0.5 sec">
                                          {[
                                            ["On", "On"],
                                            ["Off", "Off"],
                                            ["Blinking (Short)", "Blinking (Short)"],
                                            ["Blinking (Long)", "Blinking (Long)"],
                                            ["0.5 sec", "0.5 sec"],
                                            ["", "Uneffected"],
                                          ].map(([nextValue, label]) => (
                                            <button
                                              key={label}
                                              type="button"
                                              className={(nextValue === "" ? value === "" : value === nextValue) ? "is-active" : ""}
                                              onClick={() => onTargetValueChange(target, nextValue)}
                                              disabled={!canEdit}
                                            >
                                              {label}
                                            </button>
                                          ))}
                                        </div>
                                      ) : (
                                        <div className="scene-level-control switch-override-control">
                                          {renderValueInput ? renderValueInput(target, value) : (
                                          <input
                                            className="cell-input scene-level-input"
                                            type="text"
                                            min="0"
                                            max="100"
                                            step="1"
                                            value={value}
                                            onChange={(e) => onTargetValueChange(target, e.target.value)}
                                            disabled={!canEdit}
                                          />
                                          )}
                                          <div className="scene-step-grid switch-step-grid" aria-label="Level adjustment">
                                            <button type="button" onClick={() => onTargetStep(target, 1)} disabled={!canEdit}>+1</button>
                                            <button type="button" onClick={() => onTargetStep(target, 10)} disabled={!canEdit}>+10</button>
                                            <button type="button" onClick={() => onTargetStep(target, -1)} disabled={!canEdit}>-1</button>
                                            <button type="button" onClick={() => onTargetStep(target, -10)} disabled={!canEdit}>-10</button>
                                          </div>
                                          <button
                                            type="button"
                                            className={`btn-clear-circuit${value === "" ? " is-active" : ""}`}
                                            onClick={() => onTargetValueChange(target, "")}
                                            disabled={!canEdit}
                                          >
                                            Uneffected
                                          </button>
                                          <div className="scene-quick-buttons area-scene-extra-buttons">
                                            {["Raise", "Lower"].map((option) => (
                                              <button
                                                key={option}
                                                type="button"
                                                className={value === option ? "is-active" : ""}
                                                onClick={() => onTargetValueChange(target, option)}
                                                disabled={!canEdit}
                                              >
                                                {option}
                                              </button>
                                            ))}
                                          </div>
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        </>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
            {children}
          </div>
        </div>
      </div>
    );
  }
