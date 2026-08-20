"use client";

import { CURTAIN_ACTIONS } from "../lib/constants";

interface CurtainActionButtonsProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  clearLabel?: string;
}

export default function CurtainActionButtons({
  value,
  onChange,
  disabled = false,
  ariaLabel = "Curtain action",
  clearLabel = "Uneffected",
}: CurtainActionButtonsProps): React.JSX.Element {
  const options: readonly string[] = [...CURTAIN_ACTIONS, ""];
  return (
    <div className="switch-onoff-buttons curtain-action-buttons" role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const label = option || clearLabel;
        return (
          <button
            key={label}
            type="button"
            className={(option === "" ? value.trim() === "" : value === option) ? "is-active" : ""}
            onClick={() => onChange(option)}
            disabled={disabled}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
