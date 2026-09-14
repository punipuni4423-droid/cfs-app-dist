"use client";

import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface SaveRecoveryUi {
  scopeKey: string;
  backup: (() => void) | null;
  recoveryCount: number;
  severity: 'none' | 'warning' | 'error';
  notice: ReactNode;
  collapsedStatus: string | null;
  panel: ReactNode;
}

// Disclosure state only: opening or closing never invokes save/recovery work.
export function useDisclosurePanel(scopeKey: string, panelId: string) {
  const [openScope, setOpenScope] = useState<string | null>(null);
  const origin = useRef<HTMLButtonElement | null>(null);
  const scroll = useRef({ x: 0, y: 0 });
  const scrollFrame = useRef<number | null>(null);
  useEffect(() => {
    setOpenScope(null); origin.current = null;
    return () => { if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current); };
  }, [scopeKey]);
  const open = openScope === scopeKey;
  const close = () => {
    setOpenScope(null);
    const trigger = origin.current;
    const visible = (button: HTMLButtonElement | null): button is HTMLButtonElement => Boolean(button?.isConnected && !button.disabled && button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden');
    const samePanel = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-controls]'))
      .find(button => button.getAttribute('aria-controls') === panelId && visible(button));
    const showTopBar = document.querySelector<HTMLButtonElement>('[aria-label="Show top bar"]');
    const target = visible(trigger) ? trigger : samePanel ?? (visible(showTopBar) ? showTopBar : null);
    target?.focus({ preventScroll: true });
    const position = scroll.current;
    scrollFrame.current = window.requestAnimationFrame(() => window.scrollTo(position.x, position.y));
  };
  return {
    open, close,
    show: (trigger: HTMLButtonElement) => { if (!open) scroll.current = { x: window.scrollX, y: window.scrollY }; origin.current = trigger; setOpenScope(scopeKey); },
    toggle: (trigger: HTMLButtonElement) => { if (open) close(); else { scroll.current = { x: window.scrollX, y: window.scrollY }; origin.current = trigger; setOpenScope(scopeKey); } },
  };
}

export function SaveRecoveryNotice({ ui, onOpen, collapsed = false }: {
  ui: SaveRecoveryUi; onOpen: (trigger: HTMLButtonElement) => void; collapsed?: boolean;
}) {
  if (!ui.notice && !(collapsed && ui.collapsedStatus)) return null;
  return <section className={`save-reliability-notice is-${ui.severity}`} data-testid="save-reliability-alert" aria-label="Save and Draft Status">
    {ui.notice || <p role="status">{ui.collapsedStatus}</p>}
    {!ui.notice && ui.backup && <button type="button" className="btn btn-secondary" data-testid="reliability-backup" onClick={ui.backup}>Download Backup</button>}
    <button type="button" className="btn btn-secondary" data-testid="save-recovery-open" aria-controls="save-recovery-panel" onClick={event => onOpen(event.currentTarget)}>Open Recovery</button>
  </section>;
}

export default function SaveRecoveryPanel({ id, title, onClose, children }: {
  id: string; title: string; onClose: () => void; children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section id={id} className="card card-padded save-recovery-panel" role="region" aria-labelledby={`${id}-title`} data-testid={id}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault(); event.stopPropagation(); onClose();
    }}>
    <div className="save-recovery-panel-heading">
      <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{title}</h2>
      <button type="button" className="btn btn-secondary" onClick={onClose} aria-label={`Close ${title}`}>Close</button>
    </div>
    {children}
  </section>;
}
