"use client";

interface Props {
  onClick: () => void;
  colSpan: number;
  disabled?: boolean;
  scopeLabel?: string;
  label?: string;
  title?: string;
}

export default function AddRowButton({ onClick, colSpan, disabled, scopeLabel, label = "+ Add Row", title }: Props) {
  return (
    <tfoot>
      <tr className="add-row-tr">
        <td colSpan={colSpan}>
          <button type="button" className="btn-add-row" onClick={onClick} disabled={disabled}
            aria-label={scopeLabel ? `Add Row (${scopeLabel})` : undefined} title={title}>
            {label}
          </button>
        </td>
      </tr>
    </tfoot>
  );
}
