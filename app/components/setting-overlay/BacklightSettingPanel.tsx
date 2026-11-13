"use client";

import BacklightConditionSelect from "../BacklightConditionSelect";

type TargetSelection = { mode: "readOnly" } | {
  mode: "editable";
  selectedIds: ReadonlySet<string>;
  onChange: (selectedIds: ReadonlySet<string>) => void;
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
  const selectedCount = selection.mode === "editable" ? targets.filter(target => selection.selectedIds.has(target.id)).length : 0;
  const allSelected = targets.length > 0 && selectedCount === targets.length;
  function updateTargets(ids: Iterable<string>, checked: boolean): void {
    if (!canEdit || selection.mode !== "editable") return;
    const next = new Set(selection.selectedIds);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    selection.onChange(next);
  }
  return (
    <div className="scene-card switch-setting-card">
      <div className="switch-setting-layout switch-backlight-setting-layout">
        <div className="switch-setting-section">
          <div className="switch-setting-title">Target</div>
          {!readOnly && targets.length > 0 ? (
            <label className="switch-target-option">
              <input
                type="checkbox"
                checked={allSelected}
                ref={input => { if (input) input.indeterminate = selectedCount > 0 && !allSelected; }}
                onChange={event => updateTargets(targets.map(target => target.id), event.target.checked)}
                disabled={!canEdit}
              />
              <span>Select all targets</span>
            </label>
          ) : null}
          <div className="switch-target-list" role="list" aria-label="By Scene Palladiom switches">
            {targets.length === 0 ? (
              <span className="cell-readonly">{readOnly ? "No By Scene Palladiom switches. Set By Scene on the Backlight tab." : "No By Scene Palladiom switches."}</span>
            ) : targets.map(target => (
              <div className="switch-target-option" role="listitem" key={target.id}><span>{target.label}</span></div>
            ))}
          </div>
          {selection.mode === "editable" && selection.selectedIds.size > 0 ? (
            <button type="button" className="btn-clear-circuit" style={{ marginTop: "0.5rem" }} onClick={() => selection.onChange(new Set())} disabled={!canEdit}>Clear Target</button>
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
