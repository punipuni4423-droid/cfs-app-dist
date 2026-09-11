"use client";

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

export type PendingCfsGuard = () => Promise<boolean>;
export type PendingCfsGuardRef = RefObject<PendingCfsGuard | null>;

/** Resume against the latest render after Confirm commits the pending values. */
export function usePendingCfsAction<Args extends unknown[]>(
  action: (...args: Args) => void,
  guardRef: PendingCfsGuardRef,
  shouldGuard = true,
): (...args: Args) => void {
  const actionRef = useRef({ action, shouldGuard });
  useLayoutEffect(() => { actionRef.current = { action, shouldGuard }; });
  return useCallback((...args: Args) => {
    const guard = actionRef.current.shouldGuard ? guardRef.current : null;
    if (!guard) {
      actionRef.current.action(...args);
      return;
    }
    void guard().then((proceed) => { if (proceed) actionRef.current.action(...args); });
  }, [guardRef]);
}
