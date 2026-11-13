"use client";

export type ViewMode = "edit" | "overview";

interface Props {
  ariaLabel: string;
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  labels?: Record<ViewMode, string>;
  testIdPrefix: string;
}

export default function ViewModeBar({ ariaLabel, mode, onChange, labels = { edit: "Edit", overview: "Overview" }, testIdPrefix }: Props) {
  return (
    <div className="scene-view-mode-bar" role="tablist" aria-label={ariaLabel}>
      {(["edit", "overview"] as const).map(option => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={mode === option}
          className={`scene-view-mode-chip${mode === option ? " scene-view-mode-chip-active" : ""}`}
          onClick={() => onChange(option)}
          data-testid={`${testIdPrefix}-${option}`}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}
