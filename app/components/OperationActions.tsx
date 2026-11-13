"use client";

import type { ComponentProps } from "react";
import ActionIconButton from "./ActionIconButton";
import styles from "./OperationActions.module.css";

export type OperationAction = Pick<
  ComponentProps<typeof ActionIconButton>,
  "icon" | "label" | "onClick" | "disabled" | "title" | "className" | "aria-pressed"
> & { id: string };

export interface OperationActionGroup {
  id: string;
  label?: string;
  actions: readonly OperationAction[];
}

/** Shared presentation only: callers keep action scope and mutation rules. */
export default function OperationActions({ groups }: { groups: readonly OperationActionGroup[] }) {
  return (
    <div className={styles.root}>
      {groups.filter(group => group.actions.length > 0).map(group => (
        <div className={styles.group} key={group.id} role="group" aria-label={group.label ? `${group.label} operations` : undefined}>
          {group.label ? <span className={styles.label} aria-hidden="true">{group.label}</span> : null}
          <div className="switch-operation-stack">
            {group.actions.map(({ id, ...action }) => <ActionIconButton key={id} nativeTooltipOnly {...action} />)}
          </div>
        </div>
      ))}
    </div>
  );
}
