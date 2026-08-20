"use client";

import type { TriggerMaster } from "../types";
import { createEmptyTriggerMaster } from "../lib/constants";
import ActionIconButton from "./ActionIconButton";

interface TriggerMastersViewProps {
  triggerMasters: TriggerMaster[];
  onChange: (next: TriggerMaster[]) => void;
}

export default function TriggerMastersView({
  triggerMasters,
  onChange,
}: TriggerMastersViewProps) {
  function update(id: string, value: string): void {
    onChange(
      triggerMasters.map((master) =>
        master.id === id ? { ...master, name: value } : master,
      ),
    );
  }

  function addRow(): void {
    onChange([...triggerMasters, createEmptyTriggerMaster()]);
  }

  function remove(id: string): void {
    onChange(triggerMasters.filter((master) => master.id !== id));
  }

  return (
    <section className="card card-padded fade-in">
      <div className="matrix-scroll">
        <table className="matrix-table master-table">
          <thead>
            <tr>
              <th style={{ minWidth: 260 }}>Trigger Condition</th>
              <th className="col-center" style={{ width: 120 }}>Operation</th>
            </tr>
          </thead>
          <tbody>
            {triggerMasters.map((master) => (
              <tr key={master.id}>
                <td>
                  <input
                    className="cell-input"
                    value={master.name}
                    onChange={(e) => update(master.id, e.target.value)}
                  />
                </td>
                <td className="col-center">
                  <ActionIconButton
                    icon="trash"
                    label="Delete Trigger"
                    className="btn-danger-ghost"
                    onClick={() => remove(master.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="add-row-tr">
              <td colSpan={2}>
                <button className="btn-add-row" onClick={addRow}>
                  + Add Row
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
