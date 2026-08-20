"use client";

interface DisplaySettingsViewProps {
  displayScale: number;
  adminMode: boolean;
  cfsLinkedValueHighlightEnabled: boolean;
  cfsLinkMapEnabled: boolean;
  onChange: (next: number) => void;
  onAdminModeChange: (next: boolean) => void;
  onCfsLinkedValueHighlightChange: (next: boolean) => void;
  onCfsLinkMapChange: (next: boolean) => void;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 1.5;
const STEP = 0.05;
const QUICK_SCALES = [0.5, 0.6, 0.7, 1];

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(value * 100) / 100));
}

export default function DisplaySettingsView({
  displayScale,
  adminMode,
  cfsLinkedValueHighlightEnabled,
  cfsLinkMapEnabled,
  onChange,
  onAdminModeChange,
  onCfsLinkedValueHighlightChange,
  onCfsLinkMapChange,
}: DisplaySettingsViewProps) {
  const value = clampScale(displayScale);
  const percent = Math.round(value * 100);

  function setScale(next: number): void {
    onChange(clampScale(next));
  }

  return (
    <section className="card card-padded fade-in display-settings-card">
      <div className="display-settings-stack">
        <div className="display-settings-grid">
          <div>
            <h2 className="screen-section-title">Display Size</h2>
            <p className="display-settings-meta">White work areas and controls scale together.</p>
          </div>

          <div className="display-scale-control" aria-label="Display size">
            <button
              type="button"
              className="display-scale-button"
              onClick={() => setScale(value - STEP)}
              disabled={value <= MIN_SCALE}
              aria-label="Decrease display size"
              title="Decrease display size"
            >
              -
            </button>
            <input
              className="display-scale-range"
              type="range"
              min={MIN_SCALE}
              max={MAX_SCALE}
              step={STEP}
              value={value}
              onChange={(event) => setScale(Number(event.target.value))}
              aria-label="Display size"
            />
            <button
              type="button"
              className="display-scale-button"
              onClick={() => setScale(value + STEP)}
              disabled={value >= MAX_SCALE}
              aria-label="Increase display size"
              title="Increase display size"
            >
              +
            </button>
            <span className="muted-pill display-scale-value">{percent}%</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setScale(1)}
              disabled={value === 1}
            >
              Reset
            </button>
          </div>
          <div className="display-scale-presets" aria-label="Display size presets">
            {QUICK_SCALES.map((scale) => (
              <button
                key={scale}
                type="button"
                className={value === scale ? "is-active" : ""}
                onClick={() => setScale(scale)}
              >
                {Math.round(scale * 100)}%
              </button>
            ))}
          </div>
        </div>

        <div className="admin-settings-panel">
          <div>
            <h2 className="screen-section-title">Admin Mode</h2>
            <p className="display-settings-meta">
              Advanced CFS diagnostics stay hidden unless Admin Mode is enabled.
            </p>
          </div>
          <div className="settings-toggle-list">
            <label className="settings-toggle-row">
              <input
                type="checkbox"
                checked={adminMode}
                onChange={(event) => onAdminModeChange(event.target.checked)}
              />
              <span>
                <strong>Admin Mode</strong>
                <small>Show administrator-only controls.</small>
              </span>
            </label>
            <label className={`settings-toggle-row${adminMode ? "" : " is-disabled"}`}>
              <input
                type="checkbox"
                checked={adminMode && cfsLinkedValueHighlightEnabled}
                disabled={!adminMode}
                onChange={(event) => onCfsLinkedValueHighlightChange(event.target.checked)}
              />
              <span>
                <strong>CFS Linked Values fill</strong>
                <small>Highlight linked function cells in CFS.</small>
              </span>
            </label>
            <label className={`settings-toggle-row${adminMode ? "" : " is-disabled"}`}>
              <input
                type="checkbox"
                checked={adminMode && cfsLinkMapEnabled}
                disabled={!adminMode}
                onChange={(event) => onCfsLinkMapChange(event.target.checked)}
              />
              <span>
                <strong>CFS Link Map</strong>
                <small>Enable the Link Map button and diagnostic panel.</small>
              </span>
            </label>
          </div>
        </div>
      </div>
    </section>
  );
}
