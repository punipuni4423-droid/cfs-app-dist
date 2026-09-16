"use client";

interface BacklightConditionSelectProps {
  value: string;
  conditions: ReadonlyArray<{ key: string; name: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}

/** The empty condition keeps the existing Uneffected/clear storage value. */
export default function BacklightConditionSelect({
  value,
  conditions,
  disabled,
  onChange,
}: BacklightConditionSelectProps) {
  return (
    <>
      <select
        className="cell-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        <option value="">Uneffected</option>
        {conditions.map((condition) => (
          <option key={condition.key} value={condition.key}>
            {condition.name}
          </option>
        ))}
      </select>
      {value.trim() ? (
        <button
          type="button"
          className="btn-clear-circuit"
          style={{ marginTop: "0.5rem" }}
          onClick={() => onChange("")}
          disabled={disabled}
        >
          Uneffected
        </button>
      ) : null}
    </>
  );
}
