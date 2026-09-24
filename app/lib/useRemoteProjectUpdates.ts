"use client";

import { useEffect, useRef, useState } from 'react';
import type { CollaborationProjectUpdate } from '../types';
import type { ProjectUpdateObservation } from './useCollaboration';
import { mergeProjectUpdates, unreadProjectUpdates } from './remoteProjectUpdates';

const competingUi = '[role="dialog"],[aria-modal="true"],[role="menu"],[role="listbox"],.save-recovery-panel,.modal-backdrop,.setting-overlay,.cfs-inspection-dialog-backdrop,.cfs-filter-list-portal,.month-day-picker-popover';
export function hasCompetingUpdateUi(): boolean {
  if (typeof document === 'undefined') return true;
  return [...document.querySelectorAll<HTMLElement>(competingUi)].some(node => !node.closest('[data-remote-update-root]')
    && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden');
}

export function useRemoteProjectUpdates({ observation, scopeKey, baseline, baselineRevision, userId, activeProjectId, enabled, reloadSafe }: {
  observation?: ProjectUpdateObservation | null;
  scopeKey: string;
  baseline: ReadonlyMap<string, string>;
  baselineRevision: number;
  userId: string;
  activeProjectId: string;
  enabled: boolean;
  reloadSafe: boolean;
}) {
  const known = useRef(new Map<string, Map<string, CollaborationProjectUpdate>>());
  const [closed, setClosed] = useState(() => new Set<string>());
  const [competing, setCompeting] = useState(true);
  useEffect(() => {
    const check = () => setCompeting(previous => { const next = hasCompetingUpdateUi(); return previous === next ? previous : next; });
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-modal', 'role'] });
    return () => observer.disconnect();
  }, []);
  // Re-evaluate on every page render, including the explicit baseline revision
  // and global draft event renders. Map identity does not express its contents.
  void baselineRevision;
  const available = enabled && observation?.updates !== null && observation?.updates !== undefined;
  if (enabled && observation?.updates) known.current.set(scopeKey, mergeProjectUpdates(known.current.get(scopeKey) ?? new Map(), observation.updates));
  const updates = enabled ? unreadProjectUpdates(known.current.get(scopeKey) ?? new Map(), baseline, userId) : new Map<string, CollaborationProjectUpdate>();
  const candidate = available ? updates.get(activeProjectId) : undefined;
  const tokenKey = (update: CollaborationProjectUpdate) => JSON.stringify([scopeKey, update.id, update.updatedAt]);
  const canReload = Boolean(available && reloadSafe && !competing);
  const dialog = candidate && canReload && !closed.has(tokenKey(candidate)) ? candidate : null;
  return { updates, canReload, dialog, close: (shown: CollaborationProjectUpdate) => {
    const key = tokenKey(shown); // Close only the token actually displayed.
    setClosed(previous => new Set(previous).add(key));
  } };
}
