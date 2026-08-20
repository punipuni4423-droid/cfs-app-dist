"use client";

interface MatrixToolbarProps {
  onExport: () => void;
}

export default function MatrixToolbar({
  onExport,
}: MatrixToolbarProps) {
  return (
    <div className="toolbar">
      <button className="btn btn-success" onClick={onExport}>
        Excel Export
      </button>
      <span className="toolbar-spacer" />
      <span className="muted-pill" title="Drag handles to reorder groups">
        :: Drag to reorder
      </span>
    </div>
  );
}
