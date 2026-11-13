import type { BacklightLevelSetting, RoomScene, SwitchEntry } from "../types";
import { hasTstatBindingQuarantine } from "../lib/tstatBindingQuarantine";
import SectionHeading from "./SectionHeading";

interface Props {
  levels: BacklightLevelSetting[];
  switches: SwitchEntry[];
  roomScenes: RoomScene[];
}

export default function BacklightOverview({ levels, switches, roomScenes }: Props) {
  const conditionName = (condition: string) =>
    levels.find(level => level.key === condition)?.name || condition || "-";
  const targetNames = new Map(switches.filter(row => row.kind === "lutronPd").map(row =>
    [row.switchGroupId || row.id, [row.switchNumber, row.switchName].filter(Boolean).join(" / ")]));
  const rules = switches.filter(row => !hasTstatBindingQuarantine(row) && (row.backlightTarget.trim() || row.backlightCondition.trim()));
  const sceneRules = roomScenes.filter(scene => scene.backlightCondition.trim());

  return (
    <section className="read-only-overview" aria-label="Backlight overview">
      <SectionHeading>Backlight Scenes</SectionHeading>
      <div className="matrix-scroll">
        <table className="matrix-table master-table">
          <thead><tr><th>Backlight Scene</th><th>Mode</th><th>Active %</th><th>Inactive %</th></tr></thead>
          <tbody>{levels.map(level => <tr key={level.key}><td>{level.name}</td><td>{level.mode}</td><td>{level.active || "-"}</td><td>{level.inactive || "-"}</td></tr>)}</tbody>
        </table>
      </div>
      <SectionHeading>Stored Backlight Rules</SectionHeading>
      <div className="matrix-scroll">
        <table className="matrix-table master-table">
          <thead><tr><th>Source</th><th>Target</th><th>Condition</th></tr></thead>
          <tbody>
            {rules.map(row => (
              <tr key={row.id}>
                <td>{[row.switchNumber, row.switchName, row.buttonLabel, row.buttonFunction].filter(Boolean).join(" / ") || "-"}</td>
                <td>{row.backlightTarget.split(",").map(target => target.trim()).filter(Boolean)
                  .map(target => targetNames.get(target) || "Unresolved target").join(", ") || "-"}</td>
                <td>{conditionName(row.backlightCondition)}</td>
              </tr>
            ))}
            {!rules.length ? <tr><td colSpan={3} className="screen-empty">No stored Backlight rules.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <SectionHeading>Room Scene Backlight Conditions</SectionHeading>
      <div className="matrix-scroll">
        <table className="matrix-table master-table">
          <thead><tr><th>Room Scene</th><th>Condition</th></tr></thead>
          <tbody>
            {sceneRules.map(scene => <tr key={scene.id}><td>{[scene.sceneType, scene.detail].filter(Boolean).join(" / ") || "-"}</td><td>{conditionName(scene.backlightCondition)}</td></tr>)}
            {!sceneRules.length ? <tr><td colSpan={2} className="screen-empty">No Room Scene Backlight conditions.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
