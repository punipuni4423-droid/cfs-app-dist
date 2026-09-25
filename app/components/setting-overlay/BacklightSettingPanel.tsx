"use client";

import BacklightConditionSelect from "../BacklightConditionSelect";

type TargetSelection = { mode: "readOnly" } | {
  mode: "editable";
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string, checked: boolean) => void;
  onClear: () => void;
};
interface BacklightSettingPanelProps {
  targets: ReadonlyArray<{ id: string; label: string }>;
  selection: TargetSelection;
  condition: string;
  conditions: ReadonlyArray<{ key: string; name: string }>;
  onConditionChange: (value: string) => void;
  canEdit: boolean;
}

export default function BacklightSettingPanel({ targets, selection, condition, conditions, onConditionChange, canEdit }: BacklightSettingPanelProps) {
  const readOnly = selection.mode === "readOnly";
  return (
    <div className="scene-card switch-setting-card">
      <div className="switch-setting-layout switch-backlight-setting-layout">
        <div className="switch-setting-section">
          <div className="switch-setting-title">Target</div>
          <div className="switch-target-list" role={readOnly ? "list" : undefined} aria-label={readOnly ? "By Scene Palladiom switches" : undefined}>
            {targets.length === 0 ? (
              <span className="cell-readonly">{readOnly ? "No By Scene Palladiom switches. Set By Scene on the Backlight tab." : "No By Scene Palladiom switches."}</span>
            ) : targets.map(target => selection.mode === "readOnly" ? (
              <div className="switch-target-option" role="listitem" key={target.id}><span>{target.label}</span></div>
            ) : (
              <label className="switch-target-option" key={target.id}>
                <input type="checkbox" checked={selection.selectedIds.has(target.id)} onChange={event => selection.onToggle(target.id, event.target.checked)} disabled={!canEdit} />
                <span>{target.label}</span>
              </label>
            ))}
          </div>
          {selection.mode === "editable" && selection.selectedIds.size > 0 ? (
            <button type="button" className="btn-clear-circuit" style={{ marginTop: "0.5rem" }} onClick={selection.onClear} disabled={!canEdit}>Clear Target</button>
          ) : null}
          {readOnly && targets.length > 0 ? <div className="cell-readonly" style={{ marginTop: "0.5rem" }}>Change By Scene assignments on the Backlight tab.</div> : null}
        </div>
        <div className="switch-setting-section">
          <div className="switch-setting-title">Condition</div>
          <BacklightConditionSelect value={condition} conditions={conditions} onChange={onConditionChange} disabled={!canEdit} />
        </div>
      </div>
    </div>
  );
}
